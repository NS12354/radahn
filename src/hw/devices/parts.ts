/**
 * Device models for the wider parts catalog. Each speaks the real part's
 * protocol, so the same firmware works in the emulators, the behavioral sim
 * and on hardware:
 *  - SSD1306 OLED (I2C command/data stream into GDDRAM)
 *  - HD44780 16x2 LCD behind a PCF8574 I2C backpack (4-bit nibbles on E)
 *  - TM1637 4-digit 7-segment (start/stop + LSB-first bytes on CLK/DIO)
 *  - MPU-6050 IMU, AHT20 temp/RH, BH1750 light (I2C register / command models)
 *  - 28BYJ-48 stepper on a ULN2003 (coil pattern → half steps)
 *  - HC-SR04 ultrasonic (TRIG pulse → timed ECHO pulse)
 */
import type { I2CTarget, Level } from '../types';

type Canvas = HTMLCanvasElement | OffscreenCanvas;
/** A canvas for a device's own picture, or null when running headless (tests). */
export function makeCanvas(w: number, h: number): Canvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return null;
}
/** Draw a device's picture onto the product screen, letterboxed, on black. */
export function paintInto(dst: Canvas, src: Canvas) {
  const g = dst.getContext('2d') as CanvasRenderingContext2D;
  const s = Math.min(dst.width / src.width, dst.height / src.height) * 0.92;
  const w = src.width * s, h = src.height * s;
  g.save(); g.fillStyle = '#000'; g.fillRect(0, 0, dst.width, dst.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(src as any, (dst.width - w) / 2, (dst.height - h) / 2, w, h);
  g.restore();
}

// ------------------------------------------------------------------ SSD1306
const SSD_ARGS: Record<number, number> = { 0x81: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1, 0xa3: 2, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5 };
export class SSD1306 implements I2CTarget {
  readonly ram = new Uint8Array(128 * 8);
  on = false; inverted = false; contrast = 0x7f; height = 64; flipX = true; flipY = true; startLine = 0;
  dirty = true; bytes = 0;
  private mode = 2; private col = 0; private page = 0; private c0 = 0; private c1 = 127; private p0 = 0; private p1 = 7;
  private ctl = true; private co = false; private dc = false; private cmd: number[] = []; private need = 0;
  constructor(public address = 0x3c) {}
  reset() { this.ram.fill(0); this.on = false; this.inverted = false; this.mode = 2; this.col = this.page = 0; this.c0 = 0; this.c1 = 127; this.p0 = 0; this.p1 = 7; this.height = 64; this.flipX = this.flipY = true; this.startLine = 0; this.dirty = true; }
  start() { this.ctl = true; } // a multi-byte command may span transactions (the MicroPython driver sends one byte per write)
  write(b: number) {
    this.bytes++;
    if (this.ctl) { this.co = !!(b & 0x80); this.dc = !!(b & 0x40); this.ctl = false; return true; }
    if (this.dc) this.data(b); else this.command(b);
    if (this.co) this.ctl = true;
    return true;
  }
  read() { return this.on ? 0x03 : 0x43; } // status byte: bit6 = display off
  private command(b: number) {
    if (this.need) { this.cmd.push(b); if (--this.need === 0) this.exec(this.cmd); return; }
    this.cmd = [b]; this.need = SSD_ARGS[b] ?? 0;
    if (!this.need) this.exec(this.cmd);
  }
  private exec([c, a, z]: number[]) {
    if (c === 0xae || c === 0xaf) this.on = c === 0xaf;
    else if (c === 0xa6 || c === 0xa7) this.inverted = c === 0xa7;
    else if (c === 0x81) this.contrast = a;
    else if (c === 0x20) this.mode = a & 3;
    else if (c === 0x21) { this.c0 = a & 127; this.c1 = z & 127; this.col = this.c0; }
    else if (c === 0x22) { this.p0 = a & 7; this.p1 = z & 7; this.page = this.p0; }
    else if (c >= 0xb0 && c <= 0xb7) this.page = c & 7;
    else if (c <= 0x0f) this.col = (this.col & 0xf0) | c;
    else if (c >= 0x10 && c <= 0x1f) this.col = ((c & 0x0f) << 4) | (this.col & 0x0f);
    else if (c >= 0x40 && c <= 0x7f) this.startLine = c & 63;
    else if (c === 0xa0 || c === 0xa1) this.flipX = c === 0xa1;
    else if (c === 0xc0 || c === 0xc8) this.flipY = c === 0xc8;
    else if (c === 0xa8) this.height = Math.min(64, (a & 63) + 1) <= 32 ? 32 : 64;
    this.dirty = true;
  }
  private data(b: number) {
    this.ram[(this.page & 7) * 128 + (this.col & 127)] = b; this.dirty = true;
    if (this.mode === 0) { if (++this.col > this.c1) { this.col = this.c0; if (++this.page > this.p1) this.page = this.p0; } }
    else if (this.mode === 1) { if (++this.page > this.p1) { this.page = this.p0; if (++this.col > this.c1) this.col = this.c0; } }
    else this.col = (this.col + 1) & 127;
  }
  /** Is pixel (x, y) lit, as seen on the glass. */
  lit(x: number, y: number) {
    const cx = this.flipX ? x : 127 - x, cy = ((this.flipY ? y : this.height - 1 - y) + this.startLine) % 64;
    return !!(this.ram[(cy >> 3) * 128 + cx] & (1 << (cy & 7))) !== this.inverted;
  }
  draw(cv: Canvas) {
    const g = cv.getContext('2d') as CanvasRenderingContext2D;
    const img = g.createImageData(128, this.height), d = img.data, k = 0.45 + 0.55 * (this.contrast / 255);
    for (let y = 0; y < this.height; y++) for (let x = 0; x < 128; x++) {
      const i = (y * 128 + x) * 4, on = this.on && this.lit(x, y);
      d[i] = on ? 225 * k : 6; d[i + 1] = on ? 240 * k : 8; d[i + 2] = on ? 255 * k : 12; d[i + 3] = 255;
    }
    if (cv.height !== this.height) cv.height = this.height;
    g.putImageData(img, 0, 0);
  }
}

// ------------------------------------------------------------------ HD44780 + PCF8574
export class LCD1602 implements I2CTarget {
  readonly ddram = new Uint8Array(0x68).fill(0x20);
  readonly cgram = new Uint8Array(64);
  backlight = false; on = false; cursor = false; blink = false; dirty = true; writes = 0;
  private mode8 = true; private hi: number | null = null; private lastE = 0;
  private addr = 0; private cg = false; private inc = 1; private shift = 0;
  constructor(public address = 0x27, public cols = 16, public rows = 2) {}
  reset() { this.ddram.fill(0x20); this.cgram.fill(0); this.backlight = this.on = this.cursor = this.blink = false; this.mode8 = true; this.hi = null; this.lastE = 0; this.addr = 0; this.cg = false; this.inc = 1; this.shift = 0; this.dirty = true; }
  start() { }
  read() { return 0xff; }
  /** One byte on the PCF8574 port: P0=RS P1=RW P2=E P3=backlight P4..P7=D4..D7. */
  write(b: number) {
    const e = (b >> 2) & 1;
    if (this.backlight !== !!(b & 8)) { this.backlight = !!(b & 8); this.dirty = true; }
    if (this.lastE && !e && !(b & 2)) this.nibble((b >> 4) & 15, b & 1);
    this.lastE = e;
    return true;
  }
  private nibble(n: number, rs: number) {
    if (this.mode8) { this.exec(n << 4, rs); return; }
    if (this.hi == null) { this.hi = n; return; }
    const v = (this.hi << 4) | n; this.hi = null; this.exec(v, rs);
  }
  private exec(v: number, rs: number) {
    this.writes++; this.dirty = true;
    if (rs) {
      if (this.cg) { this.cgram[this.addr & 63] = v & 31; this.addr = (this.addr + 1) & 63; }
      else { if (this.addr < this.ddram.length) this.ddram[this.addr] = v; this.addr = this.step(this.addr, this.inc); }
      return;
    }
    if (v & 0x80) { this.cg = false; this.addr = v & 0x7f; }
    else if (v & 0x40) { this.cg = true; this.addr = v & 0x3f; }
    else if (v & 0x20) { this.mode8 = !!(v & 0x10); this.hi = null; }
    else if (v & 0x10) { const right = !!(v & 4); if (v & 8) this.shift += right ? -1 : 1; else { this.cg = false; this.addr = this.step(this.addr, right ? 1 : -1); } }
    else if (v & 0x08) { this.on = !!(v & 4); this.cursor = !!(v & 2); this.blink = !!(v & 1); }
    else if (v & 0x04) this.inc = v & 2 ? 1 : -1;
    else if (v & 0x02) { this.addr = 0; this.shift = 0; this.cg = false; }
    else if (v & 0x01) { this.ddram.fill(0x20); this.addr = 0; this.shift = 0; this.inc = 1; this.cg = false; }
  }
  private step(a: number, d: number) {
    const line = a >= 0x40 ? 0x40 : 0, i = a - line + d;
    return i > 0x27 ? (line ? 0 : 0x40) : i < 0 ? (line ? 0x27 : 0x67) : line + i;
  }
  /** The text on row r as it's shown (after display shifts). */
  row(r: number) {
    let s = '';
    for (let i = 0; i < this.cols; i++) s += String.fromCharCode(this.ddram[(r ? 0x40 : 0) + (((i + this.shift) % 40) + 40) % 40] || 0x20);
    return s;
  }
  draw(cv: Canvas) {
    const g = cv.getContext('2d') as CanvasRenderingContext2D, CW = 12, CH = 18, P = 8;
    const w = P * 2 + this.cols * CW, h = P * 2 + this.rows * CH;
    if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h;
    g.fillStyle = this.backlight ? '#2f62e0' : '#14224a'; g.fillRect(0, 0, w, h);
    if (!this.on) return;
    for (let r = 0; r < this.rows; r++) for (let i = 0; i < this.cols; i++) {
      const code = this.ddram[(r ? 0x40 : 0) + (((i + this.shift) % 40) + 40) % 40], x = P + i * CW, y = P + r * CH;
      g.fillStyle = this.backlight ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.03)'; g.fillRect(x, y, CW - 2, CH - 2);
      g.fillStyle = this.backlight ? '#eef3ff' : '#6f7fae';
      if (code < 8) { // custom character from CGRAM: 5x8 dots
        for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 5; xx++) if (this.cgram[code * 8 + yy] & (16 >> xx)) g.fillRect(x + xx * 2, y + yy * 2, 1.7, 1.7);
      } else { g.font = 'bold 15px "JetBrains Mono", monospace'; g.textBaseline = 'top'; g.fillText(String.fromCharCode(code), x + 1, y, CW - 2); }
    }
  }
}

