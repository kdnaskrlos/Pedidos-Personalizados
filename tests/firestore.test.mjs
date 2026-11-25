import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  collection, deleteDoc, disableNetwork, enableNetwork, doc, getDoc, getDocFromServer, getDocs, query, runTransaction, setDoc, setLogLevel, serverTimestamp, updateDoc, where, writeBatch
} from "firebase/firestore";
import { registrarPedido, prepararValidacionPago, confirmarEdicionGrande, versionPedido } from "../pedidos-sync.mjs";
import { puedeNotificar } from "../functions/notificaciones.mjs";

const PROJECT = "demo-pedidos-codex";
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(FIRESTORE || "", /^(127\.0\.0\.1|localhost):\d+$/, "Usa el emulador local de Firestore");
const [host, port] = FIRESTORE.split(":");
setLogLevel("silent");
const reglas = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
const sdk = {doc,getDocFromServer,runTransaction,serverTimestamp,deleteDoc};
let env, admin, ana, luis, asignado, inactivo, anon;

const perfil = (usuario, opts) => ({
  usuario, nombre:usuario, rol:"empleado", activo:true, verPersonalizado:true, verSublimacion:false,
  soloAsignados:false, eliminar:false, bloquear:false, ...opts
});
const pedido = (usuario, opts) => ({
  tipo:"personalizado", creadoPor:usuario, creadoEn:"2026-01-01T12:00:00.000Z",
  estado:"pendiente", avisado:false, publico:true, lectores:[usuario], denegados:[], asignados:[],
  cliente:{nombre:"Cliente sintético",telefono:"580000000000"}, tema:"Prueba", fechaEntrega:"2027-01-01",
  items:[{prenda:"Franela",horma:"Unisex",talla:"M",color:"Negro",cant:2,precioMenor:1011}],
  moneda:"USD", pagoVersion:2, totalMenor:2022, abonoMenor:25, imagenes:[], nota:"Nota sintética", ...opts
});
const fotoId = randomUUID();
const img = "data:image/jpeg;base64,AA==";
const fotoLegada = {data:img, por:"ana", creadoEn:"2026-01-01"};
const fotoVinculada = {...fotoLegada, pedidoId:"privado", baseId:fotoId, mini:false};
const ruta = (db, id) => doc(db, id);
const lista = (db, ...constraints) => getDocs(query(collection(db,"pedidos"), ...constraints));
const ids = snapshot => snapshot.docs.map(d => d.id).sort();
const leer = (db, p) => getDoc(ruta(db,p)).then(s => s.data());
const guardar = (db, p, v) => setDoc(ruta(db,p),v);
const cambiar = (db, p, v) => updateDoc(ruta(db,p),v);
const borrar = (db, p) => deleteDoc(ruta(db,p));
const alta = (db, uid, p, id = randomUUID(), fotos = [], identidad = uid) => registrarPedido(db,sdk,uid,{id,pedido:p,fotos},identidad);

before(async () => {
  env = await initializeTestEnvironment({projectId:PROJECT, firestore:{host,port:Number(port),rules:reglas}});
  const db = uid => env.authenticatedContext(uid).firestore();
  admin = db("admin"); ana = db("ana"); luis = db("luis"); asignado = db("asignado");
  inactivo = db("inactivo"); anon = env.unauthenticatedContext().firestore();
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore(), batch = writeBatch(db);
    for (const [path, value] of [
      ["sistema/estado",{iniciado:true}],
      ["usuarios/admin",perfil("admin",{rol:"admin"})], ["usuarios/ana",perfil("ana",{bloquear:true})],
      ["usuarios/luis",perfil("luis",{eliminar:true})], ["usuarios/asignado",perfil("asignado",{soloAsignados:true})],
      ["usuarios/inactivo",perfil("inactivo",{activo:false})],
      ["logins/ana",{uid:"ana",email:"ana@example.test"}], ["config/ajustes",{dias:3}],
      ["config/privado",{ejemplo:true}], ["clientes/sintetico",{nombre:"Ejemplo"}],
      ["anuncios/aviso",{texto:"Aviso sintético"}], ["respaldos/estado",{cada:7}],
      ["contadores/personalizado",{n:49,alineado:true}], ["contadores/sublimacion",{n:15,alineado:true}],
      ["fotos/" + fotoId,fotoVinculada], ["fotos/legada",fotoLegada],
      ["pedidos/publico",{...pedido("ana",{codigo:"P-0048",lectores:["ana","asignado"]})}],
      ["pedidos/privado",{...pedido("ana",{codigo:"P-0049",publico:false,denegados:["luis"],imagenes:[fotoId]})}],
      ["pedidos/otro-tipo",{...pedido("ana",{tipo:"sublimacion",codigo:"S-0015",lectores:["ana","luis"]})}]
    ]) batch.set(ruta(db,path),value);
    await batch.commit();
  });
});

