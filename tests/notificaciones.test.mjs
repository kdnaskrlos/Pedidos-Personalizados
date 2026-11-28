import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {test} from "node:test";
import {clasesDeCambio,identidadDelEvento,notificarCambio,procesarEntregas} from "../functions/notificaciones.mjs";

const pedido = {
  tipo:"personalizado",publico:true,lectores:["ana"],asignados:[],denegados:[],codigo:"P-0125",
  cliente:{telefono:"000123456789",nombre:"Cliente simulado"},nota:"Primera nota",estado:"pendiente",
  creadoPor:"ana",creadorUid:"actor-uid"
};
const evento = {
  id:"evento-1",pedidoId:"pedido-125",authType:"unknown",authId:"actor-uid",antes:pedido,
  despues:{...pedido,nota:"Nota nueva",editadoPor:"persona ajena",autorAviso:{uid:"actor-uid",en:{seconds:100,nanoseconds:0}}}
};
const perfil = (usuario,extra = {}) => ({activo:true,nombre:usuario,usuario,rol:"empleado",verPersonalizado:true,...extra});

function entorno() {
  const equipo = [
    {uid:"actor-uid",perfil:perfil("ana",{nombre:"Ana"})},
    {uid:"admin-uid",perfil:perfil("admin",{rol:"admin"})},
    {uid:"equipo-uid",perfil:perfil("luis")},
    {uid:"desactivada",perfil:perfil("paula",{activo:false})},
    {uid:"otro-tipo",perfil:perfil("roque",{verPersonalizado:false})}
  ];
  const mensajes = [], procesados = new Set();
  const prefs = new Map([["equipo-uid",{ediciones:true}]]);
  const dispositivos = new Map([
    ["admin-uid",[{id:"pc"},{id:"celular"}]],["actor-uid",[{id:"mio"}]],
    ["equipo-uid",[{id:"equipo"}]],["desactivada",[{id:"viejo"}]],["otro-tipo",[{id:"otro"}]]
  ]);
  let actual = pedido;
  const deps = {
    perfil:async uid => equipo.find(p => p.uid === uid)?.perfil,
    pedido:async () => actual,
    equipoActivo:async () => equipo,
    reservar:async id => { if (procesados.has(id)) return false; procesados.add(id); return true; },
    preferencias:async uid => prefs.get(uid),
    dispositivos:async uid => dispositivos.get(uid) || [],
    enviar:async (uid,lote,datos) => mensajes.push(...lote.map(d => datos(d)))
  };
  return {deps,mensajes,dispositivos,prefs,pedido:nuevo => { actual = nuevo; }};
}

