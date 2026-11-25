import { createHash, randomUUID } from "node:crypto";
import {initializeApp} from "firebase-admin/app";
import {getFirestore,Timestamp} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";
import {logger} from "firebase-functions";
import {onDocumentWrittenWithAuthContext} from "firebase-functions/v2/firestore";
import {HttpsError,onCall} from "firebase-functions/v2/https";
import {notificarCambio,procesarEntregas} from "./notificaciones.mjs";

initializeApp();
const db = getFirestore();
const region = "us-central1";
const usuario = uid => db.collection("usuarios").doc(uid);
const dia = 86400000;
const limiteDispositivos = 20;
const opciones = {region,maxInstances:3,timeoutSeconds:60};
const versionFirestore = snap => snap?.exists ? snap.data() : null;

async function reservar(evento,uid) {
  const id = createHash("sha256").update(evento).digest("hex");
  const marca = db.collection("notificacionesEventos").doc(id);
  const cuota = db.collection("notificacionesCuotas").doc(uid);
  return db.runTransaction(async tx => {
    const [procesado, anterior] = await tx.getAll(marca,cuota);
    if (procesado.exists) return false;
    const minuto = Math.floor(Date.now()/60000), previa = anterior.data();
    const total = previa?.minuto === minuto ? previa.total : 0;
    if (total >= 30) return false;
    tx.create(marca,{expiraEn:Timestamp.fromMillis(Date.now()+7*dia)});
    tx.set(cuota,{minuto,total:total+1});
    return true;
  });
}

async function borrarSiCoincide(uid,d) {
  const ref = usuario(uid).collection("dispositivos").doc(d.id);
  await db.runTransaction(async tx => {
    const actual = (await tx.get(ref)).data();
    if (actual?.token === d.token && actual.renovadoEn?.isEqual(d.renovadoEn)) tx.delete(ref);
  });
}

async function enviar(uid,dispositivos,crearDatos) {
  // Los tokens son secretos de entrega. Se omiten de todos los registros.
  const mensajes = dispositivos.map(d => ({
    token:d.token,data:crearDatos(d),webpush:{headers:{TTL:"86400",Urgency:"high"}}
  }));
  const lote = await getMessaging().sendEach(mensajes);
  const errores = await procesarEntregas(dispositivos,lote.responses,d => borrarSiCoincide(uid,d));
  if (errores.length) logger.warn("Entregas FCM rechazadas",{codigos:errores});
  return lote.successCount;
}

async function dispositivos(uid) {
  const docs = await usuario(uid).collection("dispositivos").orderBy("renovadoEn","desc").limit(limiteDispositivos).get();
  const limite = Date.now()-45*dia;
  const vigentes = [];
  await Promise.all(docs.docs.map(async snap => {
    const d = {...snap.data(),id:snap.id};
    if (d.renovadoEn?.toMillis() >= limite) vigentes.push(d);
    else await borrarSiCoincide(uid,d);
  }));
  return vigentes;
}

export const avisosDePedidos = onDocumentWrittenWithAuthContext({...opciones,document:"pedidos/{pedidoId}"},async event => {
  const antes = versionFirestore(event.data?.before), despues = versionFirestore(event.data?.after);
  try {
    await notificarCambio({
      id:event.id,pedidoId:event.params.pedidoId,authId:event.authId,authType:event.authType,antes,despues
    },{
      perfil:async uid => versionFirestore(await usuario(uid).get()),
      pedido:async id => versionFirestore(await db.collection("pedidos").doc(id).get()),
      equipoActivo:async () => (await db.collection("usuarios").where("activo","==",true).get()).docs.map(d => ({uid:d.id,perfil:d.data()})),
      preferencias:async uid => versionFirestore(await usuario(uid).collection("preferencias").doc("notificaciones").get()),
      dispositivos,reservar,enviar
    });
  } catch (e) { logger.error("No se pudo procesar el aviso",{evento:event.id,codigo:e.code || "error"}); }
});

export const probarNotificacion = onCall(opciones,async req => {
  const uid = req.auth?.uid, id = req.data?.dispositivo;
  if (!uid) throw new HttpsError("unauthenticated","Inicia sesión para probar los avisos.");
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new HttpsError("invalid-argument","Dispositivo inválido.");
  const ref = usuario(uid).collection("dispositivos").doc(id);
  const cuota = db.collection("notificacionesPruebas").doc(uid);
  const d = await db.runTransaction(async tx => {
    const [perfil,dispositivo,ultimo] = await tx.getAll(usuario(uid),ref,cuota);
    if (perfil.data()?.activo !== true || !dispositivo.exists) throw new HttpsError("permission-denied","Dispositivo no disponible.");
    const datos = dispositivo.data();
    if (!(datos.renovadoEn?.toMillis() >= Date.now()-45*dia))
      throw new HttpsError("failed-precondition","Vuelve a activar este dispositivo.");
    if ((ultimo.data()?.ms || 0)+60000 > Date.now()) throw new HttpsError("resource-exhausted","Espera un minuto entre pruebas.");
    tx.set(cuota,{ms:Date.now()});
    return {...datos,id};
  });
  const n = await enviar(uid,[d],() => ({
    app:"pedidos",uid,dispositivo:id,evento:randomUUID(),titulo:"Notificación de prueba",cuerpo:"Los avisos de Pedidos están activados en este dispositivo."
  }));
  if (!n) throw new HttpsError("failed-precondition","Firebase rechazó este dispositivo. Vuelve a activarlo.");
  return {solicitada:true};
});
