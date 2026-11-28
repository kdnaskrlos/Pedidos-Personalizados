import "./notificaciones-almacen.js";
import {claveVapid,regionAvisos} from "./push-config.mjs";

const SDK_MESSAGING = "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
const SDK_FUNCTIONS = "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
const CACHE = "pedidos-push-v1";
const URL_APP = new URL("./",import.meta.url);
const URL_VINCULO = new URL(".pedidos-push/dispositivo",URL_APP);
const URL_WORKER = new URL("sw.js",URL_APP);
const CLAVE_LOCAL = "cs-dispositivo-avisos";
const intervalo = 15 * 60000;
const reintento = 60000;
const vacias = admin => ({ediciones:admin,nuevos:false,estado:false});

// No se muestran mensajes, datos del SDK ni códigos fuera de esta lista.
const codigos = new Set([
  "permission-denied","unauthenticated","unavailable","deadline-exceeded","aborted","resource-exhausted",
  "messaging/unsupported-browser","messaging/indexed-db-unsupported","messaging/permission-blocked",
  "messaging/token-subscribe-failed","messaging/token-subscribe-no-token","messaging/token-update-failed",
  "messaging/token-update-no-token","messaging/token-unsubscribe-failed","messaging/invalid-sw-registration",
  "installations/request-failed","worker-no-activo","worker-distinto","token-invalido","suscripcion-no-retirada",
  "vinculo-invalido","SecurityError","QuotaExceededError","NotAllowedError","InvalidStateError","AbortError"
]);
const errorAvisos = code => Object.assign(new Error(code),{code});
const codigoSeguro = error => [error?.code,error?.name].find(codigo => codigos.has(codigo)) || "fallo";
const tokenValido = token => typeof token === "string" && token.length >= 32 && token.length <= 4096 && !/\s/.test(token);
const idValido = id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);

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
  if (!idValido(id)) {
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
  let diagnostico, restauracionPendiente = false;
  const informar = (gen,fase,codigo) => {
    if (gen !== revision) return;
    diagnostico = {fase,codigo};
    actualizar();
  };
  async function paso(gen,fase,operacion) {
    informar(gen,fase,"comprobando");
    // El SDK no ofrece cancelación. Se informa de la espera sin liberar el
    // bloqueo mientras aún puede estar cambiando la suscripción.
    const aviso = setTimeout(() => informar(gen,fase,"espera-prolongada"),20000);
    try { return await operacion(); }
    catch (error) { informar(gen,fase,codigoSeguro(error)); throw error; }
    finally { clearTimeout(aviso); }
  }
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
      diagnostico:diagnostico && {...diagnostico,espera:Math.max(0,Math.ceil((proximoIntento - Date.now()) / 1000))},
      habilitado,preferencias,ocupado,permitePreferencias:abierto && !cargandoPreferencias && listo,mensaje,error
    };
  };

  async function prepararFCM(gen) {
    const reg = await paso(gen,"worker",async () => {
      const actual = await navigator.serviceWorker.getRegistration(URL_APP.href);
      if (!actual?.active || actual.active.state === "activating") throw errorAvisos("worker-no-activo");
      if (actual.active.scriptURL !== URL_WORKER.href) throw errorAvisos("worker-distinto");
      return actual;
    });
    return paso(gen,"sdk",async () => {
      const sdk = await cargarMessaging();
      if (!await sdk.isSupported()) throw errorAvisos("messaging/unsupported-browser");
      return {sdk,reg,messaging:sdk.getMessaging(app())};
    });
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
    if (!idValido(dispositivo)) return paso(gen,"almacen",() => { throw errorAvisos("vinculo-invalido"); });
    const {sdk,reg,messaging} = await prepararFCM(gen);
    const opciones = {vapidKey:claveVapid,serviceWorkerRegistration:reg};
    const obtenerToken = () => paso(gen,"token",async () => {
      await vigente();
      const token = await sdk.getToken(messaging,opciones);
      if (!tokenValido(token)) throw errorAvisos("token-invalido");
      return token;
    });
    const guardar = (token,comprobarRegistro) => paso(gen,"firestore",async () => {
      await vigente();
      return datos.guardarDispositivo(id,dispositivo,token,vigente,comprobarRegistro);
    });
    const limpiarTokenAnterior = () => paso(gen,"suscripcion",async () => {
      await vigente();
      await almacen.cambiar(actual => actual?.generacion === generacion ? {...actual,entrega:false} : actual);
      canal?.postMessage("cambio");
      await vigente();
      let retirada;
      try { retirada = await sdk.deleteToken(messaging); }
      catch (error) {
        if (error?.code !== "messaging/token-unsubscribe-failed") throw error;
        // En el SDK 10.12.2 un DELETE rechazado deja la inscripción local intacta.
        // Cambiar la suscripción hace que getToken obtenga una inscripción nueva.
        await vigente();
        retirada = await (await reg.pushManager.getSubscription())?.unsubscribe();
      }
      await vigente();
      if (retirada !== true && await reg.pushManager.getSubscription()) throw errorAvisos("suscripcion-no-retirada");
      await almacen.cambiar(actual => actual?.generacion === generacion ? {...actual,registrado:false} : actual);
    });
    let token, reemplazado = false;
    try { token = await obtenerToken(); }
    catch (error) {
      if (!registro.registrado || !["messaging/token-update-failed","messaging/token-update-no-token"].includes(error?.code)) throw error;
      // Solo se rota aquí ante un rechazo definitivo o una ausencia confirmada
      // por el servidor. Un fallo de red no debe destruir una suscripción útil.
      const info = error.customData?.errorInfo;
      const obsoleto = typeof info === "string" && /^(requested entity was not found|unregistered|registration-token-not-registered)\.?$/i.test(info.trim());
      if (!obsoleto) {
        const existe = await paso(gen,"firestore",async () => {
          await vigente();
          return datos.existeDispositivo(id,dispositivo);
        });
        if (existe) { informar(gen,"token",codigoSeguro(error)); throw error; }
      }
      await limpiarTokenAnterior();
      reemplazado = true;
      token = await obtenerToken();
    }
    if (!await guardar(token,registro.registrado && !reemplazado)) {
      await limpiarTokenAnterior();
      await guardar(await obtenerToken(),false);
    }
    await vigente();
    const nuevo = await paso(gen,"almacen",() => almacen.cambiar(actual => actual?.generacion === generacion ?
      {...actual,entrega:true,registrado:true,comprobado:Date.now()} : actual));
    comprobar(id,gen);
    if (nuevo?.generacion !== generacion) return;
    adoptar(nuevo);
    confirmada = generacion;
    informar(gen,"firestore","verificado");
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
    const {sdk,messaging} = await prepararFCM(revision);
    if (!await vigente()) return;
    await sdk.deleteToken(messaging);
    await almacen.cambiar(actual => actual?.generacion === baja.generacion ? {...actual,limpieza:false} : actual);
  }

  async function restaurar(id,gen) {
    const actual = await paso(gen,"migracion",async () => {
      const guardado = await almacen.leer();
      if (gen !== revision) return;
      if (guardado?.uid === id) return guardado;
      const legado = guardado ? null : await leerVinculo();
      if (gen !== revision) return;
      return almacen.cambiar(anterior => {
        if (gen !== revision) return anterior;
        if (!anterior && legado?.uid === id) {
          if (!idValido(legado.id)) throw errorAvisos("vinculo-invalido");
          return {uid:id,id:legado.id,generacion:crypto.randomUUID(),habilitado:true,entrega:true,registrado:true};
        }
        if (anterior?.uid === id || !anterior && !legado) return anterior;
        return {uid:id,id:idDispositivo(),generacion:crypto.randomUUID(),habilitado:false,entrega:false};
      });
    });
    if (gen !== revision) return;
    restauracionPendiente = false;
    diagnostico = actual?.habilitado ? {fase:"migracion",codigo:"comprobando"} : null;
    adoptar(actual);
    // La nueva vinculación ya es duradera antes de retirar el formato anterior.
    if (actual) await quitarVinculo().catch(() => {});
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
    intencion = confirmada = diagnostico = null;
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
    if (gen !== revision) return;
    restauracionPendiente = compatible() && !!id;
    if (restauracionPendiente) {
      try { await restaurar(id,gen); }
      catch { if (gen === revision) proximoIntento = Date.now() + reintento; }
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
      if (restauracionPendiente) {
        if (Date.now() < proximoIntento) return;
        await restaurar(id,gen);
      }
      const actual = await almacen.leer().catch(error => {
        informar(gen,"almacen",codigoSeguro(error));
        throw error;
      });
      comprobar(id,gen);
      adoptar(actual);
      if (actual?.uid !== id) return;
      if (actual.habilitado && Notification.permission !== "granted") {
        await dispositivo(false);
        return;
      }
      const ahora = Date.now();
      if (!navigator.onLine) {
        if (actual.habilitado && !confirmada) informar(gen,"conexion","sin-conexion");
        return;
      }
      if (ahora < proximoIntento) return;
      if (!actual.habilitado && !actual.limpieza) return;
      if (!forzarRenovacion && confirmada && actual.comprobado + intervalo > ahora) return;
      confirmada = null;
      actualizar();
      let ejecutado = false;
      informar(gen,"bloqueo","comprobando");
      await exclusivo(async conservar => {
        ejecutado = true;
        forzarRenovacion = false;
        if (actual.habilitado) await registrar(actual,gen,conservar);
        else await limpiar(actual,conservar);
      });
      if (gen === revision) {
        if (!ejecutado) informar(gen,"bloqueo","otra-pestana");
        demora = reintento;
        proximoIntento = ahora + (ejecutado ? reintento : 5000);
      }
    } catch (error) {
      if (gen === revision) {
        if (diagnostico?.fase === "bloqueo") informar(gen,"bloqueo",codigoSeguro(error));
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

  function workerListo() {
    if (diagnostico?.fase === "worker" && diagnostico.codigo === "worker-no-activo") proximoIntento = 0;
    return renovar();
  }

  const cerrarSesion = () => invalidarSesion(uid);
  return {estado,dispositivo,preferencia,prueba,cambiarSesion,abrirPanel,renovar,workerListo,cerrarSesion,invalidarSesion};
}
