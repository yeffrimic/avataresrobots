// Panel de administración de la máquina.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (cents) => `${S.config?.currency?.symbol || 'Q'}${(cents / 100).toFixed(2)}`;
const toCents = (v) => Math.round(Number(String(v).replace(',', '.')) * 100);
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

let S = {}; // estado que manda el servidor
let pin = '';
try { pin = sessionStorage.getItem('pin') || ''; } catch { /* sin almacenamiento */ }

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Pin': pin },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('PIN incorrecto'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- Acceso ----------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  pin = $('#pin').value.trim();
  try {
    await load();
    try { sessionStorage.setItem('pin', pin); } catch { /* sin almacenamiento */ }
    $('#login').hidden = true;
    $('#app').hidden = false;
    startEvents();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').hidden = false;
  }
});
function logout() {
  pin = '';
  try { sessionStorage.removeItem('pin'); } catch { /* */ }
  $('#app').hidden = true;
  $('#login').hidden = false;
}
$('#logout').addEventListener('click', logout);

// ---------- Pestañas ----------
let tab = 'resumen';
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (tab === 'ventas') loadSales();
  else render();
});

async function load() {
  S = await api('/api/admin/state');
  render();
}

function render() {
  const m = S.machine || {};
  $('#machineDot').className = `dot ${m.connected ? 'ok' : 'bad'}`;
  $('#machineText').textContent = `${m.driver === 'serial' ? `Arduino (${S.config.machine.port})` : 'Simulador'} · ${m.connected ? 'conectada' : `desconectada${m.lastError ? `: ${m.lastError}` : ''}`}`;
  ({ resumen: renderSummary, inventario: renderInventory, productos: renderProducts, codigos: renderCodes, probar: renderTest, config: renderConfig }[tab] || (() => {}))();
}

const productName = (id) => S.catalog.products.find((p) => p.id === id)?.name || '—';
const stockOf = (id) => S.catalog.slots.filter((s) => s.productId === id && s.enabled !== false).reduce((a, s) => a + s.stock, 0);

