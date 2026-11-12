import * as THREE from 'three';
import type { BuiltPart } from '../app/project';
import type { View } from './view';
import type { MenuItem, PieItem } from './ui';
import {
  type EMesh, type V, toEMesh, writeEMesh, meshGeometry, edges, faceSelected, centroid, normal,
  extrude, inset, subdivide, edgeRing, loopCut, merge, mergeByDistance, fill, deleteVerts, deleteEdges, deleteFaces,
  flip, recalcNormals, linked, duplicateSel, append, ekey, triangulate,
} from '../scene/mesh';

/**
 * Edit Mode: vertex / edge / face editing of one part, Blender style.
 * The part is converted to a polygon mesh on entry (and changed back if you
 * leave without editing). Selection is kept as a set of vertices; edges and
 * faces count as selected when all their vertices are, like Blender's
 * selection flushing.
 */
export type SelMode = 'vert' | 'edge' | 'face';
export interface EditHost {
  V: View;
  part(id: string): BuiltPart | null;
  root(id: string): THREE.Object3D | null;
  pushUndo(name: string): void;
  popUndo(): void;
  /** Rebuild the scene after the model changed (no undo push). */
  changed(): void;
  report(msg: string, level?: 'info' | 'warn' | 'err' | 'ok'): void;
  render(): void;
  popup(items: MenuItem[], x: number, y: number, title?: string): void;
  pie(items: PieItem[], x: number, y: number, key?: string): void;
  mouse(): { x: number; y: number };
  snap(): { on: boolean; move: number; rot: number };
  newPart(p: BuiltPart): void;
  addMesh(kind: string): EMesh | null;
}

export const E = {
  on: false, id: '', m: null as EMesh | null, sel: new Set<number>(), mode: 'vert' as SelMode,
  orig: '', converted: false, changed: false,
};
let H: EditHost;
const overlay = new THREE.Group(); overlay.userData.overlay = true; overlay.renderOrder = 10;
const preview = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe14d, depthTest: false, transparent: true }));
preview.renderOrder = 12;
let loopArm = false, loopEdge: [number, number] | null = null;
const SEL = new THREE.Color(0xffa133), ACT = new THREE.Color(0xffffff), WIRE = new THREE.Color(0x0a0a0a);

export function initEdit(h: EditHost) { H = h; }

// ------------------------------------------------------------------ mode
export function enterEdit(id: string | null) {
  const p = id ? H.part(id) : null;
  if (!p) { H.report('Select an object to edit first', 'warn'); return false; }
  if (!H.root(id!)?.visible) { H.report('That object is hidden', 'warn'); return false; }
  E.orig = JSON.stringify(p); E.converted = p.shape !== 'mesh'; E.changed = false;
  E.on = true; E.id = id!; E.m = toEMesh(p); E.sel = new Set(E.m.v.map((_, i) => i));
  if (E.converted) { writeEMesh(p, E.m); E.m = toEMesh(p); H.changed(); }
  attach(); refresh();
  H.report(E.converted ? `Edit Mode: ${p.name} is now an editable mesh (${E.m.v.length} verts, ${E.m.f.length} faces)` : `Edit Mode: ${p.name}`);
  H.render();
  return true;
}
export function exitEdit() {
  if (!E.on) return;
  const p = H.part(E.id);
  if (p && E.converted && !E.changed) Object.assign(p, JSON.parse(E.orig)); // untouched: back to the primitive
  E.on = false; E.m = null; E.sel.clear(); loopArm = false; preview.visible = false;
  overlay.parent?.remove(overlay); preview.parent?.remove(preview);
  H.changed(); H.render();
}
export const toggleEdit = (active: string | null) => (E.on ? exitEdit() : enterEdit(active));

/** The scene was rebuilt (roots replaced): hang the overlay on the new root. */
export function onRebuild() { if (!E.on) return; attach(); refresh(); }
/** The model was replaced (undo/redo/sync): reload the mesh, or leave Edit Mode if the part is gone. */
export function reload() {
  if (!E.on) return;
  const p = H.part(E.id);
  if (!p || p.shape !== 'mesh') { E.on = false; overlay.parent?.remove(overlay); E.m = null; H.render(); return; }
  E.m = toEMesh(p); for (const i of [...E.sel]) if (i >= E.m.v.length) E.sel.delete(i);
  attach(); refresh();
}
function attach() {
  const r = H.root(E.id); if (!r) return;
  if (overlay.parent !== r) r.add(overlay);
  if (preview.parent !== r) r.add(preview);
}