test("clasifica altas, estado y cambios relevantes. Omite demo, restauración y metadatos",() => {
  assert.deepEqual(clasesDeCambio(null,pedido),["nuevos"]);
  assert.deepEqual(clasesDeCambio(null,{...pedido,restaurado:true}),[]);
  assert.deepEqual(clasesDeCambio(pedido,{...pedido,demo:true}),[]);
  assert.deepEqual(clasesDeCambio(pedido,{...pedido,restaurado:true,nota:"respaldo"}),[]);
  assert.deepEqual(clasesDeCambio(pedido,{...pedido,revisar:false,editadoEn:"2027-01-01"}),[]);
  assert.deepEqual(clasesDeCambio(pedido,{...pedido,nota:"Edición",estado:"listo"}),["estado","ediciones"]);
  assert.deepEqual(clasesDeCambio(pedido,null),[]);
});
test("reconoce el UID atestiguado y descarta identidad ausente, discordante o del servicio",() => {
  assert.equal(identidadDelEvento(evento),"actor-uid");
  assert.equal(identidadDelEvento({...evento,authId:undefined}),"actor-uid");
  assert.equal(identidadDelEvento({...evento,authId:"admin-uid"}),null);
  assert.equal(identidadDelEvento({...evento,antes:{...pedido,autorAviso:{...evento.despues.autorAviso}}}),null);
  assert.equal(identidadDelEvento({...evento,despues:pedido}),null);
  for (const authType of ["system","service_account","unauthenticated"])
    assert.equal(identidadDelEvento({...evento,authType}),null);
});
test("notifica los dos dispositivos autorizados del admin con el actor real, deduplica y excluye al autor",async () => {
  const e = entorno();
  e.pedido({...pedido,publico:false,lectores:["ana"],denegados:["luis"]});
  await Promise.all([notificarCambio(evento,e.deps),notificarCambio(evento,e.deps)]);
  assert.deepEqual(e.mensajes.map(x => [x.uid,x.dispositivo]).sort(),[["admin-uid","celular"],["admin-uid","pc"]]);
  for (const x of e.mensajes) {
    assert.match(x.cuerpo,/^Ana modificó un pedido/);
    assert.equal(x.pedidoId,"pedido-125");
    assert.doesNotMatch(JSON.stringify(x),/Cliente simulado|000123456789|Nota nueva|persona ajena/);
  }
});
test("una edición de cien partidas solicita un solo aviso por dispositivo y no incluye el pedido en el mensaje",async () => {
  const e = entorno();
  const items = Array.from({length:100},(_,i) => ({cant:1,precioMenor:100,nombre:`Cliente de partida ${i}`}));
  const antes = {...pedido,items,totalMenor:10000};
  const despues = {...evento.despues,revisionPago:"revision-100",totalMenor:10100,
    items:[...items.slice(0,-1),{...items.at(-1),cant:2}]};
  e.pedido(despues);
  e.prefs.set("equipo-uid",{ediciones:false});
  await notificarCambio({...evento,antes,despues},e.deps);
  await notificarCambio({...evento,antes,despues},e.deps);
  assert.deepEqual(e.mensajes.map(m => m.dispositivo).sort(),["celular","pc"]);
  for (const m of e.mensajes) {
    assert.equal(m.pedidoId,evento.pedidoId);
    assert.doesNotMatch(JSON.stringify(m),/Cliente de partida|revision-100|10100/);
  }
});
test("avisa a un lector de un pedido privado asignado a otra persona",async () => {
  const e = entorno();
  e.pedido({...pedido,publico:false,lectores:["ana","luis"],asignados:["ana"]});
  await notificarCambio(evento,e.deps);
  assert.deepEqual(e.mensajes.filter(x => x.uid === "equipo-uid").map(x => x.dispositivo),["equipo"]);
});
test("respeta la preferencia y la baja de un dispositivo",async () => {
  const e = entorno();
  e.dispositivos.set("admin-uid",[{id:"celular"}]);
  e.prefs.set("equipo-uid",{ediciones:false});
  await notificarCambio(evento,e.deps);
  assert.deepEqual(e.mensajes.map(x => x.dispositivo),["celular"]);
  e.prefs.set("admin-uid",{ediciones:false,estado:false,nuevos:false});
  await notificarCambio({...evento,id:"evento-2"},e.deps);
  assert.equal(e.mensajes.length,1);
});
test("una asignación no habilita el aviso si se revoca la lectura antes de enviar",async () => {
  const e = entorno();
  const compartido = {...pedido,publico:false,lectores:["ana","luis"],asignados:["luis"]};
  e.pedido(compartido);
  const leerDispositivos = e.deps.dispositivos;
  e.deps.dispositivos = uid => {
    if (uid === "equipo-uid") e.pedido({...compartido,lectores:["ana"]});
    return leerDispositivos(uid);
  };
  await notificarCambio(evento,e.deps);
  assert.deepEqual(e.mensajes.map(x => x.uid),["admin-uid","admin-uid"]);
});
test("envía altas y cambios de estado solo a quienes activaron cada categoría",async () => {
  const e = entorno();
  e.prefs.set("equipo-uid",{ediciones:false,nuevos:true,estado:false});
  e.prefs.set("admin-uid",{ediciones:false,nuevos:false,estado:true});
  await notificarCambio({...evento,antes:null,despues:pedido},e.deps);
  await notificarCambio({...evento,id:"evento-2",despues:{...evento.despues,estado:"listo"}},e.deps);
  assert.deepEqual(e.mensajes.map(m => [m.dispositivo,m.titulo]).sort(),[
    ["celular","Pedido P-0125 cambió de estado"],["equipo","Pedido P-0125 registrado"],["pc","Pedido P-0125 cambió de estado"]
  ]);
});
test("procesa bajas FCM definitivas y conserva los tokens con fallo temporal",async () => {
  const retirados = [];
  const fallos = await procesarEntregas([{id:"bien"},{id:"viejo"},{id:"red"}],[
    {success:true},{success:false,error:{code:"messaging/registration-token-not-registered"}},
    {success:false,error:{code:"messaging/server-unavailable"}}
  ],async d => { retirados.push(d.id); });
  assert.deepEqual(retirados,["viejo"]);
  assert.equal(fallos.length,2);
});

