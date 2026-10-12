// Persistencia en archivos JSON (sin base de datos): catálogo, configuración, códigos de pago
// y un registro de ventas línea por línea (sales.jsonl). La primera vez se copia /seed a /data.
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['catalog', 'config', 'codes'];

export class Store {
  constructor(root) {
    this.dataDir = path.join(root, 'data');
    this.seedDir = path.join(root, 'seed');
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const name of FILES) {
      const file = this._file(name);
      if (!fs.existsSync(file)) fs.copyFileSync(path.join(this.seedDir, `${name}.json`), file);
      this[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    this.salesFile = path.join(this.dataDir, 'sales.jsonl');
    this.eventsFile = path.join(this.dataDir, 'events.jsonl');
  }

  _file(name) { return path.join(this.dataDir, `${name}.json`); }

  // Escritura atómica: si se va la luz a media escritura, el archivo anterior queda intacto
  save(name) {
    const file = this._file(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this[name], null, 2));
    fs.renameSync(tmp, file);
  }

  // ---------- Catálogo ----------
  products({ includeInactive = false } = {}) {
    return this.catalog.products.filter((p) => includeInactive || p.active !== false);
  }
  product(id) { return this.catalog.products.find((p) => p.id === id) || null; }
  slots() { return this.catalog.slots; }
  slot(code) { return this.catalog.slots.find((s) => s.slot === code) || null; }

  // Existencias totales de un producto sumando sus casillas habilitadas
  stockOf(productId) {
    return this.catalog.slots
      .filter((s) => s.productId === productId && s.enabled !== false)
      .reduce((a, s) => a + s.stock, 0);
  }

  // ---------- Códigos de pago (simulados) ----------
  findCode(code) {
    return this.codes.find((c) => c.code === String(code) && c.active !== false) || null;
  }

  // ---------- Registros ----------
  appendSale(sale) { fs.appendFileSync(this.salesFile, `${JSON.stringify(sale)}\n`); }
  logEvent(type, data = {}) {
    fs.appendFileSync(this.eventsFile, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
  }

  sales({ from, to } = {}) {
    if (!fs.existsSync(this.salesFile)) return [];
    return fs.readFileSync(this.salesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((s) => (!from || s.at >= from) && (!to || s.at <= to));
  }

  events(limit = 100) {
    if (!fs.existsSync(this.eventsFile)) return [];
    return fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
  }
}
