import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fechasDelMes, entregasPorFecha } from "../calendario.mjs";
import { continuarLista, iniciarLista } from "../notas.mjs";
import { esHeif } from "../heic.mjs";
import { archivoReferencia, codigoParaArchivo } from "../pedido-export.mjs";
import { dividirMensaje, enlaceChatCliente } from "../whatsapp.mjs";

test("divide el mensaje de WhatsApp sin perder saltos de línea ni partir emojis", () => {
  const texto = "Prenda · talla XL\n" + "x".repeat(11999) + "👕" + "fin\n".repeat(5000);
  const partes = dividirMensaje(texto);
  assert.ok(partes.length > 1);
  assert.ok(partes.every(p => p.length <= 12000 && !/[\uD800-\uDBFF]$/.test(p)));
  assert.equal(partes.join(""),texto);
});

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

test("las referencias conservan sus bytes y se generan nombres seguros", () => {
  const bytes = Uint8Array.of(255,216,255,217);
  const foto = archivoReferencia("data:image/jpeg;base64," + Buffer.from(bytes).toString("base64"),0);
  assert.throws(() => archivoReferencia("data:image/svg+xml;base64,PHN2Zz4=",0));
  assert.equal(foto.nombre,"referencia-01.jpg");
  assert.deepEqual(foto.datos,bytes);
  assert.equal(codigoParaArchivo("../S-0011 <script>"),"S-0011-script");
});

test("WhatsApp usa E.164, enlace web directo en escritorio y wa.me en móvil", () => {
  assert.equal(enlaceChatCliente("+12025550142",true),"https://web.whatsapp.com/send?phone=12025550142");
  assert.equal(enlaceChatCliente("12025550142",false),"https://wa.me/12025550142");
  assert.ok(enlaceChatCliente("123456789012345",true));
  for (const invalido of [null,"","04120000000","12","1234567890123456","1 202 555 0142","12025550142?x=1","javascript:1"])
    assert.equal(enlaceChatCliente(invalido,true),"");
});


test("calendario contextual separa los dos tipos y el global los conserva", () => {
  const fechaEntrega = "2028-02-29";
  const personal = {tipo:"personalizado",fechaEntrega};
  const sublimado = {tipo:"sublimacion",fechaEntrega};
  const pedidos = [personal,sublimado,personal,{}];
  assert.deepEqual(entregasPorFecha(pedidos).get(fechaEntrega),[personal,sublimado,personal]);
  assert.deepEqual(entregasPorFecha(pedidos,"personalizado").get(fechaEntrega),[personal,personal]);
  assert.deepEqual(entregasPorFecha(pedidos,"sublimacion").get(fechaEntrega),[sublimado]);
});

test("listas de notas continúan el marcador y respetan texto y saltos", () => {
  assert.deepEqual(continuarLista("• A",3),{inicio:3,fin:3,texto:"\n• "});
  assert.deepEqual(continuarLista("☐ A\n☐ ",6),{inicio:4,fin:6,texto:""});
  assert.deepEqual(continuarLista("☑ A",3),{inicio:3,fin:3,texto:"\n☑ "});
  assert.equal(continuarLista("Nota normal",11),null);
  assert.equal(continuarLista("• ABC",3),null);
  assert.deepEqual(iniciarLista("☐ AB",4,"•"),{inicio:0,fin:2,texto:"• ",cursor:4});
});
