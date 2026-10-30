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
  categories: [],   // список категорий для подсказок
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
async function loadCategories() {
  state.categories = await api("GET", "/api/categories").catch(() => state.categories);
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

// Иконки для нижней панели (в стиле SF Symbols)
const ICONS = {
  sale: '<path d="M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>',
  receive: '<path d="M21 8.5 12 4 3 8.5v7L12 20l9-4.5z"/><path d="M3 8.5 12 13l9-4.5M12 13v7"/>',
  products: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  staff: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 6 4.8"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;

function render() {
  const app = $("#app");
  if (!state.user) return renderLogin(app);
  const isAdmin = state.user.role === "admin";
  const v = VIEWS[state.view] || VIEWS.sale;
  app.innerHTML = `
    <header class="top">
      <div class="top-bar">
        <span class="who"><span class="sync" title="Синхронизировано"></span>${esc(state.user.name)}<span class="role">${isAdmin ? "владелец" : "продавец"}</span></span>
        <button id="logout" class="link">Выйти</button>
      </div>
    </header>
    <main>
      <h1 class="large-title">${v.title}</h1>
      <div id="main"></div>
    </main>
    <nav class="tabbar">
      ${Object.entries(VIEWS).filter(([, x]) => !x.admin || isAdmin)
        .map(([k, x]) => `<button data-view="${k}" class="${state.view === k ? "on" : ""}">${icon(k)}<span>${x.title}</span></button>`).join("")}
    </nav>`;
  $("#logout").onclick = async () => {
    if (!confirm("Выйти из аккаунта?")) return;
    await api("POST", "/api/logout").catch(() => {}); state.user = null; render();
  };
  app.querySelectorAll(".tabbar button").forEach((b) => (b.onclick = () => { state.view = b.dataset.view; render(); window.scrollTo(0, 0); }));
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
      <div class="login-icon"><img src="/icon.svg" alt=""></div>
      <div class="brand">Склад</div>
      <div class="muted" style="text-align:center;margin:-8px 0 8px">Учёт товаров и продаж</div>
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
      <button class="btn icon" id="cam" title="Сканировать камерой"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 9v6M10 9v6M13 9v6M16.5 9v6"/></svg></button>
    </div>
    <div id="suggest"></div>
    <div class="scan-hint">Сканируйте штрих-код сканером или камерой, либо начните вводить название.</div>`;
}

function bindScan(onProduct, onUnknown) {
  const input = $("#scan");
  const box = $("#suggest");
  const pick = (p) => { input.value = ""; box.innerHTML = ""; onProduct(p); input.focus(); };

  async function lookup(code) {
    code = normCode(code);
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
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code", "data_matrix"];

// Код маркировки «Честный знак» (DataMatrix на воде, молочке и т.п.) содержит внутри обычный штрих-код:
// 01 + 14 цифр GTIN + 21 + серийный номер… Достаём из него EAN-13, чтобы товар находился как по обычному штрих-коду.
function normCode(raw) {
  let c = String(raw ?? "").trim().replace(/^\]d2|^\]Q3|^\]C1/, "").replace(/[\u001d\u00e8]/g, "");
  const m = c.match(/^\(?01\)?(\d{14})/);
  if (m && c.length > 16) c = m[1].startsWith("0") ? m[1].slice(1) : m[1];
  return c;
}

async function openCamera(onCode) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="grabber"></div><h2><span>Наведите на штрих-код</span><button class="x close" id="cam-close" aria-label="Закрыть">✕</button></h2>
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
  back.innerHTML = `<div class="modal"><div class="grabber"></div><h2><span>${esc(title)}</span><button class="x close" data-close aria-label="Закрыть">✕</button></h2>${html}</div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); refreshView(); };
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  onMount?.(back, close);
  back.querySelector("input:not([type=hidden])")?.focus();
  return close;
}

// ---------- Фото товара ----------
const PHOTO_PH = `<span class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a2 2 0 0 1 2-2h2l1.5-2h7L17 7h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg></span>`;
const imgSrc = (p) => (p && p.image ? "/images/" + p.image : "");
const thumb = (p, size = 40) => p && p.image
  ? `<img class="thumb" style="width:${size}px;height:${size}px" src="${esc(imgSrc(p))}" alt="" loading="lazy">`
  : `<span class="thumb none" style="width:${size}px;height:${size}px">${esc(catIcon(p?.category))}</span>`;

