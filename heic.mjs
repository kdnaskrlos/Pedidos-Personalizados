export const FORMATOS_FOTO = "image/*,.heic,.heif,image/heic,image/heif,image/heic-sequence,image/heif-sequence";

export function esHeif(archivo) {
  return /\.hei[cf]$/i.test(archivo.name || "") || /^image\/(?:x-)?hei[cf](?:-sequence)?$/i.test(archivo.type || "");
}

export async function cargarHeif(archivo) {
  const trabajador = new Worker(new URL("./heic-worker.mjs", import.meta.url), {type:"module"});
  try {
    const {ancho, alto, pixeles, orientacion} = await new Promise((resolve, reject) => {
      trabajador.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data);
      trabajador.onerror = () => reject(new Error("No se pudo cargar el conversor HEIC"));
      trabajador.onmessageerror = () => reject(new Error("No se pudo recibir la imagen HEIC"));
      trabajador.postMessage(archivo);
    });
    const original = document.createElement("canvas");
    original.width = ancho;
    original.height = alto;
    original.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixeles), ancho, alto), 0, 0);
    if (orientacion === 1) return original;
    const canvas = document.createElement("canvas");
    canvas.width = orientacion >= 5 ? alto : ancho;
    canvas.height = orientacion >= 5 ? ancho : alto;
    const matrices = {
      2:[-1,0,0,1,ancho,0], 3:[-1,0,0,-1,ancho,alto], 4:[1,0,0,-1,0,alto],
      5:[0,1,1,0,0,0], 6:[0,1,-1,0,alto,0], 7:[0,-1,-1,0,alto,ancho], 8:[0,-1,1,0,0,ancho]
    };
    const contexto = canvas.getContext("2d");
    contexto.setTransform(...matrices[orientacion]);
    contexto.drawImage(original,0,0);
    return canvas;
  } finally {
    trabajador.terminate();
  }
}
