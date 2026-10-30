"use strict";
// Склад — интерфейс. Один файл, без сборки.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n || 0) + " ₽";
const qtyFmt = (n) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(n || 0);
const toNum = (v) => Number(String(v ?? "").replace(",", ".").replace(/\s/g, ""));
const TZ = new Date().getTimezoneOffset();
const today = () => new Date(Date.now() - TZ * 60000).toISOString().slice(0, 10);
const shiftDay = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

const state = {
  user: null,
  view: "sale",
  version: 0,
  online: true,
  products: [],     // кэш для поиска по названию
  cart: [],         // [{ product, qty }]
  received: null,   // товар, найденный на экране прихода
  newBarcode: null, // штрих-код, которого нет в базе
  period: { preset: "today", from: today(), to: today() },
};

// ---------- Сеть ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/login") { state.user = null; render(); throw new Error("Нужно войти"); }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "err" ? 4000 : 2200);
}

function beep(ok = true) {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = ok ? 1200 : 300;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* звук не обязателен */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 60, 80]);
}

async function loadProducts() {
  state.products = await api("GET", "/api/products");
}

// ---------- Синхронизация между устройствами ----------
// Каждые 4 секунды спрашиваем у сервера номер версии данных;
// если кто-то что-то изменил — обновляем текущий экран.
async function syncTick() {
  if (!state.user || document.hidden) return;
  try {
    const { version } = await api("GET", "/api/version");
    setOnline(true);
    if (version !== state.version) {
      state.version = version;
      await loadProducts();
      // Обновляем цены и остатки в корзине
      state.cart = state.cart
        .map((l) => ({ ...l, product: state.products.find((p) => p.id === l.product.id) }))
        .filter((l) => l.product);
      if (!$(".modal-back") && !isTyping()) refreshView();
    }
  } catch { setOnline(false); }
}
function setOnline(on) {
  state.online = on;
  const dot = $(".sync");
  if (dot) { dot.classList.toggle("off", !on); dot.title = on ? "Синхронизировано" : "Нет связи с сервером"; }
}
function isTyping() {
  const a = document.activeElement;
  return a && a.tagName === "INPUT" && a.id !== "scan" && a.value !== "";
}
setInterval(syncTick, 4000);
document.addEventListener("visibilitychange", syncTick);

// ---------- Отрисовка ----------
const VIEWS = {
  sale: { title: "Продажа", render: renderSale },
  receive: { title: "Приход", render: renderReceive },
  products: { title: "Товары", render: renderProducts },
  reports: { title: "Отчёты", render: renderReports, admin: true },
  staff: { title: "Сотрудники", render: renderStaff, admin: true },
};

function render() {
  const app = $("#app");
  if (!state.user) return renderLogin(app);
  const isAdmin = state.user.role === "admin";
  app.innerHTML = `
    <header class="top">
      <span class="brand">Склад</span>
      <span class="who">
        <span class="sync" title="Синхронизировано"></span>
        <span>${esc(state.user.name)}${isAdmin ? " · владелец" : ""}</span>
        <button id="logout">Выйти</button>
      </span>
    </header>
    <nav class="nav">
      ${Object.entries(VIEWS).filter(([, v]) => !v.admin || isAdmin)
        .map(([k, v]) => `<button data-view="${k}" class="${state.view === k ? "on" : ""}">${v.title}</button>`).join("")}
    </nav>
    <main id="main"></main>`;
  $("#logout").onclick = async () => { await api("POST", "/api/logout").catch(() => {}); state.user = null; render(); };
  app.querySelectorAll(".nav button").forEach((b) => (b.onclick = () => { state.view = b.dataset.view; render(); }));
  setOnline(state.online);
  refreshView();
}

function refreshView() {
  const main = $("#main");
  if (!main) return;
  const v = VIEWS[state.view];
  if (!v || (v.admin && state.user.role !== "admin")) { state.view = "sale"; return render(); }
  scanTarget = null;
  v.render(main);
}

