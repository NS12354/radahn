import { describe, it, expect } from 'vitest';
import { WS2812Decoder } from '../src/hw/devices/ws2812';
import { GC9A01Decoder } from '../src/hw/devices/gc9a01';
import { SHT40, crc8 } from '../src/hw/devices/sht40';
import { EdgeMeter } from '../src/hw/devices/edge';

describe('WS2812 decoder', () => {
  it('decodes GRB bits from pulse widths and latches on reset', () => {
    const d = new WS2812Decoder(2); let got: any = null; d.onFrame = p => (got = p);
    let t = 0;
    const bit = (b: number) => { d.edge(1, t); t += b ? 800 : 400; d.edge(0, t); t += b ? 450 : 850; };
    const byte = (v: number) => { for (let i = 7; i >= 0; i--) bit((v >> i) & 1); };
    byte(0x10); byte(0xff); byte(0x01); // pixel 0: G=0x10 R=0xff B=0x01
    d.poll(t + 60_000);
    expect(got[0]).toEqual([0xff, 0x10, 0x01]);
    expect(got[1]).toEqual([0, 0, 0]);
  });
});

describe('GC9A01 decoder', () => {
  it('handles CASET/RASET/RAMWR windows with RGB565', () => {
    const d = new GC9A01Decoder();
    const cmd = (c: number, ...a: number[]) => { d.byte(c, 0); a.forEach(x => d.byte(x, 1)); };
    cmd(0x29); cmd(0x2a, 0, 10, 0, 11); cmd(0x2b, 0, 5, 0, 5); cmd(0x2c, 0xf8, 0x00, 0x07, 0xe0);
    const px = (x: number, y: number) => [...d.rgba.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 3)];
    expect(d.displayOn).toBe(true);
    expect(px(10, 5)).toEqual([255, 0, 0]);
    expect(px(11, 5)).toEqual([0, 255, 0]);
    expect(px(12, 5)).toEqual([0, 0, 0]);
  });
});

describe('SHT40', () => {
  it('matches the Sensirion CRC example and encodes T/RH', () => {
    expect(crc8([0xbe, 0xef])).toBe(0x92);
    const s = new SHT40(() => 25, () => 50);
    s.write(0xfd);
    const d = Array.from({ length: 6 }, () => s.read());
    expect(crc8(d.slice(0, 2))).toBe(d[2]);
    const t = -45 + 175 * ((d[0] << 8) | d[1]) / 65535, rh = -6 + 125 * ((d[3] << 8) | d[4]) / 65535;
    expect(t).toBeCloseTo(25, 1); expect(rh).toBeCloseTo(50, 1);
  });
});

describe('EdgeMeter', () => {
  it('measures frequency and duty of a PWM signal', () => {
    const m = new EdgeMeter(); let t = 0;
    for (let i = 0; i < 10; i++) { m.edge(1, t); t += 100_000; m.edge(0, t); t += 300_000; } // 2.5 kHz, 25%
    expect(m.freq(t)).toBeCloseTo(2500, 0); expect(m.duty(t)).toBeCloseTo(0.25, 2);
  });
});