// ------------------------------------------------------------------ drawing
const geoMeshes = () => { const out: THREE.Mesh[] = []; H.root(E.id)?.traverse((o: any) => { if (o.isMesh && o.userData.part === E.id && !isOverlay(o)) out.push(o); }); return out; };
const isOverlay = (o: THREE.Object3D) => { let x: THREE.Object3D | null = o; while (x) { if (x.userData.overlay) return true; x = x.parent; } return false; };
/** Redraw the part from the in-progress mesh, plus verts/edges/faces overlay. */
export function refresh() {
  if (!E.on || !E.m) return;
  const p = H.part(E.id)!, m = E.m;
  const g = meshGeometry(m, !!p.smooth, p.role === 'screen');
  for (const mesh of geoMeshes()) {
    if (mesh.geometry !== g) mesh.geometry.dispose();
    mesh.geometry = g;
    const mat = mesh.material as THREE.Material; mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1;
  }
  for (const c of [...overlay.children]) { overlay.remove(c); (c as any).geometry?.dispose(); (c as any).material?.dispose(); }
  const xr = H.V.xray, s = E.sel;
  // faces (selected tint)
  const ft: number[] = [];
  m.f.forEach(f => { if (faceSelected(f, s)) triangulate(m.v, f).forEach(t => t.forEach(i => ft.push(...m.v[i]))); });
  if (ft.length) {
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(ft, 3));
    const fm = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, depthTest: !xr, polygonOffset: true, polygonOffsetFactor: -1 }));
    fm.renderOrder = 10; overlay.add(fm);
  }
  // edges
  const ep: number[] = [], ec: number[] = [];
  for (const e of edges(m).values()) { const on = s.has(e.a) && s.has(e.b), c = on ? SEL : WIRE; ep.push(...m.v[e.a], ...m.v[e.b]); ec.push(c.r, c.g, c.b, c.r, c.g, c.b); }
  const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3)); eg.setAttribute('color', new THREE.Float32BufferAttribute(ec, 3));
  const el = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: !xr, transparent: true })); el.renderOrder = 11; overlay.add(el);
  // verts (vertex mode) or face dots (face mode)
  const dp: number[] = [], dc: number[] = [];
  if (E.mode === 'vert') m.v.forEach((q, i) => { const c = s.has(i) ? SEL : WIRE; dp.push(...q); dc.push(c.r, c.g, c.b); });
  if (E.mode === 'face') m.f.forEach(f => { const c = faceSelected(f, s) ? SEL : WIRE; dp.push(...centroid(m.v, f)); dc.push(c.r, c.g, c.b); });
  if (dp.length) {
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3)); dg.setAttribute('color', new THREE.Float32BufferAttribute(dc, 3));
    const pts = new THREE.Points(dg, new THREE.PointsMaterial({ size: E.mode === 'vert' ? 6 : 5, sizeAttenuation: false, vertexColors: true, depthTest: !xr, transparent: true })); pts.renderOrder = 12; overlay.add(pts);
  }
  void ACT;
}

// ------------------------------------------------------------------ write back
/** Commit a topology/geometry change as one undo step. */
function op(name: string, fn: (m: EMesh) => Set<number> | void, msg?: string) {
  if (!E.on || !E.m) return;
  H.pushUndo(name);
  const res = fn(E.m);
  if (res) E.sel = res;
  write(); H.report(msg ?? name);
}
/** Store E.m into the part, rebuild, remap selection. */
function write() {
  const p = H.part(E.id); if (!p || !E.m) return;
  const map = writeEMesh(p, E.m);
  E.sel = new Set([...E.sel].map(i => map.get(i)).filter((i): i is number => i != null));
  E.changed = true;
  E.m = toEMesh(p);
  H.changed();
  attach(); refresh(); H.render();
}

