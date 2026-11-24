/**
 * Rigid-body physics for robots (Rapier, WASM): gravity, mass, friction,
 * collisions, and servos/motors with real torque limits.
 *
 * Each link (a part with a moving joint, plus everything attached to it
 * without one) becomes a dynamic rigid body with colliders from its parts
 * (boxes, cylinders, balls), weighing its share of the robot's mass. Links are
 * connected by revolute / prismatic joints at the joint pivots. Servos are
 * stiff position motors whose target is clamped so the force never exceeds the
 * servo's stall torque, so a weak servo really sags and stalls; wheels are
 * velocity motors on high-friction rubber, so traction is real. The floor,
 * walls and anything marked fixed are static colliders; every other obstacle is a
 * rigid body weighing what its material and size say (a foam block, a cardboard
 * box, a wooden crate), so robots push, topple or stall against it, and grippers
 * hold it by friction. Robots and objects use continuous collision detection, so
 * nothing tunnels through anything at speed.
 *
 * A PhysicsWorld holds the engine and the surroundings. A robot's Physics adds
 * its links and joints to a world: its own (one robot), or a scene's shared
 * world, where robots collide with each other and share the blocks.
 *
 * Units inside Rapier: metres, kilograms, seconds. Formframe: mm, Y up.
 */
import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { MATERIALS, materialOf, movable, obstacleGrams, type BuiltModel, type BuiltPart, type Joint, type World } from './project';
import { restMatrix } from './kinematics';

let R: typeof RAPIER_T | null = null;
let loading: Promise<typeof RAPIER_T> | null = null;
/** Load the physics engine once (≈1.5 MB of WASM). */
export function loadPhysics(): Promise<typeof RAPIER_T> {
  if (R) return Promise.resolve(R);
  loading ??= import('@dimforge/rapier3d-compat').then(async m => { const r = (m as any).default ?? m; await r.init(); R = r; return r; });
  return loading;
}
export const physicsReady = () => !!R;

const MM = 0.001;
/** Servo weights (g). */
const SERVO_G: Record<string, number> = { sg90: 9, mg90s: 13, mg996r: 55, ds3218: 60 };
const KGCM = 0.0980665; // kg·cm → N·m
// Collision groups: bit 0 blocks, bit 1 the fixed world (floor, walls, obstacles), bits 2–15 one per robot.
const BLOCKS = 0x0001, FIXED = 0x0002, ALL = 0xffff;
const groups = (member: number, filter: number) => ((member & ALL) << 16) | (filter & ALL);
const FIXED_GROUPS = groups(FIXED, ALL & ~FIXED), BLOCK_GROUPS = groups(BLOCKS, ALL);

/**
 * The floor, walls, obstacles and blocks, and the engine they live in. Robots join it:
 * one robot gets a world of its own, a scene shares one between all its robots.
 */
export class PhysicsWorld {
  world: RAPIER_T.World;
  movable: { index: number; body: RAPIER_T.RigidBody; size: [number, number, number]; shape: 'box' | 'cyl' }[] = [];
  robots: Physics[] = [];
  /** Fixed sub-steps per frame (stiff servos on light links need small steps). */
  substeps = 12;
  private bits = 0;
  constructor(w?: World) {
    if (!R) throw new Error('Physics engine not loaded');
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    (this.world as any).numSolverIterations = 24; // stiff servo chains on light links need more iterations
    this.addWorld(w);
  }
  /** A collision bit for a new robot. Past 14 robots the rest share the last bit (and don't collide with each other). */
  takeBit() { for (let b = 2; b < 16; b++) if (!(this.bits & (1 << b))) { this.bits |= 1 << b; return 1 << b; } return 1 << 15; }
  freeBit(bit: number) { if (this.robots.filter(r => r.bit === bit).length <= 1) this.bits &= ~bit; }
  /** A robot's colliders touch blocks, the fixed world and every other robot, but not each other. */
  robotGroups(bit: number) { return groups(bit, ALL & ~bit); }