// ---------- Resumen ----------
function renderSummary() {
  const t = S.today;
  const sess = S.session;
  const low = S.catalog.slots.filter((s) => s.productId && s.enabled !== false && s.stock <= S.config.sales.lowStock);
  $('#pResumen').innerHTML = `
    <div class="grid g4">
      <div class="card stat"><b>${t.orders}</b><span>pedidos hoy</span></div>
      <div class="card stat"><b>${t.units}</b><span>productos entregados hoy</span></div>
      <div class="card stat"><b>${money(t.revenueCents)}</b><span>cobrado hoy</span></div>
      <div class="card stat"><b>${money(t.refundCents)}</b><span>reembolsado hoy</span></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card stack">
        <div class="row spread"><h3>Pedido en curso</h3><span class="badge">${esc(sess.label)}</span></div>
        ${sess.items.length ? `<table><tbody>${sess.items.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td class="num">${esc(i.subtotal)}</td></tr>`).join('')}
          <tr><td><b>Total</b></td><td class="num"><b>${esc(sess.total)}</b></td></tr></tbody></table>` : '<p class="muted">No hay ningún pedido abierto.</p>'}
        <div class="row">
          <button class="btn primary" id="approve" ${sess.items.length && sess.state !== 'dispensing' ? '' : 'disabled'}>Aprobar pago (simulado)</button>
          <button class="btn" id="cancelOrder" ${sess.items.length && sess.state !== 'dispensing' ? '' : 'disabled'}>Cancelar pedido</button>
        </div>
        <p class="muted" style="margin:0">«Aprobar pago» cobra el pedido como si hubiera pagado en efectivo y lo despacha.</p>
      </div>
      <div class="card stack">
        <h3>Alertas de inventario</h3>
        ${low.length ? low.map((s) => `<div class="row spread"><span><b>${s.slot}</b> · ${esc(productName(s.productId))}</span>
          <span class="badge ${s.stock ? 'warn' : 'bad'}">${s.stock ? `quedan ${s.stock}` : 'vacía'}</span></div>`).join('')
          : '<p class="muted">Todo bien surtido.</p>'}
        ${low.length ? '<button class="btn" id="goInv">Ir a rellenar</button>' : ''}
      </div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>Más vendidos hoy</h3>
        ${t.byProduct.length ? `<table><tbody>${t.byProduct.slice(0, 6).map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.units}</td><td class="num">${money(p.cents)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Aún no hay ventas hoy.</p>'}
      </div>
      <div class="card"><h3>Actividad reciente</h3><div class="events">${S.events.map(eventLine).join('') || '<p class="muted">Sin actividad.</p>'}</div></div>
    </div>`;
  $('#approve')?.addEventListener('click', guard(async () => { await api('/api/admin/pay', { method: 'POST' }); toast('Pago aprobado, despachando'); await load(); }));
  $('#cancelOrder')?.addEventListener('click', guard(async () => { await api('/api/admin/reset', { method: 'POST' }); await load(); }));
  $('#goInv')?.addEventListener('click', () => $('#tabs [data-tab="inventario"]').click());
}

function eventLine(e) {
  const time = new Date(e.at).toLocaleTimeString();
  const text = {
    turn: () => `🗣 «${esc(e.text)}» → ${esc(e.say)} <span class="muted">(${esc(e.source)}${e.styled ? ', con estilo' : ''})</span>`,
    vend_ok: () => `✔ Despachó ${esc(e.slot)}`,
    vend_fail: () => `✖ Falló ${esc(e.slot)} (${esc(e.reason)})`,
    test_vend_ok: () => `✔ Prueba de ${esc(e.slot)}`,
    test_vend_fail: () => `✖ Prueba de ${esc(e.slot)} falló (${esc(e.reason)})`,
    button: () => `🔘 Botón ${esc(e.button)}`,
    restock: () => `📦 ${esc(e.slot)}: ${e.from} → ${e.to}`,
    low_stock: () => `⚠ Quedan ${e.left} de ${esc(productName(e.product))}`,
    order_done: () => `🧾 Pedido terminado: ${e.delivered} entregados${e.failed ? `, ${e.failed} fallaron` : ''}`,
    catalog_edit: () => '✎ Catálogo editado',
  }[e.type];
  return `<div><span class="muted">${time}</span> · ${text ? text() : esc(e.type)}</div>`;
}

// ---------- Inventario ----------
function renderInventory() {
  const rows = {};
  for (const s of S.catalog.slots) (rows[s.slot.replace(/\d+$/, '')] ??= []).push(s);
  const opts = (sel) => `<option value="">— vacía —</option>${S.catalog.products.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  $('#pInventario').innerHTML = `
    <div class="row spread" style="margin-bottom:14px">
      <h2>Inventario por casilla</h2>
      <div class="row">
        <button class="btn" id="addSlot">+ Casilla</button>
        <button class="btn" id="refillAll">Rellenar todo</button>
        <button class="btn primary" id="saveInv">Guardar cambios</button>
      </div>
    </div>
    <div class="machine">
      ${Object.entries(rows).map(([row, slots]) => `<div class="shelf"><div class="shelf-label">${esc(row)}</div>
        ${slots.map((s) => {
          const cls = s.enabled === false ? 'off' : !s.stock && s.productId ? 'empty' : s.stock <= S.config.sales.lowStock ? 'low' : '';
          return `<div class="slot ${cls}" data-slot="${esc(s.slot)}">
            <div class="slot-head"><span class="slot-code">${esc(s.slot)}</span>
              <label class="row" style="gap:4px"><input type="checkbox" data-f="enabled" ${s.enabled !== false ? 'checked' : ''}/> activa</label></div>
            <select data-f="productId">${opts(s.productId)}</select>
            <div class="bar"><i style="width:${s.capacity ? (s.stock / s.capacity) * 100 : 0}%"></i></div>
            <div class="row spread"><span><b>${s.stock}</b> / <input data-f="capacity" type="number" min="1" value="${s.capacity}" style="width:56px;padding:2px 4px"/></span>
              <span class="row" style="gap:4px"><button class="btn small" data-a="minus">−</button><button class="btn small" data-a="plus">+</button></span></div>
            <div class="row"><button class="btn small" data-a="refill">Rellenar</button><button class="btn small" data-a="vend">Probar</button><button class="btn small" data-a="press">Botón</button></div>
          </div>`;
        }).join('')}</div>`).join('')}
    </div>
    <p class="muted">«Probar» hace girar el motor de esa casilla sin cobrar ni descontar existencias. «Botón» simula que un cliente apachó el botón físico de esa casilla.</p>`;

  const slotOf = (el) => S.catalog.slots.find((s) => s.slot === el.closest('[data-slot]').dataset.slot);
  $('#pInventario').onchange = (e) => {
    const s = slotOf(e.target);
    if (!s) return;
    const f = e.target.dataset.f;
    if (f === 'enabled') s.enabled = e.target.checked;
    if (f === 'productId') s.productId = e.target.value || null;
    if (f === 'capacity') { s.capacity = Math.max(1, Number(e.target.value) || 1); s.stock = Math.min(s.stock, s.capacity); }
  };
  $('#pInventario').onclick = guard(async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const s = slotOf(b);
    const a = b.dataset.a;
    if (a === 'minus') s.stock = Math.max(0, s.stock - 1);
    if (a === 'plus') s.stock = Math.min(s.capacity, s.stock + 1);
    if (a === 'refill') s.stock = s.capacity;
    if (a === 'vend') {
      b.disabled = true;
      const r = await api('/api/admin/test/vend', { method: 'POST', body: { slot: s.slot } }).finally(() => { b.disabled = false; });
      toast(r.ok ? `${s.slot} despachó bien` : `${s.slot} falló: ${r.reason}`, !r.ok);
      return;
    }
    if (a === 'press') { await api('/api/admin/test/button', { method: 'POST', body: { button: s.slot } }); toast(`Botón ${s.slot} apachado`); return; }
    renderInventory();
  });
  $('#refillAll').onclick = () => { S.catalog.slots.forEach((s) => { if (s.productId) s.stock = s.capacity; }); renderInventory(); };
  $('#addSlot').onclick = () => {
    const code = prompt('Código de la nueva casilla (por ejemplo D1):')?.trim().toUpperCase();
    if (!code) return;
    if (S.catalog.slots.some((s) => s.slot === code)) return toast('Esa casilla ya existe', true);
    S.catalog.slots.push({ slot: code, productId: null, stock: 0, capacity: 8, enabled: true });
    renderInventory();
  };
  $('#saveInv').onclick = guard(saveCatalog);
}

async function saveCatalog() {
  await api('/api/admin/catalog', { method: 'PUT', body: S.catalog });
  toast('Guardado');
  await load();
}

// ---------- Productos ----------
function renderProducts() {
  const cats = [...new Set(S.catalog.products.map((p) => p.category))];
  $('#pProductos').innerHTML = `
    <div class="row spread" style="margin-bottom:14px">
      <h2>Productos</h2>
      <div class="row"><button class="btn" id="addProduct">+ Producto</button><button class="btn primary" id="saveProducts">Guardar cambios</button></div>
    </div>
    <p class="muted">Todo lo que el encargado sabe de un producto sale de aquí. Si un dato no está (por ejemplo los alérgenos), dirá que no lo tiene: nunca lo inventa. Los «alias» son las formas en que la gente lo pide.</p>
    <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="card table-wrap"><table>
      <thead><tr><th>Id</th><th>Nombre</th><th>Alias (separados por coma)</th><th>Categoría</th><th class="num">Precio</th><th>Tamaño</th><th>Descripción</th><th>Etiquetas</th><th>Alérgenos</th><th>Existencias</th><th>Destacado</th><th>Activo</th><th></th></tr></thead>
      <tbody>${S.catalog.products.map((p, i) => `<tr data-i="${i}">
        <td><input data-f="id" value="${esc(p.id)}" style="min-width:100px"/></td>
        <td><input data-f="name" value="${esc(p.name)}" style="min-width:140px"/></td>
        <td><input data-f="aliases" value="${esc((p.aliases || []).join(', '))}" style="min-width:160px"/></td>
        <td><input data-f="category" list="cats" value="${esc(p.category)}"/></td>
        <td><input data-f="price" value="${(p.priceCents / 100).toFixed(2)}" style="width:80px;text-align:right"/></td>
        <td><input data-f="size" value="${esc(p.size)}"/></td>
        <td><input data-f="description" value="${esc(p.description)}" style="min-width:180px"/></td>
        <td><input data-f="tags" value="${esc((p.tags || []).join(', '))}" style="min-width:140px"/></td>
        <td><input data-f="allergens" value="${esc((p.allergens || []).join(', '))}"/></td>
        <td class="num">${stockOf(p.id)}</td>
        <td><input type="checkbox" data-f="featured" ${p.featured ? 'checked' : ''}/></td>
        <td><input type="checkbox" data-f="active" ${p.active !== false ? 'checked' : ''}/></td>
        <td><button class="btn small danger" data-a="del">Quitar</button></td>
      </tr>`).join('')}</tbody></table></div>`;

  $('#pProductos tbody').addEventListener('change', (e) => {
    const p = S.catalog.products[e.target.closest('tr').dataset.i];
    const f = e.target.dataset.f;
    const v = e.target.value;
    if (f === 'aliases' || f === 'tags' || f === 'allergens') p[f] = list(v);
    else if (f === 'price') p.priceCents = toCents(v);
    else if (f === 'featured' || f === 'active') p[f] = e.target.checked;
    else if (f === 'id') {
      const old = p.id;
      p.id = v.trim().toLowerCase();
      S.catalog.slots.forEach((s) => { if (s.productId === old) s.productId = p.id; });
    } else p[f] = v.trim();
  });
  $('#pProductos tbody').addEventListener('click', (e) => {
    if (!e.target.closest('[data-a="del"]')) return;
    const i = Number(e.target.closest('tr').dataset.i);
    const p = S.catalog.products[i];
    if (S.catalog.slots.some((s) => s.productId === p.id)) return toast(`«${p.name}» está en una casilla: quítalo de ahí primero`, true);
    S.catalog.products.splice(i, 1);
    renderProducts();
  });
  $('#addProduct').onclick = () => {
    S.catalog.products.push({ id: `producto-${S.catalog.products.length + 1}`, name: 'Nuevo producto', aliases: [], category: cats[0] || 'chips', priceCents: 500, size: '', description: '', tags: [], allergens: [], featured: false, active: true });
    renderProducts();
  };
  $('#saveProducts').onclick = guard(saveCatalog);
}

// ---------- Ventas ----------
async function loadSales() {
  const today = new Date().toISOString().slice(0, 10);
  const from = $('#salesFrom')?.value || today;
  const to = $('#salesTo')?.value || today;
  const { sales, stats } = await api(`/api/admin/sales?from=${from}&to=${to}T23:59:59.999Z`);
  $('#pVentas').innerHTML = `
    <div class="row spread" style="margin-bottom:14px">
      <h2>Ventas</h2>
      <div class="row">
        <label>Desde <input type="date" id="salesFrom" value="${from}"/></label>
        <label>Hasta <input type="date" id="salesTo" value="${to}"/></label>
        <button class="btn" id="exportCsv" ${sales.length ? '' : 'disabled'}>Descargar CSV</button>
      </div>
    </div>
    <div class="grid g4">
      <div class="card stat"><b>${stats.orders}</b><span>pedidos</span></div>
      <div class="card stat"><b>${stats.units}</b><span>productos entregados</span></div>
      <div class="card stat"><b>${money(stats.revenueCents)}</b><span>cobrado</span></div>
      <div class="card stat"><b>${money(stats.refundCents)}</b><span>reembolsado</span></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>Por producto</h3>${stats.byProduct.length ? `<table><thead><tr><th>Producto</th><th class="num">Unidades</th><th class="num">Ingreso</th></tr></thead><tbody>
        ${stats.byProduct.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.units}</td><td class="num">${money(p.cents)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin ventas en estas fechas.</p>'}</div>
      <div class="card table-wrap"><h3>Pedidos</h3>${sales.length ? `<table><thead><tr><th>Hora</th><th>Productos</th><th>Pago</th><th class="num">Cobrado</th></tr></thead><tbody>
        ${sales.map((s) => `<tr><td>${new Date(s.at).toLocaleString()}</td><td>${s.items.map((i) => `${i.qty} × ${esc(i.name)}`).join('<br>')}${s.failed.length ? `<br><span class="badge bad">${s.failed.length} no salieron</span>` : ''}</td>
          <td>${s.payment.method === 'admin' ? 'aprobado en panel' : `código ${esc(s.payment.code)}`}</td><td class="num">${money(s.chargedCents)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin pedidos.</p>'}</div>
    </div>`;
  $('#salesFrom').onchange = guard(loadSales);
  $('#salesTo').onchange = guard(loadSales);
  $('#exportCsv').onclick = () => {
    const rows = [['fecha', 'pedido', 'producto', 'cantidad', 'precio', 'entregados', 'pago', 'cobrado_pedido', 'reembolsado_pedido']];
    for (const s of sales) for (const i of s.items) {
      rows.push([s.at, s.id, i.name, i.qty, (i.priceCents / 100).toFixed(2), s.delivered.filter((d) => d === i.id).length,
        s.payment.method === 'admin' ? 'panel' : s.payment.code, (s.chargedCents / 100).toFixed(2), (s.refundCents / 100).toFixed(2)]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv' }));
    a.download = `ventas_${from}_${to}.csv`;
    a.click();
  };
}

// ---------- Códigos de pago ----------
function renderCodes() {
  $('#pCodigos').innerHTML = `
    <div class="row spread" style="margin-bottom:14px">
      <h2>Códigos de pago (simulados)</h2>
      <div class="row"><button class="btn" id="addCode">+ Código</button><button class="btn primary" id="saveCodes">Guardar cambios</button></div>
    </div>
    <p class="muted">El cliente dice su código cuando la máquina se lo pide. Funciona como una tarjeta prepagada: se descuenta del saldo y, si algo no sale, se le devuelve. «Un solo uso» lo desactiva tras la primera compra.</p>
    <div class="card table-wrap"><table>
      <thead><tr><th>Código</th><th class="num">Saldo</th><th>Nota</th><th>Un solo uso</th><th>Activo</th><th>Último uso</th><th></th></tr></thead>
      <tbody>${S.codes.map((c, i) => `<tr data-i="${i}">
        <td><input data-f="code" value="${esc(c.code)}" inputmode="numeric" style="width:120px"/></td>
        <td><input data-f="balance" value="${(c.balance / 100).toFixed(2)}" style="width:100px;text-align:right"/></td>
        <td><input data-f="note" value="${esc(c.note)}" style="min-width:200px"/></td>
        <td><input type="checkbox" data-f="singleUse" ${c.singleUse ? 'checked' : ''}/></td>
        <td><input type="checkbox" data-f="active" ${c.active !== false ? 'checked' : ''}/></td>
        <td class="muted">${c.lastUsed ? new Date(c.lastUsed).toLocaleString() : '—'}</td>
        <td><button class="btn small danger" data-a="del">Borrar</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#pCodigos tbody').addEventListener('change', (e) => {
    const c = S.codes[e.target.closest('tr').dataset.i];
    const f = e.target.dataset.f;
    if (f === 'balance') c.balance = toCents(e.target.value);
    else if (f === 'singleUse' || f === 'active') c[f] = e.target.checked;
    else c[f] = e.target.value.trim();
  });
  $('#pCodigos tbody').addEventListener('click', (e) => {
    if (!e.target.closest('[data-a="del"]')) return;
    S.codes.splice(Number(e.target.closest('tr').dataset.i), 1);
    renderCodes();
  });
  $('#addCode').onclick = () => {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    S.codes.push({ code, balance: 2000, note: '', singleUse: false, active: true });
    renderCodes();
  };
  $('#saveCodes').onclick = guard(async () => { await api('/api/admin/codes', { method: 'PUT', body: S.codes }); toast('Códigos guardados'); await load(); });
}

// ---------- Probar ----------
const chatLog = [];
function renderTest() {
  const buttons = [...S.catalog.slots.map((s) => s.slot), ...(S.config.buttons.confirm || []).slice(0, 1), ...(S.config.buttons.cancel || []).slice(0, 1)];
  $('#pProbar').innerHTML = `
    <div class="grid g2">
      <div class="card stack">
        <h3>Conversación de prueba</h3>
        <p class="muted" style="margin:0">Escribe como si fueras un cliente. Usa el pedido real de la máquina, y el avatar no lo dice en voz alta. Debajo de cada respuesta verás cómo la entendió y si se usó el estilo o el borrador.</p>
        <div class="chat" id="chat">${chatLog.join('')}</div>
        <form id="testForm" class="row"><input id="testText" placeholder="¿Qué tenés de tomar?" autocomplete="off" style="flex:1"/><button class="btn primary">Enviar</button></form>
      </div>
      <div class="stack">
        <div class="card stack">
          <h3>Botones físicos</h3>
          <div class="keys">${buttons.map((b) => `<button class="btn" data-btn="${esc(b)}">${esc(b)}</button>`).join('')}</div>
          <p class="muted" style="margin:0">Simulan los botones de la máquina: el avatar responde en voz alta.</p>
        </div>
        <div class="card stack">
          <h3>Hacer hablar al avatar</h3>
          <form id="sayForm" class="row"><input id="sayText" placeholder="¡Ya rellené las Coca-Colas, bien frías!" style="flex:1"/><button class="btn">Decir</button></form>
        </div>
      </div>
    </div>`;
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;
  $('#testForm').onsubmit = guard(async (e) => {
    e.preventDefault();
    const text = $('#testText').value.trim();
    if (!text) return;
    $('#testText').value = '';
    chatLog.push(`<div class="bubble me">${esc(text)}</div>`);
    renderTest();
    const r = await api('/api/admin/test/turn', { method: 'POST', body: { text } });
    const d = r.debug;
    const how = d.source === 'modelo' ? 'entendido por el modelo' : d.source === 'atajo' ? 'atajo directo' : `reglas de respaldo${d.llmError ? ` (${d.llmError})` : ''}`;
    const used = d.styled ? (d.validation?.ok ? '✔ con estilo' : `✘ estilo rechazado: ${d.validation?.reason}, se dijo el borrador`) : 'borrador';
    chatLog.push(`<div class="bubble bot">${esc(r.say)}<small>${esc(how)} · intención «${esc(d.nlu.intent)}» · ${esc(used)}</small>
      <details><summary class="muted">detalle</summary><div class="debug">${esc(JSON.stringify({ entendido: d.nlu, borrador: d.draft, estilo: d.styled }, null, 2))}</div></details></div>`);
    renderTest();
    $('#testText').focus();
  });
  $('#pProbar .keys').onclick = guard(async (e) => {
    const b = e.target.closest('[data-btn]');
    if (b) await api('/api/admin/test/button', { method: 'POST', body: { button: b.dataset.btn } });
  });
  $('#sayForm').onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('/api/admin/say', { method: 'POST', body: { text: $('#sayText').value } });
    $('#sayText').value = '';
    toast('Enviado al avatar');
  });
}

// ---------- Configuración ----------
function renderConfig() {
  const c = S.config;
  const f = (path, label, type = 'text', extra = '') => {
    const v = path.split('.').reduce((o, k) => o?.[k], c);
    if (type === 'textarea') return `<label>${label}<textarea data-p="${path}" rows="5">${esc(v)}</textarea></label>`;
    if (type === 'checkbox') return `<label class="row" style="gap:8px;color:var(--text)"><input type="checkbox" data-p="${path}" ${v ? 'checked' : ''}/> ${label}</label>`;
    return `<label>${label}<input data-p="${path}" type="${type}" value="${esc(Array.isArray(v) ? v.join(', ') : v)}" ${extra}/></label>`;
  };
  $('#pConfig').innerHTML = `
    <div class="row spread" style="margin-bottom:14px"><h2>Configuración</h2><button class="btn primary" id="saveConfig">Guardar cambios</button></div>
    <div class="grid g2">
      <div class="card stack"><h3>Encargado (personaje)</h3>
        ${f('persona.name', 'Nombre')}
        ${f('persona.style', 'Cómo habla (estilo). Solo cambia la forma de decir las cosas, nunca los datos.', 'textarea')}
        ${f('persona.greeting', 'Saludo inicial')}
        <div class="grid g2">${f('persona.voice', 'Voz de Microsoft', 'text', 'list="voices"')}${f('persona.hue', 'Color del rostro (0-360)', 'number', 'min="0" max="360"')}
          ${f('persona.rate', 'Velocidad de voz', 'number', 'step="0.05" min="0.6" max="1.6"')}${f('persona.pitch', 'Tono de voz', 'number', 'step="0.05" min="0.5" max="1.8"')}</div>
        <datalist id="voices"><option value="es-GT-AndresNeural"><option value="es-GT-MartaNeural"><option value="es-MX-JorgeNeural"><option value="es-MX-DaliaNeural"></datalist>
      </div>
      <div class="stack">
        <div class="card stack"><h3>Máquina</h3>
          <label>Conexión<select data-p="machine.driver"><option value="simulador" ${c.machine.driver !== 'serial' ? 'selected' : ''}>Simulador (sin hardware)</option><option value="serial" ${c.machine.driver === 'serial' ? 'selected' : ''}>Arduino por USB</option></select></label>
          <div class="grid g2">${f('machine.port', 'Puerto (Windows: COM3 · Linux: /dev/ttyACM0)')}${f('machine.baudRate', 'Baudios', 'number')}
            ${f('machine.vendTimeoutMs', 'Tiempo máximo por despacho (ms)', 'number')}${f('machine.simDelayMs', 'Simulador: demora (ms)', 'number')}</div>
          ${f('machine.simFailSlots', 'Simulador: casillas que fallan (para probar reembolsos), separadas por coma')}
        </div>
        <div class="card stack"><h3>Venta</h3>
          <div class="grid g2">${f('sales.maxItems', 'Máximo de productos por compra', 'number')}${f('sales.lowStock', 'Alerta cuando queden', 'number')}
            ${f('sales.sessionTimeoutS', 'Cancelar pedido inactivo tras (s)', 'number')}${f('sales.paymentTimeoutS', 'Esperar el código hasta (s)', 'number')}</div>
          <div class="grid g2">${f('buttons.confirm', 'Botones que confirman/pagan')}${f('buttons.cancel', 'Botones que cancelan')}</div>
          <div class="grid g2">${f('currency.symbol', 'Símbolo de moneda')}${f('currency.plural', 'Moneda en plural (para la voz)')}</div>
        </div>
        <div class="card stack"><h3>Modelo de lenguaje</h3>
          <p class="muted" style="margin:0">${S.llm ? 'Clave de Groq configurada.' : '⚠ Sin GROQ_API_KEY: la máquina usa reglas simples y no le da estilo a las respuestas.'}</p>
          <div class="grid g2">${f('llm.model', 'Modelo de Groq')}${f('llm.timeoutMs', 'Tiempo máximo (ms)', 'number')}</div>
          ${f('llm.style', 'Dar estilo a las respuestas (si se apaga, dice el borrador exacto)', 'checkbox')}
        </div>
      </div>
    </div>`;
  $('#saveConfig').onclick = guard(async () => {
    const next = structuredClone(S.config);
    document.querySelectorAll('#pConfig [data-p]').forEach((el) => {
      const keys = el.dataset.p.split('.');
      const last = keys.pop();
      const obj = keys.reduce((o, k) => o[k], next);
      const old = obj[last];
      if (el.type === 'checkbox') obj[last] = el.checked;
      else if (Array.isArray(old)) obj[last] = list(el.value).map((x) => x.toUpperCase());
      else if (typeof old === 'number') obj[last] = Number(el.value);
      else obj[last] = el.value;
    });
    next.currency.singular = next.currency.plural.replace(/es$/, '').replace(/s$/, '') || next.currency.singular;
    const r = await api('/api/admin/config', { method: 'PUT', body: next });
    toast(`Configuración guardada${r.machine ? ` · máquina ${r.machine.connected ? 'conectada' : 'desconectada'}` : ''}`);
    await load();
  });
}

// ---------- Eventos en vivo ----------
let es;
function startEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.addEventListener('display', (e) => {
    S.session = JSON.parse(e.data);
    if (tab === 'resumen') renderSummary();
  });
  es.addEventListener('say', (e) => {
    const d = JSON.parse(e.data);
    if (tab === 'probar') { chatLog.push(`<div class="bubble bot">🔊 ${esc(d.say)}<small>dicho por el avatar</small></div>`); renderTest(); }
  });
  es.addEventListener('admin', (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'low_stock') toast(`Quedan ${d.left} de ${d.product}`);
    if (d.type === 'machine') { S.machine = d.status; render(); }
  });
  // Refresco periódico de números y actividad
  clearInterval(startEvents.t);
  startEvents.t = setInterval(() => { if (tab === 'resumen') load().catch(() => {}); }, 15000);
}

// Entrar directo si ya hay PIN guardado en esta pestaña
if (pin) {
  load().then(() => { $('#login').hidden = true; $('#app').hidden = false; startEvents(); }).catch(() => logout());
}
