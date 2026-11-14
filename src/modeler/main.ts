import './modeler.css';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { $, $$, h, esc, ICON, kc, isMac, initMenus, closeMenus, menuOpen, popup, menubar, pie, bnum, bvec, panel, brow, bselect, bcheck, btext, type MenuItem, type NumOpts } from './ui';
import { View, type Shading, type ViewName } from './view';
import { BuiltProduct } from '../scene/built';
import { listProjects, loadProject, saveProject } from '../app/store';
import { newBuiltModel, newUid, defaultAutoOpts, type Project, type BuiltModel, type BuiltPart, type ShapeKind, type BindRole } from '../app/project';
import { autoBuild, mergeRebuild } from '../app/autobuild';
import { fitBuilt, bounds } from '../app/fit';
import { BOARDS } from '../hw/library/boards';
import { COMPONENTS } from '../hw/library/components';
import { listen, post } from '../app/sync';
import { toEMesh, writeEMesh, append, type EMesh } from '../scene/mesh';
import * as Ed from './edit';
const { E } = Ed;

/**
 * Formframe Modeler: a Blender-style editor for built models, in its own
 * window. It edits project.product.built in the shared IndexedDB store and
 * tells the studio window (BroadcastChannel) so it rebuilds live.
 *
 * Coordinates: shown Blender style (Z up, front view along +Y). Stored data is
 * Y-up with the front facing +Z; see toB/fromB.
 */
type Tool = 'select' | 'cursor' | 'move' | 'rotate' | 'scale' | 'transform';
type V3 = [number, number, number];
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const r2 = (v: number) => Math.round(v * 100) / 100;

const S = {
  id: '', project: null as Project | null, built: newBuiltModel(), prod: null as BuiltProduct | null,
  sel: new Set<string>(), active: null as string | null, hidden: new Set<string>(),
  tool: 'select' as Tool, snap: false, snapMove: 1, snapRot: 5, emuNumpad: true, trackpadOrbit: isMac,
  undo: [] as { name: string; json: string }[], redo: [] as { name: string; json: string }[],
  dirty: false, saveT: 0 as any, fieldEdit: false, firstEdit: true,
  ptab: 'object', sbtab: 'item', infoTab: 'reports', reports: [] as { t: Date; msg: string; level: string }[],
  mouse: { x: 0, y: 0 }, collapsed: new Set<string>(), outFilter: '', redoOp: null as null | { name: string; id: string },
};
let V: View;

// ------------------------------------------------------------------ coordinates
const qM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), qMi = qM.clone().invert();
const toB = (p: V3): V3 => [p[0], -p[2], p[1]];
const fromB = (b: V3): V3 => [b[0], b[2], -b[1]];
const dimsB = (s: V3): V3 => [s[0], s[2], s[1]];
const dimsFromB = (b: V3): V3 => [b[0], b[2], b[1]];
function rotToB(rot: V3): V3 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R, 'XYZ'));
  const e = new THREE.Euler().setFromQuaternion(qM.clone().multiply(q).multiply(qMi), 'ZYX'); // Blender "XYZ Euler"
  return [e.x, e.y, e.z].map(v => r2(v * R2D)) as V3;
}
function rotFromB(b: V3): V3 {
  const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(b[0] * D2R, b[1] * D2R, b[2] * D2R, 'ZYX'));
  const e = new THREE.Euler().setFromQuaternion(qMi.clone().multiply(qb).multiply(qM), 'XYZ');
  return [e.x, e.y, e.z].map(v => r2(v * R2D)) as V3;
}

// ------------------------------------------------------------------ model helpers
const parts = () => S.built.parts;
const part = (id: string | null) => (id ? parts().find(p => p.id === id) ?? null : null);
const root = (id: string) => S.prod!.roots.get(id) ?? null;
const selParts = () => parts().filter(p => S.sel.has(p.id));
const COLL: Record<string, { name: string; kind: BuiltPart['kind'] }> = { shell: { name: 'Enclosure', kind: 'shell' }, ext: { name: 'Details', kind: undefined }, internal: { name: 'Internals', kind: 'internal' } };
const collOf = (p: BuiltPart) => p.kind ?? 'ext';
const ROLES: Record<BindRole, string> = { body: 'Body', dial: 'Dial (rotates)', screen: 'Screen', press: 'Press surface', led: 'LED / light', ignore: 'Hidden in product' };
const FIN: Record<string, string> = { matte: 'Matte', satin: 'Satin', gloss: 'Gloss', soft: 'Soft-touch', brushed: 'Brushed metal', polished: 'Polished metal', clear: 'Clear / translucent' };
const SHAPE_NAMES: Record<ShapeKind, string> = { box: 'Cube', rbox: 'Rounded Cube', cyl: 'Cylinder', tube: 'Tube', sphere: 'UV Sphere', torus: 'Torus', cone: 'Cone', disc: 'Circle', rect: 'Plane', mesh: 'Mesh' };
const PARAM: Partial<Record<ShapeKind, [string, number, number, number, string]>> = { rbox: ['Corner Radius', 0, 50, 0.5, 'mm'], tube: ['Inner Diameter', 0, 400, 0.5, 'mm'], cone: ['Top Ratio', 0, 1, 0.05, ''] };

