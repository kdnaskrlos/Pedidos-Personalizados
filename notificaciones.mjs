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
  let id = localStorage.getItem(CLAVE_LOCAL);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLAVE_LOCAL,id);
  }
  return id;
}

// La sesión se verifica de nuevo después de cada operación de red.
export function crearNotificaciones({sesion,app,datos,actualizar,cargarMessaging = () => import(SDK_MESSAGING)}) {
  let uid, adminActual = false, activo = false, abierto = false, cargandoPreferencias = false;
  let ocupado = false, listo = false, cerrando = false;
  let preferencias = vacias(false), mensaje = "", error = false, revision = 0;
  let intento = -Infinity, sincronizado = -Infinity;
  const comprobar = (id,gen) => {
    if (cerrando || !id || sesion()?.uid !== id || revision !== gen) throw new Error("La sesión cambió.");
  };
  const estado = () => ({
    estado:!compatible() ? "incompatible" : Notification.permission === "denied" ? "bloqueado" :
      !claveVapid ? "configuracion" : !listo ? "cargando" : activo && Notification.permission === "granted" ? "activo" : "apagado",
    preferencias,ocupado,permitePreferencias:abierto && !cargandoPreferencias && listo,mensaje,error
  });

  async function prepararFCM() {
    const sdk = await cargarMessaging();
    if (!await sdk.isSupported()) throw new Error("El navegador no admite notificaciones web.");
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) throw new Error("Recarga Pedidos para terminar de instalar la aplicación.");
    return {sdk,reg,messaging:sdk.getMessaging(app())};
  }

  async function registrar(id,gen,vinculo) {
    const {sdk,reg,messaging} = await prepararFCM();
    comprobar(id,gen);
    const opciones = {vapidKey:claveVapid,serviceWorkerRegistration:reg};
    const dispositivo = vinculo?.id || idDispositivo(), cache = await cacheAvisos();
    const vigencia = () => {
      comprobar(id,gen);
      if (Notification.permission !== "granted") throw new Error("El permiso de notificaciones cambió.");
    };
    const guardar = async recuperar => {
      const token = await sdk.getToken(messaging,opciones);
      vigencia();
      if (!token) throw new Error("Firebase no devolvió un token para el dispositivo.");
      return datos.guardarDispositivo(id,dispositivo,token,vigencia,recuperar);
    };
    if (!await guardar(!!vinculo)) {
      // El servidor puede haber borrado un token inválido que aún conserva el SDK.
      vigencia();
      await sdk.deleteToken(messaging);
      vigencia();
      await guardar(false);
    }
    try {
      vigencia();
      await cache.put(URL_VINCULO,new Response(JSON.stringify({uid:id,id:dispositivo})));
      vigencia();
    } catch (e) {
      const vinculo = await leerVinculo().catch(() => null);
      if (vinculo?.uid === id && vinculo.id === dispositivo) await quitarVinculo();
      throw e;
    }
    activo = true;
    sincronizado = Date.now();
  }

  async function retirar(id) {
    const vinculo = await leerVinculo();
    if (vinculo?.uid !== id) { activo = false; return; }
    // Silencia el SW antes de intentar operaciones que necesitan red.
    await quitarVinculo();
    activo = false;
    const quitarToken = prepararFCM().then(({sdk,messaging}) => sdk.deleteToken(messaging));
    const quitarSuscripcion = navigator.serviceWorker.getRegistration().then(async reg => {
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    });
    await Promise.all([datos.borrarDispositivo(id,vinculo.id),quitarToken,quitarSuscripcion,cerrarAvisos()]);
  }

  async function cambiarSesion(id,admin) {
    if (id === uid) {
      if (admin !== adminActual && !abierto) { preferencias = vacias(admin); actualizar(); }
      adminActual = admin;
      return;
    }
    uid = id;
    adminActual = admin;
    const gen = ++revision;
    cerradoEstado(admin);
    try {
      const vinculo = await leerVinculo();
      if (gen !== revision) return;
      if (vinculo && vinculo.uid !== id) {
        await quitarVinculo();
        await cerrarAvisos();
      } else if (id && vinculo?.uid === id && Notification.permission === "granted") activo = true;
    } catch { /* La app sigue funcionando cuando el almacenamiento de avisos está bloqueado. */ }
    if (gen === revision) { listo = true; actualizar(); await renovar(); }
  }

  function cerradoEstado(admin) {
    abierto = activo = listo = ocupado = error = cerrando = cargandoPreferencias = false;
    preferencias = vacias(admin);
    intento = sincronizado = -Infinity;
    mensaje = "";
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

  function dispositivo(encender) {
    return operar(async (id,gen) => {
      if (!encender) return retirar(id);
      // El navegador exige una interacción directa para mostrar este diálogo.
      const permiso = await Notification.requestPermission();
      comprobar(id,gen);
      if (permiso !== "granted") throw new Error("No se concedió permiso para mostrar notificaciones.");
      await registrar(id,gen);
    },encender ? "Dispositivo activado." : "Avisos desactivados en este dispositivo.");
  }

  const preferencia = (key,val) => operar(async (id,gen) => {
    if (!Object.hasOwn(preferencias,key)) return;
    const nuevas = await datos.guardarPreferencia(id,key,val,preferencias);
    comprobar(id,gen);
    preferencias = nuevas;
  },"Preferencia guardada.");

  const prueba = () => operar(async (id,gen) => {
    const vinculo = await leerVinculo();
    comprobar(id,gen);
    if (vinculo?.uid !== id) throw new Error("Activa este dispositivo primero.");
    const {getFunctions,httpsCallable} = await import(SDK_FUNCTIONS);
    comprobar(id,gen);
    await httpsCallable(getFunctions(app(),regionAvisos),"probarNotificacion")({dispositivo:vinculo.id});
  },"Prueba solicitada. Revisa las notificaciones de este dispositivo.");

  async function renovar(forzar = false) {
    if (!claveVapid || !listo || ocupado || cerrando || !compatible()) return;
    const id = sesion()?.uid, gen = revision;
    if (!id || id !== uid) return;
    const permiso = Notification.permission;
    const ahora = Date.now();
    if (permiso === "granted" &&
        (!navigator.onLine || ahora - intento < reintento || (!forzar && ahora - sincronizado < intervalo))) return;
    const vinculo = await leerVinculo().catch(() => null);
    if (gen !== revision || ocupado || cerrando || sesion()?.uid !== id || vinculo?.uid !== id) return;
    ocupado = true;
    intento = ahora;
    try {
      if (Notification.permission !== "granted") await retirar(id);
      else {
        const reconciliar = async bloqueo => {
          if (!bloqueo) return;
          const actual = await leerVinculo();
          comprobar(id,gen);
          if (actual?.uid === id && actual.id === vinculo.id) await registrar(id,gen,actual);
        };
        if (navigator.locks) await navigator.locks.request("pedidos-push-reconciliar",{ifAvailable:true},reconciliar);
        else await reconciliar(true);
      }
    } catch { /* La intención local se conserva ante errores de red o del SDK. */ }
    finally { if (gen === revision) { ocupado = false; actualizar(); } }
  }

  async function cerrarSesion() {
    const id = sesion()?.uid;
    if (!id) return;
    cerrando = true;
    ++revision;
    const limpieza = retirar(id);
    let temporizador;
    try {
      await Promise.race([limpieza,new Promise(resolve => { temporizador = setTimeout(resolve,1800); })]);
    } catch { /* La vinculación local se desactiva aunque Firestore esté sin conexión. */ }
    finally { clearTimeout(temporizador); }
  }

  return {estado,dispositivo,preferencia,prueba,cambiarSesion,abrirPanel,renovar,cerrarSesion};
}
