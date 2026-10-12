// Capa de lenguaje del cajero: entiende al cliente y le responde con el estilo del encargado.
//
//   1. Entender   → intención estructurada (modelo en modo JSON, con ids validados contra los
//                   productos de tu programa; si Groq falla, reglas simples).
//   2. Ejecutar   → la caja (caja.js) y tu programa hacen todo; aquí solo se arma un BORRADOR
//                   exacto con precios y datos reales, y la lista de HECHOS permitidos.
//   3. Estilo     → el modelo reescribe el borrador como el personaje. validateStyled() comprueba
//                   que no inventó ni omitió precios, cantidades o productos; si falla, se dice
//                   el borrador tal cual. Así el cajero nunca promete algo que no es cierto.
import { chat } from './llm.js';
import { normalize, priceSay, priceShow, joinList, productNames, validateStyled } from './text.js';

const INTENTS = ['saludo', 'catalogo', 'info', 'recomendar', 'agregar', 'quitar', 'carrito', 'pagar',
  'cancelar', 'ayuda', 'despedida', 'fuera_de_tema', 'no_entendi'];

const NUMBER_WORDS = { uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };

const CATEGORY_NAMES = { chips: 'chips y boquitas', dulces: 'dulces', bebidas: 'bebidas frías' };

const STATE_LABELS = {
  idle: '¿Qué se te antoja?',
  shopping: 'Tu pedido',
  awaiting_payment: 'Esperando tu pago',
  dispensing: 'Despachando…',
};

const OFFLINE = 'Uy, ahorita no me puedo comunicar con la máquina. Probá otra vez en un momentito.';

export class Brain {
  constructor({ caja, config, apiKey }) {
    this.caja = caja;
    this.getConfig = config;
    this.apiKey = apiKey;
    this.history = [];
  }

  get config() { return this.getConfig(); }
  price(cents) { return priceSay(cents, this.config.currency); }

  // ======================================================================
  // Entrada principal: lo que dijo el cliente → { say, emotion, display, debug }
  // ======================================================================
  async turn(text) {
    const debug = { text };
    this.caja.touch();
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
    const result = await this.execute(nlu);
    const say = await this.style(result, text, debug);
    this.remember(text, say);
    return { say, emotion: result.emotion || null, display: this.display(), debug };
  }

  // Botones físicos (los avisa tu programa con un evento)
  async button({ casilla, boton }) {
    const btn = String(boton || '').toUpperCase();
    const { confirm = [], cancel = [] } = this.config.botones || {};
    let nlu = null;
    if (confirm.includes(btn)) nlu = { intent: 'pagar', items: [] };
    else if (cancel.includes(btn)) nlu = { intent: 'cancelar', items: [] };
    else {
      const p = this.caja.productBySlot(casilla || btn);
      if (p) nlu = { intent: 'agregar', items: [{ id: p.id, cantidad: 1 }] };
    }
    if (!nlu) return null;
    this.caja.touch();
    const debug = { button: casilla || btn, nlu, source: 'botón' };
    const result = await this.execute(nlu);
    const say = await this.style(result, `(apachó el botón ${casilla || btn})`, debug);
    return { say, emotion: result.emotion || null, display: this.display(), debug };
  }

