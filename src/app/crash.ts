/**
 * Crash tests: drop a robot or device, run it into a wall, or hit it with
 * something, in rigid-body physics, and see what breaks.
 *
 * The test runs in a world of its own (floor, plus the wall or the projectile)
 * from the model's current pose. A robot's servos are powered and hold their
 * angles (wheels roll freely); a device is one rigid body. Every frame the
 * impacts go to a DamageTracker, which saves damage on the model, and whatever
 * breaks takes effect straight away (a stripped servo goes limp mid-test).
 */
import * as THREE from 'three';
import { Physics, loadPhysics } from './physics';
import { DamageTracker, estimateGrams, statusOf, loadText, type DamageStatus } from './damage';
import { applyBreaks } from './robot';
import { restMatrix } from './kinematics';
import type { BuiltModel, Joint, World } from './project';

export type CrashKind = 'drop' | 'wall' | 'hit';
export type Orient = 'flat' | 'front' | 'back' | 'side' | 'upside' | 'edge' | 'corner';
export interface CrashSpec {
  kind: CrashKind;
  /** drop: height of the lowest point above the floor (mm). */
  height: number;
  /** drop: which way up it lands. */
  orient: Orient;
  /** wall / hit: speed (m/s). */
  speed: number;
  /** hit: the projectile's mass (g). */
  mass: number;
}
export const ORIENTS: Record<Orient, string> = { flat: 'Flat (as it stands)', front: 'Front face down', back: 'Back down', side: 'On its side', upside: 'Upside down', edge: 'On an edge', corner: 'On a corner' };
export const CRASH_LABEL: Record<CrashKind, string> = { drop: 'Drop test', wall: 'Into a wall', hit: 'Hit by an object' };

export interface CrashRow { key: string; name: string; what: string; status: DamageStatus; level: number; load: string; consequence: string }
export interface CrashReport { title: string; summary: string; rows: CrashRow[]; broken: number; peakG: number; peakN: number }

const MM = 0.001;
const ROT: Record<Orient, THREE.Euler> = {
  flat: new THREE.Euler(0, 0, 0), front: new THREE.Euler(Math.PI / 2, 0, 0), back: new THREE.Euler(-Math.PI / 2, 0, 0), side: new THREE.Euler(0, 0, Math.PI / 2),
  upside: new THREE.Euler(Math.PI, 0, 0), edge: new THREE.Euler(Math.PI / 4, 0, 0), corner: new THREE.Euler(Math.atan(1 / Math.SQRT2), 0, Math.PI / 4),
};

/** Every corner of every part, posed (model mm). */
function corners(model: BuiltModel, pose: Map<string, THREE.Matrix4>) {
  const out: THREE.Vector3[] = [];
  for (const p of model.parts) {
    if (p.role === 'ignore') continue;
    const M = (pose.get(p.id) ?? new THREE.Matrix4()).clone().multiply(restMatrix(p)), [a, b, c] = p.size.map(v => v / 2);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push(new THREE.Vector3(sx * a, sy * b, sz * c).applyMatrix4(M));
  }
  return out;
}

export class CrashLab {
  phys!: Physics;
  damage!: DamageTracker;
  world!: World;
  t = 0;
  duration = 3;
  done = false;
  /** The worst shock and force anything felt (for the report). */
  peakG = 0; peakN = 0;
  /** Lines for what broke, as it happens. */
  events: string[] = [];
  private acc = 0;
  private targets = new Map<string, number | { vel: number }>();
  private projectile = -1;
  private before: Record<string, number> = {};

  private constructor(public model: BuiltModel, public spec: CrashSpec) {}

  /**
   * Set up a test. pose: where every part is now (robots: the sim's pose; devices: rest).
   * compTypeOf / torqueOf: what each part stands for, and its servo's stall torque (kg·cm).
   */
  static async create(model: BuiltModel, pose: Map<string, THREE.Matrix4>, spec: CrashSpec, compTypeOf: (uid: string) => string | undefined, torqueOf: (j: Joint) => number) {
    await loadPhysics();
    const lab = new CrashLab(model, spec);
    lab.setup(pose, compTypeOf, torqueOf);
    return lab;
  }

