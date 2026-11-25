/**
 * The Robot panel: floats over the 3D view whenever the model has joints.
 * Joints follow the firmware while it runs; otherwise the sliders move them
 * (teach mode: record poses, insert them into the code). Also: the world the
 * robot lives in, mass and servo supply, reset, URDF export/import, ROS 2 bridge.
 */
import * as THREE from 'three';
import type { App } from './app';
import { attachLoose } from '../app/loose';
import { $, el, esc, toast, download } from './dom';
import { BuiltProduct } from '../scene/built';
import { RobotSim, isRobot } from '../app/robot';
import { RosBridge } from '../app/rosbridge';
import { exportUrdf, importUrdf } from '../app/urdf';
import { firmwareRunning } from './elec';
import { COMPONENTS } from '../hw/library/components';
import { MATERIALS, materialOf, objTitle, type BuiltModel, type ObstacleMaterial, type World } from '../app/project';
import { defaultAutoOpts } from '../app/project';
import { track } from './track';
import { onWorldEdited, openDraw, selectWorldObject } from './worldedit';
import { ARM_PICK, armTable, pickBlock } from '../app/robots';
import { crashActive } from './crash';

let A: App;
let sim: RobotSim | null = null;
let sig = '';
/** The Start marker the sim's home pose was last set from, and the Finish run being timed. */
let homeKey = '', race: { t0: number; done: boolean } | null = null;
/** Put the sim's home at the world's Start marker (or the origin). Returns true if it moved. */
function applyStart(w?: World) {
  const k = JSON.stringify(w?.start ?? null); if (!sim || k === homeKey) return false;
  homeKey = k; const st = w?.start;
  sim.home = st ? new THREE.Matrix4().makeRotationY(st.yaw * Math.PI / 180).setPosition(st.pos[0], 0, st.pos[1]) : new THREE.Matrix4();
  return true;
}
let open = true;
let uiT = 0;
const bridge = new RosBridge(() => sim);
bridge.onStatus = () => render();

const WORLDS: Record<string, { label: string; make: () => World | undefined }> = {
  none: { label: 'No world', make: () => undefined },
  floor: { label: 'Open floor', make: () => ({ size: 3000, obstacles: [] }) },
  room: { label: 'Room with obstacles', make: () => ({ size: 2200, obstacles: [{ shape: 'box', pos: [0, 600], size: [400, 120, 120] }, { shape: 'cyl', pos: [-550, -200], size: [180, 200, 180], color: '#3aa0ff' }, { shape: 'box', pos: [600, -300], size: [160, 150, 360], color: '#33c27f' }, { shape: 'box', pos: [-450, 650], size: [200, 100, 200], color: '#e5c07b' }, { shape: 'cyl', pos: [350, 250], size: [120, 160, 120], color: '#c678dd' }] }) },
  track: { label: 'Line track', make: () => { const pts: [number, number][] = []; for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push([Math.round(Math.cos(a) * 420 - 420), Math.round(Math.sin(a) * 650 + Math.sin(a * 2) * 120)]); } return { size: 2000, obstacles: [], track: { points: pts, width: 26 } }; } },
  table: { label: 'Table with blocks', make: armTable },
};
const worldKind = (w?: World) => (!w ? 'none' : w.track ? 'track' : w.size === 700 ? 'table' : w.obstacles.length ? 'room' : 'floor');

const objName = (o: World['obstacles'][number]) => o.name ?? (o.shape === 'cyl' ? 'Cylinder' : 'Box');

const model = (): BuiltModel | null => (A.product instanceof BuiltProduct ? A.project.product.built ?? null : null);

export function initRobot(app: App) {
  A = app;
  onWorldEdited(() => render());
  const panel = el('div', 'robotp'); panel.id = 'robotPanel'; panel.style.display = 'none';
  $('#viewport').appendChild(panel);
}