function uniqueName(base: string) {
  const names = new Set(parts().map(p => p.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) { const n = `${stem}.${String(i).padStart(3, '0')}`; if (!names.has(n)) return n; }
}

// ------------------------------------------------------------------ reports, undo, save
function report(msg: string, level: 'info' | 'warn' | 'err' | 'ok' = 'info') {
  S.reports.push({ t: new Date(), msg, level }); if (S.reports.length > 200) S.reports.shift();
  if (S.infoTab === 'reports') renderInfo();
  const st = $('#stRight'); st.dataset.flash = msg;
}
function pushUndo(name: string) {
  S.undo.push({ name, json: JSON.stringify(S.built) }); if (S.undo.length > 100) S.undo.shift(); S.redo = [];
  if (S.firstEdit) { S.firstEdit = false; $('#banner').classList.remove('show'); }
}
function restoreJson(json: string) {
  const b = JSON.parse(json) as BuiltModel; b.rev = S.built.rev;
  S.built = b; S.prod!.model = b;
  for (const id of [...S.sel]) if (!part(id)) S.sel.delete(id);
  if (S.active && !part(S.active)) S.active = null;
}
function undo() {
  const u = S.undo.pop(); if (!u) { report('Nothing to undo', 'warn'); return; }
  S.redo.push({ name: u.name, json: JSON.stringify(S.built) }); restoreJson(u.json); Ed.reload(); rebuild(); scheduleSave(); report('Undo ' + u.name);
}
function redo() {
  const r = S.redo.pop(); if (!r) { report('Nothing to redo', 'warn'); return; }
  S.undo.push({ name: r.name, json: JSON.stringify(S.built) }); restoreJson(r.json); Ed.reload(); rebuild(); scheduleSave(); report('Redo ' + r.name);
}
/** Make a change as one undo step. */
function commit(name: string, fn: () => void, msg?: string) {
  pushUndo(name); fn(); S.redoOp = null; $('#redo').classList.remove('show'); rebuild(); scheduleSave(); if (msg !== '') report(msg ?? name);
}
function scheduleSave() {
  S.dirty = true; $('#saveState').textContent = 'Unsaved';
  clearTimeout(S.saveT); S.saveT = setTimeout(save, 350);
}
async function save() {
  clearTimeout(S.saveT);
  if (!S.id) return;
  try {
    const latest = (await loadProject(S.id)) ?? S.project!;
    S.built.rev = Math.max(S.built.rev ?? 0, latest.product.built?.rev ?? 0) + 1;
    latest.product.built = JSON.parse(JSON.stringify(S.built));
    latest.product.source = 'built';
    await saveProject(S.id, latest, undefined, true);
    S.project = latest; S.dirty = false;
    $('#saveState').textContent = 'Saved';
    post({ type: 'built', id: S.id });
  } catch (e: any) { report('Save failed: ' + (e?.message ?? e), 'err'); $('#saveState').textContent = 'Save failed'; }
}
/** The studio (or another modeler) saved: pick up electronics changes, and model edits made there. */
async function reloadFromStore() {
  const p = await loadProject(S.id); if (!p) return;
  S.project = p; renderTitle();
  const sb = p.product.built;
  if (sb && !S.dirty && (sb.rev ?? 0) > (S.built.rev ?? 0)) { S.built = sb; S.prod!.model = sb; for (const id of [...S.sel]) if (!part(id)) S.sel.delete(id); if (S.active && !part(S.active)) S.active = null; Ed.reload(); rebuild(); report('Updated from the studio'); }
  else if (sb && !S.dirty && (sb.rev ?? 0) < (S.built.rev ?? 0) && p.product.source === 'built') scheduleSave(); // someone wrote an older copy: put ours back
  else if (S.ptab === 'scene') renderProps();
}

// ------------------------------------------------------------------ rebuild + selection display
function rebuild3D() {
  S.prod!.build();
  for (const [id, r] of S.prod!.roots) r.visible = !S.hidden.has(id);
  V.refreshMaterials();
  Ed.onRebuild();
  updateSelViz();
}
function rebuild() { rebuild3D(); renderAll(); }
function refreshFields() { $$('.bnum').forEach(e => (e as any).refresh?.()); }

function median(ids: string[]) {
  const c = new THREE.Vector3(); let n = 0;
  for (const id of ids) { const r = root(id); if (!r) continue; c.add(r.getWorldPosition(new THREE.Vector3())); n++; }
  return n ? c.divideScalar(n) : c;
}
function updateSelViz() {
  const roots = E.on ? [] : [...S.sel].map(root).filter(Boolean) as THREE.Object3D[];
  V.setSelection(roots, !E.on && S.active && S.sel.has(S.active) ? root(S.active) : null);
  const gz = !E.on && (S.tool === 'move' || S.tool === 'rotate' || S.tool === 'scale' || S.tool === 'transform');
  const on = gz && roots.length > 0 && !modal;
  V.tc.visible = on; (V.tc as any).enabled = on;
  if (on && !gizmoDrag) {
    V.helper.position.copy(median([...S.sel])); V.helper.quaternion.identity(); V.helper.scale.set(1, 1, 1);
    V.tc.setMode(S.tool === 'rotate' ? 'rotate' : S.tool === 'scale' ? 'scale' : 'translate');
  }
}
function setSel(ids: string[], active: string | null = ids[ids.length - 1] ?? null) {
  if (E.on && !(ids.length === 1 && ids[0] === E.id)) leaveEdit();
  S.sel = new Set(ids); S.active = active; updateSelViz(); renderAll(false);
}

// ------------------------------------------------------------------ transforms (shared by modal G/R/S and the gizmo tools)
interface Orig { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3; wpos: THREE.Vector3; wquat: THREE.Quaternion }
function captureOrig() {
  const m = new Map<string, Orig>();
  for (const id of S.sel) { const r = root(id); if (!r) continue; m.set(id, { pos: r.position.clone(), quat: r.quaternion.clone(), scale: r.scale.clone(), wpos: r.getWorldPosition(new THREE.Vector3()), wquat: r.getWorldQuaternion(new THREE.Quaternion()) }); }
  return m;
}
function restoreOrig(o: Map<string, Orig>) { for (const [id, t] of o) { const r = root(id); if (r) { r.position.copy(t.pos); r.quaternion.copy(t.quat); r.scale.copy(t.scale); } } }
const parentQ = () => S.prod!.mm.getWorldQuaternion(new THREE.Quaternion());
function setWorld(r: THREE.Object3D, wpos: THREE.Vector3, wquat?: THREE.Quaternion) {
  r.position.copy(S.prod!.mm.worldToLocal(wpos.clone()));
  if (wquat) r.quaternion.copy(parentQ().invert().multiply(wquat));
}
function applyMove(o: Map<string, Orig>, d: THREE.Vector3) { for (const [id, t] of o) { const r = root(id)!; r.quaternion.copy(t.quat); r.scale.copy(t.scale); setWorld(r, t.wpos.clone().add(d)); } }
function applyRot(o: Map<string, Orig>, q: THREE.Quaternion, pivot: THREE.Vector3) {
  for (const [id, t] of o) { const r = root(id)!; r.scale.copy(t.scale); setWorld(r, t.wpos.clone().sub(pivot).applyQuaternion(q).add(pivot), q.clone().multiply(t.wquat)); }
}
function applyScale(o: Map<string, Orig>, m: THREE.Matrix3, pivot: THREE.Vector3) {
  for (const [id, t] of o) {
    const r = root(id)!; r.quaternion.copy(t.quat);
    setWorld(r, t.wpos.clone().sub(pivot).applyMatrix3(m).add(pivot));
    const f = [0, 1, 2].map(i => new THREE.Vector3().setComponent(i, 1).applyQuaternion(t.wquat).applyMatrix3(m).length());
    r.scale.set(t.scale.x * f[0], t.scale.y * f[1], t.scale.z * f[2]);
  }
}
/** Write the roots' transforms back into the parts (bakes scale into size). */
function writeBack(ids: Iterable<string>) {
  for (const id of ids) {
    const p = part(id), r = root(id); if (!p || !r) continue;
    p.pos = [r.position.x, r.position.y, r.position.z].map(r2) as V3;
    const e = new THREE.Euler().setFromQuaternion(r.quaternion, 'XYZ'); p.rot = [e.x, e.y, e.z].map(v => r2(v * R2D)) as V3;
    if (Math.abs(r.scale.x - 1) + Math.abs(r.scale.y - 1) + Math.abs(r.scale.z - 1) > 1e-6) {
      p.size = [p.size[0] * r.scale.x, p.size[1] * r.scale.y, p.size[2] * r.scale.z].map(v => Math.max(0.05, r2(v))) as V3;
      if (p.shape === 'tube' && p.param) p.param = r2(p.param * r.scale.x);
      r.scale.set(1, 1, 1);
    }
  }
}

// ------------------------------------------------------------------ modal G / R / S
type Axis = 'x' | 'y' | 'z';
interface Modal { kind: 'G' | 'R' | 'S'; axis: Axis | null; plane: boolean; local: boolean; typed: string; sx: number; sy: number; pivot: THREE.Vector3; ps: { x: number; y: number }; orig: Map<string, Orig>; dupe: boolean; ctrl: boolean; shift: boolean }
let modal: Modal | null = null;
let gizmoDrag: null | { orig: Map<string, Orig>; pos: THREE.Vector3; quat: THREE.Quaternion; pivot: THREE.Vector3 } = null;
const NAMES = { G: 'Move', R: 'Rotate', S: 'Resize' };

function startModal(kind: Modal['kind'], dupe = false) {
  if (!S.sel.size) { report('No objects selected', 'warn'); return; }
  if (modal) return;
  closeMenus();
  const pivot = median([...S.sel]);
  pushUndo(dupe ? 'Duplicate Objects' : NAMES[kind]);
  modal = { kind, axis: null, plane: false, local: false, typed: '', sx: S.mouse.x, sy: S.mouse.y, pivot, ps: V.project(pivot), orig: captureOrig(), dupe, ctrl: false, shift: false };
  V.tc.visible = false; (V.tc as any).enabled = false;
  document.body.classList.add('modal');
  updateModal(); renderStatus();
}
function axisVec(m: Modal) {
  const v = new THREE.Vector3().setComponent('xyz'.indexOf(m.axis!), 1);
  if (m.local && S.active && root(S.active)) v.applyQuaternion(root(S.active)!.getWorldQuaternion(new THREE.Quaternion()));
  return v.normalize();
}
function updateModal() {
  const m = modal; if (!m) return;
  restoreOrig(m.orig);
  const typed = m.typed && m.typed !== '-' && m.typed !== '.' ? parseFloat(m.typed) : NaN;
  const snapping = S.snap !== m.ctrl, fine = m.shift ? 0.1 : 1;
  const axName = m.axis ? `along ${m.local ? 'local' : 'global'} ${m.axis.toUpperCase()}` : '';
  const scr = { x: (S.mouse.x - m.sx) * fine, y: (S.mouse.y - m.sy) * fine };
  let hud = '';
  if (m.kind === 'G') {
    let d = new THREE.Vector3();
    if (!isNaN(typed)) d = (m.axis ? axisVec(m) : new THREE.Vector3(1, 0, 0)).multiplyScalar(typed);
    else if (m.axis && !m.plane) {
      const a = axisVec(m), L = V.viewDist() * 0.2, s0 = V.project(m.pivot), s1 = V.project(m.pivot.clone().addScaledVector(a, L));
      const sx = s1.x - s0.x, sy = s1.y - s0.y, len2 = sx * sx + sy * sy || 1;
      d = a.multiplyScalar(((scr.x * sx + scr.y * sy) / len2) * L);
    } else {
      const n = V.viewNormal(), p0 = V.rayPlane(m.sx, m.sy, m.pivot, n), p1 = V.rayPlane(m.sx + scr.x, m.sy + scr.y, m.pivot, n);
      if (p0 && p1) d = p1.sub(p0);
      if (m.axis && m.plane) { const a = axisVec(m); d.addScaledVector(a, -d.dot(a)); }
    }
    if (snapping && isNaN(typed)) d.set(Math.round(d.x / S.snapMove) * S.snapMove, Math.round(d.y / S.snapMove) * S.snapMove, Math.round(d.z / S.snapMove) * S.snapMove);
    applyMove(m.orig, d);
    const len = m.axis && !m.plane ? d.dot(axisVec(m)) : d.length();
    hud = `D: ${m.typed ? `[${m.typed}|]` : r2(len)} mm (${r2(d.x)}, ${r2(d.y)}, ${r2(d.z)}) ${m.plane ? `locking ${m.axis!.toUpperCase()}` : axName}`;
  } else if (m.kind === 'R') {
    const a0 = Math.atan2(m.sy - m.ps.y, m.sx - m.ps.x), a1 = Math.atan2(m.sy + scr.y - m.ps.y, m.sx + scr.x - m.ps.x);
    let ang = -(a1 - a0);
    const axis = m.axis ? axisVec(m) : V.viewNormal();
    if (m.axis && axis.dot(V.viewNormal()) < 0) ang = -ang;
    if (!isNaN(typed)) ang = typed * D2R;
    else if (snapping) ang = Math.round(ang * R2D / S.snapRot) * S.snapRot * D2R;
    applyRot(m.orig, new THREE.Quaternion().setFromAxisAngle(axis, ang), m.pivot);
    hud = `Rot: ${m.typed ? `[${m.typed}|]` : r2(((ang * R2D + 540) % 360) - 180)}° ${axName}`;
  } else {
    const d0 = Math.max(4, Math.hypot(m.sx - m.ps.x, m.sy - m.ps.y));
    let f = Math.hypot(m.sx + scr.x - m.ps.x, m.sy + scr.y - m.ps.y) / d0;
    if (m.shift) f = 1 + (Math.hypot(S.mouse.x - m.ps.x, S.mouse.y - m.ps.y) / d0 - 1) * 0.1;
    if (!isNaN(typed)) f = typed; else if (snapping) f = Math.round(f * 10) / 10;
    const M = new THREE.Matrix3();
    if (m.axis) {
      const a = axisVec(m), A = new THREE.Matrix3().set(a.x * a.x, a.x * a.y, a.x * a.z, a.y * a.x, a.y * a.y, a.y * a.z, a.z * a.x, a.z * a.y, a.z * a.z);
      const k = f - 1, I = new THREE.Matrix3();
      const e = m.plane ? I.elements.map((v, i) => v - A.elements[i]) : A.elements;
      M.fromArray(I.elements.map((v, i) => v + k * e[i]));
    } else M.set(f, 0, 0, 0, f, 0, 0, 0, f);
    applyScale(m.orig, M, m.pivot);
    hud = `Scale: ${m.typed ? `[${m.typed}|]` : r2(f)} ${m.plane ? `locking ${m.axis!.toUpperCase()}` : axName}`;
  }
  // constraint line
  if (m.axis) {
    const a = axisVec(m), l = V.axisLine;
    l.position.copy(m.pivot); l.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), a);
    (l.material as THREE.LineBasicMaterial).color.setHex(({ x: 0xff3352, y: 0x8bdc00, z: 0x2890ff })[m.axis]); l.visible = true;
  } else V.axisLine.visible = false;
  $('#modalHud').textContent = hud;
  updateSelViz();
}
function endModal(ok: boolean) {
  const m = modal; if (!m) return;
  modal = null; V.axisLine.visible = false; $('#modalHud').textContent = ''; document.body.classList.remove('modal');
  if (ok) { writeBack(m.orig.keys()); S.redoOp = null; $('#redo').classList.remove('show'); rebuild(); scheduleSave(); report(`${m.dupe ? 'Duplicate Objects' : NAMES[m.kind]} ${m.orig.size} object${m.orig.size > 1 ? 's' : ''}`); }
  else { restoreOrig(m.orig); if (!m.dupe) S.undo.pop(); else { rebuild(); scheduleSave(); } updateSelViz(); renderStatus(); }
}
function modalKey(e: KeyboardEvent) {
  const m = modal!, k = e.key;
  if (k === 'Escape') return endModal(false);
  if (k === 'Enter' || k === ' ') return endModal(true);
  if (k === 'Control' || k === 'Meta') { m.ctrl = true; return updateModal(); }
  if (k === 'Shift') { m.shift = true; m.sx = S.mouse.x; m.sy = S.mouse.y; m.orig = m.orig; return updateModal(); }
  const lk = k.toLowerCase();
  if (lk === 'x' || lk === 'y' || lk === 'z') {
    const plane = e.shiftKey;
    if (m.axis === lk && m.plane === plane) { if (!m.local) m.local = true; else { m.axis = null; m.local = false; } }
    else { m.axis = lk; m.plane = plane; m.local = false; }
    return updateModal();
  }
  if (lk === 'g' || lk === 'r' || lk === 's') { const kind = lk === 'g' ? 'G' : lk === 'r' ? 'R' : 'S'; if (kind !== m.kind) { restoreOrig(m.orig); m.kind = kind; m.typed = ''; m.sx = S.mouse.x; m.sy = S.mouse.y; m.ps = V.project(m.pivot); updateModal(); } return; }
  if (/^[0-9.]$/.test(k)) { m.typed += k; return updateModal(); }
  if (k === '-') { m.typed = m.typed.startsWith('-') ? m.typed.slice(1) : '-' + m.typed; return updateModal(); }
  if (k === 'Backspace') { m.typed = m.typed.slice(0, -1); return updateModal(); }
}

