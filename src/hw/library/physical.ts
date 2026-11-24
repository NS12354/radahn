/**
 * Physical sizes (mm) of boards and parts, used by auto build to lay out an
 * enclosure. Board coordinates are relative to the board centre with the
 * component side facing the front (+Z), long edge along X.
 * Sources: vendor datasheets / mechanical drawings, rounded to 0.1 mm.
 */
export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface PortPhys { kind: string; side: Side; /** along the edge, from the board centre */ offset: number; w: number; h: number }
export interface BoardPhys { w: number; h: number; t: number; /** tallest part above the PCB */ top: number; holes: [number, number][]; ports: PortPhys[]; chip: number; hot?: boolean }

const corners = (w: number, h: number, inset: number): [number, number][] => [[-w / 2 + inset, -h / 2 + inset], [w / 2 - inset, -h / 2 + inset], [-w / 2 + inset, h / 2 - inset], [w / 2 - inset, h / 2 - inset]];

export const BOARD_PHYS: Record<string, BoardPhys> = {
  picow: { w: 51, h: 21, t: 1, top: 3.2, holes: [[-23.5, -5.7], [23.5, -5.7], [-23.5, 5.7], [23.5, 5.7]], ports: [{ kind: 'Micro-USB', side: 'left', offset: 0, w: 8, h: 3 }], chip: 7 },
  uno: { w: 68.6, h: 53.3, t: 1.6, top: 11, holes: [[-20.3, -24.1], [-19, 24.1], [31.8, -19], [31.8, 8.9]], ports: [{ kind: 'USB-B', side: 'left', offset: 11.4, w: 12, h: 11 }, { kind: 'DC jack', side: 'left', offset: -19, w: 9, h: 11 }], chip: 9 },
  esp32s3: { w: 69, h: 26, t: 1.6, top: 3.5, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 6, w: 9, h: 3.3 }, { kind: 'USB-C', side: 'left', offset: -6, w: 9, h: 3.3 }], chip: 18 },
  esp32c3: { w: 22.5, h: 18, t: 1, top: 3.3, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 5 },
  pi5: { w: 85, h: 56, t: 1.4, top: 16, holes: [[-39, -24.5], [19, -24.5], [-39, 24.5], [19, 24.5]], ports: [{ kind: 'USB-C', side: 'bottom', offset: -31.4, w: 9, h: 3.3 }, { kind: 'micro-HDMI', side: 'bottom', offset: -16.5, w: 7, h: 3.5 }, { kind: 'micro-HDMI', side: 'bottom', offset: -3.3, w: 7, h: 3.5 }, { kind: 'USB / Ethernet', side: 'right', offset: 0, w: 52, h: 16 }], chip: 15, hot: true },
  zero2w: { w: 65, h: 30, t: 1, top: 5, holes: corners(65, 30, 3.5), ports: [{ kind: 'mini-HDMI', side: 'bottom', offset: -20.1, w: 11.2, h: 3.5 }, { kind: 'micro-USB', side: 'bottom', offset: 9.9, w: 8, h: 3 }, { kind: 'micro-USB (power)', side: 'bottom', offset: 22.5, w: 8, h: 3 }], chip: 12 },
  // Raspberry Pi Pico & RP2040
  pico2w: { w: 51, h: 21, t: 1, top: 3.2, holes: [[-23.5, -5.7], [23.5, -5.7], [-23.5, 5.7], [23.5, 5.7]], ports: [{ kind: 'Micro-USB', side: 'left', offset: 0, w: 8, h: 3 }], chip: 7 },
  xiao2040: { w: 21, h: 17.5, t: 1, top: 3.3, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 7 },
  qtpy2040: { w: 21.8, h: 17.8, t: 1, top: 3.3, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 7 },
  feather2040: { w: 50.8, h: 22.8, t: 1.6, top: 5.5, holes: [[-22.9, -8.9], [22.9, -8.9], [-22.9, 8.9], [22.9, 8.9]], ports: [{ kind: 'USB-C', side: 'left', offset: 4, w: 9, h: 3.3 }, { kind: 'JST battery', side: 'left', offset: -6.5, w: 7, h: 6 }], chip: 7 },
  rp2040zero: { w: 23.5, h: 18, t: 1, top: 3.3, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 7 },
  // Arduino
  nano: { w: 45, h: 18, t: 1.6, top: 4.5, holes: [[-20.3, -7.6], [20.3, -7.6], [-20.3, 7.6], [20.3, 7.6]], ports: [{ kind: 'Mini-USB', side: 'left', offset: 0, w: 8, h: 4 }], chip: 7 },
  promini: { w: 33, h: 18, t: 1.6, top: 2.5, holes: [], ports: [{ kind: 'FTDI header', side: 'left', offset: 0, w: 15, h: 3 }], chip: 7 },
  // ESP32 & ESP8266
  esp32: { w: 55, h: 28, t: 1.6, top: 3.5, holes: [], ports: [{ kind: 'Micro-USB', side: 'left', offset: 0, w: 8, h: 3 }], chip: 18 },
  xiaos3: { w: 21, h: 17.5, t: 1, top: 3.5, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 10 },
  nanoesp32: { w: 45, h: 18, t: 1.6, top: 3.5, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 10 },
  esp32c6: { w: 53, h: 26, t: 1.6, top: 3.5, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 6, w: 9, h: 3.3 }, { kind: 'USB-C', side: 'left', offset: -6, w: 9, h: 3.3 }], chip: 18 },
  esp32s2: { w: 34.3, h: 25.4, t: 1, top: 3.5, holes: [], ports: [{ kind: 'USB-C', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 15 },
  esp8266: { w: 48, h: 26, t: 1.6, top: 3.5, holes: [[-21.5, -10.5], [21.5, -10.5], [-21.5, 10.5], [21.5, 10.5]], ports: [{ kind: 'Micro-USB', side: 'left', offset: 0, w: 8, h: 3 }], chip: 15 },
  d1mini: { w: 34.2, h: 25.6, t: 1, top: 3.5, holes: [], ports: [{ kind: 'Micro-USB', side: 'left', offset: 0, w: 8, h: 3 }], chip: 12 },
  // Raspberry Pi
  pi4: { w: 85, h: 56, t: 1.4, top: 16, holes: [[-39, -24.5], [19, -24.5], [-39, 24.5], [19, 24.5]], ports: [{ kind: 'USB-C', side: 'bottom', offset: -31.4, w: 9, h: 3.3 }, { kind: 'micro-HDMI', side: 'bottom', offset: -16.5, w: 7, h: 3.5 }, { kind: 'micro-HDMI', side: 'bottom', offset: -3.3, w: 7, h: 3.5 }, { kind: 'USB / Ethernet', side: 'right', offset: 0, w: 52, h: 16 }], chip: 15, hot: true },
  pi3bp: { w: 85, h: 56, t: 1.4, top: 16, holes: [[-39, -24.5], [19, -24.5], [-39, 24.5], [19, 24.5]], ports: [{ kind: 'Micro-USB', side: 'bottom', offset: -31.9, w: 8, h: 3 }, { kind: 'HDMI', side: 'bottom', offset: -10.5, w: 15, h: 6 }, { kind: 'USB / Ethernet', side: 'right', offset: 0, w: 52, h: 16 }], chip: 14, hot: true },
};
export const boardPhys = (id: string): BoardPhys => BOARD_PHYS[id] ?? { w: 50, h: 25, t: 1.6, top: 4, holes: corners(50, 25, 3), ports: [{ kind: 'USB', side: 'left', offset: 0, w: 9, h: 3.3 }], chip: 8 };

/** Body of a part inside the enclosure, and how it surfaces on the outside. */
export interface PartPhys {
  body: { shape: 'box' | 'cyl' | 'tube'; w: number; h: number; d: number; inner?: number; color: string };
  /** What auto build makes for it on the product's surface. */
  surface: 'display' | 'ring' | 'knob' | 'button' | 'pot' | 'indicator' | 'sound' | 'vents' | 'horn' | 'wires' | 'none';
  pixels?: number;
  /** Visible display diameter. */
  active?: number;
  /** Visible area of a rectangular display, w × h. */
  window?: [number, number];
}

export const PART_PHYS: Record<string, PartPhys> = {
  tft: { body: { shape: 'cyl', w: 39, h: 39, d: 3.5, color: '#1b1f27' }, surface: 'display', active: 32.4 },
  neopixel: { body: { shape: 'tube', w: 65.6, h: 65.6, d: 1.6, inner: 52.3, color: '#16181c' }, surface: 'ring', pixels: 24 },
  encoder: { body: { shape: 'box', w: 12.4, h: 13.2, d: 6.5, color: '#3a3d42' }, surface: 'knob' },
  button: { body: { shape: 'box', w: 6, h: 6, d: 4.3, color: '#2b2f36' }, surface: 'button' },
  pot: { body: { shape: 'box', w: 9.8, h: 11, d: 9, color: '#2b4a8a' }, surface: 'pot' },
  led: { body: { shape: 'cyl', w: 5, h: 5, d: 8.6, color: '#d8e0ea' }, surface: 'indicator' },
  buzzer: { body: { shape: 'cyl', w: 12, h: 12, d: 9.5, color: '#1d1f23' }, surface: 'sound' },
  sht40: { body: { shape: 'box', w: 18, h: 13, d: 2, color: '#1f7a4a' }, surface: 'vents' },
  relay: { body: { shape: 'box', w: 34, h: 26, d: 19, color: '#2b4a8a' }, surface: 'wires' },
  haptic: { body: { shape: 'box', w: 18, h: 13, d: 4, color: '#8a8f99' }, surface: 'none' },
  servo: { body: { shape: 'box', w: 32.5, h: 12.2, d: 23, color: '#1c4fa1' }, surface: 'horn' },
  // the wider catalog
  oled: { body: { shape: 'box', w: 27.3, h: 27.8, d: 3.7, color: '#1b3f8a' }, surface: 'display', window: [21.7, 10.9] },
  lcd1602: { body: { shape: 'box', w: 80, h: 36, d: 20, color: '#1f6f3a' }, surface: 'display', window: [64.5, 16.4] },
  tm1637: { body: { shape: 'box', w: 42, h: 24, d: 12, color: '#1b3f8a' }, surface: 'display', window: [30, 14] },
  switch: { body: { shape: 'box', w: 12, h: 6, d: 6, color: '#2b2f36' }, surface: 'button' },
  touch: { body: { shape: 'box', w: 15, h: 11, d: 1.6, color: '#c33' }, surface: 'button' },
  limit: { body: { shape: 'box', w: 20, h: 10, d: 6.4, color: '#2b2f36' }, surface: 'none' },
  joystick: { body: { shape: 'box', w: 34, h: 26, d: 32, color: '#1f2228' }, surface: 'knob' },
  slidepot: { body: { shape: 'box', w: 75, h: 9, d: 8, color: '#2b2f36' }, surface: 'pot' },
  ldr: { body: { shape: 'cyl', w: 5, h: 5, d: 2, color: '#d9a441' }, surface: 'indicator' },
  bh1750: { body: { shape: 'box', w: 19, h: 14, d: 3, color: '#1b3f8a' }, surface: 'indicator' },
  pir: { body: { shape: 'box', w: 32, h: 24, d: 26, color: '#2e7d32' }, surface: 'vents' },
  hcsr04: { body: { shape: 'box', w: 45, h: 20, d: 15, color: '#1b3f8a' }, surface: 'none' },
  gas: { body: { shape: 'cyl', w: 20, h: 20, d: 16, color: '#b0b4bc' }, surface: 'vents' },
  tmp36: { body: { shape: 'box', w: 5, h: 5, d: 4, color: '#111' }, surface: 'vents' },
  aht20: { body: { shape: 'box', w: 16, h: 11, d: 2, color: '#1f2a44' }, surface: 'vents' },
  mpu6050: { body: { shape: 'box', w: 21, h: 16, d: 3, color: '#1b3f8a' }, surface: 'none' },
  rgbled: { body: { shape: 'cyl', w: 5, h: 5, d: 8.6, color: '#f4f4f4' }, surface: 'indicator' },
  led_green: { body: { shape: 'cyl', w: 5, h: 5, d: 8.6, color: '#bfffd0' }, surface: 'indicator' },
  led_blue: { body: { shape: 'cyl', w: 5, h: 5, d: 8.6, color: '#c8dcff' }, surface: 'indicator' },
  led_yellow: { body: { shape: 'cyl', w: 5, h: 5, d: 8.6, color: '#fff1bf' }, surface: 'indicator' },
  led_white: { body: { shape: 'cyl', w: 5, h: 5, d: 8.6, color: '#f4f8ff' }, surface: 'indicator' },
  motor: { body: { shape: 'cyl', w: 24, h: 24, d: 30, color: '#b0b4bc' }, surface: 'none' },
  fan: { body: { shape: 'box', w: 40, h: 40, d: 10, color: '#1f2228' }, surface: 'vents' },
  pump: { body: { shape: 'cyl', w: 24, h: 24, d: 45, color: '#1f2228' }, surface: 'wires' },
  solenoid: { body: { shape: 'box', w: 54, h: 41, d: 28, color: '#b0b4bc' }, surface: 'none' },
  stepper: { body: { shape: 'cyl', w: 28, h: 28, d: 19, color: '#b0b4bc' }, surface: 'horn' },
  soil: { body: { shape: 'box', w: 23, h: 98, d: 1.6, color: '#111' }, surface: 'wires' },
};
export const partPhys = (type: string): PartPhys => PART_PHYS[type] ?? { body: { shape: 'box', w: 15, h: 15, d: 5, color: '#4a4d55' }, surface: 'none' };

export const BATTERY = { name: 'LiPo 1200 mAh', w: 50, h: 34, d: 6, color: '#8a8f99' };
