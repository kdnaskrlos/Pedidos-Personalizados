export const MAX_CENTAVOS = 1_000_000_000_000;
export const MAX_PARTIDAS = 8;
const MONEDAS = new Set(["COP", "USD", "Bs"]);

function leerCentavos(valor, maximo) {
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  const texto = String(valor).trim();
  const agrupado = typeof valor === "string" && /^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(texto);
  const normal = (agrupado ? texto.replaceAll(".", "") : texto).replace(",", ".");
  const partes = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normal);
  if (!partes) return null;
  const importe = Number(partes[2]) * 100 + Number((partes[3] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(importe) || importe > maximo) return null;
  return partes[1] && importe ? -importe : importe;
}

export const centavos = valor => leerCentavos(valor, MAX_CENTAVOS);

export function centavosHistoricos(valor) {
  const exacto = leerCentavos(valor, Number.MAX_SAFE_INTEGER);
  if (exacto !== null) return exacto;
  // Algunos pedidos anteriores ya se guardaron como números con más de dos decimales.
  return typeof valor === "number" && Number.isFinite(valor) && Math.abs(valor) <= Number.MAX_SAFE_INTEGER / 100
    ? Math.sign(valor) * Math.round(Math.abs(valor) * 100) : 0;
}

export function cantidad(valor) {
  if (typeof valor === "string" && !/^\d+$/.test(valor.trim())) return null;
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function clavePrecio(item, tallasPlus = [], precios = []) {
  if (!item.prenda) return "";
  const horma = /^niñ[oa]s?$/i.test(String(item.horma || "").trim()) ? "Niño/Niña" : item.horma;
  const base = [item.prenda, horma].filter(Boolean).join(" · ");
  const talla = String(item.talla || "").trim();
  const completa = [base, talla].filter(Boolean).join(" · ");
  const plus = /^(?:(?:[2-9]|[1-9]\d+)\s*XL|X{2,}L)$/i.test(talla);
  return plus || tallasPlus.includes(talla) || precios.some(p => p.n === completa) ? completa : base;
}

export function valorPrecioHistorico(pedido, clave) {
  const partes = clave.split(" · ");
  const precios = Array.isArray(pedido.precios) ? pedido.precios : [];
  for (let n = partes.length; n > 0; n--) {
    const k = partes.slice(0, n).join(" · ");
    const equivalentes = k.includes("Niño/Niña")
      ? [k, k.replace("Niño/Niña", "Niño"), k.replace("Niño/Niña", "Niña")] : [k];
    const precio = precios.find(p => equivalentes.includes(p.n));
    if (precio) return precio.v;
  }
  return pedido.precio;
}

export function precioHistorico(pedido, clave) {
  return centavosHistoricos(valorPrecioHistorico(pedido, clave));
}

export function validarPago(items, precio, abono, moneda, limite = MAX_PARTIDAS) {
  return calcularPago(items, i => centavos(precio(i)), typeof abono === "string" && !abono.trim() ? 0 : centavos(abono), moneda, limite);
}

export function validarPagoEnCentavos(items, abonoMenor, moneda) {
  return calcularPago(items, i => i.precioMenor, abonoMenor, moneda);
}

function calcularPago(items, precioMenor, abono, moneda, limite = MAX_PARTIDAS) {
  if (!MONEDAS.has(moneda)) return {error:"moneda"};
  if (!items.length) return {error:"precio"};
  if (items.length > limite) return {error:"partidas"};
  let total = 0, piezas = 0;
  for (const item of items) {
    const unidades = cantidad(item.cant);
    if (unidades === null) return {error:"cantidad"};
    const unitario = precioMenor(item);
    if (!Number.isSafeInteger(unitario) || unitario <= 0 || unitario > MAX_CENTAVOS) return {error:"precio"};
    piezas += unidades;
    total += unidades * unitario;
    if (!Number.isSafeInteger(piezas) || !Number.isSafeInteger(total) || total > MAX_CENTAVOS)
      return {error:"total"};
  }
  if (!Number.isSafeInteger(abono) || abono < 0) return {error:"abono"};
  if (abono > total) return {error:"sobrepago"};
  return {piezas, total, abono, saldo:total - abono};
}

export function actualizarPagoPendiente(pedido, clave) {
  if (pedido.pagoVersion !== 1) return pedido;
  const {precio, precios, abono, ...migrado} = pedido;
  const items = pedido.items.map(i => ({...i, precioMenor:precioHistorico(pedido, clave(i))}));
  const pago = validarPagoEnCentavos(items, migrado.abonoMenor, migrado.moneda);
  if (pago.error || pago.total !== migrado.totalMenor || centavos(abono) !== migrado.abonoMenor) {
    throw Object.assign(new Error("El pago pendiente requiere revisión"), {code:"pago-pendiente"});
  }
  return {...migrado, items, pagoVersion:2};
}
