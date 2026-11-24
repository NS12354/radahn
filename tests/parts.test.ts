import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SSD1306, LCD1602, TM1637, MPU6050, AHT20, BH1750, Stepper } from '../src/hw/devices/parts';
import { BOARDS, autoPreset, KIT_PRESETS } from '../src/hw/library/boards';
import { COMPONENTS } from '../src/hw/library/components';
import { BOARD_PHYS, PART_PHYS } from '../src/hw/library/physical';
import { Bench } from '../src/hw/bench';
import { runChecks } from '../src/hw/checks';
import { demoFiles, PART_LIBS } from '../src/hw/partcode';
import type { CompInstance, Level } from '../src/hw/types';

const i2cWrite = (d: { start?(r: boolean): void; write(b: number): boolean; stop?(): void }, bytes: number[]) => { d.start?.(false); bytes.forEach(b => d.write(b)); d.stop?.(); };
const i2cRead = (d: { start?(r: boolean): void; read(): number; stop?(): void }, n: number) => { d.start?.(true); const r = Array.from({ length: n }, () => d.read()); d.stop?.(); return r; };

describe('SSD1306 OLED', () => {
  it('decodes the init sequence and a horizontal-mode frame like the MicroPython driver sends', () => {
    const o = new SSD1306();
    for (const c of [0xae, 0x20, 0x00, 0x40, 0xa1, 0xa8, 63, 0xc8, 0xd3, 0, 0xda, 0x12, 0x81, 0xff, 0xa6, 0x8d, 0x14, 0xaf]) i2cWrite(o, [0x80, c]);
    for (const c of [0x21, 0, 127, 0x22, 0, 7]) i2cWrite(o, [0x80, c]);
    const fb = new Array(1024).fill(0);
    fb[0] = 0x01;            // pixel (0, 0)
    fb[128 * 2 + 5] = 0x80;  // pixel (5, 23)
    i2cWrite(o, [0x40, ...fb]);
    expect(o.on).toBe(true);
    expect(o.lit(0, 0)).toBe(true);
    expect(o.lit(5, 23)).toBe(true);
    expect(o.lit(1, 0)).toBe(false);
    i2cWrite(o, [0x80, 0xa7]);
    expect(o.lit(1, 0)).toBe(true); // inverted
  });
  it('supports page addressing', () => {
    const o = new SSD1306();
    i2cWrite(o, [0x00, 0x20, 0x02, 0xb3, 0x04, 0x11]); // page mode, page 3, column 0x14
    i2cWrite(o, [0x40, 0xff]);
    expect(o.lit(20, 24) && o.lit(20, 31)).toBe(true);
  });
});

describe('LCD 16x2 on a PCF8574 backpack', () => {
  // mirrors lib/i2c_lcd.py
  const lcdDriver = (d: LCD1602) => {
    const nib = (v: number, rs = 0) => { const b = (v & 0xf0) | 0x08 | rs; i2cWrite(d, [b | 0x04, b]); };
    const cmd = (c: number) => { nib(c); nib(c << 4); };
    const data = (c: number) => { nib(c, 1); nib(c << 4, 1); };
    i2cWrite(d, [0]); for (let i = 0; i < 3; i++) nib(0x30); nib(0x20);
    cmd(0x28); cmd(0x08); cmd(0x01); cmd(0x06); cmd(0x0c);
    return { cmd, put: (s: string) => [...s].forEach(ch => data(ch.charCodeAt(0))), at: (x: number, y: number) => cmd(0x80 | (x + (y ? 0x40 : 0))) };
  };
  it('shows text on both rows, with the backlight', () => {
    const d = new LCD1602(), l = lcdDriver(d);
    l.put('Hello, maker!'); l.at(0, 1); l.put('Up 3 s');
    expect(d.row(0)).toBe('Hello, maker!   ');
    expect(d.row(1)).toBe('Up 3 s          ');
    expect(d.on && d.backlight).toBe(true);
    l.cmd(0x01);
    expect(d.row(0).trim()).toBe('');
  });
});

describe('TM1637 7-segment', () => {
  it('decodes start/stop framed LSB-first bytes from pin edges', () => {
    const t = new TM1637(), clk = (l: Level) => t.edge('CLK', l), dio = (l: Level) => t.edge('DIO', l);
    clk(1); dio(1);
    const start = () => { dio(0); clk(0); };
    const stop = () => { dio(0); clk(1); dio(1); };
    const byte = (b: number) => { for (let i = 0; i < 8; i++) { dio(((b >> i) & 1) as Level); clk(1); clk(0); } dio(0); clk(1); clk(0); };
    start(); byte(0x40); stop();
    start(); byte(0xc0); [0x06, 0x5b | 0x80, 0x4f, 0x66].forEach(byte); stop();
    start(); byte(0x8f); stop();
    expect(t.on).toBe(true);
    expect(t.brightness).toBe(7);
    expect(t.text()).toBe('12:34');
  });
});

