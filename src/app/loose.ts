/**
 * Electronics you add to a robot project show up in its world as loose parts:
 * a board-sized object lying on the floor or table, listed in the robot panel's
 * Objects with the blocks and boxes, that you can drag, push and pick up. "Attach"
 * mounts it on the robot where it lies: it becomes real model parts that move
 * with the robot (a sensor on the front sees what's ahead).
 *
 * Sizes and looks come from auto build's layout for that part, so a loose part
 * and an attached one match what an enclosure would hold.
 */
import * as THREE from 'three';
import { autoBuild } from './autobuild';
import { defaultAutoOpts, newBuiltModel, newUid, type BuiltPart, type Obstacle, type Project } from './project';
import { BOARDS } from '../hw/library/boards';
import { COMPONENTS } from '../hw/library/components';

/** Parts that belong to the drivetrain or power and never lie loose: wheel encoders sit on the wheels, the servo supply inside. */
const NOT_LOOSE = new Set(['encoder_wheel', 'bec']);

/** The robot's main body: the biggest part with no parent (everything else hangs off it). */
export function rootPart(parts: BuiltPart[]) {
  let best: BuiltPart | null = null, v = -1;
  for (const p of parts) if (!p.parent) { const pv = p.size[0] * p.size[1] * p.size[2]; if (pv > v) { v = pv; best = p; } }
  return best;
}

/** The parts auto build would make for one component, laid flat (thin side down), centred on x/z, bottom at y = 0. */
export function flatParts(p: Project, uid: string): { parts: BuiltPart[]; size: [number, number, number]; color: string } {
  const board = BOARDS[p.electronics.board];
  let src: BuiltPart[] = [];
  try { if (board) src = autoBuild(board, p.electronics.comps, p.product.built?.auto ?? defaultAutoOpts()).parts.filter(x => x.comp === uid && x.kind === 'internal'); } catch { src = []; }
  if (!src.length) src = [{ id: 'x', name: 'Module', shape: 'box', size: [25, 25, 6], pos: [0, 0, 0], rot: [0, 0, 0], color: '#1f6f43', finish: 'satin', role: 'body', kind: 'internal', comp: uid }];
  // auto build stands boards up facing +Z (the product's front); lying flat on a surface = turned -90° about X: (x, y, z) -> (x, z, -y)
  const flat = src.map(q => ({ ...q, pos: [q.pos[0], q.pos[2], -q.pos[1]] as [number, number, number], rot: [q.rot[0] - 90, q.rot[1], q.rot[2]] as [number, number, number] }));
  const box = new THREE.Box3();
  for (const q of flat) { // extents after the turn: width x, thickness (old z) y, height (old y) z
    const h = new THREE.Vector3(q.size[0] / 2, q.size[2] / 2, q.size[1] / 2), c = new THREE.Vector3(...q.pos);
    box.expandByPoint(c.clone().sub(h)); box.expandByPoint(c.clone().add(h));
  }
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const parts = flat.map(q => ({ ...q, pos: [Math.round((q.pos[0] - c.x) * 10) / 10, Math.round((q.pos[1] - box.min.y) * 10) / 10, Math.round((q.pos[2] - c.z) * 10) / 10] as [number, number, number] }));
  const main = src.reduce((a, b) => (a.size[0] * a.size[1] >= b.size[0] * b.size[1] ? a : b));
  return { parts, size: [Math.max(4, Math.round(s.x)), Math.max(3, Math.round(s.y)), Math.max(4, Math.round(s.z))], color: main.color };
}

/** A clear spot on the floor near the robot for something `size` big. */
function freeSpot(p: Project, size: [number, number, number]): [number, number] {
  const w = p.product.built!.robot!.world!, half = w.size / 2 - Math.max(size[0], size[2]) / 2 - 10;
  const root = rootPart(p.product.built!.parts), reach = root ? Math.max(root.size[0], root.size[2]) / 2 + 60 : 120;
  const clear = (x: number, z: number) => w.obstacles.every(o => Math.hypot(o.pos[0] - x, o.pos[1] - z) > (Math.max(o.size[0], o.size[2]) + Math.max(size[0], size[2])) / 2 + 15);
  for (let ring = 0; ring < 6; ring++) for (let k = 0; k < 12; k++) {
    const a = Math.PI / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 6), r = reach + ring * 70; // in front first, then around
    const x = Math.round(Math.max(-half, Math.min(half, Math.cos(a) * r))), z = Math.round(Math.max(-half, Math.min(half, Math.sin(a) * r)));
    if (clear(x, z)) return [x, z];
  }
  return [0, Math.round(Math.min(half, reach))];
}

/**
 * Electronics you add show up in the 3D model as real parts you can select and move
 * (no case: Auto build makes one only when you ask). Used for projects whose model is
 * built from parts or not made yet; the built-in thermostat and imported CAD models are
 * left alone, and robots get loose parts in their world instead. Each component is
 * placed once, where auto build's layout puts it; its pieces move together. They're
 * marked auto, so Auto build lays them out again inside the case it makes.
 */
