export const MAX_CENTAVOS = 1_000_000_000_000;
const MONEDAS = new Set(["COP", "USD", "Bs"]);

export function centavos(valor) {
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  const texto = String(valor).trim();
  const agrupado = typeof valor === "string" && /^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(texto);
  const normal = (agrupado ? texto.replaceAll(".", "") : texto).replace(",", ".");
  const partes = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normal);
  if (!partes) return null;
  const importe = Number(partes[2]) * 100 + Number((partes[3] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(importe) || importe > MAX_CENTAVOS) return null;
  return partes[1] && importe ? -importe : importe;
}

export function centavosHistoricos(valor) {
  const exacto = centavos(valor);
  if (exacto !== null) return exacto;
  // Algunos pedidos anteriores ya se guardaron como números con más de dos decimales.
  return typeof valor === "number" && Number.isFinite(valor) && Math.abs(valor) <= MAX_CENTAVOS / 100
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

export function precioHistorico(pedido, clave) {
  const partes = clave.split(" · ");
  const precios = Array.isArray(pedido.precios) ? pedido.precios : [];
  for (let n = partes.length; n > 0; n--) {
    const k = partes.slice(0, n).join(" · ");
    const equivalentes = k.includes("Niño/Niña")
      ? [k, k.replace("Niño/Niña", "Niño"), k.replace("Niño/Niña", "Niña")] : [k];
    const precio = precios.find(p => equivalentes.includes(p.n));
    if (precio) return centavosHistoricos(precio.v);
  }
  return centavosHistoricos(pedido.precio);
}

export function validarPago(items, precio, abono, moneda) {
  if (!MONEDAS.has(moneda)) return {error:"moneda"};
  if (!items.length) return {error:"precio"};
  let total = 0, piezas = 0;
  for (const item of items) {
    const unidades = cantidad(item.cant);
    if (unidades === null) return {error:"cantidad"};
    const unitario = centavos(precio(item));
    if (!(unitario > 0)) return {error:"precio"};
    piezas += unidades;
    total += unidades * unitario;
    if (!Number.isSafeInteger(piezas) || !Number.isSafeInteger(total) || total > MAX_CENTAVOS)
      return {error:"total"};
  }
  const pagado = typeof abono === "string" && !abono.trim() ? 0 : centavos(abono);
  if (pagado === null || pagado < 0) return {error:"abono"};
  if (pagado > total) return {error:"sobrepago"};
  return {piezas, total, abono:pagado, saldo:total - pagado};
}
