const estados = {
  activo:["Activo"],
  apagado:["Desactivado"],
  bloqueado:["Bloqueado","Permite las notificaciones en la configuración del navegador y vuelve a abrir Pedidos."],
  incompatible:["No compatible","Usa un navegador compatible. En iPhone, añade Pedidos a la pantalla de inicio y ábrela desde allí."],
  configuracion:["Pendiente de configuración","Las notificaciones se podrán activar cuando el administrador configure la clave pública del proyecto."],
  cargando:["Comprobando…"]
};

const categorias = [
  ["ediciones","Ediciones de pedidos por otros miembros"],
  ["nuevos","Nuevos pedidos"],
  ["estado","Pedido listo / cambio de estado"],
  ["","Entregas próximas"],
  ["","Entregas vencidas"]
];

const escapeHTML = valor => String(valor).replace(/[&<>"']/g,c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
})[c]);

export function panelNotificaciones({estado, preferencias, ocupado, permitePreferencias = true, mensaje = "", error = false}, icono = "") {
  const [etiqueta,detalle] = estados[estado];
  const activo = estado === "activo";
  const listo = activo || estado === "apagado";
  return `<section class="card nt-panel" aria-label="Notificaciones">
    <div class="sec">${icono}Notificaciones</div>
    <div class="nt-dispositivo">
      <label class="swr nt-fila">
        <b>Notificaciones en este dispositivo</b>
        <input class="swi" type="checkbox" role="switch" data-nt-dispositivo ${activo ? "checked" : ""} ${!listo || ocupado ? "disabled" : ""}>
      </label>
      <div class="nt-acciones">
        <span class="nt-estado" data-estado="${estado}">${etiqueta}</span>
        <button class="btn sm" type="button" data-nt-prueba ${!activo || ocupado ? "disabled" : ""}>Enviar prueba a este dispositivo</button>
      </div>
      ${detalle ? `<p class="nt-ayuda">${detalle}</p>` : ""}
    </div>
    <div class="sec">Tipos de aviso</div>
    <div class="nt-tipos">${categorias.map(([id,nombre]) => `<label class="swr nt-fila">
      <span><b>${nombre}</b>${id ? "" : "<small>Pendiente de programar</small>"}</span>
      <input class="swi" type="checkbox" role="switch" data-nt-tipo="${id}" ${preferencias[id] === true ? "checked" : ""} ${!id || !permitePreferencias || ocupado ? "disabled" : ""}>
    </label>`).join("")}</div>
    <p class="msg ${error ? "bad" : "mut"}" data-nt-mensaje role="status">${escapeHTML(mensaje)}</p>
  </section>`;
}

export function montarPanelNotificaciones(root, api, icono = "") {
  const selector = "[data-nt-dispositivo],[data-nt-tipo],[data-nt-prueba]";
  const dibujar = () => {
    const foco = root.getRootNode().activeElement;
    const anterior = root.contains(foco) ? foco : null;
    const atributo = anterior?.getAttributeNames().find(a => a.startsWith("data-nt-"));
    const valor = atributo ? anterior.getAttribute(atributo) : "";
    root.innerHTML = panelNotificaciones(api.estado(),icono);
    if (atributo) {
      const destino = [...root.querySelectorAll(selector)].find(el => el.getAttribute(atributo) === valor);
      if (destino && !destino.disabled) destino.focus({preventScroll:true});
    }
  };
  root.onchange = async e => {
    if (!e.target.matches("[data-nt-dispositivo],[data-nt-tipo]")) return;
    const dispositivo = e.target.hasAttribute("data-nt-dispositivo"), valor = e.target.checked;
    const operacion = dispositivo ? api.dispositivo(valor) : api.preferencia(e.target.dataset.ntTipo,valor);
    dibujar();
    await operacion;
    dibujar();
  };
  root.onclick = async e => {
    const boton = e.target.closest("[data-nt-prueba]");
    if (!boton || boton.disabled) return;
    const operacion = api.prueba();
    dibujar();
    await operacion;
    dibujar();
  };
  dibujar();
  return dibujar;
}