const CAT_ICONS = {
  "Напитки": "🥤", "Масла и антифризы": "🛢", "Автотовары": "🚗", "Табак": "🚬", "Корм для животных": "🐾",
  "Детские товары": "🍼", "Косметика и гигиена": "🧴", "Бытовая химия": "🧽", "Хозтовары": "🧰", "Молочные продукты": "🥛",
  "Мясо, рыба, колбасы": "🥩", "Консервы": "🥫", "Хлеб и выпечка": "🍞", "Сладости": "🍫", "Снеки": "🥜", "Бакалея": "🌾",
  "Овощи и фрукты": "🍎", "Яйца": "🥚", "Замороженные продукты": "🧊", "Канцтовары": "✏️", "Электроника и связь": "🔌",
};
const catIcon = (c) => CAT_ICONS[c] || "📦";
const catName = (c) => c || "Прочее";

// Фото с телефона уменьшаем до 900 px — быстро грузится и не занимает место
function pickPhoto() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try { resolve(await resizeImage(file, 900)); }
      catch { toast("Не удалось прочитать фото", "err"); resolve(null); }
    };
    input.click();
  });
}

async function resizeImage(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  } finally { URL.revokeObjectURL(url); }
}

// ---------- Карточка товара (окно с фото) ----------
function productCard(p) {
  const isAdmin = state.user.role === "admin";
  modal(p.name, `
    <div class="pcard">
      <div class="pcard-img">${p.image ? `<img src="${esc(imgSrc(p))}" alt="">` : `<span>${esc(catIcon(p.category))}</span><div class="muted">Фото нет</div>`}</div>
      <div class="pcard-info">
        <span class="badge">${esc(catIcon(p.category))} ${esc(catName(p.category))}</span>
        <div class="pcard-price">${money(p.sell_price)}</div>
        <table><tbody>
          <tr><td class="muted">На складе</td><td class="num ${p.qty <= 2 ? "low" : ""}"><b>${qtyFmt(p.qty)}</b></td></tr>
          ${isAdmin ? `<tr><td class="muted">Закупочная цена</td><td class="num">${money(p.buy_price)}</td></tr>
          <tr><td class="muted">Наценка</td><td class="num">${p.buy_price > 0 ? Math.round(((p.sell_price - p.buy_price) / p.buy_price) * 100) + "%" : "—"}</td></tr>` : ""}
          <tr><td class="muted">Штрих-код</td><td class="num">${esc(p.barcode || "—")}</td></tr>
        </tbody></table>
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn light" id="pc-photo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a2 2 0 0 1 2-2h2l1.5-2h7L17 7h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg> ${p.image ? "Заменить фото" : "Добавить фото"}</button>
      <button class="btn light" id="pc-cart">🛒 В корзину</button>
      ${isAdmin ? `<button class="btn" id="pc-edit">✏️ Изменить</button>` : ""}
    </div>`, (root, close) => {
    $("#pc-photo", root).onclick = async () => {
      const data = await pickPhoto();
      if (!data) return;
      try {
        await api("POST", `/api/products/${p.id}/image`, { image_data: data });
        toast("Фото сохранено", "ok");
        await loadProducts();
        root.remove();
        productCard(state.products.find((x) => x.id === p.id) || p);
      } catch (e) { toast(e.message, "err"); }
    };
    $("#pc-cart", root).onclick = () => { close(); state.view = "sale"; render(); addToCart(p); };
    const edit = $("#pc-edit", root);
    if (edit) edit.onclick = () => { root.remove(); productForm(p); };
  });
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
            <div class="with-thumb" data-card="${l.product.id}">${thumb(l.product, 44)}
              <div><div class="name">${esc(l.product.name)}</div>
              <div class="muted">${money(l.product.sell_price)} · на складе ${qtyFmt(l.product.qty)}</div></div></div>
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
    if (confirm(`Товара со штрих-кодом ${code} нет в базе. Добавить его?`)) productForm(null, code);
  });

  main.querySelectorAll("[data-card]").forEach((el) => (el.onclick = () => {
    const p = state.products.find((x) => x.id === Number(el.dataset.card));
    if (p) productCard(p);
  }));
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
      <div class="with-thumb" id="recv-card">${thumb(p, 64)}
        <div><h2 style="margin:0">${esc(p.name)}</h2>
        <div class="muted">${esc(catIcon(p.category))} ${esc(catName(p.category))}</div></div></div>
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
    </form>` : `<div class="card empty">Отсканируйте поступивший товар. Если его ещё нет в базе, появится форма добавления — название подтянется само.</div>`}
    <button class="btn light" id="new-prod">+ Новый товар вручную</button>`;

  bindScan((prod) => { state.received = prod; refreshView(); setTimeout(() => $("#recv [name=qty]")?.select(), 0); },
    (code) => productForm(null, code));
  $("#new-prod").onclick = () => productForm(null, "");
  if (!p) return;
  $("#recv-card").onclick = () => productCard(p);
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
let productCat = "";
function renderProducts(main) {
  const isAdmin = state.user.role === "admin";
  const q = productQuery.toLowerCase();
  const found = state.products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.barcode || "").includes(productQuery));
  const counts = {};
  for (const p of found) counts[catName(p.category)] = (counts[catName(p.category)] || 0) + 1;
  const list = productCat ? found.filter((p) => catName(p.category) === productCat) : found;
  // Группируем по категориям
  const groups = {};
  for (const p of list) (groups[catName(p.category)] ||= []).push(p);
  const order = Object.keys(groups).sort((a, b) => (a === "Прочее") - (b === "Прочее") || a.localeCompare(b, "ru"));
  const totalQty = list.reduce((s, p) => s + Math.max(0, p.qty), 0);

  main.innerHTML = `
    <div class="toolbar">
      <input type="search" id="pq" placeholder="Поиск по названию или штрих-коду" value="${esc(productQuery)}">
      <button class="btn" id="add">+ Товар</button>
      ${isAdmin ? `<a class="btn ghost" href="/api/export.csv" download title="Выгрузить остатки в Excel">Excel</a>` : ""}
    </div>
    <div class="periods cats">
      <button data-cat="" class="${productCat ? "" : "on"}">Все · ${found.length}</button>
      ${Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map((c) =>
        `<button data-cat="${esc(c)}" class="${productCat === c ? "on" : ""}">${esc(catIcon(c === "Прочее" ? "" : c))} ${esc(c)} · ${counts[c]}</button>`).join("")}
    </div>
    ${list.length ? order.map((c) => `
      <h3>${esc(catIcon(c === "Прочее" ? "" : c))} ${esc(c)}</h3>
      <div class="card" style="padding:0 6px">
        <table><tbody>${groups[c].map((p) => `
          <tr class="click" data-id="${p.id}">
            <td style="width:52px">${thumb(p, 40)}</td>
            <td>${esc(p.name)}<div class="muted hide-d">${esc(p.barcode || "")}</div></td>
            <td class="hide-m muted">${esc(p.barcode || "—")}</td>
            <td class="num ${p.qty <= 2 ? "low" : ""}">${qtyFmt(p.qty)}</td>
            ${isAdmin ? `<td class="num hide-m muted">${money(p.buy_price)}</td>` : ""}
            <td class="num">${money(p.sell_price)}</td>
          </tr>`).join("")}</tbody></table>
      </div>`).join("") : `<div class="card empty">${productQuery ? "Ничего не найдено" : "Товаров пока нет"}</div>`}
    <div class="muted">Позиций: ${list.length} · единиц на складе: ${qtyFmt(totalQty)}</div>`;

  const qi = $("#pq");
  qi.oninput = () => {
    productQuery = qi.value.trim();
    const pos = qi.selectionStart;
    refreshView();
    const nq = $("#pq"); nq.focus(); nq.setSelectionRange(pos, pos);
  };
  main.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { productCat = b.dataset.cat; refreshView(); }));
  $("#add").onclick = () => productForm(null, "");
  main.querySelectorAll("tr.click").forEach((tr) => (tr.onclick = () => productCard(state.products.find((p) => p.id === Number(tr.dataset.id)))));
}

