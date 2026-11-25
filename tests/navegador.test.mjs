import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { chromium, devices } from "playwright-core";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDocFromServer, updateDoc, writeBatch } from "firebase/firestore";

const projectId = "demo-pedidos-codex";
const root = new URL("../", import.meta.url);
const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestore = process.env.FIRESTORE_EMULATOR_HOST;
for (const host of [auth,firestore]) assert.match(host || "", /^(127\.0\.0\.1|localhost):\d+$/);
const [dbHost, dbPort] = firestore.split(":");
const firebaseCdn = "https://www.gstatic.com/firebasejs/10.12.2/";
const curl = promisify(execFile);
const mime = {html:"text/html",js:"text/javascript",mjs:"text/javascript",png:"image/png",webmanifest:"application/manifest+json"};

async function appDePrueba() {
  const original = await readFile(new URL("index.html",root),"utf8");
  const html = original.replaceAll(firebaseCdn, "/sdk/")
    .replace("import { getAuth,", "import { connectAuthEmulator, getAuth as sdkAuth,")
    .replace("import { initializeFirestore, getFirestore,", "import { connectFirestoreEmulator, initializeFirestore as sdkInitDb, getFirestore as sdkDb,")
    .replace('location.protocol === "https:"', 'location.hostname === "127.0.0.1"')
    .replace("boot();\n", `
      const auths = new WeakSet(), bases = new WeakSet();
      function getAuth(app) {
        const auth = sdkAuth(app);
        if (!auths.has(auth)) {
          connectAuthEmulator(auth, ${JSON.stringify("http://" + auth)}, {disableWarnings:true});
          auths.add(auth);
        }
        return auth;
      }
      function conectar(db) {
        if (!bases.has(db)) {
          connectFirestoreEmulator(db, ${JSON.stringify(dbHost)}, ${Number(dbPort)});
          bases.add(db);
        }
        return db;
      }
      const initializeFirestore = (...a) => conectar(sdkInitDb(...a));
      const getFirestore = (...a) => conectar(sdkDb(...a));
      boot();
    `);
  const sdk = new Map();
  const server = createServer(async (req,res) => {
    const path = new URL(req.url,"http://127.0.0.1").pathname;
    try {
      let data;
      if (path === "/" || path === "/index.html") {
        res.setHeader("Content-Type",mime.html);
        data = html;
      } else if (path === "/config.js") {
        // No se abre config.js del repositorio.
        res.setHeader("Content-Type",mime.js);
        data = "export const firebaseConfig = " + JSON.stringify({projectId,apiKey:"demo-key",appId:"1:123:web:synthetic",authDomain:"127.0.0.1"});
      } else if (path === "/push-config.mjs") {
        // El registro FCM real se verifica por separado de los emuladores.
        res.setHeader("Content-Type",mime.mjs);
        data = 'export const claveVapid = ""; export const regionAvisos = "us-central1";';
      } else if (/^\/sdk\/firebase-[\w-]+\.js$/.test(path)) {
        res.setHeader("Content-Type",mime.js);
        if (!sdk.has(path)) {
          const asset = curl("curl",["-fsSL","--retry","1","--max-time","20",firebaseCdn + path.slice(5)],{maxBuffer:8_000_000})
            .then(r => r.stdout.replaceAll(firebaseCdn,"/sdk/"));
          sdk.set(path,asset);
        }
        data = await sdk.get(path);
      } else if (/^\/(?:(?:vendor\/)?[a-z0-9-]+\.(?:js|mjs|png|webmanifest))$/.test(path)) {
        res.setHeader("Content-Type",mime[path.split(".").at(-1)]);
        data = await readFile(new URL(path.slice(1),root));
      } else {
        res.writeHead(404).end();
        return;
      }
      res.end(data);
    } catch(e) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  return {server, url:"http://127.0.0.1:" + server.address().port};
}

const visible = selector => selector.waitFor({state:"visible"});
async function comprobarAlcanceDeAjustes(vista) {
  const personales = vista.getByRole("region",{name:"Ajustes personales",exact:true});
  const equipo = vista.getByRole("region",{name:"Ajustes de todo el equipo",exact:true});
  const notificaciones = personales.getByRole("region",{name:"Notificaciones",exact:true});
  await visible(personales.getByRole("heading",{name:"Ajustes personales",exact:true}));
  for (const nombre of ["Notificaciones en este dispositivo","Ediciones de pedidos por otros miembros","Nuevos pedidos","Pedido listo / cambio de estado"])
    await visible(notificaciones.getByRole("switch",{name:nombre,exact:true}));
  await visible(equipo.getByRole("heading",{name:"Ajustes de todo el equipo",exact:true}));
  await visible(equipo.getByText("Avisar entregas con anticipación de",{exact:true}));
  assert.equal(await equipo.locator(".nt-panel").count(),0);
  assert.equal(await notificaciones.locator(".note").count(),0);
  assert.equal(await vista.getByText("Se aplican a todo el equipo",{exact:true}).count(),0);
}
const oculto = selector => selector.waitFor({state:"hidden"});
async function descargarPedido(page, nombres) {
  const errores = [];
  const aviso = mensaje => { if (mensaje.text().startsWith("Descarga del pedido")) errores.push(mensaje.text()); };
  page.on("console",aviso);
  // Registra las solicitudes y el texto dibujado, manteniendo las descargas reales de Chromium.
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click, trazar = CanvasRenderingContext2D.prototype.fillText;
    window.descargasPrueba = [];
    window.textosResumen = [];
    HTMLAnchorElement.prototype.click = function() {
      if (this.download) window.descargasPrueba.push(this.download);
      return click.call(this);
    };
    CanvasRenderingContext2D.prototype.fillText = function(texto,...args) {
      if (this.canvas.width > 300) window.textosResumen.push(String(texto));
      return trazar.call(this,texto,...args);
    };
    window.restaurarDescargas = () => {
      HTMLAnchorElement.prototype.click = click;
      CanvasRenderingContext2D.prototype.fillText = trazar;
    };
  });
  try {
    const esperas = nombres.map(n => page.waitForEvent("download",{
      predicate:d => n.test(d.suggestedFilename()),timeout:12000
    }));
    const [archivos] = await Promise.all([Promise.all(esperas),page.locator("#d-download").click()]);
    const [png,...fotos] = await Promise.all(archivos.map(async a => readFile(await a.path())));
    const solicitados = await page.evaluate(() => window.descargasPrueba);
    assert.deepEqual(solicitados,archivos.map(a => a.suggestedFilename()));
    assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(png.readUInt32BE(16),1440);
    return {fotos,alto:png.readUInt32BE(20),resumen:await page.evaluate(() => window.textosResumen.join("\n"))};
  } catch (e) {
    const estado = await page.locator("#d-download-status").textContent({timeout:1000}).catch(() => "");
    const solicitados = await page.evaluate(() => window.descargasPrueba);
    throw new Error(`Descargas solicitadas: ${solicitados.join(", ")}. ${estado} ${errores.join(" ")}`,{cause:e});
  } finally {
    page.off("console",aviso);
    await page.evaluate(() => window.restaurarDescargas());
  }
}

function comprobarCamposPNG(resumen) {
  const lineas = resumen.split("\n");
  for (const campo of ["Datos del pedido","Creación","Entrega","Cliente","Tema","Subtotal","Total","Abono","Saldo"])
    assert.ok(lineas.includes(campo),campo);
  for (const titulo of ["Prendas","Pago","Notas","Seguimiento"])
    assert.ok(!lineas.includes(titulo),titulo);
  assert.match(resumen,/\bPrecio\s+unitario\b/);
  assert.match(resumen,/^\d+$/m);
  assert.match(resumen,/Talla /);
  assert.doesNotMatch(resumen,/RESUMEN DEL PEDIDO|\b[PS]-\d{4}\b|Teléfono|Estado|Urgente|Moneda|584120000000|12025550142/);
}

async function comprobarIconoSobreFoto(icono) {
  await visible(icono);
  assert.ok(await icono.evaluate(b => {
    const foto = b.parentElement.querySelector("img");
    const a = b.getBoundingClientRect(), f = foto.getBoundingClientRect();
    return a.width >= 40 && a.height >= 40 && Math.abs(f.right - a.right - 4) <= 2 &&
      Math.abs(a.top - f.top - 4) <= 2 && a.right <= innerWidth;
  }));
}

async function comprobarAncla(page,id) {
  await page.waitForFunction(id => {
    const t = document.getElementById(id), barra = document.querySelector(".topbar");
    if (!t || !barra || t !== document.activeElement) return false;
    const {top,bottom} = t.getBoundingClientRect();
    return top >= barra.getBoundingClientRect().bottom && bottom < innerHeight;
  },id);
}

