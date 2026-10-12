// Firmware de referencia para la máquina expendedora. Con 15 casillas y 17 botones, los pines de
// abajo son de un Arduino Mega; en un Uno/Nano usa menos casillas o un expansor (PCF8574, 74HC165).
// Habla con el sistema de la PC por USB a 9600 baudios, una orden por línea:
//
//   PC → Arduino:   VEND A1     gira el motor (espiral) de la casilla A1 hasta que cae el producto
//                   PING
//   Arduino → PC:   READY       al arrancar
//                   PONG
//                   DONE A1     el producto cayó (o el motor completó su vuelta si no hay sensor)
//                   FAIL A1 X   no se pudo: X = EMPTY (no cayó nada), UNKNOWN (casilla no existe), BUSY
//                   BTN A1      se apachó un botón físico (casillas, OK, CANCEL)
//
// AJUSTA las tablas de abajo a tu máquina. Los motores van por relé o driver (¡nunca directo al pin!).

// ---------- Casillas: código, pin del motor ----------
struct Slot { const char* code; uint8_t motorPin; };
Slot SLOTS[] = {
  { "A1", 22 }, { "A2", 23 }, { "A3", 24 }, { "A4", 25 }, { "A5", 26 },
  { "B1", 27 }, { "B2", 28 }, { "B3", 29 }, { "B4", 30 }, { "B5", 31 },
  { "C1", 32 }, { "C2", 33 }, { "C3", 34 }, { "C4", 35 }, { "C5", 36 },
};
const uint8_t NUM_SLOTS = sizeof(SLOTS) / sizeof(SLOTS[0]);

// ---------- Botones físicos: nombre que se envía, pin (a GND, con INPUT_PULLUP) ----------
struct Button { const char* name; uint8_t pin; bool last; unsigned long changedAt; };
Button BUTTONS[] = {
  { "A1", 38 }, { "A2", 39 }, { "A3", 40 }, { "A4", 41 }, { "A5", 42 },
  { "B1", 43 }, { "B2", 44 }, { "B3", 45 }, { "B4", 46 }, { "B5", 47 },
  { "C1", 48 }, { "C2", 49 }, { "C3", 50 }, { "C4", 51 }, { "C5", 52 },
  { "OK", 53 }, { "CANCEL", A0 },
};
const uint8_t NUM_BUTTONS = sizeof(BUTTONS) / sizeof(BUTTONS[0]);

// ---------- Sensor de caída (opcional): barrera infrarroja en la bandeja ----------
const bool USE_DROP_SENSOR = false;   // true si tienes sensor
const uint8_t DROP_SENSOR_PIN = 2;    // LOW cuando algo cruza la barrera
const unsigned long MOTOR_TURN_MS = 1800;   // sin sensor: lo que tarda una vuelta de espiral
const unsigned long DROP_TIMEOUT_MS = 6000; // con sensor: tiempo máximo esperando la caída
const bool RELAY_ACTIVE_LOW = true;   // muchos módulos de relé se activan con LOW

const unsigned long DEBOUNCE_MS = 40;
String line;

void motor(uint8_t pin, bool on) {
  digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

int findSlot(const String& code) {
  for (uint8_t i = 0; i < NUM_SLOTS; i++) if (code.equalsIgnoreCase(SLOTS[i].code)) return i;
  return -1;
}

void vend(const String& code) {
  int i = findSlot(code);
  if (i < 0) { Serial.print("FAIL "); Serial.print(code); Serial.println(" UNKNOWN"); return; }
  bool dropped = false;
  motor(SLOTS[i].motorPin, true);
  unsigned long start = millis();
  if (USE_DROP_SENSOR) {
    while (millis() - start < DROP_TIMEOUT_MS) {
      if (digitalRead(DROP_SENSOR_PIN) == LOW) { dropped = true; break; }
    }
  } else {
    delay(MOTOR_TURN_MS);
    dropped = true; // sin sensor confiamos en la vuelta completa
  }
  motor(SLOTS[i].motorPin, false);
  Serial.print(dropped ? "DONE " : "FAIL ");
  Serial.print(SLOTS[i].code);
  Serial.println(dropped ? "" : " EMPTY");
}

void handleLine(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;
  if (cmd.equalsIgnoreCase("PING")) { Serial.println("PONG"); return; }
  if (cmd.startsWith("VEND ") || cmd.startsWith("vend ")) { vend(cmd.substring(5)); return; }
}

void readButtons() {
  for (uint8_t i = 0; i < NUM_BUTTONS; i++) {
    bool pressed = digitalRead(BUTTONS[i].pin) == LOW;
    if (pressed != BUTTONS[i].last && millis() - BUTTONS[i].changedAt > DEBOUNCE_MS) {
      BUTTONS[i].last = pressed;
      BUTTONS[i].changedAt = millis();
      if (pressed) { Serial.print("BTN "); Serial.println(BUTTONS[i].name); }
    }
  }
}

void setup() {
  Serial.begin(9600);
  for (uint8_t i = 0; i < NUM_SLOTS; i++) { pinMode(SLOTS[i].motorPin, OUTPUT); motor(SLOTS[i].motorPin, false); }
  for (uint8_t i = 0; i < NUM_BUTTONS; i++) { pinMode(BUTTONS[i].pin, INPUT_PULLUP); BUTTONS[i].last = false; BUTTONS[i].changedAt = 0; }
  if (USE_DROP_SENSOR) pinMode(DROP_SENSOR_PIN, INPUT_PULLUP);
  Serial.println("READY");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleLine(line); line = ""; }
    else if (c != '\r' && line.length() < 32) line += c;
  }
  readButtons();
}
