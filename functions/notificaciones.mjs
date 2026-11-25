import {isDeepStrictEqual} from "node:util";

const camposPedido = [
  "cliente","tema","servicio","servicios","prendaDe","etiqueta","items","fechaEntrega","moneda",
  "precio","precios","abono","pagoVersion","totalMenor","abonoMenor","motivoSinAbono","urgente","imagenes","nota"
];

export function clasesDeCambio(antes, despues) {
  if (!despues || despues.demo || antes?.demo) return [];
  if (!antes) return despues.restaurado ? [] : ["nuevos"];
  if (despues.restaurado && !antes.restaurado) return [];
  const clases = [];
  if ((antes.estado || "pendiente") !== (despues.estado || "pendiente")) clases.push("estado");
  if (camposPedido.some(k => !isDeepStrictEqual(antes[k],despues[k]))) clases.push("ediciones");
  return clases;
}

export function puedeNotificar(perfil, pedido) {
  if (perfil?.activo !== true || !pedido) return false;
  if (perfil.rol === "admin") return true;
  if (perfil.rol !== "empleado" || !perfil.usuario) return false;
  const tipo = pedido.tipo === "personalizado" ? "verPersonalizado" : pedido.tipo === "sublimacion" ? "verSublimacion" : null;
  if (!tipo || perfil[tipo] !== true) return false;
  // Mantener la misma visibilidad de pedidos que puedeVerEmpleado en firestore.rules.
  return (pedido.publico === true && perfil.soloAsignados !== true)
    || (Array.isArray(pedido.lectores) && pedido.lectores.includes(perfil.usuario));
}

const uidValido = uid => typeof uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(uid);

export function identidadDelEvento({authId,authType,antes,despues}) {
  if (["system","service_account","unauthenticated"].includes(authType)) return null;
  // Rules exige UID y hora del servidor al cambiar el sello. La versión anterior
  // permite descartar un sello conservado por una escritura que no lo renovó.
  if (antes && isDeepStrictEqual(antes.autorAviso,despues?.autorAviso)) return null;
  const uid = antes ? despues?.autorAviso?.uid : despues?.creadorUid;
  if (!uidValido(uid)) return null;
  // Si Eventarc entrega el UID, debe concordar con el UID atestiguado por Rules.
  if (authType !== "api_key" && uidValido(authId) && authId !== uid) return null;
  return uid;
}

export function opcionesActivas(perfil, preferencias) {
  return preferencias ?? {ediciones:perfil.rol === "admin",nuevos:false,estado:false};
}

export function mensajePedido(pedido, actor, clase, uid, dispositivo, evento, pedidoId) {
  const codigo = /^[SP]-\d{4,16}$/.test(pedido.codigo) ? `Pedido ${pedido.codigo}` : "Pedido";
  const nombre = String(actor.nombre || actor.usuario || "Un compañero").trim().replace(/\s+/g," ").slice(0,55);
  const titulos = {ediciones:`${codigo} actualizado`,estado:`${codigo} cambió de estado`,nuevos:`${codigo} registrado`};
  const textos = {ediciones:"modificó un pedido",estado:"cambió el estado de un pedido",nuevos:"registró un pedido"};
  return {app:"pedidos",uid,dispositivo,evento,pedidoId,titulo:titulos[clase],cuerpo:`${nombre} ${textos[clase]}.`};
}

export async function notificarCambio(evento, deps) {
  const clases = clasesDeCambio(evento.antes,evento.despues);
  if (!clases.length) return;
  const actorUid = identidadDelEvento(evento);
  if (!actorUid) return;
  const [actor,actual] = await Promise.all([deps.perfil(actorUid),deps.pedido(evento.pedidoId)]);
  if (!puedeNotificar(actor,actual) || actual.demo) return;
  if (!await deps.reservar(evento.id,actorUid)) return;
  const equipo = await deps.equipoActivo();
  const resultados = await Promise.allSettled(equipo.filter(u => u.uid !== actorUid && puedeNotificar(u.perfil,actual)).map(async u => {
    const [preferencias,dispositivos] = await Promise.all([deps.preferencias(u.uid),deps.dispositivos(u.uid)]);
    const permitidas = opcionesActivas(u.perfil,preferencias);
    const clase = clases.find(c => permitidas[c] === true);
    if (!clase || !dispositivos.length) return;
    const [vigilado,perfil,recientes] = await Promise.all([deps.pedido(evento.pedidoId),deps.perfil(u.uid),deps.preferencias(u.uid)]);
    if (!puedeNotificar(perfil,vigilado) || vigilado.demo || opcionesActivas(perfil,recientes)[clase] !== true) return;
    await deps.enviar(u.uid,dispositivos,d => mensajePedido(vigilado,actor,clase,u.uid,d.id,evento.id,evento.pedidoId));
  }));
  const fallos = resultados.filter(r => r.status === "rejected");
  if (fallos.length) throw fallos[0].reason;
}

export const tokenInvalidado = codigo => [
  "messaging/registration-token-not-registered","messaging/invalid-registration-token"
].includes(codigo);

export async function procesarEntregas(dispositivos,respuestas,retirar) {
  const errores = [];
  await Promise.all(respuestas.map(async (r,i) => {
    if (r.success) return;
    const codigo = r.error?.code || "desconocido";
    errores.push(codigo);
    if (tokenInvalidado(codigo)) await retirar(dispositivos[i]);
  }));
  return errores;
}
