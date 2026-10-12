// Pruebas del cajero contra el simulador del programa de inventario.
// Ejecutar: npm test   (no usan Groq: el cajero entiende con reglas y dice los borradores)
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createSimulator } from '../simulador/servidor.js';
import { Inventario, mapProduct } from '../lib/inventario.js';
import { Caja } from '../lib/caja.js';
import { Brain } from '../lib/brain.js';
import { validateStyled, priceSay } from '../lib/text.js';

const CONFIG = {
  persona: { greeting: '¡Buenas!', style: '' },
  currency: { symbol: 'Q', singular: 'quetzal', plural: 'quetzales' },
  caja: { maxItems: 5, sessionTimeoutS: 60, paymentTimeoutS: 5, instruccionPago: 'Pagá en el lector.' },
  botones: { confirm: ['OK'], cancel: ['CANCEL'] },
  inventario: { pollMs: 30 },
  llm: { style: false },
};

async function setup(simOptions = {}) {
  const sim = createSimulator({ despachoMs: 10, ...simOptions });
  sim.listen(0);
  await once(sim, 'listening');
  const inventario = new Inventario({ url: `http://127.0.0.1:${sim.address().port}` });
  await inventario.refresh();
  const caja = new Caja({ inventario, config: () => CONFIG });
  const brain = new Brain({ caja, config: () => CONFIG, apiKey: null });
  return { sim, inventario, caja, brain, close: () => { caja.reset(); sim.closeAllConnections?.(); sim.close(); } };
}
const pay = (sim, id) => fetch(`http://127.0.0.1:${sim.address().port}/simulador/pagar/${id}`, { method: 'POST' });

test('traduce los productos de tu programa', () => {
  const p = mapProduct({ id: 'x', nombre: 'Agua', precio: 5.5, existencias: '3', alias: 'agua, agüita', casilla: 'c3' });
  assert.deepEqual([p.priceCents, p.stock, p.aliases, p.slot, p.category], [550, 3, ['agua', 'agüita'], 'C3', 'productos']);
  assert.equal(priceSay(550, CONFIG.currency), '5 quetzales con 50');
});

test('compra completa: pedido a tu programa, pago confirmado, entregado', async () => {
  const s = await setup();
  try {
    let r = await s.brain.turn('quiero unos doritos y una coca');
    assert.match(r.say, /14 quetzales/);
    r = await s.brain.turn('eso es todo');
    assert.match(r.say, /Son 14 quetzales por 2 productos\. Pagá en el lector\./);
    assert.equal(s.caja.state, 'awaiting_payment');
    const orderId = s.caja.order.id;
    assert.ok(s.sim.orders.has(orderId), 'el pedido llegó a tu programa');

    const paid = once(s.caja, 'paid');
    const done = once(s.caja, 'done');
    await pay(s.sim, orderId);
    await paid;
    assert.equal(s.caja.state, 'dispensing');
    const [result] = await done;
    assert.equal(result.delivered.length, 2);
    assert.equal(result.failed.length, 0);
    assert.equal(s.caja.state, 'idle');
    const say = await s.brain.narrate('done', result);
    assert.match(say.say, /Ya cayó todo/);
  } finally { s.close(); }
});

test('si el despacho falla, anuncia qué no salió y el reembolso que dice tu programa', async () => {
  const s = await setup();
  try {
    s.sim.state.falla = true;
    await s.brain.turn('dame una coca');
    await s.brain.turn('pagar');
    const done = once(s.caja, 'done');
    await pay(s.sim, s.caja.order.id);
    const [result] = await done;
    assert.equal(result.failed[0].id, 'coca');
    assert.equal(result.refundCents, 800);
    const say = await s.brain.narrate('done', result);
    assert.match(say.say, /no salió Coca-Cola\. Te devolvemos 8 quetzales/);
  } finally { s.close(); }
});

test('cambiar el pedido mientras espera el pago cancela el de tu programa y arma uno nuevo', async () => {
  const s = await setup();
  try {
    await s.brain.turn('dame unos doritos');
    await s.brain.turn('pagar');
    const first = s.caja.order.id;
    await s.brain.turn('agregale un agua pura');
    assert.equal(s.sim.orders.get(first).estado, 'cancelado');
    assert.equal(s.caja.state, 'shopping');
    await s.brain.turn('pagar');
    assert.notEqual(s.caja.order.id, first);
    assert.equal(s.caja.summary().totalCents, 1100);
  } finally { s.close(); }
});