// ------------------------------------------------------------------ geometry in world space
const rootW = () => H.root(E.id)!;
const toWorld = (q: V) => rootW().localToWorld(new THREE.Vector3(...q));
const toLocal = (w: THREE.Vector3): V => { const l = rootW().worldToLocal(w.clone()); return [l.x, l.y, l.z]; };
const ray = new THREE.Raycaster();
function visible(w: THREE.Vector3) {
  if (H.V.xray) return true;
  const cam = H.V.cam, origin = cam.getWorldPosition(new THREE.Vector3());
  let dir: THREE.Vector3, dist: number;
  if ((cam as any).isOrthographicCamera) { dir = cam.getWorldDirection(new THREE.Vector3()); dist = w.clone().sub(origin).dot(dir); origin.copy(w).addScaledVector(dir, -dist); }
  else { dir = w.clone().sub(origin); dist = dir.length(); dir.normalize(); }
  ray.set(origin, dir); ray.near = 0; ray.far = dist;
  const hit = ray.intersectObjects(geoMeshes(), false)[0];
  return !hit || hit.distance >= dist - Math.max(0.05, dist * 0.002);
}
const scr = (w: THREE.Vector3) => H.V.project(w);
function segDist(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}
function nearestEdge(x: number, y: number): [number, number] | null {
  const m = E.m!; let best: [number, number] | null = null, bd = 12;
  for (const e of edges(m).values()) {
    const wa = toWorld(m.v[e.a]), wb = toWorld(m.v[e.b]), d = segDist(x, y, scr(wa), scr(wb));
    if (d < bd && visible(wa.clone().lerp(wb, 0.5))) { bd = d; best = [e.a, e.b]; }
  }
  return best;
}

// ------------------------------------------------------------------ selection
function selectSet(ids: Set<number>, extend: boolean) {
  if (!extend) E.sel = new Set(ids);
  else { const all = [...ids].every(i => E.sel.has(i)); ids.forEach(i => (all ? E.sel.delete(i) : E.sel.add(i))); }
  refresh(); H.render();
}
export function click(x: number, y: number, extend: boolean) {
  if (!E.on || !E.m) return;
  if (loopArm) { doLoopCut(); return; }
  const m = E.m;
  if (E.mode === 'vert') {
    let best = -1, bd = 14;
    m.v.forEach((q, i) => { const w = toWorld(q), s = scr(w), d = Math.hypot(s.x - x, s.y - y); if (d < bd && visible(w)) { bd = d; best = i; } });
    if (best < 0) { if (!extend) selectSet(new Set(), false); return; }
    selectSet(new Set([best]), extend);
  } else if (E.mode === 'edge') {
    const e = nearestEdge(x, y); if (!e) { if (!extend) selectSet(new Set(), false); return; }
    selectSet(new Set(e), extend);
  } else {
    const hit = H.V.pick(x, y, geoMeshes());
    let fi = hit && hit.faceIndex != null ? (hit.object as THREE.Mesh).geometry.userData.triFace?.[hit.faceIndex] : undefined;
    if (fi == null && H.V.xray) { // through the surface: nearest face centre
      let bd = 20; m.f.forEach((f, i) => { const s = scr(toWorld(centroid(m.v, f))), d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; fi = i; } });
    }
    if (fi == null) { if (!extend) selectSet(new Set(), false); return; }
    selectSet(new Set(m.f[fi]), extend);
  }
}
export function box(x0: number, y0: number, x1: number, y1: number, extend: boolean, subtract: boolean) {
  if (!E.on || !E.m) return;
  const m = E.m, inside = (w: THREE.Vector3) => { const s = scr(w); return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1 && visible(w); };
  const hits = new Set<number>();
  if (E.mode === 'vert') m.v.forEach((q, i) => { if (inside(toWorld(q))) hits.add(i); });
  else if (E.mode === 'edge') for (const e of edges(m).values()) { if (inside(toWorld(m.v[e.a]).lerp(toWorld(m.v[e.b]), 0.5))) { hits.add(e.a); hits.add(e.b); } }
  else m.f.forEach(f => { if (inside(toWorld(centroid(m.v, f)))) f.forEach(i => hits.add(i)); });
  if (subtract) hits.forEach(i => E.sel.delete(i)); else if (extend) hits.forEach(i => E.sel.add(i)); else E.sel = hits;
  refresh(); H.render();
}
export function setSelMode(m: SelMode) { E.mode = m; refresh(); H.render(); }
function selectAll() { E.sel = new Set(E.m!.v.map((_, i) => i)); refresh(); H.render(); }
function selectNone() { E.sel.clear(); refresh(); H.render(); }
function invert() { E.sel = new Set(E.m!.v.map((_, i) => i).filter(i => !E.sel.has(i))); refresh(); H.render(); }
function selectLinked(underMouse: boolean) {
  const m = E.m!;
  if (underMouse) {
    const { x, y } = H.mouse(); const hit = H.V.pick(x, y, geoMeshes());
    const fi = hit && hit.faceIndex != null ? (hit.object as THREE.Mesh).geometry.userData.triFace?.[hit.faceIndex] : undefined;
    if (fi == null) return H.report('Point at the mesh, then press L', 'warn');
    linked(m, m.f[fi]).forEach(i => E.sel.add(i));
  } else E.sel = linked(m, E.sel);
  refresh(); H.render();
}

