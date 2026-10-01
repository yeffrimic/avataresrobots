// Servidor mínimo (sin dependencias): sirve /public y hace de proxy hacia la API de Groq
// para que la API key no viaje al navegador.
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { msVoices, msSpeak } from './mstts.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* sin .env: la key puede venir del navegador */ }

const PORT = Number(process.env.PORT) || 3000;
const GROQ = 'https://api.groq.com/openai/v1';
const MAX_BODY = 30 * 1024 * 1024;

const ROUTES = {
  'POST /api/chat': '/chat/completions',
  'POST /api/stt': '/audio/transcriptions',
  'POST /api/tts': '/audio/speech',
  'GET /api/models': '/models',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Petición demasiado grande')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res, endpoint) {
  const key = process.env.GROQ_API_KEY || req.headers['x-groq-key'];
  if (!key) return json(res, 401, { error: { message: 'Falta la API key de Groq. Ponla en el archivo .env o en Ajustes.' } });

  const body = req.method === 'POST' ? await readBody(req) : undefined;
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

  const headers = { Authorization: `Bearer ${key}` };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const upstream = await fetch(GROQ + endpoint, { method: req.method, headers, body, signal: ctrl.signal });

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
}

function serveStatic(pathname, res) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: { message: 'Prohibido' } });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: { message: 'No encontrado' } });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handler(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/status') return json(res, 200, { serverKey: Boolean(process.env.GROQ_API_KEY) });
    if (pathname === '/api/ms-voices') return json(res, 200, await msVoices());
    if (req.method === 'POST' && pathname === '/api/ms-tts') {
      const { text, voice, rate, pitch } = JSON.parse(await readBody(req));
      const mp3 = await msSpeak({ text, voice, rate, pitch });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' });
      return res.end(mp3);
    }
    const endpoint = ROUTES[`${req.method} ${pathname}`];
    if (endpoint) return await proxy(req, res, endpoint);
    if (req.method === 'GET') return serveStatic(pathname, res);
    json(res, 405, { error: { message: 'Método no permitido' } });
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
    if (!res.headersSent) json(res, 502, { error: { message: e.message } });
    else res.end();
  }
}

// Con certificado (npm run cert) servimos por HTTPS: necesario para micrófono y cámara en móviles
const CERT = path.join(ROOT, 'certs', 'cert.pem');
const KEY = path.join(ROOT, 'certs', 'key.pem');
const secure = fs.existsSync(CERT) && fs.existsSync(KEY);
const server = secure
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
  : http.createServer(handler);

server.listen(PORT, '0.0.0.0', () => {
  const proto = secure ? 'https' : 'http';
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `${proto}://${i.address}:${PORT}`);
  console.log(`\n  Avatar listo en  ${proto}://localhost:${PORT}`);
  if (lan.length) console.log(`  En tu red local: ${lan.join('  ')}`);
  if (!secure) console.log('  (Para usarlo desde el móvil ejecuta antes:  npm run cert)');
  if (!process.env.GROQ_API_KEY) console.log('  (Sin GROQ_API_KEY en .env: podrás pegarla en Ajustes desde el navegador)');
  console.log('');
});
