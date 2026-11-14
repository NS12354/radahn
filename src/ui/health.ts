import type { App } from './app';
import { $, $$, el, esc, toast } from './dom';
import { taps, device, fixWiring, showCode, flashCard, elecDial, elecPress } from './elec';
import { runChecks } from '../hw/checks';
import { COMPONENTS } from '../hw/library/components';
import { customOf, cardKind } from '../hw/custom';
import { explainCheck, explainSim, explainPython, explainCompile, parseTraceback, friendly, type Explained, type Level } from '../app/explain';
import { fitBuilt } from '../app/fit';
import { fitCheck } from '../app/internals';
import { screenPart } from '../app/screenpart';
import { BuiltProduct } from '../scene/built';
import { ImportedProduct } from '../scene/imported';
import { EmptyProduct } from '../scene/empty';
import { track } from './track';

/**
 * "Is it working?" — one place that collects every problem in the project
 * (wiring, code, the running simulation, the model, interactions), explains
 * it in plain language with a fix, and a self-test that runs the code,
 * presses the inputs and checks that every part responds.
 */
type Source = 'wiring' | 'model' | 'setup' | 'compile' | 'runtime' | 'interactions' | 'test' | 'silent';
let A: App;
const buckets = new Map<Source, Explained[]>();
let tested = false, everRan = false, runningSince = 0, testing = false;
let lastTest: { at: string; passed: boolean; failed: number } | undefined;
/** Progress facts for the Plan tab. */
export const healthState = () => ({ tested, everRan, lastTest, problems: all() });
let lastBroken = new Set<string>();
const key = (p: Explained) => p.area + '|' + p.title;

// ------------------------------------------------------------------ collection
function set(src: Source, list: Explained[]) { buckets.set(src, list); paint(); }
function add(src: Source, p: Explained) {
  const l = buckets.get(src) ?? []; if (l.some(x => key(x) === key(p))) return;
  l.push(p); buckets.set(src, l); paint();
  if (p.level === 'broken' && !testing) { const k = key(p); if (!lastBroken.has(k)) toast(`✕ ${p.title}`); }
  if (p.level === 'broken' && (src === 'runtime' || src === 'compile')) track(src === 'compile' ? 'compile' : 'crash', p.title, false);
}
export const all = () => [...buckets.values()].flat();

/** Re-check everything that doesn't need the code running (wiring, model, setup). */
export function refreshStatic() {
  if (!A) return;
  const e = A.project.electronics, b = A.board();
  set('wiring', runChecks(b, e.comps).map(c => explainCheck(c.msg, c.level, c.uid)).filter((x): x is Explained => !!x));
  // model
  const model: Explained[] = [], p = A.product;
  const types = new Set(e.comps.map(c => c.type));
  if (p instanceof BuiltProduct && A.project.product.built) {
    const parts = A.project.product.built.parts;
    for (const f of fitBuilt(parts)) if (f.level !== 'ok') model.push({ level: f.level === 'err' ? 'broken' : 'warning', area: 'model', title: f.msg.replace('collides with', 'bumps into').replace('sticks out of the enclosure', 'pokes out of the case'), why: 'Two solid parts can\'t be in the same place, and electronics have to fit inside the case.', fix: 'Move or resize the part in Design, or make the case bigger (Auto build can resize it).', at: { mode: 'design' } });
    const has = (r: string) => parts.some(x => x.role === r) || (r === 'screen' && !!screenPart(parts));
    const need: [string, string, string][] = [['encoder', 'dial', 'turns'], ['tft', 'screen', 'shows the display'], ['neopixel', 'led', 'lights up'], ['button', 'press', 'can be pressed']];
    for (const [t, r, verb] of need) if (types.has(t) && !has(r) && !(r === 'press' && has('screen'))) model.push({ level: 'tip', area: 'model', title: `Nothing on the 3D model ${verb} for the ${friendly(COMPONENTS[t].name)}`, why: `Give a part the ${r === 'led' ? 'LED' : r[0].toUpperCase() + r.slice(1)} role so the ${friendly(COMPONENTS[t].name).toLowerCase()} shows up on the model.`, fix: 'Select a part in Design and set its Role, or press Auto build.', at: { mode: 'design' } });
  } else if (!(p instanceof ImportedProduct) && !(p instanceof EmptyProduct) && A.project.product.source === 'parametric') {
    const f = fitCheck(A.project);
    if (!f.ok) for (const r of f.rows.filter(x => !x.ok)) model.push({ level: 'broken', area: 'model', title: `${r.n.replace(' footprint', '')} doesn't fit inside the case`, why: `Needs ${r.v}.`, fix: 'Make the case bigger in Design ▸ Enclosure, or switch off a component.', at: { mode: 'design' } });
  }
  set('model', model);
  // first steps
  const setup: Explained[] = [];
  if (!e.comps.length) setup.push({ level: 'tip', area: 'setup', title: 'No parts are wired yet', why: 'Add the buttons, sensors, lights and displays your product needs.', fix: 'Go to Electronics and click a part under "Add component".', at: { mode: 'elec' } });
  if (p instanceof EmptyProduct) setup.push({ level: 'tip', area: 'setup', title: 'Your product has no 3D model yet', fix: 'In Design, press "Auto build from electronics" to get one made for you.', at: { mode: 'design' } });
  set('setup', setup);
}

