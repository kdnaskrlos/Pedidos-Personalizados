// El formulario guarda el teléfono internacional sin separadores.
export function enlaceChatCliente(telefono, escritorio) {
  const numero = /^\+?([1-9]\d{7,14})$/.exec(String(telefono ?? "").trim())?.[1];
  if (!numero) return "";
  return escritorio ? `https://web.whatsapp.com/send?phone=${numero}` : `https://wa.me/${numero}`;
}
// El texto se copia por partes si supera lo que conviene pegar de una vez.
export function dividirMensaje(texto) {
  const limite = 12000;
  const partes = [];
  let inicio = 0;
  while (texto.length - inicio > limite) {
    const maximo = inicio + limite;
    const salto = texto.lastIndexOf("\n",maximo - 1);
    const fin = salto >= inicio ? salto + 1 : maximo - Number(/[\uD800-\uDBFF]/.test(texto[maximo - 1]));
    partes.push(texto.slice(inicio,fin));
    inicio = fin;
  }
  partes.push(texto.slice(inicio));
  return partes;
}