// ------------------------------------------------------------------ operators
const SHAPES: Record<ShapeKind, V3> = { box: [20, 20, 20], rbox: [40, 20, 30], cyl: [20, 20, 20], tube: [30, 30, 5], sphere: [20, 20, 20], torus: [30, 30, 5], cone: [20, 20, 20], disc: [20, 20, 0.5], rect: [40, 40, 0.5], mesh: [20, 20, 20] };
interface Preset { name: string; shape: ShapeKind; size: V3; role?: BindRole; kind?: BuiltPart['kind']; param?: number; segments?: number; color?: string; finish?: string; array?: BuiltPart['array'] }
const PRESETS: Record<string, Preset> = {
  housing: { name: 'Housing', shape: 'rbox', size: [80, 60, 30], param: 6, kind: 'shell', color: '#ece9e4', finish: 'matte' },
  window: { name: 'Display Window', shape: 'disc', size: [32.4, 32.4, 0.3], role: 'screen', color: '#000000', finish: 'gloss' },
  ring: { name: 'Light Ring', shape: 'tube', size: [66, 66, 0.8], param: 52, role: 'led', segments: 24, color: '#1a1c20', finish: 'satin' },
  cap: { name: 'Button Cap', shape: 'cyl', size: [12, 12, 4], role: 'press', color: '#2b2f36', finish: 'satin' },
  knob: { name: 'Knob', shape: 'cyl', size: [30, 30, 16], role: 'dial', color: '#b9bdc3', finish: 'brushed' },
  standoff: { name: 'Standoff', shape: 'cyl', size: [5, 5, 8], kind: 'internal', color: '#cfd2d6', finish: 'brushed' },
  vents: { name: 'Vent Slots', shape: 'box', size: [1.6, 10, 0.8], color: '#08090b', array: { n: 6, mode: 'linear', step: [3.5, 0, 0] } },
};
function addPart(pr: Preset) {
  const c = S.prod!.mm.worldToLocal(V.cursor.clone());
  const p: BuiltPart = { id: newUid(), name: uniqueName(pr.name), shape: pr.shape, size: [...pr.size] as V3, pos: [c.x, c.y, c.z].map(r2) as V3, rot: [0, 0, 0], color: pr.color ?? '#cccccc', finish: pr.finish ?? 'satin', role: pr.role ?? 'body', kind: pr.kind, param: pr.param, segments: pr.segments, array: pr.array ? JSON.parse(JSON.stringify(pr.array)) : undefined, layer: 0 };
  commit('Add ' + p.name, () => { parts().push(p); S.sel = new Set([p.id]); S.active = p.id; }, `Added ${p.name}`);
  showRedo('Add ' + pr.name, p.id);
}
const addShape = (k: ShapeKind) => addPart({ name: SHAPE_NAMES[k], shape: k, size: SHAPES[k], param: k === 'rbox' ? 3 : k === 'tube' ? 22 : k === 'cone' ? 0 : undefined });
function duplicate() {
  if (!S.sel.size) return report('No objects selected', 'warn');
  const clones = selParts().map(p => ({ ...JSON.parse(JSON.stringify(p)), id: newUid(), name: '', auto: false }) as BuiltPart);
  clones.forEach((c, i) => { c.name = uniqueName(selParts()[i].name); parts().push(c); });
  const actIdx = selParts().findIndex(p => p.id === S.active);
  S.sel = new Set(clones.map(c => c.id)); S.active = clones[actIdx >= 0 ? actIdx : 0].id;
  rebuild3D(); startModal('G', true); renderAll();
}
function deleteSel() {
  if (!S.sel.size) return report('No objects selected', 'warn');
  const n = S.sel.size;
  commit('Delete', () => { S.built.parts = parts().filter(p => !S.sel.has(p.id)); S.prod!.model = S.built; S.sel.clear(); S.active = null; }, `Deleted ${n} object${n > 1 ? 's' : ''}`);
}
function mirrorX() {
  if (!S.sel.size) return report('No objects selected', 'warn');
  commit('Mirror X', () => {
    const add = selParts().map(p => { const q: BuiltPart = JSON.parse(JSON.stringify(p)); q.id = newUid(); q.name = uniqueName(p.name); q.auto = false; q.pos = [-p.pos[0], p.pos[1], p.pos[2]]; q.rot = [p.rot[0], -p.rot[1], -p.rot[2]]; if (q.array?.step) q.array.step = [-q.array.step[0], q.array.step[1], q.array.step[2]]; if (q.array?.center) q.array.center = [-q.array.center[0], q.array.center[1]]; return q; });
    parts().push(...add); S.sel = new Set(add.map(a => a.id)); S.active = add[0]?.id ?? null;
  });
}
function setRole(r: BindRole) { if (!S.sel.size) return; commit('Set Role', () => selParts().forEach(p => (p.role = r)), `Role: ${ROLES[r]}`); }
function moveTo(c: string) { if (!S.sel.size) return; commit('Move to Collection', () => selParts().forEach(p => (p.kind = COLL[c].kind)), `Moved to ${COLL[c].name}`); }
function hideSel(unselected = false) {
  const ids = parts().filter(p => unselected ? !S.sel.has(p.id) : S.sel.has(p.id)).map(p => p.id);
  ids.forEach(i => S.hidden.add(i)); if (!unselected) { S.sel.clear(); S.active = null; }
  rebuild3D(); renderAll(); report(`Hid ${ids.length} object${ids.length === 1 ? '' : 's'}`);
}
function reveal() { const ids = [...S.hidden]; S.hidden.clear(); S.sel = new Set(ids); rebuild3D(); renderAll(); report(`Revealed ${ids.length}`); }
function selectAll() { setSel(parts().filter(p => !S.hidden.has(p.id)).map(p => p.id), S.active); }
function invertSel() { setSel(parts().filter(p => !S.hidden.has(p.id) && !S.sel.has(p.id)).map(p => p.id)); }
function snapOp(k: string) {
  const sel = [...S.sel];
  if (k === 'cursorSel') { const em = Ed.median(); if (em) { V.cursor.copy(em); renderSidebar(); return; } if (!sel.length) return report('No objects selected', 'warn'); V.cursor.copy(median(sel)); }
  if (k === 'cursorOrigin') V.cursor.set(0, 0, 0);
  if (k === 'cursorActive') { const r = S.active && root(S.active); if (r) V.cursor.copy(r.getWorldPosition(new THREE.Vector3())); }
  if (k === 'selCursor' || k === 'selGrid' || k === 'selActive') {
    if (!sel.length) return report('No objects selected', 'warn');
    commit('Snap Selection', () => {
      const o = captureOrig(), target = k === 'selCursor' ? V.cursor.clone() : k === 'selActive' ? root(S.active!)?.getWorldPosition(new THREE.Vector3()) ?? median(sel) : null;
      if (target) applyMove(o, target.sub(median(sel)));
      else for (const [id, t] of o) setWorld(root(id)!, new THREE.Vector3(Math.round(t.wpos.x), Math.round(t.wpos.y), Math.round(t.wpos.z)));
      writeBack(o.keys());
    });
  }
  renderSidebar();
}
async function runAutoBuild() {
  const prj = S.project; if (!prj) return;
  const comps = prj.electronics.comps, o = S.built.auto ?? defaultAutoOpts();
  const r = autoBuild(BOARDS[prj.electronics.board], comps, o);
  const m = mergeRebuild(parts(), r, comps, o.battery);
  if (m.dropped.length) r.notes.unshift(`Removed ${m.dropped.join(', ')}: that hardware is no longer wired.`);
  commit('Auto Build', () => { S.built.parts = m.parts; S.built.notes = r.notes; S.prod!.model = S.built; S.sel.clear(); S.active = null; }, `Auto built ${r.parts.length} parts from ${comps.length} component${comps.length === 1 ? '' : 's'}${m.kept ? `, kept ${m.kept} of yours` : ''}`);
  V.frame(); S.infoTab = 'notes'; renderInfo(); $$('#infoTabs button').forEach(b => b.classList.toggle('on', b.dataset.i === 'notes'));
}
function setShading(s: Shading) { V.shading = s; V.refreshMaterials(); Ed.refresh(); renderHeader(); }
function toggleXray() { V.xray = !V.xray; V.refreshMaterials(); Ed.refresh(); renderHeader(); report(`X-Ray ${V.xray ? 'on' : 'off'}`); }
// ------------------------------------------------------------------ edit mode glue, join, convert, shading
function enterEditMode() { if (!S.active && S.sel.size === 1) S.active = [...S.sel][0]; if (Ed.enterEdit(S.active)) { S.sel = new Set([E.id]); S.active = E.id; updateSelViz(); renderMenus(); renderAll(); } }
function leaveEdit() { if (!E.on) return; Ed.exitEdit(); renderMenus(); }
function toggleEditMode() { if (E.on) { leaveEdit(); renderAll(); } else enterEditMode(); }
function convertToMesh() {
  const ps = selParts().filter(p => p.shape !== 'mesh'); if (!ps.length) return report('Select a primitive to convert', 'warn');
  commit('Convert to Mesh', () => ps.forEach(p => writeEMesh(p, toEMesh(p))), `Converted ${ps.length} object${ps.length > 1 ? 's' : ''} to mesh`);
}
function shadeSmooth(on: boolean) { if (!S.sel.size) return report('No objects selected', 'warn'); commit(on ? 'Shade Smooth' : 'Shade Flat', () => selParts().forEach(p => { p.smooth = on; })); }
function joinSel() {
  const act = part(S.active), others = selParts().filter(p => p.id !== act?.id);
  if (!act || !others.length) return report('Select the objects to join, then the one to join into last (active)', 'warn');
  const lostArrays = others.some(o => o.array && o.array.n > 1);
  commit('Join', () => {
    const ar = root(act.id)!; ar.updateMatrixWorld(true);
    const m = toEMesh(act);
    for (const o of others) {
      const r = root(o.id)!; r.updateMatrixWorld(true);
      const om = toEMesh(o);
      append(m, { ...om, v: om.v.map(q => { const l = ar.worldToLocal(new THREE.Vector3(...q).applyMatrix4(r.matrixWorld)); return [l.x, l.y, l.z] as V3; }) });
    }
    writeEMesh(act, m);
    const gone = new Set(others.map(o => o.id)); S.built.parts = parts().filter(p => !gone.has(p.id)); S.prod!.model = S.built;
    S.sel = new Set([act.id]); S.active = act.id;
  }, `Joined ${others.length + 1} objects into ${act.name}${lostArrays ? ' (array copies were not applied)' : ''}`);
}
const unitMesh = (kind: string): EMesh | null => {
  const k = ({ Plane: 'rect', Cube: 'box', Circle: 'disc', 'UV Sphere': 'sphere', Cylinder: 'cyl', Cone: 'cone', Torus: 'torus' } as Record<string, ShapeKind>)[kind];
  return k ? toEMesh({ shape: k, size: SHAPES[k], param: k === 'cone' ? 0 : undefined } as BuiltPart) : null;
};
function renderMenus() {
  $('#viewMenus').innerHTML = '';
  menubar($('#viewMenus'), E.on ? { View: viewMenus.View, Select: Ed.editSelectMenu, Add: Ed.editAddMenu, Mesh: Ed.meshMenu } : viewMenus);
  $('#modeDrop').textContent = (E.on ? 'Edit Mode' : 'Object Mode') + ' ▾';
  $('#selModes').style.display = E.on ? '' : 'none';
  $$('#selModes .hb').forEach(b => b.classList.toggle('on', b.dataset.sm === E.mode));
  document.body.classList.toggle('editmode', E.on);
}

function setTool(t: Tool) { S.tool = t; renderToolbar(); updateSelViz(); }
function toggleSidebar() { document.body.classList.toggle('sidebar'); renderSidebar(); }
function frameSel() { const rs = [...S.sel].map(root).filter(Boolean) as THREE.Object3D[]; V.frame(rs.length ? rs : undefined); }

function download(name: string, data: Blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); }
const fileStem = () => (S.project?.name ?? 'model').replace(/[^\w-]+/g, '-').toLowerCase();
async function exportGlb() {
  const g = S.prod!.mm.clone(true); g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.setScalar(0.001); // metres, Y up
  g.traverse((o: any) => { if (o.isMesh && o.material?.map) o.material = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 }); });
  const out = await new GLTFExporter().parseAsync(g, { binary: true });
  download(fileStem() + '.glb', new Blob([out as ArrayBuffer], { type: 'model/gltf-binary' })); report('Exported ' + fileStem() + '.glb', 'ok');
}
function exportStl() {
  V.world.updateMatrixWorld(true);
  const dv = new STLExporter().parse(V.world, { binary: true }) as unknown as DataView;
  download(fileStem() + '.stl', new Blob([dv.buffer as ArrayBuffer], { type: 'model/stl' })); report('Exported ' + fileStem() + '.stl (mm, Z up)', 'ok');
}
function studio() {
  if (window.opener && !window.opener.closed) { try { window.opener.focus(); return; } catch { } }
  window.open(`${import.meta.env.BASE_URL}index.html?project=${encodeURIComponent(S.id)}`, 'formframe-studio');
}

