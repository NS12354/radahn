import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { robotProject } from '../src/app/robots';
import { RobotSim } from '../src/app/robot';
import { forwardKinematics } from '../src/app/kinematics';
import { ROBOT_LIBS } from '../src/hw/robotcode';
import type { CompInstance } from '../src/hw/types';

/** Run Python with the robot libraries importable; returns parsed JSON from stdout. */
function py(code: string): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-robot-'));
  for (const [n, src] of Object.entries(ROBOT_LIBS)) fs.writeFileSync(path.join(dir, path.basename(n)), src);
  fs.writeFileSync(path.join(dir, 'run.py'), code);
  try { return JSON.parse(execFileSync('python3', ['run.py'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 })); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
let hasPy = true; try { execFileSync('python3', ['-c', 'pass']); } catch { hasPy = false; }
const itPy = hasPy ? it : it.skip;

/** A bench stand-in: PCA9685 channel angles / motor speeds set by the test. */
function fakeBench(comps: CompInstance[]) {
  const st = new Map<string, any>();
  for (const c of comps) st.set(c.uid, c.type === 'pca9685' ? { ch: Array.from({ length: 16 }, () => ({ angle: null })) } : { a: 0, b: 0, speed: 0, cm: 0, down: false, edges: 0 });
  return { st, bench: { model: (uid: string) => (st.has(uid) ? { state: st.get(uid), sim: { press: (d: boolean) => { st.get(uid).down = d; }, tilt: () => {}, turn: () => {} } } as any : undefined) } };
}

describe('robot arm', () => {
  itPy('the firmware inverse kinematics puts the gripper tip on target in the 3D model', () => {
    const targets = [[0, 120, 150], [-120, 40, 150], [-120, 110, 150], [120, 45, 150], [80, 180, 60]];
    const qs: number[][] = py(`import json, sys, time\ntime.sleep = lambda s: None\nfrom arm import Arm\nclass S:\n    def angle(self, ch, a): pass\na = Arm(S())\nprint(json.dumps([a.ik(*t) for t in ${JSON.stringify(targets)}]))`);
    const p = robotProject('arm'), parts = p.product.built!.parts;
    const ids = ['Turntable', 'Upper arm', 'Forearm', 'Wrist'].map(n => parts.find(x => x.name === n)!.id);
    const palm = parts.find(x => x.name === 'Gripper palm')!;
    qs.forEach((q, k) => {
      const fk = forwardKinematics(parts, id => { const i = ids.indexOf(id); return i >= 0 ? q[i] : 0; });
      const tip = new THREE.Vector3(0, 370, 0).applyMatrix4(fk.get(palm.id)!); // wrist pivot 295 + 75
      expect(tip.distanceTo(new THREE.Vector3(...targets[k] as [number, number, number])), `target ${targets[k]}`).toBeLessThan(1.5);
    });
  });
  it('joints follow PCA9685 channels at servo speed, within limits', () => {
    const p = robotProject('arm'), m = p.product.built!, comps = p.electronics.comps;
    const sim = new RobotSim(m), { st, bench } = fakeBench(comps);
    const pca = comps.find(c => c.type === 'pca9685')!;
    st.get(pca.uid).ch[1].angle = 150; // shoulder +60°
    st.get(pca.uid).ch[4].angle = 180; // gripper closed
    sim.step(0.05, comps, bench, true);
    const sh = sim.joints.find(j => j.name === 'Upper arm')!;
    expect(sh.q).toBeGreaterThan(0); expect(sh.q).toBeLessThan(60); // still moving (MG996R ≈ 0.17 s/60°)
    for (let i = 0; i < 40; i++) sim.step(0.05, comps, bench, true);
    expect(sh.q).toBeCloseTo(60, 0);
    expect(sim.joints.find(j => j.name === 'Gripper finger L')!.q).toBeCloseTo(12, 0);
  });
  itPy('the demo picks the block up on the right and puts it down on the pad', () => {
    // the waypoints in main.py, as servo angles from the firmware's own IK
    const main = robotProject('arm').electronics.files['main.py'];
    const moves = [...main.matchAll(/arm\.move_to\(([-\d]+), ([-\d]+), ([-\d]+)\)|arm\.grip\((True|False)\)/g)].map(m => (m[4] ? m[4] === 'True' : [+m[1], +m[2], +m[3]]));
    const ik: (number[] | boolean)[] = py(`import json, time\ntime.sleep = lambda s: None\nfrom arm import Arm\nclass S:\n    def angle(self, ch, a): pass\na = Arm(S())\nprint(json.dumps([m if isinstance(m, bool) else a.ik(*m) for m in ${JSON.stringify(moves).replace(/true/g, 'True').replace(/false/g, 'False')}]))`);
    const p = robotProject('arm'), m = p.product.built!, comps = p.electronics.comps;
    const sim = new RobotSim(m), { st, bench } = fakeBench(comps), ch = st.get(comps.find(c => c.type === 'pca9685')!.uid).ch;
    const block = () => new THREE.Vector3().setFromMatrixPosition(sim.objects[0].m);
    const run = (s: number) => { for (let t = 0; t < s; t += 1 / 60) sim.step(1 / 60, comps, bench, true); };
    ch[4].angle = 10; // open, as main.py starts
    let held = false;
    for (const step of ik.slice(1)) { // after the first grip(False)
      if (typeof step === 'boolean') { ch[4].angle = step ? 170 : 10; run(0.5); if (step) { held = sim.holding; expect(held, 'gripped the block').toBe(true); } continue; }
      step.forEach((q, i) => (ch[i].angle = 90 + q)); run(2.5);
      if (held && sim.holding) expect(block().y, 'carried').toBeGreaterThan(10);
    }
    // fingers stopped at the block's faces (20 mm apart) instead of closing to 5 mm
    run(1);
    const b = block();
    expect(sim.holding).toBe(false);
    expect(Math.hypot(b.x - 120, b.z - 150)).toBeLessThan(4);
    expect(b.y).toBeCloseTo(4 + 10, 0); // on top of the 4 mm pad
  });
  it('fingers stop on the block and it rides with the hand', () => {
    const p = robotProject('arm'), m = p.product.built!, comps = p.electronics.comps;
    const sim = new RobotSim(m);
    // put the block straight between the fingers at rest (hand pointing up, tip at y 370)
    sim.objects[0].m.makeTranslation(0, 355, 0);
    const fl = sim.joints.find(j => j.name === 'Gripper finger L')!, fr = sim.joints.find(j => j.name === 'Gripper finger R')!;
    sim.manual.set(fl.id, 12); sim.manual.set(fr.id, 12);
    for (let i = 0; i < 30; i++) sim.step(1 / 60, comps, fakeBench(comps).bench, false);
    expect(fl.q).toBeCloseTo(4, 0); expect(fr.q).toBeCloseTo(4, 0); // 28 mm gap − 2×4 = 20 mm block
    expect(sim.holding).toBe(true);
    sim.manual.set(fl.id, 0); sim.manual.set(fr.id, 0);
    for (let i = 0; i < 60; i++) sim.step(1 / 60, comps, fakeBench(comps).bench, false);
    expect(sim.holding).toBe(false);
    expect(new THREE.Vector3().setFromMatrixPosition(sim.objects[0].m).y).toBeCloseTo(10, 0); // fell to the floor
  });
});

describe('rover', () => {
  const run = (kind: 'rover-avoid' | 'rover-line', a: number, b: number, secs: number) => {
    const p = robotProject(kind), comps = p.electronics.comps, sim = new RobotSim(p.product.built!), { st, bench } = fakeBench(comps);
    sim.settle();
    const drv = comps.find(c => c.type === 'tb6612')!; st.get(drv.uid).a = a; st.get(drv.uid).b = b;
    for (let t = 0; t < secs; t += 0.02) sim.step(0.02, comps, bench, true);
    return { sim, st, comps };
  };
  it('drives forward with both wheels on, and turns left with the right wheel faster', () => {
    const f = run('rover-avoid', 0.6, 0.6, 1);
    expect(f.sim.body.z).toBeGreaterThan(150);
    expect(Math.abs(f.sim.body.x)).toBeLessThan(2);
    const l = run('rover-avoid', -0.5, 0.5, 0.5);
    expect(l.sim.body.yaw).toBeGreaterThan(0.3); // left = toward +X
  });
  it('the sonar reads the distance to the obstacle ahead, and the robot stops at walls', () => {
    const r = run('rover-avoid', 0.8, 0.8, 8);
    const sonar = r.comps.find(c => c.type === 'hcsr04')!;
    expect(r.st.get(sonar.uid).cm).toBeLessThan(15);   // drove up to the box at z = 600
    expect(r.sim.stalled).toBe(true);
    expect(r.sim.body.z).toBeLessThan(600);
  });
  it('line sensors see the track under them', () => {
    const r = run('rover-line', 0, 0, 0.1);
    const lines = r.comps.filter(c => c.type === 'line');
    expect(lines.every(c => r.st.get(c.uid).down)).toBe(true);
  });
});

/** Run a walking program in CPython with a recording servo driver, then play the frames into the robot sim. */
function walk(kind: 'dog' | 'hexapod', program: string) { return walkWith(kind, program, () => {}); }
function walkWith(kind: 'dog' | 'hexapod', program: string, tweak: (c: CompInstance[]) => void) {
  const frames: number[][][] = py(`import json, time\ntime.sleep = lambda s: None\nfrom legs import Legs, dog_leg_ik, hex_leg_ik\nframes = []\nclass S:\n    def __init__(self, k): self.k = k; self.a = [90] * 16\n    def angle(self, ch, a): self.a[ch] = a\nA = S(0); B = S(1)\norig = Legs.apply\ndef rec(self, feet=None):\n    orig(self, feet)\n    frames.append([list(A.a), list(B.a)])\nLegs.apply = rec\n${program}\nprint(json.dumps(frames))`);
  const p = robotProject(kind), comps = p.electronics.comps; tweak(comps);
  const sim = new RobotSim(p.product.built!), { st, bench } = fakeBench(comps);
  const pcas = comps.filter(c => c.type === 'pca9685');
  sim.settle();
  for (const f of frames) {
    pcas.forEach((c, i) => f[i].forEach((a, ch) => { st.get(c.uid).ch[ch].angle = a; }));
    sim.step(0.02, comps, bench, true);
  }
  for (let i = 0; i < 20; i++) sim.step(0.02, comps, bench, true);
  return sim;
}
describe('walking robots', () => {
  itPy('the dog stands at the commanded height on all four feet', () => {
    const sim = walk('dog', `dog = Legs([(A, (0, 1, 2)), (A, (3, 4, 5)), (A, (6, 7, 8)), (A, (9, 10, 11))], dog_leg_ik, [(12, 130, 0)] * 4, sides=[1, -1, 1, -1], fronts=[1, 1, -1, -1])\ndog.stand(130)`);
    const body = sim.pose.get(sim.model.parts.find(p => p.name === 'Body')!.id)!;
    expect(new THREE.Vector3(0, 160, 0).applyMatrix4(body).y).toBeCloseTo(130, -1); // body centre (hip height at rest 160)
    expect(sim.legs.contacts.length).toBe(4);
    expect(sim.legs.fallen).toBe(false);
  });
  itPy('the dog walks forward with the creep gait without falling', () => {
    const sim = walk('dog', `dog = Legs([(A, (0, 1, 2)), (A, (3, 4, 5)), (A, (6, 7, 8)), (A, (9, 10, 11))], dog_leg_ik, [(12, 130, 0)] * 4, sides=[1, -1, 1, -1], fronts=[1, 1, -1, -1])\ndog.stand(130)\ndog.gait([[0], [3], [1], [2]], stride=40, lift=35, cycles=3, ticks=14, shift=14)`);
    expect(sim.body.z).toBeGreaterThan(60);
    expect(sim.legs.fallen).toBe(false);
  });
  itPy('the hexapod walks forward with a tripod gait and turns left', () => {
    const legs = `bug = Legs([(A, (0, 1, 2)), (A, (3, 4, 5)), (A, (6, 7, 8)), (B, (0, 1, 2)), (B, (3, 4, 5)), (B, (6, 7, 8))], hex_leg_ik, [(90, 80, 0)] * 6, sides=[1, 1, 1, -1, -1, -1], fronts=[1, 0, -1, 1, 0, -1])\nbug.stand(80)\n`;
    const fwd = walk('hexapod', legs + 'bug.gait([[0, 2, 4], [1, 3, 5]], stride=50, lift=30, cycles=4, ticks=12)');
    expect(fwd.body.z).toBeGreaterThan(120);
    expect(fwd.legs.fallen).toBe(false);
    const turn = walk('hexapod', legs + 'bug.gait([[0, 2, 4], [1, 3, 5]], stride=40, lift=30, turn=1.0, cycles=3, ticks=12)');
    expect(turn.body.yaw).toBeGreaterThan(0.15);
  });
});

describe('URDF', () => {
  it('exports a valid robot and imports it back to the same geometry and joints', async () => {
    const { exportUrdf, importUrdf, parseXml } = await import('../src/app/urdf');
    for (const kind of ['arm', 'dog', 'rover-avoid'] as const) {
      const p = robotProject(kind), m = p.product.built!;
      const xml = exportUrdf(m, p.name);
      const doc = parseXml(xml);
      const robot = doc.kids.find(k => k.tag === 'robot')!;
      const links = robot.kids.filter(k => k.tag === 'link'), joints = robot.kids.filter(k => k.tag === 'joint');
      expect(joints.length, kind).toBe(links.length - 1); // a tree: every link but the root has one parent joint
      const moving = m.parts.filter(x => x.joint && x.joint.type !== 'fixed').length;
      expect(joints.filter(j => j.attrs.type !== 'fixed').length, kind).toBe(moving);
      const back = importUrdf(xml).parts;
      // every original part comes back at the same place, size and orientation
      for (const o of m.parts) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rot.map(v => v * Math.PI / 180) as [number, number, number]));
        const match = back.find(b => Math.hypot(b.pos[0] - o.pos[0], b.pos[1] - o.pos[1], b.pos[2] - o.pos[2]) < 0.05 && b.shape === (o.shape === 'cyl' || o.shape === 'tube' || o.shape === 'disc' ? 'cyl' : o.shape === 'sphere' ? 'sphere' : 'box')
          && (o.shape === 'sphere' || [...b.size].sort().join() === [...o.size].sort().join())); // URDF spheres are round: a squashed foot comes back round
        expect(match, `${kind}: ${o.name}`).toBeTruthy();
        // same world-space box: compare the transformed half-extent corners
        const corner = (pos: number[], rot: number[], size: number[]) => new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot.map(v => v * Math.PI / 180) as [number, number, number]))).add(new THREE.Vector3(...pos as [number, number, number]));
        if (o.shape !== 'sphere' && o.shape !== 'cyl') expect(corner(match!.pos, match!.rot, match!.size).distanceTo(corner(o.pos, o.rot, o.size)), `${kind}: ${o.name} orientation`).toBeLessThan(0.1);
        void q;
      }
      // joints come back with the same pivots and axes, and posing both gives the same result
      const orig = m.parts.filter(x => x.joint && x.joint.type !== 'fixed');
      for (const o of orig) {
        const b = back.find(x => x.joint && Math.hypot(...x.joint.pivot.map((v, i) => v - o.joint!.pivot[i]) as [number, number, number]) < 0.05 && Math.hypot(x.pos[0] - o.pos[0], x.pos[1] - o.pos[1], x.pos[2] - o.pos[2]) < 0.05)!;
        expect(b, `${kind}: joint ${o.name}`).toBeTruthy();
        const ao = new THREE.Vector3(...o.joint!.axis).normalize(), ab = new THREE.Vector3(...b.joint!.axis).normalize();
        expect(ao.distanceTo(ab), `${kind}: axis ${o.name}`).toBeLessThan(1e-4);
      }
    }
  });
  it('maps Formframe axes to ROS: the robot faces +x, up is +z', async () => {
    const { exportUrdf } = await import('../src/app/urdf');
    const m = robotProject('arm').product.built!;
    const xml = exportUrdf(m);
    expect(xml).toMatch(/name="turntable_joint" type="revolute">.*<axis xyz="0 0 1"\/>/); // base yaw is about ROS z (up)
    expect(xml).toMatch(/name="upper_arm_joint" type="revolute">.*<axis xyz="0 1 0"\/>/); // shoulder about ROS y (left)
  });
});

