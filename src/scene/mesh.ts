import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuiltPart, MeshData } from '../app/project';

/**
 * Polygon meshes for Edit Mode: converting primitives to quad meshes,
 * building render geometry, normalising to the part box, and the topology
 * operations Edit Mode uses (extrude, inset, subdivide, loop cut, merge…).
 * Coordinates here are the part's local millimetres (front = +Z).
 */
export type V = [number, number, number];
export interface EMesh { v: V[]; f: number[][]; e: [number, number][] }

const TAU = Math.PI * 2;
export const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// ------------------------------------------------------------------ primitives → quads (unit space, -0.5…0.5)
function ring(n: number, r: number, z: number, a0 = Math.PI / 2): V[] { return Array.from({ length: n }, (_, i) => { const a = a0 + (i / n) * TAU; return [Math.cos(a) * r, Math.sin(a) * r, z] as V; }); }
function cylinder(n: number, top: number): EMesh {
  const v: V[] = [...ring(n, 0.5, -0.5), ...(top > 1e-4 ? ring(n, 0.5 * top, 0.5) : [[0, 0, 0.5] as V])];
  const f: number[][] = [];
  if (top > 1e-4) {
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push([i, j, n + j, n + i]); }
    f.push(Array.from({ length: n }, (_, i) => n + i));
  } else for (let i = 0; i < n; i++) f.push([i, (i + 1) % n, n]);
  f.push(Array.from({ length: n }, (_, i) => n - 1 - i));
  return { v, f, e: [] };
}
function unitPrimitive(p: BuiltPart): EMesh {
  const [w, h, d] = p.size;
  switch (p.shape) {
    case 'box': {
      const v: V[] = []; for (let i = 0; i < 8; i++) v.push([i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5]);
      return { v, f: [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]], e: [] };
    }
    case 'rect': return { v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]], f: [[0, 1, 2, 3]], e: [] };
    case 'disc': { const v = ring(32, 0.5, 0.5); return { v, f: [v.map((_, i) => i)], e: [] }; }
    case 'cyl': return cylinder(32, 1);
    case 'cone': return cylinder(32, Math.max(0, Math.min(1, p.param ?? 0.6)));
    case 'sphere': {
      const seg = 32, rings = 16, v: V[] = [[0, 0, -0.5]], f: number[][] = [];
      for (let r = 1; r < rings; r++) { const t = (r / rings) * Math.PI, z = -Math.cos(t) * 0.5, rr = Math.sin(t) * 0.5; v.push(...ring(seg, rr, z)); }
      v.push([0, 0, 0.5]);
      const at = (r: number, s: number) => 1 + (r - 1) * seg + (s % seg), top = v.length - 1;
      for (let s = 0; s < seg; s++) f.push([0, at(1, s + 1), at(1, s)]);
      for (let r = 1; r < rings - 1; r++) for (let s = 0; s < seg; s++) f.push([at(r, s), at(r, s + 1), at(r + 1, s + 1), at(r + 1, s)]);
      for (let s = 0; s < seg; s++) f.push([at(rings - 1, s), at(rings - 1, s + 1), top]);
      return { v, f, e: [] };
    }
    case 'torus': {
      const M = 48, N = 12, tube = Math.min(d, w / 2) / 2 / w, R = 0.5 - tube, v: V[] = [], f: number[][] = [];
      for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) { const a = (i / M) * TAU, b = (j / N) * TAU, rr = R + tube * Math.cos(b); v.push([Math.cos(a) * rr, Math.sin(a) * rr, (tube * w / d) * Math.sin(b)]); }
      for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) { const a = i * N + j, b = ((i + 1) % M) * N + j, c = ((i + 1) % M) * N + (j + 1) % N, e = i * N + (j + 1) % N; f.push([a, b, c, e]); }
      return { v, f, e: [] };
    }
    case 'tube': {
      const n = 32, ri = Math.max(0.01, Math.min(0.49, (p.param ?? w * 0.8) / w / 2));
      const v: V[] = [...ring(n, 0.5, 0.5), ...ring(n, ri, 0.5), ...ring(n, 0.5, -0.5), ...ring(n, ri, -0.5)];
      const f: number[][] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        f.push([i, j, n + j, n + i]);               // front
        f.push([2 * n + j, 2 * n + i, 3 * n + i, 3 * n + j]); // back
        f.push([2 * n + i, 2 * n + j, j, i]);       // outer wall
        f.push([n + i, n + j, 3 * n + j, 3 * n + i]); // inner wall
      }
      return { v, f, e: [] };
    }
    case 'rbox': default: {
      const r = Math.max(0.01, Math.min(p.param ?? 2, Math.min(w, h, d) / 2 - 0.01));
      const g = new RoundedBoxGeometry(w, h, d, 3, r).scale(1 / w, 1 / h, 1 / d);
      return fromGeometry(g);
    }
  }
}
/** Any triangle geometry → welded mesh, with coplanar triangle pairs merged back into quads. */
export function fromGeometry(g0: THREE.BufferGeometry): EMesh {
  const g = mergeVertices(g0.clone().deleteAttribute('normal').deleteAttribute('uv'), 1e-5);
  const pos = g.attributes.position, idx = g.index!;
  const v: V[] = []; for (let i = 0; i < pos.count; i++) v.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  const tris: number[][] = []; for (let i = 0; i < idx.count; i += 3) { const t = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)]; if (new Set(t).size === 3) tris.push(t); }
  const n = tris.map(t => normal(v, t));
  const byEdge = new Map<string, number[]>();
  tris.forEach((t, i) => t.forEach((a, k) => { const key = ekey(a, t[(k + 1) % 3]); (byEdge.get(key) ?? byEdge.set(key, []).get(key)!).push(i); }));
  const used = new Set<number>(), f: number[][] = [];
  tris.forEach((t, i) => {
    if (used.has(i)) return;
    for (let k = 0; k < 3 && !used.has(i); k++) {
      const a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3];
      const j = (byEdge.get(ekey(a, b)) ?? []).find(x => x !== i && !used.has(x));
      if (j == null || dot(n[i], n[j]) < 0.9999) continue;
      const o = tris[j].find(x => x !== a && x !== b)!;
      const quad = [b, c, a, o];
      if (!convex(v, quad)) continue;
      used.add(i); used.add(j); f.push(quad);
    }
    if (!used.has(i)) { used.add(i); f.push(t); }
  });
  g.dispose();
  return { v, f, e: [] };
}