  private addWorld(w?: World) {
    const r = R!;
    const fixed = this.world.createRigidBody(r.RigidBodyDesc.fixed());
    const size = (w?.size ?? 4000) * MM;
    this.world.createCollider(r.ColliderDesc.cuboid(size / 2 + 1, 0.05, size / 2 + 1).setTranslation(0, -0.05, 0).setFriction(0.9).setCollisionGroups(FIXED_GROUPS), fixed);
    if (!w) return;
    const s = size / 2;
    for (const [x, z, hx, hz] of [[0, -s - 0.005, s + 0.02, 0.005], [0, s + 0.005, s + 0.02, 0.005], [-s - 0.005, 0, 0.005, s], [s + 0.005, 0, 0.005, s]]) this.world.createCollider(r.ColliderDesc.cuboid(hx, 0.1, hz).setTranslation(x, 0.1, z).setCollisionGroups(FIXED_GROUPS), fixed);
    w.obstacles.forEach((o, index) => {
      const [sx, sy, sz] = o.size.map(v => v * MM);
      const desc = o.shape === 'cyl' ? r.ColliderDesc.cylinder(sy / 2, sx / 2) : r.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
      desc.setFriction(MATERIALS[materialOf(o)].friction).setRestitution(0.1);
      const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (o.rot ?? 0) * Math.PI / 180);
      if (movable(o)) {
        const body = this.world.createRigidBody(r.RigidBodyDesc.dynamic().setTranslation(o.pos[0] * MM, sy / 2, o.pos[1] * MM).setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
          .setCanSleep(false).setCcdEnabled(true).setLinearDamping(0.05).setAngularDamping(0.1));
        const v = o.shape === 'cyl' ? Math.PI * (sx / 2) * (sz / 2) * sy : sx * sy * sz;
        desc.setDensity(obstacleGrams(o) / 1000 / Math.max(1e-9, v)).setCollisionGroups(BLOCK_GROUPS);
        this.world.createCollider(desc, body);
        this.movable.push({ index, body, size: o.size, shape: o.shape });
      } else this.world.createCollider(desc.setTranslation(o.pos[0] * MM, sy / 2, o.pos[1] * MM).setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }).setCollisionGroups(FIXED_GROUPS), fixed);
    });
  }

  /** Advance everything by dt: each robot's motors chase the targets it set (Physics.setTargets). */
  step(dt: number) {
    this.world.timestep = dt / this.substeps;
    for (let s = 0; s < this.substeps; s++) {
      for (const rb of this.robots) rb.drive();
      this.world.step();
    }
  }
  /** Where the blocks are now: index → [x, y, z] mm and quaternion. */
  movables() { return this.movable.map(m => { const t = m.body.translation(), q = m.body.rotation(); return { index: m.index, pos: [t.x / MM, t.y / MM, t.z / MM] as [number, number, number], quat: [q.x, q.y, q.z, q.w] as [number, number, number, number] }; }); }
  dispose() { this.world.free(); this.robots = []; }
}


export interface Link { head: BuiltPart; parts: BuiltPart[]; origin: THREE.Vector3; body: RAPIER_T.RigidBody }
export interface PhysJoint { id: string; joint: Joint; link: Link; parent: Link; j: RAPIER_T.ImpulseJoint; maxTorque: number; stiffness: number }

export class Physics {
  /** The world this robot is in (its own unless it joined a scene's). */
  pw: PhysicsWorld;
  world: RAPIER_T.World;
  links: Link[] = [];
  joints: PhysJoint[] = [];
  /** This robot's collision bit in its world. */
  bit: number;
  private own: boolean;
  private targets = new Map<string, number | { vel: number }>();
  private linkOfPart = new Map<string, Link>();
  get movable() { return this.pw.movable; }
  get substeps() { return this.pw.substeps; }
  set substeps(n: number) { this.pw.substeps = n; }

