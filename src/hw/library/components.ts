import type { Check, CompInstance, ComponentDef, DeviceCtx, DeviceModel, Level } from '../types';
import { EdgeMeter } from '../devices/edge';
import { WS2812Decoder } from '../devices/ws2812';
import { GC9A01Decoder } from '../devices/gc9a01';
import { SHT40 } from '../devices/sht40';
import { audio } from '../audio';

/**
 * Component library. Each entry declares its pins, power, cost, which product
 * feature it can bind to, and a device model that speaks the part's real
 * protocol (pin levels, SPI bytes, I2C transactions) to whichever runtime is
 * running. See docs/EXTENDING.md for adding parts.
 */

const ms = 1e6;

function encoder(ctx: DeviceCtx): DeviceModel {
  const state = { count: 0 };
  // A human turn takes ~10-20 ms per detent; phases are ~3 ms apart. Detents are
  // queued back-to-back in emulated time so fast drags never overlap.
  const PHASE = 3 * ms;
  let busyUntil = 0;
  const idle = () => { busyUntil = 0; ctx.setInput('CLK', 1); ctx.setInput('DT', 1); };
  const turn = (d: number) => {
    state.count += d;
    const [a, b] = d > 0 ? ['CLK', 'DT'] : ['DT', 'CLK'];
    const now = ctx.now(), start = Math.max(0, busyUntil - now);
    busyUntil = now + start + 4 * PHASE;
    const at = (t: number, fn: () => void) => (t <= 0 ? fn() : ctx.schedule(t, fn));
    at(start, () => ctx.setInput(a, 0));
    at(start + PHASE, () => ctx.setInput(b, 0));
    at(start + 2 * PHASE, () => ctx.setInput(a, 1));
    at(start + 3 * PHASE, () => ctx.setInput(b, 1));
  };
  return { state, reset: idle, sim: { turn } };
}

function button(ctx: DeviceCtx): DeviceModel {
  const state = { down: false };
  return {
    state,
    reset: () => ctx.setInput('SIG', 1),
    sim: { press: (down: boolean) => { state.down = down; ctx.setInput('SIG', down ? 0 : 1); } },
  };
}

function tft(ctx: DeviceCtx): DeviceModel {
  const dec = new GC9A01Decoder();
  const state = { mode: 'off' as 'off' | 'spi' | 'sim', commands: 0 };
  let simCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  const sim2d = (): CanvasRenderingContext2D | null => {
    if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return null; // headless
    if (!simCanvas) simCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(240, 240) : Object.assign(document.createElement('canvas'), { width: 240, height: 240 });
    return simCanvas.getContext('2d') as CanvasRenderingContext2D;
  };
  let img: ImageData | null = null;
  const paint = () => {
    const cv = ctx.isBound() && ctx.product ? ctx.product.screenCanvas() : null;
    if (!cv) return;
    const g = cv.getContext('2d') as CanvasRenderingContext2D;
    g.save(); g.imageSmoothingEnabled = true;
    if (state.mode === 'spi') {
      if (!dec.displayOn) { g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height); }
      else {
        if (!img) img = new ImageData(240, 240);
        img.data.set(dec.rgba);
        // The GC9A01 glass is natively inverted: drivers send INVON (0x21) to get normal colors.
        if (!dec.inverted) for (let i = 0; i < img.data.length; i += 4) { img.data[i] ^= 255; img.data[i + 1] ^= 255; img.data[i + 2] ^= 255; }
        const tmp = sim2d(); if (!tmp) return; tmp.putImageData(img, 0, 0);
        g.drawImage(simCanvas as any, 0, 0, cv.width, cv.height);
      }
    } else if (state.mode === 'sim' && simCanvas) {
      g.drawImage(simCanvas as any, 0, 0, cv.width, cv.height);
    }
    g.restore();
    ctx.product!.screenUpdated();
  };
  const c565 = (c: number) => `rgb(${((c >> 11) & 31) * 255 / 31 | 0},${((c >> 5) & 63) * 255 / 63 | 0},${(c & 31) * 255 / 31 | 0})`;
  let dirtySim = false;
  return {
    state,
    reset: () => { dec.reset(); state.mode = 'off'; img = null; if (simCanvas) { const g = sim2d()!; g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240); } },
    onSpi(byte) {
      if (ctx.readPin('CS') !== 0) return 0xff;
      state.mode = 'spi';
      dec.byte(byte, ctx.readPin('DC'));
      return 0xff;
    },
    frame() {
      if (state.mode === 'spi' && dec.dirty) { dec.dirty = false; state.commands = dec.commands; paint(); }
      if (state.mode === 'sim' && dirtySim) { dirtySim = false; paint(); }
    },
    sim: {
      // High-level drawing used by the behavioral runtime's gc9a01 shim.
      op(op: string, a: any[]) {
        state.mode = 'sim'; dirtySim = true;
        const g = sim2d();
        if (!g) return;
        if (op === 'fill') { g.fillStyle = c565(a[0]); g.fillRect(0, 0, 240, 240); }
        else if (op === 'rect') { g.fillStyle = c565(a[4]); g.fillRect(a[0], a[1], a[2], a[3]); }
        else if (op === 'text') {
          const [s, x, y, w, h, fg, bg] = a;
          g.fillStyle = c565(bg); g.fillRect(x, y, s.length * w, h);
          g.fillStyle = c565(fg); g.font = `bold ${h * 0.9}px "JetBrains Mono", monospace`; g.textBaseline = 'middle';
          for (let i = 0; i < s.length; i++) g.fillText(s[i], x + i * w, y + h / 2, w);
        }
      },
    },
  };
}

