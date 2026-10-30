// Склад — учёт товаров: приход, продажи, остатки, отчёты.
// Без внешних зависимостей: только Node.js 22.13+ (встроенная SQLite).
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { guessCategory, CATEGORIES } = require("./public/categories.js");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_NAME = process.env.ADMIN_NAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const IMAGES_DIR = path.join(DATA_DIR, "images");
fs.mkdirSync(IMAGES_DIR, { recursive: true });
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
CREATE TABLE IF NOT EXISTS lookup_cache (
  code TEXT PRIMARY KEY,
  data TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '1');
DELETE FROM lookup_cache WHERE data IS NULL;
`);

// Новые поля у товаров (для баз, созданных старой версией)
{
  const cols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  if (!cols.includes("category")) db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  if (!cols.includes("image")) db.exec("ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT ''");
  // Товарам без категории подбираем её автоматически (при каждом запуске — правила со временем улучшаются)
  const upd = db.prepare("UPDATE products SET category = ? WHERE id = ?");
  for (const p of db.prepare("SELECT id, name FROM products WHERE category = ''").all()) {
    const c = guessCategory(p.name);
    if (c) upd.run(c, p.id);
  }
}

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

async function readJson(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw bad("Слишком большой запрос (фото больше 3 МБ?)");
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
  // Категорию берём из формы, а если её нет — определяем по названию
  const category = str(body.category).slice(0, 60) || guessCategory(name, body.category_hint) || "";
  return { name, barcode, buy, sell, category };
}

// ---------- Фото товаров ----------
const IMG_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMG = 3 * 1024 * 1024;

function removeImageFiles(id) {
  for (const ext of Object.values(IMG_TYPES)) fs.rmSync(path.join(IMAGES_DIR, `${id}.${ext}`), { force: true });
}

// Сохраняет фото: из data:-ссылки (снято на телефон) или скачивает по адресу (из базы штрих-кодов)
async function saveImage(id, { data, url }) {
  let buf, ext;
  if (data) {
    const m = String(data).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw bad("Неподдерживаемый формат фото");
    buf = Buffer.from(m[2], "base64");
    ext = IMG_TYPES[m[1]];
  } else if (url && /^https?:\/\//.test(url)) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!res.ok || !IMG_TYPES[type]) return false;
    buf = Buffer.from(await res.arrayBuffer());
    ext = IMG_TYPES[type];
  } else return false;
  if (!buf.length || buf.length > MAX_IMG) throw bad("Фото слишком большое (больше 3 МБ)");
  removeImageFiles(id);
  fs.writeFileSync(path.join(IMAGES_DIR, `${id}.${ext}`), buf);
  db.prepare("UPDATE products SET image = ?, updated = datetime('now') WHERE id = ?").run(`${id}.${ext}?v=${Date.now()}`, id);
  bump();
  return true;
}

// Фото из формы: ошибка скачивания картинки из интернета не должна мешать сохранению товара
async function applyImage(id, body) {
  try {
    if (body.image_data) await saveImage(id, { data: body.image_data });
    else if (body.image_url) await saveImage(id, { url: body.image_url });
  } catch (e) {
    if (body.image_data) throw e;
  }
}

// Новый товар может добавить любой сотрудник (по штрих-коду или вручную)
route("POST", "/api/products", async (req, res, { user }) => {
  const body = await readJson(req, 5_000_000);
  const p = saveProduct(body);
  const qty = num(body.qty ?? 0, "Количество", { min: 0 });
  const id = tx(() => {
    const r = db.prepare("INSERT INTO products (barcode, name, qty, buy_price, sell_price, category) VALUES (?,?,?,?,?,?)")
      .run(p.barcode, p.name, qty, p.buy, p.sell, p.category);
    const pid = Number(r.lastInsertRowid);
    if (qty > 0) {
      db.prepare("INSERT INTO movements (type, product_id, product_name, qty, buy_price, user_id) VALUES ('in',?,?,?,?,?)")
        .run(pid, p.name, qty, p.buy, user.id);
    }
    bump();
    return pid;
  });
  await applyImage(id, body);
  send(res, 201, productView(db.prepare("SELECT * FROM products WHERE id = ?").get(id), user));
});

route("PUT", "/api/products/:id", async (req, res, { user, params }) => {
  const id = Number(params.id);
  const old = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  if (!old) throw new HttpError(404, "Товар не найден");
  const body = await readJson(req, 5_000_000);
  const p = saveProduct({ ...old, ...body }, id);
  const qty = body.qty !== undefined ? num(body.qty, "Количество") : old.qty;
  tx(() => {
    db.prepare("UPDATE products SET barcode=?, name=?, buy_price=?, sell_price=?, qty=?, category=?, updated=datetime('now') WHERE id=?")
      .run(p.barcode, p.name, p.buy, p.sell, qty, p.category, id);
    if (qty !== old.qty) {
      db.prepare("INSERT INTO movements (type, product_id, product_name, qty, buy_price, user_id) VALUES ('adjust',?,?,?,?,?)")
        .run(id, p.name, Math.round((qty - old.qty) * 1000) / 1000, p.buy, user.id);
    }
    bump();
  });
  await applyImage(id, body);
  send(res, 200, db.prepare("SELECT * FROM products WHERE id = ?").get(id));
}, { auth: "admin" });

// Фото к товару может добавить любой сотрудник, удалить — только владелец
route("POST", "/api/products/:id/image", async (req, res, { user, params }) => {
  const id = Number(params.id);
  if (!db.prepare("SELECT 1 FROM products WHERE id = ?").get(id)) throw new HttpError(404, "Товар не найден");
  const body = await readJson(req, 5_000_000);
  await saveImage(id, { data: body.image_data });
  send(res, 200, productView(db.prepare("SELECT * FROM products WHERE id = ?").get(id), user));
});

route("DELETE", "/api/products/:id/image", async (req, res, { params }) => {
  const id = Number(params.id);
  removeImageFiles(id);
  db.prepare("UPDATE products SET image = '' WHERE id = ?").run(id);
  bump();
  send(res, 200, { ok: true });
}, { auth: "admin" });

route("GET", "/api/categories", async (req, res) => {
  const used = db.prepare("SELECT DISTINCT category FROM products WHERE category != ''").all().map((r) => r.category);
  send(res, 200, [...new Set([...CATEGORIES, ...used])]);
});

route("DELETE", "/api/products/:id", async (req, res, { params }) => {
  tx(() => { db.prepare("DELETE FROM products WHERE id = ?").run(Number(params.id)); bump(); });
  removeImageFiles(Number(params.id));
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
  const cats = db.prepare(`
    SELECT COALESCE(NULLIF(p.category, ''), 'Прочее') AS name, SUM(m.qty*m.price) AS revenue, SUM(m.qty*(m.price-m.buy_price)) AS profit
    FROM movements m LEFT JOIN products p ON p.id = m.product_id
    WHERE m.type='sale' AND date(m.created, ?) BETWEEN ? AND ?
    GROUP BY 1 ORDER BY revenue DESC`).all(shift, from, to);
  const low = db.prepare("SELECT id, name, qty FROM products WHERE qty <= 2 ORDER BY qty, name LIMIT 50").all();
  send(res, 200, { from, to, ...sum, profit: sum.revenue - sum.cost, top, stock, low, cats });
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
  const rows = db.prepare("SELECT barcode, name, category, qty, buy_price, sell_price FROM products ORDER BY category, name COLLATE NOCASE").all();
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const fmt = (n) => String(n).replace(".", ",");
  const csv = "﻿" + ["Штрих-код;Название;Категория;Количество;Закупочная цена;Розничная цена"]
    .concat(rows.map((r) => [esc(r.barcode), esc(r.name), esc(r.category || "Прочее"), fmt(r.qty), fmt(r.buy_price), fmt(r.sell_price)].join(";")))
    .join("\r\n");
  send(res, 200, csv, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="ostatki-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
}, { auth: "admin" });

// ---------- Поиск названия товара по штрих-коду в открытых базах ----------
const UA = "Sklad/1.0 (inventory app; https://github.com/bekaevyunus/sklad)";

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// Семейство баз Open Facts: продукты, косметика и бытовая химия, прочие товары, корм для животных
const OPEN_FACTS = [
  ["Open Food Facts", "world.openfoodfacts.org"],
  ["Open Beauty Facts", "world.openbeautyfacts.org"],
  ["Open Products Facts", "world.openproductsfacts.org"],
  ["Open Pet Food Facts", "world.openpetfoodfacts.org"],
];

// Категория по данным Open Facts — пригодится, если по названию определить не удалось
function offHint(host, tags = []) {
  if (host.includes("beauty")) return "Косметика и гигиена";
  if (host.includes("petfood")) return "Корм для животных";
  const t = (tags || []).join(" ");
  const map = [
    ["beverages|waters|juices|sodas|teas|coffees", "Напитки"], ["dairies|milks|cheeses|yogurts", "Молочные продукты"],
    ["chocolates|candies|biscuits|confectioneries|sweet-snacks", "Сладости"], ["salty-snacks|chips|nuts", "Снеки"],
    ["breads|pastries", "Хлеб и выпечка"], ["meats|sausages|fishes|seafood", "Мясо, рыба, колбасы"],
    ["canned", "Консервы"], ["cereals|pastas|flours|sugars|condiments|sauces|oils", "Бакалея"],
    ["fruits|vegetables", "Овощи и фрукты"], ["frozen", "Замороженные продукты"], ["baby", "Детские товары"],
  ];
  for (const [re, cat] of map) if (new RegExp(re).test(t)) return cat;
  return "";
}

async function fromOpenFacts([source, host], code) {
  const fields = "product_name_ru,product_name,generic_name_ru,brands,quantity,image_front_url,image_front_small_url,categories_tags";
  const d = await getJson(`https://${host}/api/v2/product/${code}.json?fields=${fields}&lc=ru`);
  if (!d || d.status !== 1 || !d.product) return null;
  const p = d.product;
  const name = str(p.product_name_ru || p.product_name || p.generic_name_ru);
  if (!name) return null;
  return {
    name, brand: str(p.brands).split(",")[0].trim(), quantity: str(p.quantity),
    image: p.image_front_url || p.image_front_small_url || "", source, hint: offHint(host, p.categories_tags),
  };
}