// ------------------------------------------------------------------ menus
const addMenu = (): MenuItem[] => [
  { label: 'Mesh', icon: 'mesh', sub: [
    { label: 'Plane', icon: 'mesh', action: () => addShape('rect') }, { label: 'Cube', icon: 'mesh', action: () => addShape('box') },
    { label: 'Rounded Cube', icon: 'mesh', action: () => addShape('rbox') }, { label: 'Circle', icon: 'mesh', action: () => addShape('disc') },
    { label: 'UV Sphere', icon: 'mesh', action: () => addShape('sphere') }, { label: 'Cylinder', icon: 'mesh', action: () => addShape('cyl') },
    { label: 'Cone', icon: 'mesh', action: () => addShape('cone') }, { label: 'Torus', icon: 'mesh', action: () => addShape('torus') },
    { label: 'Tube', icon: 'mesh', action: () => addShape('tube') },
  ] },
  { label: 'Product Part', icon: 'object', sub: Object.entries(PRESETS).map(([, p]) => ({ label: p.name, icon: 'object', action: () => addPart(p) })) },
  { sep: true },
  { label: 'Auto Build from Electronics', icon: 'auto', action: runAutoBuild, hint: 'Lay out an enclosure around the board and parts wired in the studio' },
];
const snapItems = (): MenuItem[] => [
  { label: 'Selection to Cursor', action: () => snapOp('selCursor') }, { label: 'Selection to Active', action: () => snapOp('selActive') }, { label: 'Selection to Grid', action: () => snapOp('selGrid') },
  { sep: true }, { label: 'Cursor to Selected', action: () => snapOp('cursorSel') }, { label: 'Cursor to Active', action: () => snapOp('cursorActive') }, { label: 'Cursor to World Origin', action: () => snapOp('cursorOrigin') },
];
const roleItems = (): MenuItem[] => (Object.keys(ROLES) as BindRole[]).map(r => ({ label: ROLES[r], checked: S.active ? part(S.active)?.role === r : false, action: () => setRole(r) }));
const collItems = (): MenuItem[] => Object.entries(COLL).map(([k, c]) => ({ label: c.name, icon: 'collection', action: () => moveTo(k) }));
const viewItems = (): MenuItem[] => [
  { label: 'Front', shortcut: 'Numpad 1', action: () => V.setView('front') }, { label: 'Back', shortcut: 'Ctrl Numpad 1', action: () => V.setView('back') },
  { label: 'Right', shortcut: 'Numpad 3', action: () => V.setView('right') }, { label: 'Left', shortcut: 'Ctrl Numpad 3', action: () => V.setView('left') },
  { label: 'Top', shortcut: 'Numpad 7', action: () => V.setView('top') }, { label: 'Bottom', shortcut: 'Ctrl Numpad 7', action: () => V.setView('bottom') },
];
const objectMenu = (): MenuItem[] => [
  { label: 'Transform', sub: [{ label: 'Move', shortcut: 'G', action: () => startModal('G') }, { label: 'Rotate', shortcut: 'R', action: () => startModal('R') }, { label: 'Scale', shortcut: 'S', action: () => startModal('S') }] },
  { label: 'Snap', sub: snapItems },
  { sep: true },
  { label: 'Duplicate Objects', shortcut: 'Shift D', action: duplicate }, { label: 'Mirror X', action: mirrorX },
  { label: 'Join', shortcut: 'Ctrl J', action: joinSel },
  { label: 'Rename Active Item', shortcut: 'F2', action: () => rename() },
  { sep: true },
  { label: 'Shade Smooth', action: () => shadeSmooth(true) }, { label: 'Shade Flat', action: () => shadeSmooth(false) },
  { label: 'Convert to Mesh', action: convertToMesh }, { label: 'Edit Mode', shortcut: 'Tab', action: enterEditMode },
  { sep: true },
  { label: 'Set Role', sub: roleItems }, { label: 'Move to Collection', shortcut: 'M', sub: collItems },
  { sep: true },
  { label: 'Auto Build from Electronics', icon: 'auto', action: runAutoBuild },
  { sep: true },
  { label: 'Show/Hide', sub: [{ label: 'Hide Selected', shortcut: 'H', action: () => hideSel() }, { label: 'Hide Unselected', shortcut: 'Shift H', action: () => hideSel(true) }, { label: 'Reveal Hidden Objects', shortcut: 'Alt H', action: reveal }] },
  { sep: true },
  { label: 'Delete', shortcut: 'X', action: deleteSel },
];
const operators = (): { label: string; shortcut?: string; action: () => void }[] => {
  const flat: { label: string; shortcut?: string; action: () => void }[] = [];
  const walk = (items: MenuItem[], pre: string) => items.forEach(i => { if (i.sep || i.title) return; const sub = typeof i.sub === 'function' ? i.sub() : i.sub; if (sub) walk(sub, `${pre}${i.label} ▸ `); else if (i.action && !i.disabled) flat.push({ label: pre + i.label, shortcut: i.shortcut, action: i.action }); });
  walk(topMenus.File(), 'File ▸ '); walk(topMenus.Edit(), 'Edit ▸ '); walk(viewMenus.View(), 'View ▸ '); walk(viewMenus.Select(), 'Select ▸ '); walk(addMenu(), 'Add ▸ '); walk(objectMenu(), 'Object ▸ ');
  return flat;
};
const topMenus: Record<string, () => MenuItem[]> = {
  File: () => [
    { label: 'Open…', shortcut: 'Ctrl O', action: openPicker }, { label: 'Save', shortcut: 'Ctrl S', action: () => { save(); report('Saved', 'ok'); } },
    { label: 'Revert', action: () => { if (confirm('Reload the model from the last save?')) location.reload(); } },
    { sep: true },
    { label: 'Export', sub: [{ label: 'glTF 2.0 (.glb)', action: exportGlb }, { label: 'STL (.stl)', action: exportStl }] },
    { sep: true },
    { label: 'Open in Blender (live link)', action: () => { post({ type: 'blender-open', id: S.id }); report('Asked the studio window to open Blender. Keep the studio open while linked.'); } },
    { label: 'Switch to Studio', icon: 'logo', action: studio },
  ],
  Edit: () => [
    { label: 'Undo', shortcut: 'Ctrl Z', action: undo, disabled: !S.undo.length }, { label: 'Redo', shortcut: 'Shift Ctrl Z', action: redo, disabled: !S.redo.length },
    { label: 'Undo History', sub: () => S.undo.length ? S.undo.map((u, i) => ({ label: u.name, action: () => { while (S.undo.length > i) undo(); } })).reverse() : [{ label: 'Nothing yet', disabled: true }] },
    { sep: true },
    { label: 'Menu Search', shortcut: 'F3', action: () => search() }, { label: 'Rename Active Item', shortcut: 'F2', action: () => rename() },
  ],
  Render: () => [{ label: 'Render Image', shortcut: 'F12', action: renderImage }],
  Window: () => [
    { label: 'Toggle Maximize Area', shortcut: 'Ctrl Space', action: () => { document.body.classList.toggle('maxview'); } },
    { label: 'Toggle Window Fullscreen', action: () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); } },
    { sep: true }, ...(['layout', 'modeling', 'shading'] as const).map(w => ({ label: w[0].toUpperCase() + w.slice(1), checked: document.body.classList.contains('ws-' + w), action: () => setWorkspace(w) })),
  ],
  Help: () => [{ label: 'Keyboard Shortcuts', action: shortcutsHelp }, { label: 'About Formframe Modeler', action: () => report('Formframe Modeler: a Blender-style editor for Formframe built models. Changes sync live with the studio window.') }],
};
const viewMenus: Record<string, () => MenuItem[]> = {
  View: () => [
    { label: 'Sidebar', shortcut: 'N', checked: document.body.classList.contains('sidebar'), action: toggleSidebar },
    { label: 'Toolbar', shortcut: 'T', checked: !document.body.classList.contains('no-toolbar'), action: () => document.body.classList.toggle('no-toolbar') },
    { sep: true },
    { label: 'Frame Selected', shortcut: 'Numpad .', action: frameSel }, { label: 'Frame All', shortcut: 'Home', action: () => V.frame() },
    { sep: true },
    { label: 'Perspective/Orthographic', shortcut: 'Numpad 5', action: () => V.setOrtho(!V.isOrtho) }, { label: 'Viewpoint', sub: viewItems },
    { sep: true },
    { label: 'Emulate Numpad (number row)', checked: S.emuNumpad, action: () => { S.emuNumpad = !S.emuNumpad; prefs(); } },
    { label: 'Trackpad: two-finger scroll orbits', checked: S.trackpadOrbit, action: () => { S.trackpadOrbit = !S.trackpadOrbit; prefs(); } },
  ],
  Select: () => [
    { label: 'All', shortcut: 'A', action: selectAll }, { label: 'None', shortcut: 'Alt A', action: () => setSel([]) }, { label: 'Invert', shortcut: 'Ctrl I', action: invertSel },
    { sep: true }, { label: 'Box Select', shortcut: 'B', action: () => setTool('select') },
    { sep: true },
    { label: 'Select All by Role', sub: (Object.keys(ROLES) as BindRole[]).map(r => ({ label: ROLES[r], action: () => setSel(parts().filter(p => p.role === r).map(p => p.id)) })) },
    { label: 'Select Collection', sub: Object.entries(COLL).map(([k, c]) => ({ label: c.name, action: () => setSel(parts().filter(p => collOf(p) === k).map(p => p.id)) })) },
    { label: 'Select Auto-built', action: () => setSel(parts().filter(p => p.auto).map(p => p.id)) },
  ],
  Add: addMenu,
  Object: objectMenu,
};
function contextMenu(x: number, y: number) {
  popup([
    { label: 'Duplicate Objects', shortcut: 'Shift D', action: duplicate }, { label: 'Mirror X', action: mirrorX }, { label: 'Rename', shortcut: 'F2', action: () => rename() },
    { sep: true }, { label: 'Set Role', sub: roleItems }, { label: 'Move to Collection', sub: collItems }, { label: 'Snap', sub: snapItems },
    { sep: true }, { label: 'Hide', shortcut: 'H', action: () => hideSel() }, { label: 'Delete', shortcut: 'X', action: deleteSel },
  ], x, y, 'Object Context Menu');
}
function rename(id = S.active) {
  const p = part(id); if (!p) return report('No active object', 'warn');
  const box = h('div', 'popin', `<div class="t">Rename Active Object</div>`); const inp = btext(p.name, () => {});
  box.appendChild(inp); $('#menuLayer').appendChild(box);
  box.style.left = Math.min(S.mouse.x, innerWidth - 270) + 'px'; box.style.top = Math.min(S.mouse.y, innerHeight - 60) + 'px';
  inp.focus(); inp.select();
  const done = (ok: boolean) => { box.remove(); if (ok && inp.value.trim() && inp.value !== p.name) { const v = inp.value.trim(); commit('Rename', () => { p.name = v; }, `Renamed to ${v}`); } };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
}
function search() {
  const ops = operators();
  const box = h('div', 'popin', `<div class="t">Menu Search</div>`); box.style.width = '360px';
  const inp = btext('', () => {}, 'Search…'); const list = h('div'); box.append(inp, list);
  $('#menuLayer').appendChild(box); box.style.left = (innerWidth - 360) / 2 + 'px'; box.style.top = '80px';
  let hits = ops;
  const draw = () => {
    const q = inp.value.toLowerCase().trim(); hits = ops.filter(o => o.label.toLowerCase().includes(q)).slice(0, 14);
    list.innerHTML = hits.map((o, i) => `<div class="mi${i === 0 ? ' subopen' : ''}" data-i="${i}"><span class="ml">${esc(o.label)}</span><span class="ms">${esc(o.shortcut ? kc(o.shortcut) : '')}</span></div>`).join('');
    $$('.mi', list).forEach(r => (r.onpointerdown = e => { e.preventDefault(); const o = hits[+r.dataset.i!]; box.remove(); o.action(); }));
  };
  draw(); inp.focus();
  inp.oninput = draw;
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape') box.remove(); if (e.key === 'Enter' && hits[0]) { box.remove(); hits[0].action(); } };
  inp.onblur = () => setTimeout(() => box.remove(), 100);
}
function renderImage() { const url = V.snapshot(); fetch(url).then(r => r.blob()).then(b => download(fileStem() + '.png', b)); report('Rendered ' + fileStem() + '.png', 'ok'); }
function shortcutsHelp() {
  const rows: [string, string][] = [['G / R / S', 'Move / rotate / scale, then X Y Z to lock an axis (twice = local), Shift+axis to lock a plane, type a number, Enter or click to confirm, Esc or right-click to cancel'], ['Shift A', 'Add menu'], ['Shift D', 'Duplicate and move'], ['X / Delete', 'Delete'], ['A / Alt A / Ctrl I', 'Select all / none / invert'], ['Shift click', 'Add to selection'], ['Drag', 'Box select'], ['H / Shift H / Alt H', 'Hide / hide others / reveal'], ['M', 'Move to collection'], ['F2 / F3', 'Rename / menu search'], ['Middle drag', 'Orbit (Shift: pan, Ctrl: zoom). Alt+left drag also orbits'], ['Wheel / trackpad', 'Zoom. Two-finger scroll orbits, Shift pans, pinch zooms'], ['Numpad 1 3 7 (Ctrl: opposite)', 'Front, right, top views. Number row works too while Emulate Numpad is on'], ['Numpad 5', 'Perspective / orthographic'], ['Home / Numpad .', 'Frame all / selected'], ['Z / Shift S / `', 'Shading, snap and view pies'], ['Shift right-click', 'Place the 3D cursor'], ['N / T', 'Sidebar / toolbar'], ['Alt Z', 'X-ray'], ['Ctrl Z / Shift Ctrl Z', 'Undo / redo'], ['Ctrl Space', 'Maximize the viewport'], ['Tab', 'Edit Mode: 1/2/3 vertex/edge/face, E extrude, I inset, Ctrl R loop cut, F fill, M merge, X delete, P separate, L / Ctrl L linked, Shift N normals'], ['Ctrl J', 'Join selected objects into the active one']];
  popup([{ title: 'Keyboard shortcuts' }, ...rows.map(([k, d]) => ({ label: d, shortcut: k, action: () => {} }))], innerWidth / 2 - 260, 60);
}
function setWorkspace(w: 'layout' | 'modeling' | 'shading') {
  document.body.classList.remove('ws-layout', 'ws-modeling', 'ws-shading'); document.body.classList.add('ws-' + w);
  $$('#workspaces button').forEach(b => b.classList.toggle('on', b.dataset.ws === w));
  if (w === 'shading') { setShading('material'); S.ptab = 'material'; renderProps(); }
  if (w === 'modeling') { document.body.classList.add('sidebar'); setShading('solid'); renderSidebar(); }
  if (w === 'layout') setShading('solid');
  V.resize();
}
function prefs() { try { localStorage.setItem('ffm.prefs', JSON.stringify({ emu: S.emuNumpad, tp: S.trackpadOrbit, snap: S.snap, sm: S.snapMove, sr: S.snapRot })); } catch { } }

// ------------------------------------------------------------------ redo ("Adjust Last Operation")
function showRedo(name: string, id: string) {
  S.redoOp = { name, id };
  const p = part(id), el = $('#redo'); if (!p) return;
  el.innerHTML = ''; el.classList.add('show');
  el.appendChild(panel('redo', name, b => {
    const live = (fn: () => void) => (v: number, final: boolean) => { fn.call(null); void v; rebuild3D(); refreshFields(); if (final) { scheduleSave(); renderAll(false); } };
    b.appendChild(bvec('Size', [0, 1, 2].map(k => ({ label: 'XYZ'[k], unit: 'mm', step: 0.5, min: 0.05, get: () => dimsB(p.size)[k], set: (v: number, f: boolean) => { const d = dimsB(p.size); d[k] = v; p.size = dimsFromB(d); live(() => {})(v, f); } }))));
    b.appendChild(bvec('Location', [0, 1, 2].map(k => ({ label: 'XYZ'[k], unit: 'mm', step: 0.5, get: () => toB(p.pos)[k], set: (v: number, f: boolean) => { const l = toB(p.pos); l[k] = v; p.pos = fromB(l); live(() => {})(v, f); } }))));
  }));
}