async function escribirNotaConListas(page) {
  const nota = page.locator("#in-nota");
  await nota.press("End");
  await nota.press("Enter");
  await page.getByRole("button",{name:"• Viñeta"}).click();
  await page.keyboard.insertText("Separar prendas");
  await nota.press("Enter");
  await page.keyboard.insertText("Doblar");
  await nota.press("Enter");
  await nota.press("Enter");
  await page.getByRole("button",{name:"• Viñeta"}).click();
  await page.keyboard.insertText("Revisar empaque");
  await nota.press("Enter");
  await nota.press("Enter");
  await page.keyboard.insertText("Línea normal");
}

async function comprobarZoomMovil(page,visor) {
  const mano = await page.context().newCDPSession(page);
  const r = await visor.locator(".lbvp").boundingBox();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const tocar = (type,...dx) => mano.send("Input.dispatchTouchEvent",{
    type,touchPoints:dx.map((x,id) => ({x:cx+x,y:cy,id}))
  });
  const foto = visor.locator('.lbs[aria-hidden="false"] img');
  const estado = () => foto.evaluate(img => {
    const m = new DOMMatrix(getComputedStyle(img).transform);
    return {escala:m.a,x:m.e,visible:img.getBoundingClientRect().right > 0 && img.getBoundingClientRect().left < innerWidth};
  });
  try {
    await tocar("touchStart",-20,20);
    await tocar("touchMove",-125,125);
    await tocar("touchEnd");
    assert.equal((await estado()).escala,4);
    await tocar("touchStart",0);
    await tocar("touchMove",-155);
    await tocar("touchEnd");
    const ampliada = await estado();
    assert.ok(ampliada.x < 0 && ampliada.visible);
    assert.equal(await visor.locator('[role="status"]').textContent(),"Foto 2 de 2");

    await tocar("touchStart",-125,125);
    await tocar("touchMove",-17,17);
    await tocar("touchEnd");
    assert.equal((await estado()).escala,1);
    await tocar("touchStart",-95);
    await tocar("touchMove",95);
    await tocar("touchEnd");
    assert.equal(await visor.locator('[role="status"]').textContent(),"Foto 1 de 2");
    assert.equal((await estado()).escala,1);

    await visor.press("ArrowRight");
    await tocar("touchStart",-20,20);
    await tocar("touchMove",-125,125);
    await tocar("touchEnd");
    assert.equal((await estado()).escala,4);
    await visor.press("ArrowLeft");
    await visor.press("ArrowRight");
    assert.equal((await estado()).escala,1);
  } finally {
    await mano.detach();
  }
}

async function comprobarCalendariosPorTipo(page) {
  let fecha;
  const navPedidos = page.locator('[data-view="pedidos"]:visible').first();
  for (const [tema,cantidad,excluido] of [
    [/Etiqueta de Prueba/i,"1 entrega",/Tema Adicional/i],
    [/Tema Adicional/i,"4 entregas",/Etiqueta de Prueba/i]
  ]) {
    await navPedidos.click();
    await page.locator('[data-filtro="pendientes"]:visible').click();
    await page.locator(".oc2:visible").filter({hasText:tema}).click();
    await page.locator("#d-edit").click();
    await page.locator('[data-go="2"]').click();
    await page.locator("#in-fecha").click();
    const calendario = page.getByRole("dialog",{name:"Fecha de entrega"});
    const dia = calendario.locator('.dpg:not([inert]) button[aria-pressed="true"]');
    await visible(dia);
    assert.ok((await dia.getAttribute("aria-label")).endsWith(cantidad));
    assert.doesNotMatch(await calendario.locator(".aglist").innerText(),excluido);
    fecha = await dia.getAttribute("data-d");
    await page.reload();
    await visible(page.locator(".shell"));
  }

  // Tras recargar, espera a que la lista incluya ambos tipos antes de abrir la agenda.
  await navPedidos.click();
  await page.locator('[data-filtro="pendientes"]:visible').click();
  for (const tema of [/Etiqueta de Prueba/i,/Tema Adicional/i]) {
    await visible(page.locator(".oc2:visible").filter({hasText:tema}));
  }
  await page.locator('[data-act="agenda"]').click();
  const agenda = page.locator(".agov");
  const dia = agenda.locator(`.dpg:not([inert]) button[data-d="${fecha}"]`);
  if (!(await dia.count())) await agenda.getByRole("button",{name:"Mes siguiente"}).click();
  await visible(dia);
  assert.match(await dia.getAttribute("aria-label"),/5 entregas$/);
  await dia.click();
  for (const tema of [/Etiqueta de Prueba/i,/Tema Adicional/i])
    await visible(agenda.locator(".aglist").getByText(tema));
}

async function simularWhatsApp(contexto, destino) {
  await contexto.route(destino, ruta => ruta.fulfill({contentType:"text/plain",body:destino}));
}

async function abrirChat(page, destino) {
  const enlace = page.locator(".pdwa");
  assert.equal(await enlace.getAttribute("href"),destino);
  const [chat] = await Promise.all([
    page.context().waitForEvent("page",{timeout:10000}),
    enlace.click()
  ]);
  await chat.waitForURL(destino,{timeout:10000});
  assert.equal(await chat.locator("body").innerText(),destino);
  return chat;
}

async function comprobarChatsEscritorio(page) {
  const contexto = page.context(), pedidos = page.url(), enlace = page.locator(".pdwa");
  const primero = "https://web.whatsapp.com/send?phone=584120000000";
  const segundo = "https://web.whatsapp.com/send?phone=584140000000";
  const tarjeta = tema => page.locator(".oc2:visible").filter({hasText:tema});
  await simularWhatsApp(contexto,primero);
  await simularWhatsApp(contexto,segundo);
  assert.equal(contexto.pages().length,1);

  const chat = await abrirChat(page,primero);
  assert.equal(contexto.pages().length,2);
  await page.bringToFront();
  await page.locator(".pdback").click();
  await tarjeta(/Tema Adicional/i).click();
  assert.equal(await enlace.getAttribute("href"),segundo);
  await enlace.click();
  await chat.waitForURL(segundo,{timeout:10000});
  assert.equal(await chat.locator("body").innerText(),segundo);
  assert.equal(contexto.pages().length,2,"Ambos clientes deben abrirse en la misma pestaña de WhatsApp");
  assert.equal(page.url(),pedidos);
  await visible(page.locator(".pdmd").getByText(/Nota Tema Adicional/i));

  await chat.close();
  assert.equal(contexto.pages().length,1);
  const nuevoChat = await abrirChat(page,segundo);
  assert.equal(contexto.pages().length,2);
  await nuevoChat.close();
  await visible(enlace);
  assert.equal(page.url(),pedidos);

  // Simula un navegador que bloquea la siguiente apertura.
  await page.evaluate(() => {
    const abrir = window.open;
    window.open = () => { window.open = abrir; return null; };
  });
  await enlace.click();
  await visible(page.getByText(/permite las ventanas emergentes de Pedidos/));
  assert.equal(contexto.pages().length,1);
  assert.equal(page.url(),pedidos);
  await page.locator(".pdback").click();
  await tarjeta(/Tema Escritorio/i).click();
}

async function iniciar(page, url, usuario, pin) {
  if (url) await page.goto(url);
  await page.locator("#lu").fill(usuario);
  await page.locator("#lp").fill(pin);
  await page.locator("#loginForm button").click();
  await visible(page.locator(".shell"));
}

