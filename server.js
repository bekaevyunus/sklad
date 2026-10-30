// Склад — учёт товаров: приход, продажи, остатки, отчёты.
// Без внешних зависимостей: только Node.js 22.13+ (встроенная SQLite).
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_NAME = process.env.ADMIN_NAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "sklad.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','seller')),
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  buy_price REAL NOT NULL DEFAULT 0,
  sell_price REAL NOT NULL DEFAULT 0,
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  total REAL NOT NULL,
  cost REAL NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('in','sale','adjust')),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  buy_price REAL NOT NULL DEFAULT 0,
  sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mov_created ON movements(created);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '1');
`);

// ---------- Пароли и сессии ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.pass_hash, "hex"));
}

// Первый запуск: создаём владельца
if (db.prepare("SELECT COUNT(*) c FROM users").get().c === 0) {
  if (!ADMIN_PASSWORD) {
    console.error("Первый запуск: задайте ADMIN_PASSWORD (пароль владельца).");
    process.exit(1);
  }
  const { salt, hash } = hashPassword(ADMIN_PASSWORD);
  db.prepare("INSERT INTO users (name, pass_hash, salt, role) VALUES (?,?,?, 'admin')").run(ADMIN_NAME, hash, salt);
  console.log(`Создан владелец «${ADMIN_NAME}».`);
}

function bump() {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='version'").run();
}
function version() {
  return Number(db.prepare("SELECT value FROM meta WHERE key='version'").get().value);
}

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------- HTTP-помощники ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw bad("Слишком большой запрос");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw bad("Неверный формат данных"); }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = cookies(req).sklad_session;
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.active = 1`).get(token) || null;
}

const num = (v, name, { min = -Infinity } = {}) => {
  const n = Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n)) throw bad(`Поле «${name}» должно быть числом`);
  if (n < min) throw bad(`Поле «${name}» не может быть меньше ${min}`);
  return Math.round(n * 1000) / 1000;
};
const str = (v) => String(v ?? "").trim();

// Продавцу не показываем закупочную цену
function productView(p, user) {
  if (!p) return null;
  if (user.role === "admin") return p;
  const { buy_price, ...rest } = p;
  return rest;
}

// ---------- API ----------
const routes = [];
const route = (method, pattern, handler, { auth = "any" } = {}) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler, auth });
};

route("POST", "/api/login", async (req, res) => {
  const { name, password } = await readJson(req);
  // Имя без учёта регистра (в том числе кириллица)
  const wanted = str(name).toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE active = 1").all().find((u) => u.name.toLowerCase() === wanted);
  if (!user || !checkPassword(String(password || ""), user)) throw new HttpError(401, "Неверное имя или пароль");
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, user.id);
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  send(res, 200, { id: user.id, name: user.name, role: user.role }, {
    "Set-Cookie": `sklad_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}${secure}`,
  });
}, { auth: "none" });

route("POST", "/api/logout", async (req, res) => {
  const token = cookies(req).sklad_session;
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  send(res, 200, { ok: true }, { "Set-Cookie": "sklad_session=; Path=/; Max-Age=0" });
}, { auth: "none" });

route("GET", "/api/me", async (req, res, { user }) => send(res, 200, { ...user, version: version() }));

route("GET", "/api/version", async (req, res) => send(res, 200, { version: version() }));

// Товары
route("GET", "/api/products", async (req, res, { user, query }) => {
  const q = str(query.get("q")).toLowerCase();
  // Фильтруем в JS: SQLite LIKE не различает регистр кириллицы
  const rows = db.prepare("SELECT * FROM products ORDER BY name COLLATE NOCASE").all()
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.barcode || "").includes(q))
    .slice(0, 2000);
  send(res, 200, rows.map((p) => productView(p, user)));
});

route("GET", "/api/products/barcode/:code", async (req, res, { user, params }) => {
  const p = db.prepare("SELECT * FROM products WHERE barcode = ?").get(decodeURIComponent(params.code));
  if (!p) throw new HttpError(404, "Товар с таким штрих-кодом не найден");
  send(res, 200, productView(p, user));
});