test("limita lecturas anónimas e inactivas a las rutas de acceso justificadas", async () => {
  await assertSucceeds(leer(anon,"sistema/estado"));
  await assertSucceeds(leer(anon,"logins/ana"));
  await assertFails(getDocs(collection(anon,"logins")));
  await assertFails(getDocs(collection(admin,"logins")));
  await assertSucceeds(leer(inactivo,"usuarios/inactivo"));
  for (const db of [anon,inactivo]) {
    for (const path of ["usuarios/ana","pedidos/publico","fotos/" + fotoId,"config/ajustes","clientes/sintetico","anuncios/aviso","contadores/personalizado","respaldos/estado"])
      await assertFails(leer(db,path));
    await assertFails(cambiar(db,"pedidos/publico",{nota:"Sin permiso"}));
  }
  await assertSucceeds(leer(ana,"config/ajustes"));
  await assertFails(getDocs(collection(ana,"usuarios")));
  await assertSucceeds(getDocs(query(collection(ana,"usuarios"), where("activo","==",true))));
  await assertFails(leer(ana,"config/privado"));
  await assertFails(leer(ana,"clientes/sintetico"));
  await assertFails(cambiar(ana,"usuarios/ana",{rol:"admin"}));
  await assertFails(cambiar(ana,"logins/ana",{email:"otra@example.test"}));
  await assertSucceeds(cambiar(admin,"usuarios/luis",{activo:false}));
  await assertFails(leer(luis,"pedidos/publico"));
});

test("las consultas por tipo, lectores y público respetan el alcance real", async () => {
  const tipo = where("tipo","==","personalizado"), publico = where("publico","==",true);
  assert.deepEqual(ids(await assertSucceeds(lista(luis,tipo,publico))),["publico"]);
  assert.deepEqual(ids(await assertSucceeds(lista(ana,tipo,where("lectores","array-contains","ana")))),["privado","publico"]);
  assert.deepEqual(ids(await assertSucceeds(lista(asignado,tipo,where("lectores","array-contains","asignado")))),["publico"]);
  await assertFails(lista(ana,where("lectores","array-contains","ana")));
  await assertFails(lista(luis));
  await assertFails(lista(asignado,tipo,publico));
  await assertFails(leer(luis,"pedidos/privado"));
  await assertFails(leer(luis,"pedidos/otro-tipo"));
  await assertFails(leer(ana,"pedidos/otro-tipo"));
  assert.deepEqual(ids(await assertSucceeds(lista(admin))),["otro-tipo","privado","publico"]);
});

test("los destinatarios de avisos coinciden con la lectura de Firestore al asignar y revocar acceso", async () => {
  const path = "pedidos/privado";
  await assertSucceeds(cambiar(admin,path,{publico:false,lectores:["ana","luis","asignado"],asignados:["ana"],denegados:[]}));
  const comparar = async (db, usuario, permitido, documento = path) => {
    const [datos, miembro] = await Promise.all([leer(admin,documento),leer(admin,`usuarios/${usuario}`)]);
    assert.equal(puedeNotificar(miembro,datos),permitido);
    const lecturaServidor = getDocFromServer(ruta(db,documento));
    if (permitido) assert.equal((await assertSucceeds(lecturaServidor)).exists(),true);
    else await assertFails(lecturaServidor);
  };
  await comparar(luis,"luis",true);
  await comparar(asignado,"asignado",true);
  await assertSucceeds(cambiar(admin,path,{lectores:["ana"],asignados:["luis"]}));
  await comparar(luis,"luis",false);
  await comparar(asignado,"asignado",false);
  await assertSucceeds(cambiar(admin,path,{publico:true,asignados:["ana"]}));
  await comparar(luis,"luis",true);
  await comparar(asignado,"asignado",false);
  await assertSucceeds(cambiar(admin,"usuarios/luis",{verPersonalizado:false}));
  await comparar(luis,"luis",false);
  const restaurado = "pedidos/aviso-restaurado";
  await assertSucceeds(guardar(admin,restaurado,pedido("ana",{restaurado:true,codigo:"P-0051",pagoVersion:1,publico:false,lectores:{asignado:false}})));
  await comparar(asignado,"asignado",true,restaurado);
  await comparar(ana,"ana",false,restaurado);
});

test("al editar conserva identidad, autoría y controles de acceso", async () => {
  for (const v of [{tipo:"sublimacion"},{codigo:"P-9999"},{creadoEn:"ayer"},{creadoPor:"luis"},{creadorUid:"luis"},
    {editadoPor:"otra-persona"},{listoPor:"otra-persona"},{avisadoPor:"otra-persona"},
    {publico:false,lectores:["luis"]},{denegados:["ana"]},{demo:true},{revisar:false}])
    await assertFails(cambiar(luis,"pedidos/publico",v));
  await assertFails(cambiar(admin,"pedidos/publico",{codigo:"P-1000"}));
  await assertFails(cambiar(ana,"pedidos/privado",{lectores:["ana","luis"]}));
  await assertFails(cambiar(ana,"pedidos/privado",{publico:true}));
  await assertSucceeds(cambiar(ana,"pedidos/privado",{publico:true,lectores:["ana"],denegados:[]}));
  await assertSucceeds(cambiar(luis,"pedidos/privado",{nota:"Edición sintética",editadoPor:"luis",revisar:true,revisarPor:"luis",revisarCambios:["Nota"]}));
  await assertSucceeds(cambiar(admin,"pedidos/privado",{revisar:false}));
  await assertFails(borrar(ana,"pedidos/privado"));
  await assertSucceeds(borrar(luis,"pedidos/privado"));
});

