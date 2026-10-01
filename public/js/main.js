import { Avatar } from './avatar.js';
import { LipSync } from './lipsync.js';
import { Speaker } from './speech.js';
import { Mic } from './mic.js';
import * as groq from './groq.js';
import { PERSONALITIES } from './personalities.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* almacenamiento no disponible */ }
  },
};

// ---------- Ajustes ----------
const DEFAULTS = {
  voiceEngine: 'microsoft',
  msVoice: 'es-MX-DaliaNeural',
  browserVoice: '',
  groqVoice: 'troy',
  ttsModel: 'canopylabs/orpheus-v1-english',
  rate: 1,
  pitch: 1,
  lang: 'es-ES',
  chatModel: 'qwen/qwen3.8-27b',
  sttModel: 'whisper-large-v3-turbo',
  temperature: 0.8,
  sensitivity: 0.5,
  silenceMs: 900,
  bargeIn: false,
  camEveryTurn: true,
  apiKey: '',
  modelUrl: '',
};
const settings = { ...DEFAULTS, ...store.get('avatar.settings', {}) };
settings.personality ??= { ...PERSONALITIES[0] };
if (!settings.v2) { // migración: la voz de Microsoft pasa a ser la predeterminada
  settings.voiceEngine = 'microsoft';
  settings.msVoice ??= DEFAULTS.msVoice;
  settings.v2 = true;
}
let customs = store.get('avatar.customPersonalities', []);
const saveSettings = () => store.set('avatar.settings', settings);
const saveCustoms = () => store.set('avatar.customPersonalities', customs);

// ---------- Núcleo ----------
const avatar = new Avatar($('#stage'));
const lipsync = new LipSync(avatar);
const speaker = new Speaker({ lipsync, settings: () => settings });
const mic = new Mic();
groq.setClientKey(settings.apiKey);

let history = [];
let attachments = [];
let turn = null; // turno en curso: { ctrl: AbortController }
let conversation = false;
let pttActive = false;
let uiState = 'idle';
let camStream = null;
let camFacing = 'user';
let serverKey = false;

const LABELS = {
  idle: 'En espera',
  listening: 'Escuchando',
  hearing: 'Te escucho…',
  transcribing: 'Transcribiendo…',
  thinking: 'Pensando…',
  speaking: 'Hablando',
};

function setState(s) {
  uiState = s;
  avatar.setState({ hearing: 'listening', transcribing: 'thinking' }[s] ?? s);
  const pill = $('#statePill');
  pill.textContent = LABELS[s];
  pill.dataset.state = s;
}
const restState = () => setState(conversation ? 'listening' : 'idle');

// ---------- Personalidad ----------
function systemPrompt() {
  const p = settings.personality;
  return `${p.prompt}

Te llamas ${p.name}. Eres un avatar 3D (una cabeza flotando en el espacio) que conversa por voz en tiempo real.
Reglas:
- Lo que escribes se convierte en voz: habla natural y breve (1 a 3 frases) salvo que te pidan más detalle.
- No uses markdown, listas, asteriscos, emojis ni URLs. Escribe los números y símbolos como se dicen.
- Responde en el idioma en que te hablen (por defecto ${settings.lang.startsWith('es') ? 'español' : settings.lang}).
- Si recibes una imagen marcada como de tu cámara, es lo que estás viendo ahora mismo con tus ojos: háblale en primera persona ("veo...").
- Puedes expresar emociones empezando una frase con una etiqueta: [feliz], [triste], [sorprendido], [pensativo] o [enojado]. Úsalas con moderación y nunca las pronuncies.`;
}

function applyPersonality() {
  const p = settings.personality;
  $('#avatarName').textContent = p.name;
  document.title = `${p.name} · Avatar`;
  avatar.setHue(p.hue ?? 190);
  document.documentElement.style.setProperty('--hue', p.hue ?? 190);
}

const allPersonalities = () => [...PERSONALITIES, ...customs];
const isCustom = (id) => customs.some((c) => c.id === id);