  // Avisos de la caja: pago recibido, pedido entregado, cancelado, vencido…
  async narrate(type, data = {}) {
    let result = null;
    if (type === 'paid') {
      result = { draft: '¡Pago recibido! Ya te lo despacho, esperá tantito.', emotion: 'feliz' };
    } else if (type === 'done') {
      const { delivered, failed, refundCents } = data;
      if (!failed.length) {
        result = { draft: '¡Listo! Ya cayó todo, sacalo de abajo. ¡Que lo disfrutés!', emotion: 'feliz', mentioned: unique(delivered) };
      } else {
        let draft = `Uy, no salió ${joinList(unique(failed).map((p) => p.name))}.`;
        draft += refundCents ? ` Te devolvemos ${this.price(refundCents)}.` : ' Avisale al encargado, porfa.';
        if (delivered.length) draft += ' Lo demás ya cayó, sacalo de abajo.';
        result = { draft, emotion: 'triste', mentioned: unique([...failed, ...delivered]) };
      }
    } else if (type === 'cancelled') {
      result = { draft: 'El pago no se completó y se canceló tu pedido. Si querés, lo intentamos otra vez.', emotion: 'triste' };
    } else if (type === 'expired') {
      result = data.stage === 'payment'
        ? { draft: 'Como no se completó el pago, cancelé tu pedido. Aquí estoy cuando se te antoje algo.' }
        : { draft: 'Como ya no me dijiste nada, cancelé tu pedido. Aquí estoy cuando se te antoje algo.' };
    }
    if (!result) return null;
    const say = await this.style({ mode: 'strict', facts: {}, mentioned: [], ...result }, '', { event: type });
    return { say, emotion: result.emotion || null, display: this.display() };
  }

  greeting() {
    return { say: this.config.persona.greeting, emotion: 'feliz', display: this.display() };
  }

  display() {
    const s = this.caja.summary();
    const cur = this.config.currency;
    return {
      ...s,
      label: STATE_LABELS[s.state],
      total: priceShow(s.totalCents, cur),
      items: s.items.map((i) => ({ ...i, price: priceShow(i.priceCents, cur), subtotal: priceShow(i.subtotalCents, cur) })),
    };
  }

  remember(text, say) {
    this.history.push({ cliente: text, cajero: say });
    if (this.history.length > 4) this.history.shift();
  }

  // ======================================================================
  // 1. Entender
  // ======================================================================
  shortcut(text) {
    const norm = normalize(text);
    if (!norm) return { intent: 'no_entendi', items: [] };
    if (this.caja.state === 'awaiting_payment' && /\b(cancela|cancelar|cancelalo|olvidalo|ya no quiero)\b/.test(norm)) {
      return { intent: 'cancelar', items: [] };
    }
    return null;
  }

  catalogTable() {
    return this.caja.products().map((p) => [
      p.id, p.name, p.aliases.join(', '), p.category, p.tags.join(', '), p.stock > 0 ? 'sí' : 'agotado',
    ].join(' | ')).join('\n');
  }