// ------------------------------------------------------------------ modal transform (G / R / S / extrude / inset)
type Axis = 'x' | 'y' | 'z';
interface EModal { kind: 'G' | 'R' | 'S' | 'I'; axis: Axis | 'n' | null; local: boolean; typed: string; sx: number; sy: number; pivot: THREE.Vector3; ps: { x: number; y: number }; orig: Map<number, THREE.Vector3>; normal: THREE.Vector3 | null; keepOnCancel: boolean; base?: EMesh; baseSel?: Set<number>; ctrl: boolean; shift: boolean; name: string }
export let emodal: EModal | null = null;
function medianW(): THREE.Vector3 { const c = new THREE.Vector3(); let n = 0; for (const i of E.sel) { c.add(toWorld(E.m!.v[i])); n++; } return n ? c.divideScalar(n) : c; }
export function startModal(kind: EModal['kind'], opts: { normal?: THREE.Vector3 | null; keepOnCancel?: boolean; name?: string; undoPushed?: boolean } = {}) {
  if (!E.on || !E.m) return;
  if (!E.sel.size) { H.report('Nothing selected', 'warn'); return; }
  if (kind === 'I' && !E.m.f.some(f => faceSelected(f, E.sel))) { H.report('Inset needs selected faces', 'warn'); return; }
  const name = opts.name ?? ({ G: 'Move', R: 'Rotate', S: 'Resize', I: 'Inset Faces' })[kind];
  if (!opts.undoPushed) H.pushUndo(name);
  const { x, y } = H.mouse(), pivot = medianW();
  emodal = { kind, axis: opts.normal ? 'n' : null, local: false, typed: '', sx: x, sy: y, pivot, ps: scr(pivot), orig: new Map([...E.sel].map(i => [i, toWorld(E.m!.v[i])])), normal: opts.normal ?? null, keepOnCancel: !!opts.keepOnCancel, ctrl: false, shift: false, name };
  if (kind === 'I') { emodal.base = JSON.parse(JSON.stringify(E.m)); emodal.baseSel = new Set(E.sel); }
  document.body.classList.add('modal');
  updateModal(); H.render();
}
function axisVec(m: EModal) {
  if (m.axis === 'n') return m.normal!.clone().normalize();
  const v = new THREE.Vector3().setComponent('xyz'.indexOf(m.axis!), 1);
  if (m.local) v.applyQuaternion(rootW().getWorldQuaternion(new THREE.Quaternion()));
  return v.normalize();
}
export function updateModal() {
  const m = emodal; if (!m || !E.m) return;
  const { x, y } = H.mouse(), typed = m.typed && m.typed !== '-' && m.typed !== '.' ? parseFloat(m.typed) : NaN;
  const sn = H.snap(), snapping = sn.on !== m.ctrl, fine = m.shift ? 0.1 : 1;
  const dx = (x - m.sx) * fine, dy = (y - m.sy) * fine;
  const axName = m.axis === 'n' ? 'along normal' : m.axis ? `along ${m.local ? 'local' : 'global'} ${m.axis.toUpperCase()}` : '';
  let hud = '';
  if (m.kind === 'I') {
    const d0 = Math.max(10, Math.hypot(m.sx - m.ps.x, m.sy - m.ps.y)), d1 = Math.hypot(m.sx + dx - m.ps.x, m.sy + dy - m.ps.y);
    const span = (() => { let s = 1; for (const f of m.base!.f) if (faceSelected(f, m.baseSel!)) { const c = centroid(m.base!.v, f); for (const i of f) s = Math.max(s, Math.hypot(...(m.base!.v[i].map((q, k) => q - c[k]) as V))); } return s; })();
    let t = Math.max(0, (1 - d1 / d0) * span); if (!isNaN(typed)) t = Math.max(0, typed); else if (snapping) t = Math.round(t / sn.move) * sn.move;
    E.m = JSON.parse(JSON.stringify(m.base)); E.sel = inset(E.m!, m.baseSel!, t);
    hud = `Thickness: ${m.typed ? `[${m.typed}|]` : t.toFixed(2)} mm`;
  } else {
    let apply: (w: THREE.Vector3) => THREE.Vector3;
    if (m.kind === 'G') {
      let d = new THREE.Vector3();
      if (!isNaN(typed)) d = (m.axis ? axisVec(m) : new THREE.Vector3(1, 0, 0)).multiplyScalar(typed);
      else if (m.axis) {
        const a = axisVec(m), L = H.V.viewDist() * 0.2, s0 = scr(m.pivot), s1 = scr(m.pivot.clone().addScaledVector(a, L)), ax = s1.x - s0.x, ay = s1.y - s0.y;
        d = a.multiplyScalar(((dx * ax + dy * ay) / (ax * ax + ay * ay || 1)) * L);
      } else { const n = H.V.viewNormal(), p0 = H.V.rayPlane(m.sx, m.sy, m.pivot, n), p1 = H.V.rayPlane(m.sx + dx, m.sy + dy, m.pivot, n); if (p0 && p1) d = p1.sub(p0); }
      if (snapping && isNaN(typed)) d.set(Math.round(d.x / sn.move) * sn.move, Math.round(d.y / sn.move) * sn.move, Math.round(d.z / sn.move) * sn.move);
      apply = w => w.clone().add(d);
      hud = `D: ${m.typed ? `[${m.typed}|]` : (m.axis ? d.dot(axisVec(m)) : d.length()).toFixed(2)} mm (${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)}) ${axName}`;
    } else if (m.kind === 'R') {
      let ang = -(Math.atan2(m.sy + dy - m.ps.y, m.sx + dx - m.ps.x) - Math.atan2(m.sy - m.ps.y, m.sx - m.ps.x));
      const axis = m.axis ? axisVec(m) : H.V.viewNormal();
      if (m.axis && axis.dot(H.V.viewNormal()) < 0) ang = -ang;
      if (!isNaN(typed)) ang = typed * Math.PI / 180; else if (snapping) ang = Math.round(ang * 180 / Math.PI / sn.rot) * sn.rot * Math.PI / 180;
      const q = new THREE.Quaternion().setFromAxisAngle(axis, ang);
      apply = w => w.clone().sub(m.pivot).applyQuaternion(q).add(m.pivot);
      hud = `Rot: ${m.typed ? `[${m.typed}|]` : (ang * 180 / Math.PI).toFixed(1)}° ${axName}`;
    } else {
      const d0 = Math.max(4, Math.hypot(m.sx - m.ps.x, m.sy - m.ps.y));
      let f = Math.hypot(m.sx + dx - m.ps.x, m.sy + dy - m.ps.y) / d0;
      if (!isNaN(typed)) f = typed; else if (snapping) f = Math.round(f * 10) / 10;
      const a = m.axis ? axisVec(m) : null;
      apply = w => { const v = w.clone().sub(m.pivot); if (a) v.addScaledVector(a, (f - 1) * v.dot(a)); else v.multiplyScalar(f); return v.add(m.pivot); };
      hud = `Scale: ${m.typed ? `[${m.typed}|]` : f.toFixed(3)} ${axName}`;
    }
    for (const [i, w] of m.orig) E.m.v[i] = toLocal(apply(w));
  }
  const l = H.V.axisLine;
  if (m.axis && m.kind !== 'I') { const a = axisVec(m); l.position.copy(m.pivot); l.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), a); (l.material as THREE.LineBasicMaterial).color.setHex(m.axis === 'n' ? 0xffffff : ({ x: 0xff3352, y: 0x8bdc00, z: 0x2890ff })[m.axis]); l.visible = true; }
  else l.visible = false;
  (document.getElementById('modalHud') as HTMLElement).textContent = hud;
  refresh();
}
export function endModal(ok: boolean) {
  const m = emodal; if (!m) return;
  emodal = null; H.V.axisLine.visible = false; (document.getElementById('modalHud') as HTMLElement).textContent = ''; document.body.classList.remove('modal');
  if (!ok) {
    if (m.kind === 'I') { E.m = m.base!; E.sel = m.baseSel!; }
    else for (const [i, w] of m.orig) E.m!.v[i] = toLocal(w);
    if (m.keepOnCancel) { write(); H.report(m.name); } else { H.popUndo(); refresh(); H.render(); }
    return;
  }
  write(); H.report(m.name);
}
export function modalKey(e: KeyboardEvent) {
  const m = emodal!, k = e.key, lk = k.toLowerCase();
  if (k === 'Escape') return endModal(false);
  if (k === 'Enter' || k === ' ') return endModal(true);
  if (k === 'Control' || k === 'Meta') { m.ctrl = true; return updateModal(); }
  if (k === 'Shift') { m.shift = true; return updateModal(); }
  if (m.kind !== 'I' && (lk === 'x' || lk === 'y' || lk === 'z')) {
    if (m.axis === lk) { if (!m.local) m.local = true; else { m.axis = m.normal ? 'n' : null; m.local = false; } } else { m.axis = lk; m.local = false; }
    return updateModal();
  }
  if (/^[0-9.]$/.test(k)) { m.typed += k; return updateModal(); }
  if (k === '-') { m.typed = m.typed.startsWith('-') ? m.typed.slice(1) : '-' + m.typed; return updateModal(); }
  if (k === 'Backspace') { m.typed = m.typed.slice(0, -1); return updateModal(); }
}
export function modalKeyUp(e: KeyboardEvent) { if (!emodal) return; if (e.key === 'Control' || e.key === 'Meta') emodal.ctrl = false; if (e.key === 'Shift') emodal.shift = false; updateModal(); }

