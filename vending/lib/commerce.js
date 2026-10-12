// Lógica de venta, 100 % determinista: carrito, cobro, despacho, existencias y ventas.
// El modelo de lenguaje NUNCA decide nada aquí: solo se llama a estos métodos con datos validados.
//
// Estados:  idle → shopping → awaiting_payment → dispensing → idle
// Eventos:  'change' (cambió el carrito o el estado), 'dispensing', 'dispensed', 'failed',
//           'done', 'low_stock', 'expired'
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class Commerce extends EventEmitter {
  constructor({ store, machine }) {
    super();
    this.store = store;
    this.machine = machine;
    this.state = 'idle';
    this.cart = new Map(); // productId → cantidad
    this.lastMentioned = []; // ids de productos de los que se habló hace poco (para «sí, dámelo»)
  }

  get cfg() { return this.store.config.sales; }

  // ---------- Sesión ----------
  touch() {
    clearTimeout(this._timer);
    if (this.state === 'dispensing' || this.state === 'idle') return;
    const s = this.state === 'awaiting_payment' ? this.cfg.paymentTimeoutS : this.cfg.sessionTimeoutS;
    this._timer = setTimeout(() => {
      if (this.state === 'dispensing') return;
      const hadItems = this.cart.size > 0;
      this.reset();
      if (hadItems) this.emit('expired');
    }, s * 1000);
    this._timer.unref?.(); // no mantener vivo el proceso solo por esto
  }

  reset() {
    clearTimeout(this._timer);
    this.cart.clear();
    this.lastMentioned = [];
    this._setState('idle');
  }

  _setState(state) {
    this.state = state;
    this.emit('change');
  }

  // ---------- Consultas ----------
  available(productId) { return this.store.stockOf(productId); }

  inStock() { return this.store.products().filter((p) => this.available(p.id) > 0); }

  summary() {
    const items = [...this.cart].map(([id, qty]) => {
      const p = this.store.product(id);
      return { id, name: p.name, qty, priceCents: p.priceCents, subtotalCents: p.priceCents * qty };
    });
    return { state: this.state, items, totalCents: items.reduce((a, i) => a + i.subtotalCents, 0), count: items.reduce((a, i) => a + i.qty, 0) };
  }

  // ---------- Carrito ----------
  add(productId, qty = 1) {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    const p = this.store.product(productId);
    if (!p || p.active === false) return { ok: false, reason: 'no_existe' };
    qty = Math.max(1, Math.floor(Number(qty) || 1));
    const inCart = this.cart.get(productId) || 0;
    const stock = this.available(productId);
    if (stock === 0) return { ok: false, reason: 'agotado', product: p };
    if (inCart + qty > stock) return { ok: false, reason: 'insuficiente', product: p, available: stock - inCart };
    const count = this.summary().count;
    if (count + qty > this.cfg.maxItems) return { ok: false, reason: 'limite', product: p, max: this.cfg.maxItems };
    this.cart.set(productId, inCart + qty);
    if (this.state === 'idle' || this.state === 'awaiting_payment') this._setState('shopping');
    else this.emit('change');
    this.touch();
    return { ok: true, product: p, qty };
  }

  remove(productId, qty = null) {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    const inCart = this.cart.get(productId);
    if (!inCart) return { ok: false, reason: 'no_esta', product: this.store.product(productId) };
    const left = qty ? Math.max(0, inCart - qty) : 0;
    if (left) this.cart.set(productId, left); else this.cart.delete(productId);
    if (!this.cart.size) this._setState('idle');
    else { if (this.state === 'awaiting_payment') this._setState('shopping'); else this.emit('change'); }
    this.touch();
    return { ok: true, product: this.store.product(productId), removed: inCart - left };
  }

  cancel() {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    const had = this.cart.size > 0;
    this.reset();
    return { ok: true, had };
  }

  // ---------- Cobro ----------
  requestPayment() {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    if (!this.cart.size) return { ok: false, reason: 'vacio' };
    // Revalidar existencias justo antes de cobrar
    for (const [id, qty] of this.cart) {
      if (this.available(id) < qty) return { ok: false, reason: 'insuficiente', product: this.store.product(id), available: this.available(id) };
    }
    this._setState('awaiting_payment');
    this.touch();
    return { ok: true, ...this.summary() };
  }

  /**
   * Cobra el carrito. method: 'codigo' (con code) o 'admin' (aprobado desde el panel: simula efectivo).
   * Si el cobro pasa, el despacho arranca en segundo plano y avisa con eventos.
   */
  pay({ method = 'codigo', code = null } = {}) {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    if (!this.cart.size) return { ok: false, reason: 'vacio' };
    if (this.state !== 'awaiting_payment') {
      const r = this.requestPayment();
      if (!r.ok) return r;
    }
    const { totalCents, items } = this.summary();
    let account = null;
    if (method === 'codigo') {
      account = this.store.findCode(code);
      if (!account) { this.touch(); return { ok: false, reason: 'codigo_invalido' }; }
      if (account.balance < totalCents) { this.touch(); return { ok: false, reason: 'saldo', balanceCents: account.balance, totalCents }; }
      account.balance -= totalCents;
      if (account.singleUse) account.active = false;
      account.lastUsed = new Date().toISOString();
      this.store.save('codes');
    }
    const order = {
      id: randomUUID(),
      at: new Date().toISOString(),
      items: items.map((i) => ({ ...i })),
      totalCents,
      payment: { method, code: account ? maskCode(account.code) : null },
      account,
    };
    this.cart.clear();
    this._setState('dispensing');
    clearTimeout(this._timer);
    this._dispense(order); // en segundo plano
    return { ok: true, totalCents, items, balanceCents: account ? account.balance : null };
  }

  // ---------- Despacho ----------
  async _dispense(order) {
    const delivered = [];
    const failed = [];
    for (const item of order.items) {
      const p = this.store.product(item.id);
      for (let n = 0; n < item.qty; n++) {
        this.emit('dispensing', { product: p });
        const ok = await this._vendOne(p);
        if (ok) delivered.push(p.id);
        else failed.push(p.id);
        this.emit(ok ? 'dispensed' : 'failed', { product: p });
      }
    }
    // Reembolso de lo que no se pudo entregar
    const refundCents = failed.reduce((a, id) => a + this.store.product(id).priceCents, 0);
    if (refundCents && order.account) {
      order.account.balance += refundCents;
      if (order.account.singleUse) order.account.active = true;
      this.store.save('codes');
    }
    this.store.save('catalog');
    this.store.appendSale({
      id: order.id,
      at: order.at,
      items: order.items.map(({ id, name, qty, priceCents }) => ({ id, name, qty, priceCents })),
      delivered,
      failed,
      totalCents: order.totalCents,
      chargedCents: order.totalCents - refundCents,
      refundCents,
      payment: order.payment,
    });
    this.lastMentioned = [];
    this._setState('idle');
    this.emit('done', {
      delivered: delivered.map((id) => this.store.product(id)),
      failed: failed.map((id) => this.store.product(id)),
      refundCents,
      balanceCents: order.account ? order.account.balance : null,
    });
  }

  // Intenta cada casilla con ese producto hasta que una despache
  async _vendOne(p) {
    const candidates = this.store.slots().filter((s) => s.productId === p.id && s.enabled !== false && s.stock > 0);
    for (const slot of candidates) {
      const r = await this.machine.vend(slot.slot);
      this.store.logEvent(r.ok ? 'vend_ok' : 'vend_fail', { slot: slot.slot, product: p.id, reason: r.reason });
      if (r.ok) {
        slot.stock -= 1;
        const left = this.available(p.id);
        if (left <= this.cfg.lowStock) this.emit('low_stock', { product: p, left });
        return true;
      }
      // Si el Arduino dice que está vacía, corregimos el inventario
      if (r.reason === 'EMPTY') slot.stock = 0;
      if (r.reason === 'DESCONECTADA') return false;
    }
    return false;
  }
}

export const maskCode = (code) => (String(code).length <= 2 ? '**' : `${'*'.repeat(String(code).length - 2)}${String(code).slice(-2)}`);