  private setup(pose0: Map<string, THREE.Matrix4>, compTypeOf: (uid: string) => string | undefined, torqueOf: (j: Joint) => number) {
    const m = this.model, s = this.spec, wall = m.auto?.wall ?? 2;
    for (const [k, d] of Object.entries(m.damage ?? {})) this.before[k] = d.level;
    // centre the model over the origin, then place it for the test
    const pts = corners(m, pose0), box = new THREE.Box3().setFromPoints(pts), c = box.getCenter(new THREE.Vector3());
    let T = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
    // forward: where the robot faces (its root's +Z), flattened; devices face +Z
    const root = m.parts.find(p => !p.parent) ?? m.parts[0];
    const fwd = new THREE.Vector3(0, 0, 1).transformDirection(pose0.get(root?.id ?? '') ?? new THREE.Matrix4()); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1); fwd.normalize();
    if (s.kind === 'drop') T.premultiply(new THREE.Matrix4().makeRotationFromEuler(ROT[s.orient]));
    const posed = new Map([...pose0].map(([id, M]) => [id, T.clone().multiply(M)]));
    for (const p of m.parts) if (!posed.has(p.id)) posed.set(p.id, T.clone());
    const lift = s.kind === 'drop' ? s.height : s.kind === 'wall' && !m.robot ? 300 : 0; // a device is thrown at the wall
    const minY = Math.min(...corners(m, posed).map(v => v.y));
    const up = new THREE.Matrix4().makeTranslation(0, lift - minY + 0.5, 0);
    for (const [id, M] of posed) posed.set(id, up.clone().multiply(M));
    const placed = new THREE.Box3().setFromPoints(corners(m, posed)), size = placed.getSize(new THREE.Vector3()), mid = placed.getCenter(new THREE.Vector3());
    const reach = Math.abs(size.x * fwd.x) / 2 + Math.abs(size.z * fwd.z) / 2;
    const yaw = Math.round(Math.atan2(fwd.x, fwd.z) * 180 / Math.PI);
    // the test world
    const obstacles: World['obstacles'] = [];
    if (s.kind === 'wall') obstacles.push({ shape: 'box', pos: [mid.x + fwd.x * (reach + 150), mid.z + fwd.z * (reach + 150)], size: [1200, 600, 80], rot: yaw, material: 'fixed', color: '#b8bec7', name: 'Wall' });
    if (s.kind === 'hit') { obstacles.push({ shape: 'cyl', pos: [mid.x + fwd.x * (reach + 260), mid.z + fwd.z * (reach + 260)], size: [50, 50, 50], material: 'metal', mass: s.mass, color: '#5f6368', name: 'Projectile' }); this.projectile = 0; }
    this.world = { size: 4000, obstacles };
    // a free body in a world of its own; a device gets an estimated weight
    const spec = { ...(m.robot ?? { kind: 'custom' as const, mass: estimateGrams(m, wall) }), mobile: 'legs' as const, world: this.world, physics: true };
    this.phys = new Physics({ ...m, robot: spec }, posed, torqueOf);
    this.damage = new DamageTracker(m, compTypeOf, torqueOf, wall);
    applyBreaks(this.phys, this.damage, this.damage.brokenKeys());
    // powered servos hold where they are; wheels roll
    for (const [id, q] of this.phys.measured()) { const pj = this.phys.joints.find(j => j.id === id)!; if (pj.joint.type !== 'wheel') this.targets.set(id, q); }
    const v = new THREE.Vector3();
    if (s.kind === 'wall') v.copy(fwd).multiplyScalar(s.speed);
    for (const b of this.phys.bodies()) b.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    if (s.kind === 'hit') {
      const mv = this.phys.pw.movable[0];
      const start = new THREE.Vector3(mid.x + fwd.x * (reach + 260), mid.y, mid.z + fwd.z * (reach + 260)).multiplyScalar(MM);
      mv.body.setTranslation(start, true);
      mv.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fwd.x, fwd.z))), true);
      const dir = mid.clone().multiplyScalar(MM).sub(start).normalize().multiplyScalar(s.speed);
      mv.body.setLinvel({ x: dir.x, y: dir.y + 0.5 * 9.81 * (0.26 / s.speed), z: dir.z }, true); // aimed a little high to allow for the drop on the way
    }
    this.phys.resetShock();
    const travel = s.kind === 'drop' ? Math.sqrt((2 * s.height * MM) / 9.81) : s.kind === 'wall' ? (lift ? 0.4 : 0.15 / Math.max(0.05, s.speed)) : 0.26 / Math.max(0.2, s.speed);
    this.duration = Math.min(6, travel + 1.6);
  }

  /** Advance in fixed 1/120 s steps (deterministic whatever the frame rate). Returns true when finished. */
  step(dt: number) {
    if (this.done) return true;
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= 1 / 120 && n++ < 6) {
      this.acc -= 1 / 120; this.t += 1 / 120;
      this.phys.step(1 / 120, this.targets);
      const imp = this.phys.impacts();
      for (const g of imp.shock.values()) this.peakG = Math.max(this.peakG, g);
      for (const f of imp.force.values()) this.peakN = Math.max(this.peakN, f);
      const broke = this.damage.apply(imp);
      if (broke.length) { applyBreaks(this.phys, this.damage, broke); this.events.push(...broke.map(k => this.damage.describe(k))); }
      if (this.t >= this.duration) { this.done = true; break; }
    }
    return this.done;
  }
  /** Run to the end without drawing (tests, or "skip"). */
  finish() { while (!this.step(1 / 30)); return this.report(); }

  pose() { return this.phys.pose(); }
  objectPoses() { return new Map(this.phys.movables().map(mv => [mv.index, new THREE.Matrix4().compose(new THREE.Vector3(...mv.pos), new THREE.Quaternion(...mv.quat), new THREE.Vector3(1, 1, 1))])); }

  report(): CrashReport {
    const s = this.spec, d = this.damage, st = d.state;
    const title = s.kind === 'drop' ? `${(s.height / 1000).toFixed(s.height % 100 ? 2 : 1)} m drop, ${ORIENTS[s.orient].toLowerCase()}` : s.kind === 'wall' ? `Into a wall at ${s.speed} m/s` : `Hit by ${s.mass} g at ${s.speed} m/s`;
    const rows: CrashRow[] = [];
    for (const [key, pd] of Object.entries(st)) {
      const rt = d.ratings.get(key); if (!rt) continue;
      rows.push({ key, name: d.names.get(key) ?? key, what: rt.what, status: statusOf(pd.level), level: pd.level, load: loadText(pd.worst), consequence: pd.level >= 1 ? consequence(rt.effect, rt.fails) : pd.level >= 0.8 ? 'Still works, but weakened: another hit could break it' : pd.level >= 0.5 ? 'Scuffed, works fine' : 'Fine' });
    }
    rows.sort((a, b) => b.level - a.level);
    const shown = rows.filter(r => r.level >= 0.5);
    const broken = shown.filter(r => r.status === 'broken').length, damaged = shown.filter(r => r.status === 'damaged').length;
    const fresh = shown.filter(r => r.level > (this.before[r.key] ?? 0) + 1e-3).length;
    const summary = broken ? `${broken} part${broken > 1 ? 's' : ''} broke${damaged ? `, ${damaged} more damaged` : ''}.` : damaged ? `Nothing broke; ${damaged} part${damaged > 1 ? 's' : ''} damaged.` : shown.length ? 'Survived: only scuffs.' : 'Survived without a scratch.';
    return { title, summary: summary + (fresh < shown.length && shown.length ? ' (includes damage from earlier tests)' : ''), rows: shown, broken, peakG: Math.round(this.peakG), peakN: Math.round(this.peakN) };
  }
  dispose() { this.phys?.dispose(); }
}

function consequence(effect: string, fails: string) {
  const more: Record<string, string> = { 'no-power': ': nothing runs without it', screen: ': the display is unreadable', hazard: '' };
  return fails[0].toUpperCase() + fails.slice(1) + (more[effect] ?? '');
}
