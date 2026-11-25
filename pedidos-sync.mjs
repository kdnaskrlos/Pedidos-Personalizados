const PREFIJOS = {personalizado:"P", sublimacion:"S"};

export function consecutivoDe(tipo, codigo) {
  if (!Object.hasOwn(PREFIJOS, tipo)) return null;
  const texto = String(codigo ?? "");
  if (!new RegExp(`^${PREFIJOS[tipo]}-\\d{4,}$`).test(texto)) return null;
  const n = Number(texto.slice(2));
  if (!Number.isSafeInteger(n)) throw new Error("Hay un código histórico fuera del intervalo admitido");
  return n;
}

export function documentosFoto(pedidoId, fotos, por, creadoEn) {
  return fotos.flatMap(({id, data, mini}) => {
    const vinculo = {pedidoId, baseId:id, por, creadoEn};
    return [[id, {...vinculo, data, mini:false}], [id + "_m", {...vinculo, data:mini, mini:true}]];
  });
}

const PARTIDAS_POR_BLOQUE = 8;
export const necesitaValidacionPago = p => p.pagoVersion === 2 && p.items.length > PARTIDAS_POR_BLOQUE;

// Margen para el documento de Firestore y el evento con ambas versiones del pedido.
export function pedidoCabe(pedido) {
  const utf8 = new TextEncoder();
  const bytes = valor => {
    if (typeof valor === "string") return utf8.encode(valor).length + 1;
    if (Array.isArray(valor)) return valor.reduce((suma, item) => suma + bytes(item), 0);
    if (valor && typeof valor === "object")
      return Object.entries(valor).reduce((suma, [key, item]) => suma + bytes(key) + bytes(item), 32);
    return 8;
  };
  return bytes(pedido) <= 96 * 1024;
}

function bloqueDePago(pedidoId, alta, items, anterior) {
  const inicio = anterior?.items.length ?? 0;
  const fin = Math.min(inicio + PARTIDAS_POR_BLOQUE, items.length);
  let totalMenor = anterior?.totalMenor ?? 0;
  for (const {cant, precioMenor} of items.slice(inicio, fin)) totalMenor += cant * precioMenor;
  return {pedidoId, alta, totalMenor, items:items.slice(0, fin)};
}
const rutaPago = (doc, db, identidad, revision) => doc(db, "usuarios", identidad, "validacionesPago", revision);

export async function prepararValidacionPago(db, {doc, getDocFromServer, runTransaction}, identidad, pedidoId, revision, pedido, envio = null) {
  const ref = rutaPago(doc, db, identidad, revision);
  const alta = envio !== null;

  for (;;) {
    let inicio;
    try {
      const resultado = await runTransaction(db, async tx => {
        if (envio) {
          const recibo = await tx.get(envio);
          if (recibo.exists()) return {codigo:recibo.data().codigo};
        }
        const anterior = (await tx.get(ref)).data();
        inicio = anterior?.items.length ?? 0;
        if (anterior && (anterior.pedidoId !== pedidoId || anterior.alta !== alta || inicio > pedido.items.length)) {
          throw Object.assign(new Error("La validación del pago no coincide con el pedido"), {code:"pago-pendiente"});
        }
        if (inicio === pedido.items.length) return {ref};
        const parcial = bloqueDePago(pedidoId, alta, pedido.items, anterior);
        tx.set(ref, parcial);
        return parcial.items.length === pedido.items.length ? {ref} : null;
      });
      if (resultado) return resultado;
    } catch (error) {
      if (error.code !== "permission-denied" || inicio === undefined) throw error;
      // Una segunda pestaña puede haber confirmado el bloque o el pedido mientras se escribía.
      const actual = await getDocFromServer(ref).catch(() => null);
      if ((actual?.data()?.items.length ?? 0) > inicio) continue;
      if (envio) {
        const recibo = await getDocFromServer(envio).catch(() => null);
        if (recibo?.exists()) return {codigo:recibo.data().codigo};
      }
      throw error;
    }
  }
}

// Las ediciones encolan los bloques antes del lote final en el mismo cliente de Firestore.
export function encolarValidacionPago(db, {doc, setDoc}, identidad, pedidoId, revision, pedido) {
  const ref = rutaPago(doc, db, identidad, revision);
  const escrituras = [];
  let parcial;
  while (!parcial || parcial.items.length < pedido.items.length) {
    parcial = bloqueDePago(pedidoId, false, pedido.items, parcial);
    escrituras.push(setDoc(ref, parcial));
  }
  return {ref, escrituras};
}

export async function registrarPedido(db, {doc, getDocFromServer, runTransaction}, uid, {id, pedido, fotos}, identidad = uid, normalizar = p => p) {
  const envio = doc(db, "usuarios", identidad, "envios", id);
  const destino = doc(db, "pedidos", id);
  const contador = doc(db, "contadores", pedido.tipo);
  let validacion, datosPreparados;
  if (pedido.items?.length > PARTIDAS_POR_BLOQUE) {
    const recibo = await getDocFromServer(envio);
    if (recibo.exists()) return recibo.data().codigo;
    datosPreparados = normalizar(pedido);
    const resultado = await prepararValidacionPago(db, {doc, getDocFromServer, runTransaction}, identidad, id, id, datosPreparados, envio);
    if (resultado.codigo) return resultado.codigo;
    validacion = resultado.ref;
    datosPreparados = {...datosPreparados, revisionPago:id};
  }

  for (let intento = 0; intento < 4; intento++) {
    let reservado;
    try {
      return await runTransaction(db, async tx => {
        const recibo = await tx.get(envio);
        if (recibo.exists()) return recibo.data().codigo;

        const datos = datosPreparados ?? normalizar(pedido);
        const estado = (await tx.get(contador)).data();
        if (estado?.alineado !== true || !Number.isSafeInteger(estado.n) || estado.n < 0) {
          throw Object.assign(new Error("Falta alinear los contadores"), {code:"contador-pendiente"});
        }
        const n = estado.n + 1;
        if (!Number.isSafeInteger(n))
          throw Object.assign(new Error("Se agotó el intervalo de numeración"), {code:"contador-agotado"});
        reservado = n;
        const codigo = PREFIJOS[pedido.tipo] + "-" + String(n).padStart(4, "0");
        tx.set(contador, {n, alineado:true, ultimoId:id});
        tx.set(destino, {...datos, codigo, consecutivo:n, creadorUid:uid});
        tx.set(envio, {tipo:pedido.tipo, codigo, n});
        if (validacion) tx.delete(validacion);
        for (const [fotoId, foto] of documentosFoto(id, fotos, pedido.creadoPor, pedido.creadoEn))
          tx.set(doc(db, "fotos", fotoId), foto);
        return codigo;
      });
    } catch (error) {
      if (error.code !== "permission-denied" || reservado === undefined) throw error;
      // El emulador puede evaluar las reglas contra un contador que avanzó antes de
      // devolver el error de concurrencia. Solo reintentamos si el servidor lo confirma.
      const snapshot = await getDocFromServer(contador).catch(() => null);
      if (!(snapshot?.data()?.n >= reservado)) throw error;
    }
  }
  throw Object.assign(new Error("El contador sigue ocupado"), {code:"contencion"});
}