test("el mismo service worker muestra un aviso FCM y abre una URL segura, aunque el cliente esté cerrado", async () => {
  let intencion;
  const handlers = {}, mostrados = [], aperturas = [], mensajes = [], borradas = [];
  const url = new URL("https://example.test/Pedidos/sw.js");
  const vinculos = new Map();
  const binding = new URL("./.pedidos-push/dispositivo",url).href;
  const cache = {match:async url => vinculos.get(String(url))};
  const self = {
    location:url,
    addEventListener:(tipo,fn) => { handlers[tipo] = fn; },
    registration:{
      getNotifications:async ({tag}) => mostrados.filter(m => m.opciones.tag === tag),
      showNotification:async (titulo,opciones) => { mostrados.push({titulo,opciones}); }
    },
    clients:{claim:async () => {},matchAll:async () => [],openWindow:async href => { aperturas.push(href); }}
  };
  const lanzar = async (tipo,datos) => {
    let espera;
    handlers[tipo]({...datos,waitUntil:p => { espera = p; }});
    await espera;
  };
  runInNewContext(await readFile(new URL("../sw.js",import.meta.url),"utf8"),{self,location:url,URL,importScripts() {},
    almacenAvisos:{leer:async () => intencion},caches:{open:async () => cache,keys:async () => ["pedidos-v184","pedidos-v185","pedidos-push-v1","libs-v1"],
    delete:async clave => { borradas.push(clave); }}});
  const datos = {app:"pedidos",uid:"uid123",dispositivo:"id-1",evento:"e1",pedidoId:"p-1",titulo:"Actualizado",cuerpo:"Ana modificó un pedido."};
  await lanzar("push",{data:{json:() => ({data:datos})}});
  assert.equal(mostrados.length,0);
  vinculos.set(binding,{json:async () => ({uid:"uid123",id:"id-1"})});
  await lanzar("activate",{});
  assert.deepEqual(borradas,["pedidos-v184"]);
  await Promise.all([lanzar("push",{data:{json:() => ({data:datos})}}),lanzar("push",{data:{json:() => ({data:datos})}})]);
  assert.equal(mostrados.length,1);
  await lanzar("notificationclick",{notification:{data:mostrados[0].opciones.data,close() {}}});
  assert.deepEqual(aperturas,["https://example.test/Pedidos/?aviso=p-1&destino=uid123"]);
  self.clients.matchAll = async () => [{url:"https://example.test/Pedidos/",focus:async () => {},postMessage:m => mensajes.push(m)}];
  await lanzar("notificationclick",{notification:{data:mostrados[0].opciones.data,close() {}}});
  assert.equal(mensajes[0].id,"p-1");
  assert.equal(aperturas.length,1);
  await lanzar("pushsubscriptionchange",{});
  assert.equal(mensajes.at(-1).tipo,"pedidos-renovar-avisos");
  vinculos.clear();
  await lanzar("push",{data:{json:() => ({data:{...datos,evento:"e2"}})}});
  assert.equal(mostrados.length,1);
  intencion = {uid:datos.uid,id:datos.dispositivo,habilitado:true,entrega:true};
  await lanzar("push",{data:{json:() => ({data:{...datos,evento:"e3"}})}});
  assert.equal(mostrados.length,2);
  intencion.habilitado = false;
  vinculos.set(binding,{json:async () => ({uid:datos.uid,id:datos.dispositivo})});
  await lanzar("push",{data:{json:() => ({data:{...datos,evento:"e4"}})}});
  assert.equal(mostrados.length,2);
});

