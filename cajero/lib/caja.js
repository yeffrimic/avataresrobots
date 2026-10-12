// La caja: el pedido del cliente y su ciclo con tu programa de inventario.
// Todo es determinista. El modelo de lenguaje nunca llama aquí directamente.
//
// Estados:  idle → shopping → awaiting_payment → dispensing → idle
//           (el carrito vive aquí; desde «awaiting_payment» el pedido vive en tu programa)
// Eventos:  'change', 'paid', 'done', 'cancelled', 'expired'
import { EventEmitter } from 'node:events';

const FINISHED = new Set(['entregado', 'fallido']);
const ABORTED = new Set(['cancelado', 'vencido', 'rechazado']);

export class Caja extends EventEmitter {
  constructor({ inventario, config }) {
    super();
    this.inv = inventario;
    this.config = config; // función que devuelve la configuración actual
    this.state = 'idle';
    this.cart = new Map(); // id → cantidad
    this.order = null; // { id, totalCents, paid }
    this.lastMentioned = [];
  }

  get cfg() { return this.config().caja; }

  // ---------- Catálogo (viene de tu programa) ----------
  products() { return this.inv.products; }
  product(id) { return this.inv.products.find((p) => p.id === id) || null; }
  productBySlot(slot) { return this.inv.products.find((p) => p.slot === String(slot).toUpperCase()) || null; }
  available(id) { return this.product(id)?.stock ?? 0; }
  inStock() { return this.inv.products.filter((p) => p.stock > 0); }

  summary() {
    const items = [...this.cart].map(([id, qty]) => {
      const p = this.product(id);
      const price = p?.priceCents ?? 0;
      return { id, name: p?.name ?? id, qty, priceCents: price, subtotalCents: price * qty };
    });
    const cartTotal = items.reduce((a, i) => a + i.subtotalCents, 0);
    return {
      state: this.state,
      items,
      // Mientras se paga, el total que vale es el que devolvió tu programa
      totalCents: this.order?.totalCents ?? cartTotal,
      count: items.reduce((a, i) => a + i.qty, 0),
      orderId: this.order?.id ?? null,
    };
  }

  _setState(s) {
    this.state = s;
    this.emit('change');
  }

  // ---------- Inactividad ----------
  touch() {
    clearTimeout(this._idle);
    if (this.state !== 'shopping') return;
    this._idle = setTimeout(() => {
      if (this.state !== 'shopping') return;
      this.reset();
      this.emit('expired', { stage: 'shopping' });
    }, this.cfg.sessionTimeoutS * 1000);
    this._idle.unref?.();
  }

  reset() {
    clearTimeout(this._idle);
    clearTimeout(this._payTimer);
    clearInterval(this._poll);
    this.cart.clear();
    this.order = null;
    this.lastMentioned = [];
    this._setState('idle');
  }

  // ---------- Carrito ----------
  async add(id, qty = 1) {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    const p = this.product(id);
    if (!p) return { ok: false, reason: 'no_existe' };
    qty = Math.max(1, Math.floor(Number(qty) || 1));
    const inCart = this.cart.get(id) || 0;
    if (p.stock === 0) return { ok: false, reason: 'agotado', product: p };
    if (inCart + qty > p.stock) return { ok: false, reason: 'insuficiente', product: p, available: p.stock - inCart };
    if (this.summary().count + qty > this.cfg.maxItems) return { ok: false, reason: 'limite', product: p, max: this.cfg.maxItems };
    await this._reopen();
    this.cart.set(id, inCart + qty);
    this._setState('shopping');
    this.touch();
    return { ok: true, product: p, qty };
  }

  async remove(id) {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    const p = this.product(id);
    if (!this.cart.has(id)) return { ok: false, reason: 'no_esta', product: p };
    await this._reopen();
    this.cart.delete(id);
    if (this.cart.size) { this._setState('shopping'); this.touch(); } else this.reset();
    return { ok: true, product: p };
  }

  // Si estaba esperando el pago y cambia el pedido, se cancela el de tu programa y se vuelve a armar
  async _reopen() {
    if (this.state !== 'awaiting_payment' || !this.order) return;
    const id = this.order.id;
    clearTimeout(this._payTimer);
    clearInterval(this._poll);
    this.order = null;
    await this.inv.cancelarPedido(id).catch(() => {});
  }

