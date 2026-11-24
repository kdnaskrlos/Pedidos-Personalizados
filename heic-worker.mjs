import iniciarLibheif from "./vendor/libheif-bundle.mjs";

function cajas(vista, inicio, fin) {
  const lista = [];
  for (let i = inicio; i + 8 <= fin;) {
    let largo = vista.getUint32(i), cabecera = 8;
    if (largo === 1) {
      if (i + 16 > fin) break;
      largo = Number(vista.getBigUint64(i + 8));
      cabecera = 16;
    }
    if (largo === 0) largo = fin - i;
    if (largo < cabecera || i + largo > fin) break;
    const tipo = String.fromCharCode(...new Uint8Array(vista.buffer, i + 4, 4));
    lista.push({tipo, inicio:i + cabecera, fin:i + largo});
    i += largo;
  }
  return lista;
}

// libheif aplica irot/imir al decodificar. Consultar las asociaciones de la
// imagen primaria evita volver a girarla si el archivo también trae EXIF.
function orientacionDelContenedor(bytes) {
  const v = new DataView(bytes);
  const meta = cajas(v, 0, v.byteLength).find(c => c.tipo === "meta");
  if (!meta) return false;
  const hijos = cajas(v, meta.inicio + 4, meta.fin);
  const pitm = hijos.find(c => c.tipo === "pitm"), iprp = hijos.find(c => c.tipo === "iprp");
  if (!pitm || !iprp) return false;
  const primaria = v.getUint8(pitm.inicio) ? v.getUint32(pitm.inicio + 4) : v.getUint16(pitm.inicio + 4);
  const propiedades = cajas(v, iprp.inicio, iprp.fin);
  const ipco = propiedades.find(c => c.tipo === "ipco");
  if (!ipco) return false;
  const atributos = cajas(v, ipco.inicio, ipco.fin);
  for (const caja of propiedades.filter(c => c.tipo === "ipma")) {
    const id32 = v.getUint8(caja.inicio) !== 0, indices16 = (v.getUint8(caja.inicio + 3) & 1) === 1;
    const entradas = v.getUint32(caja.inicio + 4);
    let pos = caja.inicio + 8;
    for (let i = 0; i < entradas && pos + (id32 ? 5 : 3) <= caja.fin; i++) {
      const id = id32 ? v.getUint32(pos) : v.getUint16(pos);
      pos += id32 ? 4 : 2;
      const n = v.getUint8(pos++);
      if (pos + n * (indices16 ? 2 : 1) > caja.fin) break;
      for (let j = 0; j < n; j++) {
        const indice = indices16 ? v.getUint16(pos) & 0x7fff : v.getUint8(pos) & 0x7f;
        pos += indices16 ? 2 : 1;
        const propiedad = atributos[indice - 1];
        if (id === primaria && (propiedad?.tipo === "imir" ||
          (propiedad?.tipo === "irot" && propiedad.inicio < propiedad.fin && (v.getUint8(propiedad.inicio) & 3)))) return true;
      }
    }
  }
  return false;
}

function orientacionTiff(vista) {
  const tiff = 4 + vista.getUint32(0);
  const orden = vista.getUint16(tiff), little = orden === 0x4949;
  if ((!little && orden !== 0x4d4d) || vista.getUint16(tiff + 2,little) !== 42) return;
  const tabla = tiff + vista.getUint32(tiff + 4,little), entradas = vista.getUint16(tabla,little);
  for (let i = 0, pos = tabla + 2; i < entradas && pos + 12 <= vista.byteLength; i++, pos += 12) {
    if (vista.getUint16(pos,little) === 0x112 && vista.getUint16(pos+2,little) === 3 &&
      vista.getUint32(pos+4,little) === 1) return vista.getUint16(pos+8,little);
  }
}

function orientacionExif(heif, imagen) {
  // Puntero de la imagen primaria de la versión local de libheif-js.
  const handle = imagen.handle?.$$?.ptr;
  if (!handle) return;
  const filtro = heif._malloc(5), ids = heif._malloc(4), error = heif._malloc(16);
  let destino = 0;
  try {
    heif.HEAPU8.set([69,120,105,102,0],filtro); // Exif
    if (heif._heif_image_handle_get_list_of_metadata_block_IDs(handle,filtro,ids,1) !== 1) return;
    const id = new DataView(heif.HEAPU8.buffer).getUint32(ids,true);
    const n = heif._heif_image_handle_get_metadata_size(handle,id);
    if (n < 12 || n > 1_048_576) return;
    destino = heif._malloc(n);
    if (!destino) return;
    heif._heif_image_handle_get_metadata(error,handle,id,destino);
    const memoria = heif.HEAPU8.buffer;
    if (new DataView(memoria).getInt32(error,true) === 0) return orientacionTiff(new DataView(memoria,destino,n));
  } finally {
    for (const p of [destino,error,ids,filtro]) heif._free(p);
  }
}

self.onmessage = async ({data:archivo}) => {
  try {
    const bytes = await archivo.arrayBuffer();
    const heif = await iniciarLibheif();
    const decodificador = new heif.HeifDecoder();
    const imagenes = decodificador.decode(new Uint8Array(bytes));
    const imagen = imagenes.find(i => i.is_primary()) || imagenes[0];
    if (!imagen) throw new Error("El archivo no contiene una imagen HEIC legible");
    const ancho = imagen.get_width(), alto = imagen.get_height();
    if (!(ancho > 0 && alto > 0) || ancho * alto > 64_000_000)
      throw new Error("La imagen HEIC es demasiado grande para convertirla");
    const pixeles = new Uint8ClampedArray(ancho * alto * 4);
    await new Promise((resolve, reject) => {
      imagen.display({data:pixeles,width:ancho,height:alto}, resultado =>
        resultado ? resolve() : reject(new Error("No se pudo decodificar la imagen HEIC")));
    });
    let exif;
    try { if (!orientacionDelContenedor(bytes)) exif = orientacionExif(heif, imagen); }
    catch { /* La imagen sigue siendo válida si los metadatos opcionales están dañados. */ }
    const orientacion = Number.isInteger(exif) && exif >= 1 && exif <= 8 ? exif : 1;
    self.postMessage({ancho,alto,pixeles:pixeles.buffer,orientacion}, [pixeles.buffer]);
  } catch(e) {
    self.postMessage({error:e.message || "No se pudo convertir la imagen HEIC"});
  }
};
