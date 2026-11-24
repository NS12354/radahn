/**
 * Robot kinematics on the built model. Pure math (three.js types only), so it
 * runs in tests and in both windows.
 *
 * Every part's rest pose is its pos/rot in model space (mm, Y up, the robot
 * faces +Z). A joint is defined at rest in the same space (pivot + axis), so
 * forward kinematics is just: M(part) = M(parent) · J(part, q). M maps rest
 * model space to the current pose; the body pose B (for robots that drive or
 * walk) is applied on top: world = B · M · rest.
 */
import * as THREE from 'three';
import type { BuiltPart, Joint, World } from './project';

const D2R = Math.PI / 180;
const v3 = (a: [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2]);

export function restMatrix(p: BuiltPart) {
  return new THREE.Matrix4().compose(v3(p.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * D2R, p.rot[1] * D2R, p.rot[2] * D2R)), new THREE.Vector3(1, 1, 1));
}

/** The motion a joint adds at value q (degrees, or mm for prismatic), in rest model space. */
export function jointMatrix(j: Joint, q: number) {
  const axis = v3(j.axis).normalize(), m = new THREE.Matrix4();
  if (!q || j.type === 'fixed' || axis.lengthSq() === 0) return m;
  if (j.type === 'prismatic') return m.makeTranslation(axis.x * q, axis.y * q, axis.z * q);
  const p = v3(j.pivot);
  return m.makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, q * D2R)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
}

/** Clamp a joint value to its limits. */
export const clampJoint = (j: Joint, q: number) => (j.type === 'wheel' ? q : Math.max(j.min ?? -Infinity, Math.min(j.max ?? Infinity, q)));

/** M for every part (rest model space → posed model space), without the body pose. */
export function forwardKinematics(parts: BuiltPart[], q: (id: string) => number): Map<string, THREE.Matrix4> {
  const byId = new Map(parts.map(p => [p.id, p]));
  const out = new Map<string, THREE.Matrix4>();
  const visit = (p: BuiltPart, depth = 0): THREE.Matrix4 => {
    const have = out.get(p.id); if (have) return have;
    const parent = p.parent && p.parent !== p.id && depth < 64 ? byId.get(p.parent) : undefined;
    const m = parent ? visit(parent, depth + 1).clone() : new THREE.Matrix4();
    if (p.joint) m.multiply(jointMatrix(p.joint, q(p.id)));
    out.set(p.id, m);
    return m;
  };
  for (const p of parts) visit(p);
  return out;
}

/** Bottom of a foot part (its contact point), in rest model space. */
export function footRest(p: BuiltPart) {
  return new THREE.Vector3(0, -p.size[1] / 2, 0).applyMatrix4(restMatrix(p));
}
/** Centre of a part and its local +Z (where a sensor looks), after posing. */
export function sensorRay(p: BuiltPart, m: THREE.Matrix4) {
  const w = m.clone().multiply(restMatrix(p));
  const o = new THREE.Vector3().setFromMatrixPosition(w);
  const d = new THREE.Vector3(0, 0, 1).transformDirection(w);
  return { o, d };
}

/** Body pose for a robot that drives or walks: yaw about Y, tilt, and position. */
export class BodyPose {
  m = new THREE.Matrix4();
  reset() { this.m.identity(); }
  get x() { return this.m.elements[12]; }
  get z() { return this.m.elements[14]; }
  /** Heading: angle of the body's +Z in the floor plane (radians, 0 = +Z). */
  get yaw() { const f = new THREE.Vector3(0, 0, 1).transformDirection(this.m); return Math.atan2(f.x, f.z); }
}

