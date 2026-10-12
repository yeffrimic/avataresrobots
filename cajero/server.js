// El cajero: conversa con el cliente (a través del avatar) y le pasa los pedidos a tu programa de
// inventario por API (ver API.md). No guarda inventario ni cobra: anuncia lo que tu programa diga.
//
//   Para el avatar:        GET  /api/persona · GET /api/display · POST /api/greet
//                          POST /api/turn { text } → { say, emotion, display }
//                          GET  /api/events (SSE): lo que el avatar debe decir por su cuenta
//   Para tu programa:      POST /api/eventos  (opcional: avisos de pedido, botones, decir…)
//   Pruebas (solo local):  GET  /  ·  POST /api/probar  ·  GET /api/estado
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Inventario } from './lib/inventario.js';
import { Caja } from './lib/caja.js';
import { Brain } from './lib/brain.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, '..', '.env')]) {
  try { process.loadEnvFile(f); } catch { /* opcional */ }
}

const PORT = Number(process.env.CAJERO_PORT) || 4000;
const CAJERO_TOKEN = process.env.CAJERO_TOKEN || '';

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
if (process.env.INVENTARIO_URL) config.inventario.url = process.env.INVENTARIO_URL;

const inventario = new Inventario({ url: config.inventario.url, token: process.env.INVENTARIO_TOKEN || '' });
const caja = new Caja({ inventario, config: () => config });
const brain = new Brain({ caja, config: () => config, apiKey: process.env.GROQ_API_KEY });

// ---------- Eventos en vivo para el avatar (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
async function announce(type, data) {
  const r = await brain.narrate(type, data);
  if (r) broadcast('say', r);
}
caja.on('change', () => broadcast('display', brain.display()));
caja.on('paid', () => announce('paid'));
caja.on('done', (d) => announce('done', d));
caja.on('cancelled', (d) => announce('cancelled', d));
caja.on('expired', (d) => announce('expired', d));

// Lista de productos al día (además se pide antes de cada cobro)
const refresh = () => inventario.refresh().catch((e) => console.error(`  Inventario: ${e.message}`));
setInterval(refresh, config.inventario.refreshS * 1000).unref();

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

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function tokenOk(req) {
  if (!CAJERO_TOKEN) return true;
  const given = Buffer.from(String(req.headers['x-cajero-token'] || ''));
  const real = Buffer.from(CAJERO_TOKEN);
  return given.length === real.length && timingSafeEqual(given, real);
}

// ---------- Rutas ----------
const routes = {
  'GET /api/persona': () => {
    const { name, hue, voice, rate, pitch, greeting } = config.persona;
    return { name, hue, voice, rate, pitch, greeting };
  },
  'GET /api/display': () => brain.display(),
  'POST /api/greet': () => brain.greeting(),
  'POST /api/turn': async (body) => {
    const { debug, ...out } = await brain.turn(String(body.text || '').trim().slice(0, 500));
    console.log(`  «${debug.text}» → ${out.say}  [${debug.source} · ${debug.nlu?.intent}${debug.styled ? (debug.validation?.ok ? ' · estilo' : ' · borrador') : ''}]`);
    return out;
  },

  // Avisos de tu programa de inventario
  'POST /api/eventos': async (body, req) => {
    if (!tokenOk(req)) { const e = new Error('Token inválido'); e.status = 401; throw e; }
    const tipo = String(body.tipo || '').toLowerCase();
    if (tipo === 'pedido') caja.update(body);
    else if (tipo === 'boton') {
      const r = await brain.button(body);
      if (r) broadcast('say', r);
    } else if (tipo === 'inventario') await inventario.refresh().catch(() => {});
    else if (tipo === 'decir') broadcast('say', { say: String(body.texto || '').slice(0, 300), emotion: body.emocion || null, display: brain.display() });
    else { const e = new Error(`Tipo de evento desconocido: ${body.tipo}`); e.status = 400; throw e; }
    return { ok: true };
  },

  // Pruebas
  'POST /api/probar': async (body) => brain.turn(String(body.text || '')),
  'GET /api/estado': () => ({
    inventario: { url: inventario.url, conectado: inventario.connected, error: inventario.lastError, productos: inventario.products.length, actualizado: inventario.updatedAt },
    pedido: brain.display(),
    modelo: Boolean(process.env.GROQ_API_KEY) && config.llm.style,
  }),
};
const LOCAL_ONLY = new Set(['POST /api/probar', 'GET /api/estado']);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (key === 'GET /') {
      if (!isLocal(req)) return json(res, 403, { error: 'Solo desde esta PC' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'probar.html')));
    }
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
    if (LOCAL_ONLY.has(key) && !isLocal(req)) return json(res, 403, { error: 'Solo desde esta PC' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    json(res, 200, await handler(body, req));
  } catch (e) {
    if (!e.status) console.error(e);
    json(res, e.status || 400, { error: e.message });
  }
}).listen(PORT, async () => {
  console.log(`\n  Cajero listo en http://localhost:${PORT}  (página de pruebas en /)`);
  console.log(`  Programa de inventario: ${config.inventario.url}`);
  if (!process.env.GROQ_API_KEY) console.log('  Sin GROQ_API_KEY: entiende con reglas simples y habla sin estilo.');
  if (!CAJERO_TOKEN) console.log('  Sin CAJERO_TOKEN: cualquiera en la red puede enviar eventos a /api/eventos.');
  await refresh();
  console.log(`  Productos cargados: ${inventario.products.length}\n`);
});
