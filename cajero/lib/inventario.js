// Cliente de la API de tu programa de inventario (ver API.md).
// Traduce sus campos en español al formato interno del cajero y guarda la última lista de productos
// para seguir funcionando si el programa no responde un momento.

export class InventoryError extends Error {
  constructor(message, { status = 0, data = {} } = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const toCents = (v) => Math.round(Number(v) * 100);
const asList = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()) : []);

// Producto de tu programa → producto del cajero
export function mapProduct(p) {
  return {
    id: String(p.id),
    name: String(p.nombre ?? p.name ?? p.id),
    priceCents: toCents(p.precio ?? p.price ?? 0),
    stock: Math.max(0, Math.floor(Number(p.existencias ?? p.stock ?? 0))),
    category: p.categoria ? String(p.categoria).toLowerCase() : 'productos',
    aliases: asList(p.alias),
    size: p.tamano ?? p.tamaño ?? '',
    description: p.descripcion ?? '',
    tags: asList(p.etiquetas),
    allergens: asList(p.alergenos),
    featured: Boolean(p.destacado),
    slot: p.casilla ? String(p.casilla).toUpperCase() : null,
  };
}

export class Inventario {
  constructor({ url, token = '', timeoutMs = 5000 }) {
    this.url = String(url || '').replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.products = [];
    this.updatedAt = 0;
    this.lastError = null;
  }

  async request(path, { method = 'GET', body } = {}) {
    if (!this.url) throw new InventoryError('Falta INVENTARIO_URL');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new InventoryError(data.error || `HTTP ${res.status}`, { status: res.status, data });
      return data;
    } catch (e) {
      if (e instanceof InventoryError) throw e;
      throw new InventoryError(e.name === 'AbortError' ? 'El programa de inventario tardó demasiado' : `Sin conexión con el inventario: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Lista de productos (si falla, se queda con la última que tenía)
  async refresh() {
    try {
      const data = await this.request('/productos');
      const list = Array.isArray(data) ? data : data.productos || [];
      this.products = list.map(mapProduct).filter((p) => p.id && p.priceCents > 0);
      this.updatedAt = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      throw e;
    }
    return this.products;
  }

  get connected() { return !this.lastError && this.updatedAt > 0; }

  crearPedido(items) {
    return this.request('/pedidos', { method: 'POST', body: { items: items.map(({ id, qty }) => ({ id, cantidad: qty })) } });
  }

  verPedido(id) { return this.request(`/pedidos/${encodeURIComponent(id)}`); }

  cancelarPedido(id) { return this.request(`/pedidos/${encodeURIComponent(id)}/cancelar`, { method: 'POST' }); }
}
