import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { App } from './app';
import { $, $$, el, esc, opts, toast } from './dom';
import { BuiltProduct } from '../scene/built';
import { newUid, defaultAutoOpts, type BindRole, type BuiltModel, type BuiltPart, type ShapeKind, type Joint, type JointType } from '../app/project';
import { autoBuild, mergeRebuild } from '../app/autobuild';
import { screenPart, displayComps } from '../app/screenpart';
import { bounds, fitBuilt } from '../app/fit';
import { COMPONENTS } from '../hw/library/components';
import { track } from './track';

/**
 * Design-mode panels for built models: part list, shape palette, inspector,
 * a move/rotate/resize gizmo, fit check, role summary and auto build.
 */
const SHAPES: Record<ShapeKind, { label: string; size: [number, number, number]; param?: number }> = {
  rbox: { label: 'Rounded box', size: [40, 30, 20], param: 3 },
  box: { label: 'Box', size: [20, 20, 20] },
  cyl: { label: 'Cylinder', size: [20, 20, 10] },
  tube: { label: 'Tube / ring', size: [30, 30, 5], param: 22 },
  sphere: { label: 'Sphere', size: [20, 20, 20] },
  torus: { label: 'Torus', size: [30, 30, 4] },
  cone: { label: 'Cone', size: [20, 20, 20], param: 0.5 },
  disc: { label: 'Disc (flat)', size: [30, 30, 0.5] },
  rect: { label: 'Panel (flat)', size: [40, 30, 0.5] },
  mesh: { label: 'Mesh (edited in the 3D modeler)', size: [20, 20, 20] },
};
const ROLES: Record<BindRole, string> = { body: 'Body (static)', dial: 'Dial (rotates)', screen: 'Screen', press: 'Press surface', led: 'LED / light', ignore: 'Hidden' };
const KINDS: Record<string, string> = { ext: 'Exterior detail', shell: 'Enclosure (shell)', internal: 'Internal component' };
const FIN: Record<string, string> = { matte: 'Matte', satin: 'Satin', gloss: 'Gloss', soft: 'Soft-touch', brushed: 'Brushed metal', polished: 'Polished metal', clear: 'Clear / translucent' };
const PARAM: Partial<Record<ShapeKind, [string, number, number, number]>> = { rbox: ['Corner r', 0, 50, 0.5], tube: ['Inner Ø', 0, 400, 0.5], cone: ['Top ratio', 0, 1, 0.05] };

let A: App;
let tc: TransformControls | null = null;
let dragging = false;

export const isBuilt = (app: App) => app.product instanceof BuiltProduct;
const model = (): BuiltModel => A.project.product.built!;
const prod = () => A.product as BuiltProduct;
const sel = () => model().parts.find(p => p.id === A.selected) ?? null;

export { newBuiltModel } from '../app/project';

/** Pointer is over the gizmo (main.ts skips click-to-select then). */
export const gizmoBusy = () => dragging || !!(tc as any)?.axis;

export function initModeler(app: App) {
  A = app;
  $('#shapeBtns').innerHTML = Object.entries(SHAPES).filter(([k]) => k !== 'mesh').map(([k, s]) => `<button data-s="${k}">${s.label}</button>`).join('');
  $$('#shapeBtns button').forEach(b => (b.onclick = () => addShape(b.dataset.s as ShapeKind)));
  $('#bAutoBuild').onclick = () => runAutoBuild();
  const bindOpt = (id: string, k: string, num = false) => ($(id).onchange = e => {
    const t = e.target as HTMLInputElement, a: any = autoOpts();
    a[k] = t.type === 'checkbox' ? t.checked : num ? Math.max(0, +t.value || 0) : t.value;
    A.changed('product');
  });
  bindOpt('#abStyle', 'style'); bindOpt('#abWall', 'wall', true); bindOpt('#abClear', 'clearance', true); bindOpt('#abMount', 'mount'); bindOpt('#abBattery', 'battery');
  ($('#mXray') as HTMLInputElement).onchange = e => { if (!isBuilt(A)) return; model().xray = (e.target as HTMLInputElement).checked; prod().applyXray(); A.changed('product'); };

  tc = new TransformControls(A.viewport.camera, A.viewport.renderer.domElement);
  tc.setSpace('local'); tc.setTranslationSnap(1); tc.setRotationSnap(15 * Math.PI / 180); tc.setSize(0.8);
  A.viewport.scene.add(tc);
  tc.addEventListener('dragging-changed', (e: any) => {
    dragging = e.value; A.viewport.controls.enabled = !e.value;
    if (!isBuilt(A)) return;
    const root = tc!.object;
    if (e.value) { prod().frozen = root ?? null; return; }
    prod().frozen = null;
    if (root) bake(root);
  });
  tc.addEventListener('objectChange', () => { const r = tc!.object; if (r && isBuilt(A)) { liveWrite(r); } });
  window.addEventListener('keydown', e => {
    if (A.mode !== 'design' || !isBuilt(A) || document.body.classList.contains('at-home')) return;
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    const p = sel();
    if (e.key === 'w') tc!.setMode('translate');
    else if (e.key === 'e') tc!.setMode('rotate');
    else if (e.key === 'r') tc!.setMode('scale');
    else if (p && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removePart(p); }
    else if (p && (e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); duplicate(p); }
    else return;
    syncGizmoButtons();
  });
  $$('#gizmoMode button').forEach(b => (b.onclick = () => { tc!.setMode(b.dataset.g as any); syncGizmoButtons(); }));
}