async function crearSublimado(page, tema, opciones = {}) {
  const nav = page.locator('.side [data-act="nuevo"], .bottom [data-act="nuevo"]').filter({visible:true});
  if (await nav.count()) await nav.first().click();
  else await page.locator('[data-act="nuevo"]').filter({visible:true}).first().click();
  const tipo = page.locator('[data-t="sublimacion"]');
  if (await tipo.count()) await tipo.click();
  await page.locator("#in-nombre").fill("Persona de prueba");
  await page.locator("#in-tel").fill(opciones.telefono || "04120000000");
  await page.locator("#in-tema").fill(tema);
  await page.locator("#next").click();
  await page.locator("#addItem").click();
  await page.locator('[data-pick="prenda"]').first().click();
  await page.locator(".pkgrid [data-v]").first().click();
  await page.locator('[data-pick="talla"]').click();
  await page.locator('.pkgrid [data-v="2XL"]').click();
  if (opciones.errores) {
    await page.locator("[data-cant]").fill("1.5");
    await page.locator("#next").click();
    await visible(page.getByText("Las unidades deben ser un entero positivo",{exact:false}));
  }
  await page.locator("[data-cant]").fill("2");
  if (opciones.partidas) {
    const agregarAlFinal = opciones.partidas === 10;
    opciones.mediciones.push(await page.evaluate(n => {
      const inicio = performance.now();
      for (let i = 0; i < n; i++) {
        if (i) document.querySelector("#dupItem").click();
        const nombre = [...document.querySelectorAll('.irow3:not(.mini) [data-fld="nombre"]')].at(-1);
        nombre.value = "LOTE" + String(i + 1).padStart(3,"0");
        nombre.dispatchEvent(new Event("input",{bubbles:true}));
      }
      return performance.now() - inicio;
    },opciones.partidas - Number(agregarAlFinal)));
    if (agregarAlFinal) {
      await page.locator("#addItem").click();
      const fila = page.locator('.irow3:not(.mini)');
      await fila.locator('[data-pick="prenda"]').click();
      await page.locator(".pkgrid [data-v]").first().click();
      await fila.locator('[data-pick="talla"]').click();
      await page.locator('.pkgrid [data-v="2XL"]').click();
      await fila.locator("[data-cant]").fill("2");
      await fila.locator('[data-fld="nombre"]').fill("LOTE010");
    }
  }
  if (opciones.multi) {
    await page.locator("#addItem").click();
    await page.locator('[data-pick="prenda"]').last().click();
    await page.locator(".pkgrid [data-v]").first().click();
    await page.locator('[data-pick="talla"]').last().click();
    await page.locator('.pkgrid [data-v="3XL"]').click();
  }
  await page.locator("#next").click();
  await page.locator("#in-fecha").click();
  const selector = page.getByRole("dialog",{name:"Fecha de entrega"});
  await visible(selector);
  if (opciones.errores) {
    const elegido = selector.locator('.dpg:not([inert]) button[aria-pressed="true"]');
    const antes = await elegido.getAttribute("data-d");
    await page.keyboard.press("ArrowRight");
    assert.notEqual(await elegido.getAttribute("data-d"),antes);
  }
  await selector.getByRole("button",{name:"Mañana",exact:true}).click();
  await visible(selector);
  await selector.getByRole("button",{name:"Confirmar fecha"}).click();
  await page.locator("#in-mon").selectOption("USD");
  const precios = page.locator("#prl input");
  await precios.first().fill("10,11");
  if (opciones.multi) await precios.last().fill("2,13");
  if (opciones.errores) {
    await page.locator("#in-abono").fill("21");
    await visible(page.locator("#pago-msg").getByText("El abono no puede ser mayor que el total"));
    await page.locator("#next").click();
    await visible(page.locator("#f-abono .bad"));
  }
  await page.locator("#in-abono").fill("0,25");
  await page.locator("#next").click();
  const notaEsperada = "Nota " + tema + (opciones.errores ? "\n• Separar prendas\n• Doblar\n• Revisar empaque\nLínea normal" : "");
  await page.locator("#in-nota").fill("Nota " + tema);
  if (opciones.errores) await escribirNotaConListas(page);
  assert.equal(await page.locator("#in-nota").inputValue(),notaEsperada);
  if (opciones.foto) {
    const entrada = page.locator("#fileGal");
    if (opciones.errores) {
      await entrada.setInputFiles({name:"invalida.heic",mimeType:"image/heic",buffer:Buffer.from("invalida")});
      await visible(page.getByText(/No se pudo (abrir|convertir) la foto HEIC/).first());
      assert.equal(await page.locator("#in-nota").inputValue(),notaEsperada);
      await page.locator("[data-rmimg]").click();
      await entrada.setInputFiles({
        name:"referencia.HEIF",mimeType:"application/octet-stream",
        buffer:await readFile(new URL("tests/fixtures/referencia-orientacion-6.heic",root))
      });
      await page.waitForFunction(() => {
        const foto = document.querySelector("#imgs img");
        return foto?.naturalWidth === 48 && foto.naturalHeight === 96;
      });
    }
    await entrada.setInputFiles(new URL("icono-192.png",root).pathname);
    await visible(page.locator('#imgs img[src^="data:image/"]').last());
  }
  await page.locator("#save").click();
  await oculto(page.locator("#save"));
}

async function comprobarEtiquetas(page, env) {
  const tienda = page.locator('[data-prendade="tienda"]');
  const cliente = page.locator('[data-prendade="cliente"]');
  const etiquetas = page.locator('[data-pick="etiqueta"]');
  const abrir = () => page.locator('.side [data-act="nuevo"]').click();
  const elegir = async (campo,valor) => {
    await page.locator(`[data-pick="${campo}"]`).click();
    await page.locator(".pkgrid [data-v]").filter({hasText:new RegExp("^" + valor + "$")}).click();
  };
  const continuar = async (mezclar = false) => {
    await page.reload();
    await visible(page.locator(".shell"));
    if (mezclar) {
      // Simula un borrador antiguo con una etiqueta que ya no corresponde.
      await page.evaluate(() => {
        const clave = Object.keys(localStorage).find(k => k.startsWith("cs-borrador-"));
        const borrador = JSON.parse(localStorage.getItem(clave));
        borrador.F.items[0].etiqueta = "Etiqueta antigua";
        borrador.F.etiqueta = "Etiqueta antigua";
        localStorage.setItem(clave,JSON.stringify(borrador));
      });
    }
    await abrir();
    await page.locator("#dok").click();
    await visible(page.locator('.step[data-step="1"]'));
  };
  const comprobarGuardado = (id, origen, etiqueta) => env.withSecurityRulesDisabled(async contexto => {
    const snap = await getDocFromServer(doc(contexto.firestore(),"pedidos",id));
    assert.ok(snap.exists(), "El pedido debe estar confirmado en Firestore");
    const pedido = snap.data();
    assert.equal(pedido.prendaDe,origen);
    assert.equal(pedido.etiqueta,etiqueta);
    assert.equal(pedido.items[0].etiqueta,etiqueta);
  });

  await abrir();
  await page.locator('[data-t="personalizado"]').click();
  await page.locator("#in-nombre").fill("Cliente ficticio");
  await page.locator("#in-tel").fill("04120000000");
  await page.locator("#in-tema").fill("Etiqueta de prueba");
  await page.locator('[data-servicio="DTF"]').click();
  await tienda.click();
  await page.locator("#next").click();
  await page.locator("#addItem").click();
  await elegir("etiqueta","Comic Shop");
  await elegir("prenda","Franela");
  await elegir("color","Negro");
  await elegir("horma","Unisex");
  await elegir("talla","M");
  await page.waitForFunction(() => Object.entries(localStorage).some(([k,v]) => k.startsWith("cs-borrador-") && JSON.parse(v).F.items[0]?.talla === "M"));
  await continuar();
  assert.match(await etiquetas.innerText(),/Comic Shop/);

  await page.locator('[data-go="0"]').click();
  await cliente.click();
  await page.locator("#next").click();
  assert.equal(await etiquetas.count(),0);
  await page.waitForFunction(() => Object.entries(localStorage).some(([k,v]) => {
    if (!k.startsWith("cs-borrador-")) return false;
    const f = JSON.parse(v).F;
    return f.prendaDe === "cliente" && f.step === 1 && f.items[0]?.etiqueta === "";
  }));
  await continuar(true);
  assert.equal(await etiquetas.count(),0);
  await page.locator("#next").click();
  await page.locator("#in-fecha").click();
  await page.getByRole("button",{name:"Mañana",exact:true}).click();
  await page.getByRole("button",{name:"Confirmar fecha"}).click();
  await page.locator("#in-mon").selectOption("USD");
  await page.locator("#prl input").fill("10");
  await page.locator("#in-abono").fill("2");
  await page.locator("#next").click();
  await page.locator("#save").click();
  await oculto(page.locator("#save"));
  const tarjeta = page.locator(".oc2:visible").filter({hasText:/Etiqueta de Prueba/i});
  await visible(tarjeta);
  const id = await tarjeta.getAttribute("data-open");
  await comprobarGuardado(id,"cliente","");

  await tarjeta.click();
  await page.locator("#d-edit").click();
  await page.locator('[data-go="1"]').click();
  assert.equal(await etiquetas.count(),0);
  await page.locator('[data-go="0"]').click();
  await tienda.click();
  await page.locator("#next").click();
  await visible(etiquetas);
  await page.locator("#next").click();
  assert.match(await page.locator("#f-items").innerText(),/Completa lo marcado en rojo/);
  await elegir("etiqueta","Comic Shop");
  await page.locator('[data-go="3"]').click();
  await page.locator("#save").click();
  await oculto(page.locator("#save"));
  await visible(page.getByText("Cambio guardado",{exact:true}));
  await comprobarGuardado(id,"tienda","Comic Shop");
}

