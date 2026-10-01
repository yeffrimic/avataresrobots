// Micrófono con detección de voz (VAD) y pulsar-para-hablar.
// Graba PCM crudo con un AudioWorklet para poder conservar unos ms previos ("pre-roll")
// y no cortar el inicio de las palabras. Entrega WAV mono 16 kHz, ideal para Whisper.
//
// Eventos: 'speechstart', 'speechcancel', 'utterance' (detail = Blob WAV)

const WORKLET = `
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
`;

const PREROLL_S = 0.4;
const TRIGGER_S = 0.12;
const MIN_VOICED_S = 0.25;
const MAX_UTTERANCE_S = 15;

export class Mic extends EventTarget {
  constructor() {
    super();
    this.level = 0;
    this.sensitivity = 0.5;
    this.silenceMs = 900;
    this.noise = 0.002;
    this.threshold = 0.01;
    this.energy = 0;
    this.slow = 0;
    this.peak = 0;
    this.endLevel = 0;
    this.recording = false;
    this.manual = false;
    this._vad = false;
    this._resetPreroll();
  }

  get started() { return Boolean(this.ctx); }

  async start() {
    if (this.ctx) return;
    if (!this._starting) {
      this._starting = (async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Sin ganancia automática: sube el ruido cuando callas y el detector creería que sigues hablando
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
        });
        // Firefox exige que el contexto use la misma frecuencia que el micrófono
        const rate = stream.getAudioTracks()[0]?.getSettings().sampleRate;
        let ctx;
        try { ctx = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext(); } catch { ctx = new AudioContext(); }
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'mic-tap');
        const mute = ctx.createGain();
        mute.gain.value = 0;
        ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
        node.port.onmessage = (e) => this._frame(e.data);
        this.stream = stream;
        this.sr = ctx.sampleRate;
        this.ctx = ctx;
        this.calibrate = ctx.sampleRate * 0.6; // primeros 0.6 s: solo aprender el ruido de la sala
      })().finally(() => { this._starting = null; });
    }
    await this._starting;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // Activa/desactiva la escucha automática (manos libres)
  set vad(on) {
    if (on === this._vad) return;
    this._vad = on;
    if (!on && this.recording && !this.manual) this._cancel();
    this._resetPreroll();
  }
  get vad() { return this._vad; }

  beginManual() {
    if (!this.ctx) return;
    this.manual = true;
    this._begin();
  }

  endManual() {
    if (!this.manual) return;
    this.manual = false;
    this._finish(true);
  }

  // Envía ya lo grabado (plan B si no detecta que terminaste de hablar)
  finishNow() {
    if (!this.recording) return;
    this.manual = false;
    this._finish(true);
  }

  // Números internos para el modo diagnóstico (?debug)
  get stats() {
    return { level: this.level, slow: this.slow, noise: this.noise, threshold: this.threshold,
      peak: this.peak, endLevel: this.endLevel, recording: this.recording,
      silenceMs: this.recording ? Math.round(this.silence / this.sr * 1000) : 0,
      recMs: this.recording ? Math.round(this.recLen / this.sr * 1000) : 0,
      sampleRate: this.sr, ctxState: this.ctx?.state };
  }

  _resetPreroll() {
    this.preroll = [];
    this.prerollLen = 0;
    this.above = 0;
  }

  _begin() {
    this.recording = true;
    this.chunks = this.preroll.slice();
    this.recLen = this.prerollLen;
    this.voiced = 0;
    this.silence = 0;
    this.voicedRun = 0;
    this.peak = this.slow;
    this._resetPreroll();
    this.dispatchEvent(new Event('speechstart'));
  }

  _cancel() {
    this.recording = false;
    this.chunks = [];
    this.dispatchEvent(new Event('speechcancel'));
  }

  // manual: con pulsar-para-hablar basta con la duración (tú decides cuándo hablas)
  _finish(manual = false) {
    if (!this.recording) return;
    const enough = manual ? this.recLen > this.sr * 0.3 : this.voiced > this.sr * MIN_VOICED_S;
    if (!enough) return this._cancel();
    this.recording = false;
    const wav = encodeWav(this.chunks, this.sr);
    this.chunks = [];
    this.dispatchEvent(new CustomEvent('utterance', { detail: wav }));
  }

  _frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    // Nivel suavizado (~40 ms): evita que los huecos entre sílabas cuenten como silencio
    this.level = Math.max(rms, this.level * 0.93);

    // Ruido de fondo: baja rápido hacia el mínimo y sube muy despacio,
    // así se adapta a micrófonos bajos o salas ruidosas sin "aprender" tu voz
    if (this.calibrate > 0) {
      this.calibrate -= f.length;
      this.noise += (this.level - this.noise) * 0.05;
    } else {
      this.noise += (this.level - this.noise) * (this.level < this.noise ? 0.05 : 0.0008);
    }

    // Umbral = ruido de fondo × factor según la sensibilidad (más sensible → factor menor)
    const s = this.sensitivity;
    this.threshold = Math.max(this.noise * (1.8 + (1 - s) * 4.2), 0.0015 + (1 - s) * 0.006);
    const loud = this.level > this.threshold;

    // Energía promediada en ~150 ms: estable frente a clics, roces y picos de ruido
    const a = Math.exp(-f.length / (this.sr * 0.15));
    this.energy = this.energy * a + rms * rms * (1 - a);
    this.slow = Math.sqrt(this.energy);

    if (this.recording) {
      this.chunks.push(f);
      this.recLen += f.length;
      // Fin de frase: el nivel cae claramente respecto a tu voz (sirve aunque haya ruido constante)
      this.peak = Math.max(this.slow, this.peak * 0.9998);
      this.endLevel = Math.max(this.threshold, this.peak * 0.18);
      if (this.slow > this.endLevel) {
        this.voiced += f.length;
        this.voicedRun += f.length;
        // Solo una voz sostenida (>0.1 s) reinicia la cuenta de silencio
        if (this.voicedRun > this.sr * 0.1) this.silence = 0;
      } else {
        this.voicedRun = 0;
        this.silence += f.length;
      }
      const tooLong = this.recLen > this.sr * MAX_UTTERANCE_S;
      if (tooLong || (!this.manual && this.silence > this.sr * this.silenceMs / 1000)) {
        const manual = this.manual;
        this.manual = false;
        this._finish(manual);
      }
      return;
    }

    if (!this._vad || this.calibrate > 0) return;
    this.preroll.push(f);
    this.prerollLen += f.length;
    while (this.prerollLen > this.sr * PREROLL_S) this.prerollLen -= this.preroll.shift().length;
    this.above = loud ? this.above + f.length : 0;
    if (this.above > this.sr * TRIGGER_S) this._begin();
  }
}

function encodeWav(chunks, sr, target = 16000) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const data = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { data.set(c, o); o += c.length; }

  const ratio = sr / target;
  const outLen = Math.floor(len / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(len, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += data[j];
    const v = s / Math.max(1, b - a);
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }

  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
