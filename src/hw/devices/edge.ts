import type { Level } from '../types';

/**
 * Measures a digital signal from its edges in emulated time: frequency, duty cycle
 * and steady level. Used for buzzer tones, servo pulses and LED dimming.
 */
export class EdgeMeter {
  level: Level = 0;
  private lastRise = -1;
  private lastFall = -1;
  private lastEdge = 0;
  periodNs = 0;
  highNs = 0;

  edge(level: Level, t: number) {
    if (level === this.level) return;
    if (level === 1) {
      if (this.lastRise >= 0) this.periodNs = t - this.lastRise;
      this.lastRise = t;
    } else {
      if (this.lastRise >= 0) this.highNs = t - this.lastRise;
      this.lastFall = t;
    }
    this.level = level;
    this.lastEdge = t;
  }

  /** True if the signal has toggled recently enough to be treated as PWM. */
  isPwm(now: number) {
    return this.periodNs > 0 && now - this.lastEdge < Math.max(3 * this.periodNs, 50e6);
  }
  freq(now: number) { return this.isPwm(now) ? 1e9 / this.periodNs : 0; }
  duty(now: number) {
    if (this.isPwm(now)) return Math.max(0, Math.min(1, this.highNs / this.periodNs));
    return this.level;
  }
  pulseMs(now: number) { return this.isPwm(now) ? this.highNs / 1e6 : 0; }
  reset() { this.level = 0; this.lastRise = this.lastFall = -1; this.periodNs = this.highNs = 0; }
}