// ------------------------------------------------------------------ live: serial output, status, compile
let buf = '', recent: string[] = [];
function onSerial(text: string, cls?: string) {
  if (cls) { if (cls === 'w' || cls === 'e') for (const l of text.split('\n')) if (/^\[sim\]/.test(l)) add('runtime', explainSim(l)); return; }
  buf += text.replace(/\x04/g, '').replace(/\r/g, '');
  const parts = buf.split('\n'); buf = parts.pop()!;
  for (const l of parts) {
    recent.push(l); if (recent.length > 14) recent.shift();
    if (/^\[sim\]/.test(l)) { add('runtime', explainSim(l)); continue; }
    if (/^Traceback: /.test(l) || /^\w+(Error|Exception)\b/.test(l)) {
      const tb = parseTraceback(/^Traceback: /.test(l) ? [l] : recent);
      if (tb && tb.type !== 'KeyboardInterrupt') add('runtime', explainPython(tb.type, tb.message, tb.line, A.project.electronics.files, tb.file && A.project.electronics.files[tb.file] != null ? tb.file : 'main.py'));
      recent = [];
    }
  }
}
function onStatus(running: boolean, text: string) {
  if (running && text === 'starting') { track('run', `Ran the code on the ${A.board().name}`); set('runtime', []); set('silent', []); buf = ''; recent = []; runningSince = performance.now(); everRan = true; lastBroken = new Set(all().filter(p => p.level === 'broken').map(key)); }
  if (!running) runningSince = 0;
  paint();
}
function onCompile(text: string, ok: boolean | null) {
  if (ok === null) set('compile', []);
  else if (ok) { set('compile', []); track('compile', 'Sketch compiled', true); }
  else set('compile', explainCompile(text, A.project.electronics.files));
}
/** The code was edited: errors from the last run may no longer apply. */
export function codeChanged() {
  if (!(buckets.get('runtime')?.length || buckets.get('compile')?.length || buckets.get('test')?.length || tested)) return;
  buckets.set('runtime', []); buckets.set('compile', []); buckets.set('test', []); buckets.set('silent', []); tested = false; $('#ptest').innerHTML = ''; paint();
}
/** The wiring changed: the last test result no longer applies. */
export function wiringEdited() { if (!tested && !buckets.get('test')?.length) return; buckets.set('test', []); tested = false; $('#ptest').innerHTML = ''; paint(); }
/** The prototype got an event its interactions don't handle. */
export function unhandled(state: string, trigger: string) {
  add('interactions', { level: 'tip', area: 'interactions', title: `"${trigger}" on the ${state} screen does nothing yet`, why: 'You tried it in Prototype mode, but no interaction handles it.', fix: 'Add an interaction for it in the Interactions list (Prototype mode).', at: { mode: 'proto' } });
}