const controlador = (await readFile(new URL("../notificaciones.mjs",import.meta.url),"utf8"))
  .replace(/^import "\.\/notificaciones-almacen.js";\n/m,"")
  .replace(/^import .*$/m,'const claveVapid = "simulada", regionAvisos = "simulada";')
  .replace("import.meta.url",'"https://example.test/Pedidos/notificaciones.mjs"')
  .replace("export function crearNotificaciones","function crearNotificaciones");

function dispositivoSimulado(id, servidor) {
  let estado, arrendamiento;
  let reloj = 0, usuario = "ana", token = id + "-token", intentos = 0, bajas = 0, escrituras = 0;
  const guardado = new Map();
  const cache = {
    match:async url => guardado.get(String(url))?.clone(),
    put:async (url,res) => { guardado.set(String(url),res); },
    delete:async url => guardado.delete(String(url))
  };
  const Notification = {permission:"granted",requestPermission:async () => Notification.permission};
  const navigator = {onLine:true,serviceWorker:{getRegistration:async () => ({
    active:{},getNotifications:async () => [],pushManager:{getSubscription:async () => null}
  })}};
  const almacenAvisos = {
    leer:async () => structuredClone(estado),
    cambiar:async fn => structuredClone(estado = fn(estado)),
    arrendar:async fn => structuredClone(arrendamiento = fn(arrendamiento))
  };
  const crear = runInNewContext(controlador + "\ncrearNotificaciones",{
    URL,Response,crypto,almacenAvisos,setTimeout,clearTimeout,isSecureContext:true,window:{Notification,PushManager:{},caches:{}},
    Notification,navigator,caches:{open:async () => cache},localStorage:{getItem:() => id},
    Date:{now:() => reloj}
  });
  const sesion = () => usuario ? {uid:usuario} : null;
  return {
    Notification,navigator,almacenAvisos,perderCache:() => guardado.clear(),
    legado:() => cache.put("https://example.test/Pedidos/.pedidos-push/dispositivo",new Response(JSON.stringify({uid:"ana",id}))),
    avanzar: ms => { reloj += ms; },
    cambiarToken: nuevo => { token = nuevo; }, cambiarUsuario: uid => { usuario = uid; },
    contadores: () => ({intentos,bajas,escrituras}),
    abrir:() => crear({
      sesion,app:() => ({}),actualizar:() => {},
      cargarMessaging: async () => ({
        isSupported:async () => true, getMessaging:() => ({}), getToken:async () => token,
        deleteToken:async () => { bajas++; token += "-nuevo"; }
      }),
      datos:{
        leerPreferencias:async () => null,
        guardarDispositivo:async (uid,id,actual,vigencia,comprobarRegistro) => {
          intentos++;
          if (!navigator.onLine || servidor.falla) throw new Error("Sin conexión");
          await servidor.espera;
          await vigencia();
          const clave = uid + "/" + id;
          if (!servidor.has(clave) && comprobarRegistro) return false;
          if (servidor.get(clave) !== actual) { servidor.set(clave,actual); escrituras++; }
          return true;
        },
        borrarDispositivo:async (uid,id) => {
          if (!navigator.onLine) throw new Error("Sin conexión");
          servidor.delete(uid + "/" + id);
        }
      }
    })
  };
}

test("restaura la intención tras recargar, desconectarse y perder el registro remoto", async () => {
  const servidor = new Map(), movil = dispositivoSimulado("movil",servidor), pc = dispositivoSimulado("pc",servidor);
  let app = movil.abrir();
  await app.cambiarSesion("ana",false);
  await app.dispositivo(true);
  const escritorio = pc.abrir();
  await escritorio.cambiarSesion("ana",false);
  await escritorio.dispositivo(true);
  assert.equal(app.estado().estado,"activo");
  servidor.delete("ana/movil");
  movil.navigator.onLine = false;
  app = movil.abrir();
  await app.cambiarSesion("ana",false);
  await app.abrirPanel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.estado().estado,"pendiente");
  movil.navigator.onLine = true;
  servidor.falla = true;
  await app.renovar();
  assert.equal(app.estado().estado,"pendiente");
  servidor.falla = false;
  await app.renovar(true);
  assert.equal(servidor.has("ana/movil"),false);
  movil.avanzar(60000);
  await Promise.all([app.renovar(),app.renovar(true),app.renovar()]);
  assert.equal(servidor.get("ana/movil"),"movil-token-nuevo");
  assert.equal(servidor.get("ana/pc"),"pc-token");
  assert.deepEqual(movil.contadores(),{intentos:4,bajas:1,escrituras:2});
  movil.avanzar(15 * 60000);
  await app.renovar();
  assert.equal(movil.contadores().escrituras,2);
  movil.cambiarToken("rotado");
  movil.avanzar(60000);
  await app.renovar(true);
  assert.equal(servidor.get("ana/movil"),"rotado");
  assert.equal(servidor.size,2);
});

