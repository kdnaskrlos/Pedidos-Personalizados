import assert from "node:assert/strict";
import { test } from "node:test";
import { cantidad, centavos, clavePrecio, precioHistorico, validarPago, validarPagoEnCentavos, actualizarPagoPendiente } from "../pagos.mjs";

test("lee montos completos y conserva dos decimales", () => {
  for (const [valor, esperado] of [
    ["50000", 5000000], ["50.000", 5000000], ["50.000,50", 5000050],
    ["0", 0], [" 12.5 ", 1250], ["12,50", 1250], [12.5, 1250]
  ]) assert.equal(centavos(valor), esperado);
  for (const valor of ["123abc", "50,000.50", "1.00.50", "1,234", "1e3", "1 000", "0.0015", Infinity, NaN, undefined])
    assert.equal(centavos(valor), null, String(valor));
});

test("rechaza cantidades distintas de enteros positivos seguros", () => {
  for (const valor of [0, -1, "1.5", "1,5", "12abc", "1e2", "1 2", false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(cantidad(valor), null, String(valor));
  assert.equal(cantidad("10001"), 10001);
});

const items = [
  {prenda:"Franela", horma:"Unisex Plus", talla:"2XL", cant:2},
  {prenda:"Franela", horma:"Unisex Plus", talla:"4XL", cant:1},
  {prenda:"Short", horma:"Niño", talla:"6", cant:2},
  {prenda:"Short", horma:"Niña", talla:"8", cant:1}
];
const precios = {"Franela · Unisex Plus · 2XL":"10,11", "Franela · Unisex Plus · 4XL":"11,00", "Short · Niño/Niña":"2.13"};
const precio = i => precios[clavePrecio(i)];

test("calcula por prenda, horma, y talla Plus usando centavos en cada moneda", () => {
  assert.equal(clavePrecio({prenda:"Franela", talla:"10XL"}), "Franela · 10XL");
  assert.equal(clavePrecio({prenda:"Franela", talla:"Especial"}, ["Especial"]), "Franela · Especial");
  for (const moneda of ["COP", "USD", "Bs"])
    assert.deepEqual(validarPago(items, precio, "10,05", moneda), {piezas:6,total:3761,abono:1005,saldo:2756});
  assert.equal(validarPago([{...items[0],cant:3}, ...items.slice(1)], precio, 0, "COP").total, 4772);
  assert.equal(validarPago(items, precio, 0, "EUR").error, "moneda");
});

test("admite cero y pago total, y rechaza sobrepago y montos inválidos", () => {
  assert.equal(validarPago(items, precio, "", "USD").saldo, 3761);
  assert.equal(validarPago(items, precio, "37,61", "USD").saldo, 0);
  assert.equal(validarPago(items, precio, "37.62", "USD").error, "sobrepago");
  for (const abono of ["-0.01", "-5", "10x", "1.0000", Infinity, NaN])
    assert.equal(validarPago(items, precio, abono, "USD").error, "abono");
  for (const importe of ["", "0", "-1", "12.00x", Infinity, NaN])
    assert.equal(validarPago(items, () => importe, "", "USD").error, "precio");
  assert.equal(validarPago([{...items[0],cant:1.2}], precio, 0, "COP").error, "cantidad");
  assert.equal(validarPago([{...items[0],cant:Number.MAX_SAFE_INTEGER}], precio, 0, "COP").error, "total");
});

test("lee precios históricos por prenda y horma sin modificar el pedido", () => {
  const pedido = {precios:[{n:"Short · Niña",v:"2,13"},{n:"Franela",v:10.123}], precio:11};
  const antes = JSON.stringify(pedido);
  assert.equal(precioHistorico(pedido, clavePrecio(items[0])), 1012);
  assert.equal(precioHistorico(pedido, clavePrecio(items[2])), 213);
  assert.equal(precioHistorico(pedido, "Otro"), 1100);
  assert.equal(precioHistorico({precio:11_000_000_000}, "Otro"), 1_100_000_000_000);
  assert.equal(JSON.stringify(pedido), antes);
});

test("valida todas las partidas de un pedido grande y conserva el abono", () => {
  const partida = {cant:3,precioMenor:111};
  const partes = Array.from({length:200}, () => partida);
  assert.equal(validarPagoEnCentavos(partes, 5, "COP").saldo, 200 * 333 - 5);
  assert.equal(validarPagoEnCentavos([partida,{cant:2,precioMenor:11.5}], 0, "USD").error, "precio");
});

test("actualiza un envío pendiente del formato anterior sin cambiar total, saldo ni fotos", () => {
  const anterior = {
    pagoVersion:1, moneda:"USD", items:[{prenda:"Franela",cant:2},{prenda:"Short",cant:3}],
    precios:[{n:"Franela",v:10.11},{n:"Short",v:2.13}], precio:0,
    abono:0.25, abonoMenor:25, totalMenor:2661, imagenes:["foto"]
  };
  const actualizado = actualizarPagoPendiente(anterior, i => clavePrecio(i));
  assert.equal(actualizado.pagoVersion,2);
  assert.deepEqual(actualizado.items.map(i => i.precioMenor),[1011,213]);
  assert.equal(actualizado.totalMenor,2661);
  assert.equal(actualizado.abonoMenor,25);
  assert.deepEqual(actualizado.imagenes,["foto"]);
  assert.equal(anterior.pagoVersion,1);
  const grande = {...anterior, items:Array.from({length:12}, () => anterior.items[0]), totalMenor:12 * 2022};
  assert.equal(actualizarPagoPendiente(grande, i => clavePrecio(i)).items.length,12);
  assert.throws(() => actualizarPagoPendiente({...anterior,totalMenor:0}, i => clavePrecio(i)), {code:"pago-pendiente"});
});