function saveProduct(body, id) {
  const name = str(body.name);
  if (!name) throw bad("Укажите название товара");
  const barcode = str(body.barcode) || null;
  const buy = num(body.buy_price ?? 0, "Закупочная цена", { min: 0 });
  const sell = num(body.sell_price ?? 0, "Розничная цена", { min: 0 });
  if (barcode) {
    const other = db.prepare("SELECT id, name FROM products WHERE barcode = ?").get(barcode);
    if (other && other.id !== id) throw bad(`Штрих-код уже занят товаром «${other.name}»`);
  }
  return { name, barcode, buy, sell };
}

route("POST", "/api/products", async (req, res, { user }) => {
  const body = await readJson(req);
  const p = saveProduct(body);
  const qty = num(body.qty ?? 0, "Количество", { min: 0 });
  const id = tx(() => {
    const r = db.prepare("INSERT INTO products (barcode, name, qty, buy_price, sell_price) VALUES (?,?,?,?,?)")
      .run(p.barcode, p.name, qty, p.buy, p.sell);
    const pid = Number(r.lastInsertRowid);
    if (qty > 0) {
      db.prepare("INSERT INTO movements (type, product_id, product_name, qty, buy_price, user_id) VALUES ('in',?,?,?,?,?)")
        .run(pid, p.name, qty, p.buy, user.id);
    }
    bump();
    return pid;
  });
  send(res, 201, db.prepare("SELECT * FROM products WHERE id = ?").get(id));
}, { auth: "admin" });

route("PUT", "/api/products/:id", async (req, res, { user, params }) => {
  const id = Number(params.id);
  const old = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  if (!old) throw new HttpError(404, "Товар не найден");
  const body = await readJson(req);
  const p = saveProduct({ ...old, ...body }, id);
  const qty = body.qty !== undefined ? num(body.qty, "Количество") : old.qty;
  tx(() => {
    db.prepare("UPDATE products SET barcode=?, name=?, buy_price=?, sell_price=?, qty=?, updated=datetime('now') WHERE id=?")
      .run(p.barcode, p.name, p.buy, p.sell, qty, id);
    if (qty !== old.qty) {
      db.prepare("INSERT INTO movements (type, product_id, product_name, qty, buy_price, user_id) VALUES ('adjust',?,?,?,?,?)")
        .run(id, p.name, Math.round((qty - old.qty) * 1000) / 1000, p.buy, user.id);
    }
    bump();
  });
  send(res, 200, db.prepare("SELECT * FROM products WHERE id = ?").get(id));
}, { auth: "admin" });

route("DELETE", "/api/products/:id", async (req, res, { params }) => {
  tx(() => { db.prepare("DELETE FROM products WHERE id = ?").run(Number(params.id)); bump(); });
  send(res, 200, { ok: true });
}, { auth: "admin" });

// Приход товара (по штрих-коду или из списка)
route("POST", "/api/receive", async (req, res, { user }) => {
  const body = await readJson(req);
  const id = Number(body.product_id);
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  if (!p) throw new HttpError(404, "Товар не найден");
  const qty = num(body.qty, "Количество", { min: 0.001 });
  // Цены при приходе меняет только владелец
  const buy = user.role === "admin" && body.buy_price !== undefined && body.buy_price !== ""
    ? num(body.buy_price, "Закупочная цена", { min: 0 }) : p.buy_price;
  const sell = user.role === "admin" && body.sell_price !== undefined && body.sell_price !== ""
    ? num(body.sell_price, "Розничная цена", { min: 0 }) : p.sell_price;
  tx(() => {
    db.prepare("UPDATE products SET qty = qty + ?, buy_price = ?, sell_price = ?, updated = datetime('now') WHERE id = ?")
      .run(qty, buy, sell, id);
    db.prepare("INSERT INTO movements (type, product_id, product_name, qty, buy_price, user_id) VALUES ('in',?,?,?,?,?)")
      .run(id, p.name, qty, buy, user.id);
    bump();
  });
  send(res, 200, productView(db.prepare("SELECT * FROM products WHERE id = ?").get(id), user));
});