// ------------------------------------------------------------------ rendering: header, toolbar, outliner, props, sidebar, info, status
function renderAll(full = true) {
  renderOutliner(); renderProps(); renderSidebar(); renderInfo(); renderStatus(); renderVText();
  if (full) renderHeader();
  if (S.redoOp && !part(S.redoOp.id)) { S.redoOp = null; $('#redo').classList.remove('show'); }
}
function renderTitle() {
  const n = S.project?.name ?? 'Untitled';
  $('#projName').textContent = n; document.title = `${n} — Formframe Modeler`;
}
function renderHeader() {
  $$('#shadeBtns .hb').forEach(b => b.classList.toggle('on', b.dataset.sh === V.shading));
  $('#bXray').classList.toggle('on', V.xray); $('#bOverlay').classList.toggle('on', V.overlays); $('#bSnap').classList.toggle('on', S.snap);
}
const TOOLS: [Tool, string, string, string][] = [['select', 'select', 'Select Box', 'W'], ['cursor', 'cursor', 'Cursor', ''], ['move', 'move', 'Move', 'G'], ['rotate', 'rotate', 'Rotate', 'R'], ['scale', 'scale', 'Scale', 'S'], ['transform', 'transform', 'Transform', '']];
function renderToolbar() {
  const t = $('#toolbar'); t.innerHTML = '';
  TOOLS.forEach(([k, ic, name, sc], i) => {
    if (i === 2) t.appendChild(h('hr'));
    const b = h('button', 'tool' + (S.tool === k ? ' on' : ''), ICON[ic]); b.title = `${name}${sc ? ` (${sc})` : ''}`;
    b.onclick = () => setTool(k); t.appendChild(b);
  });
  t.appendChild(h('hr'));
  const add = h('button', 'tool', ICON.mesh); add.title = 'Add (Shift A)'; add.onclick = e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); popup(addMenu(), r.right + 30, r.top + 14, 'Add'); }; t.appendChild(add);
  const ab = h('button', 'tool', ICON.auto); ab.title = 'Auto Build from Electronics'; ab.onclick = runAutoBuild; t.appendChild(ab);
}
function renderVText() {
  $('#vName').textContent = V.viewLabel();
  const a = part(S.active);
  $('#vSub').textContent = `(1) Scene Collection${a ? ` | ${a.name}` : ''}`;
}

function renderOutliner() {
  const o = $('#outliner'); o.innerHTML = '';
  const q = S.outFilter.toLowerCase();
  const row = (indent: number, html: string, cls = '') => { const r = h('div', 'orow ' + cls, html); r.style.paddingLeft = 4 + indent * 14 + 'px'; o.appendChild(r); return r; };
  const top = row(0, `<span class="exp"></span>${ICON.collection}<span class="on">Scene Collection</span>`);
  top.onclick = () => setSel([]);
  for (const [k, c] of Object.entries(COLL)) {
    const ps = parts().filter(p => collOf(p) === k && (!q || p.name.toLowerCase().includes(q)));
    if (!ps.length && k !== 'ext' && !parts().some(p => collOf(p) === k)) continue;
    const shut = S.collapsed.has(k), allHidden = ps.length > 0 && ps.every(p => S.hidden.has(p.id));
    const r = row(1, `<span class="exp">${shut ? '▸' : '▾'}</span>${ICON.collection}<span class="on">${c.name}</span><span class="hdim">${ps.length}</span><span class="oi"><button data-x="eye" title="Hide in viewport">${allHidden ? ICON.eyeOff : ICON.eye}</button></span>`);
    r.onclick = e => {
      const x = (e.target as HTMLElement).closest('[data-x]');
      if (x) { ps.forEach(p => allHidden ? S.hidden.delete(p.id) : S.hidden.add(p.id)); rebuild3D(); renderAll(false); return; }
      if ((e.target as HTMLElement).closest('.exp')) { shut ? S.collapsed.delete(k) : S.collapsed.add(k); renderOutliner(); return; }
      setSel(ps.map(p => p.id));
    };
    r.ondragover = e => { e.preventDefault(); r.classList.add('drop'); };
    r.ondragleave = () => r.classList.remove('drop');
    r.ondrop = e => { e.preventDefault(); r.classList.remove('drop'); const id = e.dataTransfer?.getData('text/plain'); if (id) { if (!S.sel.has(id)) S.sel = new Set([id]); moveTo(k); } };
    if (shut) continue;
    for (const p of ps) {
      const hid = S.hidden.has(p.id);
      const pr = row(2, `<span class="exp"></span>${ICON.mesh}<span class="on${hid ? ' dim' : ''}">${esc(p.name)}</span>${p.array && p.array.n > 1 ? `<span title="Array ×${p.array.n}" style="color:#6aa2ff">${ICON.wrench}</span>` : ''}${p.role !== 'body' ? `<span class="rb">${p.role}</span>` : ''}<span class="oi"><button data-x="eye" title="Hide in viewport (H)">${hid ? ICON.eyeOff : ICON.eye}</button></span>`, (S.sel.has(p.id) ? 'sel' : '') + (S.active === p.id ? ' act' : ''));
      pr.draggable = true;
      pr.ondragstart = e => e.dataTransfer?.setData('text/plain', p.id);
      pr.onclick = e => {
        if ((e.target as HTMLElement).closest('[data-x]')) { hid ? S.hidden.delete(p.id) : S.hidden.add(p.id); if (!hid) S.sel.delete(p.id); rebuild3D(); renderAll(false); return; }
        if (e.shiftKey || e.ctrlKey || e.metaKey) { if (S.sel.has(p.id) && S.active === p.id) { S.sel.delete(p.id); S.active = null; } else { S.sel.add(p.id); S.active = p.id; } setSel([...S.sel], S.active); }
        else setSel([p.id]);
      };
      pr.ondblclick = e => {
        if ((e.target as HTMLElement).closest('[data-x]')) return;
        const nm = $('.on', pr), inp = h('input', 'ren') as HTMLInputElement; inp.value = p.name; nm.replaceWith(inp); inp.focus(); inp.select();
        const done = (ok: boolean) => { if (!inp.isConnected) return; const v = inp.value.trim(); if (ok && v && v !== p.name) commit('Rename', () => { p.name = v; }, `Renamed to ${v}`); else renderOutliner(); };
        inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
        inp.onblur = () => done(true);
      };
      if (S.active === p.id) requestAnimationFrame(() => { const rr = pr.getBoundingClientRect(), orr = o.getBoundingClientRect(); if (rr.top < orr.top || rr.bottom > orr.bottom) pr.scrollIntoView({ block: 'nearest' }); });
    }
  }
}

/** Number-field options that edit the active part live, as one undo step per drag. */
function pf(name: string, get: () => number, set: (v: number) => void, o: Partial<NumOpts> = {}): NumOpts {
  return { ...o, get, set: (v, final) => {
    if (!S.fieldEdit) { pushUndo(name); S.fieldEdit = true; }
    set(v); rebuild3D(); refreshFields();
    if (final) { S.fieldEdit = false; scheduleSave(); renderAll(false); }
  } };
}
function transformFields(p: BuiltPart, b: HTMLElement, dims = true) {
  b.appendChild(bvec('Location', [0, 1, 2].map(k => pf('Location', () => toB(p.pos)[k], v => { const l = toB(p.pos); l[k] = v; p.pos = fromB(l); }, { label: 'XYZ'[k], unit: 'mm', step: 0.5 }))));
  b.appendChild(bvec('Rotation', [0, 1, 2].map(k => pf('Rotation', () => rotToB(p.rot)[k], v => { const r = rotToB(p.rot); r[k] = v; p.rot = rotFromB(r); }, { label: 'XYZ'[k], unit: '°', step: 1, dragScale: 0.5 }))));
  const sc: V3 = [1, 1, 1];
  b.appendChild(bvec('Scale', [0, 1, 2].map(k => pf('Scale', () => sc[k], v => { const f = v / (sc[k] || 1); sc[k] = v; const d = dimsB(p.size); d[k] = Math.max(0.05, d[k] * f); p.size = dimsFromB(d); if (k === 0 && p.shape === 'tube' && p.param) p.param *= f; }, { label: 'XYZ'[k], step: 0.01, prec: 3, min: 0.001, dragScale: 0.1 }))));
  if (dims) b.appendChild(bvec('Dimensions', [0, 1, 2].map(k => pf('Dimensions', () => dimsB(p.size)[k], v => { const d = dimsB(p.size); d[k] = Math.max(0.05, v); p.size = dimsFromB(d); }, { label: 'XYZ'[k], unit: 'mm', step: 0.5, min: 0.05 }))));
}

