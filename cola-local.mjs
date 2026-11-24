const NOMBRE = "pedidos-cola-local";
let conexion;

function abrir() {
  if (!conexion) {
    conexion = new Promise((resolve, reject) => {
      const request = indexedDB.open(NOMBRE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const pedidos = db.createObjectStore("pedidos", {keyPath:["owner","id"]});
        pedidos.createIndex("owner", "owner");
        db.createObjectStore("fotos", {keyPath:["owner","id"]});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      conexion = null;
      throw error;
    });
  }
  return conexion;
}

async function operar(nombre, modo, accion) {
  const db = await abrir();
  return new Promise((resolve, reject) => {
    const tx = modo === "readwrite" ? db.transaction(nombre, modo, {durability:"strict"}) : db.transaction(nombre, modo);
    const request = accion(tx.objectStore(nombre));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(request.error || tx.error);
  });
}

export const guardarPendiente = pedido => operar("pedidos", "readwrite", s => s.add(pedido));
export const leerPendientes = owner => operar("pedidos", "readonly", s => s.index("owner").getAll(owner));
export const borrarPendiente = (owner, id) => operar("pedidos", "readwrite", s => s.delete([owner, id]));
export const guardarFotoLocal = foto => operar("fotos", "readwrite", s => s.put(foto));
export const leerFotoLocal = (owner, id) => operar("fotos", "readonly", s => s.get([owner, id]));
export const borrarFotoLocal = (owner, id) => operar("fotos", "readwrite", s => s.delete([owner, id]));
