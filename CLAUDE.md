# Contexto del proyecto (para Claude)

Avatar 3D conversacional por voz: una cabeza robot en Three.js que escucha (Whisper de Groq), ve (cámara o imágenes → modelo con visión de Groq), responde en streaming y habla en español con lip-sync. El usuario habla español; responde y escribe la UI y los comentarios en español.

**Uso previsto:** una demostración en una PC con **Pop!_OS + Firefox**. Debe funcionar en cualquier plataforma, incluidos móviles.

## Arranque

```
cp .env.example .env     # poner GROQ_API_KEY (no está en el repo)
npm start                # Node >= 22; sin dependencias
npm run cert             # opcional: HTTPS autofirmado para usarlo desde el móvil en la LAN
```

En Pop!_OS, el Node de `apt` es viejo: instalar Node 22 con NodeSource (ver README).

## Arquitectura

- `server.js`: servidor HTTP/HTTPS sin dependencias. Sirve `public/` y hace de proxy a Groq (`/api/chat`, `/api/stt`, `/api/tts`, `/api/models`), para que la key no llegue al navegador. Si `.env` no tiene key, acepta la cabecera `X-Groq-Key` que manda la UI.
- `mstts.js`: TTS con las voces neuronales de Microsoft Edge «Leer en voz alta» (WebSocket no oficial, token `Sec-MS-GEC`), usado en `/api/ms-tts` y `/api/ms-voices`. Es la voz por defecto: 45 voces nativas en español. Solo acepta formatos MP3/Opus, no PCM ni WAV.
- `public/js/main.js`: orquestación, UI, ajustes (localStorage `avatar.settings`), personalidades, cámara, imágenes, modo `?debug`.
- `public/js/avatar.js`: escena Three.js (r170 por CDN, con importmap). El rostro se dibuja en un canvas 2D que se usa como `emissiveMap` del visor; emociones; carga opcional de `.glb` con blendshapes ARKit u Oculus.
- `public/js/mic.js`: VAD propio con un AudioWorklet y pre-roll de 0.4 s. Entrega WAV de 16 kHz. Incluye pulsar-para-hablar (Espacio) y `finishNow()`.
- `public/js/lipsync.js`: texto → visemas en español (A/E/I/O/U/M/F/C). Con audio, se ajusta a la duración real y la boca sigue el volumen.
- `public/js/speech.js`: cola de voz con tres motores, `microsoft` (por defecto), `browser` y `groq` (Orpheus, solo inglés). Si falla el motor elegido, pasa a la voz del navegador.
- `public/js/personalities.js`: personalidades predefinidas. **Juan** es la primera, así que sale por defecto en instalaciones nuevas: co-presentador de la charla de Yeffri para niños y jóvenes en Guatemala, con voz `es-GT-AndresNeural`. Su prompt lo escribió el usuario; no cambiar los datos de «Lo que sabes» sin pedirlo. El campo opcional `msVoice` de una personalidad cambia la voz al elegirla.

- `index.html` (en la raíz) + `assets/` + `.nojekyll`: página de presentación pública en GitHub Pages (https://yeffrimic.github.io/avataresrobots/), servida desde `main`, en `/`. Importa `public/js/avatar.js`, `lipsync.js` y `speech.js` para mostrar la cabeza en vivo hablando en bucle, sin servidor. Si cambia la API de esos módulos, revisa que la página siga funcionando. El repo es **público**.

## Decisiones y lecciones (no repetir errores)

- **Modelos de Groq:** Llama 4 Scout ya no existe. El de chat con visión es `qwen/qwen3.8-27b`. Al arrancar, `checkModels()` cambia solo a otro modelo si el guardado desaparece.
- **Plan gratuito de Groq:** unos 7000 tokens de entrada por minuto, y cada imagen cuesta unos 2000. `max_completion_tokens` está en 400 porque Groq reserva esa cantidad del cupo de salida por minuto. El error 429 se muestra con un aviso claro.
- **Cámara:** no transmite de forma continua. Manda una foto por mensaje; según el ajuste `camEveryTurn`, siempre o solo con palabras como «mira», «ves» o «esto». En el historial, las imágenes antiguas se resumen en texto.
- **Por qué voz de Microsoft:** en el Windows del usuario no hay voces en español instaladas, y en Linux con Firefox las del navegador suenan robóticas.
- **Detector de voz** (el usuario tuvo problemas reales con «se queda en *Te escucho…*»):
  - umbral relativo al ruido de fondo, con 0.6 s de calibración al arrancar;
  - fin de frase con la energía promediada en 150 ms, por debajo de `max(umbral, pico*0.18)`;
  - solo una voz sostenida de más de 0.1 s reinicia la cuenta de silencio;
  - `autoGainControl` desactivado; máximo 15 s por frase;
  - tocar el micrófono o pulsar Espacio mientras dice «Te escucho…» envía lo grabado.

  **Pendiente:** confirmar que funciona con el micrófono real del usuario. Si no, pedirle una captura de `/?debug`.
- **Whisper:** no se le pasa `prompt`, porque con ruido lo repetía como si fuera la transcripción. Hay un filtro `HALLUCINATIONS` en `main.js`.
- **Pausas a media frase:** si el usuario sigue hablando antes de la respuesta, la frase anterior se une a la siguiente (`carry`).
- **Firefox:** el `AudioContext` del micrófono se crea con el `sampleRate` de la pista; si no, Firefox da error.
- **Móviles:** micrófono y cámara exigen HTTPS (`npm run cert` o un túnel).
- **Tras cambiar `server.js` o `mstts.js` hay que reiniciar el servidor.** Un 405 en `/api/ms-tts` significa que sigue corriendo un servidor viejo.

## Cómo probar sin micrófono real

Edge sin ventana con `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=archivo.wav` (WAV PCM de 48 kHz; se puede generar con System.Speech en PowerShell), arrancado con `--remote-debugging-port` y controlado con `puppeteer-core` vía `puppeteer.connect`, instalado en una carpeta temporal, no en el proyecto. `puppeteer.launch` con Edge falla en esa máquina. En Firefox: `puppeteer.launch({ browser: 'firefox' })` con las prefs `media.navigator.streams.fake` y `media.navigator.permission.disabled`. El modo `--virtual-time-budget` no sirve para probar getUserMedia.

En Windows, los scripts con acentos pasados por heredoc de bash se corrompen: usar la herramienta Edit.

## Ideas pendientes ofrecidas al usuario

- Modo ligero para PCs lentas (sin bloom y con menos resolución).
- Incluir Three.js y las fuentes en el proyecto, para no depender del CDN.