// ------------------------------------------------------------------ per-part liveness
const OUT_UI = new Set(['led', 'ring', 'screen', 'relay', 'haptic', 'buzzer', 'servo']);
function role(type: string): 'out' | 'in' | 'sensor' | 'bus' {
  const s = customOf(type); if (s) { const k = cardKind(s); return k === 'led' ? 'out' : k === 'generic' ? 'bus' : 'in'; }
  const ui = COMPONENTS[type]?.ui; return ui && OUT_UI.has(ui) ? 'out' : ui === 'sensor' ? 'sensor' : 'in';
}
const stateSig = new Map<string, string>(), stateAct = new Map<string, number>();
function activity(uid: string) {
  const m = A.bench.model(uid); let changed = stateAct.get(uid) ?? 0;
  try { const s = JSON.stringify(m?.state ?? {}); if (stateSig.has(uid) && stateSig.get(uid) !== s) changed++; stateSig.set(uid, s); } catch { }
  stateAct.set(uid, changed);
  return A.bench.activity(uid) + changed;
}
function tickParts() {
  const running = device.running(), secs = runningSince ? (performance.now() - runningSince) / 1000 : 0;
  const silent: Explained[] = [];
  for (const c of A.project.electronics.comps) {
    const name = friendly(COMPONENTS[c.type]?.name ?? c.type), r = role(c.type), act = running ? activity(c.uid) : 0;
    const bad = all().find(p => p.level === 'broken' && p.at?.uid === c.uid);
    let cls = 'off', tip = 'Press Run to check this part';
    if (bad) { cls = 'bad'; tip = bad.title; }
    else if (running) {
      if (r === 'out' || r === 'bus' || r === 'sensor') { if (act > 0) { cls = 'ok'; tip = r === 'out' ? 'Working: getting signals from your code' : 'Working: your code talks to it'; } else if (secs > 5) { cls = 'idle'; tip = r === 'out' ? 'No signal from your code yet' : 'Your code hasn\'t read it yet'; silent.push({ level: 'tip', area: 'running', title: r === 'out' ? `The ${name} hasn't received anything from your code` : `Your code hasn't read the ${name}`, why: 'It\'s wired, but the running code never used it. That\'s fine if you haven\'t written that part yet.', fix: 'Check the pin numbers in your code match the bench, and that the code actually uses this part.', at: { uid: c.uid, mode: 'elec' } }); } else { cls = 'wait'; tip = 'Waiting for your code…'; } }
      else { cls = 'ready'; tip = 'Ready: press or turn it on the bench or the 3D model'; }
    }
    const d = document.querySelector<HTMLElement>(`.card[data-uid="${c.uid}"] .pdot`); if (d) { d.className = 'pdot ' + cls; d.title = tip; }
  }
  if (running && JSON.stringify(silent.map(key)) !== JSON.stringify((buckets.get('silent') ?? []).map(key))) set('silent', silent);
  if (running && secs > 6 && !all().some(p => p.level === 'broken') && !tested) { tested = true; paint(); }
}