function fillPersonalitySelect() {
  const opt = (p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`;
  $('#pSelect').innerHTML =
    `<optgroup label="Predefinidas">${PERSONALITIES.map(opt).join('')}</optgroup>` +
    (customs.length ? `<optgroup label="Mis personalidades">${customs.map(opt).join('')}</optgroup>` : '');
  $('#pSelect').value = settings.personality.id;
  $('#pDelete').hidden = !isCustom(settings.personality.id);
}

function syncPersonalityFields() {
  const p = settings.personality;
  $('#pName').value = p.name;
  $('#pPrompt').value = p.prompt;
  $('#pHue').value = p.hue ?? 190;
}

function onPersonalityEdited() {
  const p = settings.personality;
  const c = customs.find((x) => x.id === p.id);
  if (c) { Object.assign(c, p); saveCustoms(); }
  saveSettings();
  applyPersonality();
}

$('#pSelect').addEventListener('change', (e) => {
  const p = allPersonalities().find((x) => x.id === e.target.value);
  if (!p) return;
  settings.personality = { ...p };
  if (p.rate) settings.rate = p.rate;
  if (p.pitch) settings.pitch = p.pitch;
  saveSettings();
  applyPersonality();
  syncSettingsUI();
  clearConversation(`Ahora hablas con ${p.name}.`);
});
$('#pName').addEventListener('input', (e) => { settings.personality.name = e.target.value.trim() || 'Avatar'; onPersonalityEdited(); });
$('#pPrompt').addEventListener('input', (e) => { settings.personality.prompt = e.target.value; onPersonalityEdited(); });
$('#pHue').addEventListener('input', (e) => { settings.personality.hue = Number(e.target.value); onPersonalityEdited(); });

$('#pSaveNew').addEventListener('click', () => {
  const p = { ...settings.personality, id: `custom-${Date.now()}`, rate: settings.rate, pitch: settings.pitch };
  customs.push(p);
  settings.personality = { ...p };
  saveCustoms();
  saveSettings();
  fillPersonalitySelect();
  toast(`Personalidad «${p.name}» guardada.`);
});

$('#pDelete').addEventListener('click', () => {
  const id = settings.personality.id;
  if (!isCustom(id) || !confirm(`¿Eliminar la personalidad «${settings.personality.name}»?`)) return;
  customs = customs.filter((c) => c.id !== id);
  saveCustoms();
  settings.personality = { ...PERSONALITIES[0] };
  saveSettings();
  applyPersonality();
  syncSettingsUI();
});

// ---------- Ajustes generales ----------
function updateOutputs() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const out = el.closest('label')?.querySelector('output');
    if (out) out.textContent = el.value;
  });
  document.querySelectorAll('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(settings.voiceEngine); });
}

function syncSettingsUI() {
  fillVoices();
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const v = settings[el.dataset.setting];
    if (el.id === 'browserVoice' || el.id === 'msVoice') return; // ya se seleccionan al rellenar la lista
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v ?? '';
  });
  fillPersonalitySelect();
  syncPersonalityFields();
  updateOutputs();
}

document.querySelectorAll('[data-setting]').forEach((el) => {
  const key = el.dataset.setting;
  const event = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(event, () => {
    if (el.type === 'checkbox') settings[key] = el.checked;
    else if (el.type === 'range') settings[key] = Number(el.value);
    else settings[key] = el.value.trim();
    saveSettings();
    updateOutputs();
    if (key === 'apiKey') { groq.setClientKey(settings.apiKey); updateKeyStatus(); }
    if (key === 'lang') { fillVoices(); fillMsVoices(); }
  });
});

$('[data-setting="modelUrl"]').addEventListener('change', () => loadModel(settings.modelUrl));

// Voces de Microsoft del idioma elegido (si la actual no es de ese idioma, se elige la primera)
let msVoiceList = [];
function fillMsVoices() {
  const sel = $('#msVoice');
  const prefix = settings.lang.slice(0, 2);
  const voices = msVoiceList.filter((v) => v.locale.startsWith(prefix))
    .sort((a, b) => (b.locale === settings.lang) - (a.locale === settings.lang) || a.locale.localeCompare(b.locale));
  if (!voices.length) { sel.innerHTML = `<option value="${esc(settings.msVoice)}">${esc(settings.msVoice)}</option>`; return; }
  sel.innerHTML = voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)} — ${esc(v.locale)} (${v.gender})</option>`).join('');
  if (!voices.some((v) => v.id === settings.msVoice)) { settings.msVoice = voices[0].id; saveSettings(); }
  sel.value = settings.msVoice;
}
async function loadMsVoices() {
  try { msVoiceList = await groq.msVoices(); } catch (e) { console.warn(e); }
  fillMsVoices();
}