describe('I2C sensors', () => {
  it('MPU-6050 reports 1 g on Z when flat, and tilts', () => {
    const m = new MPU6050(() => 22);
    i2cWrite(m, [0x75]); expect(i2cRead(m, 1)[0]).toBe(0x68);
    i2cWrite(m, [0x6b, 0]);
    const s16 = (h: number, l: number) => { const v = (h << 8) | l; return v > 32767 ? v - 65536 : v; };
    i2cWrite(m, [0x3b]); let d = i2cRead(m, 14);
    expect(s16(d[4], d[5]) / 16384).toBeCloseTo(1, 1);
    expect(s16(d[6], d[7]) / 340 + 36.53).toBeCloseTo(22, 0);
    m.pitch = 90; i2cWrite(m, [0x3b]); d = i2cRead(m, 6);
    expect(s16(d[0], d[1]) / 16384).toBeCloseTo(-1, 1);
  });
  it('AHT20 returns the room temperature and humidity with a valid CRC', () => {
    const a = new AHT20(() => 21.5, () => 40);
    i2cWrite(a, [0xac, 0x33, 0x00]);
    const d = i2cRead(a, 7);
    const h = (d[1] << 12) | (d[2] << 4) | (d[3] >> 4), t = ((d[3] & 15) << 16) | (d[4] << 8) | d[5];
    expect(t * 200 / 1048576 - 50).toBeCloseTo(21.5, 1);
    expect(h * 100 / 1048576).toBeCloseTo(40, 1);
    let crc = 0xff; for (const v of d.slice(0, 6)) { crc ^= v; for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 255 : (crc << 1) & 255; }
    expect(d[6]).toBe(crc);
  });
  it('BH1750 returns lux × 1.2 as a big-endian word', () => {
    const b = new BH1750(() => 300);
    i2cWrite(b, [0x01]); i2cWrite(b, [0x10]);
    const d = i2cRead(b, 2);
    expect(((d[0] << 8) | d[1]) / 1.2).toBeCloseTo(300, 0);
  });
});

describe('stepper', () => {
  it('counts half steps both ways from the coil pattern', () => {
    const s = new Stepper();
    const seq = [[1, 0, 0, 0], [1, 1, 0, 0], [0, 1, 0, 0], [0, 1, 1, 0], [0, 0, 1, 0], [0, 0, 1, 1], [0, 0, 0, 1], [1, 0, 0, 1]];
    const apply = (p: number[]) => p.forEach((v, i) => s.pin(i, v as Level));
    for (let i = 0; i < 16; i++) apply(seq[i % 8]);
    expect(s.steps).toBe(15);
    for (let i = 15; i >= 8; i--) apply(seq[i % 8]);
    expect(s.steps).toBe(8);
  });
});

describe('HC-SR04', () => {
  it('answers a trigger pulse with an echo 58 µs per cm long', () => {
    const levels: [number, Level][] = [];
    let now = 0;
    const events: [number, () => void][] = [];
    const bench = new Bench(BOARDS.picow, { roomC: 21, rh: 40 }, null);
    bench.load(BOARDS.picow, [{ uid: 'u', type: 'hcsr04', pins: { TRIG: 2, ECHO: 3 }, color: '#fff' }]);
    bench.attach({ kind: 'sim-python', running: true, start: async () => {}, stop: () => {}, setInput: (g: number, l: Level) => { if (g === 3) levels.push([now, l]); }, readOutput: () => 0, schedule: (ns: number, fn: () => void) => events.push([now + ns, fn]), now: () => now, sendSerial: () => {}, onSerial: () => {}, onStatus: () => {} } as any);
    bench.model('u')!.state.cm = 100;
    bench.pin(2, 1, 0); bench.pin(2, 0, 10e3);
    while (events.length) { events.sort((a, b) => a[0] - b[0]); const [t, fn] = events.shift()!; now = t; fn(); }
    const hi = levels.find(l => l[1] === 1)!, lo = levels.filter(l => l[1] === 0).pop()!;
    expect((lo[0] - hi[0]) / 1e3).toBeGreaterThan(5800);
    expect((lo[0] - hi[0]) / 1e3).toBeLessThan(5870);
  });
});