  /**
   * Build from the model, with every part at its current pose (part id → rest→world matrix).
   * torqueOf(joint) → servo stall torque in kg·cm (0 = an unlimited/ideal actuator).
   */
  constructor(model: BuiltModel, pose: Map<string, THREE.Matrix4>, torqueOf: (j: Joint) => number, shared?: PhysicsWorld) {
    if (!R) throw new Error('Physics engine not loaded');
    const r = R, spec = model.robot!;
    this.own = !shared;
    this.pw = shared ?? new PhysicsWorld(spec.world);
    this.world = this.pw.world;
    this.bit = this.pw.takeBit();
    this.pw.robots.push(this);
    const ROBOT = this.pw.robotGroups(this.bit);
    // ---- links (same grouping as URDF export)
    const parts = model.parts.filter(p => p.role !== 'ignore');
    const byId = new Map(parts.map(p => [p.id, p]));
    const moving = (p: BuiltPart) => !!p.joint && p.joint.type !== 'fixed';
    const headOf = (p: BuiltPart): BuiltPart => { let q = p, n = 0; while (q.parent && byId.has(q.parent) && !moving(q) && n++ < 64) q = byId.get(q.parent)!; return q; };
    const heads = parts.filter(p => headOf(p) === p);
    // mass: servos weigh what they weigh (they're most of a walking robot), the rest by volume.
    // Every moving link also carries the servo that drives it.
    const servoG = (p: BuiltPart) => (p.detail?.startsWith('servo:') ? SERVO_G[p.detail.slice(6)] ?? 30 : 0);
    const driven = parts.filter(p => moving(p) && p.joint!.drive && p.joint!.type === 'revolute' && !parts.some(q => q.parent === p.id && q.detail?.startsWith('servo:')));
    const fixedG = parts.reduce((a, p) => a + servoG(p), 0) + driven.length * 45;
    const restG = Math.max(spec.mass * 0.25, spec.mass - fixedG);
    const totalVol = parts.filter(p => !servoG(p)).reduce((a, p) => a + vol(p), 0) || 1;
    const massOf = (p: BuiltPart) => Math.max(0.004, (servoG(p) || (restG * vol(p)) / totalVol + (driven.includes(p) ? 45 : 0)) / 1000);
    for (const h of heads) {
      const members = parts.filter(p => headOf(p) === h);
      const origin = new THREE.Vector3(...(h.joint ? h.joint.pivot : (centroid(members) as [number, number, number])));
      const M = pose.get(h.id) ?? new THREE.Matrix4();
      const wp = origin.clone().applyMatrix4(M), q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(M));
      const isRoot = !h.parent || !byId.has(h.parent);
      const desc = (isRoot && spec.mobile === 'fixed' ? r.RigidBodyDesc.fixed() : r.RigidBodyDesc.dynamic())
        .setTranslation(wp.x * MM, wp.y * MM, wp.z * MM).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.05).setAngularDamping(0.2).setCanSleep(false).setCcdEnabled(true);
      const body = this.world.createRigidBody(desc);
      const link: Link = { head: h, parts: members, origin, body };
      for (const p of members) {
        const mass = massOf(p);
        const c = colliderFor(r, p, origin);
        if (!c) continue;
        const v = c.vol;
        c.desc.setDensity(mass / Math.max(1e-9, v)).setCollisionGroups(ROBOT)
          .setFriction(p.foot || p.joint?.type === 'wheel' || p.detail === 'wheel' || p.detail === 'foot' || p.detail === 'finger' ? 1.1 : 0.45).setRestitution(0.05);
        this.world.createCollider(c.desc, body);
      }
      this.links.push(link);
      for (const p of members) this.linkOfPart.set(p.id, link);
    }
    // ---- joints
    for (const l of this.links) {
      const h = l.head;
      if (!moving(h) || !h.parent) continue;
      const parent = this.linkOfPart.get(h.parent); if (!parent) continue;
      const j = h.joint!, axis = new THREE.Vector3(...j.axis).normalize();
      const a1 = new THREE.Vector3(...j.pivot).sub(parent.origin).multiplyScalar(MM), a2 = new THREE.Vector3(...j.pivot).sub(l.origin).multiplyScalar(MM);
      const data = j.type === 'prismatic' ? r.JointData.prismatic(a1, a2, axis) : r.JointData.revolute(a1, a2, axis);
      if (j.type === 'prismatic') { data.limitsEnabled = true; data.limits = [(j.min ?? 0) * MM, (j.max ?? 10) * MM]; }
      const ij = this.world.createImpulseJoint(data, parent.body, l.body, true);
      const t = torqueOf(j);
      const maxTorque = j.type === 'prismatic' ? 15 : t > 0 ? t * KGCM : 50;
      // stiff: full torque at ~6° of error, like a servo's P loop
      const stiffness = j.type === 'prismatic' ? 3000 : maxTorque / (6 * Math.PI / 180);
      (ij as any).configureMotorModel?.(r.MotorModel.ForceBased);
      this.joints.push({ id: h.id, joint: j, link: l, parent, j: ij, maxTorque, stiffness });
    }
  }

  /** Current joint value (deg or mm) from the bodies' relative pose. */
  measure(pj: PhysJoint): number {
    const q1 = pj.parent.body.rotation(), q2 = pj.link.body.rotation();
    const rel = new THREE.Quaternion(q1.x, q1.y, q1.z, q1.w).invert().multiply(new THREE.Quaternion(q2.x, q2.y, q2.z, q2.w));
    const axis = new THREE.Vector3(...pj.joint.axis).normalize();
    if (pj.joint.type === 'prismatic') {
      const t1 = pj.parent.body.translation(), t2 = pj.link.body.translation();
      const d = new THREE.Vector3(t2.x - t1.x, t2.y - t1.y, t2.z - t1.z).applyQuaternion(new THREE.Quaternion(q1.x, q1.y, q1.z, q1.w).invert());
      const rest = pj.link.origin.clone().sub(pj.parent.origin).multiplyScalar(MM);
      return d.sub(rest).dot(axis) / MM;
    }
    return 2 * Math.atan2(rel.x * axis.x + rel.y * axis.y + rel.z * axis.z, rel.w) * 180 / Math.PI;
  }

  /** What the motors should do: joint id → position (deg / mm) for servos, or { vel } (deg/s) for wheels / motors. */
  setTargets(targets: Map<string, number | { vel: number }>) { this.targets = targets; }
  /** Apply the targets to the motors (every sub-step). */
  drive() {
    for (const pj of this.joints) {
      const t = this.targets.get(pj.id);
      if (t == null) continue;
      const ij = pj.j as any;
      if (typeof t === 'object') { ij.configureMotorVelocity((t.vel * Math.PI) / 180, 2); continue; }
      if (pj.joint.type === 'prismatic') { ij.configureMotorPosition(t * MM, pj.stiffness, 60); continue; }
      // clamp the error so stiffness × error never exceeds the servo's torque
      const q = this.measure(pj), maxErr = (pj.maxTorque / pj.stiffness) * 180 / Math.PI;
      const goal = q + Math.max(-maxErr, Math.min(maxErr, t - q));
      ij.configureMotorPosition((goal * Math.PI) / 180, pj.stiffness, pj.stiffness * 0.04);
    }
  }
  /** Measured joint values (deg or mm). */
  measured(): Map<string, number> {
    const out = new Map<string, number>();
    for (const pj of this.joints) out.set(pj.id, this.measure(pj));
    return out;
  }
  /**
   * Set the targets and, in a world of its own, advance by dt. In a shared world
   * the scene steps the world once for everyone (PhysicsWorld.step).
   * Returns the measured joint values.
   */
  step(dt: number, targets: Map<string, number | { vel: number }>): Map<string, number> {
    this.setTargets(targets);
    if (this.own) this.pw.step(dt);
    return this.measured();
  }

  /** Rest→world matrix for every part (feeds the renderer, sensors and the body pose). */
  pose(): Map<string, THREE.Matrix4> {
    const out = new Map<string, THREE.Matrix4>();
    for (const l of this.links) {
      const t = l.body.translation(), q = l.body.rotation();
      const B = new THREE.Matrix4().compose(new THREE.Vector3(t.x / MM, t.y / MM, t.z / MM), new THREE.Quaternion(q.x, q.y, q.z, q.w), new THREE.Vector3(1, 1, 1))
        .multiply(new THREE.Matrix4().makeTranslation(-l.origin.x, -l.origin.y, -l.origin.z));
      for (const p of l.parts) out.set(p.id, B);
    }
    return out;
  }
  /** Where the movable obstacles are now: index → [x, y, z] mm and quaternion. */
  movables() { return this.pw.movables(); }
  root(): Link { return this.links.find(l => !l.head.parent) ?? this.links[0]; }
  /** Leave the world: free it if it's this robot's own, else take this robot's bodies (and their colliders and joints) out of the shared one. */
  dispose() {
    if (this.own) { this.pw.dispose(); return; }
    for (const l of this.links) this.world.removeRigidBody(l.body);
    this.pw.freeBit(this.bit);
    this.pw.robots = this.pw.robots.filter(r => r !== this);
    this.links = []; this.joints = [];
  }
}