describe('ROS 2 bridge', () => {
  it('advertises, publishes /joint_states with the URDF joint names, and obeys /cmd_vel', async () => {
    const { RosBridge } = await import('../src/app/rosbridge');
    const { urdfJointNames } = await import('../src/app/urdf');
    const sent: any[] = [];
    class FakeWS { readyState = 1; onopen: any; onmessage: any; onerror: any; onclose: any; constructor(public url: string) { setTimeout(() => this.onopen?.(), 0); } send(s: string) { sent.push(JSON.parse(s)); } close() { this.onclose?.(); } }
    const p = robotProject('rover-avoid'), sim = new RobotSim(p.product.built!);
    const br = new RosBridge(() => sim, FakeWS as any);
    br.connect('ws://localhost:9090');
    await new Promise(r => setTimeout(r, 5));
    expect(br.status).toBe('connected');
    expect(sent.filter(m => m.op === 'advertise').map(m => m.topic)).toEqual(['/joint_states', '/formframe/pose']);
    expect(sent.filter(m => m.op === 'subscribe').map(m => m.topic)).toEqual(['/cmd_vel', '/formframe/joint_commands']);
    br.publish();
    const js = sent.find(m => m.topic === '/joint_states' && m.op === 'publish').msg;
    expect(js.name.sort()).toEqual([...urdfJointNames(sim.model).values()].sort());
    br.receive({ op: 'publish', topic: '/cmd_vel', msg: { linear: { x: 0.2 }, angular: { z: 0 } } });
    const { bench } = fakeBench(p.electronics.comps);
    sim.settle();
    for (let i = 0; i < 25; i++) sim.step(0.02, p.electronics.comps, bench, false);
    expect(sim.body.z).toBeGreaterThan(80); // 0.2 m/s for 0.5 s
    br.close();
  });
});

describe('servo torque', () => {
  itPy('a dog on weak micro servos sags lower than one on 20 kg servos', () => {
    const stand = `dog = Legs([(A, (0, 1, 2)), (A, (3, 4, 5)), (A, (6, 7, 8)), (A, (9, 10, 11))], dog_leg_ik, [(12, 110, 0)] * 4, sides=[1, -1, 1, -1], fronts=[1, 1, -1, -1])\ndog.stand(110)`;
    const strong = walk('dog', stand);
    const weak = walkWith('dog', stand, comps => { const pca = comps.find(c => c.type === 'pca9685')!; pca.props!.servos = pca.props!.servos.map((s: any) => ({ ...s, type: 'sg90' })); });
    const h = (s: RobotSim) => new THREE.Vector3(0, 160, 0).applyMatrix4(s.pose.get(s.model.parts.find(p => p.name === 'Body')!.id)!).y;
    expect(h(weak)).toBeLessThan(h(strong) - 5);
    expect(weak.joints.some(j => j.sag !== 0)).toBe(true);
  });
});