describe('catalog consistency', () => {
  it('every part is well-formed and creates a device model headless', () => {
    const comps: CompInstance[] = Object.values(COMPONENTS).map((d, i) => ({ uid: 'u' + i, type: d.id, pins: Object.fromEntries(d.roles.map(r => [r.id, null])), color: '#fff' }));
    for (const [k, d] of Object.entries(COMPONENTS)) {
      expect(d.id, k).toBe(k);
      expect(new Set(d.roles.map(r => r.id)).size, k).toBe(d.roles.length);
      if (d.ui === 'meter') expect(d.reading, k).toBeTruthy();
    }
    const bench = new Bench(BOARDS.picow, { roomC: 21, rh: 40 }, null);
    expect(() => { bench.load(BOARDS.picow, comps); bench.frame(0.016); }).not.toThrow();
    expect(Object.keys(COMPONENTS).length).toBeGreaterThanOrEqual(40);
  });
  it('every board has physical dimensions and a kit preset on real, non-boot pins', () => {
    for (const b of Object.values(BOARDS)) {
      expect(BOARD_PHYS[b.id], b.id).toBeTruthy();
      const p = KIT_PRESETS[b.id];
      expect(p, b.id).toBeTruthy();
      for (const pins of Object.values(autoPreset(b))) for (const g of pins) {
        expect(b.gpio, b.id).toContain(g);
        expect(b.strap, b.id).not.toContain(g);
      }
    }
    expect(Object.keys(BOARDS).length).toBeGreaterThanOrEqual(20);
  });
  it('flags outputs on input-only pins', () => {
    const msgs = runChecks(BOARDS.esp32, [{ uid: 'l', type: 'led', pins: { SIG: 34 }, color: '#fff' }]).map(c => c.msg).join('\n');
    expect(msgs).toMatch(/input-only/);
  });
  it('every part with a surface feature or display has a physical size', () => {
    for (const t of ['oled', 'lcd1602', 'tm1637', 'joystick', 'stepper']) expect(PART_PHYS[t], t).toBeTruthy();
  });
});

describe('demo programs', () => {
  const all = (b: string): CompInstance[] => {
    const board = BOARDS[b], used = new Set<number>(), out: CompInstance[] = [];
    for (const d of Object.values(COMPONENTS)) {
      const pins: Record<string, number | null> = {};
      for (const r of d.roles) { const g = board.gpio.find(x => !used.has(x)) ?? null; if (g != null && !/^(SDA|SCL)$/.test(r.id)) used.add(g); pins[r.id] = g; }
      out.push({ uid: d.id, type: d.id, pins, color: '#fff' });
    }
    return out;
  };
  it('generates a program for every board that covers every part', () => {
    for (const id of Object.keys(BOARDS)) {
      const f = demoFiles(BOARDS[id], all(id))!;
      const main = f['main.py'] ?? f['sketch.ino'];
      expect(main, id).toBeTruthy();
      expect(main, id).toMatch(/ready/);
      if (BOARDS[id].lang === 'micropython') for (const lib of ['lib/ssd1306.py', 'lib/i2c_lcd.py', 'lib/tm1637.py', 'lib/hcsr04.py']) expect(f[lib], `${id} ${lib}`).toBeTruthy();
    }
  });
  it('MicroPython and Python demos, and the part drivers, are valid Python', () => {
    let py = '';
    try { py = execFileSync('python3', ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8' }); } catch { return; } // no python3 here: skip
    expect(py).toBeTruthy();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-demo-'));
    const files: Record<string, string> = {};
    for (const id of ['picow', 'esp32', 'pi5']) for (const [n, src] of Object.entries(demoFiles(BOARDS[id], all(id))!)) files[`${id}/${n}`] = src;
    for (const lib of Object.values(PART_LIBS)) for (const [n, src] of Object.entries(lib)) files[`libs/${n}`] = src;
    for (const [n, src] of Object.entries(files)) { const p = path.join(dir, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, src); }
    const check = `import ast, sys, pathlib\nbad = []\nfor p in pathlib.Path(sys.argv[1]).rglob('*.py'):\n    try:\n        ast.parse(p.read_text())\n    except SyntaxError as e:\n        bad.append(f'{p}: {e}')\nprint('\\n'.join(bad))`;
    expect(execFileSync('python3', ['-c', check, dir], { encoding: 'utf8' }).trim()).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('sim text font', () => {
  it('draws readable 5x7 glyphs', async () => {
    const { glyphs } = await import('../src/hw/runtimes/sim-python');
    const [A, sp] = glyphs('A ');
    expect(A).toEqual([0, 0x7e, 0x11, 0x11, 0x11, 0x7e, 0, 0]);
    expect(sp.every(v => v === 0)).toBe(true);
  });
});

describe('auto build with the new displays', () => {
  it('gives an OLED a rectangular window that becomes the product screen', async () => {
    const { autoBuild } = await import('../src/app/autobuild');
    const { defaultAutoOpts } = await import('../src/app/project');
    const { screenPart, displayComps } = await import('../src/app/screenpart');
    const comps: CompInstance[] = [{ uid: 'o', type: 'oled', pins: { SDA: 4, SCL: 5 }, color: '#fff' }, { uid: 'b', type: 'button', pins: { SIG: 6 }, color: '#fff' }];
    const r = autoBuild(BOARDS.picow, comps, defaultAutoOpts());
    const win = r.parts.find(p => p.comp === 'o' && /window/.test(p.name))!;
    expect(win.shape).toBe('rect');
    expect(win.size[0]).toBeCloseTo(21.7, 0);
    const pick = screenPart(r.parts, displayComps({ electronics: { comps } } as any));
    expect(pick?.id).toBe(win.id);
  });
});