const PTABS: [string, string, string][] = [['scene', 'scene', 'Scene'], ['object', 'object', 'Object'], ['modifiers', 'modifier', 'Modifiers'], ['data', 'data', 'Data'], ['material', 'material', 'Material']];
function renderProps() {
  const tabs = $('#ptabs'); tabs.innerHTML = '';
  PTABS.forEach(([k, ic, name], i) => {
    if (i === 1) tabs.appendChild(h('hr'));
    const b = h('button', S.ptab === k ? 'on' : '', ICON[ic]); b.title = name; b.onclick = () => { S.ptab = k; renderProps(); }; tabs.appendChild(b);
  });
  const c = $('#pcontent'); c.innerHTML = '';
  const p = part(S.active);
  $('#propsTitle').textContent = PTABS.find(t => t[0] === S.ptab)![2];
  if (S.ptab === 'scene') return sceneTab(c);
  if (!p) { c.appendChild(h('div', 'bnote', 'No active object. Click an object in the viewport or the outliner.')); return; }
  c.appendChild(h('div', 'pcrumb', `${ICON.mesh}<span>${esc(p.name)}</span>`));
  if (S.ptab === 'object') {
    c.appendChild(brow('Name', btext(p.name, v => v.trim() && commit('Rename', () => { p.name = v.trim(); }))));
    c.appendChild(panel('obj.tf', 'Transform', b => { transformFields(p, b, false); b.appendChild(brow('Mode', '<span class="hdim">XYZ Euler</span>')); }));
    c.appendChild(panel('obj.ff', 'Formframe', b => {
      b.appendChild(brow('Role', bselect(ROLES as any, p.role, v => commit('Set Role', () => { p.role = v as BindRole; }))));
      b.appendChild(brow('Collection', bselect(Object.fromEntries(Object.entries(COLL).map(([k, v]) => [k, v.name])), collOf(p), v => commit('Move to Collection', () => { p.kind = COLL[v].kind; }))));
      b.appendChild(brow('Explode Step', bnum(pf('Explode Step', () => p.layer ?? 0, v => { p.layer = Math.round(v); }, { step: 1, prec: 0, dragScale: 0.05 }))));
      if (p.auto) b.appendChild(bcheck('Keep when rebuilding', false, v => commit('Keep Part', () => { p.auto = !v; })));
      const comp = p.comp === 'board' ? BOARDS[S.project!.electronics.board]?.name : p.comp === 'battery' ? 'Battery' : S.project?.electronics.comps.find(x => x.uid === p.comp);
      if (comp) b.appendChild(brow('Electronics', `<span class="hdim">${esc(typeof comp === 'string' ? comp : COMPONENTS[comp.type]?.name ?? comp.type)}</span>`));
      b.appendChild(h('div', 'bnote', 'Roles connect parts to the electronics: the Dial turns the encoder, the Screen shows the firmware’s display, Press presses a button, LED lights up.'));
    }));
    c.appendChild(panel('obj.vis', 'Visibility', b => b.appendChild(bcheck('Show in Viewport', !S.hidden.has(p.id), v => { v ? S.hidden.delete(p.id) : S.hidden.add(p.id); rebuild3D(); renderAll(false); }))));
  } else if (S.ptab === 'modifiers') {
    const add = h('button', 'bbtn', `${ICON.wrench}<span>Add Modifier ▾</span>`);
    add.onclick = e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); popup([{ title: 'Generate' }, { label: 'Array', icon: 'modifier', disabled: !!p.array, action: () => commit('Add Modifier', () => { p.array = { n: 3, mode: 'linear', step: [Math.max(5, p.size[0] + 2), 0, 0], center: [0, 0] }; }) }], r.left + 20, r.bottom + 14); };
    c.appendChild(add);
    if (p.array) {
      const a = p.array, mod = panel('mod.array', 'Array', b => {
        b.appendChild(brow('Fit Type', '<span class="hdim">Fixed Count</span>'));
        b.appendChild(brow('Count', bnum(pf('Array Count', () => a.n, v => { a.n = Math.max(1, Math.round(v)); }, { step: 1, prec: 0, min: 1, max: 500, dragScale: 0.1 }))));
        b.appendChild(brow('Mode', bselect({ linear: 'Constant Offset', radial: 'Radial (around Y)' }, a.mode, v => commit('Array Mode', () => { a.mode = v as any; }))));
        if (a.mode === 'linear') b.appendChild(bvec('Distance', [0, 1, 2].map(k => pf('Array Offset', () => toB(a.step ?? [10, 0, 0])[k], v => { const s = toB(a.step ?? [10, 0, 0]); s[k] = v; a.step = fromB(s); }, { label: 'XYZ'[k], unit: 'mm', step: 0.5 }))));
        else b.appendChild(bvec('Centre', [0, 1].map(k => pf('Array Centre', () => (a.center ?? [0, 0])[k], v => { const c2 = [...(a.center ?? [0, 0])] as [number, number]; c2[k] = v; a.center = c2; }, { label: k ? 'Z' : 'X', unit: 'mm', step: 0.5 }))));
      }, `<button class="hb" title="Remove modifier" data-x="rm">${ICON.x}</button>`);
      mod.classList.add('mod');
      ($('[data-x=rm]', mod) as HTMLElement).onclick = () => commit('Remove Modifier', () => { p.array = undefined; });
      c.appendChild(mod);
    } else c.appendChild(h('div', 'bnote', 'Add an Array modifier to repeat this object in a line or around a centre (grilles, ribs, vents).'));
  } else if (S.ptab === 'data') {
    c.appendChild(panel('data.prim', 'Primitive', b => {
      b.appendChild(brow('Type', bselect(SHAPE_NAMES as any, p.shape, v => {
        if (v === 'mesh') return commit('Convert to Mesh', () => writeEMesh(p, toEMesh(p)));
        if (p.shape === 'mesh' && !confirm('Replace the edited mesh with a primitive? Its vertices are discarded (Ctrl Z brings them back).')) return renderProps();
        commit('Change Primitive', () => { p.shape = v as ShapeKind; p.mesh = undefined; if (v === 'rbox') p.param ??= 3; if (v === 'tube') p.param = p.size[0] * 0.75; });
      })));
      if (p.shape === 'mesh' && p.mesh) b.appendChild(brow('Mesh', `<span class="hdim">${p.mesh.v.length / 3} vertices · ${p.mesh.f.length} faces</span>`));
      b.appendChild(bcheck('Shade Smooth', !!p.smooth, v => commit(v ? 'Shade Smooth' : 'Shade Flat', () => { p.smooth = v; })));
      const eb = h('button', 'bbtn', `${ICON.mesh}<span>${E.on && E.id === p.id ? 'Back to Object Mode' : 'Edit Mode'} (Tab)</span>`); eb.style.margin = '4px 0'; eb.onclick = toggleEditMode; b.appendChild(eb);
      b.appendChild(bvec('Dimensions', [0, 1, 2].map(k => pf('Dimensions', () => dimsB(p.size)[k], v => { const d = dimsB(p.size); d[k] = Math.max(0.05, v); p.size = dimsFromB(d); }, { label: 'XYZ'[k], unit: 'mm', step: 0.5, min: 0.05 }))));
      const pm = PARAM[p.shape];
      if (pm) b.appendChild(brow(pm[0], bnum(pf(pm[0], () => p.param ?? 0, v => { p.param = v; }, { step: pm[3], min: pm[1], max: pm[2], unit: pm[4] }))));
      if (p.role === 'led' && (p.shape === 'tube' || p.shape === 'torus')) b.appendChild(brow('LED Segments', bnum(pf('LED Segments', () => p.segments ?? 1, v => { p.segments = Math.max(1, Math.round(v)); }, { step: 1, prec: 0, min: 1, max: 256, dragScale: 0.1 }))));
      b.appendChild(h('div', 'bnote', 'Primitives keep their parameters (corner radius, inner diameter…). Edit Mode turns a part into an editable mesh.'));
    }));
  } else if (S.ptab === 'material') {
    c.appendChild(panel('mat.slot', 'Material Slots', b => b.appendChild(h('div', 'orow sel act', `<span class="exp"></span>${ICON.material}<span class="on">${esc(FIN[p.finish] ?? p.finish)} · ${p.color.toUpperCase()}</span>`))));
    c.appendChild(panel('mat.surf', 'Surface', b => {
      const col = h('input', 'bcolor') as HTMLInputElement; col.type = 'color'; col.value = p.color;
      col.oninput = () => { if (!S.fieldEdit) { pushUndo('Base Color'); S.fieldEdit = true; } p.color = col.value; rebuild3D(); };
      col.onchange = () => { S.fieldEdit = false; scheduleSave(); renderAll(false); };
      b.appendChild(brow('Base Color', col));
      b.appendChild(brow('Finish', bselect(FIN, p.finish, v => commit('Finish', () => { p.finish = v; }))));
      b.appendChild(h('div', 'bnote', 'Shown in Material Preview and Rendered shading (Z). Solid shading shows the base colour only.'));
    }));
  }
}
function sceneTab(c: HTMLElement) {
  const prj = S.project, m = S.built, o = m.auto ?? (m.auto = defaultAutoOpts());
  c.appendChild(h('div', 'pcrumb', `${ICON.scene}<span>Scene</span>`));
  c.appendChild(panel('sc.proj', 'Project', b => {
    b.appendChild(brow('Name', `<span>${esc(prj?.name ?? '')}</span>`));
    b.appendChild(brow('Board', `<span>${esc(prj ? BOARDS[prj.electronics.board]?.name ?? prj.electronics.board : '')}</span>`));
    b.appendChild(brow('Units', '<span class="hdim">Millimetres</span>'));
    const bb = bounds(m.parts); b.appendChild(brow('Size', `<span class="hdim">${bb ? dimsB(bb.size).map(v => Math.round(v)).join(' × ') + ' mm' : '—'}</span>`));
    b.appendChild(bcheck('Fade enclosure in the studio (X-ray)', m.xray, v => commit('X-ray', () => { m.xray = v; })));
  }));
  c.appendChild(panel('sc.elec', `Electronics (${prj?.electronics.comps.length ?? 0})`, b => {
    const comps = prj?.electronics.comps ?? [];
    if (!comps.length) b.appendChild(h('div', 'bnote', 'Nothing wired yet. Add parts in the studio’s Electronics mode; they show up here.'));
    comps.forEach(x => b.appendChild(h('div', 'orow', `<span class="exp"></span><span class="sw" style="width:10px;height:10px;border-radius:2px;background:${x.color};flex:none"></span><span class="on">${esc(COMPONENTS[x.type]?.name ?? x.type)}</span>${COMPONENTS[x.type]?.binds ? `<span class="rb">${COMPONENTS[x.type].binds}</span>` : ''}`)));
  }));
  c.appendChild(panel('sc.auto', 'Auto Build', b => {
    b.appendChild(brow('Shape', bselect({ auto: 'Auto', round: 'Round', rect: 'Rectangular' }, o.style, v => { o.style = v as any; scheduleSave(); })));
    b.appendChild(brow('Wall', bnum({ get: () => o.wall, set: (v, f) => { o.wall = v; if (f) scheduleSave(); }, step: 0.2, min: 0.8, max: 6, unit: 'mm' })));
    b.appendChild(brow('Gap', bnum({ get: () => o.clearance, set: (v, f) => { o.clearance = v; if (f) scheduleSave(); }, step: 0.5, min: 0, max: 5, unit: 'mm' })));
    b.appendChild(brow('Mount', bselect({ wall: 'Wall plate', desk: 'Desk (feet / stand)', none: 'None' }, o.mount, v => { o.mount = v as any; scheduleSave(); })));
    b.appendChild(bcheck('LiPo battery', o.battery, v => { o.battery = v; scheduleSave(); }));
    const btn = h('button', 'bbtn prim', `${ICON.auto}<span>${m.parts.some(p => p.auto) ? 'Rebuild' : 'Auto Build'} from Electronics</span>`); btn.style.marginTop = '6px'; btn.onclick = runAutoBuild;
    b.appendChild(btn);
    b.appendChild(h('div', 'bnote', 'Replaces auto-built parts and keeps the ones you made. Decisions are listed in the Info editor under Build Notes.'));
  }));
}
function renderSidebar() {
  if (!document.body.classList.contains('sidebar')) return;
  $$('#sbTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === S.sbtab));
  const c = $('#sbBody'); c.innerHTML = '';
  if (S.sbtab === 'item' && E.on) {
    const md = Ed.median();
    if (!md) { c.appendChild(h('div', 'bnote', 'Nothing selected')); return; }
    c.appendChild(panel('sb.median', `Transform · ${E.sel.size === 1 ? 'Vertex' : 'Median'}`, b => b.appendChild(bvec(E.sel.size === 1 ? 'Vertex' : 'Median', [0, 1, 2].map(k => ({ label: 'XYZ'[k], unit: 'mm', step: 0.5, get: () => Ed.median()?.getComponent(k) ?? 0, set: (v: number, f: boolean) => { if (!S.fieldEdit) { pushUndo('Move'); S.fieldEdit = true; } Ed.setMedian(k, v, f); if (f) { S.fieldEdit = false; scheduleSave(); renderStatus(); } } }))))));
    c.appendChild(h('div', 'bnote', 'Global coordinates. Drag a field or type a value to move the selection.'));
    return;
  }
  if (S.sbtab === 'item') {
    const p = part(S.active);
    if (!p) { c.appendChild(h('div', 'bnote', 'No active object')); return; }
    c.appendChild(panel('sb.tf', 'Transform', b => transformFields(p, b)));
    c.appendChild(panel('sb.info', 'Formframe', b => { b.appendChild(brow('Name', btext(p.name, v => v.trim() && commit('Rename', () => { p.name = v.trim(); })))); b.appendChild(brow('Role', bselect(ROLES as any, p.role, v => commit('Set Role', () => { p.role = v as BindRole; })))); }));
  } else if (S.sbtab === 'tool') {
    c.appendChild(panel('sb.snap', 'Snapping', b => {
      b.appendChild(bcheck('Snap while transforming', S.snap, v => { S.snap = v; prefs(); renderHeader(); }));
      b.appendChild(brow('Move Step', bnum({ get: () => S.snapMove, set: v => { S.snapMove = Math.max(0.1, v); prefs(); }, step: 0.5, min: 0.1, unit: 'mm' })));
      b.appendChild(brow('Rotate Step', bnum({ get: () => S.snapRot, set: v => { S.snapRot = Math.max(1, v); prefs(); }, step: 1, min: 1, unit: '°' })));
      b.appendChild(h('div', 'bnote', 'Hold Ctrl during a move to flip snapping, and Shift for precision.'));
    }));
  } else {
    c.appendChild(panel('sb.view', 'View', b => {
      b.appendChild(brow('Focal Length', bnum({ get: () => r2(18 / Math.tan((V.persp.fov * D2R) / 2)), set: v => { V.persp.fov = 2 * Math.atan(18 / Math.max(1, v)) * R2D; V.persp.updateProjectionMatrix(); }, step: 1, min: 1, unit: 'mm' })));
      b.appendChild(brow('Clip Start', bnum({ get: () => V.persp.near, set: v => { V.persp.near = Math.max(0.01, v); V.persp.updateProjectionMatrix(); }, step: 0.1, unit: 'mm' })));
      b.appendChild(brow('End', bnum({ get: () => V.persp.far, set: v => { V.persp.far = Math.max(10, v); V.persp.updateProjectionMatrix(); }, step: 100, unit: 'mm' })));
    }));
    c.appendChild(panel('sb.cursor', '3D Cursor', b => b.appendChild(bvec('Location', [0, 1, 2].map(k => ({ label: 'XYZ'[k], unit: 'mm', step: 0.5, get: () => V.cursor.getComponent(k), set: (v: number) => V.cursor.setComponent(k, v) }))))));
    c.appendChild(panel('sb.nav', 'Navigation', b => {
      b.appendChild(bcheck('Emulate Numpad', S.emuNumpad, v => { S.emuNumpad = v; prefs(); }));
      b.appendChild(bcheck('Two-finger scroll orbits', S.trackpadOrbit, v => { S.trackpadOrbit = v; prefs(); }));
    }));
  }
}
function renderInfo() {
  const c = $('#info'); c.innerHTML = '';
  const fit = fitBuilt(parts()), bad = fit.filter(f => f.level !== 'ok').length;
  $('#infoHint').textContent = bad ? `${bad} fit issue${bad > 1 ? 's' : ''}` : '';
  if (S.infoTab === 'reports') {
    if (!S.reports.length) c.appendChild(h('div', 'irow', '<span class="m hdim">Reports from operations appear here.</span>'));
    for (const r of S.reports) c.appendChild(h('div', 'irow ' + r.level, `<span class="t">${r.t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><span class="m">${esc(r.msg)}</span>`));
    c.scrollTop = c.scrollHeight;
  } else if (S.infoTab === 'fit') {
    if (!fit.length) c.appendChild(h('div', 'irow', '<span class="m hdim">Put parts in the Internals collection to check they fit inside the Enclosure.</span>'));
    for (const f of fit) { const r = h('div', `irow ${f.level}${f.ids.length ? ' click' : ''}`, `<span class="dot"></span><span class="m">${esc(f.msg)}</span>`); if (f.ids.length) r.onclick = () => setSel(f.ids, f.ids[0]); c.appendChild(r); }
  } else {
    if (!S.built.notes.length) c.appendChild(h('div', 'irow', '<span class="m hdim">Run Auto Build (Add ▸ Auto Build from Electronics) to see how it laid things out.</span>'));
    S.built.notes.forEach(n => c.appendChild(h('div', 'irow', `<span class="dot"></span><span class="m">${esc(n)}</span>`)));
  }
}
function renderStatus() {
  const k = (s: string) => s.split(' ').map(x => `<kbd>${esc(kc(x))}</kbd>`).join('');
  if (E.on) {
    $('#stLeft').innerHTML = Ed.emodal ? `<span>${k('LMB')}<b>Confirm</b></span><span>${k('RMB')}<b>Cancel</b></span><span>${k('X')}${k('Y')}${k('Z')}<b>Axis</b></span><span>${k('Ctrl')}<b>Snap</b></span>`
      : `<span>${k('LMB')}<b>Select</b></span><span>${k('1')}${k('2')}${k('3')}<b>Vert / Edge / Face</b></span><span>${k('E')}<b>Extrude</b></span><span>${k('Ctrl R')}<b>Loop Cut</b></span><span>${k('RMB')}<b>Context Menu</b></span><span>${k('Tab')}<b>Object Mode</b></span>`;
    $('#stRight').textContent = `${part(E.id)?.name ?? ''}  |  ${Ed.stats()}  |  Edit Mode`;
    return;
  }
  $('#stLeft').innerHTML = modal
    ? `<span>${k('LMB')}<b>Confirm</b></span><span>${k('RMB')}<b>Cancel</b></span><span>${k('X')}${k('Y')}${k('Z')}<b>Axis</b></span><span>${k('Shift')}<b>Precision / plane</b></span><span>${k('Ctrl')}<b>Snap</b></span>`
    : `<span>${k('LMB')}<b>Select</b></span><span>${k('MMB')}<b>Rotate View</b></span><span>${k('RMB')}<b>Object Context Menu</b></span><span>${k('Shift A')}<b>Add</b></span>`;
  const fit = fitBuilt(parts()).filter(f => f.level !== 'ok').length;
  $('#stRight').textContent = `Objects ${S.sel.size}/${parts().length}  |  ${fit ? `Fit: ${fit} issue${fit > 1 ? 's' : ''}` : 'Fit OK'}  |  Formframe Modeler`;
}

// ------------------------------------------------------------------ viewport input
function wireViewport() {
  const vp = $('#vp'), cv = V.renderer.domElement;
  let down: { x: number; y: number; btn: number; shift: boolean; ctrl: boolean } | null = null, box = false, zoomDrag: { y: number } | null = null;
  vp.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('#toolbar, #navWrap, #sidebar, #redo, #banner')) return;
    V.controls.mouseButtons.LEFT = (e.altKey && e.button === 0 ? THREE.MOUSE.ROTATE : -1) as any;
    if (modal) { e.preventDefault(); e.stopPropagation(); endModal(e.button === 0); return; }
    if (Ed.emodal) { e.preventDefault(); e.stopPropagation(); Ed.endModal(e.button === 0); renderStatus(); return; }
    if (e.button === 1 && (e.ctrlKey || e.metaKey)) { V.controls.enabled = false; zoomDrag = { y: e.clientY }; e.preventDefault(); return; }
    if (e.button === 0 && !e.altKey) {
      if ((V.tc as any).axis && V.tc.visible) return; // gizmo handles it
      down = { x: e.clientX, y: e.clientY, btn: 0, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }; box = false;
    }
    if (e.button === 2) {
      if (e.shiftKey) placeCursor(e.clientX, e.clientY);
      else if (E.on) Ed.contextMenu(e.clientX, e.clientY);
      else contextMenu(e.clientX, e.clientY);
    }
  }, true);
  vp.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('pointermove', e => {
    S.mouse = { x: e.clientX, y: e.clientY };
    if (modal) { updateModal(); return; }
    if (Ed.emodal) { Ed.updateModal(); return; }
    if (E.on) Ed.hoverLoop(e.clientX, e.clientY);
    if (zoomDrag) { V.dolly(Math.exp((e.clientY - zoomDrag.y) * 0.01)); zoomDrag.y = e.clientY; return; }
    if (down && !box && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 && S.tool !== 'cursor') box = true;
    if (down && box) {
      const r = vp.getBoundingClientRect(), b = $('#boxsel');
      b.style.display = 'block'; b.style.left = Math.min(down.x, e.clientX) - r.left + 'px'; b.style.top = Math.min(down.y, e.clientY) - r.top + 'px';
      b.style.width = Math.abs(e.clientX - down.x) + 'px'; b.style.height = Math.abs(e.clientY - down.y) + 'px';
    }
  });
  window.addEventListener('pointerup', e => {
    if (zoomDrag) { zoomDrag = null; V.controls.enabled = true; return; }
    const d = down; down = null; if (!d) return;
    if (box) {
      $('#boxsel').style.display = 'none'; box = false;
      if (E.on) { Ed.box(Math.min(d.x, e.clientX), Math.min(d.y, e.clientY), Math.max(d.x, e.clientX), Math.max(d.y, e.clientY), d.shift, d.ctrl); renderStatus(); renderSidebar(); }
      else boxSelect(d, e, d.shift, d.ctrl);
      return;
    }
    if (e.target !== cv) return;
    if (S.tool === 'cursor') { placeCursor(e.clientX, e.clientY); return; }
    if (E.on) { Ed.click(e.clientX, e.clientY, d.shift); renderStatus(); renderSidebar(); return; }
    clickSelect(e.clientX, e.clientY, d.shift);
  });
  vp.addEventListener('wheel', e => {
    e.preventDefault(); if (modal) return;
    const trackpad = S.trackpadOrbit && e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40);
    if (e.ctrlKey) V.dolly(Math.exp(e.deltaY * 0.01));
    else if (trackpad && e.shiftKey) V.pan(-e.deltaX, -e.deltaY);
    else if (trackpad) V.orbit(-e.deltaX * 0.006, -e.deltaY * 0.006);
    else V.dolly(e.deltaY > 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
  V.onChange = () => { renderVText(); if (gizmoDrag == null && !modal) { /* keep helper on selection */ } };

  // nav buttons
  ($('#nZoom') as HTMLElement).innerHTML = ICON.zoom; ($('#nPan') as HTMLElement).innerHTML = ICON.hand; ($('#nOrtho') as HTMLElement).innerHTML = ICON.ortho;
  const dragBtn = (el: HTMLElement, fn: (dx: number, dy: number) => void) => {
    el.onpointerdown = e => { e.stopPropagation(); el.setPointerCapture(e.pointerId); let x = e.clientX, y = e.clientY; el.onpointermove = m => { fn(m.clientX - x, m.clientY - y); x = m.clientX; y = m.clientY; }; el.onpointerup = () => { el.onpointermove = null; }; };
  };
  dragBtn($('#nZoom'), (_dx, dy) => V.dolly(Math.exp(dy * 0.01)));
  dragBtn($('#nPan'), (dx, dy) => V.pan(dx, dy));
  $('#nOrtho').onclick = () => { V.setOrtho(!V.isOrtho); $('#nOrtho').innerHTML = V.isOrtho ? ICON.persp : ICON.ortho; renderVText(); };

  // gizmo tools move the whole selection around its median
  V.tc.addEventListener('dragging-changed', (e: any) => {
    if (e.value) { pushUndo(S.tool === 'rotate' ? 'Rotate' : S.tool === 'scale' ? 'Resize' : 'Move'); gizmoDrag = { orig: captureOrig(), pos: V.helper.position.clone(), quat: V.helper.quaternion.clone(), pivot: V.helper.position.clone() }; }
    else if (gizmoDrag) { const g = gizmoDrag; gizmoDrag = null; writeBack(g.orig.keys()); rebuild(); scheduleSave(); report(`${S.tool === 'rotate' ? 'Rotate' : S.tool === 'scale' ? 'Resize' : 'Move'} ${g.orig.size} object${g.orig.size > 1 ? 's' : ''}`); }
  });
  V.tc.addEventListener('objectChange', () => {
    const g = gizmoDrag; if (!g) return;
    const mode = V.tc.mode;
    if (mode === 'translate') applyMove(g.orig, V.helper.position.clone().sub(g.pos));
    else if (mode === 'rotate') applyRot(g.orig, V.helper.quaternion.clone().multiply(g.quat.clone().invert()), g.pivot);
    else { const s = V.helper.scale; applyScale(g.orig, new THREE.Matrix3().set(s.x, 0, 0, 0, s.y, 0, 0, 0, s.z), g.pivot); }
    V.setSelection([...S.sel].map(root).filter(Boolean) as THREE.Object3D[], S.active ? root(S.active) : null);
  });
}
function visibleMeshes() { return S.prod!.pickables().filter(m => { let o: THREE.Object3D | null = m; while (o) { if (!o.visible) return false; o = o.parent; } return true; }); }
function clickSelect(x: number, y: number, shift: boolean) {
  const hit = V.pick(x, y, visibleMeshes()), id = hit?.object.userData.part as string | undefined;
  if (!id) { if (!shift) setSel([]); return; }
  if (shift) {
    if (S.sel.has(id) && S.active === id) { S.sel.delete(id); setSel([...S.sel], null); }
    else { S.sel.add(id); setSel([...S.sel], id); }
  } else setSel([id], id);
}
function boxSelect(d: { x: number; y: number }, e: PointerEvent, extend: boolean, subtract: boolean) {
  const x0 = Math.min(d.x, e.clientX), x1 = Math.max(d.x, e.clientX), y0 = Math.min(d.y, e.clientY), y1 = Math.max(d.y, e.clientY);
  const hits: string[] = [];
  for (const [id, r] of S.prod!.roots) {
    if (!r.visible || S.hidden.has(id)) continue;
    const b = new THREE.Box3().setFromObject(r); if (b.isEmpty()) continue;
    let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
    for (let i = 0; i < 8; i++) { const p = V.project(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)); sx0 = Math.min(sx0, p.x); sx1 = Math.max(sx1, p.x); sy0 = Math.min(sy0, p.y); sy1 = Math.max(sy1, p.y); }
    if (sx1 >= x0 && sx0 <= x1 && sy1 >= y0 && sy0 <= y1) hits.push(id);
  }
  const next = new Set(extend || subtract ? S.sel : []);
  hits.forEach(id => subtract ? next.delete(id) : next.add(id));
  setSel([...next], subtract ? (next.has(S.active ?? '') ? S.active : null) : hits[hits.length - 1] ?? S.active);
}
function placeCursor(x: number, y: number) {
  const hit = V.pick(x, y, visibleMeshes());
  const p = hit?.point ?? V.rayPlane(x, y, V.cursor, V.viewNormal());
  if (p) { V.cursor.copy(p).set(r2(p.x), r2(p.y), r2(p.z)); renderSidebar(); }
}