test("las fotos heredan visibilidad del pedido y las históricas requieren vínculo", async () => {
  await assertSucceeds(leer(ana,"fotos/" + fotoId));
  await assertFails(leer(luis,"fotos/" + fotoId));
  await assertFails(leer(ana,"fotos/legada"));
  await assertFails(getDocs(collection(ana,"fotos")));
  await assertFails(cambiar(ana,"fotos/" + fotoId,{data:"otra foto"}));
  await assertFails(borrar(ana,"fotos/" + fotoId));
  await assertFails(guardar(ana,"fotos/" + randomUUID(),fotoLegada));
  await assertSucceeds(leer(admin,"fotos/legada"));
  await assertSucceeds(cambiar(admin,"fotos/legada",{pedidoId:"publico",baseId:"legada",mini:false}));
  await assertFails(leer(ana,"fotos/legada")); // Un vínculo solo no basta sin la referencia del pedido.
  await assertSucceeds(cambiar(admin,"pedidos/publico",{imagenes:["legada"]}));
  await assertSucceeds(leer(luis,"fotos/legada"));

  const adjunto = randomUUID();
  const datos = {pedidoId:"publico",baseId:adjunto,por:"luis",data:img,creadoEn:"2026-01-02",mini:false};
  await assertFails(guardar(luis,"fotos/" + adjunto,datos));
  const batch = writeBatch(luis);
  batch.update(doc(luis,"pedidos","publico"),{imagenes:["legada",adjunto],editadoPor:"luis"});
  batch.set(doc(luis,"fotos",adjunto),datos);
  await assertSucceeds(batch.commit());
  await assertSucceeds(leer(ana,"fotos/" + adjunto));
});

test("sólo reserva altas atómicas y deja al administrador fijar un piso monotónico", async () => {
  await assertFails(guardar(ana,"contadores/personalizado",{n:50,alineado:true}));
  await assertFails(guardar(ana,"contadores/personalizado",{n:100,alineado:true,ultimoId:randomUUID()}));
  await assertFails(guardar(ana,"contadores/otro",{n:50,alineado:true}));
  await assertFails(borrar(admin,"contadores/personalizado"));
  await assertFails(guardar(admin,"contadores/personalizado",{n:48,alineado:true}));
  await assertFails(guardar(admin,"pedidos/" + randomUUID(),{...pedido("admin"),codigo:"P-0050"}));
  await assertFails(guardar(ana,"pedidos/" + randomUUID(),{...pedido("ana"),codigo:"P-0050"}));
  await assertFails(guardar(ana,"usuarios/ana/envios/" + randomUUID(),{n:50,tipo:"personalizado",codigo:"P-0050"}));
  await assertSucceeds(guardar(admin,"contadores/personalizado",{n:10000,alineado:true}));
  assert.equal(await assertSucceeds(alta(ana,"ana",pedido("ana"))),"P-10001");
  assert.equal((await leer(admin,"pedidos/privado")).codigo,"P-0049");
});

test("dos clientes concurrentes reciben consecutivos distintos y un reintento conserva su identidad", async () => {
  const ida = randomUUID(), idl = randomUUID();
  const [a,l] = await Promise.all([alta(ana,"ana",pedido("ana"),ida),alta(luis,"luis",pedido("luis"),idl)]);
  assert.deepEqual([a,l].sort(),["P-0050","P-0051"]);
  assert.deepEqual(await Promise.all([
    alta(ana,"ana",pedido("ana",{nota:"Otro intento"}),ida), alta(ana,"ana",pedido("ana"),ida)
  ]),[a,a]);
  assert.equal((await leer(admin,"pedidos/" + ida)).nota,"Nota sintética");
  await assertFails(leer(luis,"usuarios/ana/envios/" + ida));
  await assertFails(borrar(admin,"usuarios/ana/envios/" + ida));
  await assertSucceeds(borrar(admin,"pedidos/" + ida));
  assert.equal(await alta(ana,"ana",pedido("ana"),ida),a);
  assert.equal(await leer(admin,"pedidos/" + ida),undefined);
  assert.equal((await leer(admin,"contadores/personalizado")).n,51);
});

