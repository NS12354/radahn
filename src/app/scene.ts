/**
 * Scenes: several robots in one shared world, simulated together (a digital twin
 * of a cell, a floor, a fleet). A scene doesn't copy its robots. Each entry
 * names a robot project in the library and says where that copy stands, so the
 * same design can appear several times (three rovers, two arms), each with
 * its own name, position and running firmware. Editing the project updates
 * every copy in every scene.
 *
 * Stored in its own IndexedDB database (falls back to memory, like projects).
 */
import type { World } from './project';
import { ARM_PICK, ARM_PLACE, pickBlock } from './robots';

export const SCENE_FORMAT_VERSION = 1;

export interface SceneRobot {
  /** Stable id inside the scene. */
  id: string;
  /** What this copy is called (shown on its tag and in the serial log). */
  name: string;
  /** Store id of the robot project it is a copy of. */
  project: string;
  /** Where it stands: floor position (mm) and heading (degrees about Y, 0 = facing +Z). */
  pose: { x: number; z: number; yaw: number };
}

export interface Scene {
  format: 'formframe-scene';
  version: number;
  name: string;
  world: World;
  robots: SceneRobot[];
}

export interface SceneMeta { id: string; name: string; created: number; updated: number; robots: number; thumb?: string }

/** Shared worlds for scenes: bigger than a single robot's, so there's room for several. */
export const SCENE_WORLDS: Record<string, { label: string; make: () => World }> = {
  floor: { label: 'Open floor', make: () => ({ size: 4000, obstacles: [] }) },
  cell: {
    label: 'Work cell (table, blocks, pad)',
    make: () => ({ size: 3000, obstacles: [pickBlock(ARM_PICK), { shape: 'cyl', pos: ARM_PLACE, size: [60, 4, 60], color: '#33c27f', name: 'Pad' }] }),
  },
  room: {
    label: 'Room with obstacles',
    make: () => ({ size: 3000, obstacles: [{ shape: 'box', pos: [0, 900], size: [500, 120, 120], name: 'Bench' }, { shape: 'cyl', pos: [-800, -300], size: [200, 200, 200], color: '#3aa0ff', name: 'Pillar' }, { shape: 'box', pos: [850, -450], size: [200, 150, 420], color: '#33c27f', name: 'Crate' }, { shape: 'box', pos: [-650, 850], size: [220, 100, 220], color: '#e5c07b', name: 'Box' }] }),
  },
  track: {
    label: 'Line track',
    make: () => { const pts: [number, number][] = []; for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push([Math.round(Math.cos(a) * 420 - 420), Math.round(Math.sin(a) * 650 + Math.sin(a * 2) * 120)]); } return { size: 3000, obstacles: [], track: { points: pts, width: 26 } }; },
  },
};

let n = 0;
export const newSceneRobotId = () => 'r' + Date.now().toString(36) + (n++).toString(36);

export function newScene(name = 'Untitled scene', world = 'cell'): Scene {
  return { format: 'formframe-scene', version: SCENE_FORMAT_VERSION, name, world: SCENE_WORLDS[world].make(), robots: [] };
}

/** A name not used yet in the scene: "Rover", "Rover 2", "Rover 3"… */
export function uniqueName(scene: Scene, base: string) {
  const taken = new Set(scene.robots.map(r => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Somewhere free on the floor for a new robot: a ring of spots around the centre, 600 mm apart. */
export function freeSpot(scene: Scene): { x: number; z: number } {
  const half = scene.world.size / 2 - 250;
  const spots: { x: number; z: number }[] = [{ x: 0, z: 0 }];
  for (let ring = 1; ring < 6; ring++) for (let k = 0; k < ring * 6; k++) { const a = (k / (ring * 6)) * Math.PI * 2; spots.push({ x: Math.round(Math.sin(a) * ring * 600), z: Math.round(Math.cos(a) * ring * 600) }); }
  const clear = (s: { x: number; z: number }) => Math.abs(s.x) < half && Math.abs(s.z) < half
    && scene.robots.every(r => Math.hypot(r.pose.x - s.x, r.pose.z - s.z) > 450)
    && scene.world.obstacles.every(o => Math.hypot(o.pos[0] - s.x, o.pos[1] - s.z) > 350);
  return spots.find(clear) ?? { x: 0, z: 0 };
}

export function parseScene(json: string): Scene {
  let s: any;
  try { s = JSON.parse(json); } catch (e) { throw new Error('Not valid JSON: ' + (e as Error).message); }
  if (s?.format !== 'formframe-scene') throw new Error('Not a Formframe scene (missing "format": "formframe-scene").');
  if (typeof s.version !== 'number' || s.version > SCENE_FORMAT_VERSION) throw new Error(`Unsupported scene version ${s.version}.`);
  return { ...newScene(), ...s, world: { size: 3000, obstacles: [], ...s.world }, robots: (s.robots ?? []).map((r: any) => ({ ...r, pose: { x: 0, z: 0, yaw: 0, ...r.pose } })) };
}
export const serializeScene = (s: Scene) => JSON.stringify(s, null, 2) + '\n';

// ------------------------------------------------------------------ storage
const DB = 'formframe-scenes', STORE = 'scenes';
let dbp: Promise<IDBDatabase | null> | null = null;
const mem = new Map<string, { meta: SceneMeta; body: string }>();
function db() {
  if (!dbp) dbp = new Promise(res => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'meta.id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const newSceneId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export async function listScenes(): Promise<SceneMeta[]> {
  const d = await db();
  const all = d ? (await req<{ meta: SceneMeta }[]>(d.transaction(STORE).objectStore(STORE).getAll())).map(x => x.meta) : [...mem.values()].map(x => x.meta);
  return all.sort((a, b) => b.updated - a.updated);
}
async function getRec(id: string) {
  const d = await db();
  return d ? req<{ meta: SceneMeta; body: string } | undefined>(d.transaction(STORE).objectStore(STORE).get(id)) : mem.get(id);
}
export async function loadScene(id: string): Promise<Scene | null> { const r = await getRec(id); return r ? parseScene(r.body) : null; }
export async function saveScene(id: string, s: Scene, thumb?: string | null) {
  const prev = (await getRec(id))?.meta, now = Date.now();
  const rec = { meta: { id, name: s.name || 'Untitled scene', created: prev?.created ?? now, updated: now, robots: s.robots.length, thumb: thumb === null ? undefined : thumb ?? prev?.thumb }, body: serializeScene(s) };
  const d = await db();
  if (!d) { mem.set(id, rec); return; }
  await req(d.transaction(STORE, 'readwrite').objectStore(STORE).put(rec));
}
export async function deleteScene(id: string) {
  const d = await db();
  if (!d) { mem.delete(id); return; }
  await req(d.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
}
