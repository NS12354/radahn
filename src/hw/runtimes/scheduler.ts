/**
 * Zero-delay task scheduler for emulator run loops. setTimeout(0) is clamped to
 * ≥4 ms after a few nested calls, which wastes a third of the CPU; a
 * MessageChannel post runs on the next macrotask with no clamp.
 */
const hasMC = typeof MessageChannel !== 'undefined';
const queue: (() => void)[] = [];
let ch: MessageChannel | null = null;
const si: ((fn: () => void) => void) | undefined = (globalThis as any).setImmediate;
export function nextTick(fn: () => void) {
  if (si) { si(fn); return; }            // Node: yields to timers every turn
  if (!hasMC) { setTimeout(fn, 0); return; }
  if (!ch) { ch = new MessageChannel(); ch.port1.onmessage = () => { const f = queue.shift(); f?.(); }; }
  queue.push(fn);
  ch.port2.postMessage(0);
}

/** Measures emulated-time / wall-time over a sliding window. */
export class SpeedMeter {
  private samples: [number, number][] = [];
  sample(emuNs: number) {
    const now = performance.now();
    this.samples.push([now, emuNs]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 1500) this.samples.shift();
  }
  get ratio() {
    if (this.samples.length < 2) return 1;
    const [a, b] = [this.samples[0], this.samples[this.samples.length - 1]];
    const wall = (b[0] - a[0]) * 1e6;
    return wall > 0 ? Math.min(1, (b[1] - a[1]) / wall) : 1;
  }
}
