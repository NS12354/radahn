import type { BuiltPart } from './project';

/**
 * Lightweight geometry for built models (no three.js, so it runs in tests and
 * inside auto build). Each part instance becomes a 2D footprint in the XY
 * (front) plane — rectangle, circle or ring — plus a Z interval. Good enough to
 * catch parts that collide or poke out of the housing; it is not a CAD kernel.
 */
type V3 = [number, number, number];
export interface Inst { part: BuiltPart; pos: V3; rot: V3; idx: number }
type FP = { k: 'rect'; x0: number; x1: number; y0: number; y1: number } | { k: 'circ'; x: number; y: number; r: number; inner?: number };
export interface Solid { inst: Inst; fp: FP; z0: number; z1: number; box: { min: V3; max: V3 } }

const D2R = Math.PI / 180;
const near = (a: number, m: number) => { const r = ((a % m) + m) % m; return r < 0.01 || m - r < 0.01; };

/** Rotation matrix for three.js Euler 'XYZ' (R = Rx·Ry·Rz). */
function rotM([rx, ry, rz]: V3) {
  const [a, b, c] = [rx * D2R, ry * D2R, rz * D2R];
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return [
    [cb * cc, -cb * sc, sb],
    [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
    [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
  ];
}

/** Expand a part's array into instances (positions/rotations in mm/deg). */
export function instances(p: BuiltPart): Inst[] {
  const a = p.array, n = Math.max(1, Math.round(a?.n ?? 1));
  if (!a || n === 1) return [{ part: p, pos: p.pos, rot: p.rot, idx: 0 }];
  const out: Inst[] = [];
  for (let i = 0; i < n; i++) {
    if (a.mode === 'radial') {
      const [cx, cy] = a.center ?? [0, 0], t = (i / n) * Math.PI * 2, dx = p.pos[0] - cx, dy = p.pos[1] - cy;
      out.push({ part: p, idx: i, pos: [cx + dx * Math.cos(t) - dy * Math.sin(t), cy + dx * Math.sin(t) + dy * Math.cos(t), p.pos[2]], rot: [p.rot[0], p.rot[1], p.rot[2] + (i * 360) / n] });
    } else {
      const s = a.step ?? [10, 0, 0];
      out.push({ part: p, idx: i, pos: [p.pos[0] + s[0] * i, p.pos[1] + s[1] * i, p.pos[2] + s[2] * i], rot: p.rot });
    }
  }
  return out;
}

export function solid(inst: Inst): Solid {
  const { part: p, pos, rot } = inst, [w, h, d] = p.size, R = rotM(rot);
  const half = [0, 1, 2].map(i => (Math.abs(R[i][0]) * w + Math.abs(R[i][1]) * h + Math.abs(R[i][2]) * d) / 2) as V3;
  const box = { min: pos.map((v, i) => v - half[i]) as V3, max: pos.map((v, i) => v + half[i]) as V3 };
  const facingZ = near(rot[0], 180) && near(rot[1], 180);
  const round = ['cyl', 'disc', 'tube', 'torus', 'cone', 'sphere'].includes(p.shape) && Math.abs(w - h) < 0.01;
  let fp: FP;
  if (facingZ && round) {
    const inner = p.shape === 'tube' ? p.param ?? w * 0.8 : p.shape === 'torus' ? w - 2 * d : undefined;
    fp = { k: 'circ', x: pos[0], y: pos[1], r: w / 2, inner: inner && inner > 0 ? inner / 2 : undefined };
  } else fp = { k: 'rect', x0: box.min[0], x1: box.max[0], y0: box.min[1], y1: box.max[1] };
  return { inst, fp, z0: box.min[2], z1: box.max[2], box };
}

const EPS = 0.05;
function rectCirc(r: Extract<FP, { k: 'rect' }>, c: { x: number; y: number }, rad: number) {
  const dx = Math.max(r.x0 - c.x, 0, c.x - r.x1), dy = Math.max(r.y0 - c.y, 0, c.y - r.y1);
  return Math.hypot(dx, dy) < rad - EPS;
}
/** Is footprint `a` entirely inside the hole of ring `c`? */
function inHole(a: FP, c: Extract<FP, { k: 'circ' }>) {
  if (!c.inner) return false;
  if (a.k === 'circ') return Math.hypot(a.x - c.x, a.y - c.y) + a.r <= c.inner + EPS;
  return [[a.x0, a.y0], [a.x1, a.y0], [a.x0, a.y1], [a.x1, a.y1]].every(([x, y]) => Math.hypot(x - c.x, y - c.y) <= c.inner! + EPS);
}
function overlap2(a: FP, b: FP): boolean {
  if (a.k === 'circ' && inHole(b, a)) return false;
  if (b.k === 'circ' && inHole(a, b)) return false;
  if (a.k === 'rect' && b.k === 'rect') return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
  if (a.k === 'circ' && b.k === 'circ') return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - EPS;
  const [r, c] = (a.k === 'rect' ? [a, b] : [b, a]) as [Extract<FP, { k: 'rect' }>, Extract<FP, { k: 'circ' }>];
  return rectCirc(r, c, c.r);
}
export function collide(a: Solid, b: Solid) { return a.z0 < b.z1 - EPS && b.z0 < a.z1 - EPS && overlap2(a.fp, b.fp); }

export const solidsOf = (p: BuiltPart) => instances(p).map(solid);

/** The housing: the largest shell part. */
export function housingOf(parts: BuiltPart[]) {
  const shells = parts.filter(p => p.kind === 'shell');
  return shells.sort((a, b) => b.size[0] * b.size[1] * b.size[2] - a.size[0] * a.size[1] * a.size[2])[0] ?? null;
}

export interface FitRow { level: 'ok' | 'warn' | 'err'; msg: string; ids: string[] }
export function fitBuilt(parts: BuiltPart[]): FitRow[] {
  const rows: FitRow[] = [];
  const inner = parts.filter(p => p.kind === 'internal' && p.role !== 'ignore');
  const solids = inner.flatMap(solidsOf);
  const seen = new Set<string>();
  for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
    const a = solids[i], b = solids[j];
    if (a.inst.part === b.inst.part) continue;
    const key = a.inst.part.id + '|' + b.inst.part.id;
    if (seen.has(key) || !collide(a, b)) continue;
    seen.add(key);
    rows.push({ level: 'err', msg: `${a.inst.part.name} collides with ${b.inst.part.name}`, ids: [a.inst.part.id, b.inst.part.id] });
  }
  const shell = parts.filter(p => p.kind === 'shell').flatMap(solidsOf);
  if (shell.length) {
    const min = [0, 1, 2].map(k => Math.min(...shell.map(s => s.box.min[k]))), max = [0, 1, 2].map(k => Math.max(...shell.map(s => s.box.max[k])));
    const outside = new Set<BuiltPart>();
    for (const s of solids) for (let k = 0; k < 3; k++) if (s.box.min[k] < min[k] - EPS || s.box.max[k] > max[k] + EPS) outside.add(s.inst.part);
    for (const p of outside) rows.push({ level: 'err', msg: `${p.name} sticks out of the enclosure`, ids: [p.id] });
  } else if (inner.length && !parts.some(p => (p as any).joint)) rows.push({ level: 'warn', msg: 'No enclosure: set a part\'s Kind to Shell to check what fits inside it', ids: [] }); // robots (jointed) aren't enclosures
  if (!rows.length && inner.length) rows.push({ level: 'ok', msg: `${inner.length} internal part${inner.length > 1 ? 's' : ''} fit without collisions`, ids: [] });
  return rows;
}

export function bounds(parts: BuiltPart[]) {
  const ss = parts.filter(p => p.role !== 'ignore').flatMap(solidsOf);
  if (!ss.length) return null;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of ss) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], s.box.min[k]); max[k] = Math.max(max[k], s.box.max[k]); }
  return { min, max, size: max.map((v, i) => v - min[i]) as V3 };
}
