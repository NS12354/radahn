import type { BoardDef, CompInstance, DeviceModel, Env, I2CTarget, Level, ProductIO, Runtime } from './types';
import { COMPONENTS } from './library/components';
import { pinLabel } from './library/boards';
import { buildPinMap } from './checks';

interface Slot { c: CompInstance; model: DeviceModel; bound: boolean; /** signals from the code: pin changes, SPI bytes, I2C and analog reads */ act: number }

/**
 * The virtual bench: device models for every wired component, routed to
 * whichever runtime (emulator, behavioral sim, or real board) is attached.
 * Runtimes call pin()/spi()/i2c()/adc(); devices call back through setInput().
 */
export class Bench {
  slots = new Map<string, Slot>();
  pinMap = new Map<number, { c: CompInstance; role: string }[]>();
  runtime: Runtime | null = null;
  /** Input levels devices want on MCU pins (applied when a runtime attaches). */
  inputs = new Map<number, Level>();
  private warned = new Set<string>();
  onLog: (msg: string, level?: 'w' | 'e') => void = () => {};
  onChange: () => void = () => {};

  constructor(public board: BoardDef, public env: Env, public product: ProductIO | null) {}

  label(g: number) { return pinLabel(this.board, g); }

  /** (Re)build device models from the project's component list. */
  load(board: BoardDef, comps: CompInstance[]) {
    this.board = board;
    this.slots.clear();
    this.pinMap = buildPinMap(comps);
    const firstOfType = new Map<string, string>();
    for (const c of comps) if (!firstOfType.has(c.type)) firstOfType.set(c.type, c.uid);
    for (const c of comps) {
      const def = COMPONENTS[c.type];
      if (!def) continue;
      const bound = !!def.binds && firstOfType.get(c.type) === c.uid;
      const slot: Slot = { c, bound, model: null as any, act: 0 };
      slot.model = def.create({
        comp: c, def,
        setInput: (role, level) => { const g = c.pins[role]; if (g != null) this.drive(g, level); },
        schedule: (ns, fn) => (this.runtime ? this.runtime.schedule(ns, fn) : setTimeout(fn, ns / 1e6)),
        now: () => (this.runtime ? this.runtime.now() : performance.now() * 1e6),
        product: this.product,
        isBound: () => slot.bound,
        env: this.env,
        log: (m, l) => this.warn(c.uid + m, m, l),
        readPin: role => { const g = c.pins[role]; return g == null || !this.runtime ? 1 : this.runtime.readOutput(g); },
      });
      this.slots.set(c.uid, slot);
    }
    this.reset();
  }

  reset() {
    this.inputs.clear(); this.warned.clear();
    for (const s of this.slots.values()) s.act = 0;
    for (const s of this.slots.values()) s.model.reset?.();
  }

  attach(rt: Runtime | null) {
    this.runtime = rt;
    if (rt) for (const [g, l] of this.inputs) rt.setInput(g, l);
  }

  warn(key: string, msg: string, level: 'w' | 'e' = 'w') {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onLog('[sim] ' + msg, level);
  }

  private drive(g: number, level: Level) {
    this.inputs.set(g, level);
    this.runtime?.setInput(g, level);
  }

  /** MCU drove pin g to `level` at emulated time tNs. */
  pin(g: number, level: Level, tNs: number) {
    const users = this.pinMap.get(g);
    if (!users) return;
    for (const u of users) { const s = this.slots.get(u.c.uid); if (s) { s.act++; s.model.onPin?.(u.role, level, tNs); } }
  }

  /** Route one SPI byte by the pins currently muxed as SCK/MOSI. */
  spi(sck: number, mosi: number, byte: number): number {
    for (const s of this.slots.values()) {
      if (s.c.pins.SCK === sck && s.c.pins.MOSI === mosi && s.model.onSpi) { s.act++; return (s.model.onSpi(byte) as number) ?? 0xff; }
    }
    this.warn('spi' + sck + mosi, `SPI traffic on SCK ${this.label(sck)} / MOSI ${this.label(mosi)}, but no device is wired there.`);
    return 0xff;
  }

  /** Find the I2C target at `address` on the bus formed by sda/scl. */
  i2c(sda: number, scl: number, address: number): I2CTarget | null {
    for (const s of this.slots.values()) {
      if (s.model.i2c && s.c.pins.SDA === sda && s.c.pins.SCL === scl && s.model.i2c.address === address) { s.act++; return s.model.i2c; }
    }
    this.warn('i2c' + sda + scl + address, `I2C device 0x${address.toString(16)} not found on SDA ${this.label(sda)} / SCL ${this.label(scl)} (NACK).`);
    return null;
  }

  /** Voltage on an analog-capable pin. */
  adc(g: number): number {
    const users = this.pinMap.get(g);
    if (users) for (const u of users) { const s = this.slots.get(u.c.uid)!; if (s.model.adc) { s.act++; return s.model.adc(u.role); } }
    return Math.random() * 0.2; // floating input picks up noise
  }

  frame(dt: number) { for (const s of this.slots.values()) s.model.frame?.(dt); }

  /** First bound model of a type (the one wired to the 3D product). */
  bound(type: string): Slot | undefined {
    for (const s of this.slots.values()) if (s.c.type === type && s.bound) return s;
    return undefined;
  }
  model(uid: string) { return this.slots.get(uid)?.model; }
  activity(uid: string) { return this.slots.get(uid)?.act ?? 0; }
}
