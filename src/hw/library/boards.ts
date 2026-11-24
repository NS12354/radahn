import type { BoardDef, Family, PinGroup } from '../types';

const rng = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** RP2040/RP2350 pin-mux tables: every pin each SPI/I2C instance can use. */
export const RP2_SPI: PinGroup[] = [{ sck: [2, 6, 18, 22], mosi: [3, 7, 19, 23] }, { sck: [10, 14, 26], mosi: [11, 15, 27] }];
export const RP2_I2C: PinGroup[] = [{ sda: [0, 4, 8, 12, 16, 20, 24, 28], scl: [1, 5, 9, 13, 17, 21, 25, 29] }, { sda: [2, 6, 10, 14, 18, 22, 26], scl: [3, 7, 11, 15, 19, 23, 27] }];
/** The bus tables limited to the pins a board brings out. */
const only = (groups: PinGroup[], gpio: number[]): PinGroup[] => groups.map(g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v!.filter(p => gpio.includes(p))])) as PinGroup);

const PICO_IO = [...rng(0, 22), 26, 27, 28];
const rp2040 = (id: string, name: string, gpio: number[], o: Partial<BoardDef>): BoardDef => ({
  id, name, chip: 'RP2040', family: 'rp2040', runtime: 'rp2040-emu', lang: 'micropython', fidelity: 'emulated', pfx: 'GP',
  gpio, adc: gpio.filter(g => g >= 26), strap: [], spi: only(RP2_SPI, gpio), i2c: only(RP2_I2C, gpio), hwPwm: gpio,
  pinMaxmA: 12, pinRecmA: 8, rail3v3mA: 300, rail5vmA: 500, logicV: 3.3, cost: 6, pcb: '#1f4d34',
  notes: 'Runs the real MicroPython v1.24.1 firmware on an emulated RP2040 (rp2040js). Pins are GPIO numbers: Pin(26) is GP26.',
  ...o,
});
const avr = (id: string, name: string, o: Partial<BoardDef>): BoardDef => ({
  id, name, chip: 'ATmega328P', family: 'avr', runtime: 'avr-emu', lang: 'arduino', fidelity: 'emulated', pfx: 'D',
  gpio: rng(0, 19), adc: rng(14, 19), strap: [],
  label: g => (g < 14 ? 'D' + g : 'A' + (g - 14)),
  spi: [{ sck: [13], mosi: [11] }], i2c: [{ sda: [18], scl: [19] }], hwPwm: [3, 5, 6, 9, 10, 11],
  pinMaxmA: 40, pinRecmA: 20, rail3v3mA: 150, rail5vmA: 500, logicV: 5, cost: 27, pcb: '#1b5e8c',
  notes: 'Runs compiled Arduino C++ (avr-gcc) on an emulated ATmega328P (avr8js).',
  ...o,
});
const esp = (id: string, name: string, chip: string, o: Partial<BoardDef> & Pick<BoardDef, 'gpio' | 'adc' | 'strap'>): BoardDef => ({
  id, name, chip, family: 'esp32', runtime: 'sim-python', lang: 'micropython', fidelity: 'behavioral', pfx: 'GPIO',
  pinMaxmA: 40, pinRecmA: 20, rail3v3mA: 500, rail5vmA: 500, logicV: 3.3, cost: 8, pcb: '#1d2733',
  notes: 'Behavioral MicroPython simulation. Use "Physical board" to run on the real board over USB.',
  ...o,
});
const PI_HEADER = { gpio: rng(2, 27), adc: [] as number[], strap: [] as number[], spi: [{ sck: [11], mosi: [10] }], i2c: [{ sda: [2], scl: [3] }], hwPwm: [12, 13, 18, 19] };
const pi = (id: string, name: string, chip: string, o: Partial<BoardDef>): BoardDef => ({
  id, name, chip, family: 'pi', runtime: 'sim-python', lang: 'python', fidelity: 'behavioral', pfx: 'GPIO', ...PI_HEADER,
  pinMaxmA: 16, pinRecmA: 8, rail3v3mA: 500, rail5vmA: 1200, logicV: 3.3, cost: 45, pcb: '#1f4d34',
  notes: 'Behavioral simulation of Python 3 + gpiozero + smbus2.',
  ...o,
});