// ------------------------------------------------------------------ TM1637
/** Segment bits: a=1 b=2 c=4 d=8 e=16 f=32 g=64, dp/colon=128. */
export class TM1637 {
  readonly segs = new Uint8Array(6);
  on = false; brightness = 7; dirty = true; frames = 0;
  private clk: Level = 1; private dio: Level = 1; private started = false; private bits = 0; private cur = 0; private bytes: number[] = [];
  reset() { this.segs.fill(0); this.on = false; this.clk = this.dio = 1; this.started = false; this.bytes = []; this.dirty = true; }
  edge(role: 'CLK' | 'DIO', l: Level) {
    if (role === 'DIO') {
      if (this.clk && l !== this.dio) {
        if (!l) { this.started = true; this.bits = 0; this.cur = 0; this.bytes = []; }
        else if (this.started) { this.started = false; this.command(this.bytes); }
      }
      this.dio = l; return;
    }
    if (l && !this.clk && this.started) {
      if (this.bits < 8) { this.cur |= this.dio << this.bits; this.bits++; }
      else { this.bytes.push(this.cur); this.cur = 0; this.bits = 0; } // 9th clock = ACK
    }
    this.clk = l;
  }
  private auto = true;
  private command(b: number[]) {
    if (!b.length) return;
    const c = b[0];
    if ((c & 0xc0) === 0x40) this.auto = !(c & 4);
    else if ((c & 0xc0) === 0xc0) { let a = c & 7; for (const v of b.slice(1)) { if (a < 6) this.segs[a] = v; if (this.auto) a++; } this.frames++; this.dirty = true; }
    else if ((c & 0xc0) === 0x80) { this.on = !!(c & 8); this.brightness = c & 7; this.dirty = true; }
  }
  /** Segments as text, best effort: "12:34". */
  text(n = 4) {
    const M: Record<number, string> = { 0x3f: '0', 0x06: '1', 0x5b: '2', 0x4f: '3', 0x66: '4', 0x6d: '5', 0x7d: '6', 0x07: '7', 0x7f: '8', 0x6f: '9', 0x77: 'A', 0x7c: 'b', 0x39: 'C', 0x5e: 'd', 0x79: 'E', 0x71: 'F', 0x40: '-', 0: ' ' };
    return Array.from(this.segs.slice(0, n), (v, i) => (M[v & 0x7f] ?? '?') + (i === 1 && v & 0x80 ? ':' : '')).join('');
  }
  draw(cv: Canvas, n = 4) {
    const g = cv.getContext('2d') as CanvasRenderingContext2D, W = 34, H = 56, P = 10;
    const w = P * 2 + n * W + 10, h = P * 2 + H;
    if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h;
    g.fillStyle = '#0b0b0c'; g.fillRect(0, 0, w, h);
    const lum = this.on ? 0.45 + 0.55 * (this.brightness / 7) : 0;
    const segPath: [number, number, number, number][] = [[4, 0, 18, 4], [22, 4, 4, 20], [22, 28, 4, 20], [4, 48, 18, 4], [0, 28, 4, 20], [0, 4, 4, 20], [4, 24, 18, 4]];
    for (let d = 0; d < n; d++) {
      const v = this.segs[d], x0 = P + d * W + (d >= 2 ? 10 : 0) + 3, y0 = P + 2;
      segPath.forEach(([x, y, sw, sh], i) => { const lit = lum && v & (1 << i); g.fillStyle = lit ? `rgba(255,60,40,${lum})` : '#2a1212'; g.fillRect(x0 + x, y0 + y, sw, sh); });
    }
    const colon = lum && this.segs[1] & 0x80;
    g.fillStyle = colon ? `rgba(255,60,40,${lum})` : '#2a1212';
    g.fillRect(P + 2 * W + 2, P + 18, 4, 4); g.fillRect(P + 2 * W + 2, P + 36, 4, 4);
  }
}