/** Per frame: step the robot and pose the 3D model. */
export function robotFrame(dt: number) {
  const m = model(), prod = A.product;
  if (crashActive()) return; // a crash test owns the model while it runs
  if (!m || !isRobot(m) || !(prod instanceof BuiltProduct)) {
    if (sim) { sim = null; sig = ''; if (prod instanceof BuiltProduct) { prod.setPose(null); prod.setWorld(null); } A.viewport.showFloor(true); bridge.close(); render(); }
    return;
  }
  const s = JSON.stringify(m.parts.map(p => [p.id, p.parent, p.joint, p.foot, p.pos, p.rot, p.size])) + JSON.stringify(m.robot ?? null);
  if (!sim || sim.model !== m) {
    sim = new RobotSim(m); homeKey = ''; if (applyStart(m.robot?.world)) sim.reset(); sim.settle(); sig = s; render();
    sim.onBreak = lines => { toast(`Broken in a collision: ${lines.join('; ')}`); A.changed('review'); track('model', `Collision damage: ${lines.join('; ')}`); }; prod.setPose(sim.pose); prod.setWorld(m.robot?.world); A.viewport.frame(prod.group);
    if (m.robot && m.robot.physics !== false) { const me = sim; me.setPhysics(true, A.project.electronics.comps).then(() => render()).catch(e => toast("Physics couldn't start: " + e.message)); }
  }
  else if (s !== sig) { sig = s; sim.resync(); if (applyStart(m.robot?.world) && !firmwareRunning()) sim.reset(); sim.settle(); render(); }
  // Finish marker: time each run from Run to reaching it
  const fin = m.robot?.world?.finish;
  if (!firmwareRunning()) race = null;
  else if (fin) {
    race ??= { t0: performance.now(), done: false };
    if (!race.done && Math.hypot(sim.body.x - fin.pos[0], sim.body.z - fin.pos[1]) <= fin.r) {
      race.done = true; const t = ((performance.now() - race.t0) / 1000).toFixed(1);
      toast(`Reached the finish in ${t} s`); track('test', `Reached the finish in ${t} s`);
    }
  }
  sim.step(dt, A.project.electronics.comps, A.bench, firmwareRunning());
  prod.setPose(sim.pose);
  prod.setWorld(m.robot?.world);
  prod.setObjects(sim.objectPoses());
  A.viewport.showFloor(!m.robot?.world);
  uiT += dt; if (uiT > 0.1) { uiT = 0; live(); }
}

/** Reset the robot to its rest pose at the origin (after rebuilding, or from the button). */
export function resetRobot() { sim?.reset(); if (race) race = { t0: performance.now(), done: false }; render(); }
export const robotSim = () => sim;
(globalThis as any).__robot = robotSim; // handy for debugging from the console

function spec() { const m = model()!; return (m.robot ??= { kind: 'custom', mobile: 'fixed', mass: 500 }); }

/** Re-draw the robot panel (e.g. after new parts appear loose in the world). */
export function renderRobotPanel() { if (sim) render(); }