function renderLogin(app) {
  app.innerHTML = `
    <form class="card login form" id="login">
      <div class="brand">Склад</div>
      <label>Имя<input type="text" name="name" autocomplete="username" required></label>
      <label>Пароль<input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn big">Войти</button>
    </form>`;
  $("#login").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      state.user = await api("POST", "/api/login", { name: f.get("name"), password: f.get("password") });
      await start();
    } catch (err) { toast(err.message, "err"); }
  };
}

// ---------- Поле сканирования (USB-сканер + ввод вручную + камера) ----------
function scanBox(placeholder) {
  return `
    <div class="scan">
      <input id="scan" type="text" inputmode="search" autocomplete="off" placeholder="${esc(placeholder)}">
      <button class="btn icon" id="cam" title="Сканировать камерой">📷</button>
    </div>
    <div id="suggest"></div>
    <div class="scan-hint">Сканируйте штрих-код сканером или камерой, либо начните вводить название.</div>`;
}

function bindScan(onProduct, onUnknown) {
  const input = $("#scan");
  const box = $("#suggest");
  const pick = (p) => { input.value = ""; box.innerHTML = ""; onProduct(p); input.focus(); };

  async function lookup(code) {
    code = code.trim();
    if (!code) return;
    const local = state.products.find((p) => p.barcode === code);
    if (local) { beep(); return pick(local); }
    try {
      const p = await api("GET", "/api/products/barcode/" + encodeURIComponent(code));
      beep();
      pick(p);
    } catch {
      // Не штрих-код? Тогда ищем по названию
      const found = searchByName(code);
      if (found.length === 1) { beep(); return pick(found[0]); }
      if (found.length > 1) return showSuggest(code);
      beep(false);
      input.value = "";
      box.innerHTML = "";
      onUnknown(code);
    }
  }

  function showSuggest(text) {
    const list = searchByName(text).slice(0, 8);
    box.innerHTML = list.length ? `<div class="suggest">${list.map((p, i) =>
      `<button data-i="${i}"><span>${esc(p.name)}</span><span class="muted">${qtyFmt(p.qty)} шт · ${money(p.sell_price)}</span></button>`).join("")}</div>` : "";
    box.querySelectorAll("button").forEach((b) => (b.onclick = () => pick(list[Number(b.dataset.i)])));
  }

  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(input.value); } };
  input.oninput = () => {
    const v = input.value.trim();
    if (v.length >= 2 && /\D/.test(v)) showSuggest(v); else box.innerHTML = "";
  };
  $("#cam").onclick = () => openCamera((code) => lookup(code));
  if (matchMedia("(pointer: fine)").matches) input.focus();
  scanTarget = lookup;
}

function searchByName(text) {
  const q = text.toLowerCase();
  return state.products.filter((p) => p.name.toLowerCase().includes(q));
}

// USB-сканер работает как клавиатура: быстро «печатает» цифры и жмёт Enter.
// Ловим это, даже если курсор не в поле сканирования.
let scanTarget = null;
let scanBuf = "", scanLast = 0;
document.addEventListener("keydown", (e) => {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA")) return;
  if (!scanTarget || $(".modal-back")) return;
  const now = Date.now();
  if (now - scanLast > 80) scanBuf = "";
  scanLast = now;
  if (e.key === "Enter") { if (scanBuf.length >= 4) scanTarget(scanBuf); scanBuf = ""; return; }
  if (e.key.length === 1) scanBuf += e.key;
});

// ---------- Камера ----------
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];