// ------------------------------------------------------------------ keyboard
function wireKeys() {
  window.addEventListener('keyup', e => Ed.modalKeyUp(e));
  window.addEventListener('keyup', e => { if (modal && (e.key === 'Control' || e.key === 'Meta')) { modal.ctrl = false; updateModal(); } if (modal && e.key === 'Shift') { modal.shift = false; updateModal(); } });
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
    if (modal) { e.preventDefault(); modalKey(e); return; }
    if (menuOpen()) return;
    if (E.on && Ed.editKey(e)) { renderStatus(); renderSidebar(); if (!E.on) { renderMenus(); renderAll(); } return; }
    // in Edit Mode only view/navigation/app keys fall through to object-mode handling
    if (E.on && !(e.ctrlKey || e.metaKey) && !/^(Numpad|F\d|Home|Period|Backquote)/.test(e.code) && !['n', 't', 'z', '.', '`', 'Z', 'S'].includes(e.key) && !(e.altKey && e.key.toLowerCase() === 'z') && !(e.shiftKey && e.key === 'Tab') && !(S.emuNumpad && /^Digit[04-9]$/.test(e.code))) return;
    const k = e.key, lk = k.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, code = e.code;
    const num = code.startsWith('Numpad') ? code.slice(6) : S.emuNumpad && /^Digit\d$/.test(code) ? code.slice(5) : null;
    const go = (fn: () => void) => { e.preventDefault(); fn(); };
    if (ctrl && lk === 'z') return go(e.shiftKey ? redo : undo);
    if (ctrl && lk === 'y') return go(redo);
    if (ctrl && lk === 's') return go(() => { save(); report('Saved', 'ok'); });
    if (ctrl && lk === 'o') return go(openPicker);
    if (ctrl && lk === 'i') return go(invertSel);
    if (ctrl && k === ' ') return go(() => document.body.classList.toggle('maxview'));
    if (num != null && !e.altKey) {
      if (num === '1') return go(() => V.setView('front', ctrl)); if (num === '3') return go(() => V.setView('right', ctrl)); if (num === '7') return go(() => V.setView('top', ctrl));
      if (num === '5') return go(() => V.setOrtho(!V.isOrtho));
      if (num === '9' && V.aligned) return go(() => V.setView(V.aligned!, true));
      if (num === '4') return go(() => V.orbit(-15 * D2R, 0)); if (num === '6') return go(() => V.orbit(15 * D2R, 0));
      if (num === '8') return go(() => V.orbit(0, 15 * D2R)); if (num === '2') return go(() => V.orbit(0, -15 * D2R));
      if (num === '0') return go(() => report('This scene has no camera. Use F12 to render the current view.', 'warn'));
    }
    if (code === 'NumpadDecimal' || (k === '.' && !e.shiftKey)) return go(frameSel);
    if (k === 'Home') return go(() => V.frame());
    if (k === 'F2') return go(() => rename());
    if (k === 'F3') return go(search);
    if (k === 'F12') return go(renderImage);
    if (k === 'Tab' && e.shiftKey) return go(() => { S.snap = !S.snap; prefs(); renderHeader(); report(`Snap ${S.snap ? 'on' : 'off'}`); });
    if (k === 'Tab') return go(toggleEditMode);
    if (ctrl && lk === 'j') return go(joinSel);
    if (e.shiftKey && lk === 'a') return go(() => popup(addMenu(), S.mouse.x, S.mouse.y, 'Add'));
    if (e.shiftKey && lk === 'd') return go(duplicate);
    if (e.shiftKey && lk === 's') return go(() => pie([{ label: 'Selection to Cursor', action: () => snapOp('selCursor') }, { label: 'Cursor to Selected', action: () => snapOp('cursorSel') }, { label: 'Cursor to World Origin', action: () => snapOp('cursorOrigin') }, { label: 'Selection to Grid', action: () => snapOp('selGrid') }, { label: 'Cursor to Active', action: () => snapOp('cursorActive') }, { label: 'Selection to Active', action: () => snapOp('selActive') }], S.mouse.x, S.mouse.y, 's'));
    if (e.shiftKey && lk === 'h') return go(() => hideSel(true));
    if (e.shiftKey && lk === 'c') return go(() => { V.cursor.set(0, 0, 0); V.frame(); });
    if (e.altKey && lk === 'h') return go(reveal);
    if (e.altKey && lk === 'a') return go(() => setSel([]));
    if (e.altKey && lk === 'z') return go(toggleXray);
    if (ctrl || e.altKey) return;
    if (lk === 'g') return go(() => startModal('G'));
    if (lk === 'r') return go(() => startModal('R'));
    if (lk === 's') return go(() => startModal('S'));
    if (lk === 'a') return go(selectAll);
    if (lk === 'b') return go(() => { setTool('select'); report('Box select: drag in the viewport'); });
    if (lk === 'w') return go(() => setTool('select'));
    if (lk === 'h') return go(() => hideSel());
    if (lk === 'm') return go(() => S.sel.size ? popup(collItems(), S.mouse.x, S.mouse.y, 'Move to Collection') : report('No objects selected', 'warn'));
    if (lk === 'n') return go(toggleSidebar);
    if (lk === 't') return go(() => document.body.classList.toggle('no-toolbar'));
    if (lk === 'x') return go(() => S.sel.size ? popup([{ label: 'Delete', action: deleteSel }], S.mouse.x, S.mouse.y, 'Delete') : report('No objects selected', 'warn'));
    if (k === 'Delete' || k === 'Backspace') return go(deleteSel);
    if (lk === 'z') return go(() => pie([{ label: 'Wireframe', icon: 'wire', action: () => setShading('wire') }, { label: 'Rendered', icon: 'rendered', action: () => setShading('rendered') }, { label: 'Solid', icon: 'solid', action: () => setShading('solid') }, { label: 'Material Preview', icon: 'matprev', action: () => setShading('material') }, { label: 'Toggle X-Ray', icon: 'xray', action: toggleXray }], S.mouse.x, S.mouse.y, 'z'));
    if (k === '`' || k === '~') return go(() => pie((['left', 'right', 'bottom', 'top', 'back', 'front'] as ViewName[]).map(v => ({ label: v[0].toUpperCase() + v.slice(1), action: () => V.setView(v) })).concat([{ label: 'Frame Selected', action: frameSel }]), S.mouse.x, S.mouse.y, '`'));
  });
}