  async cancel() {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    if (this.order) {
      try {
        await this.inv.cancelarPedido(this.order.id);
      } catch (e) {
        if (e.status === 409) return { ok: false, reason: 'ya_pagado' };
        // Si el programa no responde, igual soltamos el pedido aquí
      }
    }
    const had = this.cart.size > 0;
    this.reset();
    return { ok: true, had };
  }

  // ---------- Cobro: el pedido pasa a tu programa ----------
  async checkout() {
    if (this.state === 'dispensing') return { ok: false, reason: 'ocupada' };
    if (!this.cart.size) return { ok: false, reason: 'vacio' };
    if (this.state === 'awaiting_payment' && this.order) return { ok: true, ...this.summary(), again: true };
    await this.inv.refresh().catch(() => {});
    for (const [id, qty] of this.cart) {
      const p = this.product(id);
      if (!p || p.stock < qty) return { ok: false, reason: 'insuficiente', product: p, available: p?.stock ?? 0 };
    }
    const items = this.summary().items;
    let r;
    try {
      r = await this.inv.crearPedido(items);
    } catch (e) {
      if (e.status === 409) {
        const p = this.product(e.data.id);
        return { ok: false, reason: 'insuficiente', product: p, available: Number(e.data.disponibles) || 0 };
      }
      return { ok: false, reason: 'sin_conexion', error: e.message };
    }
    if (!r?.id) return { ok: false, reason: 'sin_conexion', error: 'Respuesta sin id de pedido' };
    const cartTotal = items.reduce((a, i) => a + i.subtotalCents, 0);
    this.order = { id: String(r.id), totalCents: r.total != null ? Math.round(Number(r.total) * 100) : cartTotal, paid: false, done: false };
    clearTimeout(this._idle);
    this._setState('awaiting_payment');
    this._watch();
    return { ok: true, ...this.summary() };
  }

  // Consulta el estado del pedido cada pocos ms y lo cancela si el pago tarda demasiado
  _watch() {
    clearInterval(this._poll);
    clearTimeout(this._payTimer);
    const id = this.order.id;
    this._poll = setInterval(async () => {
      if (!this.order || this.order.id !== id) return;
      try { this.update(await this.inv.verPedido(id)); } catch { /* reintenta en la siguiente vuelta */ }
    }, this.config().inventario.pollMs);
    this._poll.unref?.();
    this._payTimer = setTimeout(async () => {
      if (!this.order || this.order.id !== id || this.order.paid) return;
      await this.inv.cancelarPedido(id).catch(() => {});
      this.reset();
      this.emit('expired', { stage: 'payment' });
    }, this.cfg.paymentTimeoutS * 1000);
    this._payTimer.unref?.();
  }

  // Estado que llega de tu programa (por consulta o por evento). Se puede llamar varias veces.
  update(status = {}) {
    const o = this.order;
    if (!o || String(status.id ?? o.id) !== o.id || o.done) return;
    const estado = String(status.estado || '').toLowerCase();
    if ((estado === 'pagado' || estado === 'despachando') && !o.paid) {
      o.paid = true;
      clearTimeout(this._payTimer);
      this._setState('dispensing');
      this.emit('paid');
    }
    if (FINISHED.has(estado)) {
      o.done = true;
      const ids = (v) => (Array.isArray(v) ? v.map(String) : []);
      const delivered = ids(status.entregados);
      const failed = estado === 'fallido' && !status.fallidos ? [...this.cart.keys()] : ids(status.fallidos);
      const refundCents = Math.round(Number(status.reembolso || 0) * 100);
      this.emit('done', {
        delivered: delivered.map((id) => this.product(id)).filter(Boolean),
        failed: failed.map((id) => this.product(id)).filter(Boolean),
        refundCents,
        message: status.mensaje || null,
      });
      this.reset();
      this.inv.refresh().catch(() => {});
    } else if (ABORTED.has(estado)) {
      o.done = true;
      this.reset();
      this.emit('cancelled', { estado, message: status.mensaje || null });
    }
  }
}