test('cancelar antes de pagar sí; después de pagar no', async () => {
  const s = await setup({ despachoMs: 300 });
  try {
    await s.brain.turn('dame unos ricitos');
    await s.brain.turn('pagar');
    let r = await s.brain.turn('cancelar');
    assert.match(r.say, /cancelé tu pedido/);
    assert.equal(s.caja.state, 'idle');

    await s.brain.turn('dame unos ricitos');
    await s.brain.turn('pagar');
    const paid = once(s.caja, 'paid');
    await pay(s.sim, s.caja.order.id);
    await paid;
    r = await s.brain.turn('cancelar');
    assert.match(r.say, /despachando/);
  } finally { s.close(); }
});

test('no ofrece lo agotado ni más de lo que hay; respeta lo que diga tu programa', async () => {
  const s = await setup();
  try {
    let r = await s.brain.turn('dame un jugo');
    assert.match(r.say, /Ya no me queda Jugo de Naranja/);
    r = await s.brain.turn('dame 2 gomitas');
    assert.match(r.say, /solo me quedan 1/);
    // Tu programa vendió el último producto por otro lado: al cobrar, el cajero se entera
    await s.brain.turn('dame unas gomitas');
    s.sim.products.find((p) => p.id === 'gomitas').existencias = 0;
    r = await s.brain.turn('pagar');
    assert.match(r.say, /solo me quedan 0/);
    assert.equal(s.caja.state, 'shopping');
  } finally { s.close(); }
});

test('si el pago no llega a tiempo, cancela el pedido en tu programa', async () => {
  const s = await setup();
  const cfg = CONFIG.caja.paymentTimeoutS;
  CONFIG.caja.paymentTimeoutS = 0.2;
  try {
    await s.brain.turn('dame un agua pura');
    await s.brain.turn('pagar');
    const id = s.caja.order.id;
    const [info] = await once(s.caja, 'expired');
    assert.equal(info.stage, 'payment');
    assert.equal(s.sim.orders.get(id).estado, 'cancelado');
  } finally { CONFIG.caja.paymentTimeoutS = cfg; s.close(); }
});

test('botones físicos: casilla agrega su producto, OK cobra, CANCEL cancela', async () => {
  const s = await setup();
  try {
    let r = await s.brain.button({ casilla: 'A2' });
    assert.match(r.say, /Doritos Nacho/);
    await s.brain.button({ boton: 'OK' });
    assert.equal(s.caja.state, 'awaiting_payment');
    await s.brain.button({ boton: 'CANCEL' });
    assert.equal(s.caja.state, 'idle');
  } finally { s.close(); }
});

test('sin conexión con tu programa, avisa en vez de inventar', async () => {
  const inventario = new Inventario({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
  const caja = new Caja({ inventario, config: () => CONFIG });
  const brain = new Brain({ caja, config: () => CONFIG, apiKey: null });
  const r = await brain.turn('¿qué tenés de tomar?');
  assert.match(r.say, /no me puedo comunicar con la máquina/);
});

test('validador: rechaza precios inventados, productos ajenos y omisiones', () => {
  const catalog = [
    mapProduct({ id: 'doritos', nombre: 'Doritos Nacho', precio: 6, existencias: 5, alias: ['doritos'] }),
    mapProduct({ id: 'coca', nombre: 'Coca-Cola', precio: 8, existencias: 5, alias: ['coca'] }),
  ];
  const draft = 'Listo, te agrego 1 Doritos Nacho. Llevás 1 producto, son 6 quetzales. ¿Algo más o pagamos?';
  const base = { draft, mode: 'strict', mentioned: [catalog[0]], catalog };
  assert.equal(validateStyled({ ...base, styled: '¡Chilero! 1 Doritos Nacho, llevás 1 producto y son 6 quetzales. ¿Algo más o pagamos?' }).ok, true);
  assert.equal(validateStyled({ ...base, styled: 'Va, 1 Doritos Nacho por 5 quetzales, llevás 1. ¿Pagamos?' }).ok, false, 'precio inventado');
  assert.equal(validateStyled({ ...base, styled: 'Va, 1 Doritos Nacho, llevás 1. ¿Pagamos?' }).ok, false, 'omitió el total');
  assert.equal(validateStyled({ ...base, styled: '1 Doritos Nacho, llevás 1, son 6 quetzales. ¿Y una Coca para bajarlo?' }).ok, false, 'producto ajeno');
  assert.equal(validateStyled({ ...base, styled: 'Te agrego 1 de esos, llevás 1 y son 6 quetzales.' }).ok, false, 'no nombró el producto');
  assert.equal(validateStyled({ ...base, styled: '**1 Doritos Nacho**, 1 producto, 6 quetzales' }).ok, false, 'markdown');
});
