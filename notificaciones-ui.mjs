const estados = {
  activo:["Activo","Este dispositivo puede recibir tus avisos."],
  apagado:["Desactivado","Actívalos aquí para recibir avisos aunque Pedidos esté cerrada."],
  bloqueado:["Bloqueado","Permite las notificaciones en la configuración del navegador y vuelve a abrir Pedidos."],
  incompatible:["No compatible","Usa un navegador compatible. En iPhone, añade Pedidos a la pantalla de inicio y ábrela desde allí."],
  configuracion:["Pendiente de configuración","Las notificaciones se podrán activar cuando el administrador configure la clave pública del proyecto."],
  cargando:["Comprobando…","Consultando este dispositivo."]
};

const categorias = [
  ["ediciones","Ediciones de pedidos por otros miembros","Recibe un aviso cuando un compañero modifique un pedido que puedes ver."],
  ["nuevos","Nuevos pedidos","Avisa cuando otro miembro registra un pedido que puedes ver."],
  ["estado","Pedido listo / cambio de estado","Avisa cuando otro miembro cambia el estado de un pedido que puedes ver."],
  ["","Entregas próximas","Pendiente de programar."],
  ["","Entregas vencidas","Pendiente de programar."]
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
    <p class="note">Tus preferencias se aplican a tu cuenta. Cada dispositivo se activa por separado.</p>
    <div class="nt-dispositivo">
      <label class="swr nt-fila">
        <span><b>Notificaciones en este dispositivo</b><small>${detalle}</small></span>
        <input class="swi" type="checkbox" role="switch" data-nt-dispositivo ${activo ? "checked" : ""} ${!listo || ocupado ? "disabled" : ""}>
      </label>
      <div class="nt-acciones">
        <span class="nt-estado" data-estado="${estado}">${etiqueta}</span>
        <button class="btn sm" type="button" data-nt-prueba ${!activo || ocupado ? "disabled" : ""}>Enviar prueba a este dispositivo</button>
      </div>
    </div>
    <div class="sec">Tipos de aviso</div>
    <div class="nt-tipos">${categorias.map(([id,nombre,detalle]) => `<label class="swr nt-fila">
      <span><b>${nombre}</b><small>${detalle}</small></span>
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