test("desactivar sin conexión, revocar permiso y cerrar sesión impiden la recuperación", async () => {
  for (const accion of ["manual","permiso","sesion"]) {
    const servidor = new Map(), movil = dispositivoSimulado("movil",servidor);
    let app = movil.abrir();
    await app.cambiarSesion("ana",false);
    await app.dispositivo(true);
    movil.navigator.onLine = false;
    if (accion === "manual") await app.dispositivo(false);
    if (accion === "permiso") {
      movil.Notification.permission = "denied";
      await app.renovar();
      assert.equal(app.estado().estado,"bloqueado");
      movil.Notification.permission = "granted";
    }
    if (accion === "sesion") {
      await app.cerrarSesion();
      movil.cambiarUsuario("otra");
    }
    movil.navigator.onLine = true;
    app = movil.abrir();
    await app.cambiarSesion(accion === "sesion" ? "otra" : "ana",false);
    assert.equal(app.estado().estado,"apagado");
    assert.equal(movil.contadores().escrituras,1);
  }
});

test("una reconciliación pendiente no restaura el dispositivo después de cerrar sesión", async () => {
  const servidor = new Map(), movil = dispositivoSimulado("movil",servidor), app = movil.abrir();
  await app.cambiarSesion("ana",false);
  await app.dispositivo(true);
  movil.cambiarToken("rotado");
  movil.avanzar(15 * 60000);
  let continuar;
  servidor.espera = new Promise(resolve => { continuar = resolve; });
  const renovacion = app.renovar();
  while (movil.contadores().intentos < 2) await new Promise(resolve => setImmediate(resolve));
  await app.cerrarSesion();
  continuar();
  await renovacion;
  assert.equal((await movil.almacenAvisos.leer()).entrega,false);
  assert.notEqual(servidor.get("ana/movil"),"rotado");
  const restaurada = movil.abrir();
  await restaurada.cambiarSesion("ana",false);
  assert.equal(restaurada.estado().estado,"apagado");
});

test("un arranque sin conexión distingue la intención de un registro verificado", async () => {
  const movil = dispositivoSimulado("movil",new Map());
  const primera = movil.abrir();
  await primera.cambiarSesion("ana",false);
  await primera.dispositivo(true);
  movil.navigator.onLine = false;
  const reabierta = movil.abrir();
  await reabierta.cambiarSesion("ana",false);
  const resultado = reabierta.estado();
  assert.equal(resultado.estado,"pendiente");
  assert.equal(resultado.habilitado,true);
});

test("la desactivación manual prevalece sobre una renovación pausada", {timeout:4000}, async () => {
  const servidor = new Map(), movil = dispositivoSimulado("movil",servidor), app = movil.abrir();
  await app.cambiarSesion("ana",false);
  await app.dispositivo(true);
  movil.avanzar(15 * 60000);
  let continuar;
  servidor.espera = new Promise(resolve => { continuar = resolve; });
  const renovacion = app.renovar();
  while (movil.contadores().intentos < 2) await new Promise(resolve => setImmediate(resolve));
  const apagado = app.dispositivo(false);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.estado().estado,"apagado");
  } finally {
    continuar();
    await Promise.allSettled([apagado,renovacion]);
  }
  await app.renovar();
  assert.equal(servidor.has("ana/movil"),false);
});

