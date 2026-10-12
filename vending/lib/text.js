// Utilidades de texto: precios para voz, normalización y el validador anti-alucinaciones.

// Minúsculas, sin tildes ni signos: para comparar lo que dice el cliente con el catálogo
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ¿Aparece `name` como palabra(s) completa(s) dentro de `text`? Ambos ya normalizados.
export function containsPhrase(text, name) {
  if (!name) return false;
  return ` ${text} `.includes(` ${name} `);
}

// Precios en centavos (enteros) para no tener errores de redondeo
export function priceShow(cents, currency) {
  return `${currency.symbol}${(cents / 100).toFixed(2)}`;
}

// Precio dicho en voz alta: "8 quetzales", "8 quetzales con 50", "50 centavos"
export function priceSay(cents, currency) {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  if (whole === 0) return `${rest} centavos`;
  const unit = whole === 1 ? currency.singular : currency.plural;
  return rest ? `${whole} ${unit} con ${rest}` : `${whole} ${unit}`;
}

// Números escritos con dígitos (sin ceros a la izquierda): lo que el validador compara
export function numbersIn(text) {
  return (String(text).match(/\d+/g) || []).map((n) => String(Number(n)));
}

// Junta una lista en español: "a", "a y b", "a, b y c"
export function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

// Todas las formas de nombrar un producto (nombre y alias), normalizadas
export function productNames(p) {
  return [p.name, ...(p.aliases || [])].map(normalize).filter(Boolean);
}

/**
 * Valida el texto que el modelo reescribió con estilo, comparándolo con el borrador del sistema.
 *
 *   mode 'strict' → los números deben ser exactamente los del borrador (ni inventar ni omitir):
 *                   para respuestas que hablan de dinero, carrito o pago.
 *   mode 'subset' → puede omitir números, pero nunca usar uno que no esté en borrador o hechos:
 *                   para preguntas sobre productos, recomendaciones y charla.
 *
 * Además: no puede nombrar productos del catálogo que no estén en los hechos, y debe nombrar
 * los que el borrador nombra (en modo strict). Devuelve { ok, reason }.
 */
export function validateStyled({ styled, draft, factsText = '', mode = 'strict', mentioned = [], catalog = [] }) {
  const text = String(styled || '').trim();
  if (!text) return { ok: false, reason: 'vacío' };
  if (/[*#`_[\]{}<>]|https?:/.test(text)) return { ok: false, reason: 'formato' };
  if (text.length > Math.max(220, draft.length * 2.2)) return { ok: false, reason: 'demasiado largo' };

  const got = numbersIn(text);
  const allowed = new Set([...numbersIn(draft), ...(mode === 'subset' ? numbersIn(factsText) : [])]);
  const extra = got.find((n) => !allowed.has(n));
  if (extra !== undefined) return { ok: false, reason: `número inventado: ${extra}` };
  if (mode === 'strict') {
    const missing = numbersIn(draft).find((n) => !got.includes(n));
    if (missing !== undefined) return { ok: false, reason: `omitió el número ${missing}` };
  }

  const norm = normalize(text);
  const mentionedIds = new Set(mentioned.map((p) => p.id));
  const allowedNames = mentioned.flatMap(productNames);
  for (const p of catalog) {
    if (mentionedIds.has(p.id)) continue;
    // Un alias de otro producto que también es parte del nombre de uno permitido no cuenta
    const hit = productNames(p).find((n) => n.length > 2 && containsPhrase(norm, n)
      && !allowedNames.some((a) => containsPhrase(a, n)));
    if (hit) return { ok: false, reason: `nombró un producto ajeno: ${p.name}` };
  }
  if (mode === 'strict') {
    const draftNorm = normalize(draft);
    for (const p of mentioned) {
      const inDraft = productNames(p).some((n) => containsPhrase(draftNorm, n));
      const inText = productNames(p).some((n) => containsPhrase(norm, n));
      if (inDraft && !inText) return { ok: false, reason: `omitió el producto ${p.name}` };
    }
  }
  return { ok: true };
}
