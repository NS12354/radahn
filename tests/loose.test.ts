import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { robotProject, ROBOT_KINDS } from '../src/app/robots';
import { syncLooseParts, attachLoose, rootPart } from '../src/app/loose';
import { newUid } from '../src/app/project';

describe('loose electronics in a robot world', () => {
  it('leaves the robot templates as they are', () => {
    for (const k of ROBOT_KINDS) {
      const p = robotProject(k.id);
      const before = JSON.stringify(p.product.built!.robot!.world?.obstacles ?? []);
      syncLooseParts(p);
      expect(JSON.stringify(p.product.built!.robot!.world?.obstacles ?? []), k.id).toBe(before);
    }
  });
  it('puts a newly added part in the world once, attaches it on the robot, and removes it with the part', () => {
    const p = robotProject('arm'), m = p.product.built!, w = m.robot!.world!;
    syncLooseParts(p);
    const n0 = w.obstacles.length, parts0 = m.parts.length;
    const uid = newUid();
    p.electronics.comps.push({ uid, type: 'oled', pins: {} } as any);
    expect(syncLooseParts(p)).toBe(true);
    const i = w.obstacles.findIndex(o => o.comp === uid);
    expect(i).toBeGreaterThanOrEqual(0);
    const o = w.obstacles[i];
    expect(o.name).toMatch(/OLED|SSD1306/i);
    expect(o.size[1]).toBeLessThan(o.size[0]); // lying flat
    expect(Math.abs(o.pos[0]) <= w.size / 2 && Math.abs(o.pos[1]) <= w.size / 2).toBe(true);
    expect(syncLooseParts(p)).toBe(false); // stable
    // deleting the loose object doesn't bring it back
    const copy = JSON.parse(JSON.stringify(p));
    copy.product.built.robot.world.obstacles.splice(i, 1);
    expect(syncLooseParts(copy)).toBe(false);
    // attach where it lies: real parts on top of the robot's base, parented to it
    const made = attachLoose(p, i, new THREE.Matrix4())!;
    expect(made.length).toBeGreaterThan(0);
    expect(w.obstacles.length).toBe(n0);
    const root = rootPart(m.parts)!;
    for (const q of made) { expect(q.parent).toBe(root.id); expect(q.comp).toBe(uid); expect(q.attached).toBe(true); expect(q.pos[1]).toBeGreaterThanOrEqual(root.pos[1] + root.size[1] / 2 - 0.1); }
    expect(syncLooseParts(p)).toBe(false); // attached counts as placed
    // removing the component in Electronics removes its attached parts
    p.electronics.comps = p.electronics.comps.filter(c => c.uid !== uid);
    expect(syncLooseParts(p)).toBe(true);
    expect(m.parts.length).toBe(parts0);
  });
});
