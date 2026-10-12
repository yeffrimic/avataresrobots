// Llamadas a Groq desde el servidor, con tiempo límite: si tarda o falla, quien llama usa su plan B.
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

export async function chat({ apiKey, model, messages, json = false, temperature = 0.3, maxTokens = 300, timeoutMs = 5000 }) {
  if (!apiKey) throw new Error('Sin GROQ_API_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(GROQ, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Groq ${res.status}: ${data.error?.message || res.statusText}`);
    const text = data.choices?.[0]?.message?.content || '';
    return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Groq tardó más de ${timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