test("rechaza pagos directos inválidos y revierte contador, recibo, pedido y fotografías", async () => {
  const id = randomUUID(), foto = randomUUID();
  for (const datos of [{abonoMenor:-100},{abonoMenor:2100},{abono:0.21},{moneda:"EUR"},
    {precio:Infinity},{totalMenor:NaN},{totalMenor:2022.5},{totalMenor:1000},{items:[{cant:1.5}]},{precios:[{n:"Prenda",v:-2}]},{pagoVersion:1}]) {
    await assertFails(alta(ana,"ana",pedido("ana",datos),id));
  }
  await assertFails(cambiar(luis,"pedidos/publico",{abono:50,abonoMenor:5000}));
  await assertFails(alta(ana,"ana",pedido("ana",{imagenes:[foto]}),id,[{id:foto,data:"sin formato",mini:img}]));
  assert.equal((await leer(admin,"contadores/personalizado")).n,49);
  assert.equal(await leer(admin,"pedidos/" + id),undefined);
  assert.equal(await leer(ana,"usuarios/ana/envios/" + id),undefined);
  assert.equal(await leer(admin,"fotos/" + foto),undefined);
  const fotos = Array.from({length:12},() => ({id:randomUUID(),data:img,mini:img}));
  assert.equal(await alta(ana,"ana",pedido("ana",{imagenes:fotos.map(f => f.id)}),id,fotos),"P-0050");
  for (const f of fotos) assert.equal((await leer(luis,"fotos/" + f.id + "_m")).pedidoId,id);
});

test("verifica cada partida y el total de pedidos múltiples por API, y permite todavía la validación directa por bloque", async () => {
  const base = pedido("ana").items[0];
  const partida = (cant, precioMenor) => ({...base,cant,precioMenor});
  const items = [partida(3,1011), {...partida(5,213),prenda:"Short",horma:"Niño",talla:"6"}, partida(1,750)];
  const p = pedido("ana",{items,totalMenor:4848,abonoMenor:4800});
  const id = randomUUID();
  for (const alteracion of [
    {totalMenor:4849}, {abonoMenor:4849}, {abonoMenor:0.5},
    {items:[items[0],{...items[1],cant:5.5},items[2]]},
    {items:[items[0],items[1],{...items[2],precioMenor:-750}]},
    {items:[items[0],items[1],{...items[2],precioMenor:750.1}]},
    {items:[items[0],items[1],{...items[2],precioMenor:Infinity}]},
    {items:[items[0],items[1],{...items[2],precioMenor:0}]},
    {items:[items[0],null,items[2]],totalMenor:3783,abonoMenor:0},
    {items:[partida(10 ** 12, 10 ** 12)],totalMenor:200}
  ]) await assertFails(alta(ana,"ana",{...p,...alteracion},id));
  assert.equal(await assertSucceeds(alta(ana,"ana",p,id)),"P-0050");
  await assertFails(cambiar(luis,"pedidos/" + id,{totalMenor:1}));
  await assertFails(cambiar(luis,"pedidos/" + id,{abono:1}));
  await assertSucceeds(cambiar(luis,"pedidos/" + id,{items:[...items.slice(0,2),partida(2,750)],totalMenor:5598}));
  const partidasMaximas = Array.from({length:8}, () => partida(1,100));
  const max = pedido("ana",{items:partidasMaximas,totalMenor:8 * 100,abonoMenor:0});
  const fotos = Array.from({length:12}, () => ({id:randomUUID(),data:img,mini:img}));
  await assertFails(alta(ana,"ana",{...max,items:[...partidasMaximas.slice(0,-1),partida(1,-100)],totalMenor:(8 - 1) * 100}));
  const idMax = randomUUID();
  assert.equal(await assertSucceeds(alta(luis,"luis",{...max,creadoPor:"luis",lectores:["luis"],imagenes:fotos.map(f => f.id)},idMax,fotos))
    .catch(e => { throw new Error("Alta con el máximo de partidas y fotos", {cause:e}); }),"P-0051");
  await assertSucceeds(cambiar(admin,"usuarios/luis",{bloquear:true}));
  await assertSucceeds(cambiar(luis,"pedidos/" + idMax,{
    items:[partida(2,100), ...partidasMaximas.slice(1)],totalMenor:(8 + 1) * 100,editadoPor:"luis",
    revisar:true,revisarPor:"luis",revisarCambios:["Prendas"],publico:false,denegados:["ana"]
  }));
  assert.equal(await assertSucceeds(alta(ana,"ana",{...max,items:[partida(10 ** 12,1)],totalMenor:10 ** 12})),"P-0052");
});

