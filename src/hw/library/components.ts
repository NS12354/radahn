import type { Check, CompInstance, ComponentDef, DeviceCtx, DeviceModel, I2CTarget, Level } from '../types';
import { EdgeMeter } from '../devices/edge';
import { WS2812Decoder } from '../devices/ws2812';
import { GC9A01Decoder } from '../devices/gc9a01';
import { SHT40 } from '../devices/sht40';
import { audio } from '../audio';
import { SSD1306, LCD1602, TM1637, MPU6050, AHT20, BH1750, Stepper, makeCanvas, paintInto } from '../devices/parts';

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

function led_(ctx: DeviceCtx): DeviceModel {
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
    roles: [{ id: 'SIG', kind: 'digital-out' }], rail: null, mA: 10, drivemA: 10, cost: 0.05, create: led_,
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


// ------------------------------------------------------------------ the wider catalog
/** A digital input part: idle level, pulled to its active level while "pressed" (button) or "on" (switch, motion…). */
function digitalIn(activeHigh: boolean) {
  return (ctx: DeviceCtx): DeviceModel => {
    const state = { down: false };
    return { state, reset: () => { state.down = false; ctx.setInput('SIG', activeHigh ? 0 : 1); }, sim: { press: (down: boolean) => { state.down = down; ctx.setInput('SIG', (down === activeHigh ? 1 : 0) as Level); } } };
  };
}
/** An analog sensor with a slider in physical units (def.reading). */
function meter(ctx: DeviceCtx): DeviceModel {
  const r = ctx.def.reading!;
  const state = { x: r.dflt };
  const volts = r.volts ?? ((x: number, v: number) => ((x - r.min) / (r.max - r.min)) * v);
  return { state, adc: () => Math.max(0, Math.min(ctx.logicV, volts(state.x, ctx.logicV) + (Math.random() - 0.5) * 0.004)), sim: { set: (x: number) => { state.x = x; } } };
}
function tmp36(ctx: DeviceCtx): DeviceModel {
  return { state: {}, adc: () => 0.5 + 0.01 * (ctx.env.roomC + (Math.random() - 0.5) * 0.1) };
}
function joystick(ctx: DeviceCtx): DeviceModel {
  const state = { x: 0, y: 0, down: false };
  return {
    state, reset: () => { state.down = false; ctx.setInput('SW', 1); },
    adc: role => ((role === 'VRX' ? state.x : state.y) * 0.5 + 0.5) * ctx.logicV,
    sim: { set: (x: number, y: number) => { state.x = x; state.y = y; }, press: (d: boolean) => { state.down = d; ctx.setInput('SW', d ? 0 : 1); } },
  };
}
function rgbLed(ctx: DeviceCtx): DeviceModel {
  const m: Record<string, EdgeMeter> = { R: new EdgeMeter(), G: new EdgeMeter(), B: new EdgeMeter() };
  const simD: Record<string, number> = { R: -1, G: -1, B: -1 };
  const state = { r: 0, g: 0, b: 0 };
  return {
    state, reset: () => { for (const k in m) { m[k].reset(); simD[k] = -1; } },
    onPin: (role, l, t) => { simD[role] = -1; m[role]?.edge(l, t); },
    sim: { pwm: (_f: number, d: number, role?: string) => { if (role) simD[role] = d; } },
    frame: () => { const now = ctx.now(); const v = (k: string) => (simD[k] >= 0 ? simD[k] : m[k].duty(now)); state.r = v('R'); state.g = v('G'); state.b = v('B'); },
  };
}
/** A motor (or fan, pump) on a driver: speed from PWM duty; two inputs = H-bridge direction. */
function motor(ctx: DeviceCtx): DeviceModel {
  const roles = ctx.def.roles.map(r => r.id);
  const m = new Map(roles.map(r => [r, new EdgeMeter()]));
  const simD = new Map<string, number>(roles.map(r => [r, -1]));
  const state = { speed: 0, on: false, turns: 0 };
  return {
    state, reset: () => { for (const r of roles) { m.get(r)!.reset(); simD.set(r, -1); } state.speed = 0; },
    onPin: (role, l, t) => { simD.set(role, -1); m.get(role)?.edge(l, t); },
    sim: { pwm: (_f: number, d: number, role?: string) => { simD.set(role ?? roles[0], d); } },
    frame: dt => {
      const now = ctx.now(), d = (r: string) => { const s = simD.get(r)!; return s >= 0 ? s : m.get(r)!.duty(now); };
      const target = roles.length > 1 ? d(roles[0]) - d(roles[1]) : d(roles[0]);
      state.speed += (target - state.speed) * Math.min(1, dt * 6); // spin-up inertia
      state.on = Math.abs(state.speed) > 0.05; state.turns += state.speed * dt * 2;
    },
  };
}
function stepper(ctx: DeviceCtx): DeviceModel {
  const s = new Stepper();
  const state = { get steps() { return s.steps; }, get angle() { return s.angle; } };
  return { state, reset: () => s.reset(), onPin: (role, l, t) => s.pin(+role.slice(2) - 1, l, t) };
}
function hcsr04(ctx: DeviceCtx): DeviceModel {
  const state = { cm: 50, pings: 0 };
  let up = -1;
  const echoUs = () => Math.max(2, Math.min(400, state.cm)) * 58.3 + (Math.random() - 0.5) * 20;
  return {
    state,
    reset: () => { up = -1; ctx.setInput('ECHO', 0); },
    onPin: (role, l, t) => {
      if (role !== 'TRIG') return;
      if (l) { up = t; return; }
      if (up < 0) return;
      const width = t - up; up = -1;
      if (width < 5e3) return; // needs a ≥10 µs trigger pulse (accept ≥5)
      state.pings++;
      const us = echoUs();
      ctx.schedule(450e3, () => { ctx.setInput('ECHO', 1); ctx.schedule(us * 1e3, () => ctx.setInput('ECHO', 0)); });
    },
    sim: { echoUs: () => { state.pings++; return echoUs(); } },
  };
}
/** A display with its own picture: decoder → native canvas → product screen when bound. */
function display(dev: { reset(): void; draw(cv: any): void; dirty: boolean } & Partial<I2CTarget>, w: number, h: number, extra: (st: any) => void = () => {}) {
  return (ctx: DeviceCtx): DeviceModel => {
    const cv = makeCanvas(w, h);
    const state: Record<string, any> = { active: false };
    const paint = () => {
      if (!cv) return;
      dev.draw(cv);
      const scr = ctx.isBound() && ctx.product ? ctx.product.screenCanvas() : null;
      if (scr) { paintInto(scr, cv); ctx.product!.screenUpdated(); }
    };
    return {
      state, view: () => cv,
      i2c: dev.address != null ? (dev as I2CTarget) : undefined,
      reset: () => { dev.reset(); dev.dirty = true; state.active = false; },
      frame: () => { extra(state); if (dev.dirty) { dev.dirty = false; state.active = true; paint(); } },
    };
  };
}
const oled = (ctx: DeviceCtx) => { const d = new SSD1306(ctx.comp.props?.address ?? 0x3c); return display(d, 128, 64, st => { st.bytes = d.bytes; st.on = d.on; })(ctx); };
const lcd = (ctx: DeviceCtx) => { const d = new LCD1602(ctx.comp.props?.address ?? 0x27); return display(d, 208, 52, st => { st.rows = [d.row(0), d.row(1)]; st.on = d.on; })(ctx); };
function tm1637(ctx: DeviceCtx): DeviceModel {
  const d = new TM1637();
  const m = display(d, 166, 76, st => { st.text = d.text(); st.on = d.on; })(ctx);
  return { ...m, i2c: undefined, onPin: (role, l) => d.edge(role as 'CLK' | 'DIO', l) };
}
function mpu6050(ctx: DeviceCtx): DeviceModel {
  const dev = new MPU6050(() => ctx.env.roomC);
  let lp = 0, lr = 0;
  const state = { pitch: 0, roll: 0, get reads() { return dev.reads; } };
  return {
    state, i2c: dev, reset: () => dev.reset(),
    sim: { tilt: (p: number, r: number) => { state.pitch = p; state.roll = r; } },
    frame: dt => {
      if (dt <= 0) return;
      dev.gyro = [(state.roll - lr) / dt, (state.pitch - lp) / dt, 0].map(v => Math.max(-250, Math.min(250, v))) as [number, number, number];
      lr = state.roll; lp = state.pitch; dev.pitch = state.pitch; dev.roll = state.roll;
    },
  };
}
function aht20(ctx: DeviceCtx): DeviceModel {
  const n = () => (Math.random() - 0.5) * 0.04;
  const dev = new AHT20(() => ctx.env.roomC + n(), () => ctx.env.rh + n() * 10);
  return { state: { get measurements() { return dev.measurements; } }, i2c: dev };
}
function bh1750(ctx: DeviceCtx): DeviceModel {
  const state = { x: ctx.def.reading!.dflt };
  return { state, i2c: new BH1750(() => state.x * (1 + (Math.random() - 0.5) * 0.01)), sim: { set: (x: number) => { state.x = x; } } };
}

const fiveVSensorOn3v3 = (part: string) => (c: CompInstance, x: { board: { logicV: number } }): Check[] =>
  x.board.logicV === 3.3 ? [{ level: 'warn', uid: c.uid, msg: `${part} runs on 5 V and its output can reach 5 V. Use a voltage divider (or a 3.3 V version) on a 3.3 V board.` }] : [];
const led = (id: string, name: string, tint: string, cost = 0.05): ComponentDef => ({
  id, name, category: 'output', ui: 'led', tint, roles: [{ id: 'SIG', kind: 'digital-out' }], rail: null, mA: 10, drivemA: 10, cost, create: led_,
});
const DIN = (id = 'SIG') => [{ id, kind: 'digital-in' as const }];

export const MORE: Record<string, ComponentDef> = {
  // ---------------------------------------------------------------- inputs
  switch: { id: 'switch', name: 'Slide switch (to GND)', category: 'input', ui: 'toggle', roles: DIN(), rail: null, mA: 0, cost: 0.15, create: digitalIn(false), note: 'Connects the pin to GND when on. Use a pull-up.' },
  limit: { id: 'limit', name: 'Limit switch (microswitch)', category: 'input', ui: 'button', roles: DIN(), rail: null, mA: 0, cost: 0.4, create: digitalIn(false), note: 'Normally-open contact to GND. Use a pull-up.' },
  touch: { id: 'touch', name: 'Touch sensor TTP223', category: 'input', ui: 'button', roles: DIN(), rail: '3v3', mA: 2, cost: 0.3, create: digitalIn(true), note: 'Output goes HIGH while touched (default mode).' },
  pir: { id: 'pir', name: 'PIR motion sensor HC-SR501', category: 'sensor', ui: 'toggle', onText: 'motion', roles: DIN('OUT'), rail: '5v', mA: 0.1, cost: 1.2, create: ctx => { const m = digitalIn(true)({ ...ctx, setInput: (_r, l) => ctx.setInput('OUT', l) }); return m; }, note: 'OUT goes HIGH (3.3 V) while it sees motion, then holds for the delay set on its pot.' },
  tilt: { id: 'tilt', name: 'Tilt switch SW-520D', category: 'sensor', ui: 'toggle', onText: 'tilted', roles: DIN(), rail: null, mA: 0, cost: 0.2, create: digitalIn(false), note: 'Ball switch to GND: closed when upright, open when tilted past ~45°. Here "on" = tilted (reads HIGH with a pull-up).' },
  reed: { id: 'reed', name: 'Reed switch (magnet)', category: 'sensor', ui: 'toggle', onText: 'magnet near', roles: DIN(), rail: null, mA: 0, cost: 0.3, create: digitalIn(false), note: 'Closes to GND when a magnet is near. Use a pull-up. Great for door/lid sensors.' },
  irsensor: { id: 'irsensor', name: 'IR obstacle sensor', category: 'sensor', ui: 'toggle', onText: 'obstacle', roles: DIN('OUT'), rail: '3v3', mA: 20, cost: 0.6, create: ctx => digitalIn(false)({ ...ctx, setInput: (_r, l) => ctx.setInput('OUT', l) }), note: 'OUT goes LOW when something is within range (set by its pot).' },
  joystick: {
    id: 'joystick', name: 'Thumb joystick (2-axis + button)', category: 'input', ui: 'joystick',
    roles: [{ id: 'VRX', kind: 'analog' }, { id: 'VRY', kind: 'analog' }, { id: 'SW', kind: 'digital-in' }], rail: '3v3', mA: 1, cost: 1.5, create: joystick,
    note: 'Two pots: centre ≈ half supply. SW closes to GND when you press the stick (use a pull-up).',
  },
  slidepot: { id: 'slidepot', name: 'Slide potentiometer 10 kΩ', category: 'input', ui: 'meter', reading: { label: 'Position', unit: '%', min: 0, max: 100, dflt: 50 }, roles: [{ id: 'WIPER', kind: 'analog' }], rail: '3v3', mA: 0.3, cost: 1.2, create: meter },
  // ---------------------------------------------------------------- analog sensors
  ldr: { id: 'ldr', name: 'Photoresistor (LDR) + 10 kΩ', category: 'sensor', ui: 'meter', reading: { label: 'Light', unit: 'lux', min: 0, max: 1000, dflt: 300, step: 1, volts: (x, v) => v * (x / (x + 80)) }, roles: [{ id: 'AO', kind: 'analog' }], rail: '3v3', mA: 0.3, cost: 0.2, create: meter, note: 'Voltage divider: brighter light = higher voltage.' },
  soil: { id: 'soil', name: 'Capacitive soil moisture v1.2', category: 'sensor', ui: 'meter', reading: { label: 'Moisture', unit: '%', min: 0, max: 100, dflt: 40, volts: (x, v) => Math.min(v, 3.0) * (0.95 - 0.55 * x / 100) }, roles: [{ id: 'AO', kind: 'analog' }], rail: '3v3', mA: 5, cost: 1.5, create: meter, note: 'Wetter soil = LOWER voltage (≈2.8 V dry, ≈1.2 V in water). Calibrate both ends.' },
  fsr: { id: 'fsr', name: 'Force sensor FSR402 + 10 kΩ', category: 'sensor', ui: 'meter', reading: { label: 'Force', unit: 'N', min: 0, max: 20, dflt: 0, step: 0.1, volts: (x, v) => v * (x / (x + 1.5)) }, roles: [{ id: 'AO', kind: 'analog' }], rail: '3v3', mA: 0.3, cost: 6, create: meter, note: 'Divider: more force = higher voltage. Not precise: good for touch/press/weight-ish.' },
  gas: { id: 'gas', name: 'Gas sensor MQ-2', category: 'sensor', ui: 'meter', reading: { label: 'Smoke/LPG', unit: 'ppm', min: 200, max: 10000, dflt: 300, step: 10, volts: (x, v) => Math.min(v, 0.35 + 3.6 * Math.log10(x / 200) / Math.log10(50)) }, roles: [{ id: 'AO', kind: 'analog' }], rail: '5v', mA: 150, cost: 1.8, create: meter, note: 'Heater needs ~150 mA at 5 V and a 24 h burn-in. AO rises with gas concentration.', checks: fiveVSensorOn3v3('MQ-2') },
  tmp36: { id: 'tmp36', name: 'TMP36 analog temperature', category: 'sensor', ui: 'sensor', roles: [{ id: 'VOUT', kind: 'analog' }], rail: '3v3', mA: 0.05, cost: 1.5, create: tmp36, note: '10 mV/°C with a 500 mV offset: °C = (V − 0.5) × 100.' },
  // ---------------------------------------------------------------- I2C sensors
  aht20: { id: 'aht20', name: 'AHT20 temp / RH (I2C)', category: 'sensor', ui: 'sensor', roles: [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }], rail: '3v3', mA: 0.3, cost: 1, i2cAddress: 0x38, create: aht20, note: 'I2C 0x38. Trigger 0xAC 0x33 0x00, read 7 bytes (status, 20-bit RH, 20-bit T, CRC).' },
  bh1750: { id: 'bh1750', name: 'BH1750 light sensor (I2C)', category: 'sensor', ui: 'meter', reading: { label: 'Light', unit: 'lux', min: 0, max: 2000, dflt: 250, step: 1 }, roles: [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }], rail: '3v3', mA: 0.2, cost: 1.2, i2cAddress: 0x23, create: bh1750, note: 'I2C 0x23. Send 0x10 (continuous high-res), read 2 bytes; lux = raw / 1.2.' },
  mpu6050: { id: 'mpu6050', name: 'MPU-6050 accel + gyro (I2C)', category: 'sensor', ui: 'imu', roles: [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }], rail: '3v3', mA: 4, cost: 2, i2cAddress: 0x68, create: mpu6050, note: 'I2C 0x68. Wake with 0x6B = 0, read 14 bytes from 0x3B (accel, temp, gyro; ±2 g = 16384/g).' },
  hcsr04: {
    id: 'hcsr04', name: 'Ultrasonic distance HC-SR04', category: 'sensor', ui: 'distance',
    roles: [{ id: 'TRIG', kind: 'digital-out' }, { id: 'ECHO', kind: 'digital-in' }], rail: '5v', mA: 15, cost: 1.2, create: hcsr04,
    note: '10 µs pulse on TRIG; ECHO goes HIGH for 58 µs per cm (2–400 cm).',
    checks: (c, x) => (x.board.logicV === 3.3 ? [{ level: 'warn', uid: c.uid, msg: 'HC-SR04 ECHO is a 5 V signal. Add a 1 kΩ/2 kΩ divider on a 3.3 V board (or use the 3.3 V HC-SR04P).' }] : []),
  },
  // ---------------------------------------------------------------- displays
  oled: {
    id: 'oled', name: 'SSD1306 0.96" OLED 128×64 (I2C)', category: 'display', ui: 'display', binds: 'screen', bindLabel: 'Product screen',
    roles: [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }], rail: '3v3', mA: 20, cost: 2.5, i2cAddress: 0x3c, create: oled,
    note: 'I2C 0x3C. Decodes the SSD1306 command set (addressing modes, remap, invert, contrast) and GDDRAM writes.',
  },
  lcd1602: {
    id: 'lcd1602', name: 'LCD 16×2 with I2C backpack', category: 'display', ui: 'display', binds: 'screen', bindLabel: 'Product screen',
    roles: [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }], rail: '5v', mA: 25, cost: 3, i2cAddress: 0x27, create: lcd,
    note: 'HD44780 behind a PCF8574 at 0x27 (0x3F on some). 4-bit mode, custom characters, backlight bit.',
  },
  tm1637: {
    id: 'tm1637', name: 'TM1637 4-digit 7-segment', category: 'display', ui: 'display', binds: 'screen', bindLabel: 'Product screen',
    roles: [{ id: 'CLK', kind: 'digital-out' }, { id: 'DIO', kind: 'digital-out' }], rail: '3v3', mA: 30, cost: 1.2, create: tm1637,
    note: 'Two-wire TM1637 protocol (not I2C): start/stop + LSB-first bytes. Colon = bit 7 of digit 2.',
  },
  // ---------------------------------------------------------------- outputs
  led_green: led('led_green', 'Green LED + 220 Ω', '#3dff6a'),
  led_blue: led('led_blue', 'Blue LED + 100 Ω', '#3d8bff'),
  led_yellow: led('led_yellow', 'Yellow LED + 220 Ω', '#ffd23d'),
  led_white: led('led_white', 'White LED + 100 Ω', '#f4f8ff'),
  rgbled: {
    id: 'rgbled', name: 'RGB LED (common cathode)', category: 'output', ui: 'rgb',
    roles: [{ id: 'R', kind: 'pwm' }, { id: 'G', kind: 'pwm' }, { id: 'B', kind: 'pwm' }], rail: null, mA: 30, drivemA: 10, cost: 0.2, create: rgbLed,
    note: 'One resistor per colour leg. PWM each leg 0–100% to mix any colour.',
  },
  laser: { ...led('laser', 'Laser module KY-008', '#ff2a2a', 0.8), mA: 30, drivemA: 30, note: 'Class 2/3R: never point at eyes. Draws ~30 mA, so switch it with a transistor.' },
  // ---------------------------------------------------------------- motion & power
  motor: {
    id: 'motor', name: 'DC motor + L9110S driver', category: 'actuator', ui: 'motor', onText: 'spinning',
    roles: [{ id: 'IA', kind: 'pwm' }, { id: 'IB', kind: 'pwm' }], rail: '5v', mA: 200, peakmA: 800, cost: 2.5, create: motor,
    note: 'H-bridge: PWM on IA (IB low) = forward, PWM on IB (IA low) = reverse.',
  },
  fan: { id: 'fan', name: '5 V fan + MOSFET', category: 'actuator', ui: 'motor', onText: 'blowing', roles: [{ id: 'IN', kind: 'pwm' }], rail: '5v', mA: 150, cost: 2, create: motor, note: 'MOSFET low-side switch; PWM the gate for speed. Add a flyback diode.' },
  pump: { id: 'pump', name: 'Mini water pump + MOSFET', category: 'actuator', ui: 'motor', onText: 'pumping', roles: [{ id: 'IN', kind: 'pwm' }], rail: '5v', mA: 220, peakmA: 600, cost: 2.5, create: motor, note: 'Runs dry very badly. Use a flyback diode and a separate 5 V supply if it browns out the board.' },
  solenoid: { id: 'solenoid', name: 'Solenoid lock + MOSFET', category: 'actuator', ui: 'relay', onText: 'unlocked', roles: [{ id: 'IN', kind: 'digital-out' }], rail: '5v', mA: 600, cost: 4, create: relay, note: 'Pulls ~600 mA at 12 V (needs its own supply). Only energise briefly.' },
  stepper: {
    id: 'stepper', name: 'Stepper 28BYJ-48 + ULN2003', category: 'actuator', ui: 'stepper',
    roles: [{ id: 'IN1', kind: 'digital-out' }, { id: 'IN2', kind: 'digital-out' }, { id: 'IN3', kind: 'digital-out' }, { id: 'IN4', kind: 'digital-out' }], rail: '5v', mA: 240, cost: 2.5, create: stepper,
    note: '4096 half-steps per turn (64:1 gearbox). Max ~15 RPM: wait ≥ 2 ms between steps.',
  },
};

Object.assign(COMPONENTS, MORE);

export const KIT = ['encoder', 'button', 'tft', 'neopixel', 'sht40', 'relay', 'haptic', 'buzzer'];
export type { Level };