function neopixel(ctx: DeviceCtx): DeviceModel {
  const n = 24;
  const dec = new WS2812Decoder(n);
  const state = { pixels: null as [number, number, number][] | null, mA: 0, frames: 0 };
  const apply = (px: [number, number, number][]) => {
    state.pixels = px; state.frames++;
    state.mA = px.reduce((a, p) => a + (p[0] + p[1] + p[2]) / 255 * 20, 0) + n * 1;
    if (ctx.isBound() && ctx.product) ctx.product.setLeds(px);
  };
  dec.onFrame = apply;
  return {
    state,
    reset: () => { state.pixels = null; state.frames = 0; ctx.product?.setLeds(null); },
    onPin: (_r, level, t) => dec.edge(level, t),
    frame: () => dec.poll(ctx.now()),
    sim: { write: (flat: number[]) => { const px: [number, number, number][] = []; for (let i = 0; i < n; i++) px.push([flat[i * 3] | 0, flat[i * 3 + 1] | 0, flat[i * 3 + 2] | 0]); apply(px); } },
  };
}

function sht40(ctx: DeviceCtx): DeviceModel {
  const noise = () => (Math.random() - 0.5) * 0.04;
  const dev = new SHT40(() => ctx.env.roomC + noise(), () => ctx.env.rh + noise() * 10);
  return { state: { get measurements() { return dev.measurements; } }, i2c: dev };
}

function relay(ctx: DeviceCtx): DeviceModel {
  const state = { on: false };
  return { state, onPin: (_r, l) => { state.on = l === 1; } };
}

function haptic(ctx: DeviceCtx): DeviceModel {
  const state = { on: false };
  return { state, onPin: (_r, l) => { state.on = l === 1; if (ctx.isBound()) ctx.product?.haptic(state.on); } };
}

function buzzer(ctx: DeviceCtx): DeviceModel {
  const m = new EdgeMeter();
  const state = { freq: 0, playing: false };
  const voice = audio.voice();
  const pwm = (f: number, duty: number) => { state.freq = Math.round(f); state.playing = duty > 0.02 && duty < 0.98 && f > 20; voice.set(state.playing ? f : 0); };
  return {
    state,
    reset: () => { m.reset(); voice.set(0); },
    onPin: (_r, l, t) => m.edge(l, t),
    frame() {
      const now = ctx.now();
      const f = m.freq(now), d = m.duty(now);
      state.freq = Math.round(f);
      state.playing = f > 20 && f < 20000 && d > 0.02 && d < 0.98;
      voice.set(state.playing ? f : 0);
    },
    sim: { pwm },
  };
}

