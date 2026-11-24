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
 *     read the floor, the IMU reads the body's tilt, encoders count wheel turns;
 *  5. grippers: two fingers on one actuator stop at a pickable block between
 *     them, and while both press on it the block moves with the hand. Opened,
 *     it falls onto whatever is below.
 */
import * as THREE from 'three';
import type { BuiltPart, BuiltModel, Joint, World } from './project';
import { BodyPose, LegContact, clampJoint, diffDrive, driveBody, footRest, forwardKinematics, onTrack, raycastWorld, restMatrix, sensorRay, wheelsOf } from './kinematics';
import { COMPONENTS, SERVO_TYPES } from '../hw/library/components';
import { Physics, loadPhysics, physicsReady } from './physics';
import type { CompInstance, DeviceModel } from '../hw/types';

/** What the simulator needs from the bench. */
export interface BenchLike { model(uid: string): DeviceModel | undefined }

const SERVOS = new Set(['servo', 'mg996r']);
const MOTORS = new Set(['motor', 'fan', 'pump', 'contservo', 'tb6612', 'l298n']);
/** Output shaft speed at full drive (deg/s): ~200 RPM gear motor, ~130 RPM continuous servo. */
const MOTOR_DPS: Record<string, number> = { contservo: 780, default: 1200 };

