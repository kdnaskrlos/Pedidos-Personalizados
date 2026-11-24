import { strToU8, zipSync } from "./vendor/fflate.mjs";

const escapar = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
})[char]);
const disponible = valor => valor !== undefined && valor !== null && valor !== "";
const extensiones = {jpeg:"jpg", webp:"webp", png:"png", gif:"gif", avif:"avif"};

export function codigoParaArchivo(codigo) {
  return String(codigo ?? "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64) || "sin-codigo";
}

export function archivoReferencia(src, indice) {
  const partes = /^data:image\/(jpeg|png|webp|gif|avif);base64,([a-zA-Z0-9+/=]+)$/.exec(src || "");
  if (!partes) throw new Error("La referencia no es una imagen descargable");
  const [, formato, base64] = partes;
  return {
    nombre:`referencia-${String(indice + 1).padStart(2, "0")}.${extensiones[formato]}`,
    tipo:"image/" + formato,
    datos:Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  };
}

const fichas = pares => pares.filter(([, valor]) => disponible(valor))
  .map(([etiqueta, valor]) => `<dt>${escapar(etiqueta)}</dt><dd>${escapar(valor)}</dd>`).join("");
const seccion = (titulo, pares) => {
  const detalle = fichas(pares);
  return detalle ? `<section><h2>${escapar(titulo)}</h2><dl>${detalle}</dl></section>` : "";
};

export function htmlResumen({codigo, tipo, datos, prendas, pago, seguimiento, nota}, archivos=[]) {
  const columnas = ["Prenda","Horma","Talla","Color","Cantidad","Nombre","Número","Etiqueta","Precio unitario","Subtotal"];
  const activas = columnas.map((_, i) => i).filter(i => prendas.some(fila => disponible(fila[i])));
  const tabla = prendas.length ? `<section><h2>Prendas</h2><table><thead><tr>${
    activas.map(i => `<th scope="col">${columnas[i]}</th>`).join("")
  }</tr></thead><tbody>${prendas.map(fila => `<tr>${
    activas.map(i => `<td>${escapar(fila[i])}</td>`).join("")
  }</tr>`).join("")}</tbody></table></section>` : "";
  const referencias = archivos.length ? `<section><h2>Referencias</h2><ul>${archivos.map(a =>
    `<li><a href="imagenes/${escapar(a.nombre)}">${escapar(a.nombre)}</a></li>`).join("")}</ul></section>` : "";
  const titulo = codigo ? `Pedido ${codigo}` : "Pedido";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapar(titulo)}</title>
<style>
:root{font:15px/1.5 system-ui,sans-serif;color:#18212b}body{max-width:65rem;margin:2rem auto;padding:0 1.25rem}h1,h2,p{margin:0 0 .5em}
h2{font-size:1.15rem}section{margin:1.25rem 0}dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem}dt{font-weight:650}dd{margin:0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{padding:.45rem;text-align:left;border-bottom:1px solid #ccd4dc;overflow-wrap:anywhere}th{background:#f0f3f6}
.nota{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#11477a}@media print{body{margin:0;padding:0}tr{break-inside:avoid}thead{display:table-header-group}}@media(max-width:580px){dl{display:block}dd{margin-bottom:.5rem}table{font-size:.82rem}}
</style></head><body><h1>${escapar(titulo)}</h1>${tipo ? `<p>${escapar(tipo)}</p>` : ""}
${seccion("Datos del pedido", datos)}${tabla}${seccion("Pago", pago)}
${nota ? `<section><h2>Notas</h2><p class="nota">${escapar(nota)}</p></section>` : ""}
${seccion("Seguimiento", seguimiento)}${referencias}</body></html>`;
}

export function archivoPedido(resumen, archivos) {
  const codigo = codigoParaArchivo(resumen.codigo);
  const entradas = {[`resumen-pedido-${codigo}.html`]:strToU8(htmlResumen(resumen, archivos))};
  for (const archivo of archivos) entradas[`imagenes/${archivo.nombre}`] = archivo.datos;
  return {nombre:`pedido-${codigo}.zip`, tipo:"application/zip", datos:zipSync(entradas,{level:0})};
}

export function descargarArchivo({nombre, tipo, datos}) {
  const url = URL.createObjectURL(new Blob([datos], {type:tipo}));
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
