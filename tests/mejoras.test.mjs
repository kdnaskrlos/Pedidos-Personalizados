import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fechasDelMes, entregasPorFecha } from "../calendario.mjs";
import { esHeif } from "../heic.mjs";
import { archivoPedido, archivoReferencia } from "../pedido-export.mjs";
import { unzipSync } from "../vendor/fflate.mjs";

test("calendario bisiesto y agrupación de las entregas recibidas", () => {
  const febrero = fechasDelMes(2028,1);
  assert.equal(febrero.length,42);
  assert.equal(febrero[0],null);
  assert.equal(febrero.filter(Boolean).length,29);
  assert.equal(febrero[29].fecha,"2028-02-29");
  const pedido = {fechaEntrega:"2028-02-29"};
  assert.deepEqual([...entregasPorFecha([pedido,{},pedido])],[["2028-02-29",[pedido,pedido]]]);
});

test("HEIC por MIME o extensión y decodificación local de EXIF real", async () => {
  assert.ok(esHeif({name:"imagen.HEIF",type:"application/octet-stream"}));
  assert.ok(esHeif({name:"archivo",type:"image/heic-sequence"}));
  assert.ok(!esHeif({name:"imagen.jpg",type:"image/jpeg"}));
  let resultado;
  globalThis.self = {postMessage: mensaje => { resultado = mensaje; }};
  try {
    await import("../heic-worker.mjs");
    const archivo = await readFile(new URL("./fixtures/referencia-orientacion-6.heic",import.meta.url));
    await self.onmessage({data:new Blob([archivo])});
    const {ancho,alto,orientacion,pixeles} = resultado;
    assert.deepEqual([ancho,alto,orientacion],[96,48,6]);
    assert.equal(pixeles.byteLength,96 * 48 * 4);
    await self.onmessage({data:new Blob(["invalida"])});
    assert.match(resultado.error,/HEIC|HEIF/);
  } finally {
    delete globalThis.self;
  }
});

test("ZIP local conserva las fotos, escapa el resumen y omite los datos desconocidos", () => {
  const bytes = Uint8Array.of(255,216,255,217);
  const foto = archivoReferencia("data:image/jpeg;base64," + Buffer.from(bytes).toString("base64"),0);
  assert.throws(() => archivoReferencia("data:image/svg+xml;base64,PHN2Zz4=",0));
  const zip = archivoPedido({
    codigo:"../S-0011 <script>",tipo:"Sublimación",datos:[["Cliente","<script>"],["Fecha",""]],
    prendas:[["Franela",null,"M"]], pago:[["Saldo",0]],seguimiento:[],nota:"línea 1\nlínea 2"
  },[foto]);
  assert.equal(zip.nombre,"pedido-S-0011-script.zip");
  const entradas = unzipSync(zip.datos);
  assert.deepEqual(Object.keys(entradas),["resumen-pedido-S-0011-script.html","imagenes/referencia-01.jpg"]);
  assert.deepEqual(entradas["imagenes/referencia-01.jpg"],bytes);
  const resumen = Buffer.from(entradas["resumen-pedido-S-0011-script.html"]).toString();
  assert.match(resumen,/&lt;script&gt;/);
  assert.match(resumen,/Saldo<\/dt><dd>0/);
  assert.match(resumen,/href="imagenes\/referencia-01.jpg"/);
  assert.match(resumen,/@media print/);
  assert.doesNotMatch(resumen,/<script>|<img|data:image|>Horma<|>Fecha</);
});
