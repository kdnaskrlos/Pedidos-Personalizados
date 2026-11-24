const marcador = /^([ \t]*)([•☐☑])[ \t]*/;
const inicioDeLinea = (texto, cursor) => texto.slice(0, cursor).lastIndexOf("\n") + 1;

export function continuarLista(texto, cursor) {
  if (cursor !== texto.length && texto[cursor] !== "\n") return null;
  const inicio = inicioDeLinea(texto,cursor);
  const linea = texto.slice(inicio,cursor), prefijo = linea.match(marcador);
  if (!prefijo) return null;
  if (!linea.slice(prefijo[0].length).trim()) return {inicio,fin:cursor,texto:""};
  return {inicio:cursor,fin:cursor,texto:`\n${prefijo[1]}${prefijo[2]} `};
}

export function iniciarLista(texto, cursor, simbolo) {
  const inicio = inicioDeLinea(texto,cursor), resto = texto.slice(inicio);
  const prefijo = resto.match(marcador);
  const sangria = prefijo?.[1] ?? resto.match(/^[ \t]*/)[0];
  const fin = inicio + (prefijo?.[0].length ?? sangria.length);
  const nuevo = sangria + simbolo + " ";
  return {inicio,fin,texto:nuevo,cursor:inicio + nuevo.length + Math.max(0,cursor - fin)};
}

export function conectarListasNota(area, barra) {
  const aplicar = ({inicio,fin,texto,cursor = inicio + texto.length}) => {
    area.setRangeText(texto,inicio,fin,"end");
    area.focus();
    area.setSelectionRange(cursor,cursor);
    area.dispatchEvent(new Event("input",{bubbles:true}));
  };
  const alEnter = e => {
    if (e.isComposing || !e.cancelable || area.selectionStart !== area.selectionEnd) return;
    const cambio = continuarLista(area.value,area.selectionStart);
    if (cambio) { e.preventDefault(); aplicar(cambio); }
  };
  area.addEventListener("keydown",e => {
    if (e.key !== "Enter") return;
    // Las notas admiten saltos de línea aunque el formulario trate Enter como salida de otros campos.
    e.stopPropagation();
    if (!e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) alEnter(e);
  });
  area.addEventListener("beforeinput",e => {
    if (["insertLineBreak","insertParagraph"].includes(e.inputType)) alEnter(e);
  });
  barra.addEventListener("click",e => {
    const boton = e.target.closest("[data-lista-nota]");
    if (boton) aplicar(iniciarLista(area.value,area.selectionStart,boton.dataset.listaNota));
  });
}
