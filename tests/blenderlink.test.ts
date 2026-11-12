import { describe, it, expect } from 'vitest';
import { toBlender, fromBlender, geoHash } from '../src/app/blenderlink';
import { newBuiltModel, type BuiltModel } from '../src/app/project';

const model = (): BuiltModel => {
  const b = newBuiltModel();
  b.parts[0].pos = [5, -3, 12]; b.parts[0].rot = [10, 25, -40];
  b.parts.push({ id: 'g', name: 'Grille', shape: 'box', size: [2, 1, 10], pos: [-10, -20, 4], rot: [0, 0, 30], color: '#111111', finish: 'matte', role: 'body', array: { n: 5, mode: 'linear', step: [3, 0, 1] } });
  return b;
};

describe('Blender live link', () => {
  it('maps Formframe Y-up to Blender Z-up (front view looks along +Y)', () => {
    const b = model(), m = toBlender('t', b), housing = m.parts[0];
    // translation column of the column-major matrix: ours (5,-3,12) → Blender (5,-12,-3)
    expect(housing.matrix.slice(12, 15).map(x => Math.round(x * 1e6) / 1e6)).toEqual([5, -12, -3]);
    expect(housing.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('round-trips transforms, arrays and primitives untouched by Blender', () => {
    const b = model(), sent = toBlender('t', b);
    const back = fromBlender({ ...sent, parts: sent.parts.map(p => ({ ...p, mesh: undefined })) }, b).built; // Blender changed nothing
    for (const [a, c] of b.parts.map((p, i) => [p, back.parts[i]] as const)) {
      expect(c.shape).toBe(a.shape);
      c.pos.forEach((x, k) => expect(x).toBeCloseTo(a.pos[k], 3));
      c.rot.forEach((x, k) => expect(x).toBeCloseTo(a.rot[k], 2));
    }
    back.parts[1].array!.step!.forEach((x, k) => expect(x).toBeCloseTo(b.parts[1].array!.step![k], 3));
    // sending again keeps Blender's own matrix and hash (so its modifiers survive)
    const again = toBlender('t', back);
    expect(again.parts.map(p => p.hash)).toEqual(sent.parts.map(p => p.hash));
    again.parts[0].matrix.forEach((x, k) => expect(x).toBeCloseTo(sent.parts[0].matrix[k], 6));
  });

  it('takes Blender geometry, deletes missing parts and adds new objects', () => {
    const b = model(), sent = toBlender('t', b);
    const cube = { ...sent.parts[1], id: 'bnew', name: 'Knob', array: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 40, 1],
      mesh: { v: [-5, -5, -5, 5, -5, -5, -5, 5, -5, 5, 5, -5, -5, -5, 5, 5, -5, 5, -5, 5, 5, 5, 5, 5], f: [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]] } };
    const r = fromBlender({ ...sent, parts: [{ ...sent.parts[0], mesh: undefined }, cube] }, b);
    expect(r.removed).toBe(1); expect(r.added).toBe(1);
    const k = r.built.parts.find(p => p.name === 'Knob')!;
    expect(k.shape).toBe('mesh'); expect(k.size).toEqual([10, 10, 10]); expect(k.pos[1]).toBeCloseTo(40); // Blender Z 40 → our Y 40
    expect(geoHash([[0, 0, 0]], [])).toBe(geoHash([[-0.0001, 0, 0]], []));
  });
});