// Продажа
route("POST", "/api/sales", async (req, res, { user }) => {
  const body = await readJson(req);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw bad("Корзина пуста");
  const sale = tx(() => {
    let total = 0, cost = 0;
    const lines = items.map((it) => {
      const p = db.prepare("SELECT * FROM products WHERE id = ?").get(Number(it.product_id));
      if (!p) throw bad("Один из товаров удалён — обновите корзину");
      const qty = num(it.qty, "Количество", { min: 0.001 });
      // Цену продажи может изменить только владелец (скидка)
      const price = user.role === "admin" && it.price !== undefined ? num(it.price, "Цена", { min: 0 }) : p.sell_price;
      total += qty * price;
      cost += qty * p.buy_price;
      return { p, qty, price };
    });
    const r = db.prepare("INSERT INTO sales (user_id, total, cost) VALUES (?,?,?)")
      .run(user.id, Math.round(total * 100) / 100, Math.round(cost * 100) / 100);
    const saleId = Number(r.lastInsertRowid);
    for (const { p, qty, price } of lines) {
      db.prepare("UPDATE products SET qty = qty - ?, updated = datetime('now') WHERE id = ?").run(qty, p.id);
      db.prepare(`INSERT INTO movements (type, product_id, product_name, qty, price, buy_price, sale_id, user_id)
                  VALUES ('sale',?,?,?,?,?,?,?)`).run(p.id, p.name, qty, price, p.buy_price, saleId, user.id);
    }
    bump();
    return { id: saleId, total: Math.round(total * 100) / 100 };
  });
  send(res, 201, sale);
});

// Отмена продажи (возврат товара на склад) — только владелец
route("DELETE", "/api/sales/:id", async (req, res, { params }) => {
  const id = Number(params.id);
  tx(() => {
    const lines = db.prepare("SELECT product_id, qty FROM movements WHERE sale_id = ? AND type = 'sale'").all(id);
    for (const l of lines) {
      if (l.product_id) db.prepare("UPDATE products SET qty = qty + ? WHERE id = ?").run(l.qty, l.product_id);
    }
    db.prepare("DELETE FROM sales WHERE id = ?").run(id);
    bump();
  });
  send(res, 200, { ok: true });
}, { auth: "admin" });

// Период: from/to в формате YYYY-MM-DD по местному времени (смещение tz в минутах от клиента)
function period(query) {
  const tz = Number(query.get("tz") || 0); // минуты, как Date.getTimezoneOffset()
  const shift = `${-tz} minutes`;
  const today = new Date(Date.now() - tz * 60000).toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.get("from") || "") ? query.get("from") : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.get("to") || "") ? query.get("to") : from;
  return { shift, from, to };
}

route("GET", "/api/sales", async (req, res, { user, query }) => {
  const { shift, from, to } = period(query);
  const own = user.role === "admin" ? "" : "AND s.user_id = " + Number(user.id);
  const sales = db.prepare(`
    SELECT s.id, s.total, s.cost, datetime(s.created, ?) AS created, u.name AS seller
    FROM sales s LEFT JOIN users u ON u.id = s.user_id
    WHERE date(s.created, ?) BETWEEN ? AND ? ${own}
    ORDER BY s.id DESC LIMIT 1000`).all(shift, shift, from, to);
  const lines = db.prepare("SELECT sale_id, product_name, qty, price FROM movements WHERE sale_id = ?");
  send(res, 200, sales.map((s) => {
    const out = { ...s, items: lines.all(s.id) };
    if (user.role !== "admin") delete out.cost;
    return out;
  }));
});

