export function fechasDelMes(anio, mes) {
  const inicio = (new Date(anio, mes, 1).getDay() + 6) % 7;
  const dias = new Date(anio, mes + 1, 0).getDate();
  const prefijo = anio + "-" + String(mes + 1).padStart(2, "0");
  return Array.from({length:42}, (_, i) => {
    const dia = i - inicio + 1;
    return dia >= 1 && dia <= dias ? {dia, fecha:prefijo + "-" + String(dia).padStart(2, "0")} : null;
  });
}

export function entregasPorFecha(pedidos) {
  const entregas = new Map();
  for (const pedido of pedidos) {
    if (!pedido.fechaEntrega) continue;
    const dia = entregas.get(pedido.fechaEntrega) || [];
    dia.push(pedido);
    entregas.set(pedido.fechaEntrega, dia);
  }
  return entregas;
}
