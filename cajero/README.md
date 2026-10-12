# El cajero: el avatar atiende la máquina expendedora

El avatar es un **cajero**, como el de una tienda. Conversa con el cliente, arma el pedido, se lo envía a **tu programa de inventario** por API y anuncia lo que tu programa le responda: pago confirmado, despachando, entregado o falló.

El cajero **no guarda inventario, no cobra y no mueve motores**. Todo eso lo hace tu programa.

```
Cliente ──voz──► Avatar ──► Cajero (:4000) ──── API ────► Tu programa de inventario ──► Arduino, lector de pago
        ◄──voz── (labios,     ◄── pagado / entregado ───   (productos, precios, existencias, cobro, despacho)
                 ticket)
```

## Índice

- [Lo que tu programa necesita](#lo-que-tu-programa-necesita)
- [Arranque](#arranque)
- [Probar sin tu programa (simulador)](#probar-sin-tu-programa-simulador)
- [Cómo evita alucinar](#cómo-evita-alucinar)
- [Cómo compra un cliente](#cómo-compra-un-cliente)
- [Configuración](#configuración)
- [Archivos](#archivos)

## Lo que tu programa necesita

Cuatro rutas HTTP con JSON. Todo el detalle, con ejemplos, está en **[API.md](API.md)**:

| Ruta | Para qué |
|---|---|
| `GET /productos` | Lista con nombre, precio y existencias (y opcionalmente alias, descripción, etiquetas, casilla…) |
| `POST /pedidos` | El cliente terminó de elegir: tu programa crea el pedido y espera el pago |
| `GET /pedidos/{id}` | Estado: `esperando_pago`, `pagado`, `despachando`, `entregado`, `fallido`, `cancelado` |
| `POST /pedidos/{id}/cancelar` | El cliente se arrepintió antes de pagar |

**Opcional:** tu programa puede avisarle al cajero con `POST /api/eventos`. Sirve para avisos instantáneos de pago, para los **botones físicos** y para hacer hablar al avatar. Si no lo usas, el cajero consulta el estado del pedido cada segundo.

## Arranque

En el archivo `.env` de la raíz del proyecto:
```
GROQ_API_KEY=gsk_...
CAJERO_URL=http://localhost:4000
INVENTARIO_URL=http://localhost:5000      ← la dirección de tu programa
```

Luego, en dos terminales:
```
cd cajero && npm start      # el cajero (:4000)
npm start                   # el avatar (:3000), desde la raíz
```

Abre `http://localhost:3000` a pantalla completa y activa el micrófono una vez; al hacerlo, el cajero saluda. En `http://localhost:4000` (solo desde esa PC) hay una página para **probar la conversación escribiendo**: muestra cómo entendió cada frase y si la respuesta salió con estilo o como borrador exacto.

## Probar sin tu programa (simulador)

`simulador/servidor.js` hace de tu programa de inventario: implementa la API completa y tiene una página para **confirmar pagos**, **apachar botones** y **simular fallas**. Además sirve como ejemplo para programar la API en tu programa.

```
cd cajero
set CAJERO_URL=http://localhost:4000    (en Linux/Mac: export CAJERO_URL=...)
npm run simulador                       # http://localhost:4100
```

Con el simulador, `INVENTARIO_URL` va en `http://localhost:4100` (es el valor por defecto de `config.json`). Para que el pago se confirme solo a los 5 segundos, arranca el simulador con `SIM_AUTOPAGO=5`.

## Cómo evita alucinar

El modelo de lenguaje **nunca decide nada**:

1. **Entender:** el modelo convierte lo que dijo el cliente en una intención estructurada, por ejemplo «agregar 2 doritos». Los productos se validan contra la lista de tu programa, y si el modelo inventa uno, se descarta.
2. **Ejecutar:** la caja (código determinista) arma el pedido con las existencias y precios de tu programa, y escribe un **borrador exacto** de la respuesta. Al cobrar, el total que se dice es **el que devuelve tu programa**.
3. **Dar estilo:** el modelo reescribe el borrador como Juan, el tendero chapín. Un **validador** rechaza esa versión si inventa un número (precio o descuento), omite el total o una cantidad, o nombra un producto del que no se hablaba. En ese caso se dice el borrador.

Las preguntas («¿tiene cafeína?») se responden solo con los campos que manda tu programa. Si un dato no está, el cajero dice que no lo tiene.

**Si Groq falla**, el cajero sigue vendiendo con reglas simples. **Si tu programa no responde**, el cajero avisa que no puede comunicarse con la máquina; nunca vende a ciegas.

## Cómo compra un cliente

1. **Elegir:** por voz («dame unos doritos y una coca») o con los botones de las casillas. En pantalla aparece el ticket.
2. **Preguntar:** qué hay, cuánto cuesta algo o qué le recomienda.
3. **Pagar:** dice «eso es todo» o apacha OK. El cajero crea el pedido en tu programa, dice el total y cómo pagar.
4. **El pago:** tu programa lo confirma, el cajero dice «¡Pago recibido!» y luego anuncia la entrega o qué no salió y el reembolso.

Si el cliente cambia el pedido mientras se espera el pago, el cajero cancela el pedido en tu programa y crea otro nuevo. Si el pago no llega en 120 segundos, lo cancela. Si el cliente deja de hablar a media compra, el pedido se descarta a los 60 segundos.

## Configuración

En `config.json`:

| Sección | Qué se configura |
|---|---|
| `persona` | Nombre, estilo de habla, saludo, voz de Microsoft, color del rostro |
| `currency` | Moneda (para decir los precios) |
| `caja` | Máximo de productos por compra, tiempos de espera, frase de cómo pagar (`instruccionPago`) |
| `botones` | Nombres de los botones que confirman o cancelan |
| `inventario` | Dirección de tu programa (o `INVENTARIO_URL` en `.env`), cada cuánto consultar el pedido |
| `llm` | Modelo de Groq, tiempo máximo, si se le da estilo a las respuestas |

Variables de seguridad opcionales en `.env`:
- `INVENTARIO_TOKEN`: el cajero lo envía a tu programa como `Authorization: Bearer`.
- `CAJERO_TOKEN`: tu programa debe enviarlo en `X-Cajero-Token` al avisar eventos.

## Archivos

| Archivo | Qué hace |
|---|---|
| `API.md` | El contrato con tu programa de inventario |
| `server.js` | API para el avatar, entrada de eventos de tu programa y página de pruebas |
| `lib/caja.js` | Pedido y ciclo con tu programa (crear, consultar, cancelar) |
| `lib/inventario.js` | Cliente HTTP de tu programa |
| `lib/brain.js` | Entender, armar el borrador y dar estilo |
| `lib/text.js` | Precios dichos en voz y el validador anti-alucinaciones |
| `simulador/` | Programa de inventario de mentira para probar (y de ejemplo) |
| `test/` | `npm test`: 10 pruebas contra el simulador, sin Groq |
