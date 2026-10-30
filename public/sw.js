// Минимальный service worker: нужен, чтобы приложение можно было установить на телефон.
// Данные всегда берутся с сервера (без офлайн-кэша), чтобы остатки были актуальными.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
