/**
 * Editing a robot's world in the 3D view.
 *
 * Mover: click any object (a box, a block, a wall) to select it; move, turn and resize
 * handles appear on it, with a small bar naming it. New objects come in selected.
 *
 * Draw: a toolbar over the view. Line draws a dark line on the floor that line sensors
 * follow; Wall drags a straight wall the robot bumps into and distance sensors see;
 * Start sets where (and which way) the robot starts; Finish sets a goal zone that times
 * each run; Erase removes what you click. Left-drag draws, right-drag still looks around.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { App } from './app';
import { $, toast } from './dom';
import { BuiltProduct } from '../scene/built';
import { distToLine } from '../app/kinematics';
import type { DrawnLine, Obstacle, World } from '../app/project';
import { firmwareRunning } from './elec';
import { crashActive } from './crash';
import { floorAt } from './worlddrag';
import { track } from './track';

let A: App;
let tc: TransformControls;
let sel: number | null = null;
let gizmoDragging = false;
type Tool = 'line' | 'wall' | 'start' | 'finish' | 'erase';
let tool: Tool | null = null;

const world = (): World | undefined => A.project.product.built?.robot?.world;
const prod = () => (A.product instanceof BuiltProduct ? A.product : null);
const nameOf = (o: Obstacle) => o.name ?? (o.shape === 'cyl' ? 'Cylinder' : 'Box');
const r0 = (v: number) => Math.round(v);

export function initWorldEdit(app: App) {
  A = app;
  tc = new TransformControls(A.viewport.camera, A.viewport.renderer.domElement);
  tc.setSize(0.8); tc.setTranslationSnap(5); tc.setRotationSnap(15 * Math.PI / 180);
  A.viewport.scene.add(tc);
  setMode('translate');
  tc.addEventListener('dragging-changed', (e: any) => {
    gizmoDragging = e.value; A.viewport.controls.enabled = !e.value;
    const p = prod(); if (p) p.draggingObj = e.value ? sel : null;
    if (!e.value) commitGizmo();
  });

  const vp = $('#viewport');
  const bar = document.createElement('div'); bar.id = 'weBar'; bar.hidden = true;
  bar.innerHTML = `<b id="weName"></b><div class="seg2" id="weMode"><button data-g="translate" title="Move (W)">Move</button><button data-g="rotate" title="Turn (E)">Turn</button><button data-g="scale" title="Resize (R)">Resize</button></div><button class="btn" id="weDel" title="Remove it (Delete)">Delete</button><button class="wex" id="weClose" title="Done (Esc)" aria-label="Done">×</button>`;
  vp.appendChild(bar);
  bar.querySelectorAll<HTMLElement>('[data-g]').forEach(b => (b.onclick = () => setMode(b.dataset.g as any)));
  $('#weDel').onclick = () => removeSelected();
  $('#weClose').onclick = () => selectWorldObject(null);

  const db = document.createElement('div'); db.id = 'drawBar'; db.hidden = true;
  db.innerHTML = `<div class="dbtools">${([['line', 'Line'], ['wall', 'Wall'], ['start', 'Start'], ['finish', 'Finish'], ['erase', 'Erase']] as const).map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')}</div>
    <span class="dbhint" id="dbHint"></span><button class="btn" id="dbClear">Clear drawing</button><button class="btn primary" id="dbDone">Done</button>`;
  vp.appendChild(db);
  db.querySelectorAll<HTMLElement>('[data-t]').forEach(b => (b.onclick = () => setTool(b.dataset.t as Tool)));
  $('#dbDone').onclick = () => closeDraw();
  $('#dbClear').onclick = () => clearDrawing();

  // drawing takes left-button presses before the camera and the click-to-select see them
  const cv = A.viewport.renderer.domElement;
  cv.addEventListener('pointerdown', e => { if (tool && e.button === 0) { e.stopImmediatePropagation(); e.preventDefault(); drawDown(e); } }, true);
  // a click on empty space (not a drag) clears the selection
  let press: { x: number; y: number; had: number | null } | null = null;
  cv.addEventListener('pointerdown', e => { press = { x: e.clientX, y: e.clientY, had: sel }; });
  cv.addEventListener('pointerup', e => {
    if (!press || tool || gizmoDragging || (tc as any).axis) { press = null; return; }
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4, had = press.had; press = null;
    if (!moved && sel !== null && sel === had && !hitObstacle(e)) selectWorldObject(null);
  });
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select') || document.body.classList.contains('at-home')) return;
    if (tool && e.key === 'Escape') { e.preventDefault(); closeDraw(); return; }
    if (sel === null) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') selectWorldObject(null);
    else if (k === 'delete' || k === 'backspace') removeSelected();
    else if (k === 'w') setMode('translate'); else if (k === 'e') setMode('rotate'); else if (k === 'r') setMode('scale');
    else return;
    e.preventDefault(); e.stopImmediatePropagation(); // ahead of the part editor's own shortcuts
  }, true);
}

// ------------------------------------------------------------------ mover
/** The pointer is on the mover's handles (main.ts leaves the press to it). */
export const worldGizmoBusy = () => gizmoDragging || (!!tc?.object && !!(tc as any).axis);