// ------------------------------------------------------------------ fix / show
function doFix(p: Explained) {
  const f = p.autofix!; let done: string | null = null;
  if (f.kind === 'pullup') {
    const e = A.project.electronics, file = Object.keys(e.files).find(n => n.endsWith('.py') && new RegExp(`Pin\\(\\s*${f.pin}\\s*,\\s*Pin\\.IN\\s*\\)`).test(e.files[n]));
    if (file) { device.setFile(file, e.files[file].replace(new RegExp(`Pin\\(\\s*${f.pin}\\s*,\\s*Pin\\.IN\\s*\\)`, 'g'), `Pin(${f.pin}, Pin.IN, Pin.PULL_UP)`)); done = `Added Pin.PULL_UP to pin ${f.pin} in ${file}`; }
    else { toast(`Couldn't find Pin(${f.pin}, Pin.IN) in your code. Add Pin.PULL_UP to it yourself.`); return; }
  } else done = fixWiring(f.kind, f.uid, f.role);
  if (done) { toast('Fixed: ' + done); refreshStatic(); if (device.running()) toast('Press Run again to try the fix'); }
  else toast('Couldn\'t find a free pin for that. Free one up, or pick a pin on the bench yourself.');
}
function showMe(p: Explained) {
  const at = p.at ?? {};
  if (at.file || at.line) { showCode(at.file, at.line); return; }
  if (at.uid) { flashCard(at.uid); return; }
  if (at.pin != null) { const c = A.project.electronics.comps.find(x => Object.values(x.pins).includes(at.pin!)); if (c) flashCard(c.uid); else { A.setMode('elec'); } const e = A.project.electronics, f = Object.keys(e.files).find(n => new RegExp(`Pin\\(\\s*${at.pin}\\b|\\b${at.pin}\\b`).test(e.files[n])); if (f && !c) { const line = e.files[f].split('\n').findIndex(l => new RegExp(`Pin\\(\\s*${at.pin}\\b`).test(l)) + 1; showCode(f, line || undefined); } return; }
  if (at.mode) A.setMode(at.mode);
}

