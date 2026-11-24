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
const tinta = "#192a40";
const suave = "#4c6078";
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
  const medir = (valor, limite, {px = 22, peso = 600, paso = px + 8} = {}) => {
    const font = `${peso} ${px}px ${fuente}`;
    ctx.font = font;
    const lineas = partirTexto(ctx,valor,limite);
    return {font,lineas,paso,alto:paso * lineas.length};
  };
  const trazar = (texto, x, y, {color = tinta, alineado = "left"} = {}) => {
    ctx.font = texto.font;
    ctx.fillStyle = color;
    ctx.textAlign = alineado;
    texto.lineas.forEach((s,i) => ctx.fillText(s,x,y + i * texto.paso));
  };
  const escribir = (valor, x, y, limite, estilo) => trazar(medir(valor,limite,estilo),x,y,estilo);
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

  let y = 40;
  const datos = activos(resumen.datos);
  if (datos.length) y = campos(datos,margen,encabezado("Datos del pedido",y),interior,2,{fondo:"#fff"}) + 24;

  if (resumen.prendas.length) {
    y = encabezado("Prendas",y);
    for (const [indice, prenda] of resumen.prendas.entries()) {
      const [nombre,horma,talla,color,cantidad,personalizado,numero,etiqueta,unitario,subtotal] = prenda;
      const montos = activos([["Precio unitario",unitario],["Subtotal",subtotal]]);
      const anchoImporte = 140, separacion = 8, pad = 16;
      const anchoDatos = interior - 2 * pad - montos.length * (anchoImporte + separacion);
      const unir = pares => activos(pares).map(([clave,valor]) => `${clave}: ${valor}`).join(" · ");
      const titulo = nombre ? `${indice + 1}. ${nombre}` : `Partida ${indice + 1}`;
      const principal = unir([["Cantidad",cantidad],["Talla",talla],["Horma",horma],["Color",color]]);
      const secundario = unir([["Nombre",personalizado],["Número",numero],["Etiqueta",etiqueta]]);
      const filas = [
        medir(titulo,anchoDatos,{px:23,peso:800}),
        ...(principal ? [medir(principal,anchoDatos,{px:18,peso:700})] : []),
        ...(secundario ? [medir(secundario,anchoDatos,{px:16,peso:500})] : [])
      ];
      const importes = montos.map(([clave,valor]) => {
        const destacado = clave === "Subtotal";
        return {destacado, rotulo:medir(clave,anchoImporte - 24,{px:14,peso:700}),
          valor:medir(valor,anchoImporte - 24,{px:destacado ? 21 : 19,peso:700})};
      });
      const alto = Math.max(filas.reduce((total,f) => total + f.alto,0) + 24,
        ...importes.map(({rotulo,valor}) => rotulo.alto + valor.alto + 32));
      caja(margen,y,interior,alto,"#fff",12);

      let filaY = y + 12;
      filas.forEach((f,i) => {
        trazar(f,margen + pad,filaY,{color:i === 0 ? tinta : suave});
        filaY += f.alto;
      });
      importes.forEach(({destacado,rotulo,valor},i) => {
        const x = margen + interior - pad - (importes.length - i) * (anchoImporte + separacion) + separacion;
        const altoImporte = rotulo.alto + valor.alto + 16;
        const top = y + (alto - altoImporte) / 2;
        if (destacado) caja(x,top,anchoImporte,altoImporte,"#e7eff8",10);
        trazar(rotulo,x + anchoImporte - 12,top + 8,{color:suave,alineado:"right"});
        trazar(valor,x + anchoImporte - 12,top + 8 + rotulo.alto,{alineado:"right"});
      });
      y += alto + 8;
    }
    y += 16;
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
