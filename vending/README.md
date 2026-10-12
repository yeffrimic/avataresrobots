# Sistema de la máquina expendedora

Este sistema maneja toda la logística de una máquina de snacks y bebidas: catálogo, existencias por casilla, pedido, cobro, despacho por Arduino, reembolsos y ventas. El avatar es **solo el encargado**: le pasa a este sistema lo que dijo el cliente y dice en voz alta lo que el sistema responde.

```
Cliente ──voz──► Avatar (puerto 3000) ──texto──► Sistema de la máquina (puerto 4000) ──USB──► Arduino
        ◄──voz── (labios, ticket en pantalla) ◄── respuesta exacta ──   ◄── botones, despacho ──
```

## Índice

- [Arranque](#arranque)
- [Cómo evita alucinar](#cómo-evita-alucinar)
- [Cómo compra un cliente](#cómo-compra-un-cliente)
- [Panel de administración](#panel-de-administración)
- [Conectar el Arduino](#conectar-el-arduino)
- [Archivos](#archivos)
- [Pruebas](#pruebas)

## Arranque

En la PC de la máquina (Windows, Linux o Mac), con Node.js 22 o superior:

1. **Configura el archivo `.env`** en la carpeta raíz del proyecto (el mismo del avatar):
   ```
   GROQ_API_KEY=gsk_...
   VENDING_URL=http://localhost:4000
   ADMIN_PIN=un-pin-secreto
   ```
2. **Arranca el sistema de la máquina** en una terminal:
   ```
   cd vending
   npm start
   ```
3. **Arranca el avatar** en otra terminal, desde la raíz del proyecto:
   ```
   npm start
   ```
4. **Abre el avatar** en `http://localhost:3000`, a pantalla completa (F11). Activa el micrófono una vez para que el navegador dé permiso; al hacerlo, Juan saluda.
5. **Abre el panel** del operador en `http://localhost:4000/admin`.

La primera vez se crea `vending/data/` con el catálogo, la configuración y los códigos de ejemplo. Desde ese momento, todo se edita en el panel.

## Cómo evita alucinar

El modelo de lenguaje **nunca decide nada**. Cada frase del cliente pasa por tres pasos:

1. **Entender:** el modelo convierte la frase en una intención estructurada (JSON), por ejemplo «agregar 2 doritos». Los productos se validan contra el catálogo, y un id inventado se descarta. Los códigos de pago no pasan por el modelo: se reconocen con reglas, aunque se digan con palabras («uno dos tres cuatro»).
2. **Ejecutar:** la lógica de venta (`lib/commerce.js`, 100 % determinista) agrega al pedido, revisa existencias, cobra y despacha. Con el resultado arma un **borrador exacto**, con precios y datos reales.
3. **Dar estilo:** el modelo reescribe el borrador con la voz de Juan, el tendero. Un **validador** compara esa versión con el borrador y la rechaza si:
   - aparece un número que no está en los datos (un precio o descuento inventado);
   - falta un precio, total o cantidad que el borrador sí decía;
   - nombra un producto del que no se estaba hablando;
   - trae formato raro o es demasiado larga.

   Si la rechaza, Juan dice el borrador tal cual. Puede sonar menos gracioso, pero siempre es correcto.

A las preguntas sobre productos («¿tiene cafeína?», «¿es dulce?»), el modelo solo responde con lo que dice la ficha del producto en el panel. Si el dato no está, dice que no lo tiene. Si el cliente habla de otra cosa, Juan responde con humor breve y vuelve a los antojos.

**Si Groq falla o llega a su límite**, la máquina sigue vendiendo: entiende con reglas simples (nombres y alias del catálogo, palabras clave) y dice los borradores.

## Cómo compra un cliente

1. **Elegir:** pide por voz («dame unos doritos y una coca») o apacha el botón de la casilla. En pantalla aparece el ticket con el pedido y el total.
2. **Preguntar** lo que quiera: qué hay, cuánto cuesta algo, qué le recomienda Juan.
3. **Pagar:** dice «eso es todo» o apacha OK. Juan dice el total y le pide el código.
4. **Dar el código:** el cliente lo dice. Si es válido y tiene saldo, se cobra y la máquina despacha producto por producto.
5. **Recibir:** si una casilla se traba, la máquina intenta con otra casilla del mismo producto. Si no hay otra, reembolsa ese producto al código y Juan lo avisa.

Si el cliente se va a medio pedido, se cancela solo: a los 60 segundos sin actividad, o a los 120 si se estaba esperando el código. Los dos tiempos se cambian en el panel.

**Pago simulado:** los códigos funcionan como tarjetas prepagadas con saldo, y se crean en el panel. También se puede aprobar un pago desde el panel, como si fuera efectivo. Para cobrar de verdad hay que conectar un proveedor de pagos o un monedero. El protocolo ya reserva el mensaje `CREDIT` para un monedero.

## Panel de administración

`http://localhost:4000/admin`, protegido con el PIN de `ADMIN_PIN`.

| Pestaña | Para qué |
|---|---|
| Resumen | Ventas del día, pedido en curso (aprobar pago o cancelar), alertas de existencias bajas, actividad reciente (incluye lo que dijeron los clientes) |
| Inventario | Las casillas como en la máquina: qué producto lleva cada una, existencias, rellenar, **probar el motor** y **simular el botón** |
| Productos | Nombre, alias (cómo lo pide la gente), precio, tamaño, descripción, etiquetas, alérgenos, destacado. **Todo lo que Juan sabe sale de aquí.** |
| Ventas | Por fechas y por producto, con descarga a CSV |
| Códigos de pago | Crear y recargar códigos, de uso único o recargables |
| Probar | Conversación escrita para revisar cómo entiende y qué responde, con el detalle de cada respuesta |
| Configuración | Personaje (nombre, estilo, voz, color), conexión de la máquina, límites de venta, botones y modelo de lenguaje |

## Conectar el Arduino

1. **Instala la librería del puerto serie**, una sola vez, en la carpeta `vending`:
   ```
   npm install
   ```
2. **Carga el firmware** `firmware/maquina/maquina.ino`. Antes, ajusta los pines de motores y botones, y si tienes sensor de caída, actívalo.
3. **Cambia la conexión** en el panel: Configuración → Máquina → **Arduino por USB**, con el puerto (por ejemplo `COM3` en Windows o `/dev/ttyACM0` en Linux). Se reconecta solo, sin reiniciar el sistema.
4. **Prueba cada casilla** desde Inventario → «Probar».

**Protocolo** (texto, una orden por línea, 9600 baudios):

| Dirección | Mensaje | Significado |
|---|---|---|
| PC → Arduino | `VEND A1` | Despacha una unidad de la casilla A1 |
| Arduino → PC | `DONE A1` | Cayó el producto |
| Arduino → PC | `FAIL A1 EMPTY` | No cayó nada (también `JAM`, `TIMEOUT`…) |
| Arduino → PC | `BTN A1` / `BTN OK` / `BTN CANCEL` | Alguien apachó un botón físico |
| Arduino → PC | `READY` | El Arduino arrancó |

> **Si la máquina ya tiene un Arduino con su propio programa** (el de la aplicación de Windows que se reemplaza), ese programa usa su propio protocolo. Hay dos opciones: cargarle este firmware, o adaptar `parseLine()` y `_sendVend()` en `lib/machine.js` a sus mensajes.

## Archivos

| Archivo | Qué hace |
|---|---|
| `server.js` | API del avatar, eventos en vivo (SSE) y API del panel |
| `lib/commerce.js` | Pedido, cobro, despacho, reembolsos y ventas (determinista) |
| `lib/brain.js` | Entender, armar el borrador y dar estilo |
| `lib/text.js` | Precios dichos en voz y el validador anti-alucinaciones |
| `lib/machine.js` | Simulador y Arduino por USB |
| `lib/store.js` | Datos en JSON y registro de ventas en `data/sales.jsonl` |
| `seed/` | Catálogo, configuración y códigos de ejemplo |
| `firmware/maquina/maquina.ino` | Firmware de referencia del Arduino |

## Pruebas

```
cd vending
npm test
```

Prueban, sin Groq ni hardware:
- la compra completa y que no venda lo agotado;
- los códigos inválidos o sin saldo;
- el cambio de casilla y el reembolso cuando algo se traba;
- los botones físicos y el protocolo del Arduino;
- el validador con respuestas inventadas a propósito.
