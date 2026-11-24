import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { chromium, devices } from "playwright-core";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, writeBatch } from "firebase/firestore";
import { unzipSync } from "../vendor/fflate.mjs";

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
    await detalle.getByRole("button",{name:"Abrir referencia 1"}).click();
    await visible(visor);
    assert.equal(await visor.locator(".lbx-prev").isDisabled(),true);
    await visor.locator(".lbx-next").click();
    assert.equal(await visor.locator(".lbx-next").isDisabled(),true);
    await page.keyboard.press("ArrowLeft");
    const original = page.waitForEvent("download");
    await visor.getByRole("button",{name:"Descargar foto"}).click();
    const imagen = await original;
    assert.match(imagen.suggestedFilename(),/^S-\d+-referencia-01\.(webp|jpg)$/);
    assert.deepEqual(await readFile(await imagen.path()),guardadas[0]);
    await page.setViewportSize({width:900,height:460});
    assert.equal(await visor.locator(".lbs img").first().evaluate(img => {
      const {top,bottom,left,right} = img.getBoundingClientRect();
      return getComputedStyle(img).objectFit === "contain" && top >= 0 && left >= 0 && bottom <= innerHeight && right <= innerWidth;
    }),true);
    await page.setViewportSize({width:1440,height:900});
    await page.keyboard.press("Escape");
    await oculto(visor);
    const archivoPedido = page.waitForEvent("download");
    await detalle.getByRole("button",{name:"Descargar",exact:true}).click();
    const zip = await archivoPedido;
    assert.match(zip.suggestedFilename(),/^pedido-S-\d+\.zip$/);
    const entradas = unzipSync(await readFile(await zip.path()));
    const resumen = Buffer.from(entradas[Object.keys(entradas).find(n => n.endsWith(".html"))]).toString();
    assert.match(resumen,/Nota Tema Escritorio/i);
    assert.match(resumen,/19\.97/);
    assert.doesNotMatch(resumen,/<img|data:image/);
    assert.deepEqual(Object.keys(entradas).filter(n => n.startsWith("imagenes/")).map(n => Buffer.from(entradas[n])),guardadas);

    await cel.locator(".oc2:visible").filter({hasText:/Tema Escritorio/i}).click();
    await oculto(cel.locator("#d-download"));
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
        moneda:"USD",precio:5.20,abono:1.00,imagenes:[foto],publico:true,lectores:["equipoprueba"]
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

test("demo HTML desde disco: agenda, HEIC y ZIP sin servicios externos", {timeout:30000}, async () => {
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
    await page.getByRole("button",{name:/S-0042/}).click();
    const visor = page.getByRole("dialog",{name:"Referencias"});
    await page.getByRole("button",{name:"Abrir referencia 1"}).click();
    await visor.getByRole("button",{name:"Foto siguiente"}).click();
    assert.equal(await visor.locator('[role="status"]').textContent(),"Foto 2 de 2");
    await visor.getByRole("button",{name:"Cerrar"}).click();
    await page.getByRole("button",{name:"Editar",exact:true}).click();
    await page.locator("#in-fecha").click();
    const calendario = page.getByRole("dialog",{name:"Fecha de entrega"});
    await visible(calendario.getByText("2 entregas",{exact:true}));
    await calendario.getByRole("button",{name:"+3 días",exact:true}).click();
    await calendario.getByRole("button",{name:"Confirmar fecha"}).click();
    await page.getByRole("button",{name:"Probar HEIC"}).click();
    await visible(page.getByText("Referencia lista para guardar."));
    await page.waitForFunction(() => [...document.querySelectorAll("#imgs img")].at(-1)?.naturalHeight === 96);
    await page.getByRole("button",{name:"Guardar",exact:true}).click();
    const descarga = page.waitForEvent("download");
    await page.getByRole("button",{name:"Descargar",exact:true}).click();
    const zip = unzipSync(await readFile(await (await descarga).path()));
    assert.equal(Object.keys(zip).length,4);
    assert.match(Buffer.from(zip["resumen-pedido-S-0042.html"]).toString(),/Camisetas del club/);
    assert.deepEqual(errores,[]);
    assert.deepEqual(externas,[]);
  } finally {
    await navegador.close();
  }
});
