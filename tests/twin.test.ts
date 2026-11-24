import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { robotProject, pickBlock } from '../src/app/robots';
import { Twin } from '../src/app/twin';
import { newScene, uniqueName, freeSpot, parseScene, serializeScene, type SceneRobot } from '../src/app/scene';

const def = (name: string, x: number, z: number, yaw = 0): SceneRobot => ({ id: name, name, project: 'p-' + name, pose: { x, z, yaw } });
/** Pretend firmware is running and set an actuator's state by hand. */
const drive = (t: Twin, name: string, set: (st: any) => void) => {
  const r = t.byId(name)!;
  r.runtime = { running: true } as any;
  r.bench.frame = () => {}; // keep the hand-set actuator states (no firmware drives the pins)
  for (const c of r.project.electronics.comps) { const st = r.bench.model(c.uid)?.state; if (st) set({ c, st }); }
};
const run = (t: Twin, s: number) => { for (let k = 0; k < s * 60; k++) t.step(1 / 60); };

describe('scenes', () => {
  it('places each copy at its own spot and heading', () => {
    const t = new Twin(newScene('Floor', 'floor'));
    t.add(def('Rover A', -500, 0, 90), robotProject('rover-avoid'));
    t.add(def('Rover B', 500, 200, -90), robotProject('rover-avoid'));
    const [a, b] = t.robots.map(r => t.where(r));
    expect(a.x).toBeCloseTo(-500); expect(a.z).toBeCloseTo(0); expect(a.yaw).toBeCloseTo(90);
    expect(b.x).toBeCloseTo(500); expect(b.z).toBeCloseTo(200); expect(b.yaw).toBeCloseTo(-90);
  });

  it('two copies of the same design run independently and bump into each other', () => {
    const t = new Twin(newScene('Floor', 'floor'));
    const p = robotProject('rover-avoid');
    // two copies of one project, facing each other 800 mm apart
    t.add(def('Left', -400, 0, 90), p);
    t.add(def('Right', 400, 0, -90), p);
    for (const n of ['Left', 'Right']) drive(t, n, ({ c, st }) => { if (c.type === 'tb6612') { st.a = 0.8; st.b = 0.8; } });
    run(t, 4);
    const [l, r] = t.robots.map(x => t.where(x));
    expect(l.x).toBeGreaterThan(-350); // both moved toward each other…
    expect(r.x).toBeLessThan(350);
    const gap = r.x - l.x, rad = t.robots[0].sim.radius() + t.robots[1].sim.radius();
    expect(gap).toBeGreaterThan(rad * 0.9); // …and stopped instead of passing through
    expect(t.robots[0].sim.stalled || t.robots[1].sim.stalled).toBe(true);
  });

  it("one robot's sonar sees another robot", () => {
    const t = new Twin(newScene('Floor', 'floor'));
    t.add(def('Watcher', 0, -600), robotProject('rover-avoid'));
    run(t, 0.1);
    const w = t.robots[0], sonar = w.project.electronics.comps.find(c => c.type === 'hcsr04')!;
    const alone = w.bench.model(sonar.uid)!.state.cm;
    t.add(def('Target', 0, -200), robotProject('rover-avoid'));
    run(t, 0.1);
    const seen = w.bench.model(sonar.uid)!.state.cm;
    expect(alone).toBeGreaterThan(150); // the far wall
    expect(seen).toBeLessThan(40); // the other rover, ~400 mm away minus both bodies
  });

  it('an arm anywhere in the scene picks up a block beside it, from the shared world', () => {
    const scene = newScene('Cell', 'floor');
    // an arm at (800, -300) turned 90°: its pick spot (-120, 150) in arm space is in world (800 + 150, -300 + 120)
    const yaw = 90, at = new THREE.Vector3(-120, 0, 150).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw * Math.PI / 180).add(new THREE.Vector3(800, 0, -300));
    const block = pickBlock([at.x, at.z]);
    block.rot = Math.round(Math.atan2(at.x - 800, at.z + 300) * 180 / Math.PI); // facing the arm's base
    scene.world.obstacles.push(block);
    const t = new Twin(scene);
    t.add(def('Arm', 800, -300, yaw), robotProject('arm'));
    t.add(def('Bystander', -800, 0), robotProject('arm'));
    const arm = t.byId('Arm')!;
    const ch = () => arm.bench.model(arm.project.electronics.comps.find(c => c.type === 'pca9685')!.uid)!.state.ch;
    arm.runtime = { running: true } as any;
    arm.bench.frame = () => {};
    // IK for (-120, 12, 150) from lib/arm.py (see robot.test.ts): yaw −38.7, shoulder 40.1, elbow 75.4, wrist 64.5
    const pose = (q: number[], grip: number) => { q.forEach((v, i) => (ch()[i].angle = 90 + v)); ch()[4].angle = grip; };
    pose([-38.66, 40.1, 75.4, 64.5], 10); run(t, 3);
    ch()[4].angle = 170; run(t, 0.6);
    expect(t.objects[0].held?.sim).toBe(arm.sim); // the arm's own gripper holds it, not the bystander's
    pose([-38.66, 0, 0, 0], 170); run(t, 2);
    expect(new THREE.Vector3().setFromMatrixPosition(t.objects[0].m).y).toBeGreaterThan(100); // lifted
    ch()[4].angle = 10; run(t, 1.5);
    expect(t.objects[0].held).toBeUndefined();
    expect(new THREE.Vector3().setFromMatrixPosition(t.objects[0].m).y).toBeCloseTo(10, 0); // dropped to the floor
  });

  it('names, spots and the file format', () => {
    const s = newScene('Fleet', 'floor');
    expect(uniqueName(s, 'Rover')).toBe('Rover');
    s.robots.push(def('Rover', 0, 0), def('Rover 2', 600, 0));
    expect(uniqueName(s, 'rover')).toBe('rover 3');
    const spot = freeSpot(s);
    expect(s.robots.every(r => Math.hypot(r.pose.x - spot.x, r.pose.z - spot.z) > 450)).toBe(true);
    expect(parseScene(serializeScene(s))).toEqual(s);
    expect(() => parseScene('{"format":"formframe"}')).toThrow(/Not a Formframe scene/);
  });
});
