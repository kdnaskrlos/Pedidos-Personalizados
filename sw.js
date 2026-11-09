// Permite instalar la app y abrirla rápido aunque la conexión sea lenta.
// Los pedidos NO se guardan aquí: los maneja Firebase (con su propia caché sin conexión).
const CACHE = "pedidos-v100";
const LIBS = "libs-v1"; // Firebase y la fuente: archivos con versión fija, se guardan una vez
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icono-192.png", "./icono-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== LIBS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET") return;
  // Librerías de Firebase y fuentes: primero la copia guardada (nunca cambian)
  if (u.hostname === "www.gstatic.com" && u.pathname.startsWith("/firebasejs/") || u.hostname === "fonts.gstatic.com" || u.hostname === "fonts.googleapis.com") {
    e.respondWith(caches.open(LIBS).then(c => c.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok || res.type === "opaque") c.put(r, res.clone()); return res; }))));
    return;
  }
  if (u.origin !== location.origin) return;
  // La app: se intenta la versión nueva, pero si la red tarda más de 2,5 s se abre la guardada
  e.respondWith(new Promise(resolve => {
    let listo = false;
    const usarCache = () => caches.match(r).then(c => c || caches.match("./index.html")).then(c => { if (c && !listo) { listo = true; resolve(c); } });
    const t = setTimeout(usarCache, 2500);
    fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      clearTimeout(t); if (!listo) { listo = true; resolve(res); }
    }).catch(() => { clearTimeout(t); caches.match(r).then(c => c || caches.match("./index.html")).then(c => { if (!listo) { listo = true; resolve(c || Response.error()); } }); });
  }));
});