/** Auto-build options: the built model's, or held here until the first build. */
let pendingAuto = defaultAutoOpts();
function autoOpts() { return A.project.product.built?.auto ?? pendingAuto; }

function syncGizmoButtons() { $$('#gizmoMode button').forEach(b => b.classList.toggle('on', b.dataset.g === tc?.mode)); }

/** Keep the gizmo on the selected part (design mode, built model only). */
export function syncGizmo(app: App) {
  if (!tc) return;
  const root = app.mode === 'design' && isBuilt(app) && app.selected ? prod().roots.get(app.selected) : null;
  if (root && root.visible) { if (tc.object !== root) { app.product.resetDial(); app.product.explode(0); tc.attach(root); } }
  else tc.detach();
  tc.visible = !!tc.object;
}

const D2R = Math.PI / 180, r1 = (v: number) => Math.round(v * 10) / 10;
/** During a drag, write the root's transform into the part and the inspector fields. */
function liveWrite(root: THREE.Object3D) {
  const p = (root.userData as any).part as BuiltPart;
  const rest = prod().restTransform(root), e = new THREE.Euler().setFromQuaternion(rest.quat, 'XYZ');
  const before = [...p.pos];
  p.pos = [rest.pos.x, rest.pos.y, rest.pos.z].map(r1) as any;
  p.rot = [e.x, e.y, e.z].map(v => r1(v / D2R)) as any;
  // a robot part carries its joint and everything attached to it
  const d = p.pos.map((v, k) => v - before[k]);
  if (d.some(v => v)) {
    if (p.joint) p.joint.pivot = p.joint.pivot.map((v, k) => r1(v + d[k])) as any;
    const kids = new Set([p.id]); let grew = true;
    while (grew) { grew = false; for (const q of model().parts) if (q.parent && kids.has(q.parent) && !kids.has(q.id)) { kids.add(q.id); grew = true; q.pos = q.pos.map((v, k) => r1(v + d[k])) as any; if (q.joint) q.joint.pivot = q.joint.pivot.map((v, k) => r1(v + d[k])) as any; } }
    if (kids.size > 1) moved = true;
  }
  const sz = [0, 1, 2].map(k => r1(p.size[k] * (root.scale as any).getComponent(k)));
  setFields(p, sz as any);
}
function bake(root: THREE.Object3D) {
  const p = (root.userData as any).part as BuiltPart;
  liveWrite(root);
  if (root.scale.x !== 1 || root.scale.y !== 1 || root.scale.z !== 1) {
    p.size = [0, 1, 2].map(k => Math.max(0.1, r1(p.size[k] * (root.scale as any).getComponent(k)))) as any;
    if (p.shape === 'tube' && p.param) p.param = r1(p.param * root.scale.x);
    root.scale.set(1, 1, 1);
  }
  moved = false;
  rebuild();
}
let moved = false;

function rebuild() {
  prod().build();
  syncGizmo(A);
  renderModel(A);
  A.changed('product');
}

