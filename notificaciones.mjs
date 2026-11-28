import "./notificaciones-almacen.js";
import {claveVapid,regionAvisos} from "./push-config.mjs";

const SDK_MESSAGING = "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
const SDK_FUNCTIONS = "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
const CACHE = "pedidos-push-v1";
const URL_VINCULO = new URL("./.pedidos-push/dispositivo",import.meta.url);
const CLAVE_LOCAL = "cs-dispositivo-avisos";
const intervalo = 15 * 60000;
const reintento = 60000;
const vacias = admin => ({ediciones:admin,nuevos:false,estado:false});

function compatible() {
  return globalThis.isSecureContext && "Notification" in window && "PushManager" in window &&
    "serviceWorker" in navigator && "caches" in window;
}

async function cacheAvisos() {
  return compatible() ? caches.open(CACHE) : null;
}
async function leerVinculo() {
  return (await (await cacheAvisos())?.match(URL_VINCULO))?.json();
}
async function quitarVinculo() {
  await (await cacheAvisos())?.delete(URL_VINCULO);
}
async function cerrarAvisos() {
  const reg = await navigator.serviceWorker.getRegistration();
  for (const aviso of await reg?.getNotifications() || []) if (aviso.tag.startsWith("pedidos:")) aviso.close();
}

function idDispositivo() {
  let id;
  try { id = localStorage.getItem(CLAVE_LOCAL); } catch {}
  if (!id) {
    id = crypto.randomUUID();
    try { localStorage.setItem(CLAVE_LOCAL,id); } catch {}
  }
  return id;
}

