// Sistema de la máquina expendedora: inventario, ventas, cobro, despacho y la «mente» del encargado.
// El avatar solo le manda lo que dijo el cliente y dice en voz alta lo que este sistema responde.
//
//   API pública (avatar):  GET  /api/persona       nombre, color y voz del encargado
//                          POST /api/turn          { text } → { say, emotion, display }
//                          POST /api/greet         saludo inicial
//                          GET  /api/display       pedido actual
//                          GET  /api/events        eventos en vivo (SSE): lo que el avatar debe decir
//   Administración (PIN):  /admin y /api/admin/*
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { createMachine } from './lib/machine.js';
import { Commerce } from './lib/commerce.js';
import { Brain } from './lib/brain.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, '..', '.env')]) {
  try { process.loadEnvFile(f); } catch { /* opcional */ }
}

const PORT = Number(process.env.VENDING_PORT) || 4000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const PUBLIC = path.join(ROOT, 'public');

const store = new Store(ROOT);
let machine = createMachine(store.config.machine);
const commerce = new Commerce({ store, machine });
const brain = new Brain({ store, commerce, apiKey: process.env.GROQ_API_KEY });

// ---------- Eventos en vivo (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

commerce.on('change', () => broadcast('display', brain.display()));
commerce.on('done', async (data) => {
  store.logEvent('order_done', { delivered: data.delivered.length, failed: data.failed.length, refundCents: data.refundCents });
  const r = await brain.narrate('done', data);
  if (r) broadcast('say', r);
});
commerce.on('expired', async () => {
  const r = await brain.narrate('expired');
  if (r) broadcast('say', r);
});
commerce.on('low_stock', ({ product, left }) => {
  store.logEvent('low_stock', { product: product.id, left });
  broadcast('admin', { type: 'low_stock', product: product.name, left });
});

function wireMachine(m) {
  m.on('button', async (btn) => {
    store.logEvent('button', { button: btn });
    const r = await brain.button(btn);
    if (r) broadcast('say', r);
  });
  m.on('status', () => broadcast('admin', { type: 'machine', status: m.status }));
}
wireMachine(machine);

async function connectMachine() {
  try {
    await machine.connect();
    console.log(`  Máquina: ${machine.driver} conectada`);
  } catch (e) {
    machine.lastError = e.message;
    console.error(`  Máquina: ${e.message}`);
  }
}

// Cambiar de simulador a serial (o de puerto) sin reiniciar el servidor
async function replaceMachine() {
  await machine.close();
  machine.removeAllListeners();
  machine = createMachine(store.config.machine);
  commerce.machine = machine;
  wireMachine(machine);
  await connectMachine();
}

// ---------- Utilidades HTTP ----------
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) { reject(new Error('Petición demasiado grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON inválido')); }
    });
  });
}

function isAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-pin'] || ''));
  const real = Buffer.from(ADMIN_PIN);
  return given.length === real.length && timingSafeEqual(given, real);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(file, res) {
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) return json(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Rutas ----------
const routes = {
  // ----- Avatar -----
  'GET /api/persona': () => {
    const { name, hue, voice, rate, pitch, greeting } = store.config.persona;
    return { name, hue, voice, rate, pitch, greeting };
  },
  'GET /api/display': () => brain.display(),
  'POST /api/greet': () => brain.greeting(),
  'POST /api/turn': async (body) => {
    const text = String(body.text || '').trim().slice(0, 500);
    const r = await brain.turn(text);
    store.logEvent('turn', { text, say: r.say, source: r.debug.source, intent: r.debug.nlu?.intent, styled: r.say !== r.debug.draft });
    const { debug, ...out } = r;
    return out;
  },

  // ----- Administración -----
  'GET /api/admin/state': () => ({
    catalog: store.catalog,
    config: store.config,
    codes: store.codes,
    machine: machine.status,
    session: brain.display(),
    events: store.events(60),
    today: salesStats(new Date().toISOString().slice(0, 10)),
    llm: Boolean(process.env.GROQ_API_KEY),
  }),
  'PUT /api/admin/catalog': (body) => {
    validateCatalog(body);
    store.catalog = body;
    store.save('catalog');
    store.logEvent('catalog_edit');
    broadcast('display', brain.display());
    return { ok: true };
  },
  'POST /api/admin/restock': (body) => {
    const slots = body.slot ? [store.slot(body.slot)].filter(Boolean) : store.slots();
    for (const s of slots) {
      const before = s.stock;
      s.stock = body.stock != null ? Math.max(0, Math.min(s.capacity, Number(body.stock))) : s.capacity;
      store.logEvent('restock', { slot: s.slot, product: s.productId, from: before, to: s.stock });
    }
    store.save('catalog');
    return { ok: true, slots: store.slots() };
  },
  'PUT /api/admin/codes': (body) => {
    if (!Array.isArray(body)) throw new Error('Se esperaba una lista de códigos');
    for (const c of body) {
      if (!/^\d{3,12}$/.test(String(c.code))) throw new Error(`Código inválido: ${c.code} (de 3 a 12 dígitos)`);
      c.code = String(c.code);
      c.balance = Math.max(0, Math.round(Number(c.balance) || 0));
    }
    store.codes = body;
    store.save('codes');
    return { ok: true };
  },
  'PUT /api/admin/config': async (body) => {
    const machineChanged = JSON.stringify(body.machine) !== JSON.stringify(store.config.machine);
    store.config = { ...store.config, ...body };
    store.save('config');
    if (machineChanged && commerce.state !== 'dispensing') await replaceMachine();
    return { ok: true, machine: machine.status };
  },
  'GET /api/admin/sales': (_, url) => {
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    return { sales: store.sales({ from, to }).reverse(), stats: salesStats(from, to) };
  },
  'POST /api/admin/test/turn': async (body) => brain.turn(String(body.text || '')),
  'POST /api/admin/test/button': async (body) => {
    if (typeof machine.press === 'function') machine.press(body.button);
    else {
      const r = await brain.button(body.button);
      if (r) broadcast('say', r);
    }
    return { ok: true };
  },
  'POST /api/admin/test/vend': async (body) => {
    if (commerce.state === 'dispensing') throw new Error('La máquina está despachando');
    const r = await machine.vend(String(body.slot || '').toUpperCase());
    store.logEvent(r.ok ? 'test_vend_ok' : 'test_vend_fail', { slot: body.slot, reason: r.reason });
    return r;
  },
  'POST /api/admin/pay': () => {
    const r = commerce.pay({ method: 'admin' });
    if (r.ok) broadcast('say', { say: '¡Pagado! Ahí te van tus antojos, esperá tantito.', emotion: 'feliz', display: brain.display() });
    return r;
  },
  'POST /api/admin/reset': () => commerce.cancel(),
  'POST /api/admin/say': (body) => {
    broadcast('say', { say: String(body.text || '').slice(0, 300), emotion: body.emotion || null, display: brain.display() });
    return { ok: true };
  },
};

function salesStats(from, to) {
  const sales = store.sales({ from, to: to || (from ? `${from}￿` : undefined) });
  const byProduct = {};
  for (const s of sales) {
    for (const id of s.delivered) {
      const p = store.product(id);
      byProduct[id] ??= { name: p?.name || id, units: 0, cents: 0 };
      byProduct[id].units += 1;
      byProduct[id].cents += p?.priceCents || 0;
    }
  }
  return {
    orders: sales.length,
    units: sales.reduce((a, s) => a + s.delivered.length, 0),
    revenueCents: sales.reduce((a, s) => a + s.chargedCents, 0),
    refundCents: sales.reduce((a, s) => a + s.refundCents, 0),
    byProduct: Object.values(byProduct).sort((a, b) => b.units - a.units),
  };
}

function validateCatalog(c) {
  if (!c || !Array.isArray(c.products) || !Array.isArray(c.slots)) throw new Error('Catálogo inválido');
  const ids = new Set();
  for (const p of c.products) {
    if (!/^[a-z0-9-]+$/.test(p.id || '')) throw new Error(`Id de producto inválido: «${p.id}» (minúsculas, números y guiones)`);
    if (ids.has(p.id)) throw new Error(`Id repetido: ${p.id}`);
    ids.add(p.id);
    if (!p.name) throw new Error(`Falta el nombre de ${p.id}`);
    if (!Number.isInteger(p.priceCents) || p.priceCents <= 0) throw new Error(`Precio inválido en ${p.name}`);
  }
  const codes = new Set();
  for (const s of c.slots) {
    if (!/^[A-Z0-9]{1,4}$/.test(s.slot || '')) throw new Error(`Casilla inválida: ${s.slot}`);
    if (codes.has(s.slot)) throw new Error(`Casilla repetida: ${s.slot}`);
    codes.add(s.slot);
    if (s.productId && !ids.has(s.productId)) throw new Error(`La casilla ${s.slot} apunta a un producto que no existe`);
    if (!(s.stock >= 0 && s.stock <= s.capacity)) throw new Error(`Existencias inválidas en ${s.slot}`);
  }
}

// ---------- Servidor ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (key === 'GET /' || key === 'GET /admin') return serveStatic('admin.html', res);
    if (req.method === 'GET' && /^\/(admin\.(js|css))$/.test(url.pathname)) return serveStatic(url.pathname.slice(1), res);

    if (key === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: display\ndata: ${JSON.stringify(brain.display())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    const handler = routes[key];
    if (!handler) return json(res, 404, { error: 'No encontrado' });
    if (url.pathname.startsWith('/api/admin/') && !isAdmin(req)) return json(res, 401, { error: 'PIN incorrecto' });
    const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
    json(res, 200, await handler(body, url));
  } catch (e) {
    console.error(e);
    json(res, 400, { error: e.message });
  }
}).listen(PORT, async () => {
  console.log(`\n  Máquina expendedora lista en http://localhost:${PORT}  (administración: /admin)`);
  if (ADMIN_PIN === '1234') console.log('  ⚠ PIN de administración por defecto (1234). Cámbialo con ADMIN_PIN en .env');
  if (!process.env.GROQ_API_KEY) console.log('  Sin GROQ_API_KEY: la máquina entiende con reglas simples y habla sin estilo.');
  await connectMachine();
  console.log('');
});
