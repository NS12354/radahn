/**
 * Damage: what an impact does to each part of a robot or device.
 *
 * The physics reports, per frame, the peak contact force on every part (N), the
 * deceleration every part felt (g), and the twist contacts put on every joint
 * (N·m). Each part has ratings for those, from what it is:
 *
 *   glass displays and sensor transducers crack under shock and point loads,
 *   PCBs (solder joints, ceramic capacitors) fail under shock,
 *   Li-ion cells are crushed or punctured (a fire risk, not just a dead part),
 *   enclosures crack under impact force, more easily with thin walls,
 *   servo gears strip when an impact twists the joint past their strength,
 *   brackets, wheels and fingers bend or snap off.
 *
 * Damage is the worst load as a fraction of the rating, plus fatigue: every
 * hard knock (over half the rating) adds a little, so repeated hits wear a part
 * out. Under 50 % nothing shows; 50–80 % is a knock; 80–100 % is damaged (it still
 * works, weakened); at 100 % it's broken and the consequence applies. Damage is
 * saved with the model until it's repaired.
 *
 * The numbers are engineering ballparks for hobby hardware, not a substitute for
 * a real drop test, and a rigid-body impact is shorter and harder than one with
 * give in it, so treat results as "likely" rather than certain.
 */
import type { BuiltModel, BuiltPart, Joint } from './project';
import type { Impacts } from './physics';

export type Effect = 'cosmetic' | 'limp' | 'detach' | 'dead-sensor' | 'no-power' | 'screen' | 'hazard';
export type DamageStatus = 'ok' | 'knock' | 'damaged' | 'broken';
export interface Rating {
  /** What it is, for the report: 'Servo gears (MG996R, metal)', 'Display glass' … */
  what: string;
  /** Contact force it takes (N), shock (g), and for joints the twist on the gears (N·m). */
  forceN?: number; shockG?: number; twistNm?: number;
  /** What happens when it breaks. */
  effect: Effect;
  /** The failure in words: 'the gears strip', 'the glass cracks' … */
  fails: string;
}
export interface PartDamage {
  /** 0 = new, 1 = broken (can go past 1). */
  level: number;
  status: DamageStatus;
  /** The worst single load, and how it compared to the rating. */
  worst: { kind: 'force' | 'shock' | 'twist'; value: number; rating: number };
  hits: number;
}

const DISPLAYS = new Set(['gc9a01', 'ssd1306', 'lcd1602', 'st7789', 'ili9341', 'tm1637', 'oled', 'epaper']);
const SENSORS = new Set(['hcsr04', 'irsensor', 'line', 'mpu6050', 'aht20', 'bh1750', 'sht40', 'pir', 'ldr', 'tmp36', 'gas', 'soil', 'fsr', 'encoder_wheel', 'touch', 'joystick']);
const DRIVERS = new Set(['pca9685', 'tb6612', 'l298n']);
const KGCM = 0.0980665;

/** A key for joint (gear) damage, separate from the link part's own structure. */
export const jointKey = (id: string) => `joint:${id}`;

/**
 * What a part can take. compType: the electronics component type it stands for (if any);
 * torque: stall torque of the servo driving a joint (kg·cm); wall: enclosure wall (mm).
 */
