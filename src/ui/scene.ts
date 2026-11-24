/**
 * The scene workspace: several robots in one shared world, simulated together.
 *
 * - Left: the robots in the scene (name, design, status, position) and what's in the world.
 * - Middle: the 3D view. Every robot carries a name tag. Drag a robot to move it,
 *   Shift-drag to turn it (while stopped).
 * - Bottom: one serial console for the whole scene, filterable per robot.
 *
 * Each robot runs its own firmware on its own emulated board or behavioral sim
 * (see app/twin.ts). Robots are copies of library projects. "Open in editor"
 * leaves the scene to edit that design, and the scene picks up the change when
 * it is opened again.
 */
import * as THREE from 'three';
import { $, el, esc, toast } from './dom';
import { Viewport } from '../scene/viewport';
import { BuiltProduct, drawWorld } from '../scene/built';
import { displayComps } from '../app/screenpart';
import { Twin, type TwinRobot } from '../app/twin';
import { SCENE_WORLDS, freeSpot, newSceneRobotId, saveScene, uniqueName, type Scene, type SceneRobot } from '../app/scene';
import { listProjects, loadProject, newProjectId, saveProject } from '../app/store';
import { isRobot } from '../app/robot';
import { ARM_PICK, ARM_PLACE, ROBOT_KINDS, pickBlock, robotProject, type RobotKind } from '../app/robots';
import { RP2040Runtime } from '../hw/runtimes/rp2040';
import { AVRRuntime } from '../hw/runtimes/avr';
import { SimPythonRuntime } from '../hw/runtimes/sim-python';
import { b64decode } from './dom';
import type { Project, World } from '../app/project';

export interface SceneHost {
  base: string;
  /** Leave the scene and edit a robot's project. */
  openProject(id: string): void;
  goHome(): void;
  /** The studio's viewport (paused while a scene is open). */
  studio: Viewport;
}

interface View { robot: TwinRobot; product: BuiltProduct; tag: HTMLElement; color: string }

const TAG_COLORS = ['#ff7a2f', '#3aa0ff', '#33c27f', '#e5c07b', '#c678dd', '#56b6c2', '#ff5c8a', '#a0a0ff'];
const STATUS_TEXT: Record<string, string> = { stopped: 'stopped', starting: 'starting…', running: 'running', finished: 'finished', crashed: 'crashed', missing: 'project missing' };

let host: SceneHost;
let vp: Viewport | null = null;
let id = '';
let scene: Scene | null = null;
let twin: Twin | null = null;
let views: View[] = [];
/** Scene entries whose project couldn't be loaded (deleted from the library). */
let missing: SceneRobot[] = [];
let selected: string | null = null;
let filter: string | 'all' = 'all';
const worldG = new THREE.Group(); worldG.scale.setScalar(0.1);
const pickMeshes = new Map<number, THREE.Mesh>();
let worldKey = '';
let saveT: any = 0;
let uiT = 0;
const log: { robot: string; text: string; cls?: string }[] = [];
const partial = new Map<string, string>();
let firmwareCache: Promise<Uint8Array> | null = null;

export const inScene = () => document.body.classList.contains('at-scene');
(globalThis as any).__scene = () => twin; // handy for debugging from the console (and the browser tests)