/** Select an object in the robot's world (null: none). Its handles appear on the next frame. */
export function selectWorldObject(i: number | null) {
  sel = i;
  if (i !== null && A.selected) { A.selected = null; A.product.highlight(null); } // one set of handles at a time
  if (i === null) tc.detach();
  paintBar();
}
function setMode(m: 'translate' | 'rotate' | 'scale') {
  tc.setMode(m);
  tc.showX = m !== 'rotate'; tc.showZ = m !== 'rotate'; tc.showY = m !== 'translate'; // slide on the floor, turn about the vertical
  document.querySelectorAll<HTMLElement>('#weMode [data-g]').forEach(b => b.classList.toggle('on', b.dataset.g === m));
}
function paintBar() {
  const o = sel !== null ? world()?.obstacles[sel] : undefined;
  $('#weBar').hidden = !o || !!tool;
  if (o) $('#weName').textContent = nameOf(o);
}
function hitObstacle(e: PointerEvent) {
  const p = prod(); if (!p) return false;
  const h = A.viewport.hit(e, p.worldObjects());
  return h?.object.userData.obstacle !== undefined;
}
function removeSelected() {
  const w = world(); if (sel === null || !w?.obstacles[sel]) return;
  if (firmwareRunning()) { toast('Stop the code to change the world'); return; }
  const [o] = w.obstacles.splice(sel, 1);
  selectWorldObject(null);
  A.changed('product'); track('model', `Robot world: removed the ${nameOf(o).toLowerCase()}`); refreshPanel();
}
/** Handles released: write where the object ended up into the world. */
function commitGizmo() {
  const w = world(), o = sel !== null ? w?.obstacles[sel] : undefined, m = tc.object;
  if (!w || !o || !m) return;
  const sc = m.scale;
  const size: [number, number, number] = o.shape === 'cyl'
    ? (() => { const d = r0(o.size[0] * (sc.x + sc.z) / 2); return [Math.max(5, d), Math.max(5, r0(o.size[1] * sc.y)), Math.max(5, d)]; })()
    : [Math.max(5, r0(o.size[0] * sc.x)), Math.max(5, r0(o.size[1] * sc.y)), Math.max(5, r0(o.size[2] * sc.z))];
  const half = w.size / 2 - Math.max(size[0], size[2]) / 2;
  const pos: [number, number] = [r0(Math.max(-half, Math.min(half, m.position.x))), r0(Math.max(-half, Math.min(half, m.position.z)))];
  const rot = r0(new THREE.Euler().setFromQuaternion(m.quaternion, 'YXZ').y * 180 / Math.PI);
  const before = JSON.stringify([o.pos, o.rot ?? 0, o.size]);
  o.pos = pos; o.rot = rot; o.size = size;
  if (JSON.stringify([o.pos, o.rot, o.size]) === before) return;
  A.changed('product'); track('model', `Robot world: ${tc.mode === 'scale' ? 'resized' : tc.mode === 'rotate' ? 'turned' : 'moved'} the ${nameOf(o).toLowerCase()}`); refreshPanel();
}

/** Per frame: keep the handles on the selected object (its mesh is rebuilt when the world changes). */
export function worldEditFrame() {
  if (!tc) return;
  const p = prod(), w = world(), o = sel !== null ? w?.obstacles[sel] : undefined;
  if (A.selected && sel !== null) selectWorldObject(null); // a part was picked in Design
  if (!p || !o || crashActive() || document.body.classList.contains('at-home') || document.body.classList.contains('present')) {
    if (tc.object) tc.detach();
    if (sel !== null && !o) selectWorldObject(null);
    if (tool && !w) closeDraw();
    return;
  }
  if (firmwareRunning() && !gizmoDragging) { if (tc.object) tc.detach(); return; } // the code owns the world while it runs
  if (!gizmoDragging) {
    const mesh = p.worldObjects().find(m => m.userData.obstacle === sel);
    if (mesh && tc.object !== mesh) tc.attach(mesh);
  }
}