test("migra un vínculo anterior y conserva el ID tras perder Cache Storage", async () => {
  const servidor = new Map([["ana/movil","movil-token"]]), movil = dispositivoSimulado("movil",servidor);
  await movil.legado();
  let app = movil.abrir();
  await app.cambiarSesion("ana",false);
  assert.equal(app.estado().estado,"activo");
  movil.perderCache();
  servidor.delete("ana/movil");
  app = movil.abrir();
  await app.cambiarSesion("ana",false);
  assert.equal(app.estado().estado,"activo");
  assert.equal((await movil.almacenAvisos.leer()).id,"movil");
  assert.deepEqual([...servidor], [["ana/movil","movil-token-nuevo"]]);
  await app.dispositivo(false);
  await movil.legado();
  app = movil.abrir();
  await app.cambiarSesion("ana",false);
  assert.equal(app.estado().estado,"apagado");
});

test("dos pestañas no rotan el mismo token a la vez y una baja invalida ambas", {timeout:4000}, async () => {
  const servidor = new Map(), movil = dispositivoSimulado("movil",servidor);
  const primera = movil.abrir(), segunda = movil.abrir();
  await primera.cambiarSesion("ana",false);
  await primera.dispositivo(true);
  await segunda.cambiarSesion("ana",false);
  servidor.delete("ana/movil");
  let continuar;
  servidor.espera = new Promise(resolve => { continuar = resolve; });
  movil.avanzar(15 * 60000);
  const conteo = movil.contadores().intentos;
  const primeraRenovacion = primera.renovar();
  while (movil.contadores().intentos === conteo) await new Promise(resolve => setImmediate(resolve));
  await segunda.renovar(true);
  assert.equal(movil.contadores().intentos,conteo + 1);
  await segunda.dispositivo(false);
  continuar();
  await primeraRenovacion;
  assert.equal(movil.contadores().bajas,0);
  assert.equal((await movil.almacenAvisos.leer()).entrega,false);
  assert.equal(servidor.has("ana/movil"),false);
});

test("un fallo de verificación del perfil pausa la entrega y una baja definitiva no la repone", async () => {
  const servidor = new Map(), movil = dispositivoSimulado("movil",servidor), app = movil.abrir();
  await app.cambiarSesion("ana",true);
  await app.dispositivo(true);
  await app.invalidarSesion("ana",true);
  let registro = await movil.almacenAvisos.leer();
  assert.equal(registro.habilitado,true);
  assert.equal(registro.entrega,false);
  await app.cambiarSesion("ana",true);
  assert.equal(app.estado().estado,"activo");
  await app.invalidarSesion("ana");
  registro = await movil.almacenAvisos.leer();
  assert.equal(registro.habilitado,false);
  assert.equal(registro.entrega,false);
  await app.cambiarSesion("ana",false);
  assert.equal(app.estado().estado,"apagado");
});

test("los errores consecutivos amplían la espera sin escribir en Firestore", async () => {
  const servidor = new Map(), movil = dispositivoSimulado("movil",servidor), app = movil.abrir();
  servidor.falla = true;
  await app.cambiarSesion("ana",false);
  await app.dispositivo(true);
  assert.equal(app.estado().estado,"pendiente");
  assert.equal(app.estado().habilitado,true);
  movil.avanzar(60000);
  await app.renovar();
  movil.avanzar(60000);
  await app.renovar(true);
  assert.equal(movil.contadores().intentos,2);
  assert.equal(movil.contadores().escrituras,0);
  servidor.falla = false;
  movil.avanzar(60000);
  await app.renovar(true);
  assert.equal(app.estado().estado,"activo");
  assert.equal(movil.contadores().escrituras,1);
});

test("una señal de suscripción durante la espera se procesa al terminar la pausa", async () => {
  const servidor = new Map(), movil = dispositivoSimulado("movil",servidor), app = movil.abrir();
  await app.cambiarSesion("ana",false);
  await app.dispositivo(true);
  movil.cambiarToken("rotado");
  await app.renovar(true);
  assert.equal(app.estado().estado,"pendiente");
  assert.equal(movil.contadores().intentos,1);
  movil.avanzar(60000);
  await app.renovar();
  assert.equal(app.estado().estado,"activo");
  assert.equal(servidor.get("ana/movil"),"rotado");
});