// ---------- Форма товара ----------
function productForm(p, barcode = "") {
  const isNew = !p;
  const isAdmin = state.user.role === "admin";
  if (!isNew && !isAdmin) return productCard(p);
  let photo = { data: null, url: null, removed: false };

  modal(isNew ? "Новый товар" : "Изменить товар", `
    <form class="form" id="pf">
      <div class="pf-photo">
        <div class="pf-img" id="pf-img">${p?.image ? `<img src="${esc(imgSrc(p))}" alt="">` : PHOTO_PH}</div>
        <div class="pf-photo-btns">
          <button type="button" class="btn light" id="pf-shot">${p?.image ? "Заменить фото" : "Сфотографировать"}</button>
          <button type="button" class="btn ghost" id="pf-noimg" ${p?.image ? "" : "hidden"}>Убрать фото</button>
          <div class="muted">Фото подтянется само, если товар найдётся по штрих-коду</div>
        </div>
      </div>
      <label>Штрих-код
        <div class="scan"><input name="barcode" type="text" value="${esc(p?.barcode ?? barcode)}" placeholder="Можно оставить пустым">
        <button type="button" class="btn icon light" id="pf-cam" title="Сканировать камерой"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 9v6M10 9v6M13 9v6M16.5 9v6"/></svg></button>
        <button type="button" class="btn icon light" id="pf-find" title="Найти по штрих-коду"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></button></div>
      </label>
      <div id="pf-found" class="found" hidden></div>
      <label>Название<input name="name" type="text" value="${esc(p?.name || "")}" required autocomplete="off"></label>
      <label>Категория <span id="pf-auto" class="muted"></span>
        <input name="category" type="text" list="pf-cats" value="${esc(p?.category || "")}" placeholder="Определится по названию" autocomplete="off">
        <datalist id="pf-cats">${state.categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      </label>
      <div class="row">
        <label>${isNew ? "Количество" : "Остаток"}<input name="qty" type="text" inputmode="decimal" value="${p ? p.qty : 1}"></label>
        <label>Закупочная цена<input name="buy_price" type="text" inputmode="decimal" value="${p?.buy_price ?? ""}" placeholder="0"></label>
        <label>Розничная цена<input name="sell_price" type="text" inputmode="decimal" value="${p?.sell_price ?? ""}" placeholder="0"></label>
      </div>
      ${!isNew ? `<div class="muted">Остаток лучше менять через «Приход». Ручная правка записывается как корректировка.</div>` : ""}
      ${isNew && !isAdmin ? `<div class="muted">Закупочную цену после сохранения видит только владелец.</div>` : ""}
      <div id="margin" class="muted"></div>
      <div class="row">
        <button class="btn big" id="pf-save">${isNew ? "Добавить" : "Сохранить"}</button>
        ${!isNew ? `<button type="button" class="btn danger" id="pf-del">Удалить</button>` : ""}
      </div>
    </form>`, (root, close) => {
    const f = $("#pf", root);
    const imgBox = $("#pf-img", root);
    const setPreview = (src) => {
      imgBox.innerHTML = src ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : PHOTO_PH;
      const im = imgBox.querySelector("img");
      if (im) im.onerror = () => { imgBox.innerHTML = PHOTO_PH; if (photo.url === src) photo.url = null; };
      $("#pf-noimg", root).hidden = !src;
      $("#pf-shot", root).textContent = src ? "Заменить фото" : "Сфотографировать";
    };
    $("#pf-shot", root).onclick = async () => {
      const data = await pickPhoto();
      if (data) { photo = { data, url: null, removed: false }; setPreview(data); }
    };
    $("#pf-noimg", root).onclick = () => { photo = { data: null, url: null, removed: true }; setPreview(""); };

    // Категория: подсказываем по названию, пока человек не выбрал её сам
    let catTouched = !!p?.category;
    const autoLabel = $("#pf-auto", root);
    const autoCat = (hint) => {
      if (catTouched) return;
      const c = Categories.guessCategory(f.name.value, hint);
      f.category.value = c;
      autoLabel.textContent = c ? "· определена автоматически" : "";
    };
    f.category.oninput = () => { catTouched = !!f.category.value.trim(); autoLabel.textContent = ""; };
    f.name.addEventListener("input", () => autoCat());

    const showMargin = () => {
      const b = toNum(f.buy_price.value), s = toNum(f.sell_price.value);
      $("#margin", root).textContent = b > 0 && s > 0 ? `Наценка: ${money(s - b)} (${Math.round(((s - b) / b) * 100)}%)` : "";
    };
    f.buy_price.oninput = f.sell_price.oninput = showMargin;
    showMargin();

    // Поиск названия, фото и категории в базах штрих-кодов
    const info = $("#pf-found", root);
    const findName = async (auto) => {
      const code = normCode(f.barcode.value);
      if (!/^\d{8,14}$/.test(code)) { if (!auto) toast("Сначала укажите штрих-код (8–14 цифр)", "err"); return; }
      info.hidden = false;
      info.innerHTML = `<span class="spin"></span> Ищу товар по штрих-коду…`;
      try {
        const r = await api("GET", "/api/lookup/" + code);
        if (!f.isConnected) return;
        const typed = f.name.value.trim();
        if (!typed || !auto) f.name.value = r.full_name;
        if (r.image && !photo.data && (isNew || !p?.image)) { photo = { data: null, url: r.image, removed: false }; setPreview(r.image); }
        if (!catTouched && r.category) { f.category.value = r.category; autoLabel.textContent = "· определена автоматически"; }
        else autoCat(r.category);
        info.innerHTML = `
          <div><b>Найдено:</b> ${esc(r.full_name)}<div class="muted">Источник: ${esc(r.source)}. Проверьте и при необходимости исправьте.</div>
          ${typed && auto ? `<button type="button" class="btn light" id="pf-use">Взять это название</button>` : ""}</div>`;
        const use = $("#pf-use", root);
        if (use) use.onclick = () => { f.name.value = r.full_name; autoCat(r.category); use.remove(); };
        if (auto) setTimeout(() => { const el = f.name.value === r.full_name ? f.qty : f.name; el.focus(); el.select(); }, 0);
      } catch (e) {
        if (!f.isConnected) return;
        info.innerHTML = `<div class="muted">${esc(e.message)}. Введите название вручную${isNew ? " и при желании сфотографируйте товар" : ""}.</div>`;
        if (auto) setTimeout(() => f.name.focus(), 0);
      }
    };
    $("#pf-find", root).onclick = () => findName(false);
    $("#pf-cam", root).onclick = () => openCamera((code) => { f.barcode.value = normCode(code); beep(); if (isNew) findName(true); });
    if (isNew && barcode) findName(true);
    else if (isNew) setTimeout(() => f.name.focus(), 0);
    if (!catTouched) autoCat();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#pf-save", root);
      btn.disabled = true;
      const body = {
        name: f.name.value, barcode: normCode(f.barcode.value), qty: f.qty.value || 0,
        category: f.category.value.trim(),
        buy_price: f.buy_price.value || 0, sell_price: f.sell_price.value || 0,
      };
      if (photo.data) body.image_data = photo.data;
      else if (photo.url) body.image_url = photo.url;
      try {
        const saved = isNew ? await api("POST", "/api/products", body) : await api("PUT", `/api/products/${p.id}`, body);
        if (photo.removed && !isNew) await api("DELETE", `/api/products/${p.id}/image`);
        toast(isNew ? `Добавлено в «${catName(saved.category)}»` : "Сохранено", "ok");
        await Promise.all([loadProducts(), loadCategories()]);
        close();
      } catch (err) { toast(err.message, "err"); btn.disabled = false; }
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

      ${r.cats.length ? `<div class="card"><h2>Продажи по категориям</h2>
        <table><thead><tr><th>Категория</th><th class="num">Выручка</th><th class="num">Прибыль</th></tr></thead>
        <tbody>${r.cats.map((c) => `<tr><td>${esc(catIcon(c.name === "Прочее" ? "" : c.name))} ${esc(c.name)}</td>
          <td class="num">${money(c.revenue)}</td><td class="num">${money(c.profit)}</td></tr>`).join("")}</tbody></table></div>` : ""}

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
    await Promise.all([loadProducts(), loadCategories()]);
  } catch { state.user = null; }
  render();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
start();