test("escritorio y móvil: login, altas offline en varios clientes, recarga, sincronización y funciones del pedido", {timeout:150000}, async () => {
  const {server,url} = await appDePrueba();
  let navegador, env;
  const errores = [];
  try {
    const chromiumLocal = "/usr/bin/chromium";
    const executablePath = process.env.CHROMIUM_PATH || (existsSync(chromiumLocal) ? chromiumLocal : chromium.executablePath());
    navegador = await chromium.launch({executablePath,args:["--no-sandbox"]});
    const desktop = await navegador.newContext({viewport:{width:1440,height:900},reducedMotion:"reduce"});
    const mobile = await navegador.newContext({...devices["Pixel 7"],reducedMotion:"reduce"});
    const paginas = [await desktop.newPage(),await mobile.newPage()];
    const [page,cel] = paginas;
    const inesperadas = [];
    for (const context of [desktop,mobile]) await context.route("**/*", async route => {
      const destino = new URL(route.request().url());
      if (["127.0.0.1","localhost"].includes(destino.hostname)) return route.continue();
      // El SDK también intenta cargar recursos auxiliares de Google en el navegador.
      // Se bloquean junto a cualquier otro host externo.
      if (!["fonts.googleapis.com","fonts.gstatic.com","apis.google.com","www.google.com"].includes(destino.hostname))
        inesperadas.push(destino.hostname);
      await route.abort();
    });
    for (const tab of paginas) {
      tab.setDefaultTimeout(12000);
      tab.on("pageerror",e => errores.push(e.message));
    }

    await page.goto(url);
    await page.locator("#bn").fill("Admin de prueba");
    await page.locator("#bu").fill("adminprueba");
    await page.locator("#bp").fill("60479253");
    await page.locator("#bp2").fill("60479253");
    await page.locator("#bootForm button").click();
    await visible(page.locator(".shell"));
    await page.locator('.side [data-view="equipo"]').click();
    await page.locator("#newUser").click();
    await page.locator("#nn").fill("Equipo de prueba");
    await page.locator("#nu").fill("equipoprueba");
    await page.locator("#np").fill("58360924");
    await page.locator("#vp").uncheck();
    await page.locator("#ns").click();
    await visible(page.getByText("Datos de acceso",{exact:true}));
    await page.getByRole("button",{name:"Listo",exact:true}).click();
    await iniciar(cel,url,"equipoprueba","58360924");
    await page.locator('.side [data-view="ajustes"]:visible').click();
    const ajustesNotificaciones = page.locator(".nt-panel");
    await comprobarAlcanceDeAjustes(page);
    await page.setViewportSize({width:390,height:844});
    await visible(page.locator(".m-tabs"));
    await comprobarAlcanceDeAjustes(page);
    await page.setViewportSize({width:1440,height:900});
    await page.waitForFunction(() => !document.querySelector('[data-nt-tipo="ediciones"]').disabled);
    assert.equal(await ajustesNotificaciones.locator('[data-nt-tipo="ediciones"]').isChecked(),true);
    assert.equal(await ajustesNotificaciones.locator("[data-nt-dispositivo]").isDisabled(),true);
    await ajustesNotificaciones.locator('[data-nt-tipo="nuevos"]').check();
    await visible(ajustesNotificaciones.getByText("Preferencia guardada."));
    await cel.locator('.side [data-act="cuenta"]:visible').click();
    await visible(cel.getByRole("heading",{name:"Mi cuenta"}));
    const cuentaNotificaciones = cel.locator(".nt-panel");
    await cel.waitForFunction(() => !document.querySelector('[data-nt-tipo="ediciones"]').disabled);
    assert.equal(await cuentaNotificaciones.locator('[data-nt-tipo="nuevos"]').isChecked(),false);
    await cuentaNotificaciones.locator('[data-nt-tipo="estado"]').check();
    await visible(cuentaNotificaciones.getByText("Preferencia guardada."));
    await cel.locator(".ov .mh [data-close]").click();
    assert.equal(await ajustesNotificaciones.locator('[data-nt-tipo="estado"]').isChecked(),false);
    await page.locator('.side [data-view="resumen"]:visible').click();
    for (const tab of paginas) {
      await tab.waitForFunction(() => !!navigator.serviceWorker.controller && !!localStorage.getItem("cs-arranque"));
      await tab.reload();
      await visible(tab.locator(".shell"));
      await tab.waitForFunction(() => !!navigator.serviceWorker.controller);
    }

    await Promise.all([desktop.setOffline(true),mobile.setOffline(true)]);
    await Promise.all([
      (async () => {
        await crearSublimado(page,"Tema escritorio",{foto:true,errores:true});
        await crearSublimado(page,"Tema adicional",{telefono:"04140000000"});
      })(),
      crearSublimado(cel,"Tema móvil")
    ]);
    for (const tab of paginas) {
      const enlace = tab.locator('[data-act="cola"]');
      await visible(enlace);
      await oculto(tab.locator(".oc2-code"));
      await tab.reload();
      await visible(enlace);
    }
    await page.locator('[data-act="cola"]').click();
    assert.match(await page.locator('[data-act="cola"]').innerText(), /2 pedidos/);
    await page.locator(".mb details summary").first().click();
    await visible(page.getByText(/Nota Tema Escritorio/i));
    await visible(page.locator(".mb details img").first());
    await page.getByRole("button",{name:"Cerrar",exact:true}).filter({visible:true}).last().click();

    const otraPestana = await desktop.newPage();
    otraPestana.setDefaultTimeout(12000);
    otraPestana.on("pageerror",e => errores.push(e.message));
    await otraPestana.goto(url);
    await visible(otraPestana.locator('[data-act="cola"]'));
    await Promise.all([desktop.setOffline(false),mobile.setOffline(false)]);
    await Promise.all([...paginas,otraPestana].map(tab => oculto(tab.locator('[data-act="cola"]'))));
    await otraPestana.close();
    const pedidosNav = tab => tab.locator('[data-view="pedidos"]').filter({visible:true}).first();
    await Promise.all(paginas.map(async tab => {
      await pedidosNav(tab).click();
      const sublimacion = tab.locator('[data-tab="sublimacion"]');
      if (await sublimacion.isVisible()) await sublimacion.click();
      await tab.waitForFunction(() => [...document.querySelectorAll(".oc2-code")].filter(x => x.offsetWidth).length === 3);
      assert.deepEqual((await tab.locator(".oc2-code:visible").allTextContents()).sort(),["S-0001","S-0002","S-0003"]);
    }));
    assert.equal(await cel.locator('[data-tab="personalizado"]').count(),0);

    await page.setViewportSize({width:1100,height:430});
    for (const [tab, ids] of [[page,["aviso-vencidos","aviso-proximos"]],[cel,["aviso-proximos","aviso-vencidos"]]]) {
      for (const id of ids) {
        await tab.locator('[data-view="resumen"]:visible').first().click();
        await tab.locator(`[data-aviso="${id}"]`).click();
        await comprobarAncla(tab,id);
      }
      await pedidosNav(tab).click();
    }
    await page.setViewportSize({width:1440,height:900});

    await page.locator(".oc2:visible").filter({hasText:/Tema Escritorio/i}).click();
    await visible(page.getByText("Nota Tema Escritorio",{exact:false}));
    assert.match(await page.locator(".pdpay").innerText(),/19\.97/);
    await page.waitForFunction(() => [...document.querySelectorAll(".pdmd img[data-foto]")].filter(img => img.naturalWidth).length === 2);
    const detalle = page.locator(".pdmd"), visor = page.getByRole("dialog",{name:"Referencias"});
    const bytesDe = async (tab, n) => Buffer.from((await tab.locator(".pdmd img[data-foto]").nth(n).getAttribute("src")).split(",")[1],"base64");
    const guardadas = await Promise.all([bytesDe(page,0),bytesDe(page,1)]);
    assert.equal(await detalle.locator(".imgbox button").count(),2);
    assert.equal(await detalle.getByRole("button",{name:/Descargar referencia/}).count(),0);
    await oculto(visor);

    await detalle.getByRole("button",{name:"Abrir referencia 1"}).click();
    await visible(visor);
    assert.equal(await visor.locator(".lbx-prev").isDisabled(),true);
    const icono = visor.getByRole("button",{name:"Descargar foto"});
    await comprobarIconoSobreFoto(icono);
    await visor.locator(".lbx-next").click();
    assert.equal(await visor.locator(".lbx-next").isDisabled(),true);
    await comprobarIconoSobreFoto(icono);
    const original = page.waitForEvent("download");
    await icono.click();
    const imagen = await original;
    assert.match(imagen.suggestedFilename(),/^S-\d+-referencia-02\.png$/);
    assert.deepEqual([...(await readFile(await imagen.path())).subarray(0,8)],[137,80,78,71,13,10,26,10]);
    await page.setViewportSize({width:900,height:460});
    await comprobarIconoSobreFoto(icono);
    assert.equal(await visor.locator('.lbs[aria-hidden="false"] img').evaluate(img => {
      const {top,bottom,left,right} = img.getBoundingClientRect();
      return getComputedStyle(img).objectFit === "contain" && top >= 0 && left >= 0 && bottom <= innerHeight && right <= innerWidth;
    }),true);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await visor.locator(".lbx-prev").isDisabled(),true);
    await comprobarIconoSobreFoto(icono);
    await page.setViewportSize({width:1440,height:900});
    await page.keyboard.press("Escape");
    await oculto(visor);

    const {resumen,fotos} = await descargarPedido(page,[
      /^resumen-pedido-S-\d+\.png$/, /^S-\d+-referencia-01\.png$/, /^S-\d+-referencia-02\.png$/
    ]);
    comprobarCamposPNG(resumen);
    assert.ok(fotos.every(foto => foto.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))));
    assert.match(resumen,/Nota Tema Escritorio\n• Separar prendas\n• Doblar\n• Revisar empaque\nLínea normal/i);
    assert.match(resumen,/19\.97/);
    await oculto(page.locator("#d-download-status"));
    assert.equal(await page.locator("#d-download-status").textContent(),"");
    await comprobarChatsEscritorio(page);

    await cel.locator(".oc2:visible").filter({hasText:/Tema Escritorio/i}).click();
    await oculto(cel.locator("#d-download"));
    const destinoMovil = "https://wa.me/584120000000";
    await simularWhatsApp(mobile,destinoMovil);
    const chatMovil = await abrirChat(cel,destinoMovil);
    assert.ok(await chatMovil.evaluate(() => window.opener === null));
    await chatMovil.close();
    await visible(cel.locator(".pdmd"));
    await cel.getByRole("button",{name:"Abrir referencia 1"}).click();
    const visorMovil = cel.getByRole("dialog",{name:"Referencias"});
    await visible(visorMovil);
    for (const control of [".lbx-prev",".lbx-next",".lbx-down"]) await oculto(visorMovil.locator(control));
    await visorMovil.locator(".lbvp").evaluate(el => {
      for (const [tipo,x] of [["pointerdown",290],["pointermove",105],["pointerup",105]])
        el.dispatchEvent(new PointerEvent(tipo,{bubbles:true,cancelable:true,pointerId:1,pointerType:"touch",clientX:x,clientY:300}));
    });
    assert.equal(await visorMovil.locator(".lbx-next").isDisabled(),true);
    await comprobarZoomMovil(cel,visorMovil);
    await visorMovil.getByRole("button",{name:"Cerrar"}).click();
    await cel.locator(".pdback").click();

    await page.locator("#d-edit").click();
    await page.locator('[data-go="2"]').click();
    await page.locator("#in-fecha").click();
    const selector = page.getByRole("dialog",{name:"Fecha de entrega"});
    await visible(selector.locator('.dpg:not([inert]) button[aria-pressed="true"][aria-label$="3 entregas"]'));
    assert.equal(await selector.locator(".agrow").count(),3);
    assert.equal(await selector.locator(".agrow[data-open]").count(),0);
    await selector.locator(".agrow").first().click();
    await visible(selector);
    await selector.getByRole("button",{name:"Cancelar fecha"}).click();
    await page.locator('[data-go="3"]').click();
    assert.match(await page.locator("#in-nota").inputValue(),/• Doblar\n• Revisar empaque\nLínea normal/);
    await page.locator("#in-nota").fill("Nota editada desde escritorio");
    await page.locator("#save").click();
    await oculto(page.locator("#save"));
    await page.locator(".oc2:visible").filter({hasText:/Tema Escritorio/i}).click();
    await visible(page.getByText("Nota editada desde escritorio",{exact:true}));
    await page.locator("#d-listo").click();
    await visible(page.locator("#pw"));
    const wa = new URL(await page.locator("#pw").getAttribute("href"));
    assert.equal(wa.hostname,"wa.me");
    assert.match(wa.searchParams.get("text"), /19\.97/);
    await page.getByRole("button",{name:"Más tarde",exact:true}).click();
    await page.locator('[data-filtro="avisar"]:visible').click();
    await visible(page.locator(".oc2:visible").filter({hasText:/Tema Escritorio/i}));
    await page.locator('.side [data-view="avisos"]:visible').click();
    await visible(page.locator('#app [data-avisar]'));
    await page.locator('.side [data-view="ajustes"]:visible').click();
    const archivo = page.waitForEvent("download");
    await page.locator("#rLocal").click();
    const respaldo = JSON.parse(await readFile(await (await archivo).path(),"utf8"));
    assert.equal(Object.keys(respaldo.colecciones.pedidos).length,3);
    const [id,guardado] = Object.entries(respaldo.colecciones.pedidos)[0];
    respaldo.colecciones.pedidos = {
      [id]:{...guardado,editadoEn:"2090-01-01T00:00:00Z",nota:"Restauración sintética"}
    };
    await page.locator("#rFile").setInputFiles({
      name:"respaldo-prueba.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(respaldo))
    });
    await page.locator("#okc").click();
    await visible(page.getByText("Restaurado: 0 recuperados, 1 actualizados",{exact:true}));
    // El restablecimiento ocurre antes de que el móvil vuelva a tener contacto con Firestore.
    await mobile.setOffline(true);
    await crearSublimado(cel,"Pedido recuperado",{foto:true,multi:true});
    await visible(cel.locator('[data-act="cola"]'));
    await page.locator('.side [data-view="equipo"]:visible').click();
    await page.locator('[data-utog]').filter({hasText:"Equipo de prueba"}).click();
    await page.locator("[data-reset]").click();
    await page.locator("#okc").click();
    await visible(page.locator(".cred"));
    const nuevoPin = (await page.locator(".cred").innerText()).match(/PIN: (\d{8})/)?.[1];
    assert.ok(nuevoPin);
    await page.getByRole("button",{name:"Listo",exact:true}).click();
    await mobile.setOffline(false);
    await visible(cel.getByRole("heading",{name:"Acceso desactivado"}));
    await cel.locator("#lo").click();
    await visible(cel.locator("#loginForm"));
    await iniciar(cel,null,"equipoprueba",nuevoPin);
    await pedidosNav(cel).click();
    const recuperado = cel.locator(".oc2:visible").filter({hasText:/Pedido Recuperado/i});
    await visible(recuperado);
    await oculto(cel.locator('[data-act="cola"]'));
    assert.equal(await recuperado.count(),1);
    assert.match(await recuperado.innerText(),/S-0004/);
    await recuperado.click();
    await visible(cel.getByText(/Nota Pedido Recuperado/i));
    assert.match(await cel.locator(".pdpay").innerText(),/22\.10/);
    await cel.waitForFunction(() => document.querySelector(".pdmd img[data-foto]")?.naturalWidth > 0);
    await cel.locator(".pdback").click();

    // Simula un pedido y una foto ya existentes antes de actualizar las reglas.
    env = await initializeTestEnvironment({projectId,firestore:{host:dbHost,port:Number(dbPort)}});
    const foto = "referencia-historica";
    const bytes = await readFile(new URL("icono-192.png",root));
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore(), lote = writeBatch(db);
      lote.set(doc(db,"pedidos","pedido-historico"),{
        tipo:"sublimacion",codigo:"S-0011",creadoPor:"equipoprueba",creadoEn:"2024-01-01",fechaEntrega:"2026-12-04",estado:"pendiente",
        tema:"Pedido histórico",nota:"Nota histórica",cliente:{nombre:"Cuenta histórica",telefono:"584120000000"},
        items:[{prenda:"Franela",horma:"Unisex",color:"Fullprint",talla:"M",cant:2}],
        moneda:"USD",precio:5.20,abono:1.00,imagenes:[foto,"foto-inasequible","otra-foto-inasequible"],
        publico:false,lectores:["equipoprueba"],asignados:["adminprueba"],denegados:[]
      });
      lote.set(doc(db,"pedidos","pedido-restringido"),{
        tipo:"sublimacion",codigo:"S-0012",tema:"Pedido restringido",fechaEntrega:"2026-12-04",
        creadoPor:"adminprueba",creadoEn:"2024-01-01",estado:"pendiente",items:[],
        cliente:{nombre:"Cuenta restringida",telefono:"584120000000"},publico:false,lectores:["adminprueba"]
      });
      lote.set(doc(db,"fotos",foto),{data:"data:image/png;base64," + bytes.toString("base64"),por:"equipoprueba"});
      await lote.commit();
    });
    const historico = cel.locator(".oc2:visible").filter({hasText:"Pedido histórico"});
    await visible(historico);
    assert.match(await historico.innerText(),/S-0011/);
    await page.locator('.side [data-view="ajustes"]:visible').click();
    await page.locator("#rFotos").click();
    await page.locator("#okc").click();
    await visible(page.getByText("1 fotos vinculadas",{exact:true}));
    await cel.reload();
    await pedidosNav(cel).click();
    await historico.click();
    assert.match(await cel.locator(".pdpay").innerText(),/9\.40/);
    await visible(cel.getByText("Nota histórica"));
    await cel.waitForFunction(() => document.querySelector(".pdmd img[data-foto]")?.naturalWidth > 0);
    assert.deepEqual(await bytesDe(cel,0),bytes);
    await cel.locator("#d-edit").click();
    await cel.locator('[data-go="2"]').click();
    await cel.locator("#in-fecha").click();
    const agendaRestringida = cel.getByRole("dialog",{name:"Fecha de entrega"});
    await visible(agendaRestringida.locator('.dpg:not([inert]) button[data-d="2026-12-04"][aria-label$="1 entrega"]'));
    assert.equal(await agendaRestringida.locator(".agrow").count(),1);
    assert.doesNotMatch(await agendaRestringida.innerText(),/Cuenta restringida|Pedido restringido/);
    await pedidosNav(page).click();
    await page.locator('[data-filtro="pendientes"]:visible').click();
    await page.locator(".oc2:visible").filter({hasText:"Pedido histórico"}).click();
    const incompleto = await descargarPedido(page,[/^resumen-pedido-S-0011\.png$/,/^S-0011-referencia-01\.png$/]);
    assert.deepEqual(incompleto.fotos,[bytes]);
    await visible(page.getByText("No se pudieron descargar las referencias 02, 03.",{exact:false}));
    assert.match(incompleto.resumen,/9\.40/);
    await page.locator(".pdback").click();

    await page.locator(".oc2:visible").filter({hasText:/Tema Adicional/i}).click();
    const sinFotos = await descargarPedido(page,[/^resumen-pedido-S-\d+\.png$/]);
    assert.deepEqual(sinFotos.fotos,[]);
    await oculto(page.locator("#d-download-status"));
    await page.locator(".pdback").click();

    const historicoLargo = await page.evaluate(async () => {
      const {archivoResumenPng} = await import("/pedido-export.mjs");
      const trazar = CanvasRenderingContext2D.prototype.fillText;
      const cajas = [];
      CanvasRenderingContext2D.prototype.fillText = function(texto,x,y) {
        if (this.canvas.width > 300) {
          const escala = this.getTransform().a, medida = this.measureText(texto);
          const derecha = this.textAlign === "right";
          cajas.push({
            texto,x,y,
            dentro:(x - (derecha ? medida.width : 0)) * escala >= 0 &&
              (x + (derecha ? 0 : medida.width)) * escala <= this.canvas.width &&
              (y + medida.actualBoundingBoxDescent) * escala < this.canvas.height
          });
        }
        return trazar.call(this,texto,x,y);
      };
      try {
        const prendas = Array.from({length:12},(_,i) => [
          "Franela " + (i + 1),"Unisex","M","Azul",2,"","",
          i === 11 ? "Una etiqueta extensa para comprobar que el contenido se ajusta al ancho de la partida".repeat(3) : "",
          "$ 10.11","$ 20.22"
        ]);
        const {datos} = await archivoResumenPng({codigo:"S-0011",datos:[["Cliente","Cliente ficticio"]],prendas,
          pago:[["Saldo","$ 19.97"]], nota:"Una nota extensa con un salto de línea. ".repeat(90) + "\nFin de la nota",seguimiento:[]});
        const ultimas = cajas.filter(c => /^(?:Franela|Fin de la nota)/.test(c.texto));
        return {formato:datos.type,dentro:cajas.every(c => c.dentro),filas:ultimas.map(c => c.texto),
          orden:ultimas.every((c,i) => !i || c.y > ultimas[i-1].y),
          precios:cajas.filter(c => ["$ 10.11","$ 20.22"].includes(c.texto)).slice(0,2).map(c => c.x)};
      } finally {
        CanvasRenderingContext2D.prototype.fillText = trazar;
      }
    });
    assert.equal(historicoLargo.formato,"image/png");
    assert.ok(historicoLargo.dentro && historicoLargo.orden);
    assert.equal(historicoLargo.filas.length,13);
    assert.equal(historicoLargo.filas.at(-2),"Franela 12 azul");
    assert.deepEqual(historicoLargo.precios,[724,884]);
    assert.equal(historicoLargo.filas.at(-1),"Fin de la nota");

    await comprobarEtiquetas(page,env);
    await comprobarCalendariosPorTipo(page);
    const uidAviso = await cel.evaluate(() => JSON.parse(localStorage.getItem("cs-arranque")).uid);
    const entrada = new URL(url);
    entrada.searchParams.set("destino",uidAviso);
    entrada.searchParams.set("aviso","pedido-restringido");
    await cel.goto(entrada.href);
    await visible(cel.getByText(/El pedido no está disponible/));
    assert.equal(await cel.locator(".pdmd").count(),0);
    entrada.searchParams.set("aviso","pedido-historico");
    await cel.goto(entrada.href);
    await visible(cel.locator(".pdmd").getByText("PEDIDO S-0011"));
    assert.equal(new URL(cel.url()).search,"");
    const uidAdmin = await page.evaluate(() => JSON.parse(localStorage.getItem("cs-arranque")).uid);
    const admin = env.authenticatedContext(uidAdmin).firestore();
    await updateDoc(doc(admin,"pedidos","pedido-historico"),{lectores:["adminprueba"],asignados:["equipoprueba"]});
    await cel.goto(entrada.href);
    await visible(cel.getByText(/El pedido no está disponible/));
    assert.equal(await cel.locator(".pdmd").count(),0);
    assert.deepEqual(errores,[]);
    assert.deepEqual(inesperadas,[]);
  } catch(e) {
    if (errores.length) throw new Error(errores.join("\n"), {cause:e});
    throw e;
  } finally {
    await env?.cleanup();
    await navegador?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test("demo independiente: agenda, HEIC, PNG, Etiqueta y WhatsApp sin servicios externos", {timeout:30000}, async () => {
  const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath());
  const navegador = await chromium.launch({executablePath,args:["--no-sandbox"]});
  try {
    const context = await navegador.newContext({viewport:{width:1280,height:800},reducedMotion:"reduce"});
    const externas = [], errores = [];
    await context.route(/^https?:/,route => { externas.push(route.request().url()); return route.abort(); });
    context.on("page",tab => tab.on("pageerror",e => errores.push(e.message)));
    let page = await context.newPage();
    const archivo = new URL("demo/mejoras-pedidos-v369.html",root);
    try { await page.goto(archivo.href); }
    catch (error) {
      if (!error.message.includes("ERR_BLOCKED_BY_ADMINISTRATOR")) throw error;
      // Chromium administrado bloquea file://. El documento se carga en una
      // pestaña vacía con origen opaco y las solicitudes externas bloqueadas.
      await page.close();
      page = await context.newPage();
      await page.setContent(await readFile(archivo,"utf8"));
    }
    await page.getByRole("button",{name:"Vencidos"}).click();
    await comprobarAncla(page,"aviso-vencidos");
    await page.getByRole("button",{name:"Volver a Pedidos"}).click();
    await page.getByRole("button",{name:/P-0042/}).click();
    await page.locator(".pdwa").click();
    await visible(page.getByText("https://web.whatsapp.com/send?phone=12025550142",{exact:true}));
    await page.getByRole("button",{name:"Cerrar",exact:true}).click();
    assert.equal(await page.locator(".pdmd .imgbox button").count(),2);
    assert.equal(await page.getByRole("button",{name:/Descargar referencia/}).count(),0);
    const visor = page.getByRole("dialog",{name:"Referencias"});
    await page.getByRole("button",{name:"Abrir referencia 1"}).click();
    await visor.getByRole("button",{name:"Foto siguiente"}).click();
    assert.equal(await visor.locator('[role="status"]').textContent(),"Foto 2 de 2");
    const fotoActiva = visor.locator('.lbs[aria-hidden="false"] img');
    assert.ok(await fotoActiva.evaluate(img => img.naturalHeight > img.naturalWidth));
    const botonFoto = visor.getByRole("button",{name:"Descargar foto"});
    await comprobarIconoSobreFoto(botonFoto);
    await page.setViewportSize({width:800,height:450});
    await comprobarIconoSobreFoto(botonFoto);
    await page.setViewportSize({width:1280,height:800});
    await visor.getByRole("button",{name:"Cerrar"}).click();
    await page.getByRole("button",{name:"Editar",exact:true}).click();
    await page.getByRole("button",{name:/Prendas/}).click();
    assert.equal(await page.getByLabel("Etiqueta",{exact:true}).count(),2);
    await page.getByRole("button",{name:/Cliente/}).click();
    await page.getByRole("button",{name:"El cliente la trae"}).click();
    await page.getByRole("button",{name:/Prendas/}).click();
    assert.equal(await page.getByLabel("Etiqueta",{exact:true}).count(),0);
    await page.getByRole("button",{name:/Entrega y fotos/}).click();
    await page.locator("#in-fecha").click();
    const calendario = page.getByRole("dialog",{name:"Fecha de entrega"});
    await visible(calendario.getByText("2 entregas",{exact:true}));
    await oculto(calendario.getByText("Equipo Aurora",{exact:true}));
    await calendario.getByRole("button",{name:"+3 días",exact:true}).click();
    await calendario.getByRole("button",{name:"Confirmar fecha"}).click();
    await escribirNotaConListas(page);
    await page.getByRole("button",{name:"Probar HEIC"}).click();
    await visible(page.getByText("Referencia lista para guardar."));
    await page.waitForFunction(() => [...document.querySelectorAll("#imgs img")].at(-1)?.naturalHeight === 96);
    await page.getByRole("button",{name:"Guardar",exact:true}).click();
    const {resumen,fotos,alto} = await descargarPedido(page,[
      /^resumen-pedido-P-0042\.png$/, /^P-0042-referencia-01\.png$/,
      /^P-0042-referencia-02\.png$/, /^P-0042-referencia-03\.png$/
    ]);
    comprobarCamposPNG(resumen);
    assert.equal(fotos.length,3);
    assert.ok(alto < 2400, "Dos partidas deben caber en un resumen compacto");
    assert.match(resumen,/Camisetas del club/);
    assert.match(resumen,/^Chemis verde esmeralda$/m);
    assert.match(resumen,/^Franela Violeta$/m);
    assert.match(resumen,/Talla S · Dama/);
    assert.match(resumen,/\$ 38\.00/);
    assert.match(resumen,/Prenda a cargo de\nCliente/);
    assert.match(resumen,/Confirmar la ubicación del número/);
    assert.match(resumen,/• Doblar\n• Revisar empaque\nLínea normal/);
    assert.match(resumen,/Registrado por/);
    assert.deepEqual(errores,[]);
    assert.deepEqual(externas,[]);
  } finally {
    await navegador.close();
  }
});