test("valida los bloques de un pedido grande, reanuda el envío y consume el comprobante", async () => {
  const id = randomUUID(), rutaPago = `usuarios/ana/validacionesPago/${id}`;
  const base = pedido("ana").items[0];
  const items = Array.from({length:97}, (_, n) => ({
    ...base, cant:1 + n % 4, precioMenor:139 + n, nombre:"Prenda sintética " + n
  }));
  const suma = partidas => partidas.reduce((t, i) => t + i.cant * i.precioMenor, 0);
  const estado = partidas => ({pedidoId:id,alta:true,items:partidas,totalMenor:suma(partidas)});
  const parcial = items.slice(0,8);
  await assertFails(guardar(ana,rutaPago,estado(items.slice(0,9))));
  await assertFails(guardar(ana,rutaPago,{...estado(parcial),totalMenor:1}));
  await assertSucceeds(guardar(ana,rutaPago,estado(parcial)));
  await assertFails(leer(luis,rutaPago));
  await assertFails(guardar(luis,rutaPago,estado(items.slice(0,16))));
  await assertFails(guardar(ana,rutaPago,estado(items.slice(0,17))));
  await assertFails(guardar(ana,rutaPago,estado([{...items[0],cant:9}, ...items.slice(1,16)])));
  await assertFails(guardar(ana,rutaPago,estado([...parcial,{...items[8],precioMenor:-1}])));
  await assertFails(guardar(ana,rutaPago,estado([...parcial,{...items[8],cant:1.5}])));
  await assertFails(guardar(ana,rutaPago,{...estado(items.slice(0,16)),pedidoId:randomUUID()}));
  assert.equal((await leer(admin,"contadores/personalizado")).n,49);
  assert.equal(await leer(admin,"pedidos/" + id),undefined);

  const p = pedido("ana",{items,totalMenor:suma(items),abonoMenor:125,revisionPago:id});
  function confirmar(datos, consumir, uid = "ana", db = ana) {
    const batch = writeBatch(db);
    batch.set(doc(db,"contadores","personalizado"),{n:50,alineado:true,ultimoId:id});
    batch.set(doc(db,"pedidos",id),{...datos,codigo:"P-0050",consecutivo:50,creadorUid:uid});
    batch.set(doc(db,"usuarios",uid,"envios",id),{tipo:"personalizado",n:50,codigo:"P-0050"});
    if (consumir) batch.delete(doc(db,rutaPago));
    return batch.commit();
  }
  await assertFails(confirmar(p,true));
  const {ref} = await prepararValidacionPago(ana,sdk,"ana",id,id,p,doc(ana,"usuarios","ana","envios",id));
  assert.equal(ref.path,rutaPago);
  await assertFails(confirmar(p,false));
  await assertFails(confirmar({...p,revisionPago:randomUUID()},true));
  await assertFails(confirmar({...p,totalMenor:p.totalMenor + 1},true));
  await assertFails(confirmar({...p,abonoMenor:p.totalMenor + 1},true));
  await assertFails(confirmar({...p,items:[...items.slice(0,-1),{...items.at(-1),nombre:"Fila distinta"}]},true));
  await assertFails(confirmar({...p,creadoPor:"luis",lectores:["luis"]},false,"luis",luis));
  assert.equal((await leer(admin,"contadores/personalizado")).n,49);
  assert.equal(await leer(admin,"pedidos/" + id),undefined);
  const fotos = [{id:randomUUID(),data:img,mini:img}];
  assert.equal(await alta(ana,"ana",{...p,imagenes:[fotos[0].id]},id,fotos),"P-0050");
  const confirmado = await leer(luis,"pedidos/" + id);
  assert.deepEqual(confirmado.items,items);
  assert.equal(confirmado.totalMenor,p.totalMenor);
  assert.equal((await leer(luis,"fotos/" + fotos[0].id)).pedidoId,id);
  assert.equal(await leer(ana,rutaPago),undefined);
  await assertFails(guardar(ana,rutaPago,estado(parcial)));
  assert.equal(await alta(ana,"ana",p,id),"P-0050");
  assert.equal((await leer(admin,"contadores/personalizado")).n,50);

  const concurrente = randomUUID(), otra = pedido("ana",{items:items.slice(0,15),totalMenor:suma(items.slice(0,15))});
  assert.deepEqual(await Promise.all([
    alta(ana,"ana",otra,concurrente), alta(ana,"ana",otra,concurrente)
  ]),["P-0051","P-0051"]);
  assert.equal((await leer(admin,"contadores/personalizado")).n,51);
});

