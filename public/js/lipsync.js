// Sincronización labial.
// Convierte el texto en una línea de tiempo de "visemas" (formas de boca) pensada para español,
// y la reproduce sincronizada con la voz:
//  - Voz del navegador: duración estimada + re-sincronización con los eventos de palabra.
//  - Voz de Groq (audio): duración exacta del audio + volumen real para abrir/cerrar la boca.

export const VISEMES = {
  sil: { open: 0, wide: 0, round: 0, closed: 0 },
  A: { open: 1, wide: 0.3, round: 0, closed: 0 },
  E: { open: 0.55, wide: 0.85, round: 0, closed: 0 },
  I: { open: 0.3, wide: 1, round: 0, closed: 0 },
  O: { open: 0.75, wide: 0, round: 0.85, closed: 0 },
  U: { open: 0.35, wide: 0, round: 1, closed: 0 },
  M: { open: 0, wide: 0.1, round: 0, closed: 1 },
  F: { open: 0.12, wide: 0.45, round: 0, closed: 0.3 },
  C: { open: 0.25, wide: 0.35, round: 0, closed: 0 },
};

const LETTERS = [
  ['aáàâä', 'A', 1],
  ['eéèêë', 'E', 0.9],
  ['iíìîïy', 'I', 0.8],
  ['oóòôö', 'O', 1],
  ['uúùûü', 'U', 0.85],
  ['mbpv', 'M', 0.7],
  ['f', 'F', 0.7],
];
const PAUSES = { ' ': 0.25, ',': 1.4, ';': 1.4, ':': 1.4, '.': 2.2, '!': 2.2, '?': 2.2, '…': 2.2, '\n': 1.6 };

export function buildTimeline(text) {
  const items = [];
  let t = 0;
  const push = (v, w, i) => { items.push({ v, start: t, end: t + w, i }); t += w; };
  const s = text.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === 'h') continue; // muda en español
    const hit = LETTERS.find(([chars]) => chars.includes(ch));
    if (hit) push(hit[1], hit[2], i);
    else if (/\d/.test(ch)) { push('E', 0.9, i); push('O', 0.9, i); }
    else if (/\p{L}/u.test(ch)) push('C', 0.55, i);
    else if (PAUSES[ch]) push('sil', PAUSES[ch], i);
  }
  return { items, total: Math.max(t, 0.001) };
}

const BASE_SEC_PER_UNIT = 0.075;
const now = () => performance.now() / 1000;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class LipSync {
  constructor(avatar) {
    this.avatar = avatar;
    this.active = null;
    avatar.addUpdater(() => this._update());
  }

  // duration: segundos exactos (audio) | rate: velocidad de la voz del navegador (estimación)
  start({ text, duration, rate = 1, offset = 0, getLevel = null }) {
    const tl = buildTimeline(text);
    const spu = duration ? duration / tl.total : BASE_SEC_PER_UNIT / rate;
    const t0 = now() + offset;
    this.active = { ...tl, spu, t0, startedAt: t0, getLevel, cursor: 0 };
  }

  // Llamado en cada evento de palabra de la voz del navegador
  resync(charIndex) {
    const a = this.active;
    if (!a) return;
    const it = a.items.find((x) => x.i >= charIndex);
    if (!it) return;
    const elapsed = now() - a.startedAt;
    if (it.start > 3 && elapsed > 0.3) a.spu = a.spu * 0.5 + (elapsed / it.start) * 0.5;
    a.t0 = now() - it.start * a.spu;
  }

  stop() {
    this.active = null;
    this.avatar.setMouth(VISEMES.sil);
  }

  _update() {
    const a = this.active;
    if (!a) return;
    const pos = (now() - a.t0) / a.spu;
    if (pos < 0 || pos >= a.total) return this.avatar.setMouth(VISEMES.sil);

    let i = a.cursor < a.items.length && a.items[a.cursor].start <= pos ? a.cursor : 0;
    while (i < a.items.length - 1 && a.items[i].end <= pos) i++;
    a.cursor = i;
    const it = a.items[i];
    const next = a.items[i + 1];
    const cur = VISEMES[it.v];
    const nxt = next ? VISEMES[next.v] : VISEMES.sil;

    // Coarticulación: al final de cada sonido la boca ya va hacia el siguiente
    const f = (pos - it.start) / (it.end - it.start);
    const b = smooth(0.55, 1, f) * 0.5;
    const out = {};
    for (const k in cur) out[k] = cur[k] + (nxt[k] - cur[k]) * b;

    if (a.getLevel) {
      const env = Math.min(1, Math.max(0, (a.getLevel() - 0.01) * 9));
      out.open *= Math.min(1, env * 1.4);
    }
    this.avatar.setMouth(out);
  }
}