// ------------------------------------------------------------------ wheels
export interface WheelInfo { id: string; x: number; radius: number; axis: THREE.Vector3; center: THREE.Vector3 }
/** Wheels in body space: lateral position (x), radius, axis. */
export function wheelsOf(parts: BuiltPart[]): WheelInfo[] {
  return parts.filter(p => p.joint?.type === 'wheel').map(p => ({ id: p.id, x: p.joint!.pivot[0], radius: Math.max(p.size[0], p.size[1], p.size[2]) / 2, axis: v3(p.joint!.axis).normalize(), center: v3(p.joint!.pivot) }));
}
/**
 * Body forward speed (mm/s, along +Z) and yaw rate (rad/s, about +Y) from driven wheel spin rates (deg/s),
 * by a least-squares fit of v − ω·x to each wheel's ground speed (works for 2WD and 4WD skid steer).
 */
export function diffDrive(wheels: WheelInfo[], rates: Map<string, number>): { v: number; w: number } {
  const ws = wheels.filter(w => rates.has(w.id));
  if (!ws.length) return { v: 0, w: 0 };
  // ground pushes the body opposite to the contact point's motion: v_body = −ω (axis × down·r), along +Z
  const s = ws.map(w => { const om = rates.get(w.id)! * D2R; const c = w.axis.clone().cross(new THREE.Vector3(0, -w.radius, 0)).multiplyScalar(-om); return c.z; });
  const mx = ws.reduce((a, w) => a + w.x, 0) / ws.length, ms = s.reduce((a, b) => a + b, 0) / s.length;
  let cov = 0, vx = 0; ws.forEach((w, i) => { cov += (w.x - mx) * (s[i] - ms); vx += (w.x - mx) ** 2; });
  const w = vx > 1e-6 ? -cov / vx : 0;
  return { v: ms + w * mx, w };
}
/** Advance a wheeled body: drive, then block if it would hit an obstacle or leave the floor. Returns true if it moved. */
export function driveBody(b: BodyPose, v: number, w: number, dt: number, radius: number, world?: World): boolean {
  const next = new THREE.Matrix4().makeRotationY(w * dt).premultiply(new THREE.Matrix4()); // yaw about the body's own origin
  const cand = b.m.clone().multiply(next).multiply(new THREE.Matrix4().makeTranslation(0, 0, v * dt));
  const x = cand.elements[12], z = cand.elements[14];
  // blocked: refuse moves that push further into a wall or obstacle (moving away from one you're touching is fine)
  if (world) { const now = penetration(world, b.x, b.z, radius), then = penetration(world, x, z, radius); if (then > 0 && then >= now - 1e-6) { if (Math.abs(w) > 1e-6) { b.m.multiply(next); return true; } return false; } }
  b.m.copy(cand);
  return true;
}
/** How far (mm) a body of radius r at (x, z) overlaps the walls or obstacles (≤ 0: clear). */
export function penetration(world: World, x: number, z: number, r: number): number {
  const h = world.size / 2;
  let pen = Math.max(Math.abs(x) + r - h, Math.abs(z) + r - h);
  for (const o of world.obstacles) {
    const d = o.shape === 'cyl' ? Math.hypot(x - o.pos[0], z - o.pos[1]) - o.size[0] / 2
      : Math.hypot(Math.max(0, Math.abs(x - o.pos[0]) - o.size[0] / 2), Math.max(0, Math.abs(z - o.pos[1]) - o.size[2] / 2)) - (Math.abs(x - o.pos[0]) <= o.size[0] / 2 && Math.abs(z - o.pos[1]) <= o.size[2] / 2 ? Math.min(o.size[0] / 2 - Math.abs(x - o.pos[0]), o.size[2] / 2 - Math.abs(z - o.pos[1])) : 0);
    pen = Math.max(pen, r - d);
  }
  return pen;
}

// ------------------------------------------------------------------ legs
/**
 * Ground contact for walking robots (a kinematic contact model, not a full
 * dynamics engine): feet on the ground don't slip, the lowest foot rests on
 * the floor, and when the centre of mass is outside the feet that support it,
 * the body tips about them until another foot lands (or it falls over).
 */
