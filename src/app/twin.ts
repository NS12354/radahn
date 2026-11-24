/**
 * The scene simulator. Each robot in a scene gets everything it has in its own
 * project:
 * - a bench of device models,
 * - a firmware runtime (its own emulated chip or behavioral sim),
 * - a robot simulator.
 * They all share one world:
 * - the floor, walls, track and obstacles;
 * - the pickable blocks, which any gripper can take and any robot's sensors can see;
 * - each other: a robot is a cylinder obstacle to the others, so rovers bump
 *   into and sonar each other.
 *
 * With physics on (scene.physics), they all live in one rigid-body world instead:
 * robots really collide, push each other and the blocks, and grip by friction.
 *
 * Pure logic (no DOM): the scene UI adds the 3D models and the runtimes.
 */
import * as THREE from 'three';
import type { BuiltModel, Project, World } from './project';
import { RobotSim, dropObjects, makeObjects, type WorldObject } from './robot';
import { PhysicsWorld, loadPhysics } from './physics';
import type { Scene, SceneRobot } from './scene';
import { Bench } from '../hw/bench';
import { BOARDS } from '../hw/library/boards';
import type { BoardDef, Runtime } from '../hw/types';

export type RobotStatus = 'stopped' | 'starting' | 'running' | 'finished' | 'crashed' | 'missing';

export interface TwinRobot {
  def: SceneRobot;
  project: Project;
  model: BuiltModel;
  board: BoardDef;
  bench: Bench;
  sim: RobotSim;
  runtime: Runtime | null;
  status: RobotStatus;
  /** Last few serial lines (the UI keeps the full console). */
  height: number;
}

/** Makes the firmware runtime for a robot's board (emulator, behavioral sim…), or explains why it can't. */
export type RuntimeFactory = (r: TwinRobot) => Runtime | string;
/** Files the runtime starts with (compiles Arduino sketches, filters Python). */
export type PayloadFactory = (r: TwinRobot) => Promise<Record<string, string> | string>;

export class Twin {
  robots: TwinRobot[] = [];
  /** Blocks shared by every robot in the scene. */
  objects: WorldObject[] = [];
  onSerial: (r: TwinRobot, text: string, cls?: string) => void = () => {};
  onStatus: (r: TwinRobot) => void = () => {};
  /** The shared rigid-body world, while physics is on. */
  physics: PhysicsWorld | null = null;
  private physGen = 0;

  constructor(public scene: Scene) { this.objects = makeObjects(scene.world); }

  get world(): World { return this.scene.world; }

  /** Add a scene entry, given its project (null: the project was deleted; the entry stays, marked missing). */
  add(def: SceneRobot, project: Project): TwinRobot | null {
    const model = project.product.built;
    if (!model) return null;
    const board = BOARDS[project.electronics.board];
    const bench = new Bench(board, project.env, null);
    bench.load(board, project.electronics.comps);
    const sim = new RobotSim(model);
    sim.sceneWorld = this.scene.world;
    sim.sharedObjects = true;
    sim.objects = this.objects;
    const height = Math.max(40, ...model.parts.map(p => p.pos[1] + p.size[1] / 2));
    const r: TwinRobot = { def, project, model, board, bench, sim, runtime: null, status: 'stopped', height };
    bench.onLog = (m, l) => this.onSerial(r, m + '\n', l === 'e' ? 'e' : 'w');
    this.robots.push(r);
    if (this.physics) r.sim.physWorld = this.physics;
    this.place(r);
    if (this.physics) r.sim.setPhysics(true, project.electronics.comps).catch(() => {});
    return r;
  }
  remove(r: TwinRobot) {
    this.stop(r);
    r.sim.phys?.dispose(); r.sim.phys = null;
    for (const o of this.objects) if (o.held?.sim === r.sim) o.held = undefined;
    this.robots = this.robots.filter(x => x !== r);
  }
  byId(id: string) { return this.robots.find(r => r.def.id === id); }

  /** Put a robot back at its spot in the scene (its joints at rest). */
  place(r: TwinRobot) {
    const { x, z, yaw } = r.def.pose;
    r.sim.home = new THREE.Matrix4().makeRotationY(yaw * Math.PI / 180).setPosition(x, 0, z);
    r.sim.reset();
  }

  /** The world changed (preset, blocks added or removed): rebuild the blocks and re-place everyone. */
  setWorld(w: World) {
    this.scene.world = w;
    this.objects.length = 0;
    this.objects.push(...makeObjects(w)); // same array: every sim keeps pointing at it
    for (const r of this.robots) { r.sim.sceneWorld = w; this.place(r); }
    if (this.physics) void this.setPhysics(true);
  }