/**
 * Board library. To add a board, append a BoardDef here and (if it needs a new
 * runtime) register the runtime in src/hw/runtimes/index.ts. See docs/EXTENDING.md.
 */
export const BOARDS: Record<string, BoardDef> = {
  // ------------------------------------------------------------ Raspberry Pi Pico & RP2040
  picow: rp2040('picow', 'Raspberry Pi Pico / Pico W', PICO_IO, {}),
  pico2w: {
    ...rp2040('pico2w', 'Raspberry Pi Pico 2 / Pico 2 W', PICO_IO, {}),
    chip: 'RP2350', family: 'rp2350', runtime: 'sim-python', fidelity: 'behavioral', cost: 7, pinMaxmA: 12,
    notes: 'Behavioral MicroPython simulation (the emulator models the RP2040, not the RP2350). Same pinout and code as the Pico.',
  },
  xiao2040: rp2040('xiao2040', 'Seeed XIAO RP2040', [0, 1, 2, 3, 4, 6, 7, 26, 27, 28, 29], {
    cost: 5, pcb: '#1d2733', notes: 'Real MicroPython on an emulated RP2040. Silkscreen D0–D10 = GP26, 27, 28, 29, 6, 7, 0, 1, 2, 4, 3.',
  }),
  qtpy2040: rp2040('qtpy2040', 'Adafruit QT Py RP2040', [3, 4, 5, 6, 20, 22, 23, 24, 25, 26, 27, 28, 29], {
    cost: 10, pcb: '#1d2733', notes: 'Real MicroPython on an emulated RP2040. A0–A3 = GP29–26, SDA/SCL = GP24/25, STEMMA QT = GP22/23.',
  }),
  feather2040: rp2040('feather2040', 'Adafruit Feather RP2040', [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 18, 19, 20, 24, 25, 26, 27, 28, 29], {
    cost: 12, pcb: '#1d2733', rail3v3mA: 500, notes: 'Real MicroPython on an emulated RP2040. Has a LiPo charger. SDA/SCL = GP2/3, A0–A3 = GP26–29.',
  }),
  rp2040zero: rp2040('rp2040zero', 'Waveshare RP2040-Zero', [...rng(0, 15), 26, 27, 28, 29], {
    cost: 4, pcb: '#1d2733', notes: 'Real MicroPython on an emulated RP2040. Tiny castellated board; the onboard RGB LED is on GP16.',
  }),

  // ------------------------------------------------------------ Arduino (AVR)
  uno: avr('uno', 'Arduino Uno R3', {}),
  nano: avr('nano', 'Arduino Nano', { cost: 22, pcb: '#1b5e8c', notes: 'Runs compiled Arduino C++ on an emulated ATmega328P. Same pins as the Uno in a breadboard-friendly size (A6/A7 are analog-only and not modelled).' }),
  promini: avr('promini', 'Arduino Pro Mini 5 V / 16 MHz', { cost: 5, pcb: '#1b5e8c', rail3v3mA: 0, rail5vmA: 150, notes: 'Runs compiled Arduino C++ on an emulated ATmega328P. No USB: program it with a 5 V FTDI adapter.' }),

  // ------------------------------------------------------------ ESP32 & ESP8266
  esp32: esp('esp32', 'ESP32 DevKitC (WROOM-32)', 'ESP32', {
    gpio: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39],
    adc: [32, 33, 34, 35, 36, 39], adc2: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27], strap: [0, 2, 5, 12, 15], inputOnly: [34, 35, 36, 39],
    cost: 6, notes: 'Behavioral MicroPython simulation. GPIO 34–39 are input-only. Wi-Fi + Bluetooth.',
  }),
  esp32s3: esp('esp32s3', 'ESP32-S3 DevKitC-1', 'ESP32-S3', {
    gpio: [0, ...rng(1, 18), 21, 38, 39, 40, 41, 42, 45, 46, 47, 48], adc: rng(1, 10), adc2: rng(11, 18), strap: [0, 3, 45, 46], cost: 9,
  }),
  xiaos3: esp('xiaos3', 'Seeed XIAO ESP32-S3', 'ESP32-S3', {
    gpio: [1, 2, 3, 4, 5, 6, 7, 8, 9, 43, 44], adc: rng(1, 9), strap: [3], cost: 7,
    notes: 'Behavioral MicroPython simulation. Silkscreen D0–D10 = GPIO 1–6, 43, 44, 7, 8, 9.',
  }),
  nanoesp32: esp('nanoesp32', 'Arduino Nano ESP32', 'ESP32-S3', {
    gpio: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 21, 38, 43, 44, 47, 48], adc: rng(1, 10), adc2: rng(11, 14), strap: [3], cost: 20, pcb: '#1b5e8c',
    notes: 'Behavioral MicroPython simulation. In MicroPython use GPIO numbers: D2–D7 = GPIO 5–10, A0–A3 = GPIO 1–4.',
  }),
  esp32c3: esp('esp32c3', 'ESP32-C3 SuperMini', 'ESP32-C3', { gpio: [...rng(0, 10), 20, 21], adc: rng(0, 4), strap: [2, 8, 9], cost: 3 }),
  esp32c6: esp('esp32c6', 'ESP32-C6 DevKitC-1', 'ESP32-C6', {
    gpio: [...rng(0, 9), ...rng(14, 23)], adc: rng(0, 6), strap: [4, 5, 8, 9, 15], cost: 8,
    notes: 'Behavioral MicroPython simulation. Wi-Fi 6, Bluetooth LE, Thread/Zigbee.',
  }),
  esp32s2: esp('esp32s2', 'Wemos S2 Mini (ESP32-S2)', 'ESP32-S2', {
    gpio: [...rng(1, 18), 21, ...rng(33, 40)], adc: rng(1, 10), adc2: rng(11, 18), strap: [0, 45, 46], cost: 4,
  }),
  esp8266: esp('esp8266', 'NodeMCU v2 (ESP8266)', 'ESP8266', {
    family: 'esp8266', gpio: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17], adc: [17], adcAlias: { 0: 17 }, strap: [0, 2, 15],
    label: g => (g === 17 ? 'A0' : 'GPIO' + g), pinMaxmA: 12, pinRecmA: 12, rail3v3mA: 300, cost: 4,
    notes: 'Behavioral MicroPython simulation. One analog input, A0 = ADC(0). Silkscreen D1 = GPIO5, D2 = GPIO4.',
  }),
  d1mini: esp('d1mini', 'Wemos D1 mini (ESP8266)', 'ESP8266', {
    family: 'esp8266', gpio: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17], adc: [17], adcAlias: { 0: 17 }, strap: [0, 2, 15],
    label: g => (g === 17 ? 'A0' : 'GPIO' + g), pinMaxmA: 12, pinRecmA: 12, rail3v3mA: 300, cost: 3,
    notes: 'Behavioral MicroPython simulation. D0–D8 = GPIO 16, 5, 4, 0, 2, 14, 12, 13, 15; A0 = ADC(0).',
  }),

  // ------------------------------------------------------------ Raspberry Pi (Linux)
  pi5: pi('pi5', 'Raspberry Pi 5', 'BCM2712', { rail5vmA: 1600, cost: 60 }),
  pi4: pi('pi4', 'Raspberry Pi 4 Model B', 'BCM2711', { cost: 55 }),
  pi3bp: pi('pi3bp', 'Raspberry Pi 3 Model B+', 'BCM2837B0', { rail5vmA: 1000, cost: 35 }),
  zero2w: pi('zero2w', 'Raspberry Pi Zero 2 W', 'RP3A0', { rail3v3mA: 300, rail5vmA: 1000, cost: 15 }),
};