export function placeElectronics(p: Project): boolean {
  const src = p.product.source, comps = p.electronics.comps;
  if ((src !== 'none' && src !== 'built') || p.product.built?.robot || !comps.length) return false;
  const board = BOARDS[p.electronics.board]; if (!board) return false;
  const m = p.product.built ?? newBuiltModel();
  const placed = new Set(m.placed ?? []), todo = ['board', ...comps.map(c => c.uid)].filter(k => !placed.has(k) && !m.parts.some(q => q.comp === k));
  if (!todo.length) { if (!m.placed || m.placed.length !== placed.size) m.placed = [...placed]; return false; }
  let layout: BuiltPart[] = [];
  try { layout = autoBuild(board, comps, m.auto ?? defaultAutoOpts()).parts.filter(x => x.kind === 'internal'); } catch { layout = []; }
  let added = false;
  for (const key of todo) {
    const mine = layout.filter(q => q.comp === key); placed.add(key);
    if (!mine.length) continue;
    const ids = new Map(mine.map(q => [q.id, `${q.id}-${newUid()}`]));
    const main = mine.reduce((a, b) => (a.size[0] * a.size[1] * a.size[2] >= b.size[0] * b.size[1] * b.size[2] ? a : b));
    for (const q of mine) m.parts.push({ ...q, id: ids.get(q.id)!, parent: q.parent && ids.has(q.parent) ? ids.get(q.parent) : q === main ? undefined : ids.get(main.id), auto: true });
    added = true;
  }
  m.placed = [...placed];
  if (added && !p.product.built) { p.product.built = m; p.product.source = 'built'; }
  return added;
}

/**
 * A component removed in Electronics takes its 3D part with it (a display module, a
 * sensor, a button cap...), on any model, along with parts mounted on that part
 * (its display window, say). Parts not tied to a component are never touched.
 */
export function dropRemovedParts(m: { parts: { id: string; parent?: string; comp?: string }[] }, uids: Set<string>): boolean {
  const gone = new Set(m.parts.filter(q => q.comp && q.comp !== 'board' && !uids.has(q.comp)).map(q => q.id));
  if (!gone.size) return false;
  let grew = true;
  while (grew) { grew = false; for (const q of m.parts) if (q.parent && gone.has(q.parent) && !gone.has(q.id)) { gone.add(q.id); grew = true; } }
  m.parts = m.parts.filter(q => !gone.has(q.id));
  return true;
}

/**
 * Keep the world in step with the wiring: a part added in Electronics (that the
 * model doesn't already show) appears loose in the world, once; a removed part's
 * loose object and attached parts go away. Returns true when it changed anything.
 */
export function syncLooseParts(p: Project): boolean {
  const placedNow = placeElectronics(p);
  const m = p.product.built; if (!m) return placedNow;
  const uids = new Set(p.electronics.comps.map(c => c.uid));
  let changed = dropRemovedParts(m, uids) || placedNow;
  const w = m.robot?.world; if (!w) return changed;
  const sp = m.robot!;
  const placed = new Set((sp.placed ?? []).filter(u => uids.has(u)));
  if ((sp.placed ?? []).length !== placed.size) changed = true;
  // removed in Electronics: drop its loose object and the parts it was attached as
  const keepObs = w.obstacles.filter(o => !o.comp || uids.has(o.comp));
  if (keepObs.length !== w.obstacles.length) { w.obstacles = keepObs; changed = true; }
  // added: show it loose, once (deleting the loose object later doesn't bring it back)
  for (const c of p.electronics.comps) {
    if (NOT_LOOSE.has(c.type) || placed.has(c.uid) || m.parts.some(q => q.comp === c.uid) || w.obstacles.some(o => o.comp === c.uid)) { placed.add(c.uid); continue; }
    const f = flatParts(p, c.uid), name = COMPONENTS[c.type]?.name ?? c.type;
    w.obstacles.push({ shape: 'box', pos: freeSpot(p, f.size), size: f.size, color: f.color, name, material: 'plastic', pick: true, comp: c.uid });
    placed.add(c.uid); changed = true;
  }
  if (changed || (sp.placed ?? []).length !== placed.size) sp.placed = [...placed];
  return changed;
}

/**
 * Mount loose object `i` on the robot where it lies. `body` maps model space to world
 * (the robot may have driven off from where it started). Returns the new parts.
 */
export function attachLoose(p: Project, i: number, body: THREE.Matrix4): BuiltPart[] | null {
  const m = p.product.built, w = m?.robot?.world, o = w?.obstacles[i];
  if (!m || !w || !o?.comp) return null;
  const root = rootPart(m.parts); if (!root) return null;
  const f = flatParts(p, o.comp);
  // where it lies, in the robot's own (rest) frame, kept on top of the main body's footprint
  const local = new THREE.Vector3(o.pos[0], 0, o.pos[1]).applyMatrix4(body.clone().invert());
  const hx = Math.max(0, root.size[0] / 2 - f.size[0] / 2), hz = Math.max(0, root.size[2] / 2 - f.size[2] / 2);
  const x = Math.max(root.pos[0] - hx, Math.min(root.pos[0] + hx, local.x)), z = Math.max(root.pos[2] - hz, Math.min(root.pos[2] + hz, local.z));
  const top = root.pos[1] + root.size[1] / 2;
  const turn = (o.rot ?? 0) * Math.PI / 180, cs = Math.cos(turn), sn = Math.sin(turn);
  const made = f.parts.map(q => ({
    ...q, id: newUid(), auto: undefined, attached: true as const, parent: root.id, comp: o.comp,
    pos: [Math.round((x + q.pos[0] * cs + q.pos[2] * sn) * 10) / 10, Math.round((top + q.pos[1]) * 10) / 10, Math.round((z - q.pos[0] * sn + q.pos[2] * cs) * 10) / 10] as [number, number, number],
    rot: [q.rot[0], q.rot[1] + (o.rot ?? 0), q.rot[2]] as [number, number, number],
  }));
  m.parts.push(...made);
  w.obstacles.splice(i, 1);
  return made;
}
