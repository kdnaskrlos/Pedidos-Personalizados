import assert from "node:assert/strict";
import { test } from "node:test";
import { cantidad, centavos, clavePrecio, precioHistorico, validarPago } from "../pagos.mjs";

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
  assert.equal(JSON.stringify(pedido), antes);
});