/** Editable mesh (local mm) for a part, converting primitives. */
export function toEMesh(p: BuiltPart): EMesh {
  const u: EMesh = p.shape === 'mesh' && p.mesh ? { v: chunk(p.mesh.v), f: p.mesh.f.map(x => [...x]), e: (p.mesh.e ?? []).map(x => [...x] as [number, number]) } : unitPrimitive(p);
  return { ...u, v: u.v.map(([x, y, z]) => [x * p.size[0], y * p.size[1], z * p.size[2]] as V) };
}
const chunk = (a: number[]): V[] => { const out: V[] = []; for (let i = 0; i + 2 < a.length; i += 3) out.push([a[i], a[i + 1], a[i + 2]]); return out; };

/** Store an edited mesh back into the part: normalise to its box, move `pos` to the new box centre. Returns old→new vertex indices. */
export function writeEMesh(p: BuiltPart, m: EMesh): Map<number, number> {
  const { mesh: c, map } = cleanMap(m);
  const min: V = [Infinity, Infinity, Infinity], max: V = [-Infinity, -Infinity, -Infinity];
  for (const q of c.v) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], q[k]); max[k] = Math.max(max[k], q[k]); }
  if (!c.v.length) { min.fill(0); max.fill(0); }
  const size = [0, 1, 2].map(k => Math.max(0.01, max[k] - min[k])) as V, ctr = [0, 1, 2].map(k => (min[k] + max[k]) / 2) as V;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rot.map(x => x * Math.PI / 180) as V, 'XYZ'));
  const off = new THREE.Vector3(...ctr).applyQuaternion(q);
  p.pos = [p.pos[0] + off.x, p.pos[1] + off.y, p.pos[2] + off.z].map(r4) as V;
  p.size = size.map(r4) as V;
  p.shape = 'mesh'; p.param = undefined;
  p.mesh = { v: c.v.flatMap(q2 => [0, 1, 2].map(k => r6(max[k] - min[k] < 1e-6 ? 0 : (q2[k] - ctr[k]) / (max[k] - min[k])))), f: c.f, e: c.e.length ? c.e : undefined };
  return map;
}
const r4 = (x: number) => Math.round(x * 1e4) / 1e4, r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Drop degenerate faces, unused vertices and duplicate loose edges; reindex. */
export const clean = (m: EMesh): EMesh => cleanMap(m).mesh;
function cleanMap(m: EMesh): { mesh: EMesh; map: Map<number, number> } {
  const f = m.f.map(face => face.filter((x, i) => x !== face[(i + 1) % face.length])).filter(face => new Set(face).size >= 3);
  const faceEdges = new Set<string>(); f.forEach(face => face.forEach((a, i) => faceEdges.add(ekey(a, face[(i + 1) % face.length]))));
  const seen = new Set<string>();
  const e = m.e.filter(([a, b]) => a !== b && !faceEdges.has(ekey(a, b)) && !seen.has(ekey(a, b)) && seen.add(ekey(a, b)));
  const used = new Set<number>(); f.forEach(x => x.forEach(i => used.add(i))); e.forEach(([a, b]) => { used.add(a); used.add(b); });
  const map = new Map<number, number>(), v: V[] = [];
  m.v.forEach((q, i) => { if (used.has(i)) { map.set(i, v.length); v.push(q); } });
  return { mesh: { v, f: f.map(x => x.map(i => map.get(i)!)), e: e.map(([a, b]) => [map.get(a)!, map.get(b)!] as [number, number]) }, map };
}

