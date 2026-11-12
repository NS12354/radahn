import { describe, it, expect } from 'vitest';
import { toEMesh, writeEMesh, edges, extrude, inset, loopCut, subdivide, merge, recalcNormals, flip, triangulate, centroid, type EMesh } from '../src/scene/mesh';
import type { BuiltPart, ShapeKind } from '../src/app/project';

const part = (shape: ShapeKind, size: [number, number, number] = [20, 20, 20], param?: number): BuiltPart =>
  ({ id: 'p', name: 'P', shape, size, pos: [0, 0, 0], rot: [0, 0, 0], color: '#fff', finish: 'matte', role: 'body', param });
/** Signed volume (positive = faces point outward). */
const volume = (m: EMesh) => { let v = 0; for (const f of m.f) for (const [a, b, c] of triangulate(m.v, f)) { const [p, q, r] = [m.v[a], m.v[b], m.v[c]]; v += p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]); } return v / 6; };
const watertight = (m: EMesh) => [...edges(m).values()].every(e => e.faces.length === 2);
const all = (m: EMesh) => new Set(m.v.map((_, i) => i));

describe('edit-mode meshes', () => {
  it('converts every closed primitive to a watertight, outward-facing mesh of the same size', () => {
    for (const [k, param] of [['box'], ['rbox', 3], ['cyl'], ['cone', 0.5], ['cone', 0], ['sphere'], ['torus'], ['tube', 12]] as [ShapeKind, number?][]) {
      const m = toEMesh(part(k, [20, 20, k === 'torus' ? 5 : 20], param));
      expect(watertight(m), k).toBe(true);
      expect(volume(m), k).toBeGreaterThan(0);
    }
    const cube = toEMesh(part('box', [10, 20, 30]));
    expect(cube.f.every(f => f.length === 4)).toBe(true);
    expect(Math.abs(volume(cube) - 6000)).toBeLessThan(1e-6);
    expect(toEMesh(part('rbox', [40, 20, 30], 3)).f.filter(f => f.length === 4).length).toBeGreaterThan(50); // triangles merged back into quads
  });

  it('extrudes a face into a closed, bigger solid', () => {
    const m = toEMesh(part('box')), top = new Set(m.f[1]); // +Z face
    const r = extrude(m, top);
    expect(r.dir![2]).toBeCloseTo(1);
    r.sel.forEach(i => (m.v[i][2] += 10));
    expect(watertight(m)).toBe(true);
    expect(m.f.length).toBe(10);
    expect(volume(m)).toBeCloseTo(20 * 20 * 30);
  });

  it('insets, loop-cuts and subdivides without opening the surface', () => {
    const a = toEMesh(part('box')); inset(a, new Set(a.f[1]), 3);
    expect(a.f.length).toBe(10); expect(watertight(a)).toBe(true); expect(volume(a)).toBeCloseTo(8000);
    const b = toEMesh(part('box')), [e0, e1] = b.f[2]; const loop = loopCut(b, e0, e1);
    expect(loop.size).toBe(4); expect(b.f.length).toBe(10); expect(watertight(b)).toBe(true);
    const c = toEMesh(part('box')); subdivide(c, all(c));
    expect(c.f.length).toBe(24); expect(watertight(c)).toBe(true); expect(volume(c)).toBeCloseTo(8000);
  });

  it('merges, fixes flipped normals, and round-trips through the part', () => {
    const m = toEMesh(part('box')); merge(m, new Set(m.f[1]), centroid(m.v, m.f[1])); // collapse the top into a point → pyramid
    const p = part('box'); writeEMesh(p, m);
    const back = toEMesh(p);
    expect(back.v.length).toBe(5); expect(back.f.length).toBe(5); expect(watertight(back)).toBe(true);
    expect(p.size[2]).toBeCloseTo(20); expect(p.shape).toBe('mesh');
    flip(back, new Set([0, 1])); recalcNormals(back, all(back)); expect(volume(back)).toBeGreaterThan(0);
    const flipped = toEMesh(part('box')); flip(flipped, all(flipped)); recalcNormals(flipped, all(flipped)); expect(volume(flipped)).toBeCloseTo(8000);
  });

  it('keeps the part box centred on the geometry after an off-centre edit', () => {
    const p = part('box'), m = toEMesh(p), r = extrude(m, new Set(m.f[1])); r.sel.forEach(i => (m.v[i][2] += 10));
    writeEMesh(p, m);
    expect(p.size).toEqual([20, 20, 30]); expect(p.pos[2]).toBeCloseTo(5);
  });
});
