// Respeta el orden de cada grupo en el catálogo. Las tallas fuera del catálogo
// comparten un rango final y conservan el orden original del pedido.
export function ordenarPartidasPorTalla(partidas, catalogo) {
  const normalizar = talla => String(talla ?? "").trim().toUpperCase();
  const rangos = new Map();
  const grupos = [catalogo.tallasNino,catalogo.tallasAdulto,catalogo.tallasPlus];
  for (const [grupo,tallas] of grupos.entries()) {
    for (const talla of tallas) {
      const clave = normalizar(talla);
      if (clave && !rangos.has(clave)) rangos.set(clave,{grupo,orden:rangos.size});
    }
  }
  const desconocida = {grupo:grupos.length,orden:rangos.size};
  const ordenadas = partidas.map(partida => ({partida,...(rangos.get(normalizar(partida.talla)) ?? desconocida)}))
    .sort((a,b) => a.orden - b.orden);
  return ordenadas.map(({partida,grupo},i) => ({
    partida,
    separador:i > 0 && grupo !== ordenadas[i - 1].grupo
  }));
}
