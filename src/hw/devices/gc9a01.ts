/**
 * GC9A01 (240×240 round TFT) SPI command decoder.
 * Understands CASET (0x2A), RASET (0x2B), RAMWR (0x2C), RAMWRC (0x3C), MADCTL (0x36),
 * INVON/INVOFF, DISPON/DISPOFF and sleep commands; everything else (gamma, power
 * tables...) is accepted and ignored, like the real panel's init sequence.
 * Pixels are RGB565, big-endian on the wire. The panel itself is natively
 * inverted; init sequences send INVON (0x21) so colors appear normal.
 */
export class GC9A01Decoder {
  readonly W = 240;
  readonly H = 240;
  readonly rgba = new Uint8ClampedArray(240 * 240 * 4);
  private cmd = -1;
  private args: number[] = [];
  private x0 = 0; private x1 = 239; private y0 = 0; private y1 = 239;
  private x = 0; private y = 0;
  private hi = -1;
  displayOn = false;
  sleeping = true;
  inverted = false;
  dirty = true;
  commands = 0;
  pixelsWritten = 0;

  constructor() { for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255; }

  /** Handle one SPI byte; dc = level of the D/C line (0 = command, 1 = data). */
  byte(b: number, dc: 0 | 1) {
    if (dc === 0) { this.command(b); return; }
    if (this.cmd === 0x2c || this.cmd === 0x3c) { this.pixelByte(b); return; }
    this.args.push(b);
    if (this.cmd === 0x2a && this.args.length === 4) {
      this.x0 = (this.args[0] << 8) | this.args[1]; this.x1 = (this.args[2] << 8) | this.args[3];
    } else if (this.cmd === 0x2b && this.args.length === 4) {
      this.y0 = (this.args[0] << 8) | this.args[1]; this.y1 = (this.args[2] << 8) | this.args[3];
    }
  }

  private command(c: number) {
    this.cmd = c; this.args = []; this.commands++;
    if (c === 0x2c) { this.x = this.x0; this.y = this.y0; this.hi = -1; }
    else if (c === 0x3c) { this.hi = -1; }
    else if (c === 0x29) { this.displayOn = true; this.dirty = true; }
    else if (c === 0x28) { this.displayOn = false; this.dirty = true; }
    else if (c === 0x11) { this.sleeping = false; }
    else if (c === 0x10) { this.sleeping = true; }
    else if (c === 0x21) { this.inverted = true; this.dirty = true; }
    else if (c === 0x20) { this.inverted = false; this.dirty = true; }
  }

  private pixelByte(b: number) {
    if (this.hi < 0) { this.hi = b; return; }
    const v = (this.hi << 8) | b; this.hi = -1;
    if (this.x <= 239 && this.y <= 239) {
      const i = (this.y * 240 + this.x) * 4;
      this.rgba[i] = ((v >> 11) & 31) * 255 / 31;
      this.rgba[i + 1] = ((v >> 5) & 63) * 255 / 63;
      this.rgba[i + 2] = (v & 31) * 255 / 31;
    }
    this.pixelsWritten++;
    this.dirty = true;
    if (++this.x > this.x1) { this.x = this.x0; if (++this.y > this.y1) this.y = this.y0; }
  }

  reset() {
    this.rgba.fill(0); for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
    this.cmd = -1; this.args = []; this.displayOn = false; this.sleeping = true; this.inverted = false; this.dirty = true;
    this.x0 = this.y0 = 0; this.x1 = this.y1 = 239; this.commands = this.pixelsWritten = 0;
  }
}