function fillVoices() {
  const sel = $('#browserVoice');
  if (!globalThis.speechSynthesis) return;
  const prefix = settings.lang.slice(0, 2).toLowerCase();
  const voices = globalThis.speechSynthesis.getVoices().slice().sort((a, b) =>
    (b.lang.toLowerCase().startsWith(prefix) - a.lang.toLowerCase().startsWith(prefix)) || a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">Automática (la mejor disponible)</option>' +
    voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} — ${esc(v.lang)}</option>`).join('');
  sel.value = settings.browserVoice;
  if (sel.value !== settings.browserVoice) sel.value = '';
}
globalThis.speechSynthesis?.addEventListener?.('voiceschanged', fillVoices);

function updateKeyStatus() {
  const badge = $('#keyStatus');
  const ok = serverKey || settings.apiKey;
  badge.textContent = serverKey ? 'en el servidor ✓' : settings.apiKey ? 'en este navegador' : 'falta';
  badge.className = `badge ${ok ? 'ok' : 'bad'}`;
}

async function checkStatus() {
  try { serverKey = (await (await fetch('/api/status')).json()).serverKey; } catch { serverKey = false; }
  updateKeyStatus();
  if (!serverKey && !settings.apiKey) {
    openPanel('settingsPanel');
    toast('Agrega tu API key de Groq aquí abajo (o en el archivo .env del servidor).');
    return;
  }
  const ids = await loadModelList();
  if (ids) checkModels(ids);
}

// Groq retira modelos cada cierto tiempo: si el elegido ya no existe, usamos uno disponible
const CHAT_FALLBACKS = [/qwen.*(vl|3\.[5-9])/i, /llama-4/i, /vision/i, /qwen/i, /gpt-oss-120b/i, /llama-3\.3-70b/i];
const STT_FALLBACKS = [/whisper-large-v3-turbo/, /whisper/];

function checkModels(ids) {
  const fix = (key, patterns, label) => {
    if (ids.includes(settings[key])) return;
    const pick = patterns.map((r) => ids.find((id) => r.test(id))).find(Boolean);
    if (!pick) return;
    toast(`El modelo ${label} «${settings[key]}» ya no está disponible en Groq; ahora uso «${pick}».`);
    settings[key] = pick;
    saveSettings();
    syncSettingsUI();
  };
  fix('chatModel', CHAT_FALLBACKS, 'de chat');
  fix('sttModel', STT_FALLBACKS, 'de voz a texto');
}

let modelIds = null;
async function loadModelList() {
  if (modelIds) return modelIds;
  try {
    modelIds = await groq.listModels();
    $('#modelList').innerHTML = modelIds.map((id) => `<option value="${esc(id)}"></option>`).join('');
  } catch { /* sin key todavía */ }
  return modelIds;
}

// ---------- Paneles y avisos ----------
function openPanel(id) {
  $(`#${id}`).hidden = false;
  if (id === 'settingsPanel') loadModelList();
}
function togglePanel(id) { if ($(`#${id}`).hidden) openPanel(id); else $(`#${id}`).hidden = true; }
$('#btnSettings').addEventListener('click', () => togglePanel('settingsPanel'));
$('#btnLog').addEventListener('click', () => togglePanel('logPanel'));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { $(`#${b.dataset.close}`).hidden = true; }));

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 4000);
}

// ---------- Registro y subtítulos ----------
function logMessage(role, text, images = [], camImage = null) {
  const log = $('#log');
  log.querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const p = document.createElement('span');
  p.textContent = text;
  div.append(p);
  if (images.length || camImage) {
    const imgs = document.createElement('div');
    imgs.className = 'imgs';
    for (const src of images) imgs.insertAdjacentHTML('beforeend', `<img src="${src}" alt="imagen enviada">`);
    if (camImage) imgs.insertAdjacentHTML('beforeend', `<img class="cam" src="${camImage}" alt="lo que veía la cámara">`);
    div.append(imgs);
  }
  log.append(div);
  log.scrollTop = log.scrollHeight;
  return p;
}

