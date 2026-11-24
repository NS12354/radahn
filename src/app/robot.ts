/**
 * The robot simulator: joints follow the actuators on the bench, the body
 * drives or walks, and sensors read the world.
 *
 * Each frame:
 *  1. targets: servo angle (direct or a PCA9685 channel), stepper angle, motor
 *     driver speed (wheels and continuous joints), or the teach-mode slider;
 *  2. joints move toward their target at the servo's real speed, clamped to limits;
 *     legs whose servos can't hold the body sag;
 *  3. mobility: wheels drive the body (differential drive), legs walk it (contact model);
 *  4. sensors: ultrasonic / IR distance by raycasting the world, line sensors
 *     read the floor, the IMU reads the body's tilt, encoders count wheel turns.
 */
import * as THREE from 'three';
import type { BuiltPart, BuiltModel, Joint, World } from './project';
import { BodyPose, LegContact, clampJoint, diffDrive, driveBody, footRest, forwardKinematics, onTrack, raycastWorld, restMatrix, sensorRay, wheelsOf } from './kinematics';
import { COMPONENTS, SERVO_TYPES } from '../hw/library/components';
import type { CompInstance, DeviceModel } from '../hw/types';

/** What the simulator needs from the bench. */
export interface BenchLike { model(uid: string): DeviceModel | undefined }

const SERVOS = new Set(['servo', 'mg996r']);
const MOTORS = new Set(['motor', 'fan', 'pump', 'contservo', 'tb6612', 'l298n']);
/** Output shaft speed at full drive (deg/s): ~200 RPM gear motor, ~130 RPM continuous servo. */
const MOTOR_DPS: Record<string, number> = { contservo: 780, default: 1200 };

export interface JointState { id: string; name: string; joint: Joint; q: number; target: number; driven: boolean; sag: number; torque?: number; load?: number }

export class RobotSim {
  q = new Map<string, number>();
  /** Teach mode / manual targets (used when nothing on the bench drives the joint). */
  manual = new Map<string, number>();
  body = new BodyPose();
  legs = new LegContact();
  pose = new Map<string, THREE.Matrix4>();
  joints: JointState[] = [];
  /** Distance etc. the world gives each sensor (for the bench cards). */
  readings = new Map<string, string>();
  stalled = false;
  /** ROS /cmd_vel (mm/s, rad/s): drives a wheeled robot while no firmware is running. */
  cmdVel: { v: number; w: number; t: number } | null = null;
  private wheelDeg = new Map<string, number>();
  private lastImu = { p: 0, r: 0 };

  constructor(public model: BuiltModel) { this.resync(); }

  /** The model changed (parts or joints edited): keep values for joints that still exist. */
  resync() {
    const parts = this.model.parts;
    this.joints = parts.filter(p => p.joint && p.joint.type !== 'fixed').map(p => ({ id: p.id, name: p.name, joint: p.joint!, q: this.q.get(p.id) ?? 0, target: this.manual.get(p.id) ?? 0, driven: false, sag: 0 }));
    for (const id of [...this.q.keys()]) if (!this.joints.some(j => j.id === id)) this.q.delete(id);
    this.solve();
  }
  reset() {
    this.q.clear(); this.manual.clear(); this.wheelDeg.clear(); this.body.reset(); this.legs.reset(); this.stalled = false;
    for (const j of this.joints) { j.q = 0; j.target = 0; j.sag = 0; }
    this.settle();
  }
  get spec() { return this.model.robot; }

  /** Joint target from its actuator on the bench, or null if nothing drives it (yet). */
  private target(j: Joint, comps: CompInstance[], bench: BenchLike): { q?: number; rate?: number; speed?: number } | null {
    const d = j.drive; if (!d) return null;
    const c = comps.find(x => x.uid === d.comp); if (!c) return null;
    const st = bench.model(c.uid)?.state as any; if (!st) return null;
    const sign = d.invert ? -1 : 1, off = d.offset ?? 0;
    // a servo angle (0-180) → joint value: degrees around the centre, or a slide (grippers) across the joint's travel
    const fromServo = (a: number) => (j.type === 'prismatic' ? (j.min ?? 0) + ((d.invert ? 180 - a : a) / 180) * ((j.max ?? 10) - (j.min ?? 0)) : (a - 90) * sign + off);
    if (c.type === 'pca9685') { const a = st.ch?.[d.channel ?? 0]?.angle; return a == null ? null : { q: fromServo(a) }; }
    if (SERVOS.has(c.type)) return st.pulseMs > 0.3 ? { q: fromServo(st.angle) } : null;
    if (c.type === 'stepper') return { q: (st.steps / 4096) * 360 * sign + off };
    if (MOTORS.has(c.type)) {
      const s = c.type === 'tb6612' || c.type === 'l298n' ? (d.channel === 1 ? st.b : st.a) : st.speed;
      return { speed: (s ?? 0) * sign, rate: MOTOR_DPS[c.type] ?? MOTOR_DPS.default };
    }
    return null;
  }