  async understand(text) {
    const cart = this.caja.summary();
    const products = this.caja.products();
    const categories = [...new Set(products.map((p) => p.category))];
    const tags = [...new Set(products.flatMap((p) => p.tags))];
    const recent = this.caja.lastMentioned.map((id) => `${this.caja.product(id)?.name} (${id})`).join(', ') || 'ninguno';
    const system = `Eres el módulo de comprensión del cajero de una máquina expendedora. Lee lo que dijo el cliente y devuelve SOLO un objeto JSON válido.

Productos (id | nombre | también le dicen | categoría | etiquetas | disponible):
${this.catalogTable() || '(sin productos)'}

Categorías válidas: ${categories.join(', ') || 'ninguna'}. Etiquetas válidas: ${tags.join(', ') || 'ninguna'}.
Estado: ${this.caja.state}. Pedido: ${cart.items.map((i) => `${i.qty} ${i.name} (${i.id})`).join(', ') || 'vacío'}.
Productos de los que se habló recién: ${recent}.
Últimos mensajes: ${this.history.map((h) => `Cliente: ${h.cliente} / Cajero: ${h.cajero}`).join(' || ') || 'ninguno'}

Intenciones:
- saludo: saluda o empieza a hablar.
- catalogo: pregunta qué hay o qué venden (puede filtrar por categoría, etiqueta o precio).
- info: pregunta algo de un producto concreto (precio, tamaño, sabor, si tiene azúcar, etc.).
- recomendar: pide una sugerencia o no sabe qué elegir.
- agregar: pide o quiere comprar un producto. También "sí", "dámelo", "va" cuando se le acaba de ofrecer uno: usa ese producto.
- quitar: ya no quiere un producto que está en el pedido.
- carrito: pregunta qué lleva o cuánto va.
- pagar: terminó de elegir y quiere pagar ("eso es todo", "cobrame", "listo", "nada más").
- cancelar: quiere cancelar todo el pedido.
- ayuda: pregunta cómo funciona la máquina o cómo se paga.
- despedida: se despide o da las gracias sin pedir nada.
- fuera_de_tema: habla de algo que no tiene que ver con la tienda.
- no_entendi: no se entiende lo que quiere.

Responde con este formato exacto:
{"intent": "...", "items": [{"id": "...", "cantidad": 1}], "categoria": null, "etiquetas": [], "precio_max": null, "pregunta": null}

Reglas:
- En "items" usa SOLO ids de la lista de productos. Si pide algo que no está en la lista, deja "items" vacío y pon en "pregunta" lo que pidió.
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

  // Nunca confiar en el JSON del modelo: todo se valida contra los productos reales
  sanitize(n) {
    const products = this.caja.products();
    const ids = new Set(products.map((p) => p.id));
    const categories = new Set(products.map((p) => p.category));
    const tags = new Set(products.flatMap((p) => p.tags));
    const max = this.config.caja.maxItems;
    const items = (Array.isArray(n.items) ? n.items : [])
      .filter((i) => i && ids.has(String(i.id)))
      .map((i) => ({ id: String(i.id), cantidad: Math.min(max, Math.max(1, Math.floor(Number(i.cantidad) || 1))) }));
    return {
      intent: INTENTS.includes(n.intent) ? n.intent : 'no_entendi',
      items: mergeItems(items),
      categoria: categories.has(n.categoria) ? n.categoria : null,
      etiquetas: (Array.isArray(n.etiquetas) ? n.etiquetas : []).filter((t) => tags.has(t)),
      precio_max: n.precio_max != null && Number.isFinite(Number(n.precio_max)) ? Number(n.precio_max) : null,
      pregunta: typeof n.pregunta === 'string' ? n.pregunta.slice(0, 160) : null,
    };
  }

  // Plan B sin modelo: palabras clave y nombres de los productos
  fallbackUnderstand(text) {
    const norm = normalize(text);
    const found = [];
    let rest = ` ${norm} `;
    const names = this.caja.products()
      .flatMap((p) => productNames(p).map((n) => ({ id: p.id, n })))
      .sort((a, b) => b.n.length - a.n.length); // «coca sin azucar» antes que «coca»
    for (const { id, n } of names) {
      if (rest.includes(` ${n} `)) {
        const before = rest.slice(0, rest.indexOf(` ${n} `)).trim().split(' ').at(-1);
        found.push({ id, cantidad: Number(before) || NUMBER_WORDS[before] || 1 });
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
    const validCat = categoria && this.caja.products().some((p) => p.category === categoria) ? categoria : null;
    return { intent, items, categoria: intent === 'catalogo' || intent === 'recomendar' ? validCat : null, etiquetas: [], precio_max: null, pregunta: text.slice(0, 160) };
  }

  // ======================================================================
  // 2. Ejecutar: arma { draft, facts, mentioned, mode, emotion }
  // ======================================================================
  async execute(nlu) {
    const c = this.caja;
    const busy = ['agregar', 'quitar', 'pagar', 'cancelar'];
    if (c.state === 'dispensing' && busy.includes(nlu.intent)) {
      return { draft: 'Esperame tantito, estoy despachando tus cosas.', mode: 'strict', facts: {}, mentioned: [] };
    }
    // Sin productos (el programa de inventario no respondió nunca): no hay nada que ofrecer
    if (!c.products().length && !['despedida', 'no_entendi', 'cancelar'].includes(nlu.intent)) {
      await c.inv.refresh().catch(() => {});
      if (!c.products().length) return { draft: OFFLINE, mode: 'strict', facts: {}, mentioned: [], emotion: 'triste' };
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
      cancelar: () => this.doCancel(),
      ayuda: () => ({ draft: `Decime qué querés o apachá el botón de la casilla. Cuando termines, decí «pagar». ${this.config.caja.instruccionPago}`, mode: 'strict' }),
      despedida: () => this.doBye(),
      fuera_de_tema: () => this.doOffTopic(nlu),
      no_entendi: () => ({ draft: 'Perdón, no te entendí bien. ¿Me lo repetís?', mode: 'strict', emotion: 'pensativo' }),
    }[nlu.intent];
    const result = await handler();
    return { facts: {}, mentioned: [], mode: 'subset', ...result };
  }

  // Lo que se le puede decir al modelo sobre un producto (y nada más)
  facts(p) {
    return {
      nombre: p.name,
      precio: this.price(p.priceCents),
      tamaño: p.size || 'sin dato',
      descripcion: p.description || 'sin dato',
      etiquetas: p.tags.join(', ') || 'sin dato',
      alergenos: p.allergens.length ? `contiene ${joinList(p.allergens)}` : 'sin datos de alérgenos',
      disponible: p.stock > 0 ? 'sí' : 'agotado',
    };
  }

  withPrice(p) { return `${p.name} a ${this.price(p.priceCents)}`; }

  filtered({ categoria, etiquetas = [], precio_max } = {}) {
    return this.caja.inStock().filter((p) => (!categoria || p.category === categoria)
      && etiquetas.every((t) => p.tags.includes(t))
      && (precio_max == null || p.priceCents <= precio_max * 100));
  }

  best(list) {
    return [...list].sort((a, b) => (b.featured === true) - (a.featured === true) || b.stock - a.stock);
  }

  alternative(p) {
    return this.best(this.filtered({ categoria: p?.category }).filter((x) => x.id !== p?.id))[0] || null;
  }

  cartLine() {
    const s = this.caja.summary();
    if (!s.count) return '';
    return `Llevás ${s.count === 1 ? '1 producto' : `${s.count} productos`}, son ${this.price(s.totalCents)}.`;
  }

  cartFacts() {
    const s = this.caja.summary();
    return { productos: s.items.map((i) => `${i.qty} ${i.name}`), total: this.price(s.totalCents) };
  }

  categoriesInStock() {
    const cats = [...new Set(this.caja.inStock().map((p) => p.category))];
    return joinList(cats.map((k) => CATEGORY_NAMES[k] || k)) || 'nada por ahorita';
  }

  doGreeting() {
    return {
      draft: `¡Buenas! Tengo ${this.categoriesInStock()}. ¿Qué se te antoja?`,
      facts: { hay: this.categoriesInStock() },
      emotion: 'feliz',
    };
  }

  doCatalog(nlu) {
    const hasFilter = nlu.categoria || nlu.etiquetas.length || nlu.precio_max != null;
    if (!hasFilter) {
      const top = this.best(this.caja.inStock()).filter((p) => p.featured).slice(0, 2);
      let draft = `Tengo ${this.categoriesInStock()}.`;
      if (top.length) draft += ` Lo más pedido: ${joinList(top.map((p) => p.name))}.`;
      draft += ' ¿De cuál te antojás?';
      return { draft, facts: { hay: this.categoriesInStock() }, mentioned: top };
    }
    const list = this.best(this.filtered(nlu));
    if (!list.length) return { draft: `Ahorita no tengo nada así. Tengo ${this.categoriesInStock()}.`, facts: {}, emotion: 'triste' };
    const shown = list.slice(0, 5);
    this.caja.lastMentioned = shown.map((p) => p.id);
    const draft = `Tengo ${joinList(shown.map((p) => this.withPrice(p)))}${list.length > shown.length ? ', y otras cosas más.' : '.'}`;
    return { draft, facts: { productos: shown.map((p) => this.facts(p)) }, mentioned: shown };
  }

  doInfo(nlu) {
    const id = nlu.items[0]?.id || this.caja.lastMentioned[0];
    const p = id && this.caja.product(id);
    if (!p) return this.notInCatalog(nlu);
    this.caja.lastMentioned = [p.id];
    const f = this.facts(p);
    let draft = `${p.name}${p.size ? `, ${p.size}` : ''}, a ${f.precio}.`;
    draft += p.stock > 0 ? ' ¿Te lo doy?' : ' Ahorita está agotado.';
    return { draft, facts: { producto: f, pregunta_del_cliente: nlu.pregunta }, mentioned: [p], answerQuestion: true };
  }

  doRecommend(nlu) {
    const hasFilter = nlu.categoria || nlu.etiquetas.length || nlu.precio_max != null;
    let picks;
    if (hasFilter) picks = this.best(this.filtered(nlu)).slice(0, 2);
    else {
      // Sin preferencias: algo de comer y algo de tomar
      const snack = this.best(this.caja.inStock().filter((p) => p.category !== 'bebidas'))[0];
      const drink = this.best(this.filtered({ categoria: 'bebidas' }))[0];
      picks = [snack, drink].filter(Boolean);
    }
    if (!picks.length) return { draft: `Ahorita no tengo nada así. Tengo ${this.categoriesInStock()}.`, emotion: 'triste' };
    this.caja.lastMentioned = picks.map((p) => p.id);
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
      this.caja.lastMentioned = [alt.id];
    } else draft += ` Tengo ${this.categoriesInStock()}.`;
    return { draft, facts: { no_hay: nlu.pregunta || 'lo que pidió' }, mentioned: alt ? [alt] : [], mode: 'strict', emotion: 'pensativo' };
  }

  async doAdd(nlu) {
    if (!nlu.items.length) return this.notInCatalog(nlu);
    const added = [];
    const problems = [];
    const mentioned = [];
    for (const { id, cantidad } of nlu.items) {
      const r = await this.caja.add(id, cantidad);
      const p = this.caja.product(id);
      if (p) mentioned.push(p);
      if (r.ok) { added.push(`${cantidad} ${p.name}`); continue; }
      if (r.reason === 'agotado') {
        const alt = this.alternative(p);
        problems.push(`Ya no me queda ${p.name}${alt ? `, pero tengo ${this.withPrice(alt)}` : ''}.`);
        if (alt) { mentioned.push(alt); this.caja.lastMentioned = [alt.id]; }
      } else if (r.reason === 'insuficiente') problems.push(`De ${p.name} solo me quedan ${r.available}.`);
      else if (r.reason === 'limite') problems.push(`Solo puedo despachar ${r.max} productos por compra.`);
    }
    let draft = added.length ? `Listo, te agrego ${joinList(added)}.` : '';
    if (problems.length) draft += `${draft ? ' ' : ''}${problems.join(' ')}`;
    if (added.length) draft += ` ${this.cartLine()} ¿Algo más o pagamos?`;
    return { draft, mentioned: unique(mentioned), mode: 'strict', emotion: added.length ? 'feliz' : 'triste', facts: { pedido: this.cartFacts() } };
  }

  async doRemove(nlu) {
    if (!nlu.items.length) return { draft: '¿Cuál querés que te quite?', mode: 'strict' };
    const removed = [];
    const mentioned = [];
    for (const { id } of nlu.items) {
      const r = await this.caja.remove(id);
      if (r.product) mentioned.push(r.product);
      if (r.ok) removed.push(r.product.name);
    }
    if (!removed.length) return { draft: `Eso no lo llevás en tu pedido. ${this.cartLine() || 'Todavía no llevás nada.'}`, mentioned, mode: 'strict' };
    return { draft: `Listo, te quité ${joinList(removed)}. ${this.cartLine() || 'Ya no llevás nada.'}`, mentioned, mode: 'strict', facts: { pedido: this.cartFacts() } };
  }

  doCart() {
    const s = this.caja.summary();
    if (!s.count) return { draft: 'Todavía no llevás nada. ¿Qué se te antoja?', mode: 'strict' };
    return {
      draft: `Llevás ${joinList(s.items.map((i) => `${i.qty} ${i.name}`))}, son ${this.price(s.totalCents)}. ${s.state === 'awaiting_payment' ? this.config.caja.instruccionPago : '¿Pagamos?'}`,
      mentioned: s.items.map((i) => this.caja.product(i.id)).filter(Boolean),
      mode: 'strict',
      facts: { pedido: this.cartFacts() },
    };
  }

  async doPay() {
    const r = await this.caja.checkout();
    if (!r.ok) {
      if (r.reason === 'vacio') return { draft: 'Primero decime qué querés llevar.', mode: 'strict' };
      if (r.reason === 'insuficiente') {
        return r.product
          ? { draft: `De ${r.product.name} solo me quedan ${r.available}. ¿Te cambio la cantidad?`, mentioned: [r.product], mode: 'strict', emotion: 'triste' }
          : { draft: 'Algo de tu pedido ya se acabó. ¿Lo revisamos?', mode: 'strict', emotion: 'triste' };
      }
      if (r.reason === 'sin_conexion') return { draft: OFFLINE, mode: 'strict', emotion: 'triste' };
      return { draft: 'Esperame tantito, estoy despachando.', mode: 'strict' };
    }
    const n = r.count === 1 ? '1 producto' : `${r.count} productos`;
    return { draft: `Son ${this.price(r.totalCents)} por ${n}. ${this.config.caja.instruccionPago}`, mode: 'strict', facts: { pedido: this.cartFacts() } };
  }

  async doCancel() {
    const r = await this.caja.cancel();
    if (r.ok) return { draft: r.had ? 'Listo, cancelé tu pedido. Aquí estoy cuando se te antoje algo.' : 'No hay nada que cancelar. ¿Qué se te antoja?', mode: 'strict' };
    if (r.reason === 'ya_pagado') return { draft: 'Tu pago ya entró, así que ya no lo puedo cancelar. Ahorita te lo despacho.', mode: 'strict' };
    return { draft: 'Esperame tantito, estoy despachando.', mode: 'strict' };
  }

  doBye() {
    if (this.caja.cart.size) return { draft: `Todavía tenés un pedido sin pagar. ${this.cartLine()} ¿Pagamos o lo cancelo?`, mode: 'strict' };
    return { draft: '¡Gracias a vos! Que te vaya bien.', emotion: 'feliz' };
  }

  doOffTopic(nlu) {
    const offer = this.best(this.caja.inStock())[0];
    if (offer) this.caja.lastMentioned = [offer.id];
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
    const system = `${this.config.persona.style}

Tu tarea: decir el BORRADOR con tu estilo, para que suene natural en voz alta, como el cajero de esta tiendita.
Reglas estrictas:
- Usa SOLO la información del borrador y de los hechos. No inventes productos, precios, promociones, cantidades, tiempos ni datos.
- Escribe los números con dígitos y exactamente como aparecen (por ejemplo «8 quetzales con 50»).
- ${result.answerQuestion ? 'Contesta la pregunta del cliente usando solo los hechos. Si el dato no está en los hechos, di que ese dato no lo tienes.' : 'Si el cliente preguntó algo que no está en los hechos, di que ese dato no lo tienes.'}
- Si el borrador le pide algo al cliente (pagar, elegir, confirmar), mantén esa petición.
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
        catalog: this.caja.products(),
      });
      debug.validation = v;
      return v.ok ? styled : result.draft;
    } catch (e) {
      debug.styleError = e.message;
      return result.draft;
    }
  }
}

function unique(products) {
  const seen = new Set();
  return products.filter((p) => p && !seen.has(p.id) && seen.add(p.id));
}

function mergeItems(items) {
  const m = new Map();
  for (const i of items) m.set(i.id, (m.get(i.id) || 0) + i.cantidad);
  return [...m].map(([id, cantidad]) => ({ id, cantidad }));
}
