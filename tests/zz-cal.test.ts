import { it, beforeAll } from 'vitest';
import * as THREE from 'three';
import { autoBuild } from '../src/app/autobuild';
import { BOARDS } from '../src/hw/library/boards';
import { defaultAutoOpts, kitFor, obstacleGrams } from '../src/app/project';
import { CrashLab, type CrashSpec } from '../src/app/crash';
import { estimateGrams } from '../src/app/damage';
import { robotProject } from '../src/app/robots';
import { RobotSim } from '../src/app/robot';
import { loadPhysics } from '../src/app/physics';
beforeAll(async () => { await loadPhysics(); }, 30000);
const spec = (o: Partial<CrashSpec>): CrashSpec => ({ kind: 'drop', height: 1000, orient: 'flat', speed: 1, mass: 200, ...o });
it('cal', async () => {
  const comps = kitFor('picow'), r = autoBuild(BOARDS.picow, comps, { ...defaultAutoOpts(), battery: true });
  const dev = () => ({ parts: JSON.parse(JSON.stringify(r.parts)), xray: false, auto: { ...defaultAutoOpts(), battery: true }, notes: [] } as any);
  console.log('device grams', estimateGrams(dev()), r.parts.map(p => `${p.name}[${p.kind ?? ''}/${p.role ?? ''}/${p.detail ?? ''}]`).join(', '));
  for (const [h, o] of [[300, 'flat'], [500, 'front'], [1000, 'flat'], [1000, 'front'], [1000, 'corner'], [1500, 'front']] as const) {
    const m = dev(), lab = await CrashLab.create(m, new Map(), spec({ height: h, orient: o }), uid => comps.find(c => c.uid === uid)?.type, () => 0);
    const rep = lab.finish();
    console.log(`DEVICE ${h} ${o}: peak ${rep.peakG} g ${rep.peakN} N | ${rep.summary} | ${rep.rows.map(x => `${x.name}:${x.status}(${x.load})`).join('; ')}`);
  }
  for (const [kind, s] of [['dog', spec({ height: 300 })], ['dog', spec({ height: 1000 })], ['rover-avoid', spec({ kind: 'wall', speed: 0.5 })], ['rover-avoid', spec({ kind: 'wall', speed: 2 })], ['arm', spec({ kind: 'hit', mass: 200, speed: 5 })], ['hexapod', spec({ height: 500, orient: 'side' })]] as const) {
    const p = robotProject(kind as any), c = p.electronics.comps, sim = new RobotSim(p.product.built!); sim.settle(); (sim as any).comps = c;
    const lab = await CrashLab.create(p.product.built!, sim.pose, s, uid => c.find(x => x.uid === uid)?.type, j => (j.drive ? (sim as any).servoOf(j, c).torque : 0));
    const rep = lab.finish();
    console.log(`ROBOT ${kind} ${s.kind} ${s.height}/${s.speed}: peak ${rep.peakG} g ${rep.peakN} N | ${rep.summary} | ${rep.rows.map(x => `${x.name}:${x.status}(${x.load})`).join('; ')}`);
  }
  // normal operation: no damage
  for (const kind of ['dog', 'rover-avoid'] as const) {
    const p = robotProject(kind), c = p.electronics.comps, sim = new RobotSim(p.product.built!);
    const st = new Map<string, any>(); for (const x of c) st.set(x.uid, x.type === 'pca9685' ? { ch: Array.from({ length: 16 }, () => ({ angle: 90 })) } : { a: 1, b: 1, speed: 0, cm: 0, down: false, edges: 0 });
    const b = { model: (u: string) => st.has(u) ? { state: st.get(u), sim: { press() {}, tilt() {}, turn() {} } } as any : undefined };
    sim.settle(); await sim.setPhysics(true, c);
    for (let i = 0; i < 360; i++) { if (kind === 'dog') { const t = i / 60; for (let leg = 0; leg < 4; leg++) { st.get(c.find(x => x.type === 'pca9685')!.uid).ch[leg * 3 + 1].angle = 90 + 20 * Math.sin(t * 6 + leg); } } sim.step(1 / 60, c, b, true); }
    console.log(`NORMAL ${kind}: damage`, JSON.stringify(Object.fromEntries(Object.entries(p.product.built!.damage ?? {}).map(([k, v]) => [k, [v.level, v.worst]]))), 'body', sim.body.x.toFixed(0), sim.body.z.toFixed(0));
  }
}, 300000);