function setFields(p: BuiltPart, size = p.size) {
  const set = (id: string, v: number) => { const i = document.getElementById(id) as HTMLInputElement | null; if (i && document.activeElement !== i) i.value = String(v); };
  size.forEach((v, k) => set('bs' + k, v)); p.pos.forEach((v, k) => set('bp' + k, v)); p.rot.forEach((v, k) => set('br' + k, v));
}

function frontZ() { const b = bounds(model().parts); return b ? b.max[2] : 0; }

function addShape(k: ShapeKind) {
  const s = SHAPES[k], n = model().parts.filter(p => p.shape === k).length + 1;
  const p: BuiltPart = { id: newUid(), name: `${s.label.split(' ')[0]} ${n}`, shape: k, size: [...s.size], pos: [0, 0, r1(frontZ() + s.size[2] / 2 + 2)], rot: [0, 0, 0], param: s.param, color: '#b9bdc3', finish: 'satin', role: 'body', layer: 2 };
  if (!model().parts.length) p.pos[2] = 0;
  model().parts.push(p);
  prod().build(); A.selectPart(p.id); A.changed('product');
}
function duplicate(p: BuiltPart) {
  const q: BuiltPart = JSON.parse(JSON.stringify(p)); q.id = newUid(); q.name = p.name + ' copy'; q.auto = false; q.pos = [p.pos[0] + 5, p.pos[1] + 5, p.pos[2]];
  model().parts.splice(model().parts.indexOf(p) + 1, 0, q);
  prod().build(); A.selectPart(q.id); A.changed('product'); toast('Duplicated ' + p.name);
}
function removePart(p: BuiltPart) {
  model().parts.splice(model().parts.indexOf(p), 1);
  prod().build(); A.selectPart(null); A.changed('product'); toast('Deleted ' + p.name);
}

// ------------------------------------------------------------------ auto build
export async function runAutoBuild() {
  const prj = A.project, comps = prj.electronics.comps;
  const prev = prj.product.built, src = prj.product.source;
  if (src === 'parametric' || src === 'imported') {
    if (!window.confirm?.(`Replace the ${src === 'parametric' ? 'built-in thermostat' : 'imported CAD'} model with one auto-built from the electronics? You can switch back from the Project menu.`)) return;
  }
  const o = prev?.auto ?? autoOpts();
  const r = autoBuild(A.board(), comps, o);
  const m = mergeRebuild(src === 'built' && prev ? prev.parts : [], r, comps, o.battery);
  if (m.dropped.length) r.notes.unshift(`Removed ${m.dropped.join(', ')}: that hardware is no longer wired.`);
  prj.product.built = { parts: m.parts, xray: prev?.xray ?? false, auto: o, notes: r.notes };
  prj.product.source = 'built';
  await A.rebuildProduct();
  A.setMode('design');
  A.selectPart(null);
  A.changed('product');
  track('model', `Auto-built a ${r.style === 'round' ? 'round' : 'rectangular'} enclosure (${r.size.map(Math.round).join(' × ')} mm, ${r.parts.length} parts)`, true);
  toast(`Auto built ${r.parts.length} parts from ${comps.length} component${comps.length === 1 ? '' : 's'}${m.kept ? `, kept ${m.kept} of yours` : ''}`);
}

