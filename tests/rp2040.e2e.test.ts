import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { Bench } from '../src/hw/bench';
import { BOARDS, KIT_PRESETS } from '../src/hw/library/boards';
import { COMPONENTS, KIT } from '../src/hw/library/components';
import { RP2040Runtime } from '../src/hw/runtimes/rp2040';
import { defaultFiles } from '../src/hw/templates';
import type { CompInstance } from '../src/hw/types';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(50); } return true; }

describe('RP2040 + real MicroPython: thermostat kit', () => {
  it('boots, deploys, and talks to every virtual device', async () => {
    const board = BOARDS.picow;
    const comps: CompInstance[] = KIT.map((t, i) => {
      const pins: Record<string, number> = {};
      COMPONENTS[t].roles.forEach((r, k) => (pins[r.id] = KIT_PRESETS.picow[t][k]));
      return { uid: 'c' + i, type: t, pins, color: '#fff' };
    });
    const env = { roomC: 20.5, rh: 42 };
    const leds: any[] = [];
    const bench = new Bench(board, env, { screenCanvas: () => null, screenUpdated() {}, setLeds: px => leds.push(px), haptic() {} });
    bench.load(board, comps);
    const logs: string[] = [];
    bench.onLog = m => logs.push(m);
    const fw = Buffer.from(fs.readFileSync('public/firmware/micropython-rp2-pico-v1.24.1.uf2.b64.txt', 'utf8').trim(), 'base64');
    const rt = new RP2040Runtime(bench, async () => new Uint8Array(fw));
    let out = '';
    rt.onSerial = t => (out += t);
    const frames = setInterval(() => bench.frame(0.016), 16);
    await rt.start(defaultFiles(board, comps));
    const ok1 = await until(() => /target 22\.0\s+room 20\.\d/.test(out), 20000); if (!ok1) { console.log('OUT>>', JSON.stringify(out.slice(-1500)), 'LOGS', logs); } expect(ok1).toBe(true);

    // turn the dial 3 detents clockwise
    const enc = bench.bound('encoder')!.model;
    for (let i = 0; i < 3; i++) { enc.sim!.turn(1); await wait(60); }
    expect(await until(() => out.includes('target 23.5'), 8000)).toBe(true);

    // press the display button
    const btn = bench.bound('button')!.model;
    btn.sim!.press(true); await wait(300); btn.sim!.press(false);
    expect(await until(() => /eco True/.test(out), 8000)).toBe(true);

    const tft = bench.bound('tft')!.model;
    const np = bench.bound('neopixel')!.model;
    const sht = bench.bound('sht40')!.model;
    clearInterval(frames);
    await rt.stop();
    console.log(out.split('\n').slice(-6).join('\n'));
    console.log('logs', logs);
    expect(tft.state.mode).toBe('spi');
    expect(np.state.frames).toBeGreaterThan(2);
    expect(leds.at(-1)?.[0]?.[1]).toBeGreaterThan(150);  // green-ish ring in eco mode
    expect(sht.state.measurements).toBeGreaterThan(0);
  }, 60000);
});