test("preview de Notificaciones sin red, con vistas y estados interactivos", {timeout:25000}, async () => {
  const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath());
  const browser = await chromium.launch({executablePath,args:["--no-sandbox"]});
  try {
    const context = await browser.newContext({viewport:{width:1270,height:850}});
    const externas = [];
    await context.route(/^https?:/,r => { externas.push(r.request().url()); return r.abort(); });
    const archivo = new URL("demo/preview-ajustes-notificaciones.html",root);
    let page = await context.newPage();
    try { await page.goto(archivo.href); }
    catch (error) {
      if (!error.message.includes("ERR_BLOCKED_BY_ADMINISTRATOR")) throw error;
      await page.close();
      page = await context.newPage();
      await page.setContent(await readFile(archivo,"utf8"));
    }
    await visible(page.getByText("Vista previa · Datos simulados",{exact:true}));
    page.setDefaultTimeout(7000);
    const marco = page.locator("#marco");
    await comprobarAlcanceDeAjustes(marco);
    assert.equal(await marco.getByRole("button",{name:"Admin",exact:true}).isVisible(),false);
    const dispositivo = marco.locator("[data-nt-dispositivo]");
    assert.equal(await marco.locator('[data-nt-tipo="ediciones"]').isChecked(),true);
    assert.equal(await marco.locator('[data-nt-tipo=""]').first().isDisabled(),true);
    await dispositivo.check();
    await visible(marco.getByText("Activo",{exact:true}));
    await marco.getByRole("button",{name:"Enviar prueba a este dispositivo"}).click();
    await visible(marco.getByText("Notificación de prueba · Datos simulados"));
    await marco.locator('[data-nt-tipo="nuevos"]').check();
    await page.getByLabel("Vista",{exact:true}).selectOption("movil");
    assert.ok((await marco.boundingBox()).width <= 390);
    await visible(marco.getByRole("button",{name:"Admin",exact:true}));
    await comprobarAlcanceDeAjustes(marco);
    assert.equal(await dispositivo.isChecked(),false);
    assert.equal(await marco.locator('[data-nt-tipo="nuevos"]').isChecked(),true);
    await page.getByLabel("Permiso simulado").selectOption("bloqueado");
    await visible(marco.getByText("Bloqueado",{exact:true}));
    await visible(marco.getByText(/Permite las notificaciones en la configuración del navegador/));
    assert.equal(await dispositivo.isDisabled(),true);
    await page.getByLabel("Permiso simulado").selectOption("incompatible");
    await visible(marco.getByText("No compatible",{exact:true}));
    await page.getByLabel("Cuenta",{exact:true}).selectOption("equipo");
    await visible(marco.getByRole("dialog",{name:"Mi cuenta",exact:true}));
    assert.equal(await marco.getByRole("region",{name:"Ajustes de todo el equipo",exact:true}).count(),0);
    assert.equal(await marco.locator('[data-nt-tipo="nuevos"]').isChecked(),false);
    await page.getByLabel("Tema",{exact:true}).selectOption("dark");
    assert.equal(await marco.getAttribute("data-theme"),"dark");
    assert.equal(await marco.evaluate(el => getComputedStyle(el).getPropertyValue("--bg").trim()),"#0e1319");
    await page.setViewportSize({width:350,height:740});
    assert.ok((await page.locator("#marco").boundingBox()).width <= 350);
    assert.deepEqual(externas,[]);
  } finally { await browser.close(); }
});

