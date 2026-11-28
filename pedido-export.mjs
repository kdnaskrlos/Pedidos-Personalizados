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

// Convierte las fotos almacenadas a un PNG real. Cambiar solo el nombre
// o la extensión no convertiría los bytes JPEG/WebP de Firestore.
export async function archivoReferenciaPng(src, indice) {
  const original = archivoReferencia(src, indice);
  const nombre = `referencia-${String(indice + 1).padStart(2, "0")}.png`;
  if (original.tipo === "image/png") return {...original, nombre};
  const fuente = new Blob([original.datos], {type:original.tipo});
  let imagen;
  try {
    imagen = await createImageBitmap(fuente);
    const lienzo = document.createElement("canvas");
    lienzo.width = imagen.width;
    lienzo.height = imagen.height;
    const contexto = lienzo.getContext("2d");
    if (!contexto) throw new Error("No se puede convertir la referencia a PNG");
    contexto.drawImage(imagen, 0, 0);
    const png = await new Promise((resolve, reject) => lienzo.toBlob(
      archivo => archivo ? resolve(archivo) : reject(new Error("No se pudo crear el PNG")), "image/png"
    ));
    return {nombre, tipo:"image/png", datos:png};
  } finally {
    imagen?.close?.();
  }
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

const palabras = texto => String(texto).normalize("NFD").replace(/\p{M}/gu,"")
  .toLocaleLowerCase("es").replace(/[^\p{L}\p{N}]+/gu," ").trim();

function nombrePrenda(nombre, color) {
  const base = nombre || "Prenda";
  if (!disponible(color) || ` ${palabras(base)} `.includes(` ${palabras(color)} `)) return base;
  return `${base} ${String(color).toLocaleLowerCase("es")}`;
}

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

function dibujarResumen(ctx, resumen, marcarCorte = () => {}, inicioPagina = 0) {
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
      marcarCorte(y);
    }
    return y;
  };
  const activos = pares => pares.filter(([,v]) => disponible(v));

  let y = 40;
  const datos = activos(resumen.datos);
  if (resumen.titulo || datos.length) {
    caja(margen,y + 5,6,25,"#d2561c",3);
    escribir(resumen.titulo,margen + 18,y,interior - 18,{px:25,peso:800});
    y = campos(datos,margen,y + 44,interior,2,{fondo:"#fff"}) + 24;
  }

  if (resumen.prendas.length) {
    for (const prenda of resumen.prendas) {
      const [nombre,horma,talla,color,cantidad,personalizado,numero,etiqueta,unitario,subtotal,separador] = prenda;
      // El corte al final de la fila anterior suprime el divisor al iniciar página.
      if (separador) {
        if (y > inicioPagina) {
          ctx.fillStyle = "#000000";
          ctx.fillRect(margen + 16,y + 4,interior - 32,1);
        }
        y += 12;
      }
      const montos = activos([["c/u",unitario],["Subtotal",subtotal]]);
      const anchoImporte = 152, separacion = 8, pad = 16;
      const ladoCantidad = 52, gap = 12;
      const tieneCantidad = disponible(cantidad);
      const desplazamiento = tieneCantidad ? ladoCantidad + gap : 0;
      const anchoDatos = interior - 2 * pad - montos.length * (anchoImporte + separacion) - desplazamiento;
      const titulo = medir(nombrePrenda(nombre,color),anchoDatos,{px:23,peso:800});
      const atributos = [disponible(talla) && `Talla ${talla}`,horma,etiqueta,personalizado,disponible(numero) && `N° ${numero}`]
        .filter(v => v !== false && disponible(v)).join(" · ");
      const detalle = atributos ? medir(atributos,anchoDatos,{px:16,peso:500}) : null;
      const altoTexto = titulo.alto + (detalle?.alto || 0);
      const importes = montos.map(([clave,valor]) => {
        const destacado = clave === "Subtotal";
        return {destacado, rotulo:medir(clave,anchoImporte - 24,{px:14,peso:700}),
          valor:medir(valor,anchoImporte - 24,{px:destacado ? 21 : 19,peso:700})};
      });
      const alto = Math.max(altoTexto + 24,tieneCantidad ? ladoCantidad + 24 : 0,
        ...importes.map(({rotulo,valor}) => rotulo.alto + valor.alto + 32));
      caja(margen,y,interior,alto,"#fff",12);

      if (tieneCantidad) {
        const x = margen + pad, top = y + (alto - ladoCantidad) / 2;
        caja(x,top,ladoCantidad,ladoCantidad,"#f0f2f5",8);
        ctx.font = `800 28px ${fuente}`;
        const px = Math.min(28, 28 * (ladoCantidad - 8) / ctx.measureText(String(cantidad)).width);
        escribir(cantidad,x + ladoCantidad / 2,top + (ladoCantidad - px) / 2,ladoCantidad - 4,
          {px,peso:800,alineado:"center"});
      }
      const textoX = margen + pad + desplazamiento, textoY = y + (alto - altoTexto) / 2;
      trazar(titulo,textoX,textoY);
      if (detalle) trazar(detalle,textoX,textoY + titulo.alto,{color:suave});
      importes.forEach(({destacado,rotulo,valor},i) => {
        const x = margen + interior - pad - (importes.length - i) * (anchoImporte + separacion) + separacion;
        const altoImporte = rotulo.alto + valor.alto + 16;
        const top = y + (alto - altoImporte) / 2;
        if (destacado) caja(x,top,anchoImporte,altoImporte,"#e7eff8",10);
        trazar(rotulo,x + anchoImporte - 12,top + 8,{color:suave,alineado:"right"});
        trazar(valor,x + anchoImporte - 12,top + 8 + rotulo.alto,{alineado:"right"});
      });
      y += alto + 8;
      marcarCorte(y);
    }
    y += 16;
  }

  const pago = activos(resumen.pago);
  if (pago.length) {
    const montos = pago.filter(([clave]) => ["Total","Abono","Saldo"].includes(clave));
    y = campos(montos,margen,y,interior,3,{fondo:"#e7eff8",destacado:true});
    y = campos(pago.filter(par => !montos.includes(par)),margen,y,interior,2,{fondo:"#fff"}) + 18;
  }

  if (disponible(resumen.nota)) {
    ctx.font = `500 22px ${fuente}`;
    const lineas = partirTexto(ctx,resumen.nota,interior - 36).length;
    const altoNota = lineas * 32;
    caja(margen,y,interior,altoNota + 36,"#fff1e5");
    escribir(resumen.nota,margen + 18,y + 18,interior - 36,{px:22,peso:500,paso:32});
    for (let linea = 1; linea < lineas; linea++) marcarCorte(y + 18 + linea * 32);
    y += altoNota + 62;
  }

  const seguimiento = activos(resumen.seguimiento);
  if (seguimiento.length)
    y = campos(seguimiento,margen,y,interior,2,{fondo:"#fff"});
  return y + 28;
}

