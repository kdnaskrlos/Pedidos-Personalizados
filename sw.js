// Permite instalar la app y abrirla al instante, con o sin internet.
// La cola de pedidos usa IndexedDB y las lecturas guardadas usan la caché de Firebase.
const CACHE = "pedidos-v182";
const LIBS = "libs-v1"; // Firebase y la fuente: archivos con versión fija, se guardan una vez
const SHELL = ["./", "./index.html", "./config.js", "./pagos.mjs", "./calendario.mjs", "./notas.mjs", "./notificaciones.mjs", "./notificaciones-ui.mjs", "./push-config.mjs", "./pedido-export.mjs", "./heic.mjs", "./heic-worker.mjs", "./vendor/libheif-bundle.mjs", "./whatsapp.mjs", "./pedidos-sync.mjs", "./cola-local.mjs", "./manifest.webmanifest", "./icono-192.png", "./icono-512.png", "./icono-maskable-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache:"reload"})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== LIBS && k !== PUSH_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
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

// Un único manejador de mensajes FCM de datos usa la misma notificación del
// sistema con la app abierta o cerrada. No se inicializa otro worker de FCM.
const PUSH_CACHE = "pedidos-push-v1";
const vinculoPush = new URL("./.pedidos-push/dispositivo",self.location).href;
const mostrando = new Set();
const idPushValido = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
self.addEventListener("push",e => {
  e.waitUntil((async () => {
    let datos;
    try { datos = e.data?.json()?.data; } catch { return; }
    if (datos?.app !== "pedidos" || !idPushValido(datos.uid) || !idPushValido(datos.dispositivo) ||
      typeof datos.evento !== "string" || datos.evento.length > 160 ||
      typeof datos.titulo !== "string" || typeof datos.cuerpo !== "string") return;
    const registro = await (await caches.open(PUSH_CACHE)).match(vinculoPush);
    const vinculo = await registro?.json();
    if (datos.uid !== vinculo?.uid || datos.dispositivo !== vinculo?.id) return;
    const tag = "pedidos:" + datos.evento;
    if (mostrando.has(tag)) return;
    mostrando.add(tag);
    try {
      if ((await self.registration.getNotifications({tag})).length) return;
      await self.registration.showNotification(datos.titulo.slice(0,100),{
        body:datos.cuerpo.slice(0,140),tag,icon:new URL("./icono-192.png",self.location).href,
        data:{app:"pedidos",uid:datos.uid,pedidoId:idPushValido(datos.pedidoId) ? datos.pedidoId : ""}
      });
    } finally { mostrando.delete(tag); }
  })());
});
self.addEventListener("notificationclick",e => {
  const aviso = e.notification.data;
  if (aviso?.app !== "pedidos") return;
  e.notification.close();
  e.waitUntil((async () => {
    const url = new URL("./",self.location);
    if (idPushValido(aviso.pedidoId) && idPushValido(aviso.uid)) {
      url.searchParams.set("aviso",aviso.pedidoId);
      url.searchParams.set("destino",aviso.uid);
    }
    const clientes = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const cliente = clientes.find(c => {
      const pagina = new URL(c.url);
      return pagina.origin === url.origin && [url.pathname,url.pathname + "index.html"].includes(pagina.pathname);
    });
    if (cliente) {
      if (url.search) cliente.postMessage({tipo:"pedidos-aviso",id:aviso.pedidoId,uid:aviso.uid});
      await cliente.focus();
    } else await self.clients.openWindow(url.href);
  })());
});
self.addEventListener("pushsubscriptionchange",e => {
  e.waitUntil((async () => {
    for (const cliente of await self.clients.matchAll({type:"window"}))
      cliente.postMessage({tipo:"pedidos-renovar-avisos"});
  })());
});
