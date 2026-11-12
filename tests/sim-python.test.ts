import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { Bench } from '../src/hw/bench';
import { BOARDS } from '../src/hw/library/boards';
import { SimPythonRuntime } from '../src/hw/runtimes/sim-python';
import { defaultFiles } from '../src/hw/templates';
import { kitFor } from '../src/app/project';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(30); } return true; }

beforeAll(() => {
  (globalThis as any).window = globalThis; (globalThis as any).navigator ??= { userAgent: 'node' };
  const req = createRequire(import.meta.url);
  req('../public/vendor/skulpt.min.js'); req('../public/vendor/skulpt-stdlib.js');
});

describe('behavioral Python runtime', () => {
  for (const id of ['esp32s3', 'pi5']) it(`runs the ${id} thermostat template`, async () => {
    const board = BOARDS[id], comps = kitFor(id);
    const bench = new Bench(board, { roomC: 20.5, rh: 42 }, null);
    bench.load(board, comps);
    const rt = new SimPythonRuntime(bench);
    let out = ''; rt.onSerial = t => (out += t);
    await rt.start(defaultFiles(board, comps));
    const re = id === 'pi5' ? /target/ : /target 22\.0/;
    if (id === 'pi5') { bench.bound('encoder')!.model.sim!.turn(1); await wait(100); bench.bound('encoder')!.model.sim!.turn(1); }
    else await until(() => re.test(out), 5000);
    if (id !== 'pi5') { bench.bound('encoder')!.model.sim!.turn(1); await wait(120); bench.bound('encoder')!.model.sim!.turn(1); }
    const ok = await until(() => (id === 'pi5' ? /target 23\.0/ : /target 23\.0/).test(out), 5000);
    if (!ok) console.log(out);
    rt.stop();
    expect(ok).toBe(true);
    expect(bench.bound('neopixel')!.model.state.frames).toBeGreaterThan(0);
  }, 20000);
});
