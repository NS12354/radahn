import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { robotProject } from '../src/app/robots';
import { RobotSim } from '../src/app/robot';
import { loadPhysics } from '../src/app/physics';
import type { CompInstance } from '../src/hw/types';

beforeAll(async () => { await loadPhysics(); }, 30_000);

function bench(comps: CompInstance[]) {
  const st = new Map<string, any>();
  for (const c of comps) st.set(c.uid, c.type === 'pca9685' ? { ch: Array.from({ length: 16 }, () => ({ angle: null })) } : { a: 0, b: 0, speed: 0, cm: 0, down: false, edges: 0 });
  return { st, b: { model: (uid: string) => (st.has(uid) ? { state: st.get(uid), sim: { press: () => {}, tilt: () => {}, turn: () => {} } } as any : undefined) } };
}
const bodyY = (s: RobotSim, name: string, restY: number) => new THREE.Vector3(0, restY, 0).applyMatrix4(s.pose.get(s.model.parts.find(p => p.name === name)!.id)!).y;

describe('rigid-body physics (Rapier)', () => {
  it('a robot dog stands on its servos without collapsing', async () => {
    const p = robotProject('dog'), comps = p.electronics.comps, sim = new RobotSim(p.product.built!), { st, b } = bench(comps);
    sim.settle();
    await sim.setPhysics(true, comps);
    const pca = comps.find(c => c.type === 'pca9685')!;
    for (let ch = 0; ch < 12; ch++) st.get(pca.uid).ch[ch].angle = 90; // hold the rest pose
    for (let i = 0; i < 120; i++) sim.step(1 / 60, comps, b, true);
    expect(sim.legs.fallen).toBe(false);
    expect(bodyY(sim, 'Body', 160)).toBeGreaterThan(140); // still standing tall
  });
  it('on micro servos the same dog sags and its knees give way', async () => {
    const p = robotProject('dog'), comps = p.electronics.comps;
    const pca = comps.find(c => c.type === 'pca9685')!;
    pca.props!.servos = pca.props!.servos.map((s: any) => ({ ...s, type: 'sg90' }));
    const sim = new RobotSim(p.product.built!), { st, b } = bench(comps);
    sim.settle();
    // crouch: hips forward, knees bent, where the lever arm is long
    const crouch = [90, 90 - 40, 90 + 80];
    for (let leg = 0; leg < 4; leg++) crouch.forEach((a, k) => { st.get(pca.uid).ch[leg * 3 + k].angle = a; });
    for (let i = 0; i < 60; i++) sim.step(1 / 60, comps, b, true); // kinematic: get into the crouch
    await sim.setPhysics(true, comps);
    const before = bodyY(sim, 'Body', 160);
    for (let i = 0; i < 120; i++) sim.step(1 / 60, comps, b, true);
    expect(bodyY(sim, 'Body', 160)).toBeLessThan(before - 10);
  });
  it('a rover drives forward on wheel traction', async () => {
    const p = robotProject('rover-avoid'), comps = p.electronics.comps, sim = new RobotSim(p.product.built!), { st, b } = bench(comps);
    sim.settle();
    await sim.setPhysics(true, comps);
    const drv = comps.find(c => c.type === 'tb6612')!;
    st.get(drv.uid).a = 0.6; st.get(drv.uid).b = 0.6;
    for (let i = 0; i < 90; i++) sim.step(1 / 60, comps, b, true);
    expect(sim.body.z).toBeGreaterThan(100);
    expect(Math.abs(sim.body.x)).toBeLessThan(40);
    expect(sim.legs.fallen).toBe(false);
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROBOT_LIBS } from '../src/hw/robotcode';
let hasPy = true; try { execFileSync('python3', ['-c', 'pass']); } catch { hasPy = false; }

describe('walking under physics', () => {
  (hasPy ? it : it.skip)('the dog walks forward with its creep gait and stays up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-phys-'));
    for (const [n, src] of Object.entries(ROBOT_LIBS)) fs.writeFileSync(path.join(dir, path.basename(n)), src);
    fs.writeFileSync(path.join(dir, 'run.py'), `import json, time\ntime.sleep = lambda s: None\nfrom legs import Legs, dog_leg_ik\nframes = []\nclass S:\n    def __init__(self): self.a = [90] * 16\n    def angle(self, ch, a): self.a[ch] = a\nA = S()\norig = Legs.apply\ndef rec(self, feet=None):\n    orig(self, feet)\n    frames.append(list(A.a))\nLegs.apply = rec\ndog = Legs([(A, (0, 1, 2)), (A, (3, 4, 5)), (A, (6, 7, 8)), (A, (9, 10, 11))], dog_leg_ik, [(12, 130, 0)] * 4, sides=[1, -1, 1, -1], fronts=[1, 1, -1, -1])\ndog.stand(130)\ndog.gait([[0], [3], [1], [2]], stride=40, lift=35, cycles=3, ticks=14, shift=14)\nprint(json.dumps(frames))`);
    const frames: number[][] = JSON.parse(execFileSync('python3', ['run.py'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 26 }));
    fs.rmSync(dir, { recursive: true, force: true });
    const p = robotProject('dog'), comps = p.electronics.comps, sim = new RobotSim(p.product.built!), { st, b } = bench(comps);
    const pca = comps.find(c => c.type === 'pca9685')!;
    sim.settle();
    await sim.setPhysics(true, comps);
    for (const f of frames) { f.forEach((a, ch) => { st.get(pca.uid).ch[ch].angle = a; }); sim.step(1 / 45, comps, b, true); }
    for (let i = 0; i < 30; i++) sim.step(1 / 60, comps, b, true);
    expect(sim.legs.fallen).toBe(false);
    expect(sim.body.z).toBeGreaterThan(30);
  }, 60_000);
});
