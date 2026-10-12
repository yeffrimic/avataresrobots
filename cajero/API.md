# API entre el cajero (avatar) y tu programa de inventario

El cajero no guarda inventario ni cobra: **pregunta y avisa a tu programa**. Tu programa es la única fuente de verdad sobre productos, precios, existencias, pagos y despacho.

```
Cliente ──voz──► Cajero (avatar) ──── GET /productos ─────────► Tu programa ── Arduino / lector de pago
                                 ──── POST /pedidos ──────────►
                                 ◄─── estado del pedido ──────  (el cajero consulta cada segundo,
                                                                 o tu programa le avisa: opcional)
```

Todo es JSON con UTF-8. Los precios van en la unidad de tu moneda, con decimales (`6.50` = Q6.50). Si defines `INVENTARIO_TOKEN`, el cajero lo envía en cada petición como `Authorization: Bearer <token>`.

## Lo que tu programa debe tener (4 rutas)

### 1. `GET /productos`

La lista de lo que se vende. El cajero la vuelve a pedir cada 30 segundos y justo antes de cada cobro.

```json
[
  {
    "id": "doritos",
    "nombre": "Doritos Nacho",
    "precio": 6.00,
    "existencias": 7,

    "categoria": "chips",
    "alias": ["doritos", "dorito"],
    "tamano": "bolsa pequeña",
    "descripcion": "Tostitos de maíz sabor queso.",
    "etiquetas": ["salado", "queso"],
    "alergenos": [],
    "destacado": true,
    "casilla": "A2"
  }
]
```

| Campo | Obligatorio | Para qué lo usa el cajero |
|---|---|---|
| `id` | sí | Identificar el producto en los pedidos |
| `nombre` | sí | Decirlo en voz alta |
| `precio` | sí | Decir precios y totales |
| `existencias` | sí | No ofrecer lo agotado (0) |
| `categoria` | no | Responder «¿qué tenés de tomar?» (sugeridas: `chips`, `dulces`, `bebidas`) |
| `alias` | no | Entender cómo lo pide la gente («coca», «coquita») |
| `tamano`, `descripcion`, `etiquetas`, `alergenos` | no | Responder preguntas. **Lo que no esté aquí, el cajero dice que no lo sabe**: nunca lo inventa |
| `destacado` | no | Darle preferencia al recomendar |
| `casilla` | no | Relacionar un botón físico con su producto (ver eventos) |

### 2. `POST /pedidos`

El cliente terminó de elegir. Tu programa reserva los productos y empieza a esperar el pago.

Petición:
```json
{ "items": [ { "id": "doritos", "cantidad": 2 }, { "id": "coca", "cantidad": 1 } ] }
```

Respuesta `201` (o `200`):
```json
{ "id": "P-1029", "estado": "esperando_pago", "total": 20.00 }
```

El cajero dice **el `total` que devuelve tu programa**: el precio que manda es el de tu programa, no el que calculó el cajero.

Si algo ya no hay, responde `409`:
```json
{ "error": "sin_existencias", "id": "doritos", "disponibles": 1 }
```

### 3. `GET /pedidos/{id}`

El estado del pedido. Mientras hay un pedido abierto, el cajero lo consulta cada segundo.

```json
{ "id": "P-1029", "estado": "pagado", "entregados": [], "fallidos": [], "reembolso": 0 }
```

| `estado` | Qué dice el avatar |
|---|---|
| `esperando_pago` | Nada: ya le dijo al cliente el total y cómo pagar |
| `pagado` | «¡Pago recibido! Ya te lo despacho» |
| `despachando` | Igual que `pagado` (si saltaste ese estado) |
| `entregado` | «¡Listo! Ya cayó todo, sacalo de abajo» |
| `fallido` | Cuáles no salieron (`fallidos`, ids repetidos por unidad) y, si `reembolso` > 0, cuánto se devuelve |
| `cancelado` / `vencido` | Que el pago no se completó y el pedido se canceló |

Cuando el pedido termina (`entregado` o `fallido`), en `entregados` y `fallidos` va un id por cada unidad. Por ejemplo `["doritos", "doritos"]`.

### 4. `POST /pedidos/{id}/cancelar`

El cliente se arrepintió antes de pagar, o se venció el tiempo de espera del cajero.

- Respuesta `200`: `{ "id": "P-1029", "estado": "cancelado" }`
- Si ya está pagado, responde `409` `{ "error": "ya_pagado" }`. El cajero le dirá al cliente que ya no se puede cancelar.

## Opcional: que tu programa le avise al cajero

Para avisos instantáneos (sin esperar la consulta de cada segundo), para los botones físicos o para hacer hablar al avatar, tu programa puede hacer `POST` a:

```
http://<pc-del-cajero>:4000/api/eventos
Header:  X-Cajero-Token: <CAJERO_TOKEN>      (si lo definiste en el .env del cajero)
```

| Evento | Cuerpo |
|---|---|
| Cambió un pedido | `{ "tipo": "pedido", "id": "P-1029", "estado": "pagado" }` (mismos campos que `GET /pedidos/{id}`) |
| Apacharon un botón de casilla | `{ "tipo": "boton", "casilla": "A2" }`: el cajero agrega ese producto |
| Botón de pagar / cancelar | `{ "tipo": "boton", "boton": "OK" }` o `{ "tipo": "boton", "boton": "CANCEL" }` |
| Cambió el inventario | `{ "tipo": "inventario" }`: el cajero vuelve a pedir `/productos` |
| Que el avatar diga algo | `{ "tipo": "decir", "texto": "¡Ya rellené las Coca-Colas!" }` |

## Probar con curl

```bash
curl http://localhost:4100/productos
curl -X POST http://localhost:4100/pedidos -H "Content-Type: application/json" -d "{\"items\":[{\"id\":\"doritos\",\"cantidad\":1}]}"
curl http://localhost:4100/pedidos/P-1
curl -X POST http://localhost:4000/api/eventos -H "Content-Type: application/json" -d "{\"tipo\":\"boton\",\"casilla\":\"A2\"}"
```

El **simulador** (`simulador/servidor.js`) implementa esta API completa. Sirve para probar sin tu programa y como ejemplo de cómo responder.