// ------------------------------------------------------------------ the self-test
interface Row { ok: boolean | null; text: string; why?: string }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function runTest() {
  if (testing) return;
  const e = A.project.electronics;
  if (!e.comps.length) { openPanel(); renderTest([{ ok: null, text: 'Add some parts in Electronics first, then test them.' }], false); return; }
  testing = true; openPanel();
  const rows: Row[] = []; const step = (t: string) => renderTest([...rows, { ok: null, text: t + '…' }], true);
  try {
    A.setMode('elec');
    step('Starting your code');
    if (!device.running()) device.run();
    const t0 = performance.now();
    while (performance.now() - t0 < 25000 && !(device.running() && performance.now() - runningSince > 4500) && !all().some(p => p.level === 'broken' && (p.area === 'code' || p.area === 'running'))) await sleep(250);
    const crash = all().filter(p => p.level === 'broken' && (p.area === 'code' || p.area === 'running'));
    if (!device.running() || crash.some(p => p.area === 'code')) {
      rows.push({ ok: false, text: 'Your code didn\'t start', why: crash[0]?.title ?? 'It stopped before it got going. See the problems below.' });
      return finish(rows);
    }
    rows.push({ ok: true, text: 'Your code is running' });
    const outputs = e.comps.filter(c => role(c.type) !== 'in');
    const snap = () => new Map(outputs.map(c => [c.uid, activity(c.uid)]));
    const nm = (c: { type: string }) => friendly(COMPONENTS[c.type]?.name ?? c.type);
    // poke every input and see which outputs react
    for (const c of e.comps.filter(x => role(x.type) === 'in' || COMPONENTS[x.type]?.ui === 'sensor')) {
      const ui = COMPONENTS[c.type]?.ui, m = A.bench.model(c.uid), bound = A.bench.bound(c.type)?.c.uid === c.uid;
      step(`Trying the ${nm(c)}`);
      const before = snap(), act0 = activity(c.uid);
      if (ui === 'encoder') { for (const d of [1, 1, 1, -1, -1, -1]) { bound ? elecDial(d) : m?.sim?.turn(d); await sleep(350); } }
      else if (ui === 'button' || customOf(c.type) && cardKind(customOf(c.type)!) === 'button') { for (let i = 0; i < 2; i++) { bound ? elecPress(true) : m?.sim?.press(true); await sleep(350); bound ? elecPress(false) : m?.sim?.press(false); await sleep(500); } }
      else if (ui === 'pot' || customOf(c.type) && cardKind(customOf(c.type)!) === 'pot') { m?.sim?.set(0.1); await sleep(900); m?.sim?.set(0.9); await sleep(900); }
      else if (ui === 'sensor') { const env = A.project.env, was = env.roomC; env.roomC = was + 4; await sleep(2200); env.roomC = was; }
      await sleep(1200);
      const after = snap(), reacted = outputs.filter(o => o.uid !== c.uid && (after.get(o.uid) ?? 0) > (before.get(o.uid) ?? 0)).map(nm);
      if (ui === 'sensor') rows.push(activity(c.uid) > act0 || A.bench.activity(c.uid) > 0 ? { ok: true, text: `Your code reads the ${nm(c)}${reacted.length ? ` (a change made the ${reacted.join(', ')} update)` : ''}` } : { ok: false, text: `Your code never reads the ${nm(c)}`, why: 'Check the SDA/SCL pins and the address in your code.' });
      else rows.push(reacted.length ? { ok: true, text: `${ui === 'encoder' ? 'Turning' : ui === 'pot' ? 'Moving' : 'Pressing'} the ${nm(c)} changes the ${reacted.join(', ')}` } : { ok: null, text: `${ui === 'encoder' ? 'Turning' : ui === 'pot' ? 'Moving' : 'Pressing'} the ${nm(c)} didn't visibly change anything`, why: 'Fine if it isn\'t meant to yet. Otherwise check its pin number in your code.' });
    }
    step('Checking every part got a signal');
    await sleep(800);
    for (const c of outputs.filter(x => COMPONENTS[x.type]?.ui !== 'sensor')) rows.push(activity(c.uid) > 0 ? { ok: true, text: `The ${nm(c)} is getting signals from your code` } : { ok: false, text: `The ${nm(c)} never got a signal`, why: 'Your code doesn\'t seem to use it. Check its pin numbers in the code match the bench.' });
    const errs = all().filter(p => p.level === 'broken' && (p.area === 'running' || p.area === 'code'));
    rows.push(errs.length ? { ok: false, text: `${errs.length} error${errs.length > 1 ? 's' : ''} while running`, why: errs[0].title } : { ok: true, text: 'No errors while running' });
    return finish(rows);
  } finally { testing = false; }
  function finish(r: Row[]) {
    const failed = r.filter(x => x.ok === false);
    set('test', failed.map(x => ({ level: 'warning' as Level, area: 'test' as const, title: x.text, why: x.why, at: { mode: 'elec' as const } })));
    tested = !failed.length;
    lastTest = { at: new Date().toISOString(), passed: !failed.length, failed: failed.length };
    track('test', failed.length ? `Test it: ${r.filter(x => x.ok).length} passed, ${failed.length} failed (${failed.map(x => x.text).join('; ')})` : `Test it passed: ${r.filter(x => x.ok).length} checks (${r.filter(x => x.ok).map(x => x.text).join('; ')})`, !failed.length);
    renderTest(r, false);
    toast(failed.length ? `Test finished: ${failed.length} thing${failed.length > 1 ? 's' : ''} to fix` : 'Test passed: everything responded');
  }
}
function renderTest(rows: Row[], busy: boolean) {
  const t = $('#ptest');
  t.innerHTML = `<div class="pth">${busy ? '<i class="spin"></i>Testing…' : 'Test results'}<span>${busy ? '' : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>` +
    rows.map(r => `<div class="ptr ${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'mid'}"><b>${r.ok === true ? '✓' : r.ok === false ? '✕' : '•'}</b><div><div>${esc(r.text)}</div>${r.why ? `<div class="pw">${esc(r.why)}</div>` : ''}</div></div>`).join('');
  ($('#bTest') as HTMLButtonElement).disabled = busy;
}