export function initScene(h: SceneHost) {
  host = h;
  $('#swHome').onclick = () => close();
  ($('#swName') as HTMLInputElement).oninput = e => { if (scene) { scene.name = (e.target as HTMLInputElement).value; changed(); } };
  $('#swWorld').innerHTML = Object.entries(SCENE_WORLDS).map(([k, w]) => `<option value="${k}">${esc(w.label)}</option>`).join('') + '<option value="custom" hidden>Custom</option>';
  $('#swWorld').onchange = e => {
    const k = (e.target as HTMLSelectElement).value; if (!SCENE_WORLDS[k] || !twin) return;
    if (twin.running) { toast('Stop the robots before changing the world'); renderWorld(); return; }
    twin.setWorld(SCENE_WORLDS[k].make()); changed(); renderWorld(); renderSide(); frameAll();
  };
  $('#swRunAll').onclick = () => runAll();
  $('#swStopAll').onclick = () => twin?.stopAll().then(renderSide);
  $('#swReset').onclick = () => { if (twin?.running) { toast('Stop the robots first'); return; } twin?.reset(); renderSide(); };
  $('#swAdd').onclick = e => { e.stopPropagation(); toggleMenu(); };
  document.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('#swMenu')) $('#swMenu').hidden = true; });
  $('#swBlock').onclick = () => addBlock();
  $('#swClear').onclick = () => { log.length = 0; partial.clear(); renderLog(); };
}

// ------------------------------------------------------------------ open / close
export async function openScene(sceneId: string, s: Scene) {
  if (!vp) setupViewport();
  id = sceneId; scene = s; selected = null; filter = 'all'; log.length = 0; partial.clear();
  document.body.classList.add('at-scene');
  host.studio.paused = true; vp!.paused = false; vp!.resize();
  ($('#swName') as HTMLInputElement).value = s.name;
  await rebuild();
  frameAll();
  renderLog();
}
async function close() {
  await twin?.stopAll();
  flush();
  document.body.classList.remove('at-scene');
  if (vp) vp.paused = true;
  host.studio.paused = false;
  host.goHome();
}

/** (Re)load every robot's project from the library and build the simulation and 3D models. */
async function rebuild() {
  await twin?.stopAll();
  for (const v of views) { vp!.scene.remove(v.product.group); v.product.dispose(); v.tag.remove(); }
  views = []; missing = [];
  twin = null;
  $('#swList').innerHTML = '<div class="empty">Loading robots…</div>'; $('#swCount').textContent = ''; $('#swObjs').innerHTML = '';
  const s = scene!;
  twin = new Twin(s);
  twin.onSerial = (r, t, cls) => serial(r.def.id, t, cls);
  twin.onStatus = () => renderSide();
  for (const def of s.robots) {
    const p = await loadProject(def.project).catch(() => null);
    if (!p || !isRobot(p.product.built)) { missing.push(def); continue; }
    addView(def, p);
  }
  renderWorld(); renderSide();
}
function addView(def: SceneRobot, p: Project) {
  const r = twin!.add(def, p); if (!r) { missing.push(def); return; }
  const product = new BuiltProduct(r.model, displayComps(p));
  r.bench.product = product; r.bench.load(r.board, p.electronics.comps);
  product.setPose(r.sim.pose); // stand at its spot now, so framing sees where it really is
  vp!.scene.add(product.group);
  const color = TAG_COLORS[(views.length + missing.length) % TAG_COLORS.length];
  const tag = el('button', 'swtagl'); tag.style.setProperty('--c', color);
  tag.onclick = () => select(def.id);
  $('#swTags').appendChild(tag);
  views.push({ robot: r, product, tag, color });
}

