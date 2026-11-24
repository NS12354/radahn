/**
 * Crash test (Review tab): drop the robot or device, run it into a wall, or hit
 * it with something, watch it happen in the 3D view, then read what broke and why.
 * Damage stays on the model (tinted amber / red, and it changes how the robot
 * behaves) until Repair.
 */
import * as THREE from 'three';
import type { App } from './app';
import { $, esc, toast } from './dom';
import { BuiltProduct } from '../scene/built';
import { CrashLab, ORIENTS, type CrashKind, type CrashReport, type CrashSpec, type Orient } from '../app/crash';
import { isRobot } from '../app/robot';
import { robotSim, resetRobot } from './robot';
import { track } from './track';

let A: App;
let lab: CrashLab | null = null;
let report: CrashReport | null = null;
let showing = false; // the final pose of a finished test is still on screen
let sig = '';
const spec: CrashSpec = { kind: 'drop', height: 1000, orient: 'flat', speed: 1, mass: 200 };
let statusT = 0;

export const crashActive = () => !!lab || showing;

export function initCrash(app: App) { A = app; }

const model = () => A.project.product.built ?? null;

/** Per frame: run the test, keep the damage tint current, re-render when the project changes. */
export function crashFrame(dt: number) {
  const m = model(), prod = A.product;
  if (prod instanceof BuiltProduct && m && prod.model === m) prod.setDamage(m.damage);
  const s = `${A.projectId}|${A.mode}|${!!m}|${m && isRobot(m)}`;
  if (s !== sig) {
    const proj = sig.split('|')[0] !== String(A.projectId);
    sig = s; if (A.mode !== 'review' && (lab || showing)) done();
    if (proj) { report = null; spec.height = m && isRobot(m) ? 500 : 1000; } // a sensible drop for what it is
    render();
  }
  if (!lab || !(prod instanceof BuiltProduct)) return;
  const finished = lab.step(dt);
  prod.setPose(lab.pose()); prod.setObjects(lab.objectPoses());
  statusT += dt;
  if (statusT > 0.15) { statusT = 0; const st = document.getElementById('crStatus'); if (st) st.textContent = `${lab.t.toFixed(1)} s · ${lab.events.length ? lab.events.length + ' broken so far' : 'nothing broken yet'}`; }
  if (finished) finish();
}

function finish() {
  if (!lab) return;
  report = lab.report();
  lab.dispose(); lab = null; showing = true;
  A.changed('review');
  track('review', `Crash test: ${report.title}. ${report.summary}`, report.broken === 0);
  render();
}

/** Put the model back (the damage stays). */
function done() {
  lab?.dispose(); lab = null; showing = false;
  const m = model(), prod = A.product;
  if (!(prod instanceof BuiltProduct)) return;
  prod.setObjects(new Map());
  if (m && isRobot(m)) { resetRobot(); A.viewport.frame(prod.group); }
  else { prod.setPose(null); prod.setWorld(null); A.viewport.showFloor(true); A.viewport.frame(prod.group); }
  render();
}

async function run() {
  const m = model(), prod = A.product;
  if (!m || !(prod instanceof BuiltProduct)) return;
  if (lab) return;
  const sim = robotSim(), robot = isRobot(m) && !!sim;
  const comps = A.project.electronics.comps;
  report = null; showing = false;
  try {
    const pose = robot ? sim!.pose : new Map<string, THREE.Matrix4>();
    lab = await CrashLab.create(m, pose, { ...spec }, uid => comps.find(c => c.uid === uid)?.type, j => (robot ? sim!.torqueOf(j) : 0));
  } catch (e: any) { toast("The crash test couldn't start: " + e.message); lab = null; render(); return; }
  prod.setWorld(lab.world); A.viewport.showFloor(false);
  prod.setPose(lab.pose()); prod.setObjects(lab.objectPoses());
  // frame the model and the floor under it (and the wall / projectile)
  const floor = prod.mm.localToWorld(new THREE.Vector3(0, 0, 0)), extra = [floor];
  for (const o of lab.world.obstacles) extra.push(prod.mm.localToWorld(new THREE.Vector3(o.pos[0], o.size[1] / 2, o.pos[1])));
  A.viewport.frame(prod.group, extra);
  render();
}

function repair() {
  const m = model(); if (!m) return;
  delete m.damage; report = null;
  A.changed('review');
  if (isRobot(m)) resetRobot();
  toast('Repaired: every part is as good as new');
  track('review', 'Repaired all crash damage');
  render();
}

