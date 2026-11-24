import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { chromium, devices } from "playwright-core";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDocFromServer, writeBatch } from "firebase/firestore";

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
const oculto = selector => selector.waitFor({state:"hidden"});
async function descargarPedido(page, nombres) {
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
  } finally {
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
  assert.match(resumen,/Cantidad: \d/);
  assert.match(resumen,/Talla: /);
  assert.doesNotMatch(resumen,/RESUMEN DEL PEDIDO|\b[PS]-\d{4}\b|Teléfono|Estado|Urgente|Moneda|584120000000|12025550142/);
}

async function comprobarIconoSobreFoto(icono) {
  await visible(icono);
  assert.ok(await icono.evaluate(b => {
    const foto = b.parentElement.querySelector("img");
    const a = b.getBoundingClientRect(), f = foto.getBoundingClientRect();
    return a.width >= 44 && a.height >= 44 && Math.abs(f.right - a.right - 4) <= 2 &&
      Math.abs(a.top - f.top - 4) <= 2 && a.right <= innerWidth;
  }));
}

async function comprobarChat(page, destino) {
  const enlace = page.locator(".pdwa"), contexto = page.context();
  await contexto.route(destino, ruta => ruta.fulfill({contentType:"text/plain",body:"WhatsApp simulado"}));
  assert.equal(await enlace.getAttribute("href"),destino);
  const popup = contexto.waitForEvent("page");
  await enlace.click();
  const chat = await popup;
  await chat.waitForURL(destino);
  assert.equal(await chat.locator("body").innerText(),"WhatsApp simulado");
  await chat.close();
  await visible(page.locator(".pdmd"));
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
  await page.locator("#in-tel").fill("04120000000");
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
  await page.locator("#in-nota").fill("Nota " + tema);
  if (opciones.foto) {
    const entrada = page.locator("#fileGal");
    if (opciones.errores) {
      await entrada.setInputFiles({name:"invalida.heic",mimeType:"image/heic",buffer:Buffer.from("invalida")});
      await visible(page.getByText(/No se pudo (abrir|convertir) la foto HEIC/).first());
      assert.equal(await page.locator("#in-nota").inputValue(), "Nota " + tema);
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
        await crearSublimado(page,"Tema adicional");
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
    assert.match(imagen.suggestedFilename(),/^S-\d+-referencia-02\.(webp|jpg)$/);
    assert.deepEqual(await readFile(await imagen.path()),guardadas[1]);
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
      /^resumen-pedido-S-\d+\.png$/, /^S-\d+-referencia-01\.(webp|jpg)$/, /^S-\d+-referencia-02\.(webp|jpg)$/
    ]);
    comprobarCamposPNG(resumen);
    assert.deepEqual(fotos,guardadas);
    assert.match(resumen,/Nota Tema Escritorio/i);
    assert.match(resumen,/19\.97/);
    await visible(page.locator("#d-download-status"));
    assert.match(await page.locator("#d-download-status").textContent(),/elige Permitir/);
    await comprobarChat(page,"https://web.whatsapp.com/send/?phone=584120000000");

    await cel.locator(".oc2:visible").filter({hasText:/Tema Escritorio/i}).click();
    await oculto(cel.locator("#d-download"));
    await comprobarChat(cel,"https://wa.me/584120000000");
    await cel.getByRole("button",{name:"Abrir referencia 1"}).click();
    const visorMovil = cel.getByRole("dialog",{name:"Referencias"});
    await visible(visorMovil);
    for (const control of [".lbx-prev",".lbx-next",".lbx-down"]) await oculto(visorMovil.locator(control));
    await visorMovil.locator(".lbvp").evaluate(el => {
      for (const [tipo,x] of [["pointerdown",290],["pointermove",105],["pointerup",105]])
        el.dispatchEvent(new PointerEvent(tipo,{bubbles:true,cancelable:true,pointerId:1,pointerType:"touch",clientX:x,clientY:300}));
    });
    assert.equal(await visorMovil.locator(".lbx-next").isDisabled(),true);
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
        moneda:"USD",precio:5.20,abono:1.00,imagenes:[foto,"foto-inasequible","otra-foto-inasequible"],publico:true,lectores:["equipoprueba"]
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
            texto,y,
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
        const ultimas = cajas.filter(c => /^(?:\d+\. Franela|Fin de la nota)/.test(c.texto));
        return {formato:datos.type,dentro:cajas.every(c => c.dentro),filas:ultimas.map(c => c.texto),
          orden:ultimas.every((c,i) => !i || c.y > ultimas[i-1].y)};
      } finally {
        CanvasRenderingContext2D.prototype.fillText = trazar;
      }
    });
    assert.equal(historicoLargo.formato,"image/png");
    assert.ok(historicoLargo.dentro && historicoLargo.orden);
    assert.equal(historicoLargo.filas.length,13);
    assert.equal(historicoLargo.filas.at(-2),"12. Franela 12");
    assert.equal(historicoLargo.filas.at(-1),"Fin de la nota");

    await comprobarEtiquetas(page,env);
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
    await page.getByRole("button",{name:/P-0042/}).click();
    await page.locator(".pdwa").click();
    await visible(page.getByText("https://web.whatsapp.com/send/?phone=12025550142",{exact:true}));
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
    await calendario.getByRole("button",{name:"+3 días",exact:true}).click();
    await calendario.getByRole("button",{name:"Confirmar fecha"}).click();
    await page.getByRole("button",{name:"Probar HEIC"}).click();
    await visible(page.getByText("Referencia lista para guardar."));
    await page.waitForFunction(() => [...document.querySelectorAll("#imgs img")].at(-1)?.naturalHeight === 96);
    await page.getByRole("button",{name:"Guardar",exact:true}).click();
    const {resumen,fotos,alto} = await descargarPedido(page,[
      /^resumen-pedido-P-0042\.png$/, /^P-0042-referencia-01\.jpg$/,
      /^P-0042-referencia-02\.jpg$/, /^P-0042-referencia-03\.(jpg|webp)$/
    ]);
    comprobarCamposPNG(resumen);
    assert.equal(fotos.length,3);
    assert.ok(alto < 2400, "Dos partidas deben caber en un resumen compacto");
    assert.match(resumen,/Camisetas del club/);
    assert.match(resumen,/1\. Franela/);
    assert.match(resumen,/2\. Franela/);
    assert.match(resumen,/\$ 38\.00/);
    assert.match(resumen,/Prenda a cargo de\nCliente/);
    assert.match(resumen,/Confirmar la ubicación del número/);
    assert.match(resumen,/Registrado por/);
    assert.deepEqual(errores,[]);
    assert.deepEqual(externas,[]);
  } finally {
    await navegador.close();
  }
});
