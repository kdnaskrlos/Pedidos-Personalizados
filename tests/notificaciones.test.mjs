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
  const handlers = {}, mostrados = [], aperturas = [], mensajes = [];
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
    clients:{matchAll:async () => [],openWindow:async href => { aperturas.push(href); }}
  };
  const lanzar = async (tipo,datos) => {
    let espera;
    handlers[tipo]({...datos,waitUntil:p => { espera = p; }});
    await espera;
  };
  runInNewContext(await readFile(new URL("../sw.js",import.meta.url),"utf8"),{self,location:url,URL,caches:{open:async () => cache}});
  const datos = {app:"pedidos",uid:"uid123",dispositivo:"id-1",evento:"e1",pedidoId:"p-1",titulo:"Actualizado",cuerpo:"Ana modificó un pedido."};
  await lanzar("push",{data:{json:() => ({data:datos})}});
  assert.equal(mostrados.length,0);
  vinculos.set(binding,{json:async () => ({uid:"uid123",id:"id-1"})});
  await Promise.all([lanzar("push",{data:{json:() => ({data:datos})}}),lanzar("push",{data:{json:() => ({data:datos})}})]);
  assert.equal(mostrados.length,1);
  await lanzar("notificationclick",{notification:{data:mostrados[0].opciones.data,close() {}}});
  assert.deepEqual(aperturas,["https://example.test/Pedidos/?aviso=p-1&destino=uid123"]);
  self.clients.matchAll = async () => [{url:"https://example.test/Pedidos/",focus:async () => {},postMessage:m => mensajes.push(m)}];
  await lanzar("notificationclick",{notification:{data:mostrados[0].opciones.data,close() {}}});
  assert.equal(mensajes[0].id,"p-1");
  assert.equal(aperturas.length,1);
  vinculos.clear();
  await lanzar("push",{data:{json:() => ({data:{...datos,evento:"e2"}})}});
  assert.equal(mostrados.length,1);
});