async function fromUpcItemDb(code) {
  // Бесплатный пробный доступ: до 100 запросов в день с одного адреса
  const d = await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
  const it = d?.items?.[0];
  if (!it?.title) return null;
  return { name: str(it.title), brand: str(it.brand), quantity: "", image: it.images?.[0] || "", source: "UPCitemdb" };
}

// ---- Российские источники ----
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "ru" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // Кодировку берём из заголовка или <meta charset>; старые русские сайты бывают в windows-1251
  const head = buf.subarray(0, 2048).toString("latin1");
  const cs = (res.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1]
    || head.match(/charset=["']?([\w-]+)/i)?.[1] || "utf-8";
  try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch { return buf.toString("utf8"); }
}

const decodeHtml = (s) => s
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
  .replace(/&laquo;/g, "«").replace(/&raquo;/g, "»").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

// barcode-list.ru — крупнейшая русскоязычная база штрих-кодов (названия присылают пользователи)
async function fromBarcodeList(code) {
  const html = await getText(`https://barcode-list.ru/barcode/RU/${encodeURIComponent("Поиск")}.htm?barcode=${code}`);
  if (!html) return null;
  // В таблице результатов ищем строки с нашим штрих-кодом и берём из них ячейку с названием
  const names = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    if (!row.includes(code)) continue;
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(decodeHtml);
    const name = cells
      .filter((c) => c && !c.includes(code) && !/^[\d\s.,]+$/.test(c) && c.length > 3 && !/^(шт|кг|л|г|упак|уп)\.?$/i.test(c))
      .sort((a, b) => b.length - a.length)[0];
    if (name) names.push(name);
  }
  if (!names.length) return null;
  return { name: names[0], brand: "", quantity: "", image: "", source: "barcode-list.ru" };
}