test("edita y restaura pedidos grandes con bloques verificados y mantiene el código histórico", async () => {
  const id = "pedido-historico-grande";
  const anterior = pedido("ana");
  const items = Array.from({length:24}, (_, n) => ({...anterior.items[0],cant:1,precioMenor:100 + n}));
  const totalMenor = items.reduce((t, i) => t + i.precioMenor, 0);
  const datos = {...anterior,items,totalMenor,codigo:"P-0012",restaurado:true};
  const revisionRestauracion = randomUUID();
  await assertFails(guardar(admin,"pedidos/" + id,datos));
  const importar = {id:revisionRestauracion,pedidoId:id,base:null,pedido:datos,fotos:[],restauracion:true};
  await confirmarEdicionGrande(admin,sdk,"admin",importar);
  const importado = await leer(admin,"pedidos/" + id);
  const otroRespaldo = {...datos,nota:"Nota actualizada desde respaldo",items:[...items,items[0]],totalMenor:totalMenor + 100};
  await confirmarEdicionGrande(admin,sdk,"admin",{...importar,id:randomUUID(),base:versionPedido(importado),pedido:otroRespaldo});
  assert.deepEqual((await leer(admin,"pedidos/" + id)).items,otroRespaldo.items);
  await assertSucceeds(cambiar(luis,"pedidos/" + id,{nota:"Nota conservada"}));
  const cambio = {items:[...items,{...items[0],cant:3}],totalMenor:totalMenor + 300,abonoMenor:150,editadoPor:"luis",
    editadoEn:"2026-11-25T12:01:05.000Z",pagoVersion:2,moneda:"USD"};
  const revision = randomUUID();
  await assertFails(cambiar(luis,"pedidos/" + id,{...cambio,revisionPago:revision}));
  const base = versionPedido(await leer(luis,"pedidos/" + id));
  const guardarEdicion = {id:revision,pedidoId:id,uid:"luis",base,pedido:cambio,fotos:[]};
  await confirmarEdicionGrande(luis,sdk,"luis",guardarEdicion);
  await confirmarEdicionGrande(luis,sdk,"luis",guardarEdicion);
  assert.equal(await leer(luis,`usuarios/luis/validacionesPago/${revision}`),undefined);
  const final = await leer(ana,"pedidos/" + id);
  assert.equal(final.codigo,"P-0012");
  assert.equal(final.totalMenor,cambio.totalMenor);
  assert.equal(final.abonoMenor,150);
  assert.deepEqual(final.items,cambio.items);
});

test("protege un pedido grande contra una edición simultánea y un formulario antiguo", async () => {
  const id = randomUUID(), rutaPedido = "pedidos/" + id;
  const items = Array.from({length:30}, () => ({...pedido("ana").items[0],cant:1,precioMenor:100}));
  await alta(ana,"ana",pedido("ana",{items,totalMenor:3000}),id);
  const original = await leer(luis,rutaPedido);
  const base = versionPedido(original);
  const desde = (uid, precioMenor) => ({id:randomUUID(),pedidoId:id,uid,base,fotos:[],pedido:{
    pagoVersion:2,moneda:"USD",abonoMenor:25,items:items.map(i => ({...i,precioMenor})),totalMenor:30 * precioMenor,editadoPor:uid,
    editadoEn:"2026-11-25T12:01:05.000Z"
  }});
  const a = desde("ana",110), b = desde("luis",150);
  const resultados = await Promise.allSettled([confirmarEdicionGrande(ana,sdk,"ana",a),confirmarEdicionGrande(luis,sdk,"luis",b)]);
  assert.equal(resultados.filter(r => r.status === "fulfilled").length,1);
  assert.equal(resultados.find(r => r.status === "rejected")?.reason.code,"conflicto-pedido");
  const vigente = await leer(ana,rutaPedido);
  assert.equal(vigente.items.length,30);
  assert.equal(vigente.totalMenor,vigente.items.reduce((s,i) => s + i.cant * i.precioMenor,0));
  assert.equal(vigente.autorAviso.uid,vigente.editadoPor);
  await assertFails(cambiar(luis,rutaPedido,{items:items.slice(0,8),totalMenor:800,editadoPor:"luis"}));
  await assertSucceeds(cambiar(luis,rutaPedido,{estado:"listo",listoPor:"luis",autorAviso:{uid:"luis",en:serverTimestamp()}}));
  assert.equal((await leer(ana,rutaPedido)).totalMenor,vigente.totalMenor);
  const reducir = {...b,id:randomUUID(),base:versionPedido(await leer(luis,rutaPedido)),
    pedido:{...b.pedido,items:items.slice(0,8),totalMenor:800}};
  await confirmarEdicionGrande(luis,sdk,"luis",reducir);
  assert.equal((await leer(ana,rutaPedido)).items.length,8);
  await assertSucceeds(cambiar(luis,rutaPedido,{items:items.slice(0,2),totalMenor:200,editadoPor:"luis"}));
});

test("reanuda una edición interrumpida tras el primer bloque sin duplicar la escritura", async () => {
  const id = randomUUID(), rutaPedido = "pedidos/" + id;
  const items = Array.from({length:20}, () => ({...pedido("ana").items[0],cant:1,precioMenor:100}));
  await alta(ana,"ana",pedido("ana",{items,totalMenor:2000}),id);
  const anterior = await leer(luis,rutaPedido);
  const datos = {id:randomUUID(),pedidoId:id,uid:"luis",base:versionPedido(anterior),fotos:[],
    pedido:{items:[...items,items[0]],totalMenor:2100,abonoMenor:50,moneda:"USD",pagoVersion:2,editadoPor:"luis",editadoEn:"2026-11-25T12:02:05.000Z"}};
  const corte = {...sdk,runTransaction:async (...args) => {
    await runTransaction(...args);
    await disableNetwork(luis);
    throw Object.assign(new Error("Conexión interrumpida"),{code:"unavailable"});
  }};
  try {
    await assert.rejects(confirmarEdicionGrande(luis,corte,"luis",datos),{code:"unavailable"});
    assert.equal((await leer(admin,rutaPedido)).totalMenor,2000);
  } finally { await enableNetwork(luis); }
  const comprobante = `usuarios/luis/validacionesPago/${datos.id}`;
  assert.equal((await leer(luis,comprobante)).items.length,8);
  await confirmarEdicionGrande(luis,sdk,"luis",datos);
  const guardado = await leer(ana,rutaPedido);
  assert.equal(guardado.totalMenor,2100);
  assert.equal(guardado.abonoMenor,50);
  assert.equal(guardado.items.length,21);
  await confirmarEdicionGrande(luis,sdk,"luis",datos);
  assert.equal((await leer(ana,rutaPedido)).autorAviso.en.isEqual(guardado.autorAviso.en),true);
  assert.equal(await leer(luis,comprobante),undefined);
});

