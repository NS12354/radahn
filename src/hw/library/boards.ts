import type { BoardDef } from '../types';

const rng = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/**
 * Board library. To add a board, append a BoardDef here and (if it needs a new
 * runtime) register the runtime in src/hw/runtimes/index.ts. See docs/EXTENDING.md.
 */
export const BOARDS: Record<string, BoardDef> = {
  picow: {
    id: 'picow', name: 'Raspberry Pi Pico / Pico W', chip: 'RP2040', family: 'rp2040',
    runtime: 'rp2040-emu', lang: 'micropython', fidelity: 'emulated', pfx: 'GP',
    gpio: [...rng(0, 22), 26, 27, 28], adc: [26, 27, 28], strap: [],
    spi: [{ sck: [2, 6, 18, 22], mosi: [3, 7, 19] }, { sck: [10, 14, 26], mosi: [11, 15, 27] }],
    i2c: [{ sda: [0, 4, 8, 12, 16, 20], scl: [1, 5, 9, 13, 17, 21] }, { sda: [2, 6, 10, 14, 18, 26], scl: [3, 7, 11, 15, 19, 27] }],
    hwPwm: [...rng(0, 22), 26, 27, 28],
    pinMaxmA: 12, pinRecmA: 8, rail3v3mA: 300, rail5vmA: 500, logicV: 3.3, cost: 6, pcb: '#1f4d34',
    notes: 'Runs the real MicroPython v1.24.1 firmware on an emulated RP2040 (rp2040js).',
  },
  uno: {
    id: 'uno', name: 'Arduino Uno R3', chip: 'ATmega328P', family: 'avr',
    runtime: 'avr-emu', lang: 'arduino', fidelity: 'emulated', pfx: 'D',
    gpio: rng(0, 19), adc: rng(14, 19), strap: [],
    label: g => (g < 14 ? 'D' + g : 'A' + (g - 14)),
    spi: [{ sck: [13], mosi: [11] }], i2c: [{ sda: [18], scl: [19] }], hwPwm: [3, 5, 6, 9, 10, 11],
    pinMaxmA: 40, pinRecmA: 20, rail3v3mA: 150, rail5vmA: 500, logicV: 5, cost: 27, pcb: '#1b5e8c',
    notes: 'Runs compiled Arduino C++ (avr-gcc) on an emulated ATmega328P (avr8js).',
  },
  esp32s3: {
    id: 'esp32s3', name: 'ESP32-S3 DevKitC-1', chip: 'ESP32-S3', family: 'esp32',
    runtime: 'sim-python', lang: 'micropython', fidelity: 'behavioral', pfx: 'GPIO',
    gpio: [0, ...rng(1, 18), 21, 38, 39, 40, 41, 42, 45, 46, 47, 48], adc: rng(1, 10), adc2: rng(11, 18), strap: [0, 3, 45, 46],
    pinMaxmA: 40, pinRecmA: 20, rail3v3mA: 500, rail5vmA: 500, logicV: 3.3, cost: 9, pcb: '#1d2733',
    notes: 'Behavioral MicroPython simulation. Use "Physical board" to run on a real ESP32 over USB.',
  },
  esp32c3: {
    id: 'esp32c3', name: 'ESP32-C3 SuperMini', chip: 'ESP32-C3', family: 'esp32',
    runtime: 'sim-python', lang: 'micropython', fidelity: 'behavioral', pfx: 'GPIO',
    gpio: [...rng(0, 10), 20, 21], adc: rng(0, 4), strap: [2, 8, 9],
    pinMaxmA: 40, pinRecmA: 20, rail3v3mA: 500, rail5vmA: 500, logicV: 3.3, cost: 3, pcb: '#1d2733',
  },
  pi5: {
    id: 'pi5', name: 'Raspberry Pi 5', chip: 'BCM2712', family: 'pi',
    runtime: 'sim-python', lang: 'python', fidelity: 'behavioral', pfx: 'GPIO',
    gpio: rng(2, 27), adc: [], strap: [],
    spi: [{ sck: [11], mosi: [10] }], i2c: [{ sda: [2], scl: [3] }], hwPwm: [12, 13, 18, 19],
    pinMaxmA: 16, pinRecmA: 8, rail3v3mA: 500, rail5vmA: 1600, logicV: 3.3, cost: 60, pcb: '#1f4d34',
    notes: 'Behavioral simulation of Python 3 + gpiozero + smbus2.',
  },
  zero2w: {
    id: 'zero2w', name: 'Raspberry Pi Zero 2 W', chip: 'RP3A0', family: 'pi',
    runtime: 'sim-python', lang: 'python', fidelity: 'behavioral', pfx: 'GPIO',
    gpio: rng(2, 27), adc: [], strap: [],
    spi: [{ sck: [11], mosi: [10] }], i2c: [{ sda: [2], scl: [3] }], hwPwm: [12, 13, 18, 19],
    pinMaxmA: 16, pinRecmA: 8, rail3v3mA: 300, rail5vmA: 1000, logicV: 3.3, cost: 15, pcb: '#1f4d34',
  },
};

export const pinLabel = (b: BoardDef, g: number) => (b.label ? b.label(g) : b.pfx + g);

/** Default wiring for the thermostat kit on each board: type -> pins in role order. */
export const KIT_PRESETS: Record<string, Record<string, number[]>> = {
  picow:   { encoder: [2, 3], sht40: [4, 5], button: [6], neopixel: [7], tft: [10, 11, 12, 13], haptic: [14], buzzer: [15], relay: [16] },
  uno:     { encoder: [2, 3], button: [4], neopixel: [6], relay: [7], haptic: [8], buzzer: [5], tft: [13, 11, 9, 10], sht40: [18, 19] },
  esp32s3: { encoder: [4, 5], button: [6], neopixel: [8], sht40: [1, 2], tft: [12, 11, 13, 10], haptic: [14], buzzer: [15], relay: [16] },
  esp32c3: { encoder: [0, 1], button: [3], neopixel: [10], sht40: [5, 20], tft: [4, 6, 7, 21], haptic: [9], buzzer: [8], relay: [2] },
  pi5:     { encoder: [17, 27], button: [22], neopixel: [18], sht40: [2, 3], tft: [11, 10, 24, 8], haptic: [5], buzzer: [12], relay: [23] },
};
KIT_PRESETS.zero2w = KIT_PRESETS.pi5;