// «Честный знак»: открытая проверка кода, которой пользуется их мобильное приложение
async function fromChestnyZnak(code) {
  const ean = code.padStart(13, "0");
  const d = await getJson(`https://mobile.api.crpt.ru/mobile/check?code=${ean}&codeType=ean13`);
  if (!d) return null;
  const pick = (o) => o && (o.productName || o.name || o.product_name || o.goodName);
  const name = str(pick(d) || pick(d.catalogData?.[0]) || pick(d.product) || pick(d.drugsData) || pick(d.milkData));
  if (!name || /не найден/i.test(name)) return null;
  const brand = str(d.brand || d.catalogData?.[0]?.brandName || d.producerName || "");
  return { name, brand: brand.length < 40 ? brand : "", quantity: "", image: "", source: "Честный знак" };
}

// Собираем понятное название: «Бренд Название, объём»
function fullName(r) {
  let name = r.name;
  if (r.brand && !name.toLowerCase().includes(r.brand.toLowerCase())) name = `${r.brand} ${name}`;
  if (r.quantity && !name.toLowerCase().includes(r.quantity.toLowerCase())) name += `, ${r.quantity}`;
  return name.replace(/\s+/g, " ").trim();
}

async function lookupBarcode(code) {
  const cached = db.prepare("SELECT data, created FROM lookup_cache WHERE code = ?").get(code);
  // «Не найдено» кэшируем на 7 дней (вдруг товар добавят в базу), найденное — навсегда
  if (cached && (cached.data || Date.now() - Date.parse(cached.created + "Z") < 7 * 86400000)) {
    return cached.data ? JSON.parse(cached.data) : null;
  }
  // Порядок = приоритет: сначала самые аккуратные названия
  const tries = [
    () => fromOpenFacts(OPEN_FACTS[0], code),
    () => fromChestnyZnak(code),
    () => fromBarcodeList(code),
    ...OPEN_FACTS.slice(1).map((s) => () => fromOpenFacts(s, code)),
    () => fromUpcItemDb(code),
  ];
  // Опрашиваем все базы одновременно, берём ответ самой приоритетной
  const results = await Promise.all(tries.map((t) => t().catch(() => "error")));
  const found = results.find((r) => r && r !== "error") || null;
  const out = found && { ...found, full_name: fullName(found) };
  // Если ни одна база не ответила (нет интернета) — не кэшируем
  const anyAnswered = results.some((r) => r !== "error");
  if (out || anyAnswered) {
    db.prepare("INSERT OR REPLACE INTO lookup_cache (code, data) VALUES (?, ?)").run(code, out ? JSON.stringify(out) : null);
  }
  return out;
}