export class LegContact {
  private planted = new Map<string, THREE.Vector3>();
  contacts: string[] = [];
  fallen = false;
  reset() { this.planted.clear(); this.contacts = []; this.fallen = false; }
  step(b: BodyPose, feet: { id: string; local: THREE.Vector3 }[], com: THREE.Vector3, dt: number) {
    if (!feet.length) return;
    const world = () => feet.map(f => ({ id: f.id, p: f.local.clone().applyMatrix4(b.m) }));
    // 1. planted feet hold their spot: fit yaw + XZ shift (2D Kabsch)
    const held = world().filter(f => this.planted.has(f.id));
    if (held.length) {
      const A = held.map(f => f.p), B = held.map(f => this.planted.get(f.id)!);
      const ca = A.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(A.length), cb = B.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(B.length);
      let sxx = 0, sxz = 0;
      A.forEach((a, i) => { const ax = a.x - ca.x, az = a.z - ca.z, bx = B[i].x - cb.x, bz = B[i].z - cb.z; sxx += ax * bx + az * bz; sxz += az * bx - ax * bz; });
      const th = held.length > 1 ? Math.atan2(sxz, sxx) : 0; // rotation about +Y taking A onto B
      const rot = new THREE.Matrix4().makeTranslation(cb.x, 0, cb.z).multiply(new THREE.Matrix4().makeRotationY(th)).multiply(new THREE.Matrix4().makeTranslation(-ca.x, 0, -ca.z));
      b.m.premultiply(rot);
    }
    // 2. rest the lowest foot on the floor
    let ws = world(); const minY = Math.min(...ws.map(f => f.p.y));
    b.m.premultiply(new THREE.Matrix4().makeTranslation(0, -minY, 0));
    ws = world();
    let touch = ws.filter(f => f.p.y < 1.5);
    // 3. tip about the support if the centre of mass isn't over it
    const c = com.clone().applyMatrix4(b.m);
    const sup = touch.map(f => f.p);
    const pivotAxis = tipAxis(sup, c);
    if (pivotAxis) {
      const { point, axis } = pivotAxis, ang = Math.min(1.5, 120 * dt) * D2R; // ≤ 120°/s
      b.m.premultiply(new THREE.Matrix4().makeTranslation(point.x, point.y, point.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, ang)).multiply(new THREE.Matrix4().makeTranslation(-point.x, -point.y, -point.z)));
      ws = world(); const m2 = Math.min(...ws.map(f => f.p.y));
      if (m2 < 0) b.m.premultiply(new THREE.Matrix4().makeTranslation(0, -m2, 0));
      ws = world(); touch = ws.filter(f => f.p.y < 1.5);
    }
    const up = new THREE.Vector3(0, 1, 0).transformDirection(b.m);
    this.fallen = up.y < 0.5;
    // 4. remember where the feet that touch are planted (new contacts plant where they land)
    const next = new Map<string, THREE.Vector3>();
    for (const f of touch) next.set(f.id, this.planted.get(f.id) ?? f.p.clone().setY(0));
    this.planted = next; this.contacts = touch.map(f => f.id);
  }
}
/** If the centre of mass isn't above the support polygon, the line/point to tip about and the axis that lowers it. */
function tipAxis(sup: THREE.Vector3[], c: THREE.Vector3): { point: THREE.Vector3; axis: THREE.Vector3 } | null {
  if (!sup.length) return null;
  const hull = convexHull2(sup);
  if (hull.length >= 3 && inside2(hull, c)) return null;
  // nearest point of the hull (point / edge) to the COM, in the floor plane
  let best: { d: number; p: THREE.Vector3; e?: [THREE.Vector3, THREE.Vector3] } | null = null;
  if (hull.length === 1) best = { d: 0, p: hull[0] };
  for (let i = 0; i < hull.length && hull.length > 1; i++) {
    const a = hull[i], z = hull[(i + 1) % hull.length], ab = new THREE.Vector2(z.x - a.x, z.z - a.z), ac = new THREE.Vector2(c.x - a.x, c.z - a.z);
    const t = Math.max(0, Math.min(1, ac.dot(ab) / Math.max(1e-9, ab.lengthSq())));
    const p = new THREE.Vector3(a.x + ab.x * t, 0, a.z + ab.y * t), d = Math.hypot(c.x - p.x, c.z - p.z);
    if (!best || d < best.d) best = { d, p, e: [a, z] };
    if (hull.length === 2) break;
  }
  if (!best) return null;
  const out = new THREE.Vector3(c.x - best.p.x, 0, c.z - best.p.z);
  if (out.lengthSq() < 1e-6) return null; // balanced exactly on the edge
  // rotate so the COM goes down: axis = out × up (right-hand rule lowers the outward side)
  const axis = out.normalize().cross(new THREE.Vector3(0, 1, 0)).multiplyScalar(-1).normalize();
  return { point: best.p, axis };
}
function convexHull2(ps: THREE.Vector3[]) {
  const pts = [...ps].sort((a, b) => a.x - b.x || a.z - b.z);
  if (pts.length < 3) return pts;
  const cross = (o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lo: THREE.Vector3[] = [], hi: THREE.Vector3[] = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...pts].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function inside2(hull: THREE.Vector3[], c: THREE.Vector3) {
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], s = Math.sign((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (s === 0) continue; if (!sign) sign = s; else if (s !== sign) return false;
  }
  return true;
}

// ------------------------------------------------------------------ world sensing
/** Distance (mm) along a ray to the nearest obstacle or wall, or Infinity. Ignores the floor. */
export function raycastWorld(world: World, o: THREE.Vector3, d: THREE.Vector3): number {
  const ray = new THREE.Ray(o, d.clone().normalize()), hit = new THREE.Vector3();
  let best = Infinity;
  const box = (min: THREE.Vector3, max: THREE.Vector3) => { if (ray.intersectBox(new THREE.Box3(min, max), hit)) best = Math.min(best, hit.distanceTo(o)); };
  for (const ob of world.obstacles) {
    const [x, z] = ob.pos, [w, h, dd] = ob.size;
    if (ob.shape === 'box') box(new THREE.Vector3(x - w / 2, 0, z - dd / 2), new THREE.Vector3(x + w / 2, h, z + dd / 2));
    else {
      // cylinder: solve in the floor plane, then check height
      const r = w / 2, dx = ray.direction.x, dz = ray.direction.z, fx = o.x - x, fz = o.z - z;
      const a = dx * dx + dz * dz, bq = 2 * (fx * dx + fz * dz), cq = fx * fx + fz * fz - r * r, disc = bq * bq - 4 * a * cq;
      if (a > 1e-9 && disc >= 0) { const t = (-bq - Math.sqrt(disc)) / (2 * a); if (t > 0) { const y = o.y + ray.direction.y * t; if (y >= 0 && y <= h) best = Math.min(best, t); } }
    }
  }
  const s = world.size / 2, wall = 200;
  box(new THREE.Vector3(-s - 10, 0, -s - 10), new THREE.Vector3(-s, wall, s + 10));
  box(new THREE.Vector3(s, 0, -s - 10), new THREE.Vector3(s + 10, wall, s + 10));
  box(new THREE.Vector3(-s - 10, 0, -s - 10), new THREE.Vector3(s + 10, wall, -s));
  box(new THREE.Vector3(-s - 10, 0, s), new THREE.Vector3(s + 10, wall, s + 10));
  return best;
}
/** Is floor point (x, z) on the dark line? */
export function onTrack(world: World, x: number, z: number): boolean {
  const t = world.track; if (!t || t.points.length < 2) return false;
  for (let i = 0; i < t.points.length; i++) {
    const [ax, az] = t.points[i], [bx, bz] = t.points[(i + 1) % t.points.length];
    const abx = bx - ax, abz = bz - az, u = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / Math.max(1e-9, abx * abx + abz * abz)));
    if (Math.hypot(x - (ax + abx * u), z - (az + abz * u)) <= t.width / 2) return true;
  }
  return false;
}