test("pedidos de 10, 30, 50 y 100 partidas en escritorio y móvil", {timeout:260000}, async t => {
  const {server,url} = await appDePrueba();
  let browser, env;
  try {
    env = await initializeTestEnvironment({projectId,firestore:{host:dbHost,port:Number(dbPort)}});
    await env.clearFirestore();
    const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath());
    browser = await chromium.launch({executablePath,args:["--no-sandbox"]});
    const escritorio = await browser.newContext({viewport:{width:1440,height:900},reducedMotion:"reduce"});
    const movil = await browser.newContext({...devices["Pixel 7"],reducedMotion:"reduce"});
    for (const context of [escritorio,movil]) await context.route(/^https?:/,r => new URL(r.request().url()).hostname === "127.0.0.1" ? r.continue() : r.abort());
    const pc = await escritorio.newPage(), cel = await movil.newPage();
    await pc.goto(url);
    await pc.locator("#bn").fill("Admin de partidas");
    await pc.locator("#bu").fill("adminpartidas");
    await pc.locator("#bp").fill("65034927");
    await pc.locator("#bp2").fill("65034927");
    await pc.locator("#bootForm button").click();
    await visible(pc.locator(".shell"));
    await iniciar(cel,url,"adminpartidas","65034927");
    const marcador = i => "LOTE" + String(i + 1).padStart(3,"0");
    for (const [page,context,perfil] of [[pc,escritorio,"PC"],[cel,movil,"Móvil"]]) {
      page.setDefaultTimeout(20000);
      for (const n of [10,30,50,100]) {
        const tema = `Pedido de ${n} partidas ${perfil}`, mediciones = [];
        const offline = n === 100 && perfil === "Móvil";
        const inicio = performance.now();
        if (offline) await context.setOffline(true);
        await crearSublimado(page,tema,{partidas:n,mediciones});
        if (offline) {
          await visible(page.locator('[data-act="cola"]'));
          await context.setOffline(false);
        }
        const tarjeta = page.locator(".oc2:visible").filter({hasText:tema});
        await visible(tarjeta);
        await tarjeta.click();
        assert.equal(await page.locator(".pdit li").count(),n);
        const total = page.locator(".pdtot");
        assert.ok((await total.innerText()).includes((n * 20.22).toLocaleString("en-US",{minimumFractionDigits:2})));
        const alta = performance.now() - inicio;

        await page.locator("#d-edit").click();
        await page.locator('[data-go="1"]').click();
        await page.evaluate(() => document.querySelector("#dupItem").click());
        await page.locator('.irow3:not(.mini) [data-fld="nombre"]').fill("EXTRA");
        await page.locator('.irow3:not(.mini) [data-cant]').fill("3");
        if (n === 100) {
          await page.locator('[data-go="3"]').click();
          await page.locator("#in-nota").fill("Renglón de prueba\n".repeat(340) + "Último renglón de la nota");
        }
        const id = await tarjeta.getAttribute("data-open");
        const inicioEdicion = performance.now();
        if (offline) {
          await page.waitForFunction(() => !!navigator.serviceWorker.controller && !!localStorage.getItem("cs-arranque"));
          await context.setOffline(true);
        }
        await page.locator("#save").click();
        await oculto(page.locator("#save"));
        if (offline) {
          await visible(page.locator('[data-act="cola"]'));
          await page.reload();
          const conservadas = await page.evaluate(() => new Promise((resolve,reject) => {
            const abrir = indexedDB.open("pedidos-cola-local");
            abrir.onerror = () => reject(abrir.error);
            abrir.onsuccess = () => {
              const db = abrir.result, leer = db.transaction("pedidos").objectStore("pedidos").getAll();
              leer.onsuccess = () => { db.close(); resolve(leer.result); };
              leer.onerror = () => { db.close(); reject(leer.error); };
            };
          }));
          const edicion = conservadas.find(e => e.pedidoId === id);
          assert.equal(edicion.pedido.items.length,101);
          assert.equal(edicion.pedido.items.at(-1).nombre,"EXTRA");
          await context.setOffline(false);
          await page.reload();
          await visible(page.locator(".shell"));
        }
        assert.ok(id);
        let guardado;
        const limite = performance.now() + 15000;
        await env.withSecurityRulesDisabled(async contexto => {
          const ref = doc(contexto.firestore(),"pedidos",id);
          do {
            guardado = (await getDocFromServer(ref)).data();
            if (guardado?.items.length === n + 1) break;
            await new Promise(r => setTimeout(r,100));
          } while (performance.now() < limite);
        });
        await oculto(page.locator('[data-act="cola"]'));
        await page.locator('[data-view="pedidos"]:visible').first().click();
        await page.locator('[data-tab="sublimacion"]').click();
        await tarjeta.click();
        assert.equal(await page.locator(".pdit li").count(),n + 1);
        assert.ok((await page.locator(".pdit li").last().innerText()).includes("30.33"));
        assert.equal(guardado.totalMenor,n * 2022 + 3033);
        assert.equal(guardado.abonoMenor,25);
        assert.equal(guardado.items.at(-1).nombre,"EXTRA");
        assert.equal(guardado.autorAviso.uid,guardado.creadorUid);
        const editar = performance.now() - inicioEdicion;

        const inicioPNG = performance.now();
        const descargas = [];
        const registrar = d => descargas.push(d);
        await page.evaluate(() => {
          const original = CanvasRenderingContext2D.prototype.fillText;
          window.filasPNG = [];
          CanvasRenderingContext2D.prototype.fillText = function(texto,x,y,...resto) {
            const {d,f} = this.getTransform(), yy = d * y + f;
            if (this.canvas.width > 300 && yy >= 0 && yy + d * this.measureText(texto).actualBoundingBoxDescent <= this.canvas.height)
              window.filasPNG.push(String(texto));
            return original.call(this,texto,x,y,...resto);
          };
          window.restaurarPNG = () => { CanvasRenderingContext2D.prototype.fillText = original; };
        });
        page.on("download",registrar);
        if (perfil === "PC") await Promise.all([page.waitForEvent("download"),page.locator("#d-download").click()]);
        else await page.locator("#d-download").click();
        await page.waitForFunction(() => !document.querySelector("#d-download").disabled);
        const estado = page.locator("#d-download-status");
        assert.doesNotMatch(await estado.innerText(),/No se pudo/);
        if (n === 100) {
          const botones = estado.getByRole("button",{name:/^PNG \d+ de \d+$/});
          assert.ok(await botones.count() >= 2);
          for (let i = 0; i < await botones.count(); i++) await Promise.all([
            page.waitForEvent("download",{predicate:d => d.suggestedFilename().endsWith(`-parte-${i+1}.png`)}),
            botones.nth(i).click()
          ]);
        } else if (perfil === "Móvil") {
          await Promise.all([page.waitForEvent("download"),estado.getByRole("button",{name:"Descargar PNG",exact:true}).click()]);
        }
        for (const archivo of descargas) {
          const png = await readFile(await archivo.path());
          assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
          assert.ok(png.readUInt32BE(20) <= 8192);
        }
        const filas = await page.evaluate(() => { window.restaurarPNG(); return window.filasPNG.join("\n"); });
        for (let i = 0; i < n; i++) assert.match(filas,new RegExp(marcador(i)));
        assert.match(filas,/EXTRA/);
        assert.match(filas,/30\.33/);
        if (n === 100) assert.match(filas,/Último renglón de la nota/);
        page.off("download",registrar);
        const png = performance.now() - inicioPNG;

        await page.locator("#d-listo").click();
        const link = page.locator("#pw");
        await visible(link);
        let texto;
        if (await link.getAttribute("data-wa-texto")) {
          await link.click();
          const campo = page.getByRole("textbox",{name:"Texto completo de la parte"});
          const selector = page.getByLabel("Parte del mensaje",{exact:true});
          texto = await campo.inputValue();
          if (await selector.count()) for (let i = 1; i < await selector.locator("option").count(); i++) {
            await selector.selectOption(String(i));
            texto += await campo.inputValue();
          }
          await campo.locator("xpath=ancestor::*[contains(@class,'ov')][1]").getByRole("button",{name:"Cancelar"}).click();
        } else texto = new URL(await link.getAttribute("href")).searchParams.get("text");
        for (let i = 0; i < n; i++) assert.match(texto,new RegExp(marcador(i)));
        assert.match(texto,/EXTRA.*30\.33/);
        await page.getByRole("button",{name:"Más tarde",exact:true}).click();
        await page.locator('[data-view="resumen"]:visible').first().click();
        t.diagnostic(`${perfil}, ${n} partidas: duplicar ${Math.round(mediciones[0])} ms, alta ${Math.round(alta)} ms, edición ${Math.round(editar)} ms, PNG ${Math.round(png)} ms`);
      }
    }

    // Los dos dispositivos editan la misma versión. El segundo conserva su copia local.
    const temaCompartido = "Pedido de 10 partidas PC";
    let idCompartido;
    for (const [page,nota] of [[pc,"Cambio de escritorio"],[cel,"Cambio del móvil conservado"]]) {
      await page.locator('[data-view="pedidos"]:visible').first().click();
      await page.locator('[data-filtro="avisar"]:visible').click();
      await page.locator('[data-tab="sublimacion"]').click();
      const tarjeta = page.locator(".oc2:visible").filter({hasText:temaCompartido});
      idCompartido = await tarjeta.getAttribute("data-open");
      await tarjeta.click();
      await page.locator("#d-edit").click();
      await page.locator('[data-go="3"]').click();
      await page.locator("#in-nota").fill(nota);
    }
    await pc.locator("#save").click();
    await oculto(pc.locator('[data-act="cola"]'));
    await env.withSecurityRulesDisabled(async contexto => {
      const ref = doc(contexto.firestore(),"pedidos",idCompartido);
      const fin = performance.now() + 15000;
      while ((await getDocFromServer(ref)).data().nota !== "Cambio de escritorio" && performance.now() < fin)
        await new Promise(r => setTimeout(r,100));
      assert.equal((await getDocFromServer(ref)).data().nota,"Cambio de escritorio");
    });
    await cel.locator("#save").click();
    await cel.locator('[data-act="cola"]').click();
    await cel.locator(".mb details summary").click();
    await visible(cel.getByText("Cambio del móvil conservado",{exact:false}));
    const copia = cel.waitForEvent("download");
    await cel.getByRole("button",{name:"Descargar edición pendiente"}).click();
    const rescatado = JSON.parse(await readFile(await (await copia).path(),"utf8"));
    assert.equal(rescatado.pedido.nota,"Cambio del móvil conservado");
    assert.equal(rescatado.pedido.items.length,11);

    // El mismo archivo contiene un pedido largo nuevo y una actualización de uno existente.
    let respaldo;
    await env.withSecurityRulesDisabled(async contexto => {
      respaldo = (await getDocFromServer(doc(contexto.firestore(),"pedidos",idCompartido))).data();
    });
    assert.equal(respaldo.nota,"Cambio de escritorio");
    const {consecutivo,creadorUid, ...sinIdentidad} = respaldo;
    const idNuevo = "restaurado-largo-e2e";
    const archivos = {app:"comicshop-pedidos",creado:"2090-01-01",colecciones:{pedidos:{
      [idCompartido]:{...respaldo,nota:"Recuperado desde respaldo",editadoEn:"2090-01-01T00:00:00Z"},
      [idNuevo]:{...sinIdentidad,tema:"Importado largo nuevo",codigo:"S-2000"}
    }}};
    await pc.locator('.side [data-view="ajustes"]:visible').click();
    await pc.locator("#rFile").setInputFiles({name:"pedidos-grandes.json",mimeType:"application/json",
      buffer:Buffer.from(JSON.stringify(archivos))});
    await pc.locator("#okc").click();
    await visible(pc.getByText("Restaurado: 1 recuperados, 1 actualizados",{exact:true}));
    await env.withSecurityRulesDisabled(async contexto => {
      const db = contexto.firestore();
      for (const id of [idCompartido,idNuevo]) {
        const efectivo = (await getDocFromServer(doc(db,"pedidos",id))).data();
        assert.deepEqual(efectivo.items,respaldo.items);
        assert.equal(efectivo.totalMenor,respaldo.totalMenor);
        assert.equal(efectivo.abonoMenor,respaldo.abonoMenor);
        assert.equal(efectivo.autorAviso,undefined);
      }
    });
  } finally {
    await env?.cleanup();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