// ------------------------------------------------------------------ I2C register devices
/** Register-pointer device: first written byte sets the pointer, the rest write registers; reads auto-increment. */
abstract class RegDevice implements I2CTarget {
  readonly regs = new Uint8Array(256);
  protected ptr = 0; private first = true; reads = 0;
  constructor(public address: number) {}
  start(read: boolean) { if (!read) this.first = true; else this.refresh(); }
  write(b: number) { if (this.first) { this.ptr = b; this.first = false; } else { this.onWrite(this.ptr, b); this.ptr = (this.ptr + 1) & 255; } return true; }
  read() { this.reads++; const v = this.regs[this.ptr]; this.ptr = (this.ptr + 1) & 255; return v; }
  protected onWrite(r: number, v: number) { this.regs[r] = v; }
  protected refresh() { }
}

export class MPU6050 extends RegDevice {
  pitch = 0; roll = 0; gyro: [number, number, number] = [0, 0, 0];
  constructor(private tempC: () => number, address = 0x68) { super(address); this.reset(); }
  reset() { this.regs.fill(0); this.regs[0x75] = 0x68; this.regs[0x6b] = 0x40; }
  protected refresh() {
    const r = Math.PI / 180, p = this.pitch * r, q = this.roll * r;
    const fs = [16384, 8192, 4096, 2048][(this.regs[0x1c] >> 3) & 3], gs = [131, 65.5, 32.8, 16.4][(this.regs[0x1b] >> 3) & 3];
    const n = () => (Math.random() - 0.5) * 0.004;
    const put = (at: number, v: number) => { const x = Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff; this.regs[at] = x >> 8; this.regs[at + 1] = x & 255; };
    put(0x3b, (-Math.sin(p) + n()) * fs); put(0x3d, (Math.sin(q) * Math.cos(p) + n()) * fs); put(0x3f, (Math.cos(q) * Math.cos(p) + n()) * fs);
    put(0x41, (this.tempC() - 36.53) * 340);
    this.gyro.forEach((v, i) => put(0x43 + i * 2, v * gs));
  }
}