function render() {
  const panel = document.getElementById('robotPanel'); if (!panel) return;
  if (!sim) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const sp = spec(), comps = A.project.electronics.comps;
  const becs = comps.filter(c => c.type === 'bec');
  const driver = (d?: { comp: string; channel?: number }) => { if (!d) return 'teach slider'; const c = comps.find(x => x.uid === d.comp); if (!c) return 'missing part'; const n = COMPONENTS[c.type]?.name.split(' (')[0] ?? c.type; return c.type === 'pca9685' ? `${n} ch ${d.channel ?? 0}` : c.type === 'tb6612' || c.type === 'l298n' ? `${n} ${d.channel ? 'B' : 'A'}` : n; };
  panel.innerHTML = `
    <div class="rph"><b>Robot</b><span class="rpst" id="rpState"></span><button class="rpx" id="rpToggle" title="${open ? 'Collapse' : 'Expand'}">${open ? '–' : '+'}</button></div>
    ${open ? `
    <div class="rpb">
      <div class="rpj">${sim.joints.map(j => {
        const lo = j.joint.type === 'wheel' ? -360 : j.joint.min ?? -180, hi = j.joint.type === 'wheel' ? 360 : j.joint.max ?? 180;
        return `<div class="rpr" data-id="${j.id}" title="Driven by ${esc(driver(j.joint.drive))}"><span class="rpn">${esc(j.name)}</span><input type="range" min="${lo}" max="${hi}" step="${j.joint.type === 'prismatic' ? 0.5 : 1}" value="${Math.round(j.q)}"><span class="rpv"></span></div>`;
      }).join('') || '<div class="empty">No moving joints yet. Select a part in Design and give it a joint.</div>'}</div>
      <div class="rpbtns"><button class="btn" id="rpRec" title="Record the current joint angles">● Record pose</button><button class="btn" id="rpIns" title="Put the recorded poses into the code">Use in code</button><button class="btn" id="rpPlay" data-ico="play">Play</button><button class="btn" id="rpClr">Clear</button></div>
      <div class="rpposes">${(sp.poses ?? []).map((p, i) => `<span class="rppose" data-i="${i}" title="Click to go to it">${esc(p.name)}</span>`).join('') || '<span class="dim">No poses yet (teach mode: move the sliders, then Record)</span>'}</div>
      <div class="rprow"><label>World</label><select id="rpWorld">${Object.entries(WORLDS).map(([k, w]) => `<option value="${k}" ${k === worldKind(sp.world) ? 'selected' : ''}>${w.label}</option>`).join('')}</select>
        <label title="Rigid-body physics (Rapier): gravity, mass, friction, collisions and servo torque limits">Physics</label><select id="rpPhys"><option value="1" ${sp.physics !== false ? 'selected' : ''}>Realistic</option><option value="" ${sp.physics !== false ? '' : 'selected'}>Off (passes through things)</option></select>
        <label>Moves on</label><select id="rpMobile">${[['fixed', 'Bolted down'], ['wheels', 'Wheels'], ['legs', 'Legs']].map(([k, l]) => `<option value="${k}" ${sp.mobile === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${sp.world ? `<div class="rprow rpobjs"><label>Objects</label>${sp.world.obstacles.map((o, i) => `<span class="rpobj" title="${esc(objTitle(o))}"><i style="background:${esc(o.color ?? '#c8743a')}"></i>${esc(objName(o))}<select class="rpmat" data-i="${i}" aria-label="What the ${esc(objName(o).toLowerCase())} is made of">${(Object.keys(MATERIALS) as ObstacleMaterial[]).map(k => `<option value="${k}" ${materialOf(o) === k ? 'selected' : ''}>${MATERIALS[k].label}</option>`).join('')}</select>${o.comp ? `<button class="rpatt" data-i="${i}" title="Mount the ${esc(objName(o))} on the robot where it lies. It then moves with the robot; fine-tune its spot in Design.">Attach</button>` : ''}<button class="rpdel" data-i="${i}" title="Remove ${esc(objName(o).toLowerCase())}" aria-label="Remove ${esc(objName(o).toLowerCase())}">×</button></span>`).join('') || '<span class="dim">None</span>'}<button class="btn" id="rpAddBlock" title="Add a 20 mm block the gripper can pick up">+ Block</button><button class="btn" id="rpAddBox" title="Add a cardboard box for the robot to push">+ Box</button></div>` : ''}
      <div class="rprow adv"><label>Mass</label><input type="number" id="rpMass" value="${sp.mass}" min="10" step="50"> g
        ${becs.length ? `<label>Servo supply</label><input type="number" id="rpAmps" value="${becs[0].props?.amps ?? 5}" min="1" step="1"> A` : ''}</div>
      <div class="rpbtns"><button class="btn" id="rpReset" data-ico="reset">Reset position</button><button class="btn" id="rpDraw" title="Draw lines to follow, walls, a start and a finish on the floor">Draw</button><button class="btn adv" id="rpUrdf" title="Save a URDF for ROS, RViz and Gazebo">Export URDF</button><button class="btn adv" id="rpImp" title="Load a robot from a URDF file">Import URDF…</button></div>
      <div class="rprow ros adv"><label>ROS 2</label><input type="text" id="rpRos" value="ws://localhost:9090" spellcheck="false"><button class="btn" id="rpRosGo">${bridge.status === 'connected' || bridge.status === 'connecting' ? 'Disconnect' : 'Connect'}</button></div>
      <div class="rpnote adv" id="rpNote">${bridge.status === 'error' ? esc(bridge.error) : bridge.status === 'connected' ? 'Publishing /joint_states and /formframe/pose; listening to /cmd_vel and /formframe/joint_commands.' : 'Needs rosbridge_server on the ROS side.'}</div>
    </div>` : ''}`;
  $('#rpToggle').onclick = () => { open = !open; render(); };
  if (!open) { live(); return; }
  panel.querySelectorAll<HTMLElement>('.rpr').forEach(r => {
    const inp = r.querySelector('input')!;
    inp.oninput = () => { sim!.manual.set(r.dataset.id!, +inp.value); if (firmwareRunning()) toast('The firmware is driving the joints: stop it to use the sliders'); };
  });
  $('#rpRec').onclick = () => {
    const poses = (sp.poses ??= []);
    poses.push({ name: `Pose ${poses.length + 1}`, joints: Object.fromEntries(sim!.joints.map(j => [j.id, Math.round((sim!.manual.get(j.id) ?? j.target) * 10) / 10])) });
    A.changed('product'); render(); toast(`Recorded pose ${poses.length}`);
  };
  $('#rpClr').onclick = () => { sp.poses = []; A.changed('product'); render(); };
  $('#rpPlay').onclick = () => play();
  $('#rpIns').onclick = () => insertPoses();
  panel.querySelectorAll<HTMLElement>('.rppose').forEach(e => (e.onclick = () => { const p = sp.poses![+e.dataset.i!]; for (const [id, q] of Object.entries(p.joints)) sim!.manual.set(id, q); }));
  $('#rpWorld').onchange = e => { sp.world = WORLDS[(e.target as HTMLSelectElement).value].make(); sim!.reset(); A.changed('product'); track('model', `Robot world: ${WORLDS[(e.target as HTMLSelectElement).value].label}`); };
  panel.querySelectorAll<HTMLElement>('.rpdel').forEach(b => (b.onclick = () => {
    const obs = sp.world!.obstacles, [o] = obs.splice(+b.dataset.i!, 1);
    A.changed('product'); render(); toast(`Removed the ${objName(o).toLowerCase()}`); track('model', `Robot world: removed the ${objName(o).toLowerCase()}`);
  }));
  panel.querySelectorAll<HTMLElement>('.rpatt').forEach(b => (b.onclick = () => {
    if (firmwareRunning()) { toast('Stop the code to attach parts'); return; }
    const o = sp.world!.obstacles[+b.dataset.i!], name = objName(o);
    const made = attachLoose(A.project, +b.dataset.i!, sim!.body.m);
    if (!made) { toast(`Couldn't attach the ${name.toLowerCase()}`); return; }
    A.changed('product'); render();
    toast(`Attached the ${name} to the robot. Fine-tune its spot in Design (drag its handles).`);
    track('model', `Attached the ${name} to the robot`);
  }));
  $('#rpAddBlock').onclick = () => {
    const obs = sp.world!.obstacles, taken = (x: number, z: number) => obs.some(o => Math.hypot(o.pos[0] - x, o.pos[1] - z) < 30);
    // the arm's pick spot first (where main.py reaches for it), else the next free spot along the table
    const spots: [number, number][] = sp.kind === 'arm' ? [ARM_PICK, [-60, 180], [0, 200], [60, 180]] : [[0, 200], [-80, 200], [80, 200]];
    const at = spots.find(([x, z]) => !taken(x, z)) ?? [spots[0][0], spots[0][1] + 40 * obs.length];
    obs.push(pickBlock(at as [number, number]));
    A.changed('product'); render(); track('model', 'Robot world: added a block');
    selectWorldObject(obs.length - 1); // comes in with its move handles showing
  };
  panel.querySelectorAll<HTMLSelectElement>('.rpmat').forEach(s => (s.onchange = () => {
    const o = sp.world!.obstacles[+s.dataset.i!]; o.material = s.value as ObstacleMaterial; delete o.mass;
    A.changed('product'); render(); toast(objTitle(o)); track('model', `Robot world: the ${objName(o).toLowerCase()} is now ${MATERIALS[o.material].label.toLowerCase()}`);
  }));
  $('#rpAddBox').onclick = () => {
    const obs = sp.world!.obstacles, n = obs.filter(o => o.name?.startsWith('Cardboard box')).length;
    const at: [number, number] = sp.kind === 'arm' ? [0, 230 + 30 * n] : [((n % 3) - 1) * 220, 450 + Math.floor(n / 3) * 220];
    obs.push(sp.kind === 'arm' ? { shape: 'box', pos: at, size: [50, 40, 50], color: '#c9a36b', name: 'Cardboard box', material: 'cardboard' } : { shape: 'box', pos: at, size: [160, 120, 160], color: '#c9a36b', name: 'Cardboard box', material: 'cardboard' });
    A.changed('product'); render(); track('model', 'Robot world: added a cardboard box');
    selectWorldObject(obs.length - 1); // comes in with its move handles showing
  };
  $('#rpPhys').onchange = async e => { sp.physics = !!(e.target as HTMLSelectElement).value; sim!.reset(); await sim!.setPhysics(!!sp.physics, A.project.electronics.comps); A.changed('product'); toast(sp.physics ? 'Realistic physics: gravity, mass, friction, collisions and servo torque limits' : 'Physics off: ideal motion, the robot passes through things'); };
  $('#rpMobile').onchange = e => { sp.mobile = (e.target as HTMLSelectElement).value as any; sim!.reset(); A.changed('product'); };
  $('#rpMass').onchange = e => { sp.mass = Math.max(10, +(e.target as HTMLInputElement).value); A.changed('product'); };
  if (becs.length) $('#rpAmps').onchange = e => { becs[0].props = { ...becs[0].props, amps: Math.max(1, +(e.target as HTMLInputElement).value) }; A.changed('electronics'); };
  $('#rpReset').onclick = () => resetRobot();
  $('#rpDraw').onclick = () => { if (!sp.world) { sp.world = WORLDS.floor.make(); A.changed('product'); render(); } openDraw(); };
  $('#rpUrdf').onclick = () => { download(`${A.project.name.replace(/[^\w-]+/g, '_') || 'robot'}.urdf`, exportUrdf(model()!, A.project.name), 'application/xml'); toast('Exported URDF: metres, Z up, x forward'); };
  $('#rpImp').onclick = () => importDialog();
  $('#rpRosGo').onclick = () => { if (bridge.status === 'connected' || bridge.status === 'connecting') bridge.close(); else bridge.connect(($('#rpRos') as HTMLInputElement).value.trim()); };
  live();
}