function led(ctx: DeviceCtx): DeviceModel {
  const m = new EdgeMeter();
  const state = { brightness: 0 };
  let simDuty = -1;
  return { state, reset: () => { m.reset(); simDuty = -1; }, onPin: (_r, l, t) => { simDuty = -1; m.edge(l, t); }, frame: () => { state.brightness = simDuty >= 0 ? simDuty : m.duty(ctx.now()); }, sim: { pwm: (_f: number, d: number) => { simDuty = d; } } };
}

function pot(ctx: DeviceCtx): DeviceModel {
  const state = { value: 0.5 };
  return { state, adc: () => state.value * 3.3, sim: { set: (v: number) => { state.value = v; } } };
}

function servo(ctx: DeviceCtx): DeviceModel {
  const m = new EdgeMeter();
  const state = { angle: 90, pulseMs: 0 };
  let simPulse = 0;
  return {
    state, reset: () => { m.reset(); simPulse = 0; },
    onPin: (_r, l, t) => { simPulse = 0; m.edge(l, t); },
    sim: { pwm: (f: number, d: number) => { simPulse = f > 0 ? (d / f) * 1000 : 0; } },
    frame() {
      const p = simPulse || m.pulseMs(ctx.now());
      state.pulseMs = p;
      if (p > 0.3 && p < 2.8) state.angle = Math.max(0, Math.min(180, ((p - 0.5) / 2) * 180));
    },
  };
}

const level5vNote = (c: CompInstance, x: { board: { logicV: number; name: string } }, part: string): Check[] =>
  x.board.logicV === 5 ? [{ level: 'warn', uid: c.uid, msg: `${part} is a 3.3 V part on a 5 V board. Use a breakout with level shifting, or add a shifter.` }] : [];

