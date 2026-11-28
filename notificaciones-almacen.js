// Compartido por la aplicación y el service worker. Guarda IDs locales, nunca tokens.
globalThis.almacenAvisos = (() => {
  let apertura;
  function abrir() {
    return apertura ??= new Promise((resolve,reject) => {
      const solicitud = indexedDB.open("pedidos-avisos",1);
      solicitud.onupgradeneeded = () => solicitud.result.createObjectStore("estado");
      solicitud.onerror = () => reject(solicitud.error);
      solicitud.onsuccess = () => {
        const db = solicitud.result;
        db.onversionchange = () => { db.close(); apertura = null; };
        resolve(db);
      };
    }).catch(error => { apertura = null; throw error; });
  }

  async function transaccion(clave, modificar) {
    const db = await abrir();
    return new Promise((resolve,reject) => {
      const tx = db.transaction("estado",modificar ? "readwrite" : "readonly");
      const tabla = tx.objectStore("estado");
      let valor;
      const solicitud = tabla.get(clave);
      solicitud.onsuccess = () => {
        valor = solicitud.result;
        if (!modificar) return;
        try {
          const siguiente = modificar(valor);
          if (siguiente !== valor) tabla.put(siguiente,clave);
          valor = siguiente;
        } catch (error) {
          reject(error);
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(valor);
      tx.onabort = () => reject(tx.error || new Error("No se pudo guardar el estado de los avisos."));
    });
  }

  return {
    leer:() => transaccion("intencion"),
    cambiar:fn => transaccion("intencion",fn),
    arrendar:fn => transaccion("operacion",fn)
  };
})();