/** Two prismatic fingers driven by the same actuator, on the same parent. */
interface Gripper { a: BuiltPart; b: BuiltPart; parent: string }
/** A pickable block in the world: pose in world mm, and the hand holding it (pose relative to the hand). */
export interface WorldObject { index: number; size: THREE.Vector3; shape: 'box' | 'cyl'; m: THREE.Matrix4; vy: number; held?: { by: string; rel: THREE.Matrix4; sim?: RobotSim } }

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
  /** Pickable blocks (world obstacles with pick: true). */
  objects: WorldObject[] = [];
  private objSig = '';
  /**
   * Scenes: the shared world (instead of the model's own), the shared blocks (the scene
   * makes them fall), other robots as obstacles, and where this robot stands (its home pose).
   */
  sceneWorld?: World;
  sharedObjects = false;
  others: World['obstacles'] = [];
  home = new THREE.Matrix4();
  private grippers: Gripper[] = [];
  private wheelDeg = new Map<string, number>();
  /** Rigid-body physics, when on (spec.physics) and loaded. */
  phys: Physics | null = null;
  /** Servo commands after slew (what the firmware asked for), separate from the measured q under physics. */
  private cmd = new Map<string, number>();
  private comps: CompInstance[] = [];
  private lastImu = { p: 0, r: 0 };

  constructor(public model: BuiltModel) { this.resync(); }

  /** The model changed (parts or joints edited): keep values for joints that still exist. */
  resync() {
    const parts = this.model.parts;
    this.joints = parts.filter(p => p.joint && p.joint.type !== 'fixed').map(p => ({ id: p.id, name: p.name, joint: p.joint!, q: this.q.get(p.id) ?? 0, target: this.manual.get(p.id) ?? 0, driven: false, sag: 0 }));
    for (const id of [...this.q.keys()]) if (!this.joints.some(j => j.id === id)) this.q.delete(id);
    this.grippers = findGrippers(parts);
    this.syncObjects();
    this.solve();
  }
  /** Put the pickable blocks where the world says (when the world changed, or on reset). */
  private syncObjects(force = false) {
    if (this.sharedObjects) return;
    const obs = this.world?.obstacles ?? [];
    const sig = JSON.stringify(obs);
    if (!force && sig === this.objSig) return;
    this.objSig = sig;
    this.objects = makeObjects(this.world);
  }
  /** The world this robot is in: its scene's, or its own. */
  get world(): World | undefined { return this.sceneWorld ?? this.spec?.world; }
  /** What wheels bump into and sensors see: fixed obstacles, blocks where they are now, other robots. */
  private senseWorld(): World | undefined {
    const w = this.world; if (!w) return w;
    if (!this.objects.length && !this.others.length) return w;
    const blocks = this.objects.map(o => { const p = new THREE.Vector3().setFromMatrixPosition(o.m); return { shape: o.shape, pos: [p.x, p.z] as [number, number], size: [o.size.x, p.y + o.size.y / 2, o.size.z] as [number, number, number] }; });
    return { ...w, obstacles: [...w.obstacles.filter(o => !o.pick), ...blocks, ...this.others] };
  }
  /** Rough radius of the robot's footprint (mm), for bumping into other robots. */
  radius() { return this.footprint(); }
  /** World pose of each pickable block, by obstacle index (for drawing). */
  objectPoses() { return new Map(this.objects.map(o => [o.index, o.m])); }
  /** Is a gripper holding something? */
  get holding() { return this.objects.some(o => o.held); }
  reset() {
    this.q.clear(); this.manual.clear(); this.wheelDeg.clear(); this.body.reset(); this.body.m.copy(this.home); this.legs.reset(); this.stalled = false;
    for (const j of this.joints) { j.q = 0; j.target = 0; j.sag = 0; }
    this.syncObjects(true);
    this.cmd.clear();
    this.settle();
    this.rebuildPhysics();
  }
  get spec() { return this.model.robot; }

  /** Switch rigid-body physics on (loads the engine) or off. Starts from the current pose. */
  async setPhysics(on: boolean, comps: CompInstance[] = this.comps) {
    this.phys?.dispose(); this.phys = null;
    if (!on || !this.spec) return;
    await loadPhysics();
    this.comps = comps;
    this.solve();
    this.phys = this.makePhysics();
  }
  private makePhysics() {
    const p = new Physics(this.model, this.pose, j => (j.drive ? this.servoOf(j, this.comps).torque : 0));
    for (const js of this.joints) this.cmd.set(js.id, js.q);
    return p;
  }
  /** Rebuild physics from the current pose (after reset or a model edit). */
  private rebuildPhysics() { if (this.phys && physicsReady()) { this.phys.dispose(); this.phys = this.makePhysics(); } }

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
    this.comps = comps;
    if (this.phys) return this.stepPhysics(dt, comps, bench, running);
    const wheelRates = new Map<string, number>();
    const before = new Map(this.q);
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
    if (this.grippers.length && this.objects.length) { this.grip(before); this.solve(); }
    if (spec?.mobile === 'wheels') {
      let { v, w } = diffDrive(wheelsOf(this.model.parts), wheelRates);
      const cv = this.cmdVel;
      if (!running && cv && performance.now() - cv.t < 1000) {
        ({ v, w } = cv);
        // spin the wheels to match (ground speed at each wheel / radius)
        for (const wh of wheelsOf(this.model.parts)) { const js = this.joints.find(j => j.id === wh.id); if (js) { const q = (this.q.get(wh.id) ?? 0) + ((v - w * wh.x) / wh.radius) * (180 / Math.PI) * dt * Math.sign(wh.axis.x || 1); this.q.set(wh.id, q); js.q = q; this.wheelDeg.set(wh.id, q); } }
      }
      this.stalled = !driveBody(this.body, v, w, dt, this.footprint(), this.senseWorld()) && Math.abs(v) > 1;
      this.solve();
    } else if (spec?.mobile === 'legs') {
      this.legs.step(this.body, this.feet(), this.com(), dt);
      this.solve();
    }
    this.carry(dt);
    this.sense(comps, bench, dt);
  }

  /**
   * Fingers that close on a block stop at its faces. Worked in the hand's rest space,
   * where the fingers slide along their joint axes. A finger already inside a block
   * before this frame (it came down onto it closed) passes through instead.
   */
  private grip(before: Map<string, number>) {
    for (const g of this.grippers) {
      const key = g.a.id, hand = this.pose.get(g.parent); if (!hand) continue;
      const inv = hand.clone().invert();
      const at = (f: BuiltPart, q: number) => new THREE.Vector3(...f.pos).addScaledVector(new THREE.Vector3(...f.joint!.axis).normalize(), q);
      const qa = this.q.get(g.a.id) ?? 0, qb = this.q.get(g.b.id) ?? 0;
      let pressing: WorldObject | null = null;
      for (const o of this.objects) {
        if (o.held && (o.held.by !== key || (o.held.sim ?? this) !== this)) continue;
        const rest = o.held ? o.held.rel.clone() : inv.clone().multiply(o.m), c = new THREE.Vector3().setFromMatrixPosition(rest), oq = new THREE.Quaternion().setFromRotationMatrix(rest);
        const pen = (qa: number, qb: number) => {
          const ca = at(g.a, qa), cb = at(g.b, qb), dist = ca.distanceTo(cb); if (dist < 1e-6) return null;
          const u = cb.clone().sub(ca).divideScalar(dist);
          const ta = halfAlong(g.a, u), tb = halfAlong(g.b, u), w = halfOf(o, u, oq), t = c.clone().sub(ca).dot(u);
          if (t <= ta || t >= dist - tb) return null; // not between the fingers
          // the block must overlap the fingers' faces (not just sit on the line between them)
          const local = c.clone().sub(ca).applyQuaternion(restQuat(g.a).invert()), ul = u.clone().applyQuaternion(restQuat(g.a).invert());
          const close = Math.abs(ul.x) >= Math.abs(ul.y) && Math.abs(ul.x) >= Math.abs(ul.z) ? 0 : Math.abs(ul.y) >= Math.abs(ul.z) ? 1 : 2;
          for (let k = 0; k < 3; k++) {
            if (k === close) continue;
            const dir = new THREE.Vector3().setComponent(k, 1).applyQuaternion(restQuat(g.a));
            if (Math.abs(local.getComponent(k)) > g.a.size[k] / 2 + halfOf(o, dir, oq) - 2) return null;
          }
          return { a: ta - (t - w), b: t + w - (dist - tb), ua: new THREE.Vector3(...g.a.joint!.axis).normalize().dot(u), ub: -new THREE.Vector3(...g.b.joint!.axis).normalize().dot(u) };
        };
        const now = pen(qa, qb); if (!now) { if (o.held) this.release(o); continue; }
        const was = pen(before.get(g.a.id) ?? qa, before.get(g.b.id) ?? qb);
        if (!o.held && was && (was.a > 0.5 || was.b > 0.5)) continue; // already inside it: passing through
        let na = qa, nb = qb;
        if (now.a > 0 && now.ua > 1e-3) na = Math.max(g.a.joint!.min ?? -Infinity, qa - now.a / now.ua);
        if (now.b > 0 && now.ub > 1e-3) nb = Math.max(g.b.joint!.min ?? -Infinity, qb - now.b / now.ub);
        for (const [f, q] of [[g.a, na], [g.b, nb]] as const) { this.q.set(f.id, q); const js = this.joints.find(j => j.id === f.id); if (js) js.q = q; }
        if (now.a > -0.05 && now.b > -0.05) { pressing = o; if (!o.held) { o.held = { by: key, rel: rest, sim: this }; o.vy = 0; } }
        else if (o.held) this.release(o);
        break;
      }
      for (const o of this.objects) if (o.held?.by === key && (o.held.sim ?? this) === this && o !== pressing) this.release(o);
    }
  }
  /** Let go: the block keeps its place and heading, stands upright, and falls. */
  private release(o: WorldObject) { releaseObject(o); }
  /** Held blocks follow the hand; loose ones fall to the floor or onto what is under them (the scene does that for shared blocks). */
  private carry(dt: number) {
    for (const o of this.objects) {
      if (!o.held || (o.held.sim ?? this) !== this) continue;
      const hand = this.pose.get(this.grippers.find(g => g.a.id === o.held!.by)?.parent ?? '');
      if (hand) o.m.copy(hand.clone().multiply(o.held.rel)); else this.release(o);
    }
    if (!this.sharedObjects) dropObjects(this.objects, this.world, dt);
  }

  private stepPhysics(dt: number, comps: CompInstance[], bench: BenchLike, running: boolean) {
    const targets = new Map<string, number | { vel: number }>();
    const cv = this.cmdVel, rosDrive = !running && cv && performance.now() - cv.t < 1000;
    for (const js of this.joints) {
      const j = js.joint, t = running ? this.target(j, comps, bench) : null;
      js.driven = !!t;
      if (t?.speed != null) { targets.set(js.id, { vel: t.speed * t.rate! }); js.target = js.q; continue; }
      if (j.type === 'wheel') { if (rosDrive) { const w = wheelsOf(this.model.parts).find(x => x.id === js.id); if (w) targets.set(js.id, { vel: ((cv!.v - cv!.w * w.x) / w.radius) * (180 / Math.PI) }); } else targets.set(js.id, { vel: 0 }); continue; }
      const goal = clampJoint(j, t?.q ?? this.manual.get(js.id) ?? js.target);
      js.target = goal;
      // the servo's own speed limit: the command slews toward the goal
      let c = this.cmd.get(js.id) ?? js.q;
      const sp = j.type === 'prismatic' ? 200 : this.servoOf(j, comps).speed;
      c += Math.max(-sp * dt, Math.min(sp * dt, goal - c));
      this.cmd.set(js.id, c);
      targets.set(js.id, c);
    }
    const q = this.phys!.step(dt, targets);
    for (const js of this.joints) {
      const v = q.get(js.id) ?? 0;
      if (js.joint.type === 'wheel') { const prev = this.q.get(js.id) ?? 0, d = ((v - prev + 540) % 360) - 180; this.q.set(js.id, prev + d); js.q = prev + d; this.wheelDeg.set(js.id, prev + d); }
      else { this.q.set(js.id, v); js.q = v; }
      // a servo that can't reach its command is being overpowered (gravity, a heavy load)
      const c = this.cmd.get(js.id);
      js.sag = c != null && js.joint.type === 'revolute' && Math.abs(c - js.target) < 0.5 && Math.abs(c - js.q) > 4 ? js.q - c : 0; // only when the command has settled
    }
    this.pose = this.phys!.pose();
    this.body.m.copy(this.pose.get(this.phys!.root().head.id) ?? new THREE.Matrix4());
    this.legs.fallen = new THREE.Vector3(0, 1, 0).transformDirection(this.body.m).y < 0.5;
    // pickable blocks are rigid bodies: their poses come from the physics
    for (const mv of this.phys!.movables()) { const o = this.objects.find(x => x.index === mv.index); if (o) { o.held = undefined; o.m.compose(new THREE.Vector3(...mv.pos), new THREE.Quaternion(...mv.quat), new THREE.Vector3(1, 1, 1)); } }
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
    const world = this.senseWorld();
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
/** The pickable blocks a world starts with (obstacles with pick: true), by obstacle index. */
export function makeObjects(world: World | undefined): WorldObject[] {
  return (world?.obstacles ?? []).flatMap((o, index) => {
    if (!o.pick) return [];
    const m = new THREE.Matrix4().compose(new THREE.Vector3(o.pos[0], o.size[1] / 2, o.pos[1]), new THREE.Quaternion().setFromAxisAngle(UP, (o.rot ?? 0) * D2R), ONE);
    return [{ index, shape: o.shape, size: new THREE.Vector3(...o.size), m, vy: 0 }];
  });
}
/** Let go of a block: it keeps its place and heading, stands upright, and falls. */
export function releaseObject(o: WorldObject) {
  o.held = undefined;
  const p = new THREE.Vector3().setFromMatrixPosition(o.m), x = new THREE.Vector3(1, 0, 0).transformDirection(o.m);
  o.m.compose(p, new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-x.z, x.x)), ONE);
  o.vy = 0;
}
/** Loose blocks fall to the floor, or onto a fixed obstacle or another block under them. */
export function dropObjects(objects: WorldObject[], world: World | undefined, dt: number) {
  for (const o of objects) {
    if (o.held) continue;
    const p = new THREE.Vector3().setFromMatrixPosition(o.m), rest = supportUnder(objects, world, o, p.x, p.z) + o.size.y / 2;
    if (p.y <= rest + 1e-3) { p.y = rest; o.vy = 0; }
    else { o.vy += 9810 * dt; p.y = Math.max(rest, p.y - o.vy * dt); if (p.y === rest) o.vy = 0; }
    o.m.setPosition(p);
  }
}
function supportUnder(objects: WorldObject[], world: World | undefined, self: WorldObject, x: number, z: number) {
  let top = 0;
  for (const ob of world?.obstacles ?? []) {
    if (ob.pick) continue;
    const dx = x - ob.pos[0], dz = z - ob.pos[1], a = -(ob.rot ?? 0) * D2R, lx = dx * Math.cos(a) + dz * Math.sin(a), lz = -dx * Math.sin(a) + dz * Math.cos(a);
    const inside = ob.shape === 'cyl' ? Math.hypot(dx, dz) <= ob.size[0] / 2 : Math.abs(lx) <= ob.size[0] / 2 && Math.abs(lz) <= ob.size[2] / 2;
    if (inside) top = Math.max(top, ob.size[1]);
  }
  const me = new THREE.Vector3().setFromMatrixPosition(self.m);
  for (const o of objects) {
    if (o === self || o.held) continue;
    const p = new THREE.Vector3().setFromMatrixPosition(o.m);
    if (p.y + o.size.y / 2 > me.y - self.size.y / 2 + 1) continue; // beside or above, not below
    if (Math.hypot(x - p.x, z - p.z) <= Math.max(o.size.x, o.size.z) / 2) top = Math.max(top, p.y + o.size.y / 2);
  }
  return top;
}
const D2R = Math.PI / 180, UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
const restQuat = (p: BuiltPart) => new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * D2R, p.rot[1] * D2R, p.rot[2] * D2R));
/** Half the part's thickness along direction u (rest model space). */
function halfAlong(p: BuiltPart, u: THREE.Vector3) {
  const l = u.clone().applyQuaternion(restQuat(p).invert());
  return (Math.abs(l.x) * p.size[0] + Math.abs(l.y) * p.size[1] + Math.abs(l.z) * p.size[2]) / 2;
}
/** Half a block's extent along u, given the block's orientation q (same space as u). */
function halfOf(o: WorldObject, u: THREE.Vector3, q: THREE.Quaternion) {
  const l = u.clone().applyQuaternion(q.clone().invert()), s = o.size;
  if (o.shape === 'cyl') return Math.hypot(l.x, l.z) * s.x / 2 + Math.abs(l.y) * s.y / 2;
  return (Math.abs(l.x) * s.x + Math.abs(l.y) * s.y + Math.abs(l.z) * s.z) / 2;
}
/** Grippers: pairs of prismatic fingers on one actuator channel that share a parent. */
function findGrippers(parts: BuiltPart[]): Gripper[] {
  const groups = new Map<string, BuiltPart[]>();
  for (const p of parts) {
    const d = p.joint?.type === 'prismatic' ? p.joint.drive : undefined;
    if (!d || !p.parent) continue;
    const k = `${d.comp}:${d.channel ?? 0}:${p.parent}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()].filter(g => g.length === 2).map(([a, b]) => ({ a, b, parent: a.parent! }));
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