// ------------------------------------------------------------------ UI
const AREA: Record<string, [string, string]> = { wiring: ['Wiring', 'elec'], code: ['Code', 'elec'], running: ['While running', 'elec'], model: ['3D model', 'design'], interactions: ['Interactions', 'proto'], setup: ['Getting started', ''], test: ['Test', 'elec'] };
export function openPanel() { document.body.classList.add('problems-open'); paint(); requestAnimationFrame(() => A.viewport.resize()); }
function paint() {
  if (!A) return;
  const ps = all(), broken = ps.filter(p => p.level === 'broken'), warn = ps.filter(p => p.level === 'warning'), tips = ps.filter(p => p.level === 'tip');
  const pill = $('#bHealth'), comps = A.project.electronics.comps.length;
  let cls: string, label: string;
  if (broken.length) { cls = 'bad'; label = `${broken.length} thing${broken.length > 1 ? 's' : ''} broken`; }
  else if (warn.length) { cls = 'warn'; label = `${warn.length} thing${warn.length > 1 ? 's' : ''} to check`; }
  else if (!comps) { cls = 'none'; label = 'Add parts to start'; }
  else if (!tested) { cls = 'none'; label = 'Not tested yet'; }
  else { cls = 'ok'; label = 'Working'; }
  pill.className = 'health ' + cls; pill.innerHTML = `<i></i><span>${label}</span>`;
  pill.title = 'Is it working? Click for details, fixes and a self-test.';
  const k = broken.map(key).join();
  if (broken.length && pill.dataset.k !== k) { pill.classList.add('pulse'); setTimeout(() => pill.classList.remove('pulse'), 1200); }
  pill.dataset.k = k;
  // dots on the mode tabs
  const byMode: Record<string, Level | null> = { design: null, proto: null, elec: null, review: null };
  for (const p of ps) { const m = AREA[p.area]?.[1]; if (!m || p.level === 'tip') continue; if (byMode[m] !== 'broken') byMode[m] = p.level; }
  $$('#modes button').forEach(b => { b.classList.toggle('dot-bad', byMode[b.dataset.m!] === 'broken'); b.classList.toggle('dot-warn', byMode[b.dataset.m!] === 'warning'); });
  if (!document.body.classList.contains('problems-open')) return;
  // panel
  $('#psum').innerHTML = cls === 'ok' ? '<b class="ok">Everything works.</b> Your code ran and every part responded.' : cls === 'bad' ? `<b class="bad">Something isn't working.</b> Start with the red items below.` : cls === 'warn' ? '<b class="warn">It runs, with things to check.</b>' : !comps ? 'Add parts in Electronics, then press <b>Test it</b>.' : 'Press <b>Test it</b> to run your code and check every part responds.';
  const list = $('#plist'); list.innerHTML = '';
  const group = (title: string, items: Explained[], lv: string) => {
    if (!items.length) return;
    list.appendChild(el('div', 'pgh ' + lv, `${title} <span>${items.length}</span>`));
    for (const p of items) {
      const c = el('div', 'pcard2 ' + lv);
      c.innerHTML = `<div class="pa">${esc(AREA[p.area]?.[0] ?? p.area)}</div><div class="pt">${fmt(p.title)}</div>${p.why ? `<div class="pw">${fmt(p.why)}</div>` : ''}${p.fix ? `<div class="pf"><b>How to fix:</b> ${fmt(p.fix)}</div>` : ''}<div class="pb"></div>`;
      const pb = c.querySelector('.pb')!;
      if (p.autofix) { const b = el('button', 'btn primary', esc(p.autofix.label)); b.onclick = () => doFix(p); pb.appendChild(b); }
      if (p.at) { const b = el('button', 'btn', p.at.file || p.at.line ? `Show line ${p.at.line ?? ''}`.trim() : 'Show me'); b.onclick = () => showMe(p); pb.appendChild(b); }
      list.appendChild(c);
    }
  };
  group('Broken', broken, 'bad'); group('Check', warn, 'warn'); group('Tips', tips, 'tip');
  if (!ps.length) list.appendChild(el('div', 'pnone', comps ? 'No problems found.' : ''));
}
const fmt = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

export function initHealth(app: App) {
  A = app;
  taps.out.push(onSerial); taps.status.push(onStatus); taps.compile.push(onCompile);
  const resize = () => requestAnimationFrame(() => A.viewport.resize());
  $('#bHealth').onclick = () => { if (document.body.classList.toggle('problems-open')) paint(); resize(); };
  $('#pClose').onclick = () => { document.body.classList.remove('problems-open'); resize(); };
  $('#bTest').onclick = () => runTest();
  setInterval(() => { if (A.project) tickParts(); }, 700);
  refreshStatic();
}
/** A different project was opened. */
export function resetHealth() { buckets.clear(); tested = false; everRan = false; lastTest = undefined; $('#ptest').innerHTML = ''; refreshStatic(); }
