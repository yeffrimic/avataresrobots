// Cliente de la API de Groq (pasa por el proxy de server.js)

let clientKey = '';
export function setClientKey(key) { clientKey = key || ''; }

function headers(extra = {}) {
  return clientKey ? { ...extra, 'X-Groq-Key': clientKey } : extra;
}

async function check(res, service = 'Groq') {
  if (res.ok) return res;
  let msg = res.statusText;
  try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* cuerpo no JSON */ }
  throw new Error(`${service} ${res.status}: ${msg}`);
}

// Chat en streaming: va entregando fragmentos de texto a medida que llegan
export async function* streamChat({ model, messages, temperature, signal }) {
  const res = await check(await fetch('/api/chat', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ model, messages, temperature, stream: true, max_completion_tokens: 400 }),
    signal,
  }));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) throw new Error(`Groq: ${json.error.message}`);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

export async function transcribe(blob, { model, language, prompt }, signal) {
  const fd = new FormData();
  fd.append('file', blob, 'voz.wav');
  fd.append('model', model);
  if (language) fd.append('language', language);
  if (prompt) fd.append('prompt', prompt);
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  const res = await check(await fetch('/api/stt', { method: 'POST', headers: headers(), body: fd, signal }));
  return (await res.json()).text || '';
}

export async function speech(text, { model, voice }, signal) {
  const res = await check(await fetch('/api/tts', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ model, voice, input: text, response_format: 'wav' }),
    signal,
  }));
  return res.arrayBuffer();
}

// Voces neuronales de Microsoft (generadas en nuestro servidor, ver mstts.js)
export async function msSpeech(text, { voice, rate, pitch }, signal) {
  const res = await check(await fetch('/api/ms-tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, rate, pitch }),
    signal,
  }), 'Voz Microsoft');
  return res.arrayBuffer();
}

export async function msVoices() {
  return (await check(await fetch('/api/ms-voices'), 'Voz Microsoft')).json();
}

export async function listModels() {
  const res = await check(await fetch('/api/models', { headers: headers() }));
  return (await res.json()).data?.map((m) => m.id).sort() ?? [];
}