// ------------------------------------------------------------------ operators
function doExtrude() {
  if (!E.sel.size) return H.report('Nothing selected', 'warn');
  H.pushUndo('Extrude');
  const r = extrude(E.m!, E.sel); E.sel = r.sel;
  const p = H.part(E.id)!; // keep indices stable until the move is confirmed: no write() here
  void p;
  refresh();
  const n = r.dir ? new THREE.Vector3(...r.dir).transformDirection(rootW().matrixWorld) : null;
  startModal('G', { normal: n, keepOnCancel: true, name: 'Extrude', undoPushed: true });
}
function doDuplicate() {
  if (!E.sel.size) return H.report('Nothing selected', 'warn');
  H.pushUndo('Duplicate'); E.sel = duplicateSel(E.m!, E.sel); refresh();
  startModal('G', { keepOnCancel: true, name: 'Duplicate', undoPushed: true });
}
function doLoopCut() {
  if (!loopEdge) { H.report('Point at an edge of a quad face', 'warn'); return; }
  const [a, b] = loopEdge; loopArm = false; preview.visible = false;
  op('Loop Cut', m => { const s = loopCut(m, a, b); return s.size ? s : undefined; }, 'Loop Cut and Slide');
  setSelMode(E.mode === 'face' ? 'edge' : E.mode);
}
export function hoverLoop(x: number, y: number) {
  if (!loopArm || !E.m) return;
  loopEdge = nearestEdge(x, y);
  const pts: number[] = [];
  if (loopEdge) {
    const m = E.m, { faces, edges: ring } = edgeRing(m, loopEdge[0], loopEdge[1]), mids = new Map(ring.map(([p, q]) => [ekey(p, q), [(m.v[p][0] + m.v[q][0]) / 2, (m.v[p][1] + m.v[q][1]) / 2, (m.v[p][2] + m.v[q][2]) / 2]]));
    for (const fi of faces) { const f = m.f[fi], ks = f.map((x2, i) => ekey(x2, f[(i + 1) % 4])).filter(k => mids.has(k)); if (ks.length >= 2) pts.push(...mids.get(ks[0])!, ...mids.get(ks[1])!); }
  }
  preview.geometry.dispose(); preview.geometry = new THREE.BufferGeometry(); preview.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  preview.visible = pts.length > 0;
}
const has = (n = 1) => { if (E.sel.size >= n) return true; H.report(n > 1 ? `Select at least ${n} vertices` : 'Nothing selected', 'warn'); return false; };
function separate() {
  const m = E.m!, faces = m.f.filter(f => faceSelected(f, E.sel));
  if (!faces.length) return H.report('Select faces to separate', 'warn');
  const p = H.part(E.id)!, q: BuiltPart = JSON.parse(JSON.stringify(p));
  q.id = Math.random().toString(36).slice(2); q.name = p.name + '.sep'; q.auto = false;
  H.pushUndo('Separate');
  writeEMesh(q, { v: m.v.map(x => [...x] as V), f: faces.map(f => [...f]), e: [] });
  deleteFaces(m, E.sel); E.sel.clear();
  H.newPart(q);
  write(); H.report(`Separated ${faces.length} face${faces.length > 1 ? 's' : ''} into ${q.name}`);
}
export const mergeItems = (): MenuItem[] => [
  { label: 'At Center', action: () => has(2) && op('Merge', m => new Set([merge(m, E.sel, centroid(m.v, [...E.sel]))])) },
  { label: 'At Cursor', action: () => has(1) && op('Merge', m => new Set([merge(m, E.sel, toLocal(H.V.cursor))])) },
  { label: 'At First', action: () => has(2) && op('Merge', m => new Set([merge(m, E.sel, m.v[[...E.sel][0]])])) },
  { label: 'By Distance', action: () => has(2) && op('Merge by Distance', m => { const n = mergeByDistance(m, E.sel); H.report(`Removed ${n} vertices`); }, '') },
];
export const deleteItems = (): MenuItem[] => [
  { label: 'Vertices', action: () => has() && op('Delete Vertices', m => { deleteVerts(m, E.sel); return new Set(); }) },
  { label: 'Edges', action: () => has(2) && op('Delete Edges', m => { deleteEdges(m, E.sel); return new Set(); }) },
  { label: 'Faces', action: () => has(3) && op('Delete Faces', m => { deleteFaces(m, E.sel); return new Set(); }) },
];
const normalItems = (): MenuItem[] => [
  { label: 'Recalculate Outside', shortcut: 'Shift N', action: () => op('Recalculate Normals', m => { recalcNormals(m, E.sel); }) },
  { label: 'Recalculate Inside', action: () => op('Recalculate Normals', m => { recalcNormals(m, E.sel, true); }) },
  { label: 'Flip', action: () => op('Flip Normals', m => { flip(m, E.sel); }) },
];
const shading = (smooth: boolean) => { const p = H.part(E.id)!; H.pushUndo(smooth ? 'Shade Smooth' : 'Shade Flat'); p.smooth = smooth; E.changed = true; H.changed(); attach(); refresh(); H.render(); };
export const meshMenu = (): MenuItem[] => [
  { label: 'Transform', sub: [{ label: 'Move', shortcut: 'G', action: () => startModal('G') }, { label: 'Rotate', shortcut: 'R', action: () => startModal('R') }, { label: 'Scale', shortcut: 'S', action: () => startModal('S') }] },
  { sep: true },
  { label: 'Extrude', shortcut: 'E', action: doExtrude }, { label: 'Inset Faces', shortcut: 'I', action: () => startModal('I') },
  { label: 'Loop Cut', shortcut: 'Ctrl R', action: armLoop },
  { label: 'Subdivide', action: () => has(3) && op('Subdivide', m => subdivide(m, E.sel)) },
  { label: 'Fill (Make Edge/Face)', shortcut: 'F', action: () => has(2) && op('Make Edge/Face', m => { if (!fill(m, E.sel)) H.report('Select 2 or more vertices', 'warn'); }) },
  { label: 'Duplicate', shortcut: 'Shift D', action: doDuplicate },
  { label: 'Separate Selection', shortcut: 'P', action: separate },
  { sep: true },
  { label: 'Merge', shortcut: 'M', sub: mergeItems },
  { label: 'Normals', shortcut: 'Alt N', sub: normalItems },
  { label: 'Shading', sub: [{ label: 'Shade Smooth', action: () => shading(true) }, { label: 'Shade Flat', action: () => shading(false) }] },
  { sep: true },
  { label: 'Delete', shortcut: 'X', sub: deleteItems },
];
export const editSelectMenu = (): MenuItem[] => [
  { label: 'All', shortcut: 'A', action: selectAll }, { label: 'None', shortcut: 'Alt A', action: selectNone }, { label: 'Invert', shortcut: 'Ctrl I', action: invert },
  { sep: true }, { label: 'Select Linked', shortcut: 'Ctrl L', action: () => selectLinked(false) }, { label: 'Pick Linked', shortcut: 'L', action: () => selectLinked(true) },
  { sep: true }, ...(['vert', 'edge', 'face'] as SelMode[]).map((s, i) => ({ label: ['Vertex', 'Edge', 'Face'][i] + ' Select Mode', shortcut: String(i + 1), checked: E.mode === s, action: () => setSelMode(s) })),
];
export const editAddMenu = (): MenuItem[] => ['Plane', 'Cube', 'Circle', 'UV Sphere', 'Cylinder', 'Cone', 'Torus'].map(n => ({ label: n, icon: 'mesh', action: () => addInto(n) }));
function addInto(kind: string) {
  const o = H.addMesh(kind); if (!o) return;
  const c = toLocal(H.V.cursor.clone());
  op('Add ' + kind, m => append(m, { ...o, v: o.v.map(q => [q[0] + c[0], q[1] + c[1], q[2] + c[2]] as V) }), `Added ${kind} to the mesh`);
}
function armLoop() { loopArm = true; loopEdge = null; H.report('Loop Cut: point at an edge and click (Esc cancels)'); hoverLoop(H.mouse().x, H.mouse().y); }
export function contextMenu(x: number, y: number) {
  H.popup([
    { label: 'Extrude', shortcut: 'E', action: doExtrude }, { label: 'Inset Faces', shortcut: 'I', action: () => startModal('I') }, { label: 'Subdivide', action: () => has(3) && op('Subdivide', m => subdivide(m, E.sel)) },
    { label: 'Loop Cut', shortcut: 'Ctrl R', action: armLoop }, { label: 'Fill', shortcut: 'F', action: () => has(2) && op('Make Edge/Face', m => { fill(m, E.sel); }) },
    { sep: true }, { label: 'Merge', sub: mergeItems }, { label: 'Normals', sub: normalItems }, { label: 'Separate', shortcut: 'P', action: separate },
    { sep: true }, { label: 'Delete', sub: deleteItems },
  ], x, y, ['Vertex', 'Edge', 'Face'][['vert', 'edge', 'face'].indexOf(E.mode)] + ' Context Menu');
}