// ---------- Проверка кода маркировки «Честный знак» ----------
// Используется открытая проверка, которой пользуется официальное приложение «Честный знак».
// Она не документирована, поэтому ответ разбираем гибко и показываем «сырые» данные в подробностях.
const CHZ_STATUS = {
  EMITTED: ["Код выпущен, но не нанесён на товар", "warn"],
  APPLIED: ["Нанесён, но не введён в оборот", "warn"],
  INTRODUCED: ["В обороте — товар легальный", "ok"],
  IN_CIRCULATION: ["В обороте — товар легальный", "ok"],
  RETIRED: ["Выведен из оборота (уже продан)", "warn"],
  WRITTEN_OFF: ["Списан", "bad"],
  WITHDRAWN: ["Выведен из оборота", "warn"],
  DISAGGREGATION: ["Расформирован", "warn"],
};

// Ищем значение по одному из ключей на любой глубине ответа
function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, keys, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

async function chzRequest(code) {
  const type = /^\d{8,14}$/.test(code) ? "ean13" : "datamatrix";
  const base = "https://mobile.api.crpt.ru";
  const headers = { "User-Agent": BROWSER_UA, Accept: "application/json" };
  const attempts = [
    () => fetch(`${base}/mobile/check?code=${encodeURIComponent(code)}&codeType=${type}`, { headers, signal: AbortSignal.timeout(9000) }),
    () => fetch(`${base}/v2/mobile/check`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeType: type }), signal: AbortSignal.timeout(9000),
    }),
  ];
  let lastErr;
  for (const go of attempts) {
    try {
      const res = await go();
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* не JSON */ }
      if (data && (res.ok || res.status === 404)) return { http: res.status, data };
      lastErr = new Error(`сервер ответил ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("нет ответа");
}

route("GET", "/api/chz/check", async (req, res, { query }) => {
  const code = String(query.get("code") || "").replace(/[\r\n]/g, "").trim();
  if (code.length < 8) throw bad("Отсканируйте код маркировки (квадратный DataMatrix на упаковке)");
  const gtinMatch = code.match(/^\(?01\)?(\d{14})/);
  const gtin = gtinMatch ? gtinMatch[1] : (/^\d{8,14}$/.test(code) ? code.padStart(14, "0") : "");
  const ean = gtin ? gtin.replace(/^0/, "") : "";
  const local = ean ? db.prepare("SELECT id, name FROM products WHERE barcode = ? OR barcode = ?").get(ean, gtin) : null;

  let r;
  try { r = await chzRequest(code); }
  catch (e) {
    return send(res, 200, { verdict: "error", title: "Нет связи с «Честным знаком»", text: e.message, gtin, local });
  }
  const d = r.data || {};
  const found = deepFind(d, ["codeFounded", "found", "isFound"]);
  const statusRaw = String(deepFind(d, ["status", "cisStatus", "state"]) || "").toUpperCase();
  const name = deepFind(d, ["productName", "name", "goodName", "product_name"]);
  const producer = deepFind(d, ["producerName", "manufacturerName", "producer", "ownerName"]);
  const expire = deepFind(d, ["expireDate", "expirationDate", "expiration_date", "expDate", "bestBefore"]);
  const group = deepFind(d, ["productGroup", "category", "pg", "productGroupName"]);
  const countryName = deepFind(d, ["country", "countryName", "producerCountry"]);
  const st = CHZ_STATUS[statusRaw];

  let verdict, title;
  if (found === false || r.http === 404) { verdict = "bad"; title = "Код не найден в системе «Честный знак»"; }
  else if (st) { verdict = st[1]; title = st[0]; }
  else if (name) { verdict = "ok"; title = "Код найден в системе"; }
  else { verdict = "unknown"; title = "Не удалось разобрать ответ"; }
  // Просроченный товар
  if (expire && Date.parse(expire) && Date.parse(expire) < Date.now()) { verdict = "bad"; title = "Срок годности истёк"; }

  send(res, 200, {
    verdict, title, status: statusRaw || null, name: name || null, producer: typeof producer === "string" ? producer : null,
    expire: expire || null, group: typeof group === "string" ? group : null, country: typeof countryName === "string" ? countryName : null,
    gtin, ean, local, codeType: /^\d{8,14}$/.test(code) ? "ean13" : "datamatrix", raw: d,
  });
});

// Проверка источников: открыть в браузере /api/lookup-debug/ШТРИХКОД — видно, что ответила каждая база
route("GET", "/api/lookup-debug/:code", async (req, res, { params }) => {
  const code = decodeURIComponent(params.code).replace(/\s/g, "");
  if (!/^\d{8,14}$/.test(code)) throw bad("Нужен штрих-код из 8–14 цифр");
  const sources = {
    "Open Food Facts": () => fromOpenFacts(OPEN_FACTS[0], code),
    "Честный знак": () => fromChestnyZnak(code),
    "barcode-list.ru": () => fromBarcodeList(code),
    "Open Beauty/Products/Pet": async () => (await Promise.all(OPEN_FACTS.slice(1).map((s) => fromOpenFacts(s, code)))).find(Boolean) || null,
    "UPCitemdb": () => fromUpcItemDb(code),
  };
  const out = {};
  await Promise.all(Object.entries(sources).map(async ([k, f]) => {
    try { out[k] = (await f())?.name || "не найдено"; } catch (e) { out[k] = "ошибка связи: " + (e.cause?.code || e.name || e.message); }
  }));
  send(res, 200, out);
}, { auth: "admin" });

route("GET", "/api/lookup/:code", async (req, res, { params }) => {
  const code = decodeURIComponent(params.code).replace(/\s/g, "");
  if (!/^\d{8,14}$/.test(code)) throw bad("Искать можно только обычные штрих-коды (8–14 цифр)");
  const r = await lookupBarcode(code);
  if (!r) throw new HttpError(404, "Товар не найден в открытых базах");
  send(res, 200, { ...r, category: guessCategory(r.full_name, r.hint) });
});

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
function serveImage(res, name) {
  if (!/^\d+\.(jpg|png|webp)$/.test(name)) return send(res, 404, { error: "Не найдено" });
  const file = path.join(IMAGES_DIR, name);
  if (!fs.existsSync(file)) return send(res, 404, { error: "Не найдено" });
  const ext = name.split(".").pop();
  res.writeHead(200, { "Content-Type": ext === "jpg" ? "image/jpeg" : `image/${ext}`, "Cache-Control": "public, max-age=31536000, immutable" });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Нет доступа" });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(pathname)) return send(res, 404, { error: "Не найдено" });
    file = path.join(PUBLIC_DIR, "index.html");
  }
  // Браузер каждый раз сверяется с сервером: после обновления приложения сразу видно новое оформление,
  // а если файл не менялся — сервер отвечает коротким «304 Не изменилось»
  const mtime = fs.statSync(file).mtime;
  mtime.setMilliseconds(0);
  const since = Date.parse(req.headers["if-modified-since"] || "");
  const headers = { "Cache-Control": "no-cache", "Last-Modified": mtime.toUTCString() };
  if (since && since >= mtime.getTime()) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// ---------- Сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/images/")) return serveImage(res, url.pathname.slice(8));
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

server.listen(PORT, () => {
  console.log(`Склад запущен.`);
  console.log(`  На этом компьютере:  http://localhost:${PORT}`);
  // Адреса в локальной сети — по ним заходят с телефонов в том же Wi-Fi
  for (const list of Object.values(require("node:os").networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) console.log(`  С телефона (Wi-Fi):  http://${a.address}:${PORT}`);
    }
  }
  console.log(`Не закрывайте это окно, пока работаете с приложением.`);
});