  /** Servo model behind a joint (for speed and torque). */
  private servoOf(j: Joint, comps: CompInstance[]) {
    const c = j.drive && comps.find(x => x.uid === j.drive!.comp);
    if (!c) return SERVO_TYPES.sg90;
    if (c.type === 'pca9685') { const s = (c.props?.servos ?? []).find((s: any) => s.ch === (j.drive!.channel ?? 0)); return SERVO_TYPES[s?.type ?? 'sg90'] ?? SERVO_TYPES.sg90; }
    return SERVO_TYPES[c.type === 'mg996r' ? 'mg996r' : 'sg90'];
  }

  step(dt: number, comps: CompInstance[], bench: BenchLike, running: boolean) {
    dt = Math.min(dt, 0.05);
    const wheelRates = new Map<string, number>();
    for (const js of this.joints) {
      const j = js.joint, t = running ? this.target(j, comps, bench) : null;
      js.driven = !!t;
      let q = this.q.get(js.id) ?? 0;
      if (t?.speed != null) {
        const rate = t.speed * t.rate!;
        if (j.type === 'wheel') wheelRates.set(js.id, rate);
        q = clampJoint(j, q + rate * dt); js.target = q;
      } else {
        const goal = clampJoint(j, t?.q ?? this.manual.get(js.id) ?? js.target);
        js.target = goal;
        const sp = j.type === 'prismatic' ? 200 : this.servoOf(j, comps).speed; // deg/s (or mm/s)
        q += Math.max(-sp * dt, Math.min(sp * dt, goal - q));
      }
      this.q.set(js.id, q); js.q = q;
      if (j.type === 'wheel') this.wheelDeg.set(js.id, q);
    }
    const spec = this.spec;
    if (spec?.mobile === 'legs') this.sag(comps);
    this.solve();
    if (spec?.mobile === 'wheels') {
      let { v, w } = diffDrive(wheelsOf(this.model.parts), wheelRates);
      const cv = this.cmdVel;
      if (!running && cv && performance.now() - cv.t < 1000) {
        ({ v, w } = cv);
        // spin the wheels to match (ground speed at each wheel / radius)
        for (const wh of wheelsOf(this.model.parts)) { const js = this.joints.find(j => j.id === wh.id); if (js) { const q = (this.q.get(wh.id) ?? 0) + ((v - w * wh.x) / wh.radius) * (180 / Math.PI) * dt * Math.sign(wh.axis.x || 1); this.q.set(wh.id, q); js.q = q; this.wheelDeg.set(wh.id, q); } }
      }
      this.stalled = !driveBody(this.body, v, w, dt, this.footprint(), spec.world) && Math.abs(v) > 1;
      this.solve();
    } else if (spec?.mobile === 'legs') {
      this.legs.step(this.body, this.feet(), this.com(), dt);
      this.solve();
    }
    this.sense(comps, bench, dt);
  }

  /** Poses without the body moving (e.g. on reset or after editing): stand on the floor. */
  settle() {
    this.solve();
    const spec = this.spec;
    if (spec?.mobile === 'legs') for (let i = 0; i < 40; i++) { this.legs.step(this.body, this.feet(), this.com(), 0.03); this.solve(); }
    else if (spec?.mobile === 'wheels') {
      const ws = wheelsOf(this.model.parts);
      const low = Math.min(...ws.map(w => w.center.y - w.radius));
      if (isFinite(low)) { this.body.m.elements[13] = -low; this.solve(); }
    }
  }

  private solve() {
    const fk = forwardKinematics(this.model.parts, id => (this.q.get(id) ?? 0) + (this.joints.find(j => j.id === id)?.sag ?? 0));
    this.pose.clear();
    for (const [id, m] of fk) this.pose.set(id, this.body.m.clone().multiply(m));
  }
  /** Feet in body space (rest → posed by the joints, without the body pose). */
  private feet() {
    const inv = this.body.m.clone().invert();
    return this.model.parts.filter(p => p.foot).map(p => ({ id: p.id, local: footRest(p).applyMatrix4(inv.clone().multiply(this.pose.get(p.id)!)) }));
  }
  /** Centre of mass in body space: part centres weighted by volume. */
  private com() {
    const inv = this.body.m.clone().invert(), c = new THREE.Vector3(); let m = 0;
    for (const p of this.model.parts) {
      const w = Math.max(1, p.size[0] * p.size[1] * p.size[2]) * (p.kind === 'internal' ? 2 : 1);
      c.add(new THREE.Vector3(...p.pos).applyMatrix4(inv.clone().multiply(this.pose.get(p.id)!)).multiplyScalar(w)); m += w;
    }
    return m ? c.divideScalar(m) : c;
  }
  private footprint() {
    let r = 0; for (const p of this.model.parts) r = Math.max(r, Math.hypot(p.pos[0], p.pos[2]) + Math.max(p.size[0], p.size[2]) / 2 * 0.6);
    return Math.max(30, r * 0.85);
  }

