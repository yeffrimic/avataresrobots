// Control de la máquina física.
//
// Protocolo por USB serial con el Arduino (texto, una orden por línea, 9600 baudios):
//   PC → Arduino:   VEND A1        despacha una unidad de la casilla A1
//                   PING
//   Arduino → PC:   READY          al arrancar
//                   PONG
//                   DONE A1        la unidad cayó (o el motor completó la vuelta)
//                   FAIL A1 EMPTY  no cayó nada / casilla vacía (también JAM, TIMEOUT…)
//                   BTN A1         alguien apachó un botón físico (A1, OK, CANCEL…)
//                   CREDIT 500     (futuro) monedero: entró crédito en centavos
//
// El firmware de referencia está en firmware/maquina/maquina.ino.
import { EventEmitter } from 'node:events';

export function parseLine(raw) {
  const line = String(raw).trim();
  const [cmd = '', a, b] = line.split(/\s+/);
  switch (cmd.toUpperCase()) {
    case 'READY': return { type: 'ready' };
    case 'PONG': return { type: 'pong' };
    case 'DONE': return a ? { type: 'done', slot: a.toUpperCase() } : { type: 'unknown', line };
    case 'FAIL': return a ? { type: 'fail', slot: a.toUpperCase(), reason: (b || 'ERROR').toUpperCase() } : { type: 'unknown', line };
    case 'BTN': return a ? { type: 'button', button: a.toUpperCase() } : { type: 'unknown', line };
    case 'CREDIT': return Number.isFinite(Number(a)) ? { type: 'credit', cents: Number(a) } : { type: 'unknown', line };
    default: return { type: 'unknown', line };
  }
}

class BaseMachine extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.pending = new Map(); // casilla → { resolve, timer }
    this.connected = false;
    this.lastError = null;
  }

  get status() {
    return { driver: this.driver, connected: this.connected, busy: this.pending.size > 0, lastError: this.lastError };
  }

  // Despacha una unidad. Nunca lanza: resuelve { ok } o { ok:false, reason }
  vend(slot) {
    if (!this.connected) return Promise.resolve({ ok: false, reason: 'DESCONECTADA' });
    if (this.pending.has(slot)) return Promise.resolve({ ok: false, reason: 'OCUPADA' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this._settle(slot, { ok: false, reason: 'TIMEOUT' }), this.cfg.vendTimeoutMs || 15000);
      this.pending.set(slot, { resolve, timer });
      this._sendVend(slot);
    });
  }

  _settle(slot, result) {
    const p = this.pending.get(slot);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(slot);
    p.resolve(result);
  }

  _handle(msg) {
    if (msg.type === 'done') this._settle(msg.slot, { ok: true });
    else if (msg.type === 'fail') this._settle(msg.slot, { ok: false, reason: msg.reason });
    else if (msg.type === 'button') this.emit('button', msg.button);
    else if (msg.type === 'credit') this.emit('credit', msg.cents);
    else if (msg.type === 'ready') this.emit('ready');
  }

  async close() {}
}

// Máquina simulada: despacha después de un rato; falla en las casillas de cfg.simFailSlots
export class SimulatorMachine extends BaseMachine {
  driver = 'simulador';

  async connect() { this.connected = true; }

  _sendVend(slot) {
    const fail = (this.cfg.simFailSlots || []).includes(slot);
    setTimeout(() => this._handle(fail ? { type: 'fail', slot, reason: 'JAM' } : { type: 'done', slot }), this.cfg.simDelayMs ?? 1800);
  }

  // Desde el panel de administración: simular que alguien apachó un botón
  press(button) { this._handle({ type: 'button', button: String(button).toUpperCase() }); }
}

// Arduino por USB. Usa la librería «serialport» (npm install en esta carpeta).
export class SerialMachine extends BaseMachine {
  driver = 'serial';

  async connect() {
    let SerialPort, ReadlineParser;
    try {
      ({ SerialPort } = await import('serialport'));
      ({ ReadlineParser } = await import('@serialport/parser-readline'));
    } catch {
      throw new Error('Falta la librería serialport. Ejecuta «npm install» dentro de la carpeta vending.');
    }
    this._open = () => {
      const port = new SerialPort({ path: this.cfg.port, baudRate: this.cfg.baudRate || 9600 });
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', (line) => this._handle(parseLine(line)));
      port.on('open', () => { this.connected = true; this.lastError = null; this.emit('status'); });
      port.on('close', () => this._lost('Puerto cerrado'));
      port.on('error', (e) => this._lost(e.message));
      this.port = port;
    };
    this._open();
  }

  _lost(reason) {
    this.connected = false;
    this.lastError = reason;
    this.emit('status');
    for (const slot of [...this.pending.keys()]) this._settle(slot, { ok: false, reason: 'DESCONECTADA' });
    // Reintento automático: el Arduino puede reiniciarse o desconectarse un momento
    clearTimeout(this._retry);
    this._retry = setTimeout(() => { if (!this.connected && !this.closed) this._open(); }, 3000);
  }

  _sendVend(slot) { this.port.write(`VEND ${slot}\n`); }

  async close() {
    this.closed = true;
    clearTimeout(this._retry);
    if (this.port?.isOpen) await new Promise((r) => this.port.close(r));
  }
}

export function createMachine(cfg) {
  return cfg.driver === 'serial' ? new SerialMachine(cfg) : new SimulatorMachine(cfg);
}