  /**
   * Physics on: build one shared rigid-body world from the scene's world and put every robot
   * in it, at its spot. Off: back to the kinematic model. Robots and blocks start over either way.
   */
  async setPhysics(on: boolean) {
    const gen = ++this.physGen;
    if (on) await loadPhysics();
    if (gen !== this.physGen) return; // a newer call won
    for (const r of this.robots) { r.sim.phys?.dispose(); r.sim.phys = null; r.sim.physWorld = undefined; }
    this.physics?.dispose(); this.physics = null;
    this.scene.physics = on ? undefined : false; // on is the default
    this.objects.length = 0; this.objects.push(...makeObjects(this.scene.world));
    for (const r of this.robots) this.place(r);
    if (!on) return;
    const pw = (this.physics = new PhysicsWorld(this.scene.world));
    for (const r of this.robots) { r.sim.physWorld = pw; await r.sim.setPhysics(true, r.project.electronics.comps); }
  }
  /** Everything back to the start: blocks where the world puts them, robots at their spots. */
  reset() { this.setWorld(this.scene.world); }

  /** Where a robot is now (floor x/z in mm, heading in degrees). */
  where(r: TwinRobot) {
    const m = r.sim.body.m, f = new THREE.Vector3(0, 0, 1).transformDirection(m);
    return { x: m.elements[12], z: m.elements[14], yaw: Math.atan2(f.x, f.z) * 180 / Math.PI };
  }

  step(dt: number) {
    for (const r of this.robots) {
      r.bench.frame(dt);
      r.sim.others = this.robots.filter(o => o !== r).map(o => {
        const p = this.where(o), d = o.sim.radius() * 2;
        return { shape: 'cyl' as const, pos: [p.x, p.z] as [number, number], size: [d, o.height, d] as [number, number, number] };
      });
      r.sim.step(dt, r.project.electronics.comps, r.bench, !!r.runtime?.running);
    }
    if (this.physics) {
      // every robot set its motor targets above; now the shared world moves everyone at once
      this.physics.step(Math.min(dt, 0.05));
      for (const mv of this.physics.movables()) { const o = this.objects.find(x => x.index === mv.index); if (o) { o.held = undefined; o.m.compose(new THREE.Vector3(...mv.pos), new THREE.Quaternion(...mv.quat), new THREE.Vector3(1, 1, 1)); } }
    } else dropObjects(this.objects, this.scene.world, Math.min(dt, 0.05));
  }

  async start(r: TwinRobot, makeRuntime: RuntimeFactory, payload: PayloadFactory) {
    await this.stop(r);
    const rt = makeRuntime(r);
    if (typeof rt === 'string') { this.onSerial(r, rt + '\n', 'w'); this.set(r, 'stopped'); return; }
    this.set(r, 'starting');
    const files = await payload(r);
    if (typeof files === 'string') { this.onSerial(r, files + '\n', 'e'); this.set(r, 'crashed'); return; }
    r.bench.reset();
    r.runtime = rt;
    rt.onSerial = t => this.onSerial(r, t);
    rt.onStatus = s => { if (/crash|fail|error/i.test(s)) this.set(r, 'crashed'); else if (/finished/i.test(s)) this.set(r, 'finished'); };
    (rt as any).onExit = (err?: string) => { if (r.runtime === rt) this.set(r, err ? 'crashed' : 'finished'); };
    this.onSerial(r, `─── ${r.def.name}: ${r.board.name}${r.board.fidelity === 'emulated' ? ' (emulated)' : ' (behavioral sim)'} ───\n`, 's');
    try {
      const boot = rt.start(files);
      this.set(r, 'running');
      await boot;
    } catch (e: any) {
      if (r.runtime === rt && !/cancelled/.test(String(e?.message))) { this.onSerial(r, String(e?.message || e) + '\n', 'e'); this.set(r, 'crashed'); r.runtime = null; }
    }
  }
  async stop(r: TwinRobot) {
    const rt = r.runtime; if (!rt) return;
    r.runtime = null;
    await rt.stop();
    this.set(r, 'stopped');
  }
  async stopAll() { await Promise.all(this.robots.map(r => this.stop(r))); }
  get running() { return this.robots.some(r => r.runtime?.running); }

  private set(r: TwinRobot, s: RobotStatus) { if (r.status !== s) { r.status = s; this.onStatus(r); } }
}
