import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { robotProject } from '../src/app/robots';
import { RobotSim } from '../src/app/robot';
import { loadPhysics } from '../src/app/physics';
import { obstacleGrams, type Obstacle } from '../src/app/project';
import type { CompInstance } from '../src/hw/types';

beforeAll(async () => { await loadPhysics(); }, 30_000);

function bench(comps: CompInstance[]) {
  const st = new Map<string, any>();
  for (const c of comps) st.set(c.uid, c.type === 'pca9685' ? { ch: Array.from({ length: 16 }, () => ({ angle: null })) } : { a: 0, b: 0, speed: 0, cm: 0, down: false, edges: 0 });
  return { st, b: { model: (uid: string) => (st.has(uid) ? { state: st.get(uid), sim: { press: () => {}, tilt: () => {}, turn: () => {} } } as any : undefined) } };
}
/** A rover facing one obstacle 260 mm ahead, driving at full power for `secs`. */
async function shove(ob: Obstacle, secs = 4) {
  const p = robotProject('rover-avoid'), comps = p.electronics.comps;
  p.product.built!.robot!.world = { size: 2400, obstacles: [ob] };
  const sim = new RobotSim(p.product.built!), { st, b } = bench(comps);
  sim.settle();
  await sim.setPhysics(true, comps);
  const drv = comps.find(c => c.type === 'tb6612')!;
  st.get(drv.uid).a = 1; st.get(drv.uid).b = 1;
  for (let t = 0; t < secs; t += 1 / 60) sim.step(1 / 60, comps, b, true);
  const o = sim.objects[0], at = o ? new THREE.Vector3().setFromMatrixPosition(o.m) : null;
  return { roverZ: sim.body.z, objZ: at?.z ?? ob.pos[1], sim };
}
const box = (material: Obstacle['material'], size: [number, number, number] = [160, 120, 160]): Obstacle => ({ shape: 'box', pos: [0, 340], size, material, name: 'Box' });

describe('collisions by weight', () => {
  it('weights come from size and material', () => {
    expect(obstacleGrams(box('cardboard'))).toBe(215);   // 160×120×160 mm of mostly-air box
    expect(obstacleGrams(box('wood'))).toBe(1843);
    expect(obstacleGrams({ ...box('wood'), mass: 50 })).toBe(50);
  });
  it('a rover cannot drive through a fixed obstacle', async () => {
    const { roverZ, objZ } = await shove(box('fixed'));
    expect(objZ).toBe(340);
    // the box's near face is at 260; the rover's nose (≈ +100 mm from its centre) stops there
    expect(roverZ).toBeLessThan(260 - 60);
    expect(roverZ).toBeGreaterThan(60); // it did drive up to it
  });
  it('it pushes a light cardboard box along', async () => {
    const { roverZ, objZ } = await shove(box('cardboard'));
    expect(objZ).toBeGreaterThan(340 + 80);
    expect(roverZ).toBeGreaterThan(200); // past where the fixed box stopped it
    expect(objZ - roverZ).toBeGreaterThan(80); // still in front of it, not passed through
  });
  it('a heavy wooden crate barely moves under the same push', async () => {
    const light = await shove(box('cardboard')), heavy = await shove(box('wood'));
    expect(heavy.objZ - 340).toBeLessThan((light.objZ - 340) / 3);
    expect(heavy.objZ - heavy.roverZ).toBeGreaterThan(80); // the rover is still in front of it
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROBOT_LIBS } from '../src/hw/robotcode';
let hasPy = true; try { execFileSync('python3', ['-c', 'pass']); } catch { hasPy = false; }

describe('the arm under physics', () => {
  (hasPy ? it : it.skip)('grips the block by friction alone, carries it and sets it on the pad', async () => {
    const main = robotProject('arm').electronics.files['main.py'];
    const moves = [...main.matchAll(/arm\.move_to\(([-\d]+), ([-\d]+), ([-\d]+)\)|arm\.grip\((True|False)\)/g)].map(m => (m[4] ? m[4] === 'True' : [+m[1], +m[2], +m[3]]));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-arm-'));
    for (const [n, s] of Object.entries(ROBOT_LIBS)) fs.writeFileSync(path.join(dir, path.basename(n)), s);
    fs.writeFileSync(path.join(dir, 'run.py'), `import json, time\ntime.sleep = lambda s: None\nfrom arm import Arm\nclass S:\n    def angle(self, ch, a): pass\na = Arm(S())\nprint(json.dumps([m if isinstance(m, bool) else a.ik(*m) for m in ${JSON.stringify(moves).replace(/true/g, 'True').replace(/false/g, 'False')}]))`);
    const ik: (number[] | boolean)[] = JSON.parse(execFileSync('python3', ['run.py'], { cwd: dir, encoding: 'utf8' }));
    fs.rmSync(dir, { recursive: true, force: true });
    const p = robotProject('arm'), comps = p.electronics.comps, sim = new RobotSim(p.product.built!), { st, b } = bench(comps);
    const ch = st.get(comps.find(c => c.type === 'pca9685')!.uid).ch;
    sim.settle(); await sim.setPhysics(true, comps);
    expect(sim.phys).not.toBeNull();
    const block = () => new THREE.Vector3().setFromMatrixPosition(sim.objects[0].m);
    const run = (s: number) => { for (let t = 0; t < s; t += 1 / 60) sim.step(1 / 60, comps, b, true); };
    ch[4].angle = 10; run(1);
    let maxY = 0;
    for (const step of ik.slice(1)) {
      if (typeof step === 'boolean') { ch[4].angle = step ? 170 : 10; run(0.8); continue; }
      step.forEach((q, i) => (ch[i].angle = 90 + q)); run(2.5);
      maxY = Math.max(maxY, block().y);
    }
    const end = block();
    expect(maxY).toBeGreaterThan(80); // lifted well off the table by the fingers' grip
    expect(Math.hypot(end.x - 120, end.z - 150)).toBeLessThan(6); // on the pad
    expect(end.y).toBeGreaterThan(4 + 6); // resting on top of the 4 mm pad, not sunk into it
  }, 60_000);
});