/** Live values (10 Hz): joint readouts, sliders following the firmware, state line. */
function live() {
  if (!sim) return;
  const st = document.getElementById('rpState');
  const run = firmwareRunning(), sp = model()?.robot;
  if (st) st.textContent = sim.legs.fallen ? 'fallen over' : sim.stalled ? 'blocked' : run ? 'firmware driving' : sim.cmdVel && performance.now() - sim.cmdVel.t < 1000 ? 'ROS /cmd_vel' : 'teach mode';
  if (!open) return;
  for (const j of sim.joints) {
    const r = document.querySelector<HTMLElement>(`#robotPanel .rpr[data-id="${j.id}"]`); if (!r) continue;
    const inp = r.querySelector('input')!, v = r.querySelector('.rpv')!;
    if (document.activeElement !== inp && (run || j.driven)) inp.value = String(j.joint.type === 'wheel' ? ((j.q % 360) + 540) % 360 - 180 : j.q);
    const unit = j.joint.type === 'prismatic' ? ' mm' : '°';
    v.textContent = `${j.joint.type === 'wheel' ? Math.round(((j.q % 360) + 360) % 360) : j.q.toFixed(j.joint.type === 'prismatic' ? 1 : 0)}${unit}${j.sag ? ` · sags ${Math.abs(j.sag).toFixed(0)}°` : ''}`;
    (v as HTMLElement).title = j.load ? `Load ${j.load.toFixed(1)} kg·cm of ${j.torque} kg·cm stall${j.sag ? ': the servo can\'t hold it' : ''}` : '';
    r.classList.toggle('drv', j.driven);
  }
  const note = document.getElementById('rpNote');
  if (note && sp?.mobile === 'legs' && sim.legs.fallen) note.textContent = 'It fell over: the centre of mass left the feet. Reset position to stand it up.';
}

