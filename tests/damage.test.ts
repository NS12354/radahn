import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { autoBuild } from '../src/app/autobuild';
import { BOARDS } from '../src/hw/library/boards';
import { defaultAutoOpts, kitFor, type BuiltModel } from '../src/app/project';
import { CrashLab, type CrashSpec } from '../src/app/crash';
import { jointKey } from '../src/app/damage';
import { robotProject } from '../src/app/robots';
import { RobotSim } from '../src/app/robot';
import { loadPhysics } from '../src/app/physics';
import type { CompInstance } from '../src/hw/types';

beforeAll(async () => { await loadPhysics(); }, 30_000);
const spec = (o: Partial<CrashSpec>): CrashSpec => ({ kind: 'drop', height: 1000, orient: 'flat', speed: 1, mass: 200, ...o });
const comps = kitFor('picow');
const thermostat = (): BuiltModel => ({ parts: autoBuild(BOARDS.picow, comps, { ...defaultAutoOpts(), battery: true }).parts, xray: false, auto: { ...defaultAutoOpts(), battery: true }, notes: [] });
const deviceTest = async (m: BuiltModel, s: Partial<CrashSpec>) => (await CrashLab.create(m, new Map(), spec(s), uid => comps.find(c => c.uid === uid)?.type, () => 0)).finish();
function bench(cs: CompInstance[]) {
  const st = new Map<string, any>();
  for (const c of cs) st.set(c.uid, c.type === 'pca9685' ? { ch: Array.from({ length: 16 }, () => ({ angle: 90 })) } : { a: 0, b: 0, speed: 0, cm: 0, down: false, edges: 0 });
  return { st, b: { model: (uid: string) => (st.has(uid) ? { state: st.get(uid), sim: { press: () => {}, tilt: () => {}, turn: () => {} } } as any : undefined) } };
}
async function robotTest(kind: Parameters<typeof robotProject>[0], s: Partial<CrashSpec>) {
  const p = robotProject(kind), cs = p.electronics.comps, sim = new RobotSim(p.product.built!);
  sim.settle();
  const lab = await CrashLab.create(p.product.built!, sim.pose, spec(s), uid => cs.find(c => c.uid === uid)?.type, j => (j.drive ? (sim as any).servoOf(j, cs).torque : 0));
  return { p, cs, report: lab.finish() };
}

describe('crash tests: devices', () => {
  it('the thermostat survives a 30 cm drop', async () => {
    const r = await deviceTest(thermostat(), { height: 300 });
    expect(r.broken).toBe(0);
  });
  it('a 1.5 m face-down drop cracks the display glass, and the damage stays until repaired', async () => {
    const m = thermostat(), r = await deviceTest(m, { height: 1500, orient: 'front' });
    const screen = r.rows.find(x => x.what === 'Display glass')!;
    expect(screen.status).toBe('broken');
    expect(screen.consequence).toMatch(/glass cracks/i);
    expect(Object.values(m.damage!).some(d => d.level >= 1)).toBe(true);
    // a second, gentle test still shows it (damage is cumulative)
    const again = await deviceTest(m, { height: 100 });
    expect(again.rows.some(x => x.what === 'Display glass' && x.status === 'broken')).toBe(true);
    expect(again.summary).toMatch(/earlier tests/);
  });
  it('higher drops hit harder', async () => {
    const low = await deviceTest(thermostat(), { height: 300 }), high = await deviceTest(thermostat(), { height: 1500 });
    expect(high.peakG).toBeGreaterThan(low.peakG * 1.5);
    expect(high.peakN).toBeGreaterThan(low.peakN * 1.5);
  });
});

describe('crash tests: robots', () => {
  it('a robot dog shrugs off a 30 cm drop but a 1 m drop strips servo gears, and those joints then go limp', async () => {
    expect((await robotTest('dog', { height: 300 })).report.broken).toBe(0);
    const { p, cs, report } = await robotTest('dog', { height: 1000 });
    const gears = report.rows.filter(r => r.key.startsWith('joint:') && r.status === 'broken');
    expect(gears.length).toBeGreaterThan(0);
    expect(gears[0].consequence).toMatch(/gears strip/i);
    // back on the bench: the stripped joints don't hold any more
    const sim = new RobotSim(p.product.built!);
    sim.settle(); await sim.setPhysics(true, cs);
    for (const g of gears) expect(sim.phys!.limp.has(g.key.slice(6))).toBe(true);
  });
  it('a rover bumping a wall at walking pace is fine; at 2 m/s its sonar takes the hit', async () => {
    expect((await robotTest('rover-avoid', { kind: 'wall', speed: 0.5 })).report.rows.length).toBe(0);
    const fast = await robotTest('rover-avoid', { kind: 'wall', speed: 2 });
    expect(fast.report.rows[0].what).toBe('Ultrasonic transducers');
    expect(fast.report.rows[0].level).toBeGreaterThan(0.8);
  });
  it('a 200 g weight at 5 m/s strips the arm\'s servos', async () => {
    const r = await robotTest('arm', { kind: 'hit', speed: 5, mass: 200 });
    expect(r.report.rows.some(x => x.key.startsWith('joint:') && x.status === 'broken')).toBe(true);
  });
});

describe('damage while running', () => {
  it('normal driving into an obstacle does no damage', async () => {
    const p = robotProject('rover-avoid'), cs = p.electronics.comps, sim = new RobotSim(p.product.built!), { st, b } = bench(cs);
    sim.settle(); await sim.setPhysics(true, cs);
    const drv = cs.find(c => c.type === 'tb6612')!; st.get(drv.uid).a = 1; st.get(drv.uid).b = 1;
    for (let i = 0; i < 400; i++) sim.step(1 / 60, cs, b, true); // drives into the wooden beam ahead
    expect(sim.body.z).toBeGreaterThan(300);
    expect(Object.values(p.product.built!.damage ?? {}).filter(d => d.level >= 0.8)).toEqual([]);
  });
  it('a broken sonar reads nothing; a broken board means the motors never get a signal', async () => {
    const p = robotProject('rover-avoid'), cs = p.electronics.comps, m = p.product.built!, { st, b } = bench(cs);
    const sonar = m.parts.find(x => x.name === 'Ultrasonic sensor')!, board = m.parts.find(x => x.comp === 'board')!;
    m.damage = { [sonar.id]: { level: 1.2, status: 'broken', worst: { kind: 'force', value: 500, rating: 400 }, hits: 1 } };
    const sim = new RobotSim(m); sim.settle();
    sim.step(1 / 60, cs, b, true);
    expect(sim.readings.get(cs.find(c => c.type === 'hcsr04')!.uid)).toBe('broken');
    m.damage[board.id] = { level: 1.1, status: 'broken', worst: { kind: 'shock', value: 700, rating: 600 }, hits: 1 };
    const drv = cs.find(c => c.type === 'tb6612')!; st.get(drv.uid).a = 1; st.get(drv.uid).b = 1;
    for (let i = 0; i < 60; i++) sim.step(1 / 60, cs, b, true);
    expect(sim.powerless).toBe(true);
    expect(Math.abs(sim.body.z)).toBeLessThan(2);
    void jointKey; void THREE;
  });
});