// ------------------------------------------------------------------ 3D
function setupViewport() {
  vp = new Viewport($('#swView'));
  vp.scene.add(worldG);
  vp.showFloor(false);
  vp.paused = true;
  vp.onTick((dt, now) => {
    if (!inScene() || !twin) return;
    twin.step(dt);
    for (const v of views) { v.product.setPose(v.robot.sim.pose); v.product.tick(dt, now); }
    for (const o of twin.objects) { const m = pickMeshes.get(o.index); if (m) o.m.decompose(m.position, m.quaternion, m.scale); }
    vp!.throttle = views.some(v => v.robot.runtime?.running && (v.robot.board.runtime === 'rp2040-emu' || v.robot.board.runtime === 'avr-emu'));
    placeTags();
    uiT += dt; if (uiT > 0.25) { uiT = 0; liveSide(); }
  });
  wireDrag();
}
function renderWorld() {
  const w = scene!.world, key = JSON.stringify(w);
  ($('#swWorld') as HTMLSelectElement).value = Object.entries(SCENE_WORLDS).find(([, p]) => JSON.stringify(p.make()) === key)?.[0] ?? 'custom';
  if (key === worldKey) return;
  worldKey = key;
  worldG.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  worldG.clear(); pickMeshes.clear();
  drawWorld(w, worldG, pickMeshes);
}
function frameAll() {
  if (!vp) return;
  // frame the robots (or the whole floor when there are none)
  if (views.length) {
    const box = new THREE.Box3();
    for (const v of views) { v.product.group.updateWorldMatrix(true, true); v.product.group.traverseVisible(o => { if ((o as any).isMesh) box.expandByObject(o); }); }
    const s = box.getBoundingSphere(new THREE.Sphere()), r = Math.max(s.radius, 30);
    const dir = new THREE.Vector3(0.5, 0.55, 1).normalize(), dist = r / Math.sin((vp.camera.fov * Math.PI) / 360) * 1.3;
    vp.controls.target.copy(s.center); vp.camera.position.copy(s.center).addScaledVector(dir, dist);
    vp.camera.near = dist / 200; vp.camera.far = dist * 40; vp.camera.updateProjectionMatrix();
  } else {
    const half = scene!.world.size * 0.1 / 2;
    vp.controls.target.set(0, 0, 0); vp.camera.position.set(half * 0.6, half * 0.9, half * 1.3);
    vp.camera.near = 1; vp.camera.far = half * 20; vp.camera.updateProjectionMatrix();
  }
}
function placeTags() {
  const rect = $('#swView').getBoundingClientRect();
  for (const v of views) {
    const top = new THREE.Vector3().setFromMatrixPosition(v.robot.sim.body.m).multiplyScalar(0.1); top.y = (v.robot.height + 30) * 0.1;
    const p = vp!.project(top);
    v.tag.style.display = p.behind ? 'none' : '';
    v.tag.style.transform = `translate(${p.x - rect.left}px, ${p.y - rect.top}px) translate(-50%, -100%)`;
    const st = v.robot.status;
    const txt = `<i class="dot ${st}"></i>${esc(v.robot.def.name)}`;
    if (v.tag.innerHTML !== txt) v.tag.innerHTML = txt;
    v.tag.classList.toggle('on', selected === v.robot.def.id);
  }
}

