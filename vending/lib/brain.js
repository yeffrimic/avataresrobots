// Capa de lenguaje de la máquina: entiende al cliente y le responde con el estilo del encargado.
//
//   1. Entender   → intención estructurada (modelo en modo JSON, con ids validados contra el
//                   catálogo; si Groq falla, reglas simples). Atajos deterministas para códigos.
//   2. Ejecutar   → la lógica de venta (commerce.js) hace todo; aquí solo se arma un BORRADOR
//                   exacto con precios y datos reales, y la lista de HECHOS permitidos.
//   3. Estilo     → el modelo reescribe el borrador como el personaje. validateStyled() comprueba
//                   que no inventó ni omitió precios, cantidades o productos; si falla, se dice
//                   el borrador tal cual. Así la máquina nunca promete algo que no es cierto.
import { chat } from './llm.js';
import { normalize, containsPhrase, priceSay, priceShow, joinList, productNames, validateStyled } from './text.js';

const INTENTS = ['saludo', 'catalogo', 'info', 'recomendar', 'agregar', 'quitar', 'carrito', 'pagar', 'codigo',
  'cancelar', 'ayuda', 'despedida', 'fuera_de_tema', 'no_entendi'];

const NUMBER_WORDS = { cero: 0, uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };

const CATEGORY_NAMES = { chips: 'chips y boquitas', dulces: 'dulces', bebidas: 'bebidas frías' };

const STATE_LABELS = {
  idle: '¿Qué se te antoja?',
  shopping: 'Tu pedido',
  awaiting_payment: 'Decí tu código de pago',
  dispensing: 'Despachando…',
};

export class Brain {
  constructor({ store, commerce, apiKey }) {
    this.store = store;
    this.commerce = commerce;
    this.apiKey = apiKey;
    this.history = [];
  }

  get config() { return this.store.config; }
  price(cents) { return priceSay(cents, this.config.currency); }

  // ======================================================================
  // Entrada principal: lo que dijo el cliente → { say, emotion, display, debug }
  // ======================================================================
  async turn(text) {
    const debug = { text };
    this.commerce.touch();
    let nlu = this.shortcut(text);
    if (nlu) debug.source = 'atajo';
    else {
      try {
        nlu = await this.understand(text);
        debug.source = 'modelo';
      } catch (e) {
        debug.llmError = e.message;
        nlu = this.fallbackUnderstand(text);
        debug.source = 'reglas';
      }
    }
    debug.nlu = nlu;
    const result = this.execute(nlu);
    const say = await this.style(result, text, debug);
    this.remember(text, say);
    return { say, emotion: result.emotion || null, display: this.display(), debug };
  }

  // Botones físicos de la máquina
  async button(name) {
    const btn = String(name).toUpperCase();
    const { confirm = [], cancel = [] } = this.config.buttons || {};
    let nlu = null;
    if (confirm.includes(btn)) nlu = { intent: 'pagar', items: [] };
    else if (cancel.includes(btn)) nlu = { intent: 'cancelar', items: [] };
    else {
      const slot = this.store.slot(btn);
      if (slot?.productId) nlu = { intent: 'agregar', items: [{ id: slot.productId, cantidad: 1 }] };
    }
    if (!nlu) return null;
    this.commerce.touch();
    const debug = { button: btn, nlu, source: 'botón' };
    const result = this.execute(nlu);
    const say = await this.style(result, `(apachó el botón ${btn})`, debug);
    return { say, emotion: result.emotion || null, display: this.display(), debug };
  }

  // Avisos de la lógica de venta (despacho terminado, pedido vencido…)
  async narrate(type, data = {}) {
    let result = null;
    if (type === 'done') {
      const { delivered, failed, refundCents, balanceCents } = data;
      if (!failed.length) {
        result = { draft: '¡Listo! Ya cayó todo, sacalo de abajo. ¡Que lo disfrutés!', emotion: 'feliz', mentioned: unique(delivered) };
      } else {
        const failedNames = joinList(unique(failed).map((p) => p.name));
        let draft = `Uy, se me trabó ${failedNames}.`;
        if (refundCents) draft += ` Te devolví ${this.price(refundCents)} a tu código.`;
        if (delivered.length) draft += ` Lo demás ya cayó, sacalo de abajo.`;
        if (balanceCents != null && refundCents) draft += ` Tu saldo es de ${this.price(balanceCents)}.`;
        result = { draft, emotion: 'triste', mentioned: unique([...failed, ...delivered]) };
      }
    } else if (type === 'expired') {
      result = { draft: 'Como ya no me dijiste nada, cancelé tu pedido. Aquí estoy cuando se te antoje algo.', mentioned: [] };
    }
    if (!result) return null;
    const say = await this.style({ mode: 'strict', facts: {}, ...result }, '', { event: type });
    return { say, emotion: result.emotion || null, display: this.display() };
  }