// ------------------------------------------------------------------ splitters
function wireSplits() {
  const root = document.documentElement;
  try { const s = JSON.parse(localStorage.getItem('ffm.layout') ?? '{}'); for (const [k, v] of Object.entries(s)) root.style.setProperty('--' + k, v as string); } catch { }
  $$('.split').forEach(sp => sp.onpointerdown = e => {
    e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
    const k = sp.dataset.split!, areas = $('#areas').getBoundingClientRect(), right = $('#rightCol').getBoundingClientRect();
    sp.onpointermove = m => {
      if (k === 'rw') root.style.setProperty('--rw', Math.min(innerWidth * 0.6, Math.max(200, areas.right - m.clientX - 2)) + 'px');
      if (k === 'bh') root.style.setProperty('--bh', Math.min(areas.height * 0.6, Math.max(60, areas.bottom - m.clientY - 2)) + 'px');
      if (k === 'oh') root.style.setProperty('--oh', Math.min(85, Math.max(12, ((m.clientY - right.top) / right.height) * 100)) + '%');
      V.resize();
    };
    sp.onpointerup = () => { sp.onpointermove = null; sp.classList.remove('drag'); try { localStorage.setItem('ffm.layout', JSON.stringify({ rw: root.style.getPropertyValue('--rw'), bh: root.style.getPropertyValue('--bh'), oh: root.style.getPropertyValue('--oh') })); } catch { } };
  });
}

// ------------------------------------------------------------------ project loading
async function openPicker() {
  const ps = await listProjects();
  const l = $('#pickList'); l.innerHTML = '';
  if (!ps.length) l.appendChild(h('div', 'bnote', 'No projects yet. Create one in the studio first.'));
  for (const p of ps) { const r = h('div', 'orow' + (p.id === S.id ? ' sel' : ''), `${ICON.scene}<span class="on">${esc(p.name)}</span><span class="hdim">${esc(BOARDS[p.board]?.name ?? '')}</span>`); r.onclick = () => { location.search = '?project=' + encodeURIComponent(p.id); }; l.appendChild(r); }
  $('#picker').classList.add('show');
  $('#picker').onclick = e => { if (e.target === $('#picker') && S.id) $('#picker').classList.remove('show'); };
}
async function load(id: string) {
  const p = await loadProject(id).catch(() => null);
  if (!p) { openPicker(); return; }
  S.id = id; S.project = p;
  S.built = p.product.built ? p.product.built : newBuiltModel();
  S.built.auto ??= defaultAutoOpts();
  S.prod = new BuiltProduct(S.built);
  // a "screen" pattern so display parts read as screens here
  const g = S.prod.screen.getContext('2d')!, gr = g.createRadialGradient(256, 200, 10, 256, 256, 300); gr.addColorStop(0, '#1b2430'); gr.addColorStop(1, '#05070a');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512); g.fillStyle = '#5b6b80'; g.font = '600 44px Inter'; g.textAlign = 'center'; g.fillText('SCREEN', 256, 270); S.prod.screenUpdated();
  V.setProduct(S.prod);
  rebuild3D(); V.frame();
  renderTitle(); renderToolbar(); renderAll();
  const src = p.product.source;
  if (src !== 'built') {
    const what = src === 'parametric' ? 'the built-in thermostat model' : src === 'imported' ? 'an imported CAD model' : 'no model yet';
    const bn = $('#banner'); bn.classList.add('show');
    bn.innerHTML = `This project currently shows <b>${what}</b> in the studio. The first change you make here switches it to this model.<br>`;
    const a = h('button', 'tbtn', 'Auto Build from Electronics'); a.onclick = runAutoBuild;
    const k = h('button', 'tbtn', 'Start from the default housing'); k.onclick = () => { commit('Start Model', () => {}, 'Started a built model'); };
    bn.append(a, k);
  }
  report(`Opened ${p.name}${p.product.built ? ` · ${S.built.parts.length} objects` : ''}`);
}

// ------------------------------------------------------------------ boot
function boot() {
  try { const s = JSON.parse(localStorage.getItem('ffm.prefs') ?? '{}'); if (s.emu != null) S.emuNumpad = s.emu; if (s.tp != null) S.trackpadOrbit = s.tp; if (s.snap != null) S.snap = s.snap; if (s.sm) S.snapMove = s.sm; if (s.sr) S.snapRot = s.sr; } catch { }
  $('#tLogo').innerHTML = ICON.logo;
  $$('.etype').forEach(e => (e.innerHTML = e.classList.contains('out') ? ICON.outliner : e.classList.contains('props') ? ICON.props : e.classList.contains('info') ? ICON.info : ICON.view3d));
  initMenus();
  menubar($('#topMenus'), topMenus);
  menubar($('#viewMenus'), viewMenus);
  $('#modeDrop').onclick = e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); popup([{ label: 'Object Mode', icon: 'object', checked: !E.on, action: () => { if (E.on) toggleEditMode(); } }, { label: 'Edit Mode', icon: 'mesh', checked: E.on, shortcut: 'Tab', action: () => { if (!E.on) toggleEditMode(); } }], r.left + 20, r.bottom + 14); };
  $('#bSnap').innerHTML = ICON.magnet; $('#bSnap').onclick = () => { S.snap = !S.snap; prefs(); renderHeader(); };
  $('#bOverlay').innerHTML = ICON.overlay; $('#bOverlay').onclick = () => { V.overlays = !V.overlays; renderHeader(); };
  $('#bXray').innerHTML = ICON.xray; $('#bXray').onclick = toggleXray;
  $$('#shadeBtns .hb').forEach(b => { b.innerHTML = ICON[{ wire: 'wire', solid: 'solid', material: 'matprev', rendered: 'rendered' }[b.dataset.sh!]!]; b.onclick = () => setShading(b.dataset.sh as Shading); });
  $$('#workspaces button').forEach(b => (b.onclick = () => setWorkspace(b.dataset.ws as any)));
  $$('#sbTabs button').forEach(b => (b.onclick = () => { S.sbtab = b.dataset.t!; renderSidebar(); }));
  $$('#infoTabs button').forEach(b => (b.onclick = () => { S.infoTab = b.dataset.i!; $$('#infoTabs button').forEach(x => x.classList.toggle('on', x === b)); renderInfo(); }));
  ($('#outSearch') as HTMLInputElement).oninput = e => { S.outFilter = (e.target as HTMLInputElement).value; renderOutliner(); };
  ($('#outSearch') as HTMLInputElement).onkeydown = e => e.stopPropagation();
  $('#bStudio').onclick = studio;
  V = new View($('#vp'));
  Ed.initEdit({
    V, part: id => part(id), root: id => root(id),
    pushUndo, popUndo: () => { S.undo.pop(); }, changed: () => { rebuild3D(); scheduleSave(); },
    report, render: () => { renderAll(false); renderStatus(); }, popup, pie, mouse: () => S.mouse,
    snap: () => ({ on: S.snap, move: S.snapMove, rot: S.snapRot }),
    newPart: q => { q.id = newUid(); parts().push(q); },
    addMesh: unitMesh,
  });
  $$('#selModes .hb').forEach(b => { b.innerHTML = ICON[b.dataset.sm === 'vert' ? 'vsel' : b.dataset.sm === 'edge' ? 'esel' : 'fsel']; b.onclick = () => { Ed.setSelMode(b.dataset.sm as Ed.SelMode); renderMenus(); }; });
  (window as any).modeler = { S, V };
  wireViewport(); wireKeys(); wireSplits(); renderHeader(); renderToolbar(); renderMenus();
  listen(m => { if (m.id === S.id && (m.type === 'saved' || m.type === 'built')) reloadFromStore(); });
  window.addEventListener('beforeunload', () => { if (S.dirty) save(); });
  const id = new URLSearchParams(location.search).get('project');
  if (id) load(id); else openPicker();
}
boot();