/** Drag a robot across the floor; Shift-drag turns it. Only while it is stopped. */
function wireDrag() {
  const canvas = vp!.renderer.domElement, ray = new THREE.Raycaster(), floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag: { v: View; start: THREE.Vector3; pose: SceneRobot['pose']; x0: number; turn: boolean } | null = null;
  const floorAt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), vp!.camera);
    return ray.ray.intersectPlane(floor, new THREE.Vector3())?.multiplyScalar(10) ?? null; // world units are cm
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const meshes: THREE.Object3D[] = [], owner = new Map<THREE.Object3D, View>();
    for (const v of views) v.product.group.traverse(o => { if ((o as any).isMesh) { meshes.push(o); owner.set(o, v); } });
    const hit = vp!.hit(e, meshes); if (!hit) return;
    const v = owner.get(hit.object)!; select(v.robot.def.id);
    if (v.robot.runtime) { toast(`Stop ${v.robot.def.name} to move it`); return; }
    const start = floorAt(e); if (!start) return;
    drag = { v, start, pose: { ...v.robot.def.pose }, x0: e.clientX, turn: e.shiftKey };
    vp!.controls.enabled = false; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const d = drag.v.robot.def;
    if (drag.turn) d.pose.yaw = Math.round((drag.pose.yaw - (e.clientX - drag.x0) * 0.6) % 360);
    else { const p = floorAt(e); if (!p) return; const half = scene!.world.size / 2 - 50; d.pose.x = Math.round(Math.max(-half, Math.min(half, drag.pose.x + p.x - drag.start.x))); d.pose.z = Math.round(Math.max(-half, Math.min(half, drag.pose.z + p.z - drag.start.z))); }
    twin!.place(drag.v.robot); liveSide();
  });
  const end = () => { if (!drag) return; drag = null; vp!.controls.enabled = true; changed(); renderSide(); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------ running
function firmware() {
  return (firmwareCache ||= fetch(host.base + 'firmware/micropython-rp2-pico-v1.24.1.uf2.b64.txt').then(r => { if (!r.ok) throw new Error('MicroPython firmware missing'); return r.text(); }).then(t => new Uint8Array(b64decode(t.trim()))));
}
const makeRuntime = (r: TwinRobot) => {
  switch (r.board.runtime) {
    case 'rp2040-emu': return new RP2040Runtime(r.bench, firmware);
    case 'avr-emu': return new AVRRuntime(r.bench);
    case 'sim-python': return new SimPythonRuntime(r.bench, host.base);
    default: return `${r.def.name}: ${r.board.name} runs on a physical board, which can't join a scene. Pick an emulated or simulated board in its project.`;
  }
};
const payload = async (r: TwinRobot): Promise<Record<string, string> | string> => {
  const f = r.project.electronics.files;
  if (r.board.runtime !== 'avr-emu') return Object.fromEntries(Object.entries(f).filter(([k]) => k.endsWith('.py')));
  if (f['firmware.hex'] && !Object.keys(f).some(k => k.endsWith('.ino'))) return { 'firmware.hex': f['firmware.hex'] };
  const src = Object.fromEntries(Object.entries(f).filter(([k]) => /\.(ino|h|hpp|c|cpp)$/.test(k)));
  serial(r.def.id, `Compiling ${r.def.name}'s sketch…\n`, 's');
  try {
    const res = await fetch(host.base + 'api/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: src, board: r.board.id }) });
    const j = await res.json().catch(() => ({ error: 'No compiler here. Run `npm run dev` locally.' }));
    return res.ok ? { 'firmware.hex': j.hex } : `${r.def.name}: ${j.error}`;
  } catch { return `${r.def.name}: no compiler available. Run \`npm run dev\` locally, or add a .hex to its project.`; }
};
async function runOne(r: TwinRobot) { await twin!.start(r, makeRuntime, payload); renderSide(); }
async function runAll() {
  if (!twin?.robots.length) { toast('Add a robot first'); return; }
  const emus = twin.robots.filter(r => r.board.runtime === 'rp2040-emu' || r.board.runtime === 'avr-emu').length;
  if (emus > 2) toast(`${emus} emulated chips share this computer's CPU, so each runs slower than real time`);
  await Promise.all(twin.robots.filter(r => !r.runtime).map(r => runOne(r)));
}

// ------------------------------------------------------------------ console
function serial(robot: string, text: string, cls?: string) {
  const buf = (partial.get(robot) ?? '') + text.replace(/\r/g, '');
  const lines = buf.split('\n'); partial.set(robot, lines.pop()!);
  for (const t of lines) log.push({ robot, text: t, cls });
  if (log.length > 2000) log.splice(0, log.length - 2000);
  if (lines.length) { clearTimeout((serial as any).t); (serial as any).t = setTimeout(renderLog, 60); }
}
function renderLog() {
  const tabs = $('#swTabs');
  tabs.innerHTML = [`<button data-f="all" class="${filter === 'all' ? 'on' : ''}">All</button>`, ...views.map(v => `<button data-f="${v.robot.def.id}" class="${filter === v.robot.def.id ? 'on' : ''}" style="--c:${v.color}">${esc(v.robot.def.name)}</button>`)].join('');
  tabs.querySelectorAll<HTMLElement>('button').forEach(b => (b.onclick = () => { filter = b.dataset.f!; renderLog(); }));
  const name = new Map(views.map(v => [v.robot.def.id, v]));
  const rows = log.filter(l => filter === 'all' || l.robot === filter).slice(-600);
  const pre = $('#swLog'), stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.innerHTML = rows.length ? rows.map(l => { const v = name.get(l.robot); return `<div class="${l.cls ?? ''}">${filter === 'all' && v ? `<b style="color:${v.color}">${esc(v.robot.def.name)}</b> ` : ''}${esc(l.text)}</div>`; }).join('') : '<div class="dim">Serial output from every robot shows here. Press ▶ Run all.</div>';
  if (stick) pre.scrollTop = pre.scrollHeight;
}

// ------------------------------------------------------------------ side panel
function select(rid: string | null) { selected = rid; renderSide(); }
function changed() {
  clearTimeout(saveT); saveT = setTimeout(flush, 500);
}
function flush() {
  clearTimeout(saveT); if (!scene || !id) return;
  saveScene(id, scene, thumb()).catch(() => toast("Couldn't save the scene"));
}
function thumb(): string | undefined {
  if (!vp || !views.length) return undefined;
  const src = vp.renderer.domElement; if (!src.width) return undefined;
  const c = document.createElement('canvas'); c.width = 400; c.height = 250;
  const g = c.getContext('2d')!, k = Math.max(400 / src.width, 250 / src.height);
  g.fillStyle = '#232325'; g.fillRect(0, 0, 400, 250);
  g.drawImage(src, (400 - src.width * k) / 2, (250 - src.height * k) / 2, src.width * k, src.height * k);
  return c.toDataURL('image/jpeg', 0.8);
}

function renderSide() {
  if (!scene || !twin) return;
  $('#swCount').textContent = String(views.length + missing.length);
  const list = $('#swList');
  list.innerHTML = views.map(v => card(v)).join('') + missing.map(m => `<div class="swr missing" data-id="${m.id}"><div class="swrh"><i class="dot missing"></i><b>${esc(m.name)}</b><button class="rpdel" data-x="del" title="Remove from the scene" aria-label="Remove ${esc(m.name)}">×</button></div><div class="swrs">Its project was deleted from the library</div></div>`).join('')
    || '<div class="empty">No robots yet. Add one from your projects or start from a template.</div>';
  list.querySelectorAll<HTMLElement>('.swr').forEach(c => {
    const rid = c.dataset.id!, v = views.find(x => x.robot.def.id === rid);
    c.onclick = e => { if (!(e.target as HTMLElement).closest('button,input')) select(rid === selected ? null : rid); };
    c.querySelectorAll<HTMLElement>('[data-x]').forEach(b => (b.onclick = () => act(b.dataset.x!, rid, v)));
    c.querySelectorAll<HTMLInputElement>('input[data-f]').forEach(inp => (inp.onchange = () => {
      if (!v) return; const d = v.robot.def, f = inp.dataset.f!;
      if (f === 'name') { d.name = inp.value.trim() || d.name; renderLog(); }
      else { if (v.robot.runtime) { toast(`Stop ${d.name} to move it`); renderSide(); return; } (d.pose as any)[f] = Math.round(+inp.value || 0); twin!.place(v.robot); }
      changed(); renderSide();
    }));
  });
  const objs = $('#swObjs');
  objs.innerHTML = scene.world.obstacles.map((o, i) => `<span class="rpobj" title="${o.pick ? 'A gripper can pick this up' : 'Fixed in place'}"><i style="background:${esc(o.color ?? '#c8743a')}"></i>${esc(o.name ?? (o.shape === 'cyl' ? 'Cylinder' : 'Box'))}<button class="rpdel" data-i="${i}" aria-label="Remove">×</button></span>`).join('') || '<span class="dim">Nothing on the floor</span>';
  objs.querySelectorAll<HTMLElement>('.rpdel').forEach(b => (b.onclick = () => { if (twin!.running) { toast('Stop the robots before changing the world'); return; } const w: World = { ...scene!.world, obstacles: scene!.world.obstacles.filter((_, i) => i !== +b.dataset.i!) }; twin!.setWorld(w); changed(); renderWorld(); renderSide(); }));
  ($('#swRunAll') as HTMLButtonElement).disabled = !views.length;
  liveSide(); renderLog();
}
function card(v: View) {
  const r = v.robot, d = r.def, on = selected === d.id, running = !!r.runtime;
  return `<div class="swr ${on ? 'on' : ''}" data-id="${d.id}" style="--c:${v.color}">
    <div class="swrh"><i class="dot ${r.status}"></i><b>${esc(d.name)}</b><span class="swst" data-live="st"></span>
      <button class="btn ${running ? '' : 'primary'} swgo" data-x="${running ? 'stop' : 'run'}" title="${running ? 'Stop' : 'Run'} ${esc(d.name)}'s firmware">${running ? '■' : '▶'}</button></div>
    <div class="swrs">${esc(r.project.name)} · ${esc(r.board.name)}</div>
    ${on ? `<div class="swrf">
      <label>Name <input type="text" data-f="name" value="${esc(d.name)}" spellcheck="false"></label>
      <div class="swxy"><label>X <input type="number" data-f="x" value="${d.pose.x}" step="50"> mm</label><label>Z <input type="number" data-f="z" value="${d.pose.z}" step="50"> mm</label><label>Heading <input type="number" data-f="yaw" value="${d.pose.yaw}" step="15">°</label></div>
      <div class="swbtns"><button class="btn" data-x="edit" title="Edit this design (every copy uses it)">Open in editor</button><button class="btn" data-x="dup">Duplicate</button><button class="btn" data-x="del">Remove</button></div>
    </div>` : ''}
  </div>`;
}
/** Status text and speed (4 Hz). */
function liveSide() {
  for (const v of views) {
    const st = document.querySelector<HTMLElement>(`#swList .swr[data-id="${v.robot.def.id}"] [data-live="st"]`); if (!st) continue;
    const r = v.robot, sp = r.runtime?.running ? r.runtime.speed?.() : undefined;
    st.textContent = STATUS_TEXT[r.status] + (sp != null && sp < 0.98 ? ` · ${sp.toFixed(2)}×` : '') + (r.sim.stalled ? ' · blocked' : r.sim.legs.fallen ? ' · fell over' : '');
    const dot = document.querySelector<HTMLElement>(`#swList .swr[data-id="${v.robot.def.id}"] .dot`); if (dot) dot.className = `dot ${r.status}`;
  }
}
async function act(x: string, rid: string, v?: View) {
  const s = scene!;
  if (x === 'run' && v) return runOne(v.robot);
  if (x === 'stop' && v) { await twin!.stop(v.robot); renderSide(); return; }
  if (x === 'edit' && v) { await twin!.stopAll(); flush(); document.body.classList.remove('at-scene'); vp!.paused = true; host.studio.paused = false; host.openProject(v.robot.def.project); return; }
  if (x === 'dup' && v) {
    const d = v.robot.def, def: SceneRobot = { id: newSceneRobotId(), name: uniqueName(s, d.name.replace(/ \d+$/, '')), project: d.project, pose: { ...freeSpot(s), yaw: d.pose.yaw } };
    s.robots.push(def); addView(def, v.robot.project); selected = def.id; changed(); renderSide(); return;
  }
  if (x === 'del') {
    s.robots = s.robots.filter(r => r.id !== rid);
    if (v) { twin!.remove(v.robot); vp!.scene.remove(v.product.group); v.product.dispose(); v.tag.remove(); views = views.filter(y => y !== v); }
    missing = missing.filter(m => m.id !== rid);
    if (selected === rid) selected = null;
    changed(); renderSide();
  }
}

// ------------------------------------------------------------------ adding robots and blocks
async function toggleMenu() {
  const m = $('#swMenu');
  if (!m.hidden) { m.hidden = true; return; }
  m.hidden = false;
  m.innerHTML = '<div class="dim">Loading your robots…</div>';
  const metas = await listProjects();
  const robots: { id: string; p: Project }[] = [];
  for (const meta of metas) { const p = await loadProject(meta.id).catch(() => null); if (p && isRobot(p.product.built)) robots.push({ id: meta.id, p }); }
  m.innerHTML = `<h4>Your robot projects</h4>${robots.map(r => `<button data-p="${r.id}"><b>${esc(r.p.name)}</b><span>${esc(r.p.electronics.board)}</span></button>`).join('') || '<div class="dim">None yet</div>'}
    <h4>New from a template</h4>${ROBOT_KINDS.map(k => `<button data-k="${k.id}"><b>${esc(k.name)}</b><span>Creates a new project</span></button>`).join('')}`;
  m.querySelectorAll<HTMLElement>('button[data-p]').forEach(b => (b.onclick = () => { m.hidden = true; const r = robots.find(x => x.id === b.dataset.p)!; addRobot(r.id, r.p); }));
  m.querySelectorAll<HTMLElement>('button[data-k]').forEach(b => (b.onclick = async () => {
    m.hidden = true;
    const p = robotProject(b.dataset.k as RobotKind), pid = newProjectId();
    await saveProject(pid, p, null);
    addRobot(pid, p);
    toast(`Made a new ${p.name} project for it (it's in your projects too)`);
  }));
}
function addRobot(projectId: string, p: Project) {
  const s = scene!;
  // an arm goes where the work cell's block is within reach, if that spot is free
  const armHome = p.electronics.robot === 'arm' && s.world.obstacles.some(o => o.pick && o.pos[0] === ARM_PICK[0] && o.pos[1] === ARM_PICK[1]) && s.robots.every(r => Math.hypot(r.pose.x, r.pose.z) > 300);
  const spot = armHome ? { x: 0, z: 0 } : freeSpot(s);
  const def: SceneRobot = { id: newSceneRobotId(), name: uniqueName(s, p.name), project: projectId, pose: { ...spot, yaw: 0 } };
  s.robots.push(def); addView(def, p); selected = def.id; changed(); renderSide(); frameAll();
}
/** A block (and a pad) within reach of the selected arm, or a block in a free spot. */
function addBlock() {
  if (!scene || !twin) return;
  if (twin.running) { toast('Stop the robots before changing the world'); return; }
  const v = views.find(x => x.robot.def.id === selected), w = scene.world;
  const obs = [...w.obstacles];
  if (v && v.robot.project.electronics.robot === 'arm') {
    const { x, z, yaw } = v.robot.def.pose, a = yaw * Math.PI / 180;
    const at = ([px, pz]: [number, number]): [number, number] => [Math.round(x + px * Math.cos(a) + pz * Math.sin(a)), Math.round(z - px * Math.sin(a) + pz * Math.cos(a))];
    const b = pickBlock(at(ARM_PICK)); b.rot = Math.round(Math.atan2(b.pos[0] - x, b.pos[1] - z) * 180 / Math.PI);
    obs.push(b);
    const pad = at(ARM_PLACE);
    if (!obs.some(o => !o.pick && Math.hypot(o.pos[0] - pad[0], o.pos[1] - pad[1]) < 40)) obs.push({ shape: 'cyl', pos: pad, size: [60, 4, 60], color: '#33c27f', name: 'Pad' });
    toast(`Put a block where ${v.robot.def.name} reaches for it, and a pad to set it on`);
  } else {
    const s = freeSpot(scene); obs.push(pickBlock([s.x, s.z]));
    toast('Added a block. Select an arm first to put one within its reach');
  }
  twin.setWorld({ ...w, obstacles: obs }); changed(); renderWorld(); renderSide();
}