// ------------------------------------------------------------------ render
export function renderModel(app: App) {
  A = app;
  const built = isBuilt(app);
  $('#secBuild').style.display = built ? '' : 'none';
  $('#secModel').style.display = built ? '' : 'none';
  const ao = autoOpts();
  ($('#abStyle') as HTMLSelectElement).value = ao.style; ($('#abWall') as HTMLInputElement).value = String(ao.wall);
  ($('#abClear') as HTMLInputElement).value = String(ao.clearance); ($('#abMount') as HTMLSelectElement).value = ao.mount; ($('#abBattery') as HTMLInputElement).checked = ao.battery;
  const n = app.project.electronics.comps.length;
  $('#autoSrc').textContent = `${n} part${n === 1 ? '' : 's'} wired`;
  $('#autoSrc').title = `${app.board().name} + ${n} part${n === 1 ? '' : 's'} from Electronics`;
  $('#bAutoBuild').textContent = built && model().parts.some(p => p.auto) ? 'Rebuild from electronics' : 'Auto build from electronics';
  const notes = built ? model().notes : [];
  $('#autoNotes').innerHTML = notes.length ? '<ul>' + notes.map(t => `<li>${esc(t)}</li>`).join('') + '</ul>' : '';
  syncGizmo(app);
  if (!built) return;
  const m = model();

  // part list
  const list = $('#partList'); list.innerHTML = '';
  $('#partsNote').textContent = m.parts.length + ' parts';
  const groups: [string, BuiltPart[]][] = [['Outside', m.parts.filter(p => p.kind !== 'internal')], ['Inside', m.parts.filter(p => p.kind === 'internal')]];
  for (const [g, ps] of groups) {
    if (!ps.length) continue;
    list.appendChild(el('div', 'grp', g));
    for (const p of ps) {
      const d = el('div', 'item' + (app.selected === p.id ? ' on' : '') + (p.role === 'ignore' ? ' dim' : ''), `<span class="sw" style="background:${p.color}"></span><span class="nm">${esc(p.name)}</span>${p.array && p.array.n > 1 ? `<span class="meta">×${p.array.n}</span>` : ''}${p.role !== 'body' ? `<span class="rolechip">${p.role}</span>` : ''}`);
      d.onclick = () => app.selectPart(p.id);
      list.appendChild(d);
    }
  }
  if (!m.parts.length) list.appendChild(el('div', 'empty', 'No parts. Add a shape below, or auto build.'));

  // model section
  ($('#mXray') as HTMLInputElement).checked = m.xray;
  const b = bounds(m.parts);
  $('#modelSize').textContent = b ? b.size.map(v => Math.round(v)).join(' × ') + ' mm' : '';
  const fit = fitBuilt(m.parts);
  const bad = fit.filter(f => f.level !== 'ok').length;
  $('#mFitBadge').innerHTML = !fit.length ? '' : bad ? `<span class="badge bad">${bad} issue${bad > 1 ? 's' : ''}</span>` : '<span class="badge ok">Fits</span>';
  const fl = $('#mFitList'); fl.innerHTML = '';
  for (const f of fit) {
    const d = el('div', `chk ${f.level}`, `<i></i><span>${esc(f.msg)}</span>`);
    if (f.ids[0]) { d.style.cursor = 'pointer'; d.onclick = () => app.selectPart(f.ids[0]); }
    fl.appendChild(d);
  }
  if (!fit.length) fl.innerHTML = '<div class="empty">Mark parts as Internal to check they fit inside the shell.</div>';

  // roles vs electronics
  const pick = screenPart(m.parts, displayComps(app.project));
  const has = (r: BindRole) => r === 'screen' ? m.parts.filter(p => p.id === pick?.id) : m.parts.filter(p => p.role === r);
  const types = new Set(app.project.electronics.comps.map(c => c.type));
  const need: [string, BindRole, string][] = [['encoder', 'dial', 'Dial'], ['tft', 'screen', 'Screen'], ['neopixel', 'led', 'LED'], ['button', 'press', 'Press']];
  const rows: string[] = [];
  for (const r of ['dial', 'screen', 'press', 'led'] as BindRole[]) {
    const ps = has(r); if (!ps.length) continue;
    const segs = r === 'led' ? ps.reduce((a, p) => a + (p.segments && p.segments > 1 ? p.segments : 1), 0) : 0;
    rows.push(`<div class="chk ok"><i></i><span><b>${ROLES[r]}</b>: ${esc(ps.map(p => p.name).join(', '))}${segs > 1 ? ` · ${segs} lit segments` : ''}${r === 'screen' && pick?.why === 'wiring' ? ' <em>(the wired display; give another part the Screen role to override)</em>' : r === 'screen' && pick?.why === 'name' ? ' <em>(guessed from its name: no part is linked to the wired display; set a part\'s Role to Screen to choose)</em>' : ''}</span></div>`);
  }
  for (const [t, r, label] of need) if (types.has(t) && !has(r).length && !(r === 'press' && has('screen').length))
    rows.push(`<div class="chk warn"><i></i><span>${esc(COMPONENTS[t].name)} is wired, but no part has the <b>${label}</b> role, so it won't show on the model.</span></div>`);
  $('#mRoles').innerHTML = rows.join('') || '<div class="empty">No parts have a role yet. Give a part the Dial, Screen, Press or LED role so the electronics drive it.</div>';

  renderInspector(app);
}