/** Animate the recorded poses with the sliders (teach mode preview). */
function play() {
  const poses = spec().poses ?? []; if (!poses.length || !sim) { toast('Record a pose first'); return; }
  let i = 0;
  const next = () => { if (!sim || i >= poses.length) return; for (const [id, q] of Object.entries(poses[i].joints)) sim.manual.set(id, q); i++; setTimeout(next, 900); };
  next();
}

/** Write the recorded poses into main.py (POSES = [...]) as servo-relative angles in the joints' channel order. */
function insertPoses() {
  const e = A.project.electronics, f = e.files['main.py'];
  const poses = spec().poses ?? [];
  if (!poses.length) { toast('Record a pose first'); return; }
  const js = sim!.joints.filter(j => j.joint.drive);
  const order = [...js].sort((a, b) => (a.joint.drive!.channel ?? 0) - (b.joint.drive!.channel ?? 0));
  // grippers: two fingers on one channel → one value; prismatic mm → servo angle offset from 90
  const seen = new Set<string>(), cols = order.filter(j => { const k = `${j.joint.drive!.comp}:${j.joint.drive!.channel ?? 0}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const val = (j: typeof cols[number], q: number) => (j.joint.type === 'prismatic' ? Math.round((q - (j.joint.min ?? 0)) / ((j.joint.max ?? 10) - (j.joint.min ?? 0)) * 180 - 90) : Math.round((j.joint.drive!.invert ? -1 : 1) * (q - (j.joint.drive!.offset ?? 0))));
  const rows = poses.map(p => `    [${cols.map(j => val(j, p.joints[j.id] ?? 0)).join(', ')}],   # ${p.name}`);
  const block = `POSES = [   # ${cols.map(j => j.name).join(', ')} (degrees from centre)\n${rows.join('\n')}\n]`;
  if (!f) { navigator.clipboard?.writeText(block); toast('Copied the poses (no main.py here)'); return; }
  const re = /^POSES = \[[\s\S]*?^\]|^POSES = \[\].*$/m;
  e.files['main.py'] = re.test(f) ? f.replace(re, block) : `${block}\n\n${f}`;
  e.filesEdited = true;
  A.changed('electronics'); toast(`Put ${poses.length} pose${poses.length > 1 ? 's' : ''} into main.py (POSES)`);
  track('code', `Inserted ${poses.length} taught robot poses into main.py`);
}

function importDialog() {
  const inp = el('input'); inp.type = 'file'; inp.accept = '.urdf,.xml';
  inp.onchange = async () => {
    const file = inp.files?.[0]; if (!file) return;
    try {
      const r = importUrdf(await file.text());
      A.project.product.source = 'built';
      A.project.product.built = { parts: r.parts, xray: false, auto: defaultAutoOpts(), notes: r.notes, robot: { kind: 'custom', mobile: 'fixed', mass: 1000 } };
      await A.rebuildProduct(); A.changed('product'); sim = null; render();
      toast(`Imported ${r.name}: ${r.notes.join(' ')}`);
      track('model', `Imported the URDF robot ${r.name}`);
    } catch (e: any) { toast("Couldn't import that URDF: " + e.message); }
  };
  inp.click();
}