// ------------------------------------------------------------------ render geometry
function sub(a: V, b: V): V { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V, b: V): V { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: V, b: V) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function len(a: V) { return Math.hypot(a[0], a[1], a[2]); }
/** Newell normal of a polygon (works for non-planar and concave loops). */
export function normal(v: V[], face: number[]): V {
  const n: V = [0, 0, 0];
  for (let i = 0; i < face.length; i++) { const a = v[face[i]], b = v[face[(i + 1) % face.length]]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
  const l = len(n) || 1; return [n[0] / l, n[1] / l, n[2] / l];
}
export function centroid(v: V[], idx: number[]): V { const c: V = [0, 0, 0]; idx.forEach(i => { c[0] += v[i][0]; c[1] += v[i][1]; c[2] += v[i][2]; }); const n = idx.length || 1; return [c[0] / n, c[1] / n, c[2] / n]; }
function convex(v: V[], q: number[]) { const n = normal(v, q); for (let i = 0; i < 4; i++) { const a = v[q[i]], b = v[q[(i + 1) % 4]], c = v[q[(i + 2) % 4]]; if (dot(cross(sub(b, a), sub(c, b)), n) < -1e-9) return false; } return true; }
/** Triangulate one polygon: fan for convex, ear clipping (via its plane) otherwise. */
export function triangulate(v: V[], face: number[]): number[][] {
  if (face.length === 3) return [face];
  if (face.length === 4 && convex(v, face)) return [[face[0], face[1], face[2]], [face[0], face[2], face[3]]];
  const n = normal(v, face), ax = Math.abs(n[0]) > Math.abs(n[1]) && Math.abs(n[0]) > Math.abs(n[2]) ? 0 : Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2;
  const [i0, i1] = ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1], flip = n[ax] < 0;
  const pts = face.map(i => new THREE.Vector2(v[i][i0], v[i][i1] * (flip ? -1 : 1)));
  const tri = THREE.ShapeUtils.triangulateShape(pts, []);
  return tri.length ? tri.map(t => t.map(k => face[k])) : face.slice(1, -1).map((_, k) => [face[0], face[k + 1], face[k + 2]]);
}
/** BufferGeometry for a mesh in local mm; userData.triFace maps triangle → polygon (for picking). */
export function meshGeometry(m: EMesh, smooth = false, uvs = false): THREE.BufferGeometry {
  const tris: number[][] = [], triFace: number[] = [];
  m.f.forEach((face, fi) => triangulate(m.v, face).forEach(t => { tris.push(t); triFace.push(fi); }));
  const g = new THREE.BufferGeometry();
  if (smooth) {
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.v.flat(), 3));
    g.setIndex(tris.flat());
  } else {
    const pos: number[] = []; tris.forEach(t => t.forEach(i => pos.push(...m.v[i])));
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }
  g.computeVertexNormals();
  if (uvs) {
    g.computeBoundingBox(); const b = g.boundingBox!, s = b.getSize(new THREE.Vector3());
    const ax = [0, 1, 2].sort((i, j) => s.getComponent(j) - s.getComponent(i)), p = g.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { const q = [p.getX(i), p.getY(i), p.getZ(i)]; uv[i * 2] = (q[ax[0]] - b.min.getComponent(ax[0])) / (s.getComponent(ax[0]) || 1); uv[i * 2 + 1] = (q[ax[1]] - b.min.getComponent(ax[1])) / (s.getComponent(ax[1]) || 1); }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  g.userData.triFace = triFace;
  return g;
}
export const partMeshGeometry = (p: BuiltPart) => meshGeometry(toEMesh(p), !!p.smooth, p.role === 'screen');