/** Board-picker groups, in order. */
export const FAMILY_LABEL: Record<Family, string> = {
  rp2040: 'Raspberry Pi Pico & RP2040', rp2350: 'Raspberry Pi Pico & RP2040', avr: 'Arduino', esp32: 'ESP32 & ESP8266', esp8266: 'ESP32 & ESP8266', pi: 'Raspberry Pi (Linux)',
};
/** `<option>`s for a board picker, grouped by family. */
export function boardOptions(fmt: (b: BoardDef) => string = b => b.name): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const groups = new Map<string, BoardDef[]>();
  for (const b of Object.values(BOARDS)) { const g = FAMILY_LABEL[b.family]; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(b); }
  return [...groups].map(([g, bs]) => `<optgroup label="${esc(g)}">${bs.map(b => `<option value="${b.id}">${esc(fmt(b))}</option>`).join('')}</optgroup>`).join('');
}

export const pinLabel = (b: BoardDef, g: number) => (b.label ? b.label(g) : b.pfx + g);

/** Default wiring for the thermostat kit on each board: type -> pins in role order. */
export const KIT_PRESETS: Record<string, Record<string, number[]>> = {
  picow:   { encoder: [2, 3], sht40: [4, 5], button: [6], neopixel: [7], tft: [10, 11, 12, 13], haptic: [14], buzzer: [15], relay: [16] },
  uno:     { encoder: [2, 3], button: [4], neopixel: [6], relay: [7], haptic: [8], buzzer: [5], tft: [13, 11, 9, 10], sht40: [18, 19] },
  esp32s3: { encoder: [4, 5], button: [6], neopixel: [8], sht40: [1, 2], tft: [12, 11, 13, 10], haptic: [14], buzzer: [15], relay: [16] },
  esp32c3: { encoder: [0, 1], button: [3], neopixel: [10], sht40: [5, 20], tft: [4, 6, 7, 21], haptic: [9], buzzer: [8], relay: [2] },
  pi5:     { encoder: [17, 27], button: [22], neopixel: [18], sht40: [2, 3], tft: [11, 10, 24, 8], haptic: [5], buzzer: [12], relay: [23] },
};
KIT_PRESETS.zero2w = KIT_PRESETS.pi4 = KIT_PRESETS.pi3bp = KIT_PRESETS.pi5;
KIT_PRESETS.pico2w = KIT_PRESETS.picow;
KIT_PRESETS.nano = KIT_PRESETS.promini = KIT_PRESETS.uno;