  greeting() {
    return { say: this.config.persona.greeting, emotion: 'feliz', display: this.display() };
  }

  display() {
    const s = this.commerce.summary();
    const cur = this.config.currency;
    return {
      ...s,
      label: STATE_LABELS[s.state],
      total: priceShow(s.totalCents, cur),
      items: s.items.map((i) => ({ ...i, price: priceShow(i.priceCents, cur), subtotal: priceShow(i.subtotalCents, cur) })),
    };
  }

  remember(text, say) {
    this.history.push({ cliente: text, maquina: say });
    if (this.history.length > 4) this.history.shift();
  }

  // ======================================================================
  // 1. Entender
  // ======================================================================

  // Atajos deterministas: lo que no debe depender del modelo
  shortcut(text) {
    const norm = normalize(text);
    if (!norm) return { intent: 'no_entendi', items: [] };
    const digits = extractDigits(norm);
    const waitingCode = this.commerce.state === 'awaiting_payment';
    if (digits && (waitingCode || /\bcodigo\b/.test(norm))) return { intent: 'codigo', items: [], codigo: digits };
    if (waitingCode && /\b(cancela|cancelar|cancelalo|olvidalo|ya no quiero)\b/.test(norm)) return { intent: 'cancelar', items: [] };
    return null;
  }

  catalogTable() {
    return this.store.products().map((p) => [
      p.id, p.name, (p.aliases || []).join(', '), p.category, (p.tags || []).join(', '),
      this.commerce.available(p.id) > 0 ? 'sí' : 'agotado',
    ].join(' | ')).join('\n');
  }