  /** Legs: a servo holding more than its torque gives way (the joint sags, the body drops). */
  private sag(comps: CompInstance[]) {
    const spec = this.spec!, feetIds = new Set(this.legs.contacts);
    const parts = this.model.parts, byId = new Map(parts.map(p => [p.id, p]));
    const nStance = Math.max(1, feetIds.size || parts.filter(p => p.foot).length);
    const loadKg = spec.mass / 1000 / nStance;
    for (const js of this.joints) {
      if (js.joint.type !== 'revolute') { js.sag = 0; continue; }
      // the foot below this joint (walk down the children)
      const foot = parts.find(p => p.foot && feetIds.has(p.id) && descends(p, js.id, byId));
      if (!foot) { js.sag *= 0.8; js.load = 0; continue; }
      const piv = new THREE.Vector3(...js.joint.pivot).applyMatrix4(this.pose.get(js.id) ?? new THREE.Matrix4());
      const fp = footRest(foot).applyMatrix4(this.pose.get(foot.id) ?? new THREE.Matrix4());
      const axis = new THREE.Vector3(...js.joint.axis).normalize().transformDirection(this.pose.get(js.id) ?? new THREE.Matrix4());
      // torque of the ground reaction (up) about the joint axis: |(foot − pivot) × up · axis| × weight
      const lever = Math.abs(fp.clone().sub(piv).cross(new THREE.Vector3(0, 1, 0)).dot(axis)) / 10; // cm
      const load = loadKg * lever, torque = this.servoOf(js.joint, comps).torque;
      js.load = load; js.torque = torque;
      const over = load / (torque * 0.6) - 1; // servos only hold ~60 % of their stall torque continuously
      js.sag = over > 0 ? Math.min(35, over * 25) * Math.sign(fp.clone().sub(piv).cross(new THREE.Vector3(0, 1, 0)).dot(axis) || 1) : js.sag * 0.8;
    }
  }

  /** Sensors that are parts of the model read the world. */
  private sense(comps: CompInstance[], bench: BenchLike, dt: number) {
    this.readings.clear();
    const world = this.spec?.world;
    for (const c of comps) {
      const part = this.model.parts.find(p => p.comp === c.uid && p.kind === 'internal') ?? this.model.parts.find(p => p.comp === c.uid);
      const m = bench.model(c.uid); if (!m) continue;
      const st = m.state as any;
      if ((c.type === 'hcsr04' || c.type === 'irsensor') && part && world) {
        const { o, d } = sensorRay(part, this.pose.get(part.id)!);
        const mm = raycastWorld(world, o, d);
        if (c.type === 'hcsr04') { st.cm = Math.round(Math.max(2, Math.min(400, mm / 10)) * 10) / 10; this.readings.set(c.uid, `${st.cm} cm`); }
        else { const near = mm < (c.props?.range ?? 150); if (near !== !!st.down) m.sim?.press(near); this.readings.set(c.uid, near ? 'obstacle' : 'clear'); }
      }
      if (c.type === 'line' && part && world) {
        const p = new THREE.Vector3().setFromMatrixPosition(this.pose.get(part.id)!.clone().multiply(restMatrix(part)));
        const dark = p.y < 40 && onTrack(world, p.x, p.z);
        if (dark !== !!st.down) m.sim?.press(dark);
        this.readings.set(c.uid, dark ? 'on line' : 'floor');
      }
      if (c.type === 'mpu6050' && part && this.spec?.mobile !== 'fixed') {
        const R = new THREE.Matrix4().extractRotation(this.pose.get(part.id)!);
        const up = new THREE.Vector3(0, 1, 0).applyMatrix4(R.clone().invert()); // gravity reaction in the chip frame (x fwd = +Z, y left = +X, z up = +Y)
        const ax = up.z, ay = up.x, az = up.y;
        const p = Math.asin(Math.max(-1, Math.min(1, -ax))) * 180 / Math.PI, r = Math.atan2(ay, az) * 180 / Math.PI;
        if (Math.abs(p - this.lastImu.p) > 0.05 || Math.abs(r - this.lastImu.r) > 0.05) { m.sim?.tilt(p, r); this.lastImu = { p, r }; }
        this.readings.set(c.uid, `pitch ${p.toFixed(0)}° roll ${r.toFixed(0)}°`);
      }
      if (c.type === 'encoder_wheel') {
        const wheel = this.joints.find(j => j.joint.sensors?.includes(c.uid));
        if (wheel) { m.sim?.turn(this.wheelDeg.get(wheel.id) ?? 0); this.readings.set(c.uid, `${st.edges} edges`); }
      }
    }
    void dt;
  }
}
function descends(p: BuiltPart, ancestor: string, byId: Map<string, BuiltPart>) {
  for (let q: BuiltPart | undefined = p, n = 0; q && n < 64; q = q.parent ? byId.get(q.parent) : undefined, n++) if (q.id === ancestor) return true;
  return false;
}

/** Does this model move? (any joint, or a robot spec) */
export const isRobot = (m: BuiltModel | null | undefined) => !!m && (!!m.robot || m.parts.some(p => p.joint && p.joint.type !== 'fixed'));
/** Parts driven by a component, for "what does this servo move" labels. */
export const jointsDrivenBy = (m: BuiltModel, uid: string) => m.parts.filter(p => p.joint?.drive?.comp === uid);
export type { World };
void COMPONENTS;