export async function archivoResumenPng(resumen) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const alto = dibujarResumen(ctx,resumen);
  return renderizarPagina(canvas,ctx,resumen,0,alto,"");
}

async function renderizarPagina(canvas,ctx,resumen,inicio,fin,sufijo) {
  const margenPagina = sufijo ? 24 : 0;
  const alto = fin - inicio + 2 * margenPagina;
  // Mantiene la proporción en pedidos históricos con muchas partidas.
  const escala = Math.min(1.5, 8192 / alto);
  canvas.width = Math.ceil(ancho * escala);
  canvas.height = Math.min(8192,Math.ceil(alto * escala));
  ctx.scale(escala,escala);
  ctx.fillStyle = "#f3f6fb";
  ctx.fillRect(0,0,ancho,alto);
  ctx.beginPath();
  ctx.rect(0,margenPagina,ancho,fin - inicio);
  ctx.clip();
  ctx.translate(0,margenPagina - inicio);
  dibujarResumen(ctx,resumen,undefined,inicio);
  const datos = await new Promise(resolve => canvas.toBlob(resolve,"image/png"));
  if (!datos) throw new Error("No se pudo generar el PNG");
  return {nombre:`resumen-pedido-${codigoParaArchivo(resumen.codigo)}${sufijo}.png`,tipo:"image/png",datos};
}

export async function archivosResumenPng(resumen) {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"), cortes = [];
  const alto = dibujarResumen(ctx,resumen,y => cortes.push(y));
  const maximo = 11000;
  if (alto <= maximo) return [await renderizarPagina(canvas,ctx,resumen,0,alto,"")];
  const paginas = [];
  let inicio = 0;
  const finales = [...cortes,alto];
  for (const [i,fin] of finales.entries()) {
    if (fin <= inicio) continue;
    if (fin !== alto && fin <= inicio + maximo && finales[i + 1] <= inicio + maximo) continue;
    paginas.push(await renderizarPagina(canvas,ctx,resumen,inicio,fin,`-parte-${paginas.length + 1}`));
    inicio = fin;
  }
  return paginas;
}