async function openCamera(onCode) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <h2>Наведите на штрих-код <button class="x" id="cam-close">✕</button></h2>
      <div id="cam-area"></div>
      <p class="muted">Держите телефон на расстоянии 10–20 см, штрих-код — внутри рамки.</p>
    </div>`;
  document.body.appendChild(back);
  let stop = () => {};
  let done = false;
  const close = () => { done = true; stop(); back.remove(); $("#scan")?.focus(); };
  $("#cam-close").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  const found = (code) => { if (done) return; close(); onCode(code); };

  if (!window.isSecureContext) {
    $("#cam-area").innerHTML = `<p class="low">Камера работает только по защищённому адресу (https://). Используйте сканер или ввод вручную.</p>`;
    return;
  }

  try {
    // 1) Встроенный распознаватель браузера (Android Chrome) — быстрый и без библиотек
    if ("BarcodeDetector" in window) {
      const supported = await BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new BarcodeDetector({ formats });
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        $("#cam-area").innerHTML = `<div class="camera"><video playsinline muted></video><div class="frame"></div></div>`;
        const video = $("#cam-area video");
        video.srcObject = stream;
        await video.play();
        stop = () => stream.getTracks().forEach((t) => t.stop());
        const loop = async () => {
          if (done) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length) return found(codes[0].rawValue);
          } catch { /* кадр не готов */ }
          setTimeout(loop, 120);
        };
        return loop();
      }
    }
    // 2) Библиотека html5-qrcode (iPhone и другие браузеры)
    await loadScript("/vendor/html5-qrcode.min.js").catch(() => loadScript("https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"));
    $("#cam-area").innerHTML = `<div id="cam-lib"></div>`;
    const scanner = new Html5Qrcode("cam-lib", { verbose: false });
    stop = () => { scanner.stop().catch(() => {}); };
    await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 140 } }, (text) => found(text));
  } catch (e) {
    $("#cam-area").innerHTML = `<p class="low">Не удалось включить камеру: ${esc(e.message || e)}.<br>Разрешите доступ к камере в настройках браузера.</p>`;
  }
}

function loadScript(src) {
  return new Promise((ok, fail) => {
    if (window.Html5Qrcode) return ok();
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => { s.remove(); fail(new Error("не загрузилась библиотека сканера")); };
    document.head.appendChild(s);
  });
}

// ---------- Окно (модальное) ----------
function modal(title, html, onMount) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal"><h2>${esc(title)} <button class="x" data-close>✕</button></h2>${html}</div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); refreshView(); };
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  onMount?.(back, close);
  back.querySelector("input:not([type=hidden])")?.focus();
  return close;
}

// ---------- ПРОДАЖА ----------
function renderSale(main) {
  const total = state.cart.reduce((s, l) => s + l.qty * l.product.sell_price, 0);
  main.innerHTML = `
    <div class="card">${scanBox("Штрих-код или название товара")}</div>
    <div class="card">
      <h2>Корзина</h2>
      <div id="cart">
        ${state.cart.length ? state.cart.map((l, i) => `
          <div class="cart-line">
            <div><div class="name">${esc(l.product.name)}</div>
              <div class="muted">${money(l.product.sell_price)} · на складе ${qtyFmt(l.product.qty)}</div></div>
            <div class="qty">
              <button data-dec="${i}">−</button>
              <input data-q="${i}" type="text" inputmode="decimal" value="${qtyFmt(l.qty)}">
              <button data-inc="${i}">+</button>
            </div>
            <div class="num sum">${money(l.qty * l.product.sell_price)}</div>
            <button class="x" data-del="${i}" title="Убрать">✕</button>
          </div>`).join("") : `<div class="empty">Отсканируйте товар, чтобы добавить его в корзину</div>`}
      </div>
      <div class="total"><span>Итого</span><span>${money(total)}</span></div>
      <div class="row">
        <button class="btn big" id="sell" ${state.cart.length ? "" : "disabled"}>Продать</button>
        ${state.cart.length ? `<button class="btn ghost" id="clear">Очистить</button>` : ""}
      </div>
    </div>
    <div class="card"><h2>${state.user.role === "admin" ? "Продажи за сегодня" : "Мои продажи за сегодня"}</h2><div id="today">…</div></div>`;

  bindScan(addToCart, (code) => {
    if (state.user.role === "admin") {
      if (confirm(`Товара со штрих-кодом ${code} нет в базе. Добавить его?`)) productForm(null, code);
    } else toast(`Товар ${code} не найден. Попросите владельца добавить его.`, "err");
  });

  main.querySelectorAll("[data-inc]").forEach((b) => (b.onclick = () => { state.cart[b.dataset.inc].qty += 1; refreshView(); }));
  main.querySelectorAll("[data-dec]").forEach((b) => (b.onclick = () => {
    const l = state.cart[b.dataset.dec];
    l.qty = Math.max(1, l.qty - 1);
    refreshView();
  }));
  main.querySelectorAll("[data-q]").forEach((inp) => (inp.onchange = () => {
    const n = toNum(inp.value);
    if (n > 0) state.cart[inp.dataset.q].qty = n;
    refreshView();
  }));
  main.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { state.cart.splice(b.dataset.del, 1); refreshView(); }));
  $("#clear") && ($("#clear").onclick = () => { if (confirm("Очистить корзину?")) { state.cart = []; refreshView(); } });
  $("#sell").onclick = sell;
  loadTodaySales();
}