/**
 * A thermostat-kit preset for a board without a hand-made one: the SPI and I2C
 * pairs come from the board's bus tables, everything else from the free pins
 * (no boot/strapping, input-only or USB-serial pins for outputs). Small boards
 * leave the parts that don't fit unconnected.
 */
export function autoPreset(b: BoardDef): Record<string, number[]> {
  const used = new Set<number>();
  const ok = (g: number) => !used.has(g) && !b.strap.includes(g) && !(b.family === 'avr' && g < 2);
  const pair = (groups: PinGroup[] | undefined, ka: keyof PinGroup, kb: keyof PinGroup): number[] => {
    for (const gr of groups ?? []) {
      const a = gr[ka]?.find(g => ok(g) && !b.inputOnly?.includes(g)), z = gr[kb]?.find(g => ok(g) && g !== a && !b.inputOnly?.includes(g));
      if (a != null && z != null) { used.add(a); used.add(z); return [a, z]; }
    }
    return [];
  };
  const out: Record<string, number[]> = {};
  out.tft = pair(b.spi, 'sck', 'mosi');
  out.sht40 = pair(b.i2c, 'sda', 'scl');
  // pins that are best kept for analog parts go last
  const pool = () => b.gpio.filter(ok).sort((x, y) => +b.adc.includes(x) - +b.adc.includes(y));
  const take = (output: boolean) => { const g = pool().find(p => !output || !b.inputOnly?.includes(p)); if (g != null) used.add(g); return g; };
  if (!out.tft.length) { const s = take(true), m = take(true); if (s != null && m != null) out.tft = [s, m]; }
  if (!out.sht40.length) { const s = take(true), c = take(true); if (s != null && c != null) out.sht40 = [s, c]; }
  const grab = (n: number, output: boolean) => { const r: number[] = []; for (let i = 0; i < n; i++) { const g = take(output); if (g == null) return []; r.push(g); } return r; };
  out.encoder = grab(2, false);
  out.button = grab(1, false);
  out.neopixel = grab(1, true);
  const dccs = grab(2, true); if (out.tft.length && dccs.length) out.tft.push(...dccs); else out.tft = [];
  out.haptic = grab(1, true);
  out.buzzer = grab(1, true);
  out.relay = grab(1, true);
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}
for (const b of Object.values(BOARDS)) KIT_PRESETS[b.id] ??= autoPreset(b);
