// Simulador del programa de inventario: implementa la API de API.md para probar el cajero sin
// tu programa, y sirve de ejemplo de cómo responder. Los datos viven en memoria.
//
//   node simulador/servidor.js            → http://localhost:4100 (página para confirmar pagos)
//   SIM_AUTOPAGO=5                        → confirma el pago solo, a los 5 segundos
//   CAJERO_URL=http://localhost:4000      → además le avisa al cajero por /api/eventos (si no, el cajero consulta)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createSimulator({ productos, autopagoMs = 0, despachoMs = 1500, cajeroUrl = '', cajeroToken = '', vencimientoMs = 180000 } = {}) {
  const products = structuredClone(productos ?? JSON.parse(fs.readFileSync(path.join(HERE, 'productos.json'), 'utf8')));
  const orders = new Map();
  const state = { falla: false };
  let seq = 0;

  const product = (id) => products.find((p) => p.id === id);

  // Aviso opcional al cajero (si no, el cajero consulta GET /pedidos/{id})
  async function notify(body) {
    if (!cajeroUrl) return;
    await fetch(`${cajeroUrl.replace(/\/$/, '')}/api/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cajeroToken ? { 'X-Cajero-Token': cajeroToken } : {}) },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  function setStatus(o, estado, extra = {}) {
    Object.assign(o, { estado, ...extra });
    notify({ tipo: 'pedido', ...view(o) });
  }

  const view = (o) => ({ id: o.id, estado: o.estado, total: o.total, entregados: o.entregados, fallidos: o.fallidos, reembolso: o.reembolso });

  // El «pago» llegó: despacha unidad por unidad (aquí iría la orden al Arduino)
  function pay(o) {
    if (o.estado !== 'esperando_pago') return false;
    clearTimeout(o.timers.auto);
    clearTimeout(o.timers.expire);
    setStatus(o, 'pagado');
    const units = o.items.flatMap((i) => Array(i.cantidad).fill(i.id));
    const fail = state.falla;
    setTimeout(() => {
      setStatus(o, 'despachando');
      setTimeout(() => {
        const entregados = fail ? units.slice(1) : units;
        const fallidos = fail ? units.slice(0, 1) : [];
        for (const id of entregados) product(id).existencias -= 1;
        // Lo que no salió no se descuenta de las existencias y se reembolsa
        const reembolso = fallidos.reduce((a, id) => a + product(id).precio, 0);
        setStatus(o, fallidos.length ? 'fallido' : 'entregado', { entregados, fallidos, reembolso });
      }, despachoMs * units.length);
    }, 200);
    return true;
  }

  function cancel(o, estado = 'cancelado') {
    if (o.estado !== 'esperando_pago') return false;
    clearTimeout(o.timers.auto);
    clearTimeout(o.timers.expire);
    setStatus(o, estado);
    return true;
  }

  const routes = [
    ['GET', /^\/productos$/, () => [200, products]],
    ['POST', /^\/pedidos$/, (body) => {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return [400, { error: 'pedido_vacio' }];
      for (const i of items) {
        const p = product(i.id);
        if (!p) return [404, { error: 'no_existe', id: i.id }];
        if (!(i.cantidad > 0) || i.cantidad > p.existencias) return [409, { error: 'sin_existencias', id: i.id, disponibles: p.existencias }];
      }
      const total = Math.round(items.reduce((a, i) => a + product(i.id).precio * i.cantidad, 0) * 100) / 100;
      const o = { id: `P-${++seq}`, estado: 'esperando_pago', items, total, entregados: [], fallidos: [], reembolso: 0, creado: new Date().toISOString(), timers: {} };
      orders.set(o.id, o);
      if (autopagoMs) o.timers.auto = setTimeout(() => pay(o), autopagoMs);
      o.timers.expire = setTimeout(() => cancel(o, 'vencido'), vencimientoMs);
      o.timers.expire.unref?.();
      return [201, view(o)];
    }],
    ['GET', /^\/pedidos\/([^/]+)$/, (_, [id]) => (orders.has(id) ? [200, view(orders.get(id))] : [404, { error: 'no_existe' }])],
    ['POST', /^\/pedidos\/([^/]+)\/cancelar$/, (_, [id]) => {
      const o = orders.get(id);
      if (!o) return [404, { error: 'no_existe' }];
      if (o.estado === 'cancelado' || o.estado === 'vencido') return [200, view(o)];
      return cancel(o) ? [200, view(o)] : [409, { error: 'ya_pagado' }];
    }],

    // ----- Solo del simulador: lo que en tu programa harían el lector de pago y los botones -----
    ['POST', /^\/simulador\/pagar\/([^/]+)$/, (_, [id]) => [orders.has(id) && pay(orders.get(id)) ? 200 : 409, { ok: true }]],
    ['POST', /^\/simulador\/rechazar\/([^/]+)$/, (_, [id]) => [orders.has(id) && cancel(orders.get(id), 'rechazado') ? 200 : 409, { ok: true }]],
    ['POST', /^\/simulador\/falla$/, (body) => { state.falla = Boolean(body.activa); return [200, state]; }],
    ['POST', /^\/simulador\/boton$/, async (body) => { await notify({ tipo: 'boton', ...body }); return [200, { ok: Boolean(cajeroUrl) }]; }],
    ['POST', /^\/simulador\/rellenar$/, () => { for (const p of products) p.existencias = Math.max(p.existencias, 6); notify({ tipo: 'inventario' }); return [200, products]; }],
    ['GET', /^\/simulador\/estado$/, () => [200, { falla: state.falla, avisaAlCajero: Boolean(cajeroUrl), autopagoMs, pedidos: [...orders.values()].reverse().slice(0, 15).map((o) => ({ ...view(o), items: o.items, creado: o.creado })) }]],
  ];

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(HERE, 'pagina.html')));
      }
      for (const [method, re, fn] of routes) {
        const m = req.method === method && pathname.match(re);
        if (!m) continue;
        let raw = '';
        for await (const c of req) raw += c;
        const [status, data] = await fn(raw ? JSON.parse(raw) : {}, m.slice(1).map(decodeURIComponent));
        return send(status, data);
      }
      send(404, { error: 'no_existe' });
    } catch (e) {
      send(400, { error: e.message });
    }
  });
  server.state = state;
  server.orders = orders;
  server.products = products;
  return server;
}

// Ejecutado directamente: levantar el simulador
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SIM_PORT) || 4100;
  createSimulator({
    autopagoMs: Number(process.env.SIM_AUTOPAGO || 0) * 1000,
    cajeroUrl: process.env.CAJERO_URL || '',
    cajeroToken: process.env.CAJERO_TOKEN || '',
  }).listen(port, () => {
    console.log(`\n  Simulador del programa de inventario en http://localhost:${port}`);
    console.log('  Abre esa dirección para confirmar pagos y apachar botones.\n');
  });
}
