import { describe, it, expect } from 'vitest';
import { Bench } from '../src/hw/bench';
import { BOARDS, KIT_PRESETS } from '../src/hw/library/boards';
import { COMPONENTS, KIT } from '../src/hw/library/components';
import { AVRRuntime } from '../src/hw/runtimes/avr';
import { defaultFiles } from '../src/hw/templates';
// @ts-ignore - plain JS module
import { compileSketch } from '../server/compile.mjs';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(50); } return true; }

describe('Arduino Uno: compiled thermostat sketch on avr8js', () => {
  it('compiles with avr-gcc and drives every virtual device', async () => {
    const board = BOARDS.uno;
    const comps = KIT.map((t, i) => { const pins: Record<string, number> = {}; COMPONENTS[t].roles.forEach((r, k) => (pins[r.id] = KIT_PRESETS.uno[t][k])); return { uid: 'c' + i, type: t, pins, color: '#fff' }; });
    const files = defaultFiles(board, comps);
    const { hex, log } = await compileSketch({ files, board: 'uno' });
    console.log(log);
    const leds: any[] = [];
    const bench = new Bench(board, { roomC: 20.5, rh: 42 }, { screenCanvas: () => null, screenUpdated() {}, setLeds: px => leds.push(px), haptic() {} });
    bench.load(board, comps);
    const logs: string[] = []; bench.onLog = m => logs.push(m);
    const rt = new AVRRuntime(bench);
    let out = ''; rt.onSerial = t => (out += t);
    const frames = setInterval(() => bench.frame(0.016), 16);
    await rt.start({ 'firmware.hex': hex });
    const ok = await until(() => /target 22\.0\s+room 20\.\d/.test(out), 20000);
    if (!ok) console.log('OUT', JSON.stringify(out), logs);
    expect(ok).toBe(true);
    const enc = bench.bound('encoder')!.model;
    for (let i = 0; i < 3; i++) { enc.sim!.turn(1); await wait(200); }
    expect(await until(() => out.includes('target 23.5'), 10000)).toBe(true);
    const btn = bench.bound('button')!.model;
    btn.sim!.press(true); await wait(400); btn.sim!.press(false);
    expect(await until(() => /eco 1/.test(out), 10000)).toBe(true);
    clearInterval(frames); rt.stop();
    console.log(out.trim().split('\n').slice(-4).join('\n'), logs);
    expect(bench.bound('tft')!.model.state.mode).toBe('spi');
    expect(bench.bound('neopixel')!.model.state.frames).toBeGreaterThan(2);
    expect(leds.at(-1)?.[0]?.[1]).toBeGreaterThan(50);
  }, 90000);
});
