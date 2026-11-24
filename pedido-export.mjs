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

const ancho = 960;
const margen = 48;
const interior = ancho - margen * 2;
const fuente = "system-ui, sans-serif";
const azul = "#14233a";
const tinta = "#192a40";
const suave = "#4c6078";
const acento = "#ffb379";
const columnasPrenda = ["Prenda","Horma","Talla","Color","Cantidad","Nombre","Número","Etiqueta","Precio unitario","Subtotal"];
const disponible = valor => valor !== undefined && valor !== null && String(valor).trim() !== "";

function partirTexto(ctx, valor, limite) {
  const lineas = [];
  for (const parrafo of String(valor).split(/\r?\n/)) {
    let linea = "";
    for (const palabra of parrafo.trim().split(/\s+/)) {
      const propuesta = linea ? linea + " " + palabra : palabra;
      if (ctx.measureText(propuesta).width <= limite) { linea = propuesta; continue; }
      if (linea) lineas.push(linea);
      linea = "";
      if (ctx.measureText(palabra).width <= limite) { linea = palabra; continue; }
      for (const letra of palabra) {
        if (linea && ctx.measureText(linea + letra).width > limite) {
          lineas.push(linea);
          linea = "";
        }
        linea += letra;
      }
    }
    lineas.push(linea);
  }
  return lineas;
}

function dibujarResumen(ctx, resumen) {
  ctx.textBaseline = "top";
  const escribir = (valor, x, y, limite, {px = 22, peso = 600, color = tinta, paso = px + 8} = {}) => {
    ctx.font = `${peso} ${px}px ${fuente}`;
    ctx.fillStyle = color;
    const lineas = partirTexto(ctx,valor,limite);
    lineas.forEach((s,i) => ctx.fillText(s,x,y + i * paso));
    return paso * lineas.length;
  };
  const caja = (x, y, w, h, color, radio = 18) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x,y,w,h,radio);
    ctx.fill();
  };
  const campos = (pares, x, y, w, columnas, {fondo, destacado = false} = {}) => {
    const gap = 16, celda = (w - gap * (columnas - 1)) / columnas;
    const tam = destacado ? 28 : 21;
    for (let i = 0; i < pares.length; i += columnas) {
      const fila = pares.slice(i,i + columnas);
      ctx.font = `700 ${tam}px ${fuente}`;
      const lineas = Math.max(...fila.map(([,v]) => partirTexto(ctx,v,celda - 28).length));
      const alto = 45 + lineas * (tam + 8);
      fila.forEach(([clave,valor], j) => {
        const pos = x + j * (celda + gap);
        if (fondo) caja(pos,y,celda,alto,destacado && clave === "Saldo" ? "#e0f3e9" : fondo,12);
        escribir(clave,pos + 14,y + 12,celda - 28,{px:14,peso:700,color:suave});
        escribir(valor,pos + 14,y + 34,celda - 28,{px:tam,peso:700});
      });
      y += alto + 8;
    }
    return y;
  };
  const activos = pares => pares.filter(([,v]) => disponible(v));
  const encabezado = (nombre,y) => {
    caja(margen,y + 5,6,25,"#d2561c",3);
    escribir(nombre,margen + 18,y,interior - 18,{px:25,peso:800});
    return y + 44;
  };

  const franja = ctx.createLinearGradient(0,0,ancho,0);
  franja.addColorStop(0,azul);
  franja.addColorStop(1,"#29496a");
  const codigo = resumen.codigo || "Pedido";
  ctx.font = `800 49px ${fuente}`;
  const altoCodigo = partirTexto(ctx,codigo,interior - 64).length * 57;
  ctx.font = `600 22px ${fuente}`;
  const altoTipo = disponible(resumen.tipo) ? partirTexto(ctx,resumen.tipo,interior - 64).length * 30 : 0;
  const altoFranja = Math.max(174,110 + altoCodigo + altoTipo);
  caja(margen,36,interior,altoFranja,franja,24);
  caja(margen + 32,68,48,5,acento,3);
  escribir("RESUMEN DEL PEDIDO",margen + 32,86,interior - 64,{px:18,peso:800,color:acento});
  escribir(codigo,margen + 32,114,interior - 64,{px:49,peso:800,color:"#fff"});
  if (disponible(resumen.tipo))
    escribir(resumen.tipo,margen + 34,120 + altoCodigo,interior - 64,{px:22,color:"#e1edf9"});

  let y = 66 + altoFranja;
  const datos = activos(resumen.datos);
  if (datos.length) y = campos(datos,margen,encabezado("Datos del pedido",y),interior,2,{fondo:"#fff"}) + 18;

  if (resumen.prendas.length) {
    y = encabezado("Prendas",y);
    for (const [indice, prenda] of resumen.prendas.entries()) {
      const altoTitulo = escribir(disponible(prenda[0]) ? `${indice + 1}. ${prenda[0]}` : `Partida ${indice + 1}`,
        margen + 14,y + 7,interior - 28,{px:22,peso:800});
      const pares = activos(columnasPrenda.slice(1).map((col,i) => [col,prenda[i + 1]]));
      y = campos(pares,margen,y + altoTitulo + 12,interior,3,{fondo:"#fff"}) + 12;
    }
    y += 10;
  }

  const pago = activos(resumen.pago);
  if (pago.length) {
    y = encabezado("Pago",y);
    const montos = pago.filter(([clave]) => ["Total","Abono","Saldo"].includes(clave));
    y = campos(montos,margen,y,interior,3,{fondo:"#e7eff8",destacado:true});
    y = campos(pago.filter(par => !montos.includes(par)),margen,y,interior,2,{fondo:"#fff"}) + 18;
  }

  if (disponible(resumen.nota)) {
    y = encabezado("Notas",y);
    ctx.font = `500 22px ${fuente}`;
    const altoNota = partirTexto(ctx,resumen.nota,interior - 36).length * 32;
    caja(margen,y,interior,altoNota + 36,"#fff1e5");
    escribir(resumen.nota,margen + 18,y + 18,interior - 36,{px:22,peso:500,paso:32});
    y += altoNota + 62;
  }

  const seguimiento = activos(resumen.seguimiento);
  if (seguimiento.length)
    y = campos(seguimiento,margen,encabezado("Seguimiento",y),interior,2,{fondo:"#fff"});
  return y + 28;
}

export async function archivoResumenPng(resumen) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const alto = dibujarResumen(ctx,resumen);
  // Mantiene la proporción en pedidos históricos con muchas partidas.
  const escala = Math.min(1.5, 8192 / alto);
  canvas.width = Math.ceil(ancho * escala);
  canvas.height = Math.ceil(alto * escala);
  ctx.scale(escala,escala);
  ctx.fillStyle = "#f3f6fb";
  ctx.fillRect(0,0,ancho,alto);
  dibujarResumen(ctx,resumen);
  const datos = await new Promise(resolve => canvas.toBlob(resolve,"image/png"));
  if (!datos) throw new Error("No se pudo generar el PNG");
  return {nombre:`resumen-pedido-${codigoParaArchivo(resumen.codigo)}.png`,tipo:"image/png",datos};
}
