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

export async function registrarPedido(db, {doc, getDocFromServer, runTransaction}, uid, {id, pedido, fotos}) {
  const envio = doc(db, "usuarios", uid, "envios", id);
  const destino = doc(db, "pedidos", id);
  const contador = doc(db, "contadores", pedido.tipo);

  for (let intento = 0; intento < 4; intento++) {
    let reservado;
    try {
      return await runTransaction(db, async tx => {
        const recibo = await tx.get(envio);
        if (recibo.exists()) return recibo.data().codigo;

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
        tx.set(destino, {...pedido, codigo, consecutivo:n, creadorUid:uid});
        tx.set(envio, {tipo:pedido.tipo, codigo, n});
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