// ------------------------------------------------------------------ topology helpers
export function edges(m: EMesh) {
  const map = new Map<string, { a: number; b: number; faces: number[] }>();
  m.f.forEach((face, fi) => face.forEach((a, i) => { const b = face[(i + 1) % face.length], k = ekey(a, b); const e = map.get(k) ?? map.set(k, { a: Math.min(a, b), b: Math.max(a, b), faces: [] }).get(k)!; e.faces.push(fi); }));
  for (const [a, b] of m.e) { const k = ekey(a, b); if (!map.has(k)) map.set(k, { a: Math.min(a, b), b: Math.max(a, b), faces: [] }); }
  return map;
}
export const faceSelected = (face: number[], sel: Set<number>) => face.every(i => sel.has(i));

/** Region extrude of selected faces, or edge/vertex extrude. Returns the new verts and the move direction. */
export function extrude(m: EMesh, sel: Set<number>): { sel: Set<number>; dir: V | null } {
  const faces = m.f.map((f, i) => (faceSelected(f, sel) ? i : -1)).filter(i => i >= 0);
  const dup = new Map<number, number>(), nv = (i: number) => dup.get(i) ?? (dup.set(i, m.v.push([...m.v[i]] as V) - 1), dup.get(i)!);
  if (faces.length) {
    const fs = new Set(faces), count = new Map<string, number>();
    faces.forEach(fi => m.f[fi].forEach((a, i) => { const k = ekey(a, m.f[fi][(i + 1) % m.f[fi].length]); count.set(k, (count.get(k) ?? 0) + 1); }));
    const n: V = [0, 0, 0]; faces.forEach(fi => { const q = normal(m.v, m.f[fi]); n[0] += q[0]; n[1] += q[1]; n[2] += q[2]; });
    const walls: number[][] = [];
    faces.forEach(fi => { const f = m.f[fi]; f.forEach((a, i) => { const b = f[(i + 1) % f.length]; if (count.get(ekey(a, b)) === 1) walls.push([a, b, nv(b), nv(a)]); }); });
    faces.forEach(fi => { m.f[fi] = m.f[fi].map(nv); });
    m.f.push(...walls);
    void fs;
    const l = len(n) || 1;
    return { sel: new Set(dup.values()), dir: [n[0] / l, n[1] / l, n[2] / l] };
  }
  const es = [...edges(m).values()].filter(e => sel.has(e.a) && sel.has(e.b));
  if (es.length) { es.forEach(e => m.f.push([e.a, e.b, nv(e.b), nv(e.a)])); return { sel: new Set(dup.values()), dir: null }; }
  [...sel].forEach(i => m.e.push([i, nv(i)]));
  return { sel: new Set(dup.values()), dir: null };
}
/** Inset each selected face by `t` mm. */
export function inset(m: EMesh, sel: Set<number>, t: number): Set<number> {
  const out = new Set<number>();
  m.f.forEach((f, fi) => {
    if (!faceSelected(f, sel)) return;
    const c = centroid(m.v, f);
    const inner = f.map(i => { const d = sub(c, m.v[i]), l = len(d); const k = l > 1e-9 ? Math.min(t, l * 0.98) / l : 0; return m.v.push([m.v[i][0] + d[0] * k, m.v[i][1] + d[1] * k, m.v[i][2] + d[2] * k]) - 1; });
    f.forEach((a, i) => { const j = (i + 1) % f.length; m.f.push([a, f[j], inner[j], inner[i]]); });
    m.f[fi] = inner; inner.forEach(i => out.add(i));
  });
  return out;
}
/** Subdivide selected faces once (each corner becomes a quad); neighbours get the edge midpoints. */
export function subdivide(m: EMesh, sel: Set<number>): Set<number> {
  const faces = new Set(m.f.map((f, i) => (faceSelected(f, sel) ? i : -1)).filter(i => i >= 0));
  if (!faces.size) return sel;
  const mid = new Map<string, number>(), mp = (a: number, b: number) => { const k = ekey(a, b); if (!mid.has(k)) mid.set(k, m.v.push([(m.v[a][0] + m.v[b][0]) / 2, (m.v[a][1] + m.v[b][1]) / 2, (m.v[a][2] + m.v[b][2]) / 2]) - 1); return mid.get(k)!; };
  faces.forEach(fi => m.f[fi].forEach((a, i) => mp(a, m.f[fi][(i + 1) % m.f[fi].length])));
  const next: number[][] = [], out = new Set<number>();
  m.f.forEach((f, fi) => {
    if (faces.has(fi)) {
      const c = m.v.push(centroid(m.v, f)) - 1; out.add(c);
      f.forEach((a, i) => { const prev = f[(i - 1 + f.length) % f.length], nx = f[(i + 1) % f.length]; next.push([a, mp(a, nx), c, mp(prev, a)]); out.add(a); out.add(mp(a, nx)); });
    } else {
      const g: number[] = []; f.forEach((a, i) => { g.push(a); const k = mid.get(ekey(a, f[(i + 1) % f.length])); if (k != null) g.push(k); }); next.push(g);
    }
  });
  m.f = next; return out;
}
/** Quads across from each other, starting at an edge (the loop-cut ring). */
export function edgeRing(m: EMesh, a: number, b: number): { faces: number[]; edges: [number, number][] } {
  const em = edges(m), faces: number[] = [], ring: [number, number][] = [[a, b]], seen = new Set<number>();
  for (const start of em.get(ekey(a, b))?.faces ?? []) {
    let fi = start, ea = a, eb = b;
    while (fi != null && !seen.has(fi) && m.f[fi].length === 4) {
      seen.add(fi); faces.push(fi);
      const f = m.f[fi], i = f.findIndex((x, k) => ekey(x, f[(k + 1) % 4]) === ekey(ea, eb));
      const oa = f[(i + 2) % 4], ob = f[(i + 3) % 4];
      if (ekey(oa, ob) === ekey(a, b)) break; // closed loop
      ring.push([oa, ob]);
      fi = em.get(ekey(oa, ob))!.faces.find(x => x !== fi)!; ea = oa; eb = ob;
    }
  }
  return { faces, edges: ring };
}
/** Cut a loop through the ring at the middle; returns the new loop's verts. */
export function loopCut(m: EMesh, a: number, b: number): Set<number> {
  const { faces, edges: ring } = edgeRing(m, a, b);
  if (!faces.length) return new Set();
  const mid = new Map<string, number>();
  for (const [x, y] of ring) if (!mid.has(ekey(x, y))) mid.set(ekey(x, y), m.v.push([(m.v[x][0] + m.v[y][0]) / 2, (m.v[x][1] + m.v[y][1]) / 2, (m.v[x][2] + m.v[y][2]) / 2]) - 1);
  const fs = new Set(faces), next: number[][] = [];
  m.f.forEach((f, fi) => {
    if (fs.has(fi)) {
      const i = f.findIndex((x, k) => mid.has(ekey(x, f[(k + 1) % 4])) && mid.has(ekey(f[(k + 2) % 4], f[(k + 3) % 4])));
      const [p0, p1, p2, p3] = [0, 1, 2, 3].map(k => f[(i + k) % 4]), m01 = mid.get(ekey(p0, p1))!, m23 = mid.get(ekey(p2, p3))!;
      next.push([p0, m01, m23, p3], [m01, p1, p2, m23]);
    } else { const g: number[] = []; f.forEach((x, i) => { g.push(x); const k = mid.get(ekey(x, f[(i + 1) % f.length])); if (k != null) g.push(k); }); next.push(g); }
  });
  m.f = next; return new Set(mid.values());
}
/** Merge the selection into one vertex at `to`. */
export function merge(m: EMesh, sel: Set<number>, to: V): number {
  const ids = [...sel]; if (!ids.length) return -1;
  const keep = ids[0]; m.v[keep] = [...to] as V;
  const map = (i: number) => (sel.has(i) ? keep : i);
  m.f = m.f.map(f => f.map(map)); m.e = m.e.map(([a, b]) => [map(a), map(b)] as [number, number]);
  return keep;
}
export function mergeByDistance(m: EMesh, sel: Set<number>, dist = 0.05): number {
  const ids = [...sel], rep = new Map<number, number>(); let n = 0;
  for (let i = 0; i < ids.length; i++) { if (rep.has(ids[i])) continue; for (let j = i + 1; j < ids.length; j++) if (!rep.has(ids[j]) && len(sub(m.v[ids[i]], m.v[ids[j]])) <= dist) { rep.set(ids[j], ids[i]); n++; } }
  const map = (i: number) => rep.get(i) ?? i;
  m.f = m.f.map(f => f.map(map)); m.e = m.e.map(([a, b]) => [map(a), map(b)] as [number, number]);
  return n;
}
/** Make a face (or an edge, for two verts) from the selection. */
export function fill(m: EMesh, sel: Set<number>): boolean {
  const ids = [...sel];
  if (ids.length === 2) { m.e.push([ids[0], ids[1]]); return true; }
  if (ids.length < 3) return false;
  const c = centroid(m.v, ids);
  let n = normal(m.v, ids); if (len(n) < 0.5) n = [0, 0, 1];
  const u = (() => { const t = sub(m.v[ids[0]], c), l = len(t) || 1; return [t[0] / l, t[1] / l, t[2] / l] as V; })(), w = cross(n, u);
  ids.sort((a, b) => { const pa = sub(m.v[a], c), pb = sub(m.v[b], c); return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u)); });
  m.f.push(ids); return true;
}
export function deleteVerts(m: EMesh, sel: Set<number>) { m.f = m.f.filter(f => !f.some(i => sel.has(i))); m.e = m.e.filter(([a, b]) => !sel.has(a) && !sel.has(b)); }
export function deleteEdges(m: EMesh, sel: Set<number>) {
  const hit = (a: number, b: number) => sel.has(a) && sel.has(b);
  m.f = m.f.filter(f => !f.some((a, i) => hit(a, f[(i + 1) % f.length]))); m.e = m.e.filter(([a, b]) => !hit(a, b));
}
export function deleteFaces(m: EMesh, sel: Set<number>) { m.f = m.f.filter(f => !faceSelected(f, sel)); }
export function flip(m: EMesh, sel: Set<number>) { m.f = m.f.map(f => (faceSelected(f, sel) ? [...f].reverse() : f)); }
/** Make winding consistent across each connected piece and point it outward. */
export function recalcNormals(m: EMesh, sel: Set<number>, inside = false) {
  const target = m.f.map((f, i) => (faceSelected(f, sel) ? i : -1)).filter(i => i >= 0); if (!target.length) return;
  const em = edges(m), done = new Set<number>();
  for (const start of target) {
    if (done.has(start)) continue;
    const comp: number[] = [], q = [start]; done.add(start);
    while (q.length) {
      const fi = q.pop()!; comp.push(fi); const f = m.f[fi];
      f.forEach((a, i) => { const b = f[(i + 1) % f.length];
        for (const nb of em.get(ekey(a, b))!.faces) {
          if (done.has(nb) || !faceSelected(m.f[nb], sel)) continue;
          const g = m.f[nb], same = g.some((x, k) => x === a && g[(k + 1) % g.length] === b);
          if (same) m.f[nb] = [...g].reverse();
          done.add(nb); q.push(nb);
        } });
    }
    let vol = 0; for (const fi of comp) for (const t of triangulate(m.v, m.f[fi])) vol += dot(m.v[t[0]], cross(m.v[t[1]], m.v[t[2]]));
    if ((vol < 0) !== inside) comp.forEach(fi => { m.f[fi] = [...m.f[fi]].reverse(); });
  }
}
/** Faces/verts connected to the seeds. */
export function linked(m: EMesh, seeds: Iterable<number>): Set<number> {
  const adj = new Map<number, Set<number>>(), link = (a: number, b: number) => { (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a); };
  m.f.forEach(f => f.forEach((a, i) => link(a, f[(i + 1) % f.length]))); m.e.forEach(([a, b]) => link(a, b));
  const out = new Set<number>(), q = [...seeds]; q.forEach(i => out.add(i));
  while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!out.has(n)) { out.add(n); q.push(n); }
  return out;
}
/** Copy selected faces (and loose selected edges) as new geometry; returns the new verts. */
export function duplicateSel(m: EMesh, sel: Set<number>): Set<number> {
  const map = new Map<number, number>(), nv = (i: number) => map.get(i) ?? (map.set(i, m.v.push([...m.v[i]] as V) - 1), map.get(i)!);
  m.f.filter(f => faceSelected(f, sel)).forEach(f => m.f.push(f.map(nv)));
  m.e.filter(([a, b]) => sel.has(a) && sel.has(b)).forEach(([a, b]) => m.e.push([nv(a), nv(b)]));
  if (!map.size) [...sel].forEach(nv);
  return new Set(map.values());
}
/** Append another mesh (already in this mesh's local space). */
export function append(m: EMesh, o: EMesh): Set<number> {
  const base = m.v.length; m.v.push(...o.v); m.f.push(...o.f.map(f => f.map(i => i + base))); m.e.push(...o.e.map(([a, b]) => [a + base, b + base] as [number, number]));
  return new Set(o.v.map((_, i) => base + i));
}