route("GET", "/api/report", async (req, res, { query }) => {
  const { shift, from, to } = period(query);
  const sum = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(cost),0) AS cost
    FROM sales WHERE date(created, ?) BETWEEN ? AND ?`).get(shift, from, to);
  const top = db.prepare(`
    SELECT product_name AS name, SUM(qty) AS qty, SUM(qty*price) AS revenue, SUM(qty*(price-buy_price)) AS profit
    FROM movements WHERE type='sale' AND date(created, ?) BETWEEN ? AND ?
    GROUP BY product_name ORDER BY revenue DESC LIMIT 20`).all(shift, from, to);
  const stock = db.prepare(`
    SELECT COUNT(*) AS items, COALESCE(SUM(qty*buy_price),0) AS buy_value, COALESCE(SUM(qty*sell_price),0) AS sell_value
    FROM products WHERE qty > 0`).get();
  const low = db.prepare("SELECT id, name, qty FROM products WHERE qty <= 2 ORDER BY qty, name LIMIT 50").all();
  send(res, 200, { from, to, ...sum, profit: sum.revenue - sum.cost, top, stock, low });
}, { auth: "admin" });

route("GET", "/api/movements", async (req, res, { query }) => {
  const { shift, from, to } = period(query);
  send(res, 200, db.prepare(`
    SELECT m.type, m.product_name, m.qty, m.price, m.buy_price, datetime(m.created, ?) AS created, u.name AS user
    FROM movements m LEFT JOIN users u ON u.id = m.user_id
    WHERE date(m.created, ?) BETWEEN ? AND ? ORDER BY m.id DESC LIMIT 2000`).all(shift, shift, from, to));
}, { auth: "admin" });

// Выгрузка остатков в Excel (CSV с ; — открывается двойным щелчком)
route("GET", "/api/export.csv", async (req, res) => {
  const rows = db.prepare("SELECT barcode, name, qty, buy_price, sell_price FROM products ORDER BY name COLLATE NOCASE").all();
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const fmt = (n) => String(n).replace(".", ",");
  const csv = "﻿" + ["Штрих-код;Название;Количество;Закупочная цена;Розничная цена"]
    .concat(rows.map((r) => [esc(r.barcode), esc(r.name), fmt(r.qty), fmt(r.buy_price), fmt(r.sell_price)].join(";")))
    .join("\r\n");
  send(res, 200, csv, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="ostatki-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
}, { auth: "admin" });

// Сотрудники
route("GET", "/api/users", async (req, res) => {
  send(res, 200, db.prepare("SELECT id, name, role, active, created FROM users ORDER BY role, name").all());
}, { auth: "admin" });

route("POST", "/api/users", async (req, res) => {
  const { name, password, role } = await readJson(req);
  const n = str(name);
  if (!n) throw bad("Укажите имя");
  if (String(password || "").length < 4) throw bad("Пароль — минимум 4 символа");
  if (db.prepare("SELECT name FROM users").all().some((u) => u.name.toLowerCase() === n.toLowerCase())) throw bad("Такое имя уже есть");
  const { salt, hash } = hashPassword(String(password));
  db.prepare("INSERT INTO users (name, pass_hash, salt, role) VALUES (?,?,?,?)")
    .run(n, hash, salt, role === "admin" ? "admin" : "seller");
  send(res, 201, { ok: true });
}, { auth: "admin" });

route("PUT", "/api/users/:id", async (req, res, { params }) => {
  const id = Number(params.id);
  const { password, active } = await readJson(req);
  if (password) {
    if (String(password).length < 4) throw bad("Пароль — минимум 4 символа");
    const { salt, hash } = hashPassword(String(password));
    db.prepare("UPDATE users SET pass_hash=?, salt=? WHERE id=?").run(hash, salt, id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  }
  if (active !== undefined) {
    db.prepare("UPDATE users SET active=? WHERE id=?").run(active ? 1 : 0, id);
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  }
  send(res, 200, { ok: true });
}, { auth: "admin" });

route("DELETE", "/api/users/:id", async (req, res, { user, params }) => {
  const id = Number(params.id);
  if (id === user.id) throw bad("Нельзя удалить самого себя");
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  send(res, 200, { ok: true });
}, { auth: "admin" });

// ---------- Статика ----------
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
};
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Нет доступа" });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(pathname)) return send(res, 404, { error: "Не найдено" });
    file = path.join(PUBLIC_DIR, "index.html");
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Cache-Control": file.endsWith("index.html") || file.endsWith("sw.js") ? "no-cache" : "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- Сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const user = currentUser(req);
      if (r.auth !== "none" && !user) throw new HttpError(401, "Нужно войти");
      if (r.auth === "admin" && user.role !== "admin") throw new HttpError(403, "Доступно только владельцу");
      return await r.handler(req, res, { user, params, query: url.searchParams });
    }
    throw new HttpError(404, "Не найдено");
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Ошибка сервера" });
  }
});

server.listen(PORT, () => console.log(`Склад запущен: http://localhost:${PORT}`));