export class AHT20 implements I2CTarget {
  private cmd: number[] = []; private busy = false; measurements = 0;
  constructor(private tempC: () => number, private rh: () => number, public address = 0x38) {}
  start(read: boolean) { if (!read) this.cmd = []; else this.out = this.frame(); this.i = 0; }
  private out: number[] = []; private i = 0;
  write(b: number) { this.cmd.push(b); if (this.cmd[0] === 0xac && this.cmd.length === 3) { this.busy = false; this.measurements++; } return true; }
  read() { return this.out[this.i++] ?? 0xff; }
  private frame() {
    const h = Math.round(Math.max(0, Math.min(100, this.rh())) / 100 * 0xfffff), t = Math.round((this.tempC() + 50) / 200 * 0xfffff);
    const b = [this.busy ? 0x98 : 0x18, (h >> 12) & 255, (h >> 4) & 255, ((h & 15) << 4) | ((t >> 16) & 15), (t >> 8) & 255, t & 255];
    let crc = 0xff;
    for (const v of b) { crc ^= v; for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 255 : (crc << 1) & 255; }
    return [...b, crc];
  }
}

export class BH1750 implements I2CTarget {
  powered = false; reads = 0;
  constructor(private lux: () => number, public address = 0x23) {}
  start() { this.n = 0; }
  write(b: number) { if (b === 0x01) this.powered = true; else if (b === 0x00) this.powered = false; else if (b >= 0x10) this.powered = true; return true; }
  private n = 0;
  read() { this.reads++; const raw = Math.max(0, Math.min(65535, Math.round(this.lux() * 1.2))); return this.n++ % 2 === 0 ? raw >> 8 : raw & 255; }
  stop() { this.n = 0; }
}

// ------------------------------------------------------------------ stepper
const HALF = [0b1000, 0b1100, 0b0100, 0b0110, 0b0010, 0b0011, 0b0001, 0b1001];
/** 28BYJ-48 through a ULN2003: each new coil pattern is a half step; 4096 half steps per output turn. */
export class Stepper {
  steps = 0; private lv = [0, 0, 0, 0]; private phase = -1; last = 0;
  constructor(public perRev = 4096) {}
  reset() { this.steps = 0; this.lv = [0, 0, 0, 0]; this.phase = -1; }
  pin(i: number, l: Level, t = 0) {
    this.lv[i] = l;
    const mask = (this.lv[0] << 3) | (this.lv[1] << 2) | (this.lv[2] << 1) | this.lv[3];
    const p = HALF.indexOf(mask);
    if (p < 0) return;
    if (this.phase >= 0 && p !== this.phase) { const d = ((p - this.phase + 12) % 8) - 4; if (d !== -4) { this.steps += d; this.last = t; } }
    this.phase = p;
  }
  get angle() { return ((this.steps / this.perRev) * 360) % 360; }
}