// ------------------------------------------------------------------ draw
const HINTS: Record<Tool, string> = {
  line: 'Drag on the floor to draw a line. Line sensors follow it. End near the start to close the loop.',
  wall: 'Drag to draw a straight wall. The robot bumps into it and distance sensors see it.',
  start: 'Click where the robot starts, and drag to point the way it faces.',
  finish: 'Click to place the finish; drag to make it bigger. Reaching it while the code runs shows the time.',
  erase: 'Click a line, wall, object or marker to remove it.',
};
export function openDraw() {
  if (!world()) { toast('Pick a world for the robot first'); return; }
  selectWorldObject(null);
  $('#drawBar').hidden = false;
  setTool('line');
}
export const drawing = () => !!tool;
function closeDraw() { tool = null; $('#drawBar').hidden = true; A.viewport.renderer.domElement.style.cursor = ''; paintBar(); }
function setTool(t: Tool) {
  tool = t;
  document.querySelectorAll<HTMLElement>('#drawBar [data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $('#dbHint').textContent = HINTS[t] + ' Right-drag to look around.';
  A.viewport.renderer.domElement.style.cursor = t === 'erase' ? 'pointer' : 'crosshair';
  paintBar();
}
function clearDrawing() {
  const w = world(); if (!w) return;
  const walls = w.obstacles.filter(o => o.name === 'Wall').length;
  if (!(w.lines?.length || w.start || w.finish || walls)) { toast('Nothing drawn yet'); return; }
  if (!window.confirm('Remove the lines, walls, start and finish you drew?')) return;
  delete w.lines; delete w.start; delete w.finish; w.obstacles = w.obstacles.filter(o => o.name !== 'Wall');
  selectWorldObject(null);
  A.changed('product'); track('model', 'Robot world: cleared the drawing'); refreshPanel();
}

function drawDown(e: PointerEvent) {
  const w = world(), p = prod(); if (!w || !p || !tool) return;
  if (firmwareRunning()) { toast('Stop the code to draw'); return; }
  const at = (ev: PointerEvent): [number, number] | null => {
    const q = floorAt(A, p, ev); if (!q) return null;
    const h = w.size / 2 - 10;
    return [r0(Math.max(-h, Math.min(h, q.x))), r0(Math.max(-h, Math.min(h, q.z)))];
  };
  const a = at(e); if (!a) return;
  // while dragging, a light outline shows what you're drawing; the world is rebuilt once, on release
  const pv = new THREE.Group(); pv.position.y = 1; p.mm.add(pv);
  const ink = new THREE.LineBasicMaterial({ color: 0x1a73e8, depthTest: false }), solid = new THREE.MeshBasicMaterial({ color: 0x1a73e8, transparent: true, opacity: 0.35, depthTest: false });
  const outline = (pts: [number, number][], closed = false) => { const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, 0, z))); const l = closed ? new THREE.LineLoop(g, ink) : new THREE.Line(g, ink); l.renderOrder = 10; return l; };
  const ring = (cx: number, cz: number, r: number) => outline(Array.from({ length: 40 }, (_, i) => [cx + Math.cos(i / 40 * Math.PI * 2) * r, cz + Math.sin(i / 40 * Math.PI * 2) * r] as [number, number]), true);
  let raf = 0;
  // the draft stays out of the world until release (the world redraws whenever it changes)
  const line: DrawnLine = { points: [a], width: 20 };
  const wall: Obstacle = { shape: 'box', pos: a, size: [10, 120, 16], rot: 0, color: '#bdb7ab', name: 'Wall', material: 'fixed' };
  const start = { pos: a, yaw: w.start?.yaw ?? 0 }, finish = { pos: a, r: w.finish?.r ?? 100 };
  const draw = (): THREE.Object3D[] => {
    if (tool === 'line') return [outline(line.points)];
    if (tool === 'wall') { const b = new THREE.Mesh(new THREE.BoxGeometry(wall.size[0], wall.size[1], wall.size[2]), solid); b.position.set(wall.pos[0], wall.size[1] / 2, wall.pos[1]); b.rotation.y = (wall.rot ?? 0) * Math.PI / 180; b.renderOrder = 10; return [b]; }
    if (tool === 'start') { const [x, z] = start.pos, d = start.yaw * Math.PI / 180; return [ring(x, z, 76), outline([[x, z], [x + Math.sin(d) * 120, z + Math.cos(d) * 120]])]; }
    if (tool === 'finish') return [ring(finish.pos[0], finish.pos[1], finish.r)];
    return [];
  };
  const preview = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; pv.traverse((o: any) => { if (o !== pv) o.geometry?.dispose(); }); pv.clear(); for (const o of draw()) pv.add(o); }); };
  const endPreview = () => { cancelAnimationFrame(raf); raf = 0; pv.traverse((o: any) => { if (o !== pv) o.geometry?.dispose(); }); p.mm.remove(pv); ink.dispose(); solid.dispose(); };
  let move: (ev: PointerEvent) => void = () => {}, up: () => void = () => {};
  if (tool === 'line') {
    move = ev => { const b = at(ev); const last = line.points[line.points.length - 1]; if (b && Math.hypot(b[0] - last[0], b[1] - last[1]) >= 12) { line.points.push(b); preview(); } };
    up = () => {
      const len = line.points.reduce((s, q, i) => s + (i ? Math.hypot(q[0] - line.points[i - 1][0], q[1] - line.points[i - 1][1]) : 0), 0);
      if (line.points.length < 2 || len < 30) return;
      const f = line.points[0], z = line.points[line.points.length - 1];
      if (len > 200 && Math.hypot(f[0] - z[0], f[1] - z[1]) < 40) { line.points.pop(); line.closed = true; }
      (w.lines ??= []).push(line); commit(`drew a ${line.closed ? 'closed ' : ''}line`);
    };
  } else if (tool === 'wall') {
    const set = (b: [number, number]) => { const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz); wall.pos = [r0((a[0] + b[0]) / 2), r0((a[1] + b[1]) / 2)]; wall.size = [Math.max(10, r0(len)), 120, 16]; wall.rot = r0(Math.atan2(-dz, dx) * 180 / Math.PI); };
    move = ev => { const b = at(ev); if (b) { set(b); preview(); } };
    up = () => { if (wall.size[0] < 30) return; w.obstacles.push(wall); commit('drew a wall'); };
  } else if (tool === 'start') {
    move = ev => { const b = at(ev); if (b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 15) { start.yaw = r0(Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI); preview(); } };
    up = () => { w.start = start; commit('set the start'); toast('Start set: Reset position and Run begin here'); };
  } else if (tool === 'finish') {
    move = ev => { const b = at(ev); if (b) { finish.r = Math.max(50, Math.min(600, r0(Math.hypot(b[0] - a[0], b[1] - a[1])))); preview(); } };
    up = () => { w.finish = finish; commit('set the finish'); };
  } else if (tool === 'erase') { endPreview(); erase(e, a); return; }
  preview();
  const done = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', done); window.removeEventListener('pointercancel', done); endPreview(); up(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', done); window.addEventListener('pointercancel', done);
}
function erase(e: PointerEvent, [x, z]: [number, number]) {
  const w = world()!, p = prod()!;
  const h = A.viewport.hit(e, p.worldObjects()), i = h?.object.userData.obstacle as number | undefined;
  if (i !== undefined && w.obstacles[i]) { const [o] = w.obstacles.splice(i, 1); commit(`erased the ${nameOf(o).toLowerCase()}`); return; }
  const li = (w.lines ?? []).findIndex(l => distToLine(l.points, !!l.closed, x, z) <= l.width / 2 + 20);
  if (li >= 0) { w.lines!.splice(li, 1); if (!w.lines!.length) delete w.lines; commit('erased a line'); return; }
  if (w.finish && Math.hypot(x - w.finish.pos[0], z - w.finish.pos[1]) <= w.finish.r) { delete w.finish; commit('erased the finish'); return; }
  if (w.start && Math.hypot(x - w.start.pos[0], z - w.start.pos[1]) <= 90) { delete w.start; commit('erased the start'); return; }
  if (w.track && distToLine(w.track.points, true, x, z) <= w.track.width / 2 + 20) { delete w.track; commit('erased the track'); return; }
  toast('Nothing to erase there');
}
function commit(what: string) { A.changed('product'); track('model', `Robot world: ${what}`); refreshPanel(); }

// the robot panel lists the world's objects: redraw it after changes made here
let panelRefresh: () => void = () => {};
export function onWorldEdited(f: () => void) { panelRefresh = f; }
function refreshPanel() { panelRefresh(); }

(globalThis as any).__worldGizmo = () => tc?.object ?? null; // handy for debugging from the console