test("traslada los recibos y la cola al restablecer el PIN y separa a otras cuentas", async () => {
  const transferir = (origen, destino, identidadCola) => {
    const batch = writeBatch(admin);
    batch.set(doc(admin,"usuarios",destino),perfil("ana",{bloquear:true,identidadCola}));
    batch.delete(doc(admin,"usuarios",origen));
    batch.set(doc(admin,"logins","ana"),{uid:destino,email:"ana-nueva@example.test"});
    return batch.commit();
  };
  const previo = randomUUID();
  assert.equal(await alta(ana,"ana",pedido("ana"),previo),"P-0050");
  const grandeId = randomUUID(), rutaGrande = `usuarios/ana/validacionesPago/${grandeId}`;
  const partida = {...pedido("ana").items[0],cant:1,precioMenor:100};
  const grande = pedido("ana",{items:Array.from({length:12}, () => partida),totalMenor:1200});
  await assertSucceeds(guardar(ana,rutaGrande,{pedidoId:grandeId,alta:true,items:grande.items.slice(0,8),totalMenor:800}));
  await assertFails(cambiar(admin,"usuarios/luis",{identidadCola:"ana"}));
  await assertFails(guardar(admin,"usuarios/impostor",perfil("otro",{identidadCola:"ana"})));
  await assertFails(transferir("ana","anaNueva","luis"));
  await assertSucceeds(transferir("ana","anaNueva","ana"));
  const nueva = env.authenticatedContext("anaNueva").firestore();
  await assertFails(leer(ana,"usuarios/ana/envios/" + previo));
  await assertFails(leer(luis,"usuarios/ana/envios/" + previo));
  assert.equal(await alta(nueva,"anaNueva",pedido("ana"),previo,[],"ana"),"P-0050");
  const pendiente = randomUUID();
  const foto = {id:randomUUID(),data:img,mini:img};
  assert.equal(await alta(nueva,"anaNueva",pedido("ana",{imagenes:[foto.id]}),pendiente,[foto],"ana"),"P-0051");
  assert.equal((await leer(admin,"pedidos/" + pendiente)).creadorUid,"anaNueva");
  await assertFails(leer(ana,rutaGrande));
  assert.equal(await alta(nueva,"anaNueva",grande,grandeId,[],"ana"),"P-0052");
  assert.equal(await leer(nueva,rutaGrande),undefined);
  await assertSucceeds(transferir("anaNueva","anaFinal","ana"));
  const final = env.authenticatedContext("anaFinal").firestore();
  await assertFails(leer(nueva,"usuarios/ana/envios/" + pendiente));
  assert.equal(await alta(final,"anaFinal",pedido("ana"),pendiente,[],"ana"),"P-0051");
  assert.equal((await leer(final,"fotos/" + foto.id)).pedidoId,pendiente);
});

test("mantiene arranque único, alta de equipo y reemplazo del UID al cambiar PIN", async () => {
  await env.clearFirestore();
  const correo = "dueño@example.test";
  const nuevo = env.authenticatedContext("dueno",{email:correo}).firestore();
  const boot = writeBatch(nuevo);
  boot.set(doc(nuevo,"sistema","estado"),{iniciado:true,iniciadoPor:"dueno",creadoEn:"2026-01-01"});
  boot.set(doc(nuevo,"usuarios","dueno"),perfil("dueno",{rol:"admin"}));
  boot.set(doc(nuevo,"logins","dueno"),{uid:"dueno",email:correo});
  await assertSucceeds(boot.commit());
  await assertFails(borrar(nuevo,"sistema/estado"));
  await assertFails(guardar(ana,"sistema/estado",{iniciado:true,iniciadoPor:"ana",creadoEn:"2026-01-01"}));
  const altaEquipo = writeBatch(nuevo);
  altaEquipo.set(doc(nuevo,"usuarios","empleado"),perfil("equipo"));
  altaEquipo.set(doc(nuevo,"logins","equipo"),{uid:"empleado",email:"equipo@example.test"});
  await assertSucceeds(altaEquipo.commit());
  const reset = writeBatch(nuevo);
  reset.set(doc(nuevo,"usuarios","nuevoUid"),perfil("equipo",{identidadCola:"empleado"}));
  reset.delete(doc(nuevo,"usuarios","empleado"));
  reset.set(doc(nuevo,"logins","equipo"),{uid:"nuevoUid",email:"equipo2@example.test"});
  await assertSucceeds(reset.commit());
  assert.equal((await leer(anon,"logins/equipo")).uid,"nuevoUid");
  await assertFails(leer(env.authenticatedContext("empleado").firestore(),"config/ajustes"));
  await assertSucceeds(leer(env.authenticatedContext("nuevoUid").firestore(),"config/ajustes"));
});

