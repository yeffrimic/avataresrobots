// Voces neuronales de Microsoft (las mismas de «Leer en voz alta» de Edge), gratis y sin API key.
// Tienen muchas voces nativas en español (México, España, Argentina, Colombia…).
// Es un servicio no oficial: si Microsoft lo cambia, la app vuelve a la voz del navegador.
import { createHash, randomUUID } from 'node:crypto';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const GEC_VERSION = '1-143.0.3650.75';
const BASE = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const HEADERS = {
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
};

// Token anti-abuso que exige el servicio: SHA-256 de (ticks de Windows redondeados a 5 min + token)
function secMsGec() {
  let s = Math.floor(Date.now() / 1000) + 11644473600;
  s -= s % 300;
  return createHash('sha256').update(`${BigInt(s) * 10000000n}${TOKEN}`).digest('hex').toUpperCase();
}
const auth = () => `TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}`;

let voicesCache = null;
export async function msVoices() {
  if (!voicesCache) {
    const res = await fetch(`https://${BASE}/voices/list?${auth()}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Voces de Microsoft no disponibles (${res.status})`);
    voicesCache = (await res.json()).map((v) => ({
      id: v.ShortName,
      name: v.FriendlyName.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ''),
      locale: v.Locale,
      gender: v.Gender === 'Female' ? 'mujer' : 'hombre',
    }));
  }
  return voicesCache;
}

const xml = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const signed = (n, unit) => `${n >= 0 ? '+' : ''}${n}${unit}`;

export function msSpeak({ text, voice = 'es-MX-DaliaNeural', rate = 1, pitch = 1 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${BASE}/edge/v1?${auth()}&ConnectionId=${randomUUID().replaceAll('-', '')}`, { headers: HEADERS });
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ya cerrado */ }
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error('La voz de Microsoft tardó demasiado')), 15000);

    ws.onopen = () => {
      const ts = new Date().toString();
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      const prosody = `pitch='${signed(Math.round((pitch - 1) * 50), 'Hz')}' rate='${signed(Math.round((rate - 1) * 100), '%')}' volume='+0%'`;
      ws.send(`X-RequestId:${randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='es-MX'><voice name='${xml(voice)}'><prosody ${prosody}>${xml(text)}</prosody></voice></speak>`);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        if (e.data.includes('Path:turn.end')) finish();
        return;
      }
      const buf = Buffer.from(e.data);
      const headLen = buf.readUInt16BE(0);
      if (buf.subarray(2, 2 + headLen).toString().includes('Path:audio')) chunks.push(buf.subarray(2 + headLen));
    };
    ws.onerror = () => finish(chunks.length ? null : new Error('No pude conectar con la voz de Microsoft'));
    ws.onclose = () => finish(chunks.length ? null : new Error('La voz de Microsoft cerró la conexión sin audio'));
  });
}