function render() {
  const box = document.getElementById('secCrash'); if (!box || !A) return;
  const m = model();
  if (!m) {
    box.innerHTML = `<h3>Crash test</h3><div class="note">Crash tests need a model made of parts. In <b>Design</b>, press <b>Auto build</b> (or build one), then come back.</div><button class="btn" id="crBuild" style="margin-top:8px">Go to Design</button>`;
    $('#crBuild').onclick = () => A.setMode('design');
    return;
  }
  const robot = isRobot(m), damaged = Object.values(m.damage ?? {}).some(d => d.level >= 0.5);
  const kinds: [CrashKind, string][] = [['drop', 'Drop test'], ['wall', robot ? 'Drive into a wall' : 'Throw at a wall'], ['hit', 'Hit by an object']];
  const num = (id: string, label: string, v: number, unit: string, step: number, min: number, max: number) => `<div class="row"><label for="${id}">${label}</label><input type="number" id="${id}" value="${v}" step="${step}" min="${min}" max="${max}"><span class="crunit">${unit}</span></div>`;
  box.innerHTML = `<h3>Crash test <span>${robot ? 'robot' : 'device'}</span></h3>
    <div class="row"><label for="crKind">Test</label><select id="crKind">${kinds.map(([k, l]) => `<option value="${k}" ${spec.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${spec.kind === 'drop' ? num('crH', 'Height', spec.height, 'mm', 100, 50, 3000) + `<div class="row"><label for="crO">Lands</label><select id="crO">${(Object.keys(ORIENTS) as Orient[]).map(o => `<option value="${o}" ${spec.orient === o ? 'selected' : ''}>${ORIENTS[o]}</option>`).join('')}</select></div>` : ''}
    ${spec.kind === 'wall' ? num('crV', 'Speed', spec.speed, 'm/s', 0.5, 0.1, 10) : ''}
    ${spec.kind === 'hit' ? num('crM', 'Object', spec.mass, 'g', 50, 10, 5000) + num('crV', 'Speed', spec.speed, 'm/s', 0.5, 0.1, 30) : ''}
    <div class="crbtns">${lab ? `<button class="btn" id="crSkip">Skip to result</button><span class="crstatus" id="crStatus">starting…</span>` : `<button class="btn primary" id="crRun" data-ico="play">Run test</button>${showing ? '<button class="btn" id="crDone">Done</button>' : ''}${damaged ? '<button class="btn" id="crFix" data-ico="reset">Repair</button>' : ''}`}</div>
    ${report ? reportHTML(report) : damaged && !lab ? `<div class="note">This ${robot ? 'robot' : 'device'} carries damage from earlier tests or collisions (tinted on the model). Repair to start fresh.</div>` : ''}
    <div class="note">Ratings are engineering ballparks for hobby hardware (glass, solder joints, servo gears, enclosure walls). Use them to compare designs and find weak spots, not to certify a product.</div>`;
  const on = (id: string, f: (v: string) => void) => { const e = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null; if (e) e.onchange = () => { f(e.value); render(); }; };
  on('crKind', v => { spec.kind = v as CrashKind; if (spec.kind === 'hit') spec.speed = Math.max(spec.speed, 5); else if (spec.kind === 'wall') spec.speed = Math.min(spec.speed, 2); });
  on('crH', v => { spec.height = Math.max(50, Math.min(3000, +v || 500)); });
  on('crO', v => { spec.orient = v as Orient; });
  on('crV', v => { spec.speed = Math.max(0.1, Math.min(30, +v || 1)); });
  on('crM', v => { spec.mass = Math.max(10, Math.min(5000, +v || 200)); });
  const b = (id: string, f: () => void) => { const e = document.getElementById(id); if (e) e.onclick = f; };
  b('crRun', () => { void run(); });
  b('crSkip', () => { if (lab) { lab.finish(); const prod = A.product; if (prod instanceof BuiltProduct) { prod.setPose(lab.pose()); prod.setObjects(lab.objectPoses()); } finish(); } });
  b('crDone', done);
  b('crFix', repair);
}

function reportHTML(r: CrashReport) {
  const dot = (s: string) => `<i class="crdot ${s}"></i>`;
  const row = (x: CrashReport['rows'][number]) => `<div class="crrow ${x.status}">${dot(x.status)}<div><b>${esc(x.name)}</b> <span class="crwhat">${esc(x.what)}</span><div class="crload">${esc(x.load)}</div><div class="crcon">${esc(x.consequence)}</div></div></div>`;
  const knocks = r.rows.filter(x => x.status === 'knock');
  return `<div class="crrep"><div class="crh"><b>${esc(r.title)}</b><span>peak ${r.peakG.toLocaleString('en-US')} g · ${r.peakN.toLocaleString('en-US')} N</span></div>
    <div class="crsum ${r.broken ? 'bad' : r.rows.some(x => x.status === 'damaged') ? 'warn' : 'ok'}">${esc(r.summary)}</div>
    ${r.rows.filter(x => x.status !== 'knock').map(row).join('')}
    ${knocks.length ? `<details class="crmore"><summary>${knocks.length} more took a knock but work fine</summary>${knocks.map(row).join('')}</details>` : ''}</div>`;
}