function addToCart(p) {
  const line = state.cart.find((l) => l.product.id === p.id);
  if (line) line.qty += 1; else state.cart.push({ product: p, qty: 1 });
  refreshView();
  $("#scan")?.focus();
}

async function sell() {
  const short = state.cart.filter((l) => l.qty > l.product.qty);
  if (short.length && !confirm(
    "Не хватает на складе:\n" + short.map((l) => `• ${l.product.name}: есть ${qtyFmt(l.product.qty)}, продаёте ${qtyFmt(l.qty)}`).join("\n") +
    "\n\nВсё равно продать? Остаток уйдёт в минус.")) return;
  const btn = $("#sell");
  btn.disabled = true;
  try {
    const r = await api("POST", "/api/sales", { items: state.cart.map((l) => ({ product_id: l.product.id, qty: l.qty })) });
    state.cart = [];
    toast(`Продано на ${money(r.total)}`, "ok");
    await loadProducts();
    refreshView();
  } catch (e) { toast(e.message, "err"); btn.disabled = false; }
}

async function loadTodaySales() {
  const box = $("#today");
  try {
    const sales = await api("GET", `/api/sales?tz=${TZ}`);
    if (!box.isConnected) return;
    const sum = sales.reduce((s, x) => s + x.total, 0);
    box.innerHTML = sales.length ? `
      <div class="muted" style="margin-bottom:6px">${sales.length} продаж на ${money(sum)}</div>
      <table><tbody>${sales.slice(0, 30).map((s) => `
        <tr><td class="muted">${s.created.slice(11, 16)}</td>
          <td>${s.items.map((i) => `${esc(i.product_name)} × ${qtyFmt(i.qty)}`).join(", ")}
            ${state.user.role === "admin" ? `<div class="muted">${esc(s.seller || "")}</div>` : ""}</td>
          <td class="num">${money(s.total)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Пока продаж нет</div>`;
  } catch (e) { box.textContent = e.message; }
}

// ---------- ПРИХОД ----------
function renderReceive(main) {
  const p = state.received;
  const isAdmin = state.user.role === "admin";
  main.innerHTML = `
    <div class="card">${scanBox("Штрих-код или название поступившего товара")}</div>
    ${p ? `
    <form class="card form" id="recv">
      <h2>${esc(p.name)}</h2>
      <div class="muted">Сейчас на складе: <b>${qtyFmt(p.qty)}</b> · розничная ${money(p.sell_price)}${isAdmin ? ` · закупочная ${money(p.buy_price)}` : ""}</div>
      <div class="row">
        <label>Пришло, шт<input name="qty" type="text" inputmode="decimal" value="1" required></label>
        ${isAdmin ? `
        <label>Закупочная цена<input name="buy_price" type="text" inputmode="decimal" value="${p.buy_price}"></label>
        <label>Розничная цена<input name="sell_price" type="text" inputmode="decimal" value="${p.sell_price}"></label>` : ""}
      </div>
      <div class="row">
        <button class="btn big">Оприходовать</button>
        <button type="button" class="btn ghost" id="recv-cancel">Отмена</button>
      </div>
    </form>` : `<div class="card empty">Отсканируйте поступивший товар. Если его ещё нет в базе${isAdmin ? ", появится форма добавления" : " — попросите владельца добавить его"}.</div>`}
    ${isAdmin ? `<button class="btn light" id="new-prod">+ Новый товар без штрих-кода</button>` : ""}`;

  bindScan((prod) => { state.received = prod; refreshView(); setTimeout(() => $("#recv [name=qty]")?.select(), 0); }, (code) => {
    if (isAdmin) productForm(null, code);
    else toast(`Товар ${code} не найден. Попросите владельца добавить его.`, "err");
  });
  $("#new-prod") && ($("#new-prod").onclick = () => productForm(null, ""));
  if (!p) return;
  $("#recv-cancel").onclick = () => { state.received = null; refreshView(); };
  $("#recv").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { product_id: p.id, qty: f.get("qty") };
    if (isAdmin) { body.buy_price = f.get("buy_price"); body.sell_price = f.get("sell_price"); }
    try {
      const upd = await api("POST", "/api/receive", body);
      toast(`${upd.name}: +${qtyFmt(toNum(body.qty))}, теперь ${qtyFmt(upd.qty)}`, "ok");
      state.received = null;
      await loadProducts();
      refreshView();
    } catch (err) { toast(err.message, "err"); }
  };
}

// ---------- ТОВАРЫ ----------
let productQuery = "";
function renderProducts(main) {
  const isAdmin = state.user.role === "admin";
  const list = productQuery
    ? state.products.filter((p) => p.name.toLowerCase().includes(productQuery.toLowerCase()) || (p.barcode || "").includes(productQuery))
    : state.products;
  const totalQty = list.reduce((s, p) => s + Math.max(0, p.qty), 0);
  main.innerHTML = `
    <div class="toolbar">
      <input type="search" id="pq" placeholder="Поиск по названию или штрих-коду" value="${esc(productQuery)}">
      ${isAdmin ? `<button class="btn" id="add">+ Товар</button>
      <a class="btn ghost" href="/api/export.csv" download>⬇ Excel</a>` : ""}
    </div>
    <div class="card" style="padding:0 6px">
      <table>
        <thead><tr>
          <th>Название</th><th class="hide-m">Штрих-код</th><th class="num">Остаток</th>
          ${isAdmin ? `<th class="num hide-m">Закупка</th>` : ""}<th class="num">Цена</th>
        </tr></thead>
        <tbody>${list.length ? list.map((p) => `
          <tr class="${isAdmin ? "click" : ""}" data-id="${p.id}">
            <td>${esc(p.name)}</td>
            <td class="hide-m muted">${esc(p.barcode || "—")}</td>
            <td class="num ${p.qty <= 2 ? "low" : ""}">${qtyFmt(p.qty)}</td>
            ${isAdmin ? `<td class="num hide-m">${money(p.buy_price)}</td>` : ""}
            <td class="num">${money(p.sell_price)}</td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty">${productQuery ? "Ничего не найдено" : "Товаров пока нет"}</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="muted">Позиций: ${list.length} · единиц на складе: ${qtyFmt(totalQty)}</div>`;

  const q = $("#pq");
  q.oninput = () => {
    productQuery = q.value.trim();
    const pos = q.selectionStart;
    refreshView();
    const nq = $("#pq"); nq.focus(); nq.setSelectionRange(pos, pos);
  };
  if (!isAdmin) return;
  $("#add").onclick = () => productForm(null, "");
  main.querySelectorAll("tr.click").forEach((tr) => (tr.onclick = () => productForm(state.products.find((p) => p.id === Number(tr.dataset.id)))));
}

function productForm(p, barcode = "") {
  const isNew = !p;
  modal(isNew ? "Новый товар" : "Товар", `
    <form class="form" id="pf">
      <label>Название<input name="name" type="text" value="${esc(p?.name || "")}" required></label>
      <label>Штрих-код
        <div class="scan"><input name="barcode" type="text" value="${esc(p?.barcode ?? barcode)}" placeholder="Можно оставить пустым">
        <button type="button" class="btn icon light" id="pf-cam" title="Сканировать камерой">📷</button>
        <button type="button" class="btn icon light" id="pf-find" title="Найти название по штрих-коду">🔍</button></div>
      </label>
      <div id="pf-found" class="found" hidden></div>
      <div class="row">
        <label>${isNew ? "Количество" : "Остаток"}<input name="qty" type="text" inputmode="decimal" value="${p ? p.qty : 0}"></label>
        <label>Закупочная цена<input name="buy_price" type="text" inputmode="decimal" value="${p?.buy_price ?? ""}" placeholder="0"></label>
        <label>Розничная цена<input name="sell_price" type="text" inputmode="decimal" value="${p?.sell_price ?? ""}" placeholder="0"></label>
      </div>
      ${!isNew ? `<div class="muted">Остаток лучше менять через «Приход». Ручная правка записывается как корректировка.</div>` : ""}
      <div id="margin" class="muted"></div>
      <div class="row">
        <button class="btn big">${isNew ? "Добавить" : "Сохранить"}</button>
        ${!isNew ? `<button type="button" class="btn danger" id="pf-del">Удалить</button>` : ""}
      </div>
    </form>`, (root, close) => {
    const f = $("#pf", root);
    if (barcode && isNew) setTimeout(() => f.name.focus(), 0);
    const showMargin = () => {
      const b = toNum(f.buy_price.value), s = toNum(f.sell_price.value);
      $("#margin", root).textContent = b > 0 && s > 0 ? `Наценка: ${money(s - b)} (${Math.round(((s - b) / b) * 100)}%)` : "";
    };
    f.buy_price.oninput = f.sell_price.oninput = showMargin;
    showMargin();
    // Поиск названия в открытых базах штрих-кодов
    const info = $("#pf-found", root);
    const findName = async (auto) => {
      const code = f.barcode.value.trim();
      if (!/^\d{8,14}$/.test(code)) { if (!auto) toast("Сначала укажите штрих-код (8–14 цифр)", "err"); return; }
      info.hidden = false;
      info.innerHTML = `<span class="spin"></span> Ищу название по штрих-коду…`;
      try {
        const r = await api("GET", "/api/lookup/" + code);
        if (!f.isConnected) return;
        const typed = f.name.value.trim();
        if (!typed || !auto) f.name.value = r.full_name;
        info.innerHTML = `
          ${r.image ? `<img src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
          <div><b>Найдено:</b> ${esc(r.full_name)}<div class="muted">Источник: ${esc(r.source)}. Проверьте и при необходимости исправьте название.</div>
          ${typed && auto ? `<button type="button" class="btn light" id="pf-use">Взять это название</button>` : ""}</div>`;
        const use = $("#pf-use", root);
        if (use) use.onclick = () => { f.name.value = r.full_name; use.remove(); };
        if (auto) setTimeout(() => { const el = f.name.value === r.full_name ? f.qty : f.name; el.focus(); el.select(); }, 0);
      } catch (e) {
        if (!f.isConnected) return;
        info.innerHTML = `<div class="muted">${esc(e.message)}. Введите название вручную.</div>`;
      }
    };
    $("#pf-find", root).onclick = () => findName(false);
    $("#pf-cam", root).onclick = () => openCamera((code) => { f.barcode.value = code; beep(); if (isNew) findName(true); });
    if (isNew && barcode) findName(true);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        name: f.name.value, barcode: f.barcode.value, qty: f.qty.value || 0,
        buy_price: f.buy_price.value || 0, sell_price: f.sell_price.value || 0,
      };
      try {
        if (isNew) await api("POST", "/api/products", body);
        else await api("PUT", `/api/products/${p.id}`, body);
        toast(isNew ? "Товар добавлен" : "Сохранено", "ok");
        await loadProducts();
        close();
      } catch (err) { toast(err.message, "err"); }
    };
    const del = $("#pf-del", root);
    if (del) del.onclick = async () => {
      if (!confirm(`Удалить «${p.name}»? История продаж сохранится.`)) return;
      try { await api("DELETE", `/api/products/${p.id}`); await loadProducts(); close(); toast("Удалено"); }
      catch (err) { toast(err.message, "err"); }
    };
  });
}

// ---------- ОТЧЁТЫ ----------
const PRESETS = {
  today: ["Сегодня", () => [today(), today()]],
  yesterday: ["Вчера", () => [shiftDay(today(), -1), shiftDay(today(), -1)]],
  week: ["7 дней", () => [shiftDay(today(), -6), today()]],
  month: ["Этот месяц", () => [today().slice(0, 8) + "01", today()]],
  prev: ["Прошлый месяц", () => {
    const first = today().slice(0, 8) + "01";
    const last = shiftDay(first, -1);
    return [last.slice(0, 8) + "01", last];
  }],
};

async function renderReports(main) {
  const per = state.period;
  main.innerHTML = `
    <div class="periods">
      ${Object.entries(PRESETS).map(([k, [t]]) => `<button data-p="${k}" class="${per.preset === k ? "on" : ""}">${t}</button>`).join("")}
    </div>
    <div class="row" style="margin-bottom:14px">
      <label>С<input type="date" id="from" value="${per.from}"></label>
      <label>По<input type="date" id="to" value="${per.to}"></label>
    </div>
    <div id="rep"><div class="empty">Загрузка…</div></div>`;
  main.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => {
    const [from, to] = PRESETS[b.dataset.p][1]();
    state.period = { preset: b.dataset.p, from, to };
    refreshView();
  }));
  $("#from").onchange = $("#to").onchange = () => {
    state.period = { preset: "", from: $("#from").value, to: $("#to").value || $("#from").value };
    refreshView();
  };

  const qs = `from=${per.from}&to=${per.to}&tz=${TZ}`;
  try {
    const [r, sales, moves] = await Promise.all([
      api("GET", `/api/report?${qs}`), api("GET", `/api/sales?${qs}`), api("GET", `/api/movements?${qs}`),
    ]);
    const box = $("#rep");
    if (!box) return;
    const ins = moves.filter((m) => m.type !== "sale");
    box.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="label">Выручка</div><div class="value">${money(r.revenue)}</div></div>
        <div class="stat"><div class="label">Себестоимость</div><div class="value">${money(r.cost)}</div></div>
        <div class="stat good"><div class="label">Прибыль</div><div class="value">${money(r.profit)}</div></div>
        <div class="stat"><div class="label">Продаж</div><div class="value">${r.count}</div></div>
      </div>
      <div class="stats">
        <div class="stat"><div class="label">Товар на складе (по закупке)</div><div class="value">${money(r.stock.buy_value)}</div></div>
        <div class="stat"><div class="label">Товар на складе (по рознице)</div><div class="value">${money(r.stock.sell_value)}</div></div>
      </div>

      ${r.low.length ? `<div class="card"><h2>Заканчивается</h2>
        ${r.low.map((p) => `<span class="badge warn" style="margin:2px">${esc(p.name)}: ${qtyFmt(p.qty)}</span>`).join(" ")}</div>` : ""}

      <div class="card"><h2>Что продаётся лучше</h2>
        ${r.top.length ? `<table><thead><tr><th>Товар</th><th class="num">Кол-во</th><th class="num">Выручка</th><th class="num">Прибыль</th></tr></thead>
        <tbody>${r.top.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${qtyFmt(t.qty)}</td>
          <td class="num">${money(t.revenue)}</td><td class="num">${money(t.profit)}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">Продаж за период нет</div>`}
      </div>

      <div class="card"><h2>Продажи</h2>
        ${sales.length ? `<table><tbody>${sales.map((s) => `
          <tr><td class="muted">${s.created.slice(8, 10)}.${s.created.slice(5, 7)} ${s.created.slice(11, 16)}</td>
            <td>${s.items.map((i) => `${esc(i.product_name)} × ${qtyFmt(i.qty)}`).join(", ")}<div class="muted">${esc(s.seller || "")}</div></td>
            <td class="num">${money(s.total)}<div class="muted">прибыль ${money(s.total - s.cost)}</div></td>
            <td><button class="x" data-cancel="${s.id}" title="Отменить продажу (вернуть товар)">↩</button></td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">Нет продаж</div>`}
      </div>

      <div class="card"><h2>Приход и корректировки</h2>
        ${ins.length ? `<table><tbody>${ins.map((m) => `
          <tr><td class="muted">${m.created.slice(8, 10)}.${m.created.slice(5, 7)} ${m.created.slice(11, 16)}</td>
            <td>${esc(m.product_name)} <span class="badge ${m.type === "adjust" ? "warn" : ""}">${m.type === "in" ? "приход" : "правка"}</span>
              <div class="muted">${esc(m.user || "")}</div></td>
            <td class="num">${m.qty > 0 ? "+" : ""}${qtyFmt(m.qty)}${m.type === "in" ? `<div class="muted">по ${money(m.buy_price)}</div>` : ""}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">Нет записей</div>`}
      </div>`;
    box.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
      if (!confirm("Отменить эту продажу? Товар вернётся на склад.")) return;
      try { await api("DELETE", `/api/sales/${b.dataset.cancel}`); toast("Продажа отменена"); await loadProducts(); refreshView(); }
      catch (e) { toast(e.message, "err"); }
    }));
  } catch (e) {
    const box = $("#rep");
    if (box) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------- СОТРУДНИКИ ----------
async function renderStaff(main) {
  main.innerHTML = `
    <div class="card">
      <h2>Добавить сотрудника</h2>
      <form class="row" id="nu">
        <label>Имя для входа<input name="name" type="text" required></label>
        <label>Пароль<input name="password" type="text" required minlength="4"></label>
        <label>Роль<select name="role"><option value="seller">Продавец</option><option value="admin">Владелец</option></select></label>
        <button class="btn">Добавить</button>
      </form>
      <p class="muted">Продавец может продавать и принимать товар, но не видит закупочные цены, прибыль и отчёты.</p>
    </div>
    <div class="card" id="ul"><div class="empty">Загрузка…</div></div>`;
  $("#nu").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("POST", "/api/users", Object.fromEntries(f));
      toast("Сотрудник добавлен", "ok");
      refreshView();
    } catch (err) { toast(err.message, "err"); }
  };
  try {
    const users = await api("GET", "/api/users");
    const box = $("#ul");
    if (!box) return;
    box.innerHTML = `<table><tbody>${users.map((u) => `
      <tr><td><b>${esc(u.name)}</b> <span class="badge">${u.role === "admin" ? "владелец" : "продавец"}</span>
          ${u.active ? "" : `<span class="badge off">отключён</span>`}</td>
        <td class="num">
          <button class="btn ghost" data-pass="${u.id}">Пароль</button>
          ${u.id !== state.user.id ? `
          <button class="btn ghost" data-act="${u.id}" data-on="${u.active ? 0 : 1}">${u.active ? "Отключить" : "Включить"}</button>
          <button class="btn danger" data-del="${u.id}">Удалить</button>` : ""}
        </td></tr>`).join("")}</tbody></table>`;
    box.querySelectorAll("[data-pass]").forEach((b) => (b.onclick = async () => {
      const pw = prompt("Новый пароль (минимум 4 символа):");
      if (!pw) return;
      try { await api("PUT", `/api/users/${b.dataset.pass}`, { password: pw }); toast("Пароль изменён", "ok"); }
      catch (e) { toast(e.message, "err"); }
    }));
    box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
      try { await api("PUT", `/api/users/${b.dataset.act}`, { active: b.dataset.on === "1" }); refreshView(); }
      catch (e) { toast(e.message, "err"); }
    }));
    box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm("Удалить сотрудника? Его продажи останутся в отчётах.")) return;
      try { await api("DELETE", `/api/users/${b.dataset.del}`); refreshView(); }
      catch (e) { toast(e.message, "err"); }
    }));
  } catch (e) { $("#ul").textContent = e.message; }
}

// ---------- Запуск ----------
async function start() {
  try {
    const me = await api("GET", "/api/me");
    state.user = me;
    state.version = me.version;
    await loadProducts();
  } catch { state.user = null; }
  render();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
start();