export function ratingOf(p: BuiltPart, compType: string | undefined, wall = 2): Rating {
  const d = p.detail ?? '', name = p.name;
  if (p.kind === 'shell') return { what: `Enclosure (${wall} mm walls)`, forceN: Math.round(260 * wall ** 1.5), shockG: 8000, effect: 'cosmetic', fails: 'the housing cracks' };
  if (d.startsWith('servo:')) return { what: `Servo case (${d.slice(6).toUpperCase()})`, forceN: 900, shockG: 400, effect: 'limp', fails: 'the case cracks and the servo stops' };
  if (p.role === 'screen' || (compType && DISPLAYS.has(compType)) || /\b(lcd|oled|tft)\b/i.test(name))
    return { what: 'Display glass', forceN: 200, shockG: 220, effect: 'screen', fails: 'the glass cracks' };
  if (d.startsWith('pcb:') || p.comp === 'board' || /\bpcb\b/i.test(name))
    return { what: 'Circuit board (solder joints)', forceN: 350, shockG: 600, effect: 'no-power', fails: 'solder joints crack and it stops working' };
  if (d === 'battery' || /batter|lipo|18650/i.test(name))
    return { what: 'Li-ion battery', forceN: 300, shockG: 500, effect: 'hazard', fails: 'the cell is dented or punctured: unsafe to use' };
  if (d.startsWith('module:') || (compType && p.kind === 'internal')) {
    const t = compType ?? d.slice(7);
    if (t === 'hcsr04' || /hcsr04/.test(d)) return { what: 'Ultrasonic transducers', forceN: 400, shockG: 900, effect: 'dead-sensor', fails: 'a transducer cracks and it stops reading' };
    if (DRIVERS.has(t) || /tb6612|l298n|pca9685/.test(d)) return { what: 'Driver board', forceN: 350, shockG: 600, effect: 'no-power', fails: 'the board cracks and the motors stop' };
    if (SENSORS.has(t) || /tcrt|mpu|imu/.test(d)) return { what: 'Sensor module', forceN: 200, shockG: 500, effect: 'dead-sensor', fails: 'it stops reading' };
    return { what: 'Electronics module', forceN: 250, shockG: 500, effect: 'cosmetic', fails: 'it cracks' };
  }
  if (d === 'motor') return { what: 'Gear motor', forceN: 500, shockG: 400, effect: 'limp', fails: 'the gearbox breaks and the wheel stops driving' };
  if (d === 'wheel') return { what: 'Wheel hub', forceN: 1200, shockG: 3000, effect: 'detach', fails: 'the hub splits and the wheel comes off' };
  if (d === 'finger') return { what: 'Gripper finger', forceN: 300, shockG: 4000, effect: 'detach', fails: 'the finger snaps off' };
  if (d === 'link') return { what: 'Aluminium bracket', forceN: 2600, shockG: 6000, effect: 'detach', fails: 'the bracket bends and the joint comes apart' };
  if (d === 'foot' || d === 'caster') return { what: d === 'foot' ? 'Rubber foot' : 'Caster', forceN: 2500, shockG: 8000, effect: 'cosmetic', fails: 'it splits' };
  if (d === 'shell' || d === 'head') return { what: '3D-printed shell', forceN: 700, shockG: 8000, effect: 'cosmetic', fails: 'it cracks' };
  if (p.kind === 'internal') return { what: 'Internal part', forceN: 300, shockG: 600, effect: 'cosmetic', fails: 'it breaks' };
  return { what: 'Structure', forceN: 1500, shockG: 8000, effect: p.joint && p.joint.type !== 'fixed' ? 'detach' : 'cosmetic', fails: p.joint && p.joint.type !== 'fixed' ? 'it snaps off at the joint' : 'it cracks' };
}

/** The gears of a servo-driven joint: plastic gears strip at ~2.5× stall torque, metal at ~3.5×. */
export function gearRating(torqueKgcm: number): Rating {
  const metal = torqueKgcm >= 3;
  return { what: `Servo gears (${torqueKgcm} kg·cm, ${metal ? 'metal' : 'plastic'})`, twistNm: torqueKgcm * KGCM * (metal ? 3.5 : 2.5), effect: 'limp', fails: 'the gears strip and the joint goes limp' };
}

export const statusOf = (level: number): DamageStatus => (level >= 1 ? 'broken' : level >= 0.8 ? 'damaged' : level >= 0.5 ? 'knock' : 'ok');

export class DamageTracker {
  ratings = new Map<string, Rating>();
  names = new Map<string, string>();
  /** Joint keys → the joint's head part id (whose joint it is). */
  jointPart = new Map<string, string>();
  private inHit = new Set<string>();
  constructor(public model: BuiltModel, compTypeOf: (uid: string) => string | undefined, torqueOf: (j: Joint) => number, wall = 2) {
    for (const p of model.parts) {
      if (p.role === 'ignore' || p.shape === 'rect') continue;
      this.ratings.set(p.id, ratingOf(p, p.comp ? compTypeOf(p.comp) : undefined, wall));
      this.names.set(p.id, p.name);
      if (p.joint?.type === 'revolute' && p.joint.drive) {
        const t = torqueOf(p.joint);
        if (t > 0) { const k = jointKey(p.id); this.ratings.set(k, gearRating(t)); this.names.set(k, `${p.name} joint`); this.jointPart.set(k, p.id); }
      }
    }
  }
  get state(): Record<string, PartDamage> { return this.model.damage ?? {}; }

