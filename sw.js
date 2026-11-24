// Permite instalar la app y abrirla al instante, con o sin internet.
// La cola de pedidos usa IndexedDB y las lecturas guardadas usan la caché de Firebase.
const CACHE = "pedidos-v179";
const LIBS = "libs-v1"; // Firebase y la fuente: archivos con versión fija, se guardan una vez
const SHELL = ["./", "./index.html", "./config.js", "./pagos.mjs", "./calendario.mjs", "./notas.mjs", "./pedido-export.mjs", "./heic.mjs", "./heic-worker.mjs", "./vendor/libheif-bundle.mjs", "./whatsapp.mjs", "./pedidos-sync.mjs", "./cola-local.mjs", "./manifest.webmanifest", "./icono-192.png", "./icono-512.png", "./icono-maskable-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache:"reload"})))).then(() => self.skipWaiting())); });
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
  // La app: se abre siempre la copia guardada (instantáneo, sin esperar la red) y se refresca por detrás.
  // Las versiones nuevas llegan con la actualización silenciosa (sw.js nuevo).
  const nav = r.mode === "navigate";
  // La demo es un HTML independiente y se abre desde su archivo de GitHub.
  if (nav && ![new URL("./", location.href).pathname, new URL("./index.html", location.href).pathname].includes(u.pathname)) return;
  e.respondWith(caches.open(CACHE).then(c => c.match(nav ? "./index.html" : r, {ignoreSearch:nav}).then(hit => {
    const red = fetch(r).then(res => { if (res.ok && !nav) c.put(r, res.clone()); return res; });
    if (hit) { e.waitUntil(red.catch(() => {})); return hit; }
    return red.catch(() => caches.match("./index.html"));
  })));
});