  async understand(text) {
    const cart = this.commerce.summary();
    const categories = [...new Set(this.store.products().map((p) => p.category))];
    const tags = [...new Set(this.store.products().flatMap((p) => p.tags || []))];
    const recent = this.commerce.lastMentioned.map((id) => `${this.store.product(id)?.name} (${id})`).join(', ') || 'ninguno';
    const system = `Eres el módulo de comprensión de una máquina expendedora de snacks y bebidas. Lee lo que dijo el cliente y devuelve SOLO un objeto JSON válido.

Catálogo (id | nombre | también le dicen | categoría | etiquetas | disponible):
${this.catalogTable()}

Categorías válidas: ${categories.join(', ')}. Etiquetas válidas: ${tags.join(', ')}.
Estado de la venta: ${this.commerce.state}. Carrito: ${cart.items.map((i) => `${i.qty} ${i.name} (${i.id})`).join(', ') || 'vacío'}.
Productos de los que se habló recién: ${recent}.
Últimos mensajes: ${this.history.map((h) => `Cliente: ${h.cliente} / Máquina: ${h.maquina}`).join(' || ') || 'ninguno'}

Intenciones:
- saludo: saluda o empieza a hablar.
- catalogo: pregunta qué hay o qué venden (puede filtrar por categoría, etiqueta o precio).
- info: pregunta algo de un producto concreto (precio, tamaño, sabor, si tiene azúcar, etc.).
- recomendar: pide una sugerencia o no sabe qué elegir.
- agregar: pide o quiere comprar un producto. También "sí", "dámelo", "va" cuando se le acaba de ofrecer uno: usa ese producto.
- quitar: ya no quiere un producto que está en el carrito.
- carrito: pregunta qué lleva o cuánto va.
- pagar: terminó de elegir ("eso es todo", "cobrame", "listo", "nada más").
- codigo: dice su código de pago.
- cancelar: quiere cancelar todo el pedido.
- ayuda: pregunta cómo funciona la máquina o cómo se paga.
- despedida: se despide o da las gracias sin pedir nada.
- fuera_de_tema: habla de algo que no tiene que ver con la tienda.
- no_entendi: no se entiende lo que quiere.

Responde con este formato exacto:
{"intent": "...", "items": [{"id": "...", "cantidad": 1}], "categoria": null, "etiquetas": [], "precio_max": null, "codigo": null, "pregunta": null}

Reglas:
- En "items" usa SOLO ids del catálogo. Si pide algo que no está en el catálogo, deja "items" vacío y pon en "pregunta" lo que pidió.
- "categoria" y "etiquetas" solo con valores válidos. "precio_max" en ${this.config.currency.plural}, o null.
- "pregunta": en pocas palabras, qué quiere saber el cliente (para info, recomendar y fuera_de_tema).`;
    const raw = await chat({
      apiKey: this.apiKey,
      model: this.config.llm.model,
      json: true,
      temperature: 0,
      maxTokens: 200,
      timeoutMs: this.config.llm.timeoutMs,
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    });
    return this.sanitize(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)));
  }

  // Nunca confiar en el JSON del modelo: todo se valida contra el catálogo
  sanitize(n) {
    const products = this.store.products();
    const ids = new Set(products.map((p) => p.id));
    const categories = new Set(products.map((p) => p.category));
    const tags = new Set(products.flatMap((p) => p.tags || []));
    const max = this.config.sales.maxItems;
    const items = (Array.isArray(n.items) ? n.items : [])
      .filter((i) => i && ids.has(i.id))
      .map((i) => ({ id: i.id, cantidad: Math.min(max, Math.max(1, Math.floor(Number(i.cantidad) || 1))) }));
    return {
      intent: INTENTS.includes(n.intent) ? n.intent : 'no_entendi',
      items: mergeItems(items),
      categoria: categories.has(n.categoria) ? n.categoria : null,
      etiquetas: (Array.isArray(n.etiquetas) ? n.etiquetas : []).filter((t) => tags.has(t)),
      precio_max: Number.isFinite(Number(n.precio_max)) && n.precio_max !== null ? Number(n.precio_max) : null,
      codigo: n.codigo ? String(n.codigo).replace(/\D/g, '') || null : null,
      pregunta: typeof n.pregunta === 'string' ? n.pregunta.slice(0, 160) : null,
    };
  }

  // Plan B sin modelo: palabras clave y nombres del catálogo
  fallbackUnderstand(text) {
    const norm = normalize(text);
    const found = [];
    let rest = ` ${norm} `;
    // Primero los nombres más largos («coca sin azucar» antes que «coca»)
    const names = this.store.products()
      .flatMap((p) => productNames(p).map((n) => ({ id: p.id, n })))
      .sort((a, b) => b.n.length - a.n.length);
    for (const { id, n } of names) {
      if (rest.includes(` ${n} `)) {
        const before = rest.slice(0, rest.indexOf(` ${n} `)).trim().split(' ').at(-1);
        const qty = Number(before) || NUMBER_WORDS[before] || 1;
        found.push({ id, cantidad: qty });
        rest = rest.replace(` ${n} `, ' ');
      }
    }
    const items = mergeItems(found);
    const has = (re) => re.test(norm);
    let intent = 'no_entendi';
    if (has(/\b(cancela|cancelar|olvidalo|ya no quiero nada)\b/)) intent = 'cancelar';
    else if (has(/\b(pagar|pago|cobra|cobrame|eso es todo|seria todo|nada mas|ya es todo)\b/)) intent = 'pagar';
    else if (items.length && has(/\b(quita|quitale|saca|sacale|ya no)\b/)) intent = 'quitar';
    else if (items.length && has(/\b(cuanto|precio|cuesta|vale|tiene|es)\b/) && !has(/\b(dame|quiero|regalame|deme|me das)\b/)) intent = 'info';
    else if (items.length) intent = 'agregar';
    else if (has(/\b(cuanto (es|va|llevo|seria)|total|que llevo)\b/)) intent = 'carrito';
    else if (has(/\b(que (tenes|tienes|tiene|hay|vendes|venden|ofreces)|menu|catalogo)\b/)) intent = 'catalogo';
    else if (has(/\b(recomienda|recomendas|recomiendas|sugier|no se que)\b/)) intent = 'recomendar';
    else if (has(/\b(como (funciona|pago|se paga|compro))\b/)) intent = 'ayuda';
    else if (has(/\b(gracias|adios|bye|nos vemos)\b/)) intent = 'despedida';
    else if (has(/\b(hola|buenas|buenos|que tal)\b/)) intent = 'saludo';
    const categoria = has(/\b(bebida|tomar|fresco|gaseosa|agua)\b/) ? 'bebidas'
      : has(/\b(dulce|chocolate|golosina)\b/) ? 'dulces'
        : has(/\b(chips|boquita|salado|papas)\b/) ? 'chips' : null;
    return { intent, items, categoria: intent === 'catalogo' || intent === 'recomendar' ? categoria : null, etiquetas: [], precio_max: null, codigo: null, pregunta: text.slice(0, 160) };
  }

  // ======================================================================
  // 2. Ejecutar: arma { draft, facts, mentioned, mode, emotion }
  // ======================================================================
  execute(nlu) {
    const c = this.commerce;
    const busyIntents = ['agregar', 'quitar', 'pagar', 'codigo', 'cancelar'];
    if (c.state === 'dispensing' && busyIntents.includes(nlu.intent)) {
      return { draft: 'Esperame tantito, estoy despachando tus cosas.', mode: 'strict' };
    }
    const handler = {
      saludo: () => this.doGreeting(),
      catalogo: () => this.doCatalog(nlu),
      info: () => this.doInfo(nlu),
      recomendar: () => this.doRecommend(nlu),
      agregar: () => this.doAdd(nlu),
      quitar: () => this.doRemove(nlu),
      carrito: () => this.doCart(),
      pagar: () => this.doPay(),
      codigo: () => this.doCode(nlu),
      cancelar: () => this.doCancel(),
      ayuda: () => ({ draft: 'Decime qué querés o apachá el botón de la casilla. Cuando termines, decí «pagar» y te pido tu código.', mode: 'strict' }),
      despedida: () => this.doBye(),
      fuera_de_tema: () => this.doOffTopic(nlu),
      no_entendi: () => ({ draft: 'Perdón, no te entendí bien. ¿Me lo repetís?', mode: 'strict', emotion: 'pensativo' }),
    }[nlu.intent];
    const result = handler();
    return { facts: {}, mentioned: [], mode: 'subset', ...result };
  }

  // Lo que se le puede decir al modelo sobre un producto (y nada más)
  facts(p) {
    const stock = this.commerce.available(p.id);
    return {
      nombre: p.name,
      precio: this.price(p.priceCents),
      tamaño: p.size || 'sin dato',
      descripcion: p.description || 'sin dato',
      etiquetas: (p.tags || []).join(', ') || 'sin dato',
      alergenos: p.allergens?.length ? `contiene ${joinList(p.allergens)}` : 'sin datos de alérgenos',
      disponible: stock > 0 ? 'sí' : 'agotado',
    };
  }

  withPrice(p) { return `${p.name} a ${this.price(p.priceCents)}`; }

  filtered({ categoria, etiquetas = [], precio_max } = {}) {
    return this.commerce.inStock().filter((p) => (!categoria || p.category === categoria)
      && etiquetas.every((t) => (p.tags || []).includes(t))
      && (precio_max == null || p.priceCents <= precio_max * 100));
  }

  best(list) {
    return [...list].sort((a, b) => (b.featured === true) - (a.featured === true) || this.commerce.available(b.id) - this.commerce.available(a.id));
  }

  // Algo parecido que sí hay: misma categoría, de preferencia destacado
  alternative(p, categoria = p?.category) {
    return this.best(this.filtered({ categoria }).filter((x) => x.id !== p?.id))[0] || null;
  }

  cartLine() {
    const s = this.commerce.summary();
    if (!s.count) return '';
    const n = s.count === 1 ? '1 producto' : `${s.count} productos`;
    return `Llevás ${n}, son ${this.price(s.totalCents)}.`;
  }

  categoriesInStock() {
    const cats = [...new Set(this.commerce.inStock().map((p) => p.category))];
    return joinList(cats.map((k) => CATEGORY_NAMES[k] || k));
  }

  doGreeting() {
    const featured = this.best(this.commerce.inStock()).slice(0, 1);
    return {
      draft: `¡Buenas! Tengo ${this.categoriesInStock()}. ¿Qué se te antoja?`,
      facts: { hay: this.categoriesInStock() },
      mentioned: featured,
      emotion: 'feliz',
    };
  }

  doCatalog(nlu) {
    const hasFilter = nlu.categoria || nlu.etiquetas.length || nlu.precio_max != null;
    if (!hasFilter) {
      const top = this.best(this.commerce.inStock()).filter((p) => p.featured).slice(0, 2);
      let draft = `Tengo ${this.categoriesInStock()}.`;
      if (top.length) draft += ` Lo más pedido: ${joinList(top.map((p) => p.name))}.`;
      draft += ' ¿De cuál te antojás?';
      return { draft, facts: { hay: this.categoriesInStock() }, mentioned: top };
    }
    const list = this.best(this.filtered(nlu));
    if (!list.length) {
      return { draft: `Ahorita no tengo nada así. Tengo ${this.categoriesInStock()}.`, facts: { hay: this.categoriesInStock() }, emotion: 'triste' };
    }
    const shown = list.slice(0, 5);
    this.commerce.lastMentioned = shown.map((p) => p.id);
    let draft = `Tengo ${joinList(shown.map((p) => this.withPrice(p)))}`;
    draft += list.length > shown.length ? ', y otras cosas más.' : '.';
    return { draft, facts: { productos: shown.map((p) => this.facts(p)) }, mentioned: shown };
  }

  doInfo(nlu) {
    const id = nlu.items[0]?.id || this.commerce.lastMentioned[0];
    const p = id && this.store.product(id);
    if (!p) return this.notInCatalog(nlu);
    this.commerce.lastMentioned = [p.id];
    const f = this.facts(p);
    let draft = `${p.name}, ${f.tamaño}, a ${f.precio}.`;
    draft += f.disponible === 'sí' ? ' ¿Te la doy?' : ' Ahorita está agotado.';
    return { draft, facts: { producto: f, pregunta_del_cliente: nlu.pregunta }, mentioned: [p], answerQuestion: true };
  }

  doRecommend(nlu) {
    const hasFilter = nlu.categoria || nlu.etiquetas.length || nlu.precio_max != null;
    let picks;
    if (hasFilter) picks = this.best(this.filtered(nlu)).slice(0, 2);
    else {
      // Sin preferencias: una boquita o dulce y algo de tomar
      const snack = this.best(this.commerce.inStock().filter((p) => p.category !== 'bebidas'))[0];
      const drink = this.best(this.filtered({ categoria: 'bebidas' }))[0];
      picks = [snack, drink].filter(Boolean);
    }
    if (!picks.length) return { draft: `Ahorita no tengo nada así. Tengo ${this.categoriesInStock()}.`, facts: {}, emotion: 'triste' };
    this.commerce.lastMentioned = picks.map((p) => p.id);
    return {
      draft: `Te recomiendo ${joinList(picks.map((p) => this.withPrice(p)))}. ¿Te lo doy?`,
      facts: { recomendados: picks.map((p) => this.facts(p)), pregunta_del_cliente: nlu.pregunta },
      mentioned: picks,
      emotion: 'feliz',
    };
  }

  notInCatalog(nlu) {
    const alt = nlu.categoria ? this.best(this.filtered({ categoria: nlu.categoria }))[0] : null;
    let draft = 'Eso no lo tengo en la máquina.';
    if (alt) {
      draft += ` Lo más parecido que tengo es ${this.withPrice(alt)}.`;
      this.commerce.lastMentioned = [alt.id];
    } else draft += ` Tengo ${this.categoriesInStock()}.`;
    return { draft, facts: { no_hay: nlu.pregunta || 'lo que pidió' }, mentioned: alt ? [alt] : [], mode: 'strict', emotion: 'pensativo' };
  }

  doAdd(nlu) {
    if (!nlu.items.length) return this.notInCatalog(nlu);
    const added = [];
    const problems = [];
    const mentioned = [];
    for (const { id, cantidad } of nlu.items) {
      const r = this.commerce.add(id, cantidad);
      const p = this.store.product(id);
      mentioned.push(p);
      if (r.ok) { added.push(`${cantidad} ${p.name}`); continue; }
      if (r.reason === 'agotado') {
        const alt = this.alternative(p);
        problems.push(`Ya no me queda ${p.name}${alt ? `, pero tengo ${this.withPrice(alt)}` : ''}.`);
        if (alt) { mentioned.push(alt); this.commerce.lastMentioned = [alt.id]; }
      } else if (r.reason === 'insuficiente') {
        problems.push(`De ${p.name} solo me quedan ${r.available}.`);
      } else if (r.reason === 'limite') {
        problems.push(`Solo puedo despachar ${r.max} productos por compra.`);
      }
    }
    let draft = added.length ? `Listo, te agrego ${joinList(added)}.` : '';
    if (problems.length) draft += `${draft ? ' ' : ''}${problems.join(' ')}`;
    if (added.length) draft += ` ${this.cartLine()} ¿Algo más o pagamos?`;
    return { draft, mentioned: unique(mentioned), mode: 'strict', emotion: added.length ? 'feliz' : 'triste', facts: { carrito: this.cartFacts() } };
  }

  doRemove(nlu) {
    const ids = nlu.items.length ? nlu.items.map((i) => i.id) : [];
    if (!ids.length) return { draft: '¿Cuál querés que te quite?', mode: 'strict' };
    const removed = [];
    const mentioned = [];
    for (const id of ids) {
      const r = this.commerce.remove(id);
      if (r.product) mentioned.push(r.product);
      if (r.ok) removed.push(r.product.name);
    }
    if (!removed.length) return { draft: `Eso no lo llevás en tu pedido. ${this.cartLine() || 'Todavía no llevás nada.'}`, mentioned, mode: 'strict' };
    const rest = this.cartLine() || 'Ya no llevás nada.';
    return { draft: `Listo, te quité ${joinList(removed)}. ${rest}`, mentioned, mode: 'strict', facts: { carrito: this.cartFacts() } };
  }

  cartFacts() {
    const s = this.commerce.summary();
    return { productos: s.items.map((i) => `${i.qty} ${i.name}`), total: this.price(s.totalCents) };
  }

  doCart() {
    const s = this.commerce.summary();
    if (!s.count) return { draft: 'Todavía no llevás nada. ¿Qué se te antoja?', mode: 'strict' };
    const list = joinList(s.items.map((i) => `${i.qty} ${i.name}`));
    return {
      draft: `Llevás ${list}, son ${this.price(s.totalCents)}. ¿Pagamos?`,
      mentioned: s.items.map((i) => this.store.product(i.id)),
      mode: 'strict',
      facts: { carrito: this.cartFacts() },
    };
  }

  doPay() {
    const r = this.commerce.requestPayment();
    if (!r.ok) {
      if (r.reason === 'vacio') return { draft: 'Primero decime qué querés llevar.', mode: 'strict' };
      if (r.reason === 'insuficiente') return { draft: `De ${r.product.name} solo me quedan ${r.available}. ¿Te cambio la cantidad?`, mentioned: [r.product], mode: 'strict', emotion: 'triste' };
      return { draft: 'Esperame tantito, estoy despachando.', mode: 'strict' };
    }
    const n = r.count === 1 ? '1 producto' : `${r.count} productos`;
    return { draft: `Son ${this.price(r.totalCents)} por ${n}. Decime tu código de pago.`, mode: 'strict', facts: { carrito: this.cartFacts() } };
  }

  doCode(nlu) {
    if (!this.commerce.cart.size) return { draft: 'Todavía no llevás nada. Primero decime qué se te antoja.', mode: 'strict' };
    if (!nlu.codigo) return { draft: '¿Cuál es tu código de pago?', mode: 'strict' };
    const r = this.commerce.pay({ method: 'codigo', code: nlu.codigo });
    if (r.ok) {
      let draft = '¡Pagado! Ahí te van tus antojos, esperá tantito.';
      if (r.balanceCents != null) draft += ` Te quedan ${this.price(r.balanceCents)} en tu código.`;
      return { draft, mode: 'strict', emotion: 'feliz' };
    }
    if (r.reason === 'codigo_invalido') return { draft: 'Ese código no me aparece. ¿Me lo repetís despacito?', mode: 'strict', emotion: 'pensativo' };
    if (r.reason === 'saldo') return { draft: `Tu código solo tiene ${this.price(r.balanceCents)} y son ${this.price(r.totalCents)}. Podés quitar algo o usar otro código.`, mode: 'strict', emotion: 'triste' };
    if (r.reason === 'insuficiente') return { draft: `De ${r.product.name} solo me quedan ${r.available}. ¿Te cambio la cantidad?`, mentioned: [r.product], mode: 'strict' };
    return { draft: 'Esperame tantito, estoy despachando.', mode: 'strict' };
  }

  doCancel() {
    const r = this.commerce.cancel();
    if (!r.ok) return { draft: 'Esperame tantito, estoy despachando.', mode: 'strict' };
    return { draft: r.had ? 'Listo, cancelé tu pedido. Aquí estoy cuando se te antoje algo.' : 'No hay nada que cancelar. ¿Qué se te antoja?', mode: 'strict' };
  }

  doBye() {
    if (this.commerce.cart.size) {
      return { draft: `Todavía tenés un pedido sin pagar. ${this.cartLine()} ¿Pagamos o lo cancelo?`, mode: 'strict' };
    }
    return { draft: '¡Gracias a vos! Que te vaya bien.', emotion: 'feliz' };
  }

  doOffTopic(nlu) {
    const offer = this.best(this.commerce.inStock())[0];
    if (offer) this.commerce.lastMentioned = [offer.id];
    return {
      draft: `De eso no sé mucho, yo solo sé de antojos.${offer ? ` ¿Te ofrezco ${this.withPrice(offer)}?` : ''}`,
      facts: { tema_del_cliente: nlu.pregunta, producto_que_puedes_ofrecer: offer ? this.facts(offer) : null },
      mentioned: offer ? [offer] : [],
      emotion: 'pensativo',
    };
  }

  // ======================================================================
  // 3. Estilo, con validación
  // ======================================================================
  async style(result, customerText, debug) {
    debug.draft = result.draft;
    if (!this.config.llm.style || !this.apiKey) return result.draft;
    const persona = this.config.persona;
    const system = `${persona.style}

Tu tarea: decir el BORRADOR con tu estilo, para que suene natural en voz alta, como el encargado de esta tiendita.
Reglas estrictas:
- Usa SOLO la información del borrador y de los hechos. No inventes productos, precios, promociones, cantidades, tiempos ni datos.
- Escribe los números con dígitos y exactamente como aparecen (por ejemplo «8 quetzales con 50»).
- ${result.answerQuestion ? 'Contesta la pregunta del cliente usando solo los hechos. Si el dato no está en los hechos, di que ese dato no lo tienes.' : 'Si el cliente preguntó algo que no está en los hechos, di que ese dato no lo tienes.'}
- Si el borrador le pide algo al cliente (un código, elegir, confirmar), mantén esa petición.
- Máximo 2 frases cortas. Sin emojis, sin listas, sin markdown, sin comillas.
- Responde solo con lo que vas a decir.`;
    const user = JSON.stringify({ lo_que_dijo_el_cliente: customerText, borrador: result.draft, hechos: result.facts || {} });
    try {
      const styled = (await chat({
        apiKey: this.apiKey,
        model: this.config.llm.model,
        temperature: 0.7,
        maxTokens: 140,
        timeoutMs: this.config.llm.timeoutMs,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      })).replace(/^["«]|["»]$/g, '').trim();
      debug.styled = styled;
      const v = validateStyled({
        styled,
        draft: result.draft,
        factsText: JSON.stringify(result.facts || {}),
        mode: result.mode || 'subset',
        mentioned: result.mentioned || [],
        catalog: this.store.products({ includeInactive: true }),
      });
      debug.validation = v;
      return v.ok ? styled : result.draft;
    } catch (e) {
      debug.styleError = e.message;
      return result.draft;
    }
  }
}

// ---------- utilidades ----------
function unique(products) {
  const seen = new Set();
  return products.filter((p) => p && !seen.has(p.id) && seen.add(p.id));
}

function mergeItems(items) {
  const m = new Map();
  for (const i of items) m.set(i.id, (m.get(i.id) || 0) + i.cantidad);
  return [...m].map(([id, cantidad]) => ({ id, cantidad }));
}

// "uno dos tres cuatro", "1 2 3 4" o "1234" → "1234" (entre 3 y 12 dígitos)
export function extractDigits(norm) {
  const digits = norm.split(' ').map((w) => (/^\d+$/.test(w) ? w : NUMBER_WORDS[w] !== undefined && w !== 'un' && w !== 'una' ? String(NUMBER_WORDS[w]) : '')).join('');
  return digits.length >= 3 && digits.length <= 12 ? digits : null;
}