function renderInspector(app: App) {
  const ins = $('#inspector'), p = sel();
  if (!p) { $('#selName').textContent = ''; ins.innerHTML = '<div class="empty">Click a part, or add a shape. Drag the handles to move it; press <b>W</b> / <b>E</b> / <b>R</b> to move, rotate or resize.</div>'; return; }
  $('#selName').textContent = p.name;
  const num = (id: string, v: number, step = 0.5) => `<input type="number" id="${id}" value="${v}" step="${step}">`;
  const tri = (lbl: string, pre: string, v: number[], step = 0.5) => `<div class="row tri"><label>${lbl}</label>${v.map((x, k) => num(pre + k, x, step)).join('')}</div>`;
  const prm = PARAM[p.shape];
  const segOk = p.role === 'led' && (p.shape === 'tube' || p.shape === 'torus');
  const a = p.array;
  ins.innerHTML = `
    <div class="row"><label>Name</label><input type="text" id="bName" value="${esc(p.name)}" style="flex:1"></div>
    <div class="row"><label>Shape</label><select id="bShape" style="flex:1">${opts(Object.fromEntries(Object.entries(SHAPES).map(([k, s]) => [k, s.label])), p.shape)}</select></div>
    <div class="row"><label>Role</label><select id="bRole" style="flex:1">${opts(ROLES as any, p.role)}</select></div>
    <div class="row"><label>Kind</label><select id="bKind" style="flex:1">${opts(KINDS, p.kind ?? 'ext')}</select></div>
    <div class="gizmo seg2" id="gizmoMode"><button data-g="translate">Move</button><button data-g="rotate">Rotate</button><button data-g="scale">Resize</button></div>
    <div class="row tri hd"><label></label><span>X</span><span>Y</span><span>Z</span></div>
    ${tri('Size mm', 'bs', p.size)}${tri('Position', 'bp', p.pos)}${tri('Rotation °', 'br', p.rot, 15)}
    ${prm ? `<div class="row"><label>${prm[0]}</label><input type="number" id="bParam" value="${p.param ?? 0}" min="${prm[1]}" max="${prm[2]}" step="${prm[3]}" style="flex:1"></div>` : ''}
    ${segOk ? `<div class="row"><label>Segments</label><input type="number" id="bSeg" value="${p.segments ?? 1}" min="1" max="256" step="1" style="flex:1"></div>` : ''}
    <div class="row"><label>Color</label><input type="color" id="bColor" value="${p.color}"><select id="bFinish" style="flex:1">${opts(FIN, p.finish)}</select></div>
    <div class="row"><label>Repeat</label><input type="number" id="bArrN" value="${a?.n ?? 1}" min="1" max="500" step="1" style="width:58px"><select id="bArrMode" style="flex:1"><option value="linear" ${a?.mode !== 'radial' ? 'selected' : ''}>in a line</option><option value="radial" ${a?.mode === 'radial' ? 'selected' : ''}>around a centre</option></select></div>
    ${a && a.n > 1 ? a.mode === 'radial' ? `<div class="row tri"><label>Centre</label>${num('bac0', a.center?.[0] ?? 0)}${num('bac1', a.center?.[1] ?? 0)}<span></span></div>` : tri('Step mm', 'bas', a.step ?? [10, 0, 0]) : ''}
    <div class="row"><label>Explode</label><input type="number" id="bLayer" value="${p.layer ?? 0}" step="1" style="flex:1" title="Exploded view moves the part this many steps along Z"></div>
    ${jointHTML(app, p)}
    ${p.auto ? `<label class="keep"><input type="checkbox" id="bKeep"> Keep this part when I rebuild <span>(auto-built parts are replaced)</span></label>` : ''}
    <div class="row" style="margin-top:10px"><button class="btn" id="bDup" style="flex:1">Duplicate</button><button class="btn" id="bMirror" style="flex:1" title="Copy mirrored across X = 0">Mirror X</button><button class="btn" id="bDel" style="flex:1">Delete</button></div>`;
  syncGizmoButtons();
  $$('#gizmoMode button').forEach(b => (b.onclick = () => { tc!.setMode(b.dataset.g as any); syncGizmoButtons(); }));
  const upd = (fn: () => void, full = false) => () => { fn(); if (full) { prod().build(); renderModel(app); } else { prod().build(); syncGizmo(app); refreshSide(app); } app.changed('product'); };
  const v = (id: string) => +($('#' + id) as HTMLInputElement).value;
  ($('#bName') as HTMLInputElement).oninput = e => { p.name = (e.target as HTMLInputElement).value; $('#selName').textContent = p.name; const it = $$('#partList .item.on .nm')[0]; if (it) it.textContent = p.name; app.changed('product'); };
  $('#bShape').onchange = upd(() => { const k = ($('#bShape') as HTMLSelectElement).value as ShapeKind; if (k === 'mesh' && !p.mesh) { toast('Open the 3D modeler and press Tab to turn this into an editable mesh'); return; } p.shape = k; p.param = SHAPES[p.shape].param ?? p.param; }, true);
  $('#bRole').onchange = upd(() => { p.role = ($('#bRole') as HTMLSelectElement).value as BindRole; }, true);
  $('#bKind').onchange = upd(() => { const k = ($('#bKind') as HTMLSelectElement).value; p.kind = k === 'ext' ? undefined : k as any; }, true);
  for (let k = 0; k < 3; k++) {
    $('#bs' + k).oninput = upd(() => { p.size[k] = Math.max(0.1, v('bs' + k)); });
    $('#bp' + k).oninput = upd(() => { p.pos[k] = v('bp' + k); });
    $('#br' + k).oninput = upd(() => { p.rot[k] = v('br' + k); });
  }
  if (prm) $('#bParam').oninput = upd(() => { p.param = v('bParam'); });
  if (segOk) $('#bSeg').oninput = upd(() => { p.segments = Math.max(1, Math.round(v('bSeg'))); }, true);
  ($('#bColor') as HTMLInputElement).oninput = upd(() => { p.color = ($('#bColor') as HTMLInputElement).value; const sw = $$('#partList .item.on .sw')[0]; if (sw) sw.style.background = p.color; });
  $('#bFinish').onchange = upd(() => { p.finish = ($('#bFinish') as HTMLSelectElement).value; });
  const arr = () => { const n = Math.max(1, Math.round(v('bArrN'))), mode = ($('#bArrMode') as HTMLSelectElement).value as 'linear' | 'radial'; p.array = n > 1 ? { n, mode, step: p.array?.step ?? [Math.max(5, p.size[0] + 2), 0, 0], center: p.array?.center ?? [0, 0] } : undefined; };
  $('#bArrN').onchange = upd(arr, true); $('#bArrMode').onchange = upd(arr, true);
  if (a && a.n > 1 && a.mode === 'radial') for (let k = 0; k < 2; k++) $('#bac' + k).oninput = upd(() => { p.array!.center = [v('bac0'), v('bac1')]; });
  if (a && a.n > 1 && a.mode !== 'radial') for (let k = 0; k < 3; k++) $('#bas' + k).oninput = upd(() => { p.array!.step = [v('bas0'), v('bas1'), v('bas2')]; });
  $('#bLayer').oninput = upd(() => { p.layer = Math.round(v('bLayer')); });
  if (p.auto) ($('#bKeep') as HTMLInputElement).onchange = e => { p.auto = !(e.target as HTMLInputElement).checked; app.changed('product'); };
  wireJoint(app, p, upd);
  $('#bDup').onclick = () => duplicate(p);
  $('#bDel').onclick = () => removePart(p);
  $('#bMirror').onclick = () => {
    const q: BuiltPart = JSON.parse(JSON.stringify(p)); q.id = newUid(); q.name = p.name + ' (mirror)'; q.auto = false;
    q.pos = [-p.pos[0], p.pos[1], p.pos[2]]; q.rot = [p.rot[0], -p.rot[1], -p.rot[2]];
    if (q.array?.step) q.array.step = [-q.array.step[0], q.array.step[1], q.array.step[2]];
    if (q.array?.center) q.array.center = [-q.array.center[0], q.array.center[1]];
    model().parts.push(q); prod().build(); app.selectPart(q.id); app.changed('product');
  };
}

