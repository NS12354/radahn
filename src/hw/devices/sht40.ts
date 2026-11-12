import type { I2CTarget } from '../types';

/** Sensirion CRC-8 (poly 0x31, init 0xFF). */
export function crc8(data: number[]) {
  let crc = 0xff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/**
 * SHT40 temperature / humidity sensor (I2C 0x44).
 * Supports measure commands 0xFD/0xF6/0xE0 (high/med/low precision), serial number 0x89
 * and soft reset 0x94. Reads return T(2)+CRC, RH(2)+CRC like the real part.
 */
export class SHT40 implements I2CTarget {
  address = 0x44;
  private out: number[] = [];
  private cmd = -1;
  measurements = 0;
  constructor(private readT: () => number, private readRH: () => number) {}

  start(read: boolean) { if (!read) this.cmd = -1; }

  write(b: number) {
    this.cmd = b;
    if (b === 0xfd || b === 0xf6 || b === 0xe0) {
      const t = Math.round(((this.readT() + 45) / 175) * 65535);
      const rh = Math.round(((this.readRH() + 6) / 125) * 65535);
      const tw = [(t >> 8) & 0xff, t & 0xff], hw = [(rh >> 8) & 0xff, rh & 0xff];
      this.out = [...tw, crc8(tw), ...hw, crc8(hw)];
      this.measurements++;
    } else if (b === 0x89) {
      const s1 = [0x0c, 0x6f], s2 = [0x52, 0x1a];
      this.out = [...s1, crc8(s1), ...s2, crc8(s2)];
    } else if (b === 0x94) {
      this.out = [];
    }
    return true;
  }

  read() { return this.out.length ? (this.out.shift() as number) : 0xff; }
}
