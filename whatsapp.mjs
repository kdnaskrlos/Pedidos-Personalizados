// El formulario guarda el teléfono internacional sin separadores.
export function enlaceChatCliente(telefono, escritorio) {
  const numero = /^\+?([1-9]\d{7,14})$/.exec(String(telefono ?? "").trim())?.[1];
  if (!numero) return "";
  return escritorio ? `https://web.whatsapp.com/send?phone=${numero}` : `https://wa.me/${numero}`;
}
