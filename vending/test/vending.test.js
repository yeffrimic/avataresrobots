// Pruebas de la lógica de venta, el protocolo del Arduino y el validador anti-alucinaciones.
// Ejecutar: npm test   (no usan Groq ni hardware)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.js';
import { SimulatorMachine, parseLine } from '../lib/machine.js';
import { Commerce } from '../lib/commerce.js';
import { Brain, extractDigits } from '../lib/brain.js';
import { validateStyled, priceSay, normalize } from '../lib/text.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Copia limpia de los datos de ejemplo en una carpeta temporal
function setup({ failSlots = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vending-'));
  fs.cpSync(path.join(ROOT, 'seed'), path.join(dir, 'seed'), { recursive: true });
  const store = new Store(dir);
  const machine = new SimulatorMachine({ simDelayMs: 5, simFailSlots: failSlots, vendTimeoutMs: 500 });
  machine.connected = true;
  const commerce = new Commerce({ store, machine });
  const brain = new Brain({ store, commerce, apiKey: null }); // sin modelo: reglas + borradores
  return { store, machine, commerce, brain };
}
const done = (commerce) => new Promise((r) => commerce.once('done', r));
const CUR = { symbol: 'Q', singular: 'quetzal', plural: 'quetzales' };

test('precios dichos en voz alta', () => {
  assert.equal(priceSay(800, CUR), '8 quetzales');
  assert.equal(priceSay(850, CUR), '8 quetzales con 50');
  assert.equal(priceSay(100, CUR), '1 quetzal');
  assert.equal(priceSay(50, CUR), '50 centavos');
});

test('protocolo del Arduino', () => {
  assert.deepEqual(parseLine('DONE a1\r'), { type: 'done', slot: 'A1' });
  assert.deepEqual(parseLine('FAIL B2 empty'), { type: 'fail', slot: 'B2', reason: 'EMPTY' });
  assert.deepEqual(parseLine('BTN ok'), { type: 'button', button: 'OK' });
  assert.deepEqual(parseLine('CREDIT 500'), { type: 'credit', cents: 500 });
  assert.equal(parseLine('basura').type, 'unknown');
});

test('códigos dichos con palabras o dígitos', () => {
  assert.equal(extractDigits(normalize('mi código es 1 2 3 4')), '1234');
  assert.equal(extractDigits(normalize('uno dos tres cuatro')), '1234');
  assert.equal(extractDigits(normalize('dame una coca')), null);
  assert.equal(extractDigits(normalize('dame 2 cocas')), null);
});

test('compra completa: agregar, pagar con código, despachar, descontar existencias y saldo', async () => {
  const { store, commerce } = setup();
  assert.equal(commerce.add('doritos', 2).ok, true);
  assert.equal(commerce.add('coca').ok, true);
  assert.equal(commerce.summary().totalCents, 2000);
  const before = store.stockOf('doritos');
  const finished = done(commerce);
  const r = commerce.pay({ method: 'codigo', code: '1234' });
  assert.equal(r.ok, true);
  assert.equal(r.balanceCents, 8000);
  const result = await finished;
  assert.equal(result.delivered.length, 3);
  assert.equal(store.stockOf('doritos'), before - 2);
  assert.equal(commerce.state, 'idle');
  assert.equal(store.sales().length, 1);
  assert.equal(store.sales()[0].chargedCents, 2000);
});

test('no vende lo agotado, ni más de lo que hay, ni más del límite', () => {
  const { commerce } = setup();
  assert.equal(commerce.add('jugo').reason, 'agotado');
  assert.equal(commerce.add('gomitas', 2).reason, 'insuficiente');
  assert.equal(commerce.add('doritos', 6).reason, 'limite');
  assert.equal(commerce.add('inventado').reason, 'no_existe');
});

test('código inválido o sin saldo no cobra', () => {
  const { store, commerce } = setup();
  commerce.add('gatorade');
  assert.equal(commerce.pay({ code: '9999' }).reason, 'codigo_invalido');
  commerce.add('snickers'); commerce.add('doritos');
  store.findCode('2026').balance = 1000;
  assert.equal(commerce.pay({ code: '2026' }).reason, 'saldo');
  assert.equal(store.findCode('2026').balance, 1000);
});

test('si una casilla se traba, prueba otra con el mismo producto y si no, reembolsa', async () => {
  // Chiky está en B2 y B5: si B2 falla, debe salir de B5
  let s = setup({ failSlots: ['B2'] });
  s.commerce.add('chiky');
  let finished = done(s.commerce);
  s.commerce.pay({ code: '1234' });
  let r = await finished;
  assert.equal(r.delivered.length, 1);
  assert.equal(r.refundCents, 0);

  // Coca solo está en C1: si falla, se reembolsa al código
  s = setup({ failSlots: ['C1'] });
  s.commerce.add('coca');
  finished = done(s.commerce);
  s.commerce.pay({ code: '1234' });
  r = await finished;
  assert.equal(r.failed.length, 1);
  assert.equal(r.refundCents, 800);
  assert.equal(s.store.findCode('1234').balance, 10000);
  assert.equal(s.store.sales()[0].chargedCents, 0);
});

test('conversación sin modelo (plan B por reglas)', async () => {
  const { brain, commerce } = setup();
  let r = await brain.turn('quiero unos doritos y una coca');
  assert.match(r.say, /Doritos Nacho/);
  assert.match(r.say, /14 quetzales/);
  r = await brain.turn('eso es todo');
  assert.match(r.say, /código/);
  assert.equal(commerce.state, 'awaiting_payment');
  const finished = done(commerce);
  r = await brain.turn('uno dos tres cuatro');
  assert.match(r.say, /Pagado/);
  await finished;
});

test('botones físicos: casilla agrega su producto, OK cobra, CANCEL cancela', async () => {
  const { brain, commerce } = setup();
  let r = await brain.button('A2');
  assert.match(r.say, /Doritos Nacho/);
  r = await brain.button('OK');
  assert.equal(commerce.state, 'awaiting_payment');
  r = await brain.button('CANCEL');
  assert.equal(commerce.state, 'idle');
});

test('validador: rechaza precios inventados, productos ajenos y omisiones', () => {
  const { store } = setup();
  const catalog = store.products();
  const doritos = store.product('doritos');
  const draft = 'Listo, te agrego 1 Doritos Nacho. Llevás 1 producto, son 6 quetzales. ¿Algo más o pagamos?';
  const base = { draft, mode: 'strict', mentioned: [doritos], catalog };
  assert.equal(validateStyled({ ...base, styled: '¡Chilero! 1 Doritos Nacho, llevás 1 producto y son 6 quetzales. ¿Algo más o pagamos?' }).ok, true);
  assert.equal(validateStyled({ ...base, styled: 'Va, 1 Doritos Nacho por 5 quetzales, llevás 1. ¿Pagamos?' }).ok, false, 'precio inventado');
  assert.equal(validateStyled({ ...base, styled: 'Va, 1 Doritos Nacho, llevás 1. ¿Pagamos?' }).ok, false, 'omitió el total');
  assert.equal(validateStyled({ ...base, styled: '1 Doritos Nacho, llevás 1, son 6 quetzales. ¿Y una Coca para bajarlo?' }).ok, false, 'producto ajeno');
  assert.equal(validateStyled({ ...base, styled: 'Te agrego 1 de esos, llevás 1 y son 6 quetzales.' }).ok, false, 'no nombró el producto');
  assert.equal(validateStyled({ ...base, styled: '**1 Doritos Nacho**, 1 producto, 6 quetzales' }).ok, false, 'markdown');
  // Modo subset (preguntas): puede omitir números, nunca inventarlos
  const sub = { draft: 'Coca-Cola, lata de 355 mililitros, a 8 quetzales. ¿Te la doy?', mode: 'subset', mentioned: [store.product('coca')], catalog, factsText: '{"precio":"8 quetzales"}' };
  assert.equal(validateStyled({ ...sub, styled: 'Sí, la Coca-Cola trae cafeína, bien fría. ¿Te la doy?' }).ok, true);
  assert.equal(validateStyled({ ...sub, styled: 'La Coca-Cola tiene 39 gramos de azúcar.' }).ok, false);
});