function vol(p: BuiltPart) { const [a, b, c] = p.size; return Math.max(1, a * b * c) * (p.shape === 'sphere' ? 0.52 : p.shape === 'cyl' || p.shape === 'tube' || p.shape === 'disc' ? 0.785 : 1) * (p.kind === 'shell' ? 0.25 : 1); }
function centroid(ps: BuiltPart[]) { const c = [0, 0, 0]; for (const p of ps) for (let k = 0; k < 3; k++) c[k] += p.pos[k] / ps.length; return c; }

/** A collider for a part, positioned relative to its link origin (rest frame), in metres. */
function colliderFor(r: typeof RAPIER_T, p: BuiltPart, origin: THREE.Vector3): { desc: RAPIER_T.ColliderDesc; vol: number } | null {
  const m = restMatrix(p), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  m.decompose(pos, q, sc);
  pos.sub(origin).multiplyScalar(MM);
  const [w, h, d] = p.size.map(v => Math.max(0.5, v) * MM);
  let desc: RAPIER_T.ColliderDesc, v: number;
  if (p.shape === 'sphere' || p.detail === 'foot' || p.detail === 'caster') { const rad = Math.min(w, h, d) / 2; desc = r.ColliderDesc.ball(rad); v = (4 / 3) * Math.PI * rad ** 3; }
  else if (p.shape === 'cyl' || p.shape === 'tube' || p.detail === 'wheel' || p.shape === 'disc') {
    // Formframe cylinders run along local Z; Rapier's along local Y: turn local Y onto Z
    const rad = Math.max(w, h) / 2, len = Math.max(d, 0.0005);
    desc = r.ColliderDesc.cylinder(len / 2, rad); v = Math.PI * rad * rad * len;
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  } else if (p.shape === 'rect') { desc = r.ColliderDesc.cuboid(w / 2, h / 2, 0.0005); v = w * h * 0.001; } // a flat plate: thin but solid
  else { desc = r.ColliderDesc.cuboid(w / 2, h / 2, Math.max(d, 0.0005) / 2); v = w * h * d; }
  desc.setTranslation(pos.x, pos.y, pos.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  return { desc, vol: Math.max(1e-9, v) };
}
