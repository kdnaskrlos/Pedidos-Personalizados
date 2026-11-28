import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function appDePrueba(arranque = "boot();",workerInicial,claveVapid = "") {
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
      ${arranque}
    `);
  const sdk = new Map();
  const server = createServer(async (req,res) => {
    const path = new URL(req.url,"http://127.0.0.1").pathname;
    try {
      let data;
      if (path === "/" || path === "/index.html") {
        res.setHeader("Content-Type",mime.html);
        data = html;
      } else if (path === "/sw.js" && workerInicial) {
        res.setHeader("Content-Type",mime.js);
        res.setHeader("Cache-Control","no-store");
        data = workerInicial;
      } else if (path === "/config.js") {
        // No se abre config.js del repositorio.
        res.setHeader("Content-Type",mime.js);
        data = "export const firebaseConfig = " + JSON.stringify({projectId,apiKey:"demo-key",appId:"1:123:web:synthetic",authDomain:"127.0.0.1"});
      } else if (path === "/push-config.mjs") {
        // El registro FCM real se verifica por separado de los emuladores.
        res.setHeader("Content-Type",mime.mjs);
        data = `export const claveVapid = ${JSON.stringify(claveVapid)}; export const regionAvisos = "us-central1";`;
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
  return {server,url:"http://127.0.0.1:" + server.address().port,publicarWorker:() => { workerInicial = null; }};
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

function comprobarCamposPNG(resumen, titulo = "SUBLIMACIÓN COMPLETA") {
  const lineas = resumen.split("\n");
  for (const campo of [titulo,"Creación","Entrega","Cliente","Tema","Subtotal","Total","Abono","Saldo"])
    assert.ok(lineas.includes(campo),campo);
  for (const omitido of ["Datos del pedido","Prendas","Pago","Notas","Seguimiento"])
    if (omitido !== titulo) assert.ok(!lineas.includes(omitido),omitido);
  if (titulo === "Datos del pedido") assert.ok(lineas.includes("Precio unitario"));
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

async function comprobarEdicionFueraDeFoto(visor) {
  const editar = visor.getByRole("button",{name:"Editar imagen"});
  await visible(editar);
  await visor.page().waitForFunction(() => {
    const area = document.querySelector(".lbvp").getBoundingClientRect();
    const foto = document.querySelector('.lbs[aria-hidden="false"] img').getBoundingClientRect();
    const boton = document.querySelector(".lbx-ed").getBoundingClientRect();
    return Math.abs(boton.right - Math.min(foto.right,area.right)) <= 2 &&
      Math.abs(boton.top - Math.min(foto.bottom,area.bottom) - 6) <= 2 &&
      boton.bottom <= innerHeight && boton.left >= 0;
  },null,{timeout:2500});
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
    await comprobarEdicionFueraDeFoto(visor);
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
    await comprobarEdicionFueraDeFoto(visor);
    await visor.locator(".lbx-next").click();
    assert.equal(await visor.locator(".lbx-next").isDisabled(),true);
    await comprobarIconoSobreFoto(icono);
    await comprobarEdicionFueraDeFoto(visor);
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
    assert.doesNotMatch(resumen,/Prenda a cargo de/);
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
    const uidAnterior = await cel.evaluate(async () => (await import("/sdk/firebase-auth.js")).getAuth().currentUser.uid);
    await cel.evaluate(uid => globalThis.almacenAvisos.cambiar(() => ({
      uid,id:crypto.randomUUID(),generacion:crypto.randomUUID(),habilitado:true,entrega:true,registrado:true
    })),uidAnterior);
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
    await cel.waitForFunction(async uid => {
      const estado = await globalThis.almacenAvisos.leer();
      return estado?.uid === uid && !estado.habilitado && !estado.entrega && !document.querySelector(".shell");
    },uidAnterior);
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
    comprobarCamposPNG(resumen,"Datos del pedido");
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
        if (page === cel) await page.locator('[data-tab="sublimacion"]').click();
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
      if (page === cel) await page.locator('[data-tab="sublimacion"]').click();
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

test("issue 13: búsqueda, detalle, visor y PNG con datos ficticios", {timeout:45000}, async () => {
  const {server,url} = await appDePrueba(`
    const partidas = [
      ["3XL","Primer Plus",1], ["M","Adulto uno",3], ["Especial","Talla histórica",1],
      ["8","Infantil ocho",1], ["S","Adulto ese",1], ["6","Infantil seis",1], ["M","Adulto dos",1]
    ].map(([talla,nombre,cant]) => ({
      talla,nombre,cant,prenda:"Franela",horma:"Unisex",color:"Azul",etiqueta:"Serie Taller",precioMenor:4800000
    }));
    const pers = {
      _id:"personalizado",tipo:"personalizado",codigo:"P-0042",estado:"pendiente",tema:"Equipo Horizonte",
      cliente:{nombre:"Cliente Ficticio"},fechaEntrega:"2026-12-03",creadoEn:"2026-11-28",creadoPor:"ana",
      editadoEn:"2026-11-28T10:30:00",editadoPor:"leo",revisarEn:"2026-11-28",revisarCambios:["Tema"],etiqueta:"Etiqueta General",
      prendaDe:"cliente",items:partidas,moneda:"COP",pagoVersion:2,abonoMenor:12000000,nota:"Separar las tallas por paquete."
    };
    const sub = {
      ...pers,_id:"sublimacion",tipo:"sublimacion",codigo:"S-0043",estado:"entregado",tema:"Festival Aurora",
      editadoEn:"",editadoPor:"leo",moneda:"USD",pagoVersion:1,precio:19.97,abono:10
    };
    const referencia = (w,h) => {
      const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
      canvas.width = w; canvas.height = h;
      ctx.fillStyle = "#e4eef3"; ctx.fillRect(0,0,w,h);
      ctx.fillStyle = "#254463"; ctx.beginPath();
      const puntos = [[.35,.19],[.44,.13],[.56,.13],[.65,.19],[.83,.29],[.74,.47],[.66,.42],
        [.66,.86],[.34,.86],[.34,.42],[.26,.47],[.17,.29]];
      puntos.forEach(([x,y],i) => i ? ctx.lineTo(x*w,y*h) : ctx.moveTo(x*w,y*h));
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#eab464"; ctx.fillRect(w*.34,h*.57,w*.32,h*.08);
      ctx.fillStyle = "#fff"; ctx.textAlign = "center";
      ctx.font = "bold " + Math.round(Math.min(w,h)*.055) + "px system-ui";
      ctx.fillText("HORIZONTE",w*.5,h*.51);
      return {src:canvas.toDataURL()};
    };
    Object.assign(S,{
      me:{activo:true,nombre:"Ana Muestra",usuario:"ana",rol:"admin"},uid:"ana",online:false,
      auth:{currentUser:{uid:"ana"}},view:"pedidos",pedidos:{personalizado:pers,sublimacion:sub},
      usuarios:{ana:{usuario:"ana",nombre:"Ana Muestra"},leo:{usuario:"leo",nombre:"Leo Ejemplo"}}
    });
    window.muestra = {
      visor:editable => lightbox([referencia(480,620),referencia(700,365)],{editar:editable ? () => {} : undefined}),
      exportar:async id => {
        const {archivosResumenPng} = await import("./pedido-export.mjs");
        return archivosResumenPng(modeloExportable(S.pedidos[id]));
      }
    };
    render();
  `);
  const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath());
  const navegador = await chromium.launch({executablePath,args:["--no-sandbox"]});
  const carpeta = process.env.PEDIDOS_VISTAS_ISSUE_13;
  if (carpeta) await mkdir(carpeta,{recursive:true});
  try {
    for (const [perfil,opciones] of [
      ["escritorio",{viewport:{width:1280,height:900}}],
      ["movil",devices["Pixel 7"]]
    ]) {
      const page = await navegador.newPage({...opciones,reducedMotion:"reduce"});
      await page.route(/^https?:/,r => new URL(r.request().url()).hostname === "127.0.0.1" ? r.continue() : r.abort());
      await page.goto(url);
      const buscar = page.getByRole("textbox",{name:"Buscar pedidos"});
      const limpiar = page.getByRole("button",{name:"Limpiar búsqueda"});
      const pendientes = page.locator('[data-filtro="pendientes"]');
      const entregados = page.locator('[data-filtro="entregados"]');
      await oculto(limpiar);
      await entregados.click();
      await buscar.fill("Horizonte");
      await visible(page.locator(".oc2:visible").filter({hasText:"Equipo Horizonte"}));
      await visible(limpiar);
      if (carpeta) await page.screenshot({path:`${carpeta}/busqueda-${perfil}.png`,animations:"disabled"});
      await limpiar.click();
      await visible(page.locator(".oc2:visible").filter({hasText:"Festival Aurora"}));
      assert.equal(await entregados.getAttribute("aria-pressed"),"true");
      assert.equal(await buscar.inputValue(),"");
      assert.equal(await buscar.evaluate(e => e === document.activeElement),true);
      await oculto(limpiar);

      const detalle = page.locator(".pdmd");
      await page.locator(".oc2:visible").filter({hasText:"Festival Aurora"}).click();
      assert.match(await detalle.locator(".pdit li").nth(3).innerText(),/Adulto uno.*\n.*59\.91\s*\nUnidad:.*19\.97/s);
      await detalle.getByRole("button",{name:"Volver"}).click();
      await pendientes.click();
      await page.locator(".oc2:visible").filter({hasText:"Equipo Horizonte"}).click();
      const filas = detalle.locator(".pdit li");
      const nombres = ["Infantil seis","Infantil ocho","Adulto ese","Adulto uno","Adulto dos","Primer Plus","Talla histórica"];
      const textos = await filas.allTextContents();
      assert.deepEqual(textos.map(t => nombres.find(n => t.includes(n))),nombres);
      assert.deepEqual(await filas.evaluateAll(fs => fs.flatMap((f,i) => f.classList.contains("separador") ? [i] : [])),[2,5,6]);
      assert.match(await filas.nth(3).innerText(),/144[.\s]000\s*\nUnidad:.*48[.\s]000/);
      assert.match(await filas.first().locator(".pr").innerText(),/^COP 48[.\s]000$/);
      assert.equal(await filas.locator(".pr small").count(),1);
      if (perfil === "movil") await page.evaluate(() => document.documentElement.dataset.theme = "dark");
      if (carpeta) {
        await detalle.locator(".pdrow").first().evaluate(fila => {
          const cuerpo = fila.closest(".pdb");
          cuerpo.scrollTop += fila.getBoundingClientRect().top - cuerpo.getBoundingClientRect().top - 14;
        });
        await page.screenshot({path:`${carpeta}/detalle-${perfil}.png`,animations:"disabled"});
      }
      await detalle.getByRole("button",{name:"Volver"}).click();

      await page.evaluate(() => window.muestra.visor(true));
      const visor = page.getByRole("dialog",{name:"Referencias"});
      await comprobarEdicionFueraDeFoto(visor);
      if (carpeta && perfil === "movil") await page.screenshot({path:`${carpeta}/visor-${perfil}.png`,animations:"disabled"});
      await visor.press("ArrowRight");
      await comprobarEdicionFueraDeFoto(visor);
      if (carpeta && perfil === "escritorio") await page.screenshot({path:`${carpeta}/visor-${perfil}.png`,animations:"disabled"});
      await visor.getByRole("button",{name:"Cerrar"}).click();
      await page.evaluate(() => window.muestra.visor(false));
      await visible(visor.locator('.lbs[aria-hidden="false"] img'));
      assert.equal(await visor.getByRole("button",{name:"Editar imagen"}).count(),0);
      await visor.getByRole("button",{name:"Cerrar"}).click();

      if (perfil === "escritorio") {
        for (const tipo of ["personalizado","sublimacion"]) {
          const {lineas,divisores,datos} = await page.evaluate(async ({tipo,guardarPNG}) => {
            const proto = CanvasRenderingContext2D.prototype, {fillText,fillRect} = proto;
            const lineas = [], divisores = [];
            proto.fillText = function(texto,...args) {
              if (this.canvas.width > 300) lineas.push(texto);
              return fillText.call(this,texto,...args);
            };
            proto.fillRect = function(x,y,w,h) {
              if (this.canvas.width > 300 && h === 1) divisores.push(lineas.length);
              return fillRect.call(this,x,y,w,h);
            };
            try {
              const [png] = await window.muestra.exportar(tipo);
              const datos = guardarPNG ? Array.from(new Uint8Array(await png.datos.arrayBuffer())) : null;
              return {lineas,divisores,datos};
            } finally { Object.assign(proto,{fillText,fillRect}); }
          },{tipo,guardarPNG:!!carpeta});
          const personalizado = tipo === "personalizado";
          comprobarCamposPNG(lineas.join("\n"),personalizado ? "PERSONALIZADO" : "SUBLIMACIÓN COMPLETA");
          assert.equal(lineas.includes("Prenda a cargo de"),personalizado);
          assert.equal(lineas.filter(l => l === "Unidad").length,1);
          assert.equal(lineas.filter(l => l === "Subtotal").length,nombres.length);
          assert.ok(lineas.some(l => l.includes("Serie Taller")));
          assert.deepEqual(lineas.slice(personalizado ? -5 : -4),["Registrado por","Ana Muestra","Última edición por",
            ...(personalizado ? ["Leo Ejemplo","28/11/2026 10:30 am"] : ["—"])]);
          assert.ok(!lineas.some(l => ["Etiqueta General","Cambio por revisar","Editado por"].includes(l)));
          assert.deepEqual(lineas.flatMap(t => nombres.filter(n => t.includes(n))),nombres);
          assert.deepEqual(divisores.map(i => nombres.find(n => lineas.slice(i,i+4).join(" ").includes(n))),
            ["Adulto ese","Primer Plus","Talla histórica"]);
          if (carpeta) await writeFile(`${carpeta}/resumen-${tipo}.png`,Buffer.from(datos));
        }
      }
      await page.close();
    }
  } finally {
    await navegador.close();
    server.close();
  }
});

test("una actualización PWA conserva la intención y el estado pendiente con IndexedDB real", {timeout:30000}, async () => {
  const anterior = 'self.addEventListener("install",()=>self.skipWaiting()); self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));';
  const {server,url,publicarWorker} = await appDePrueba("",anterior);
  const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath());
  let navegador;
  try {
    navegador = await chromium.launch({executablePath,args:["--no-sandbox"]});
    const page = await navegador.newPage({...devices["Pixel 7"]});
    await page.route(/^https?:/,r => new URL(r.request().url()).hostname === "127.0.0.1" ? r.continue() : r.abort());
    await page.goto(url);
    await page.evaluate(async () => {
      const registro = {uid:"ana",id:crypto.randomUUID(),generacion:crypto.randomUUID(),habilitado:true,entrega:true};
      await globalThis.almacenAvisos.cambiar(() => registro);
      await caches.open("pedidos-v185");
      await (await caches.open("pedidos-push-v1")).put("/.pedidos-push/dispositivo",new Response(JSON.stringify(registro)));
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    publicarWorker();
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update().then(() => {}));
    await page.waitForFunction(async () => {
      const claves = await caches.keys();
      return claves.includes("pedidos-v186") && !claves.includes("pedidos-v185");
    });
    await page.evaluate(() => caches.delete("pedidos-push-v1"));
    await page.reload();
    const estado = await page.evaluate(() => globalThis.almacenAvisos.leer());
    assert.equal(estado.uid,"ana");
    assert.equal(estado.habilitado,true);
    await page.evaluate(async () => {
      const {panelNotificaciones} = await import("/notificaciones-ui.mjs");
      document.querySelector("#app").innerHTML = panelNotificaciones({estado:"pendiente",preferencias:{},habilitado:true});
    });
    await visible(page.getByText("Pendiente de verificación",{exact:true}));
    assert.equal(await page.locator("[data-nt-dispositivo]").isChecked(),true);
    assert.equal(await page.locator("[data-nt-dispositivo]").isEnabled(),true);
    assert.equal(await page.locator("[data-nt-prueba]").isDisabled(),true);
  } finally {
    await navegador?.close();
    server.close();
  }
});

test("escritorio: recupera una vinculación v3.70.6 con el mismo ID tras el rechazo de FCM", {timeout:35000}, async () => {
  // El worker previo y su Cache Storage representan una instalación v3.70.6.
  const anterior = 'self.addEventListener("install",()=>self.skipWaiting()); self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));';
  const {server,url,publicarWorker} = await appDePrueba(`
    window.comprobarAvisos = async dispositivo => {
      const {montarPanelNotificaciones} = await import("./notificaciones-ui.mjs");
      let suscripcionAnterior = true, lectura = 0, guardado;
      const reg = await navigator.serviceWorker.getRegistration();
      Object.defineProperty(reg.pushManager,"getSubscription",{value:async () => ({
        unsubscribe:async () => { suscripcionAnterior = false; return true; }
      })});
      // getRegistration devuelve un objeto distinto por llamada en algunos navegadores.
      Object.defineProperty(PushManager.prototype,"getSubscription",{configurable:true,value:reg.pushManager.getSubscription});
      const api = crearNotificaciones({
        sesion:() => ({uid:"ana"}),app:() => ({}),actualizar:() => window.dibujarAvisos?.(),
        cargarMessaging:async () => ({
          isSupported:async () => true,getMessaging:() => ({}),
          getToken:async () => "token-ficticio-sin-credenciales-" + (suscripcionAnterior ? "anterior" : "nuevo"),
          deleteToken:async () => { throw Object.assign(new Error("Detalle privado ficticio"),{code:"messaging/token-unsubscribe-failed"}); }
        }),
        datos:{
          guardarDispositivo:async (uid,id,token,vigente,comprobar) => {
            await vigente();
            lectura++;
            if (comprobar) return false;
            guardado = {id,nuevo:token.endsWith("-nuevo")};
            return true;
          }
        }
      });
      window.dibujarAvisos = montarPanelNotificaciones(document.querySelector("#app"),api);
      await api.cambiarSesion("ana",false);
      window.reintentarAvisos = async () => {
        const reloj = Date.now;
        Date.now = () => reloj() + 6000;
        try { await api.renovar(); }
        finally { Date.now = reloj; }
        return {guardado,lectura,conservado:(await globalThis.almacenAvisos.leer()).id === dispositivo};
      };
    };
  `,anterior,"simulada");
  const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath());
  let navegador;
  try {
    navegador = await chromium.launch({executablePath,args:["--no-sandbox"]});
    const context = await navegador.newContext({viewport:{width:1440,height:900},permissions:["notifications"]});
    await context.route(/^https?:/,r => new URL(r.request().url()).hostname === "127.0.0.1" ? r.continue() : r.abort());
    const page = await context.newPage();
    await page.goto(url);
    const dispositivo = await page.evaluate(async () => {
      const id = crypto.randomUUID();
      await caches.open("pedidos-v183");
      await (await caches.open("pedidos-push-v1")).put("/.pedidos-push/dispositivo",new Response(JSON.stringify({
        uid:"ana",id,renovado:Date.now() - 8 * 86400000
      })));
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      return id;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    publicarWorker();
    await page.evaluate(async () => {
      const cambio = new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange",resolve,{once:true}));
      await (await navigator.serviceWorker.getRegistration()).update();
      await cambio;
    });
    const otra = await context.newPage();
    await otra.goto(url);
    await otra.evaluate(() => new Promise(resolve => {
      navigator.locks.request("pedidos-push-registro",() => new Promise(soltar => {
        window.soltarRegistro = soltar;
        resolve();
      }));
    }));
    await page.reload();
    await page.evaluate(dispositivo => window.comprobarAvisos(dispositivo),dispositivo);
    await visible(page.getByText("Pendiente de verificación",{exact:true}));
    assert.match(await page.locator("[data-nt-diagnostico]").innerText(),/otra-pestana/);
    assert.equal(await page.locator("[data-nt-dispositivo]").isChecked(),true);
    assert.equal(await page.locator("[data-nt-prueba]").isDisabled(),true);
    await otra.close();
    const resultado = await page.evaluate(() => window.reintentarAvisos());
    assert.deepEqual(resultado,{guardado:{id:dispositivo,nuevo:true},lectura:2,conservado:true});
    await visible(page.getByText("Activo",{exact:true}));
    assert.equal(await page.locator("[data-nt-prueba]").isEnabled(),true);
  } finally {
    await navegador?.close();
    server.close();
  }
});
