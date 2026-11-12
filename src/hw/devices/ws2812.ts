import type { Level } from '../types';

/**
 * WS2812 / NeoPixel decoder. Feed it every edge on the DIN line (emulated ns).
 * A high pulse longer than ~550 ns is a 1 bit; a low gap longer than 50 µs latches the frame.
 * Byte order on the wire is GRB.
 */
export class WS2812Decoder {
  private bits: number[] = [];
  private riseAt = -1;
  private lastFall = 0;
  private level: Level = 0;
  onFrame: (pixels: [number, number, number][]) => void = () => {};

  constructor(public count: number) {}

  edge(level: Level, t: number) {
    if (level === this.level) return;
    this.level = level;
    if (level === 1) {
      if (this.bits.length && t - this.lastFall > 50_000) this.latch();
      this.riseAt = t;
    } else if (this.riseAt >= 0) {
      const high = t - this.riseAt;
      if (high < 5_000) this.bits.push(high > 550 ? 1 : 0);
      this.lastFall = t;
    }
  }

  /** Call periodically; latches a pending frame once the line has been idle low > 50 µs. */
  poll(now: number) {
    if (this.bits.length && this.level === 0 && now - this.lastFall > 50_000) this.latch();
  }

  private latch() {
    const px: [number, number, number][] = [];
    for (let i = 0; i + 24 <= this.bits.length && px.length < this.count; i += 24) {
      const byte = (o: number) => { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | this.bits[i + o + k]; return v; };
      const g = byte(0), r = byte(8), b = byte(16);
      px.push([r, g, b]);
    }
    this.bits = [];
    if (px.length) {
      while (px.length < this.count) px.push([0, 0, 0]);
      this.onFrame(px);
    }
  }
}