  /** Take one frame's impacts. Returns the keys that broke just now. */
  apply(imp: Impacts): string[] {
    const broke: string[] = [];
    const loads = new Map<string, { kind: 'force' | 'shock' | 'twist'; value: number; rating: number; r: number }>();
    const consider = (key: string, kind: 'force' | 'shock' | 'twist', value: number) => {
      const rt = this.ratings.get(key); if (!rt) return;
      const rating = kind === 'force' ? rt.forceN : kind === 'shock' ? rt.shockG : rt.twistNm;
      if (!rating) return;
      const r = value / rating, cur = loads.get(key);
      if (!cur || r > cur.r) loads.set(key, { kind, value, rating, r });
    };
    for (const [id, F] of imp.force) consider(id, 'force', F);
    for (const [id, g] of imp.shock) consider(id, 'shock', g);
    for (const [id, nm] of imp.twist) consider(jointKey(id), 'twist', nm);
    for (const key of this.ratings.keys()) {
      const l = loads.get(key);
      if (!l || l.r < 0.5) { this.inHit.delete(key); continue; }
      const st = this.state[key] ?? { level: 0, status: 'ok' as DamageStatus, worst: { kind: l.kind, value: 0, rating: l.rating }, hits: 0 };
      const was = st.level;
      const fresh = !this.inHit.has(key); // a new knock, not the same one continuing
      this.inHit.add(key);
      st.level = Math.max(st.level, l.r) + (fresh && st.level > 0 ? 0.08 * l.r : 0);
      if (fresh) st.hits++;
      if (l.r > st.worst.value / st.worst.rating) st.worst = { kind: l.kind, value: Math.round(l.value * 10) / 10, rating: Math.round(l.rating * 10) / 10 };
      st.level = Math.round(st.level * 1000) / 1000;
      st.status = statusOf(st.level);
      (this.model.damage ??= {})[key] = st;
      if (was < 1 && st.level >= 1) broke.push(key);
    }
    return broke;
  }
  broken(key: string) { return (this.state[key]?.level ?? 0) >= 1; }
  /** Everything that's broken now, with its rating. */
  brokenKeys() { return Object.keys(this.state).filter(k => this.broken(k) && this.ratings.has(k)); }
  /** One line for a broken / damaged part: 'Forearm joint: the gears strip and the joint goes limp (3.4 N·m on 3.2 N·m gears)'. */
  describe(key: string) {
    const st = this.state[key], rt = this.ratings.get(key); if (!st || !rt) return '';
    return `${this.names.get(key) ?? key}: ${st.level >= 1 ? rt.fails : `${rt.what.toLowerCase()} took a hit`} (${loadText(st.worst)})`;
  }
}

export function loadText(w: PartDamage['worst']) {
  const u = w.kind === 'force' ? ' N' : w.kind === 'shock' ? ' g' : ' N·m';
  const what = w.kind === 'force' ? 'impact' : w.kind === 'shock' ? 'shock' : 'twist';
  const f = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
  return `${f(w.value)}${u} ${what}, rated ${f(w.rating)}${u}`;
}

/**
 * A device's weight when nothing says otherwise (g): shells by their wall area, electronics
 * by type, everything else by volume.
 */
export function estimateGrams(model: BuiltModel, wall = 2): number {
  let g = 0;
  for (const p of model.parts) {
    if (p.role === 'ignore') continue;
    const [a, b, c] = p.size, vol = a * b * c / 1000; // cm³
    const d = p.detail ?? '';
    if (p.kind === 'shell') g += 2 * (a * b + b * c + a * c) / 100 * (wall / 10) * 1.1;          // PC/ABS walls
    else if (d === 'battery' || /batter|lipo|18650/i.test(p.name)) g += vol * 2.4;
    else if (d.startsWith('pcb:') || p.comp === 'board' || p.role === 'screen' || d.startsWith('module:')) g += vol * 1.6;
    else if (d.startsWith('servo:')) g += 40;
    else g += vol * (p.kind === 'internal' ? 1.2 : 0.35);                                           // printed parts are mostly infill
  }
  return Math.max(20, Math.round(g));
}