/** Refresh size + fit without re-rendering the inspector, so the field being typed in keeps focus. */
function refreshSide(_app: App) {
  const m = model(), b = bounds(m.parts);
  $('#modelSize').textContent = b ? b.size.map(v => Math.round(v)).join(' × ') + ' mm' : '';
  const fit = fitBuilt(m.parts), bad = fit.filter(f => f.level !== 'ok').length;
  $('#mFitBadge').innerHTML = !fit.length ? '' : bad ? `<span class="badge bad">${bad} issue${bad > 1 ? 's' : ''}</span>` : '<span class="badge ok">Fits</span>';
  $('#mFitList').innerHTML = fit.map(f => `<div class="chk ${f.level}"><i></i><span>${esc(f.msg)}</span></div>`).join('') || '<div class="empty">Mark parts as Internal to check they fit inside the shell.</div>';
}

// ------------------------------------------------------------------ robot joints
const AXES: Record<string, [number, number, number]> = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
const axisKey = (a: [number, number, number]) => Object.entries(AXES).find(([, v]) => v.every((x, i) => Math.abs(x - a[i]) < 1e-6))?.[0] ?? 'custom';
/** What can drive a joint: "uid" or "uid:channel". */
function driverOptions(app: App, sel?: string) {
  const out: [string, string][] = [['', 'Nothing (teach slider)']];
  for (const c of app.project.electronics.comps) {
    const d = COMPONENTS[c.type]; if (!d) continue;
    if (c.type === 'pca9685') for (let ch = 0; ch < 16; ch++) out.push([`${c.uid}:${ch}`, `${d.name.split(' (')[0]} @0x${(c.props?.address ?? 0x40).toString(16)} ch ${ch}`]);
    else if (c.type === 'tb6612' || c.type === 'l298n') { out.push([`${c.uid}:0`, `${d.name} motor A`]); out.push([`${c.uid}:1`, `${d.name} motor B`]); }
    else if (['servo', 'mg996r', 'stepper', 'motor', 'fan', 'pump', 'contservo'].includes(c.type)) out.push([c.uid, d.name]);
  }
  return out.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
}
function descendants(parts: BuiltPart[], id: string) {
  const out = new Set<string>([id]); let grew = true;
  while (grew) { grew = false; for (const p of parts) if (p.parent && out.has(p.parent) && !out.has(p.id)) { out.add(p.id); grew = true; } }
  return out;
}
function jointHTML(app: App, p: BuiltPart) {
  const parts = model().parts, own = descendants(parts, p.id), j = p.joint;
  const kind = j ? j.type : p.parent ? 'attached' : 'none';
  const dsel = j?.drive ? (j.drive.channel != null ? `${j.drive.comp}:${j.drive.channel}` : j.drive.comp) : '';
  return `<div class="jsec"><div class="jh">Robot joint <span>${p.parent || j ? '' : 'makes this part move'}</span></div>
    <div class="row"><label>Attached to</label><select id="bjParent" style="flex:1"><option value="">Nothing (the base)</option>${parts.filter(x => !own.has(x.id)).map(x => `<option value="${x.id}" ${x.id === p.parent ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="row"><label>Moves</label><select id="bjType" style="flex:1">${[['none', 'Doesn\'t move'], ['attached', 'With its parent only'], ['revolute', 'Rotates (servo joint)'], ['prismatic', 'Slides (gripper, linear)'], ['wheel', 'Spins (wheel)']].map(([k, l]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${j && j.type !== 'fixed' ? `
    <div class="row"><label>Axis</label><select id="bjAxis" style="flex:1">${Object.keys(AXES).map(k => `<option ${k === axisKey(j.axis) ? 'selected' : ''}>${k}</option>`).join('')}${axisKey(j.axis) === 'custom' ? '<option selected>custom</option>' : ''}</select></div>
    <div class="row tri"><label>Pivot</label>${j.pivot.map((v, k) => `<input type="number" id="bjp${k}" value="${Math.round(v * 100) / 100}" step="0.5">`).join('')}</div>
    <div class="row"><label></label><button class="btn" id="bjPivC" style="flex:1" title="Pivot at the part's centre">Centre</button><button class="btn" id="bjPivB" style="flex:1" title="Pivot at the part's bottom end (−Y), like a limb's joint">Bottom</button><button class="btn" id="bjPivT" style="flex:1" title="Pivot at the part's top end (+Y)">Top</button></div>
    ${j.type !== 'wheel' ? `<div class="row tri"><label>Limits ${j.type === 'prismatic' ? 'mm' : '°'}</label><input type="number" id="bjMin" value="${j.min ?? -90}" step="1"><input type="number" id="bjMax" value="${j.max ?? 90}" step="1"><span></span></div>` : ''}
    <div class="row"><label>Driven by</label><select id="bjDrive" style="flex:1">${driverOptions(app, dsel)}</select></div>
    <label class="keep"><input type="checkbox" id="bjInv" ${j.drive?.invert ? 'checked' : ''}> Reverse direction</label>` : ''}
    <label class="keep"><input type="checkbox" id="bjFoot" ${p.foot ? 'checked' : ''}> Foot (walking robots stand on it)</label>
  </div>`;
}
function wireJoint(app: App, p: BuiltPart, upd: (fn: () => void, full?: boolean) => () => void) {
  const ensureRobot = () => { const m = model(); if (!m.robot && (p.joint || p.foot)) m.robot = { kind: 'custom', mobile: p.foot ? 'legs' : p.joint?.type === 'wheel' ? 'wheels' : 'fixed', mass: 500 }; };
  $('#bjParent').onchange = upd(() => { p.parent = ($('#bjParent') as HTMLSelectElement).value || undefined; }, true);
  $('#bjType').onchange = upd(() => {
    const t = ($('#bjType') as HTMLSelectElement).value;
    if (t === 'none') { p.joint = undefined; p.parent = undefined; }
    else if (t === 'attached') p.joint = undefined;
    else {
      const base: Joint = p.joint ?? { type: 'revolute', pivot: [p.pos[0], p.pos[1] - p.size[1] / 2, p.pos[2]], axis: t === 'wheel' ? [1, 0, 0] : t === 'prismatic' ? [1, 0, 0] : [1, 0, 0], min: t === 'prismatic' ? 0 : -90, max: t === 'prismatic' ? 10 : 90 };
      p.joint = { ...base, type: t as JointType };
      if (t === 'wheel') p.joint.pivot = [...p.pos];
      if (!p.parent) { const below = model().parts.filter(x => x.id !== p.id && !descendants(model().parts, p.id).has(x.id)).sort((a, b) => Math.hypot(...a.pos.map((v, i) => v - p.joint!.pivot[i]) as [number, number, number]) - Math.hypot(...b.pos.map((v, i) => v - p.joint!.pivot[i]) as [number, number, number]))[0]; if (below) p.parent = below.id; }
      ensureRobot();
    }
  }, true);
  ($('#bjFoot') as HTMLInputElement).onchange = upd(() => { p.foot = ($('#bjFoot') as HTMLInputElement).checked || undefined; ensureRobot(); if (p.foot) model().robot!.mobile = 'legs'; }, true);
  const j = p.joint; if (!j || j.type === 'fixed') return;
  $('#bjAxis').onchange = upd(() => { const k = ($('#bjAxis') as HTMLSelectElement).value; if (AXES[k]) j.axis = [...AXES[k]]; });
  for (let k = 0; k < 3; k++) $('#bjp' + k).oninput = upd(() => { j.pivot[k] = +($('#bjp' + k) as HTMLInputElement).value; });
  const piv = (dy: number) => upd(() => { j.pivot = [p.pos[0], p.pos[1] + dy * p.size[1] / 2, p.pos[2]]; }, true);
  $('#bjPivC').onclick = piv(0); $('#bjPivB').onclick = piv(-1); $('#bjPivT').onclick = piv(1);
  if (j.type !== 'wheel') { $('#bjMin').oninput = upd(() => { j.min = +($('#bjMin') as HTMLInputElement).value; }); $('#bjMax').oninput = upd(() => { j.max = +($('#bjMax') as HTMLInputElement).value; }); }
  $('#bjDrive').onchange = upd(() => {
    const v = ($('#bjDrive') as HTMLSelectElement).value;
    if (!v) { j.drive = undefined; return; }
    const [comp, ch] = v.split(':');
    j.drive = { comp, ...(ch != null ? { channel: +ch } : {}), invert: j.drive?.invert };
    // a servo plugged into a PCA9685 channel: record it for the power check and BOM
    const c = app.project.electronics.comps.find(x => x.uid === comp);
    if (c?.type === 'pca9685' && ch != null) { const list: { ch: number; type: string }[] = (c.props ??= {}).servos ??= []; if (!list.some(s => s.ch === +ch)) list.push({ ch: +ch, type: 'mg996r' }); app.changed('electronics'); }
  }, true);
  ($('#bjInv') as HTMLInputElement).onchange = upd(() => { if (j.drive) j.drive.invert = ($('#bjInv') as HTMLInputElement).checked; });
}