// La intención persiste incluso cuando no se puede confirmar el registro remoto.
export function crearNotificaciones({sesion,app,datos,actualizar,cargarMessaging = () => import(SDK_MESSAGING)}) {
  const almacen = globalThis.almacenAvisos;
  let canal;
  try { canal = new BroadcastChannel("pedidos-avisos"); } catch {}
  let uid, intencion, confirmada, adminActual = false, abierto = false, cargandoPreferencias = false;
  let ocupado = false, renovando = false, listo = false, cerrando = false;
  let preferencias = vacias(false), mensaje = "", error = false, revision = 0;
  let proximoIntento = 0, demora = reintento, forzarRenovacion = false;
  const comprobar = (id,gen) => {
    if (cerrando || !id || uid !== id || sesion()?.uid !== id || revision !== gen) throw new Error("La sesión cambió.");
  };
  const adoptar = valor => {
    if (valor?.generacion !== intencion?.generacion || !valor?.entrega) confirmada = null;
    intencion = valor?.uid === uid ? valor : null;
    actualizar();
  };
  if (canal) canal.onmessage = async () => {
    const gen = revision;
    const actual = await almacen.leer().catch(() => null);
    if (gen === revision) adoptar(actual);
  };
  const estado = () => {
    const habilitado = compatible() && !!intencion?.habilitado && Notification.permission === "granted";
    return {
      estado:!compatible() ? "incompatible" : Notification.permission === "denied" ? "bloqueado" :
        !claveVapid ? "configuracion" : !listo ? "cargando" : !habilitado ? "apagado" :
        confirmada === intencion.generacion ? "activo" : "pendiente",
      habilitado,preferencias,ocupado,permitePreferencias:abierto && !cargandoPreferencias && listo,mensaje,error
    };
  };

  async function prepararFCM() {
    const sdk = await cargarMessaging();
    if (!await sdk.isSupported()) throw new Error("El navegador no admite notificaciones web.");
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) throw new Error("Recarga Pedidos para terminar de instalar la aplicación.");
    return {sdk,reg,messaging:sdk.getMessaging(app())};
  }

  // Web Locks cubre Chromium y Safari con Web Push. La concesión en IndexedDB
  // coordina clientes sin Web Locks y permite recuperarse si se cierra el proceso.
  async function exclusivo(fn) {
    if (navigator.locks) return navigator.locks.request("pedidos-push-registro",{ifAvailable:true},async lock => {
      if (lock) return fn(async () => {});
    });
    const clave = crypto.randomUUID();
    const toma = await almacen.arrendar(actual => actual?.vence > Date.now() ? actual : {clave,vence:Date.now() + 120000});
    if (toma.clave !== clave) return;
    const conservar = async () => {
      const vigente = await almacen.arrendar(actual =>
        actual?.clave === clave && actual.vence > Date.now() ? {clave,vence:Date.now() + 120000} : actual);
      if (vigente?.clave !== clave || vigente.vence <= Date.now()) throw new Error("La operación de avisos caducó.");
    };
    try { return await fn(conservar); }
    finally { await almacen.arrendar(actual => actual?.clave === clave ? null : actual); }
  }

  async function registrar(preferido,gen,conservar) {
    const {uid:id,id:dispositivo,generacion} = preferido;
    const vigente = async () => {
      await conservar();
      const actual = await almacen.leer();
      comprobar(id,gen);
      if (!actual?.habilitado || actual.generacion !== generacion || Notification.permission !== "granted")
        throw new Error("La autorización de avisos cambió.");
      return actual;
    };
    const registro = await vigente();
    const {sdk,reg,messaging} = await prepararFCM();
    const opciones = {vapidKey:claveVapid,serviceWorkerRegistration:reg};
    const guardar = async comprobarRegistro => {
      await vigente();
      const token = await sdk.getToken(messaging,opciones);
      await vigente();
      if (!token) throw new Error("Firebase no devolvió un token para el dispositivo.");
      return datos.guardarDispositivo(id,dispositivo,token,vigente,comprobarRegistro);
    };
    if (!await guardar(!!registro.registrado)) {
      await vigente();
      await almacen.cambiar(actual => actual?.generacion === generacion ? {...actual,entrega:false} : actual);
      canal?.postMessage("cambio");
      await vigente();
      await sdk.deleteToken(messaging);
      await vigente();
      await guardar(false);
    }
    await vigente();
    const nuevo = await almacen.cambiar(actual => actual?.generacion === generacion ?
      {...actual,entrega:true,registrado:true,comprobado:Date.now()} : actual);
    comprobar(id,gen);
    if (nuevo?.generacion !== generacion) return;
    adoptar(nuevo);
    confirmada = generacion;
    canal?.postMessage("cambio");
  }

  async function retirar(id,{conservar = false} = {}) {
    const legado = !await almacen.leer() && await leerVinculo().catch(() => null);
    const generacion = crypto.randomUUID();
    const actual = await almacen.cambiar(anterior => {
      if (anterior && anterior.uid !== id) return anterior;
      const dispositivo = anterior?.id || (legado?.uid === id && legado.id) || idDispositivo();
      return {uid:id,id:dispositivo,generacion,habilitado:conservar && !!(anterior?.habilitado || !anterior && legado?.uid === id),
        entrega:false,registrado:!!(anterior?.registrado || !anterior && legado?.uid === id),
        limpieza:!!(anterior?.limpieza || !conservar && (anterior?.habilitado || !anterior && legado?.uid === id))};
    });
    if (actual?.generacion !== generacion) return null;
    if (uid === id) adoptar(actual);
    canal?.postMessage("cambio");
    await Promise.allSettled([quitarVinculo(),cerrarAvisos()]);
    return actual;
  }

  async function limpiar(baja,conservar) {
    const vigente = async () => {
      await conservar();
      const actual = await almacen.leer();
      return actual?.generacion === baja.generacion && !actual.habilitado && sesion()?.uid === baja.uid;
    };
    if (!await vigente()) return;
    await datos.borrarDispositivo(baja.uid,baja.id);
    const {sdk,messaging} = await prepararFCM();
    if (!await vigente()) return;
    await sdk.deleteToken(messaging);
    await almacen.cambiar(actual => actual?.generacion === baja.generacion ? {...actual,limpieza:false} : actual);
  }

  async function cambiarSesion(id,admin) {
    if (id === uid && !cerrando) {
      if (admin !== adminActual && !abierto) { preferencias = vacias(admin); actualizar(); }
      adminActual = admin;
      return;
    }
    uid = id;
    adminActual = admin;
    const gen = ++revision;
    intencion = confirmada = null;
    abierto = listo = ocupado = renovando = error = cerrando = cargandoPreferencias = false;
    preferencias = vacias(admin);
    proximoIntento = 0;
    demora = reintento;
    forzarRenovacion = false;
    mensaje = "";
    if (compatible() && !id) {
      try {
        const anterior = await almacen.leer() || await leerVinculo();
        if (gen === revision && anterior?.uid && anterior.habilitado !== false) await retirar(anterior.uid);
      } catch {}
    }
    if (compatible() && id) {
      try {
        const legado = await leerVinculo().catch(() => null);
        if (gen !== revision) return;
        const actual = await almacen.cambiar(anterior => {
          if (gen !== revision) return anterior;
          if (!anterior && legado?.uid === id)
            return {uid:id,id:legado.id,generacion:crypto.randomUUID(),habilitado:true,entrega:true,registrado:true};
          if (anterior?.uid === id || !anterior && !legado) return anterior;
          return {uid:id,id:idDispositivo(),generacion:crypto.randomUUID(),habilitado:false,entrega:false};
        });
        if (gen !== revision) return;
        adoptar(actual);
        if (actual) await quitarVinculo().catch(() => {});
      } catch { /* La app puede abrir aunque el almacenamiento de avisos no esté disponible. */ }
    }
    if (gen === revision) { listo = true; actualizar(); await renovar(); }
  }

  async function abrirPanel() {
    const usuario = sesion();
    if (!usuario || abierto) return;
    abierto = cargandoPreferencias = true;
    const gen = revision;
    try {
      const cfg = await datos.leerPreferencias(usuario.uid);
      if (gen === revision && cfg) preferencias = cfg;

    } catch {
      if (gen === revision) { mensaje = "No se pudieron consultar las preferencias. Comprueba tu conexión."; error = true; }
    }
    if (gen === revision) { cargandoPreferencias = false; actualizar(); void renovar(); }
  }

  async function operar(fn, exito) {
    if (ocupado || !sesion()?.uid || cerrando) return;
    const id = sesion().uid, gen = revision;
    ocupado = true; mensaje = ""; error = false;
    try {
      await fn(id,gen);
      comprobar(id,gen);
      mensaje = exito;
    } catch (e) {
      if (gen !== revision) return;
      error = true;
      mensaje = e.code === "functions/resource-exhausted" ? "Espera un minuto entre pruebas." :
        e.code === "functions/failed-precondition" ? "Vuelve a activar este dispositivo antes de probar." :
        e.code ? "No se pudo completar. Comprueba tu conexión y la configuración de avisos." : e.message;
    } finally {
      if (gen === revision) { ocupado = false; actualizar(); }
    }
  }

  async function dispositivo(encender) {
    if (!encender) {
      const id = sesion()?.uid;
      if (!id || cerrando) return;
      const gen = ++revision;
      confirmada = null;
      renovando = ocupado = false;
      try {
        const baja = await retirar(id);
        if (baja?.limpieza) await exclusivo(conservar => limpiar(baja,conservar));
        if (gen === revision) mensaje = "Avisos desactivados en este dispositivo.";
      } catch {
        if (gen === revision) { mensaje = "No se pudo completar la baja del registro remoto."; error = true; }
      } finally { if (gen === revision) actualizar(); }
      return;
    }
    return operar(async (id,gen) => {
      // Mantiene la llamada al permiso dentro del gesto del usuario.
      const esperada = intencion?.generacion;
      const permiso = await Notification.requestPermission();
      comprobar(id,gen);
      if (permiso !== "granted") throw new Error("No se concedió permiso para mostrar notificaciones.");
      const generacion = crypto.randomUUID();
      const actual = await almacen.cambiar(anterior => {
        comprobar(id,gen);
        if (anterior?.generacion !== esperada || anterior?.habilitado) return anterior;
        return {uid:id,id:anterior?.uid === id ? anterior.id : idDispositivo(),generacion,habilitado:true,entrega:false};
      });
      comprobar(id,gen);
      adoptar(actual);
      if (actual?.uid !== id || !actual.habilitado) return;
      canal?.postMessage("cambio");
      proximoIntento = 0;
    },"").then(() => renovar(true));
  }

  const preferencia = (key,val) => operar(async (id,gen) => {
    if (!Object.hasOwn(preferencias,key)) return;
    const nuevas = await datos.guardarPreferencia(id,key,val,preferencias);
    comprobar(id,gen);
    preferencias = nuevas;
  },"Preferencia guardada.");

  const prueba = () => operar(async (id,gen) => {
    const vinculo = await almacen.leer();
    comprobar(id,gen);
    if (vinculo?.uid !== id || !vinculo.entrega || confirmada !== vinculo.generacion) throw new Error("Activa este dispositivo primero.");
    const {getFunctions,httpsCallable} = await import(SDK_FUNCTIONS);
    comprobar(id,gen);
    await httpsCallable(getFunctions(app(),regionAvisos),"probarNotificacion")({dispositivo:vinculo.id});
  },"Prueba solicitada. Revisa las notificaciones de este dispositivo.");

  async function renovar(forzar = false) {
    if (!claveVapid || !listo || cerrando || !compatible()) return;
    const id = sesion()?.uid, gen = revision;
    if (!id || id !== uid) return;
    if (intencion?.habilitado && Notification.permission !== "granted") return dispositivo(false);
    if (forzar && intencion?.habilitado) {
      forzarRenovacion = true;
      confirmada = null;
      actualizar();
    }
    if (ocupado || renovando) return;
    renovando = true;
    try {
      const actual = await almacen.leer();
      comprobar(id,gen);
      adoptar(actual);
      if (actual?.uid !== id) return;
      if (actual.habilitado && Notification.permission !== "granted") {
        await dispositivo(false);
        return;
      }
      const ahora = Date.now();
      if (!navigator.onLine || ahora < proximoIntento) return;
      if (!actual.habilitado && !actual.limpieza) return;
      if (!forzarRenovacion && confirmada && actual.comprobado + intervalo > ahora) return;
      confirmada = null;
      actualizar();
      let ejecutado = false;
      await exclusivo(async conservar => {
        ejecutado = true;
        forzarRenovacion = false;
        if (actual.habilitado) await registrar(actual,gen,conservar);
        else await limpiar(actual,conservar);
      });
      if (gen === revision) {
        demora = reintento;
        proximoIntento = ahora + (ejecutado ? reintento : 5000);
      }
    } catch {
      if (gen === revision) {
        confirmada = null;
        proximoIntento = Date.now() + demora;
        demora = Math.min(demora * 2,intervalo);
      }
    } finally { if (gen === revision) { renovando = false; actualizar(); } }
  }

  async function invalidarSesion(id,conservar = false) {
    if (!compatible() || !id) return;
    cerrando = true;
    ++revision;
    confirmada = null;
    const baja = await retirar(id,{conservar}).catch(() => null);
    if (baja?.limpieza && navigator.onLine) {
      let temporizador;
      try {
        await Promise.race([
          exclusivo(guardar => limpiar(baja,guardar)),
          new Promise(resolve => { temporizador = setTimeout(resolve,1800); })
        ]);
      } catch { /* La entrega local ya quedó desactivada. */ }
      finally { clearTimeout(temporizador); }
    }
  }

  const cerrarSesion = () => invalidarSesion(uid);
  return {estado,dispositivo,preferencia,prueba,cambiarSesion,abrirPanel,renovar,cerrarSesion,invalidarSesion};
}