/** Edit-mode keys. Returns true when handled. */
export function editKey(e: KeyboardEvent): boolean {
  if (!E.on) return false;
  if (emodal) { e.preventDefault(); modalKey(e); return true; }
  const k = e.key, lk = k.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, { x, y } = H.mouse();
  const go = (fn: () => void) => { e.preventDefault(); fn(); return true; };
  if (loopArm && k === 'Escape') return go(() => { loopArm = false; preview.visible = false; H.report('Loop Cut cancelled'); });
  if (k === 'Tab') return go(exitEdit);
  if (!ctrl && !e.altKey && /^Digit[123]$/.test(e.code)) return go(() => setSelMode((['vert', 'edge', 'face'] as SelMode[])[+e.code.slice(5) - 1]));
  if (ctrl && lk === 'r') return go(armLoop);
  if (ctrl && lk === 'l') return go(() => selectLinked(false));
  if (ctrl && lk === 'i') return go(invert);
  if (ctrl) return false;
  if (e.shiftKey && lk === 'd') return go(doDuplicate);
  if (e.shiftKey && lk === 'n') return go(() => op('Recalculate Normals', m => { recalcNormals(m, E.sel); }));
  if (e.shiftKey && lk === 'a') return go(() => H.popup(editAddMenu(), x, y, 'Add Mesh'));
  if (e.altKey && lk === 'a') return go(selectNone);
  if (e.altKey && lk === 'n') return go(() => H.popup(normalItems(), x, y, 'Normals'));
  if (e.altKey || e.shiftKey) return false;
  if (lk === 'g') return go(() => startModal('G'));
  if (lk === 'r') return go(() => startModal('R'));
  if (lk === 's') return go(() => startModal('S'));
  if (lk === 'e') return go(doExtrude);
  if (lk === 'i') return go(() => startModal('I'));
  if (lk === 'f') return go(() => has(2) && op('Make Edge/Face', m => { if (!fill(m, E.sel)) H.report('Select 2 or more vertices', 'warn'); }));
  if (lk === 'm') return go(() => H.popup(mergeItems(), x, y, 'Merge'));
  if (lk === 'x' || k === 'Delete' || k === 'Backspace') return go(() => H.popup(deleteItems(), x, y, 'Delete'));
  if (lk === 'p') return go(separate);
  if (lk === 'l') return go(() => selectLinked(true));
  if (lk === 'a') return go(selectAll);
  if (lk === 'h') return go(() => H.report('Hiding parts of a mesh isn’t supported; use X-ray (Alt Z) to work through it', 'warn'));
  if (lk === 'w') return go(() => contextMenu(x, y));
  return false;
}

// ------------------------------------------------------------------ info for panels
export function stats() {
  const m = E.m; if (!m) return '';
  const es = [...edges(m).values()];
  return `Verts ${E.sel.size}/${m.v.length} | Edges ${es.filter(e => E.sel.has(e.a) && E.sel.has(e.b)).length}/${es.length} | Faces ${m.f.filter(f => faceSelected(f, E.sel)).length}/${m.f.length}`;
}
/** Median of the selection in world (Blender) coordinates. */
export function median(): THREE.Vector3 | null { return E.on && E.sel.size ? medianW() : null; }
export function setMedian(axis: number, value: number, final: boolean) {
  if (!E.m || !E.sel.size) return;
  const c = medianW(), d = new THREE.Vector3().setComponent(axis, value - c.getComponent(axis));
  for (const i of E.sel) E.m.v[i] = toLocal(toWorld(E.m.v[i]).add(d));
  if (final) write(); else refresh();
}
export const faceNormalW = () => { if (!E.m) return null; const fs = E.m.f.filter(f => faceSelected(f, E.sel)); if (!fs.length) return null; const n = normal(E.m.v, fs[0]); return new THREE.Vector3(...n).transformDirection(rootW().matrixWorld); };