export const COMPONENTS: Record<string, ComponentDef> = {
  encoder: {
    id: 'encoder', name: 'Rotary encoder EC11', category: 'input', ui: 'encoder',
    roles: [{ id: 'CLK', kind: 'digital-in' }, { id: 'DT', kind: 'digital-in' }],
    binds: 'dial', bindLabel: 'Dial ring', rail: '3v3', mA: 0.5, cost: 0.6, create: encoder,
    note: '20 detents/rev, one full quadrature cycle per detent (3 ms phases), module pull-ups.',
  },
  button: {
    id: 'button', name: 'Push button (to GND)', category: 'input', ui: 'button',
    roles: [{ id: 'SIG', kind: 'digital-in' }], binds: 'press', bindLabel: 'Display press', rail: null, mA: 0, cost: 0.12, create: button,
    note: 'Pulls the line to GND when pressed. Needs a pull-up when released.',
  },
  tft: {
    id: 'tft', name: 'GC9A01 1.28" round LCD', category: 'display', ui: 'screen',
    roles: [{ id: 'SCK', kind: 'spi-sck' }, { id: 'MOSI', kind: 'spi-mosi' }, { id: 'DC', kind: 'digital-out' }, { id: 'CS', kind: 'digital-out' }],
    binds: 'screen', bindLabel: 'Product screen', rail: '3v3', mA: 25, cost: 3.9, logic: 3.3, create: tft,
    note: 'Decodes the GC9A01 SPI command set (CASET/RASET/RAMWR, RGB565).',
    checks: (c, x) => level5vNote(c, x, 'GC9A01'),
  },
  neopixel: {
    id: 'neopixel', name: 'NeoPixel ring ×24 (WS2812B)', category: 'output', ui: 'ring',
    roles: [{ id: 'DIN', kind: 'data' }], binds: 'ledRing', bindLabel: 'LED light ring', rail: '5v', mA: 24, peakmA: 1440, cost: 4.5, logic: 5, create: neopixel,
    note: 'Decodes WS2812 timing from pin edges (800 kHz, GRB).',
    checks: (c, x) => [
      { level: 'warn', uid: c.uid, msg: 'At full white the NeoPixel ring draws ~1.4 A. Use a 5 V 2 A supply or cap brightness.' },
      ...(x.board.logicV === 3.3 ? [{ level: 'warn' as const, uid: c.uid, msg: 'WS2812 on 5 V may not read 3.3 V data reliably. Add a 74AHCT125 level shifter.' }] : []),
      ...(x.board.id === 'zero2w' && ![10, 12, 18, 21].includes(c.pins.DIN as number) ? [{ level: 'err' as const, uid: c.uid, msg: 'On Pi Zero, NeoPixel data must be on GPIO 10, 12, 18 or 21.' }] : []),
      ...(x.board.id === 'pi5' ? [{ level: 'warn' as const, uid: c.uid, msg: 'Pi 5 needs the Pi 5-specific NeoPixel driver. rpi_ws281x does not work there.' }] : []),
    ],
  },
  sht40: {
    id: 'sht40', name: 'SHT40 temp / RH (I2C)', category: 'sensor', ui: 'sensor',
    roles: [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }],
    binds: 'ambient', bindLabel: 'Room temperature', rail: '3v3', mA: 0.5, cost: 1.1, i2cAddress: 0x44, logic: 3.3, create: sht40,
    note: 'I2C 0x44. Measure 0xFD, 6-byte reply with CRC-8.',
    checks: (c, x) => level5vNote(c, x, 'SHT40'),
  },
  relay: {
    id: 'relay', name: 'Relay module (HVAC call)', category: 'actuator', ui: 'relay',
    roles: [{ id: 'IN', kind: 'digital-out' }], binds: 'heater', bindLabel: 'Heating call', rail: '5v', mA: 70, cost: 1.2, create: relay,
    note: 'Active-high input. Many cheap modules are active-low, so check yours.',
  },
  haptic: {
    id: 'haptic', name: 'Haptic motor + driver', category: 'actuator', ui: 'haptic',
    roles: [{ id: 'EN', kind: 'digital-out' }], binds: 'haptic', bindLabel: 'Haptic', rail: '5v', mA: 80, cost: 0.9, create: haptic,
  },
  buzzer: {
    id: 'buzzer', name: 'Passive piezo buzzer', category: 'output', ui: 'buzzer',
    roles: [{ id: 'SIG', kind: 'pwm' }], rail: null, mA: 5, drivemA: 5, cost: 0.25, create: buzzer,
    note: 'Needs a PWM square wave. A steady HIGH is silent.',
  },
  led: {
    id: 'led', name: 'LED + 220 Ω', category: 'output', ui: 'led',
    roles: [{ id: 'SIG', kind: 'digital-out' }], rail: null, mA: 10, drivemA: 10, cost: 0.05, create: led,
  },
  pot: {
    id: 'pot', name: 'Potentiometer 10 kΩ', category: 'input', ui: 'pot',
    roles: [{ id: 'WIPER', kind: 'analog' }], rail: '3v3', mA: 0.3, cost: 0.3, create: pot,
  },
  servo: {
    id: 'servo', name: 'SG90 micro servo', category: 'actuator', ui: 'servo',
    roles: [{ id: 'PWM', kind: 'pwm' }], rail: '5v', mA: 250, peakmA: 650, cost: 1.6, create: servo,
    note: '50 Hz, 0.5–2.5 ms pulse = 0–180°.',
    checks: c => [{ level: 'warn', uid: c.uid, msg: 'SG90 stall current is ~650 mA. Power it from the 5 V supply, not a GPIO or 3V3 pin.' }],
  },
};

export const KIT = ['encoder', 'button', 'tft', 'neopixel', 'sht40', 'relay', 'haptic', 'buzzer'];
export type { Level };