let subTimer;
function subtitle(user, bot) {
  clearTimeout(subTimer);
  if (user !== undefined) $('#subUser').textContent = user;
  if (bot !== undefined) $('#subBot').textContent = bot;
}
function fadeSubtitles(ms = 5000) {
  clearTimeout(subTimer);
  subTimer = setTimeout(() => subtitle('', ''), ms);
}

// ---------- Texto → voz ----------
const EMOTION_TAG = /\[(feliz|triste|sorprendid[oa]|pensativ[oa]|enojad[oa]|neutral)\]/gi;

// Algunos modelos (Qwen, DeepSeek…) pueden razonar en voz alta dentro de <think>…</think>
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
}

function cleanForDisplay(text) {
  return text.replace(EMOTION_TAG, '').replace(/[*_#`]/g, '').replace(/[ \t]+/g, ' ').trim();
}

function cleanForSpeech(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`~>|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Dónde cortar el texto en streaming para empezar a hablar cuanto antes
function findCut(s) {
  const m = /[.!?…:;](?=\s)|\n/.exec(s);
  if (m) return m.index + 1;
  if (s.length > 160) {
    const comma = s.lastIndexOf(',', 160);
    return comma > 40 ? comma + 1 : s.lastIndexOf(' ', 160) + 1 || 160;
  }
  return 0;
}

function speakChunk(raw) {
  let emotion = null;
  const text = cleanForSpeech(raw.replace(EMOTION_TAG, (_, e) => { emotion = e; return ''; }));
  if (/\p{L}|\d/u.test(text)) speaker.enqueue(text, emotion);
  else if (emotion) avatar.setEmotion(emotion);
}

speaker.onitemstart = (item) => {
  if (item.emotion) avatar.setEmotion(item.emotion);
  setState('speaking');
};
let ttsErrorShown = false;
speaker.onerror = (e) => {
  console.error(e);
  if (!ttsErrorShown) { toast(`La voz elegida falló, uso la del navegador. ${e.message}`, true); ttsErrorShown = true; }
};

// ---------- Conversación ----------
function newTurn() {
  interrupt();
  turn = { ctrl: new AbortController() };
  return turn;
}

function interrupt() {
  if (turn) { turn.ctrl.abort(); turn = null; }
  speaker.stop();
}

function clearConversation(note) {
  interrupt();
  history = [];
  $('#log').innerHTML = '';
  logMessage('note', note || 'Conversación nueva.');
  subtitle('', '');
  restState();
}

const LOOK_WORDS = /(?<!\p{L})(mira|mirá|miras|ves|ve|veo|viendo|observa|esto|esta|este|aquí|aqui|cámara|camara|lee|leer|muestro|enseño|tengo|qué es|que es|look|see|this)(?!\p{L})/iu;

function buildMessages() {
  const msgs = [{ role: 'system', content: systemPrompt() }];
  const last = history.findLastIndex((m) => m.role === 'user');
  history.forEach((m, i) => {
    if (m.role === 'user' && i !== last) {
      // Las imágenes antiguas se resumen en texto para no reenviarlas en cada turno
      const n = m.content.filter((c) => c.type === 'image_url').length;
      const text = m.content.find((c) => c.type === 'text').text;
      msgs.push({ role: 'user', content: n ? `${text}\n[Aquí te había mostrado ${n} imagen(es)]` : text });
    } else msgs.push({ role: m.role, content: m.content });
  });
  return msgs;
}

async function respond(text, my) {
  const images = attachments.splice(0, 4);
  renderAttachments();
  const cam = camStream && (settings.camEveryTurn || LOOK_WORDS.test(text) || !text) ? captureFrame() : null;
  const prompt = text || (images.length ? '¿Qué ves en esta imagen?' : '¿Qué ves?');

  const content = [{ type: 'text', text: prompt + (cam ? '\n[Se adjunta la imagen actual de tu cámara: es lo que estás viendo ahora]' : '') }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });
  if (cam) content.push({ type: 'image_url', image_url: { url: cam } });
  history.push({ role: 'user', content });
  logMessage('user', prompt, images, cam);
  subtitle(prompt, '');
  setState('thinking');

  const bubble = logMessage('bot', '…');
  let raw = '';
  let full = '';
  let spoken = 0; // caracteres de `full` ya enviados a la voz
  for await (const delta of groq.streamChat({
    model: settings.chatModel,
    temperature: settings.temperature,
    messages: buildMessages(),
    signal: my.ctrl.signal,
  })) {
    if (my !== turn) return;
    raw += delta;
    full = stripThinking(raw);
    const shown = cleanForDisplay(full);
    bubble.textContent = shown;
    subtitle(undefined, shown.length > 260 ? '…' + shown.slice(-260) : shown);
    let cut;
    while ((cut = findCut(full.slice(spoken))) > 0) {
      speakChunk(full.slice(spoken, spoken + cut));
      spoken += cut;
    }
  }
  if (my !== turn) return;
  if (full.slice(spoken).trim()) speakChunk(full.slice(spoken));
  history.push({ role: 'assistant', content: full });
  if (history.length > 30) history = history.slice(-30);
  if (!full.trim()) bubble.textContent = '(sin respuesta)';
  $('#log').scrollTop = $('#log').scrollHeight;

  await speaker.waitIdle();
  if (my === turn) {
    turn = null;
    restState();
    fadeSubtitles();
  }
}

function handleError(e, my) {
  if (e.name === 'AbortError' || my !== turn) return;
  console.error(e);
  turn = null;
  speaker.stop();
  const wait = /try again in ([\d.]+)s/.exec(e.message);
  toast(/\b429\b/.test(e.message)
    ? `Groq: se alcanzó el límite por minuto del plan gratuito. Espera ${wait ? Math.ceil(Number(wait[1])) + ' s' : 'unos segundos'} y vuelve a hablar.`
    : e.message, true);
  avatar.setEmotion('triste', 3);
  restState();
}

async function submitText(text) {
  const my = newTurn();
  try { await respond(text.trim(), my); } catch (e) { handleError(e, my); }
}

// Frases que Whisper "inventa" con ruido o silencio
const HALLUCINATIONS = [/subt[ií]tul/i, /amara\.org/i, /gracias por ver/i, /suscr[ií]bete/i, /thanks? for watching/i,
  /^\s*(conversaci[oó]n|conexi[oó]n) con\b/i, /^[\s.,¡!¿?…-]*$/];

// Si haces una pausa a media frase y sigues hablando antes de que responda,
// lo que dijiste antes se une a lo siguiente en vez de perderse.
let carry = '';

async function onUtterance(wav) {
  const my = newTurn();
  setState('transcribing');
  try {
    // Sin señal de cancelación: aunque vuelvas a hablar, esta parte se transcribe y se guarda
    let text = (await groq.transcribe(wav, {
      model: settings.sttModel,
      language: settings.lang.slice(0, 2),
    })).trim();
    if (HALLUCINATIONS.some((r) => r.test(text))) text = '';
    if (my !== turn) { carry = `${carry} ${text}`.trim(); return; }
    text = `${carry} ${text}`.trim();
    carry = '';
    if (!text) { turn = null; return restState(); }
    my.userText = text;
    await respond(text, my);
  } catch (e) {
    handleError(e, my);
  }
}

// ---------- Micrófono ----------
mic.addEventListener('speechstart', () => {
  // Volviste a hablar antes de que empezara a responder: guardamos lo anterior para unirlo
  if (turn?.userText && !speaker.playing) {
    carry = `${turn.userText} ${carry}`.trim();
    const last = history[history.length - 1];
    if (last?.role === 'user') history.pop();
  }
  interrupt();
  setState('hearing');
});
mic.addEventListener('speechcancel', () => { if (uiState === 'hearing') restState(); });
mic.addEventListener('utterance', (e) => onUtterance(e.detail));

async function ensureAudio() {
  speaker.unlock();
  try {
    await mic.start();
    return true;
  } catch (e) {
    console.error(e);
    toast('No pude acceder al micrófono. Revisa los permisos del navegador.', true);
    return false;
  }
}

$('#btnMic').addEventListener('click', async () => {
  // Plan B: si te está escuchando y no detecta el final, tocar el micrófono envía ya lo grabado
  if (uiState === 'hearing' && mic.recording && !pttActive) return mic.finishNow();
  if (conversation) {
    conversation = false;
    $('#btnMic').classList.remove('on');
    if (uiState === 'hearing' || uiState === 'listening') restState();
    return;
  }
  if (!(await ensureAudio())) return;
  conversation = true;
  $('#btnMic').classList.add('on');
  if (!turn && !speaker.playing) restState();
});

async function startPTT() {
  if (pttActive) return;
  if (mic.recording && uiState === 'hearing') return mic.finishNow(); // ya estaba grabando: enviar
  pttActive = true;
  if (!(await ensureAudio()) || !pttActive) { pttActive = false; return; }
  interrupt();
  mic.beginManual();
}
function endPTT() {
  if (!pttActive) return;
  pttActive = false;
  mic.endManual();
}

const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !isTyping()) { e.preventDefault(); startPTT(); }
  if (e.key === 'Escape') { interrupt(); restState(); fadeSubtitles(1500); }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') endPTT(); });
addEventListener('blur', endPTT);

// Bucle de interfaz: escucha automática solo cuando el avatar no habla (evita que se oiga a sí mismo)
const micBtn = $('#btnMic');
const stopBtn = $('#btnStop');
const settingsPanel = $('#settingsPanel');

// Modo diagnóstico: abre la app con ?debug para ver los números del micrófono en vivo
const debugBox = new URLSearchParams(location.search).has('debug') ? document.createElement('pre') : null;
if (debugBox) {
  debugBox.style.cssText = 'position:fixed;left:12px;top:70px;z-index:50;margin:0;padding:10px 12px;border-radius:10px;' +
    'background:rgb(0 0 0 / .75);color:#9ef;font:12px/1.5 monospace;pointer-events:none;white-space:pre';
  document.body.append(debugBox);
}
const debugEvents = [];
const debugLog = (msg) => { if (debugBox) debugEvents.unshift(`${new Date().toLocaleTimeString()} ${msg}`); debugEvents.length = Math.min(debugEvents.length, 6); };
['speechstart', 'speechcancel', 'utterance'].forEach((ev) => mic.addEventListener(ev, (e) =>
  debugLog(ev + (e.detail ? ` (${Math.round(e.detail.size / 1024)} KB)` : ''))));
let debugAt = 0;
function updateDebug() {
  if (performance.now() - debugAt < 100) return;
  debugAt = performance.now();
  const s = mic.stats;
  const n = (v) => (v ?? 0).toFixed(4);
  debugBox.textContent =
    `estado      ${uiState}   vad=${mic.vad}   ctx=${s.ctxState} ${s.sampleRate} Hz\n` +
    `nivel       ${n(s.level)}   promedio ${n(s.slow)}\n` +
    `ruido       ${n(s.noise)}   umbral   ${n(s.threshold)}\n` +
    (s.recording ? `grabando    ${s.recMs} ms   silencio ${s.silenceMs}/${settings.silenceMs} ms\n` +
      `pico voz    ${n(s.peak)}   fin si promedio < ${n(s.endLevel)}\n` : '\n\n') +
    `\n${debugEvents.join('\n')}`;
}

// Medidor de Ajustes en escala logarítmica (0.0003 … 0.3) para que se vean voces bajas y altas
const meterPos = (v) => Math.min(100, Math.max(0, ((Math.log10(Math.max(v, 1e-5)) + 3.5) / 3) * 100));
let meterHintAt = 0;
function updateMeter(lvl) {
  const loud = lvl > mic.threshold;
  $('#micLevel').style.width = `${meterPos(lvl)}%`;
  $('#micLevel').classList.toggle('loud', loud);
  $('#micThreshold').style.left = `${meterPos(mic.threshold)}%`;
  if (performance.now() - meterHintAt < 400) return;
  meterHintAt = performance.now();
  $('#micHint').textContent = lvl < 0.0005
    ? 'No llega sonido: revisa que el navegador use el micrófono correcto (candado de la barra de direcciones).'
    : 'Habla: la barra debe pasar la línea blanca. Si no la pasa, sube la sensibilidad.';
}
function uiLoop() {
  const busy = speaker.playing || performance.now() - speaker.lastEnd < 450;
  mic.vad = conversation && !pttActive && (settings.bargeIn || !busy);
  mic.sensitivity = settings.sensitivity;
  mic.silenceMs = settings.silenceMs;
  const lvl = mic.started ? mic.level : 0;
  micBtn.style.setProperty('--lvl', Math.min(1, lvl * 8).toFixed(3));
  avatar.setInputLevel(uiState === 'hearing' || uiState === 'listening' ? lvl : 0);
  stopBtn.hidden = !(speaker.playing || ['thinking', 'transcribing'].includes(uiState));
  if (!settingsPanel.hidden && mic.started) updateMeter(lvl);
  if (debugBox && mic.started) updateDebug();
  requestAnimationFrame(uiLoop);
}
requestAnimationFrame(uiLoop);

$('#btnStop').addEventListener('click', () => { interrupt(); restState(); });

// ---------- Texto ----------
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#textInput');
  const text = input.value;
  if (!text.trim() && !attachments.length) return;
  input.value = '';
  speaker.unlock();
  submitText(text);
});

// ---------- Imágenes ----------
async function imageToDataURL(file, max = 1280) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.85);
}

async function addImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (attachments.length >= 4) { toast('Máximo 4 imágenes por mensaje.'); break; }
    try { attachments.push(await imageToDataURL(f)); } catch { toast(`No pude leer «${f.name}».`, true); }
  }
  renderAttachments();
  if (attachments.length) $('#textInput').focus();
}

function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = attachments.map((src, i) =>
    `<div class="thumb"><img src="${src}" alt=""><button data-i="${i}" aria-label="Quitar"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`).join('');
  $('#textInput').placeholder = attachments.length ? 'Pregunta algo sobre la imagen… (o dilo en voz alta)' : 'Escribe un mensaje…';
}

$('#attachments').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  attachments.splice(Number(b.dataset.i), 1);
  renderAttachments();
});
$('#btnAttach').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { addImages([...e.target.files]); e.target.value = ''; });
addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addImages(files); }
});

let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropZone').hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropZone').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropZone').hidden = true;
  addImages([...(e.dataTransfer?.files || [])]);
});

// ---------- Cámara ----------
async function startCam() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  $('#camVideo').srcObject = camStream;
  $('#camBox').hidden = false;
  $('#camBox').classList.toggle('mirror', camFacing === 'user');
  $('#btnCam').classList.add('on');
}

function stopCam() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  $('#camBox').hidden = true;
  $('#btnCam').classList.remove('on');
}

function captureFrame(max = 768) {
  const v = $('#camVideo');
  if (!v.videoWidth) return null;
  const k = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * k);
  c.height = Math.round(v.videoHeight * k);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

$('#btnCam').addEventListener('click', async () => {
  if (camStream) return stopCam();
  try { await startCam(); } catch (e) { console.error(e); toast('No pude abrir la cámara. Revisa los permisos.', true); }
});
$('#btnFlip').addEventListener('click', async () => {
  camFacing = camFacing === 'user' ? 'environment' : 'user';
  try { await startCam(); } catch { camFacing = 'user'; toast('No hay otra cámara disponible.'); }
});

// ---------- Avatar 3D propio ----------
async function loadModel(url) {
  if (!url) return avatar.useRobot();
  try {
    const info = await avatar.loadModel(url);
    toast(info.morphs ? 'Modelo cargado.' : 'Modelo cargado, pero no tiene blendshapes: no podrá mover los labios.');
  } catch (e) {
    console.error(e);
    toast(`No pude cargar el modelo: ${e.message}`, true);
    avatar.useRobot();
  }
}
$('#btnGlb').addEventListener('click', () => $('#glbInput').click());
$('#glbInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadModel(URL.createObjectURL(f));
  e.target.value = '';
});
$('#btnRobot').addEventListener('click', () => {
  settings.modelUrl = '';
  saveSettings();
  syncSettingsUI();
  avatar.useRobot();
});

// ---------- Otros ----------
$('#btnTestVoice').addEventListener('click', async () => {
  const my = newTurn();
  speaker.unlock();
  speaker.enqueue(`Hola, soy ${settings.personality.name}. Así suena mi voz.`, 'feliz');
  await speaker.waitIdle();
  if (my === turn) { turn = null; restState(); }
});
$('#btnClear').addEventListener('click', () => clearConversation());

// ---------- Inicio ----------
applyPersonality();
syncSettingsUI();
restState();
checkStatus();
loadMsVoices();
if (settings.modelUrl) loadModel(settings.modelUrl);
subtitle('', `Hola, soy ${settings.personality.name}. Pulsa el micrófono para conversar.`);
fadeSubtitles(6000);
