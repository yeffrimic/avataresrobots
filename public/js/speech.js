// Cola de voz: reproduce frase por frase con el motor elegido y mueve los labios.
import * as groq from './groq.js';

export function pickVoice(lang, voices = []) {
  const code = lang.toLowerCase();
  const prefix = code.slice(0, 2);
  const candidates = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(prefix));
  const score = (v) =>
    (v.lang.toLowerCase().replace('_', '-') === code ? 4 : 0) +
    (/natural|neural|online/i.test(v.name) ? 3 : 0) +
    (/google/i.test(v.name) ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] || null;
}

function silenceBounds(buffer, threshold = 0.02) {
  const d = buffer.getChannelData(0);
  let a = 0;
  let b = d.length - 1;
  while (a < b && Math.abs(d[a]) < threshold) a++;
  while (b > a && Math.abs(d[b]) < threshold) b--;
  return [a / buffer.sampleRate, b / buffer.sampleRate];
}

export class Speaker {
  constructor({ lipsync, settings }) {
    this.lipsync = lipsync;
    this.settings = settings;
    this.queue = [];
    this.playing = false;
    this.gen = 0;
    this.lastEnd = 0;
    this.waiters = [];
    this.ctrl = new AbortController();
    this.onitemstart = null;
    this.onerror = null;
  }

  _audio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.ctx.destination);
      this.levelBuf = new Float32Array(this.analyser.fftSize);
    }
    return this.ctx;
  }

  // Llamar desde un gesto del usuario (click/tecla) para que el navegador permita el audio
  unlock() { this._audio().resume(); }

  level() {
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let s = 0;
    for (const x of this.levelBuf) s += x * x;
    return Math.sqrt(s / this.levelBuf.length);
  }

  enqueue(text, emotion = null) {
    const s = this.settings();
    const item = { text, emotion, engine: s.voiceEngine };
    // Los motores de audio se piden al instante para que la siguiente frase ya esté lista
    const fetchAudio = {
      microsoft: () => groq.msSpeech(text, { voice: s.msVoice, rate: s.rate, pitch: s.pitch }, this.ctrl.signal),
      groq: () => groq.speech(text, { model: s.ttsModel, voice: s.groqVoice }, this.ctrl.signal),
    }[item.engine];
    if (fetchAudio) {
      item.audio = fetchAudio().then((ab) => this._audio().decodeAudioData(ab));
      item.audio.catch(() => {}); // el error se gestiona al reproducir
    }
    this.queue.push(item);
    if (!this.playing) this._run();
  }

  waitIdle() {
    if (!this.playing && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  stop() {
    this.gen++;
    this.queue = [];
    this.ctrl.abort();
    this.ctrl = new AbortController();
    globalThis.speechSynthesis?.cancel();
    try { this.source?.stop(); } catch { /* ya detenido */ }
    this.source = null;
    this.lipsync.stop();
    this._idle();
  }

  _idle() {
    if (this.playing) this.lastEnd = performance.now();
    this.playing = false;
    this.waiters.splice(0).forEach((r) => r());
  }

  async _run() {
    const gen = this.gen;
    this.playing = true;
    while (this.queue.length && gen === this.gen) {
      const item = this.queue.shift();
      this.onitemstart?.(item);
      try {
        if (item.audio) await this._playAudio(item, gen);
        else await this._speakBrowser(item, gen);
      } catch (e) {
        if (gen !== this.gen || e.name === 'AbortError') break;
        this.onerror?.(e);
        if (item.audio) await this._speakBrowser(item, gen); // plan B: voz del navegador
      }
    }
    if (gen === this.gen) {
      this.lipsync.stop();
      this._idle();
    }
  }

  async _playAudio(item, gen) {
    const buffer = await item.audio;
    if (gen !== this.gen) return;
    const ctx = this._audio();
    await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    const [a, b] = silenceBounds(buffer);
    this.source = src;
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
      this.lipsync.start({ text: item.text, duration: Math.max(0.1, b - a), offset: a, getLevel: () => this.level() });
    });
    this.source = null;
  }

  _speakBrowser(item, gen) {
    if (gen !== this.gen || !globalThis.speechSynthesis) return Promise.resolve();
    const s = this.settings();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(item.text);
      const voices = speechSynthesis.getVoices();
      const voice = voices.find((v) => v.voiceURI === s.browserVoice) || pickVoice(s.lang, voices);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = s.lang;
      u.rate = s.rate;
      u.pitch = s.pitch;
      this._utterance = u; // evita que Chrome la recolecte a mitad de frase

      let guard;
      const done = () => { clearTimeout(guard); this.lipsync.stop(); resolve(); };
      u.onstart = () => this.lipsync.start({ text: item.text, rate: s.rate });
      u.onboundary = (e) => { if (!e.name || e.name === 'word') this.lipsync.resync(e.charIndex); };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
      // Algunos navegadores a veces no disparan onend
      guard = setTimeout(done, 5000 + item.text.length * 250 / s.rate);
    });
  }
}