test("conserva las operaciones administrativas de demostración y respaldo histórico", async () => {
  const viejo = {tipo:"personalizado", codigo:"P-0040", creadoEn:"2024-01-01", creadoPor:"ana",
    publico:true, lectores:["ana"], cliente:{nombre:"Prueba histórica",telefono:"580000000000"},
    items:[{prenda:"Franela",color:"Negro",talla:"M",cant:1}], precio:10, moneda:"COP", abono:12};
  await assertFails(guardar(ana,"pedidos/archivo",{...viejo,restaurado:true}));
  await assertSucceeds(guardar(admin,"pedidos/archivo",{...viejo,restaurado:true}));
  await assertSucceeds(cambiar(luis,"pedidos/archivo",{estado:"listo",listoPor:"luis"}));
  await assertFails(cambiar(luis,"pedidos/archivo",{abono:9}));
  const restaurado = await leer(admin,"pedidos/archivo");
  assert.equal(restaurado.codigo,"P-0040");
  assert.equal(restaurado.abono,12);
  await assertSucceeds(guardar(admin,"pedidos/demo",{...pedido("admin"),demo:true,codigo:"P-T001"}));
  await assertFails(guardar(ana,"pedidos/falso",{...pedido("ana"),demo:true,codigo:"P-T002"}));
  await assertSucceeds(borrar(admin,"pedidos/demo"));
});

test("las preferencias y tokens de avisos pertenecen exclusivamente al usuario activo", async () => {
  const preferencias = "usuarios/ana/preferencias/notificaciones";
  const dispositivo = "usuarios/ana/dispositivos/" + randomUUID();
  const valores = {ediciones:true,nuevos:false,estado:true};
  const token = "fcm-demo-" + "x".repeat(40);
  await assertSucceeds(guardar(ana,preferencias,valores));
  await assertSucceeds(guardar(ana,dispositivo,{token,renovadoEn:serverTimestamp()}));
  assert.deepEqual(await assertSucceeds(leer(ana,preferencias)),valores);
  assert.equal((await assertSucceeds(leer(ana,dispositivo))).token,token);
  for (const otro of [luis,admin,anon,inactivo]) {
    await assertFails(leer(otro,preferencias));
    await assertFails(leer(otro,dispositivo));
    await assertFails(guardar(otro,preferencias,valores));
    await assertFails(borrar(otro,dispositivo));
  }
  await assertFails(guardar(ana,preferencias,{...valores,nuevos:"sí"}));
  await assertFails(guardar(ana,preferencias,{...valores,vence:true}));
  await assertFails(guardar(ana,dispositivo,{token,renovadoEn:new Date(0)}));
  await assertFails(guardar(ana,dispositivo,{token:"corto",renovadoEn:serverTimestamp()}));
  await assertFails(getDocs(collection(admin,"usuarios/ana/dispositivos")));
  await assertSucceeds(cambiar(admin,"usuarios/ana",{activo:false}));
  await assertFails(leer(ana,dispositivo));
  await assertFails(guardar(ana,preferencias,valores));
  await assertSucceeds(borrar(ana,dispositivo));
  await assertFails(guardar(admin,"notificacionesEventos/evento",{expiraEn:serverTimestamp()}));
});

test("Firestore atestigua UID y hora para los avisos de edición", async () => {
  const ruta = "pedidos/publico";
  await assertFails(cambiar(ana,ruta,{autorAviso:{uid:"admin",en:serverTimestamp()},nota:"Suplantación"}));
  await assertFails(cambiar(admin,ruta,{autorAviso:{uid:"ana",en:serverTimestamp()},nota:"Suplantación por admin"}));
  await assertFails(cambiar(ana,ruta,{autorAviso:{uid:"ana",en:new Date(0)},nota:"Hora antigua"}));
  await assertFails(cambiar(ana,ruta,{autorAviso:{uid:"ana",en:serverTimestamp(),token:"otro"}}));
  await assertSucceeds(cambiar(ana,ruta,{autorAviso:{uid:"ana",en:serverTimestamp()},nota:"Edición real"}));
  assert.equal((await leer(ana,ruta)).autorAviso.uid,"ana");
  await assertSucceeds(cambiar(luis,ruta,{nota:"Cliente anterior"}));
  assert.equal((await leer(ana,ruta)).autorAviso.uid,"ana");
});
