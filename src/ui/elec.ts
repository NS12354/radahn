import type { App } from './app';
import { $, $$, b64decode, el, esc, toast } from './dom';
import { BOARDS, KIT_PRESETS, pinLabel } from '../hw/library/boards';
import { COMPONENTS } from '../hw/library/components';
import { runChecks, buildPinMap } from '../hw/checks';
import { RP2040Runtime } from '../hw/runtimes/rp2040';
import { AVRRuntime } from '../hw/runtimes/avr';
import { SimPythonRuntime } from '../hw/runtimes/sim-python';
import { SerialDeviceRuntime } from '../hw/runtimes/serial-device';
import { audio } from '../hw/audio';
import { nextColor, newUid, starterFiles } from '../app/project';
import { cardKind, customOf } from '../hw/custom';
import { initParts, renderLib } from './parts';
import { codeChanged, wiringEdited, openPanel } from './health';
import { track } from './track';
import { gh, GH_MIME, CODE_EXT, type GhDrag } from '../app/github';
import { explainCheck } from '../app/explain';

/** Card/visual type: built-ins use their own type; imported parts borrow the closest built-in card. */
const kind = (c: CompInstance) => { const s = customOf(c.type); return s ? cardKind(s) : c.type; };
import type { CompInstance, Runtime } from '../hw/types';

type AnyRuntime = Runtime & { onExit?: (e: string) => void; interrupt?: () => void; speed?: () => number };

let target: 'virtual' | 'physical' = 'virtual';
let runtime: AnyRuntime | null = null;
let rp: RP2040Runtime, avr: AVRRuntime, sim: SimPythonRuntime, dev: SerialDeviceRuntime;
let firmwareCache: Promise<Uint8Array> | null = null;
let compiled: { key: string; hex: string } | null = null;
let A: App;

const board = () => A.board();
const files = () => A.project.electronics.files;
const label = (g: number) => pinLabel(board(), g);

// ------------------------------------------------------------------ device IDE bridge hooks (see ui/devicebridge.ts)
/** Extra listeners (the problems panel) on serial output, run status and compile results. */
export const taps = { out: [] as ((t: string, cls?: string) => void)[], status: [] as ((running: boolean, t: string) => void)[], compile: [] as ((t: string, ok: boolean | null) => void)[] };
export const bridge = {
  out: (_text: string, _cls?: string) => {},
  status: (_running: boolean, _text: string) => {},
  compile: (_text: string, _ok: boolean | null) => {},
  files: () => {},
};

const emitCompile = (t: string, ok: boolean | null) => { bridge.compile(t, ok); for (const f of taps.compile) f(t, ok); };

// ------------------------------------------------------------------ serial
let partial = '';
function serial(text: string, cls?: string) {
  bridge.out(text, cls); for (const f of taps.out) f(text, cls);
  const s = $('#serial');
  if (cls) { const d = el('div', cls); d.textContent = text; s.appendChild(d); }
  else {
    partial += text.replace(/\x04/g, '').replace(/\r/g, '');
    const parts = partial.split('\n'); partial = parts.pop()!;
    for (const p of parts) { if (p.startsWith('@ff ')) continue; const d = el('div'); d.textContent = p; s.appendChild(d); }
    if (partial && !partial.startsWith('@ff') && /^>>> $|^\.\.\. $/.test(partial)) { const d = el('div'); d.textContent = partial; s.appendChild(d); partial = ''; }
  }
  while (s.children.length > 400) s.firstChild!.remove();
  s.scrollTop = s.scrollHeight;
}
let lastStatus = 'idle';
const status = (t: string) => { lastStatus = t; $('#runStatus').textContent = t; bridge.status(!!runtime, t); for (const f of taps.status) f(!!runtime, t); }; // "running" includes starting up

// ------------------------------------------------------------------ runtimes
function firmware() {
  // Shipped as base64 text so any static host serves it.
  return (firmwareCache ||= fetch(A.base + 'firmware/micropython-rp2-pico-v1.24.1.uf2.b64.txt').then(r => { if (!r.ok) throw new Error('MicroPython firmware missing'); return r.text(); }).then(t => new Uint8Array(b64decode(t.trim()))));
}
function wire(r: AnyRuntime) {
  r.onSerial = t => serial(t);
  r.onStatus = s => status(s);
  r.onExit = () => { setRunUI(); };
  return r;
}
function ensureRuntimes() {
  if (rp) return;
  rp = wire(new RP2040Runtime(A.bench, firmware)) as any;
  avr = wire(new AVRRuntime(A.bench)) as any;
  sim = wire(new SimPythonRuntime(A.bench, A.base)) as any;
  dev = wire(new SerialDeviceRuntime(A.bench, () => A.product)) as any;
  A.bench.onLog = (m, l) => serial(m, l === 'e' ? 'e' : 'w');
}
function pickRuntime(): AnyRuntime {
  if (target === 'physical') return dev;
  return ({ 'rp2040-emu': rp, 'avr-emu': avr, 'sim-python': sim, 'serial-device': dev } as any)[board().runtime];
}

async function compile(): Promise<string | null> {
  const f = files();
  if (f['firmware.hex'] && !Object.keys(f).some(k => k.endsWith('.ino'))) return f['firmware.hex'];
  const src = Object.fromEntries(Object.entries(f).filter(([k]) => /\.(ino|h|hpp|c|cpp)$/.test(k)));
  const key = JSON.stringify([board().id, src]);
  if (compiled?.key === key) return compiled.hex;
  const out = $('#compileOut'); out.className = 'compile show'; out.textContent = 'Compiling…'; emitCompile(`Compiling sketch for ${board().name}…`, null);
  try {
    const r = await fetch(A.base + 'api/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: src, board: board().id }) });
    if (r.status === 404 || !(r.headers.get('content-type') || '').includes('json')) throw Object.assign(new Error('nocompiler'), { nocompiler: true });
    const j = await r.json();
    if (!r.ok && /not found|arduino-cli|avr-gcc|toolchain/i.test(j.error ?? '')) throw Object.assign(new Error(j.error), { nocompiler: true }); // no toolchain: try the precompiled example
    if (!r.ok) { out.className = 'compile show err'; out.textContent = j.error; emitCompile(j.error, false); return null; }
    out.textContent = `✓ ${j.toolchain}\n${j.log}`; emitCompile(`${j.log || ''}\nDone compiling (${j.toolchain}).`, true);
    compiled = { key, hex: j.hex };
    return j.hex;
  } catch (e: any) {
    // Hosted build: fall back to the precompiled example when the sketch is the unmodified template
    const tpl = starterFiles(board(), A.project.electronics);
    const pristine = Object.entries(src).every(([k, v]) => tpl[k] === v);
    if (pristine && A.project.electronics.starter !== 'blank') {
      const r = await fetch(A.base + `firmware/examples/${board().id}-thermostat-${kitKey()}.hex.txt`).catch(() => null);
      if (r?.ok) { const hex = await r.text(); out.textContent = '✓ Using the precompiled example (no compiler in this build)'; emitCompile('No compiler here, so the precompiled example sketch was used.', true); compiled = { key, hex }; return hex; }
    }
    out.className = 'compile show err';
    out.textContent = 'No compiler available here. Run `npm run dev` locally (avr-gcc or arduino-cli), or add a .hex exported from Arduino IDE (Sketch → Export Compiled Binary) with the + tab.';
    emitCompile('Compilation error: no AVR compiler is installed. Run `npm run setup:toolchain`, then restart `npm run dev`.', false);
    return null;
  }
}
/** Precompiled examples are keyed by the default pin preset. */
function kitKey() {
  const p = KIT_PRESETS[board().id] ?? {};
  const matches = A.project.electronics.comps.every(c => (p[c.type] ?? []).every((g, i) => c.pins[COMPONENTS[c.type].roles[i].id] === g));
  return matches ? 'default' : 'custom';
}

async function run() {
  ensureRuntimes();
  audio.unlock();
  if (runtime?.running) await stop();
  const b = board();
  if (target === 'physical' && b.lang === 'arduino') { serial('Flashing a physical Arduino needs avrdude. Use `arduino-cli upload` locally. Web Serial upload here supports MicroPython boards.', 'w'); return; }
  if (target === 'physical' && b.lang === 'python') { serial('For a Raspberry Pi, copy main.py to the Pi and run it there. Web Serial upload supports MicroPython boards.', 'w'); return; }
  const r = pickRuntime();
  let payload = { ...files() };
  if (target === 'virtual' && b.runtime === 'avr-emu') { const hex = await compile(); if (!hex) return; payload = { 'firmware.hex': hex }; }
  else payload = Object.fromEntries(Object.entries(payload).filter(([k]) => k.endsWith('.py')));
  A.bench.reset();
  runtime = r;
  serial(`─── ${target === 'physical' ? 'physical board' : b.name + (b.fidelity === 'emulated' ? ' (emulated)' : ' (behavioral sim)')} ───`, 's');
  setRunUI(true);
  try { await r.start(payload); }
  catch (e: any) { if (runtime === r && !/cancelled/.test(String(e?.message))) { serial(String(e.message || e), 'e'); status('failed'); runtime = null; } }
  setRunUI();
}
async function stop() {
  if (!runtime) return;
  await runtime.stop();
  serial('Stopped.', 's'); status('stopped');
  A.product.setLeds(null); A.product.haptic(false); audio.silenceAll();
  runtime = null; setRunUI();
}
export const elecRunning = () => !!runtime?.running;
export function stopElec() { if (runtime?.running) stop(); }

function setRunUI(starting = false) {
  const on = starting || !!runtime?.running;
  const b = $('#bRun'); b.textContent = on ? '■ Stop' : '▶ Run'; b.classList.toggle('primary', !on);
  $('#runState').innerHTML = on ? '<span style="color:var(--ok)">● running</span>' : '<span style="color:var(--faint)">idle</span>';
  $('#bCompile').style.display = board().lang === 'arduino' && target === 'virtual' ? '' : 'none';
  bridge.status(on, on ? (starting ? 'starting' : lastStatus) : 'idle');
  for (const f of taps.status) f(on, on ? (starting ? 'starting' : lastStatus) : 'idle');
}

// ------------------------------------------------------------------ importing files (GitHub, desktop)
/** Where a file lands in this board's project: MicroPython drivers in lib/, the sketch replaces the .ino, etc. */
function destFor(name: string): string | null {
  const e = A.project.electronics, base = name.split('/').pop()!, ext = base.split('.').pop()!.toLowerCase(), lang = board().lang;
  if (ext === 'hex') return lang === 'arduino' ? 'firmware.hex' : null;
  if (lang === 'arduino') {
    if (ext === 'ino') return Object.keys(e.files).find(n => n.endsWith('.ino')) ?? base;
    return ['h', 'hpp', 'c', 'cpp'].includes(ext) ? base : null;
  }
  if (ext !== 'py') return null;
  if (base === 'main.py' || base === 'code.py') return 'main.py';
  return lang === 'micropython' ? 'lib/' + base : base;
}
/** Add files to the project's code. Asks once before replacing existing files. Returns what happened. */
export function importFiles(items: { name: string; content: string }[], source: string) {
  const e = A.project.electronics, plan: [string, string, string][] = [], skipped: string[] = [];
  for (const it of items) { const d = destFor(it.name); if (d) plan.push([it.name, d, it.content]); else skipped.push(it.name.split('/').pop()!); }
  const replacing = plan.filter(([, d, c]) => e.files[d] != null && e.files[d] !== c).map(([, d]) => d);
  if (replacing.length && !window.confirm(`Replace ${replacing.join(', ')} with the version${replacing.length > 1 ? 's' : ''} from ${source}?`)) return { added: [], skipped };
  for (const [, d, c] of plan) e.files[d] = c;
  if (plan.length) {
    e.filesEdited = true; e.activeFile = plan[0][1]; compiled = null;
    renderTabs(); A.changed('electronics'); codeChanged(); bridge.files();
    track('code', `Imported ${plan.length} file${plan.length > 1 ? 's' : ''} from ${source}: ${plan.map(p => p[1]).join(', ')}`);
  }
  const kinds = board().lang === 'arduino' ? '.ino, .h, .cpp and .hex' : '.py';
  toast(plan.length ? `Added ${plan.map(p => p[1]).join(', ')}${skipped.length ? ` (skipped ${skipped.length} non-${kinds} file${skipped.length > 1 ? 's' : ''})` : ''}` : `Nothing to add: this board uses ${kinds} files`);
  return { added: plan.map(p => p[1]), skipped };
}
/** Fetch dropped GitHub files (folders expand to their code files) and import them. */
export async function importFromGitHub(d: GhDrag) {
  const want = d.paths.slice(0, 60);
  toast(`Fetching ${want.length} file${want.length > 1 ? 's' : ''} from ${d.repo}…`);
  const got: { name: string; content: string }[] = [], failed: string[] = [];
  for (const p of want) { try { const f = await gh.file(d.repo, p, d.ref); got.push({ name: f.path, content: f.content }); } catch (err: any) { failed.push(`${p} (${err.message})`); } }
  if (failed.length) toast(`Couldn't fetch: ${failed.join('; ')}`);
  return importFiles(got, `${d.repo}@${d.ref}`);
}
function wireDrops() {
  const zone = $('#right');
  const ok = (e: DragEvent) => A.mode === 'elec' && !!e.dataTransfer && (e.dataTransfer.types.includes(GH_MIME) || e.dataTransfer.types.includes('Files'));
  zone.addEventListener('dragover', e => { if (!ok(e)) return; e.preventDefault(); e.stopPropagation(); zone.classList.add('dropping'); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove('dropping'); });
  zone.addEventListener('drop', async e => {
    if (!ok(e)) return;
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('dropping');
    const g = e.dataTransfer!.getData(GH_MIME);
    if (g) { await importFromGitHub(JSON.parse(g)); return; }
    const files = [...e.dataTransfer!.files].filter(f => CODE_EXT.test(f.name) && f.size < 1e6);
    if (!files.length) { toast('Drop .py, .ino, .h, .cpp or .hex files'); return; }
    importFiles(await Promise.all(files.map(async f => ({ name: f.name, content: await f.text() }))), 'your computer');
  });
}

// ------------------------------------------------------------------ fixes for the problems panel
/** Re-wire parts automatically: connect a loose pin, move off a clash / boot pin / USB pin, or onto an ADC, PWM or bus pin pair. */
export function fixWiring(kind: string, uid?: string, role?: string): string | null {
  const e = A.project.electronics, b = board(), comps = e.comps;
  const usedBy = (g: number, except?: CompInstance) => comps.some(c => c !== except && Object.values(c.pins).includes(g));
  const free = (pred: (g: number) => boolean, except?: CompInstance) => b.gpio.filter(g => pred(g) && !b.strap.includes(g) && !(b.family === 'avr' && g < 2) && !usedBy(g, except));
  const moved: string[] = [];
  const set = (c: CompInstance, r: string, g: number | undefined) => { if (g == null) return; c.pins[r] = g; moved.push(`${COMPONENTS[c.type].name.split(' (')[0]} ${r} → ${label(g)}`); };
  const targets = uid ? comps.filter(c => c.uid === uid) : comps;
  for (const c of targets) {
    const def = COMPONENTS[c.type]; if (!def) continue;
    for (const r of def.roles) {
      const g = c.pins[r.id];
      const isBus = r.kind === 'i2c-sda' || r.kind === 'i2c-scl';
      const clash = g != null && !isBus && comps.some(o => o !== c && Object.values(o.pins).includes(g));
      const bad = g == null || !b.gpio.includes(g) || b.strap.includes(g) || (b.family === 'avr' && g < 2) || clash;
      if (kind === 'connect' && (role ? r.id === role : g == null)) { if (g == null) set(c, r.id, (r.kind === 'analog' ? free(x => b.adc.includes(x), c) : free(x => !b.adc.includes(x) || !b.adc.length, c).concat(free(() => true, c)))[0]); }
      else if (kind === 'move' && bad && !isBus && (uid || clash)) { if (!uid && clash && comps.findIndex(o => Object.values(o.pins).includes(g!)) === comps.indexOf(c)) continue; set(c, r.id, (r.kind === 'analog' ? free(x => b.adc.includes(x), c) : free(x => !b.adc.includes(x), c).concat(free(() => true, c)))[0]); }
      else if (kind === 'move-adc' && r.kind === 'analog' && !(b.adc.includes(g!) && !b.adc2?.includes(g!))) set(c, r.id, free(x => b.adc.includes(x) && !b.adc2?.includes(x), c)[0]);
      else if (kind === 'move-pwm' && r.kind === 'pwm' && b.hwPwm && !b.hwPwm.includes(g!)) set(c, r.id, free(x => b.hwPwm!.includes(x), c)[0]);
    }
    if (kind === 'move-bus') {
      const spi = def.roles.some(r => r.kind === 'spi-sck');
      const groups = (spi ? b.spi : b.i2c) ?? [];
      const [ka, kb, ra, rb] = spi ? ['sck', 'mosi', 'SCK', 'MOSI'] as const : ['sda', 'scl', 'SDA', 'SCL'] as const;
      const ok = (g: number) => !usedBy(g, c) || (!spi && comps.some(o => o !== c && (o.pins.SDA === g || o.pins.SCL === g)));
      for (const gr of groups) { const a = (gr as any)[ka].find(ok), z = (gr as any)[kb].find((x: number) => ok(x) && x !== a); if (a != null && z != null) { set(c, ra, a); set(c, rb, z); break; } }
    }
  }
  if (!moved.length) return null;
  track('wiring', `Fixed the wiring: ${moved.join(', ')}`, true);
  wiringChanged();
  return moved.join(', ');
}
/** Jump to a line of code in the Electronics editor. */
export function showCode(file: string | undefined, line?: number) {
  const e = A.project.electronics;
  if (file && e.files[file] == null) file = Object.keys(e.files).find(n => n.endsWith('/' + file) || n === file) ?? e.activeFile;
  if (file) e.activeFile = file;
  A.setMode('elec'); renderTabs();
  const ta = $('#code') as HTMLTextAreaElement;
  if (line) {
    const lines = ta.value.split('\n'), start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    ta.focus(); ta.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    ta.scrollTop = Math.max(0, (line - 4) * 17.8);
  }
}
/** Highlight a part's card on the bench. */
export function flashCard(uid: string) {
  A.setMode('elec');
  requestAnimationFrame(() => { const c = document.querySelector<HTMLElement>(`.card[data-uid="${uid}"]`); if (!c) return; c.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1600); });
}

// ------------------------------------------------------------------ API for the device IDE window
export const device = {
  run: () => run(),
  stop: () => stop(),
  running: () => !!runtime?.running,
  status: () => lastStatus,
  async verify() { compiled = null; return !!(await compile()); },
  send(text: string) { if (!runtime?.running) { serial('Nothing is running. Run the code first.', 'w'); return; } runtime.sendSerial(text); },
  interrupt() { if (runtime?.interrupt) runtime.interrupt(); else runtime?.sendSerial('\x03'); },
  setFile(name: string, content: string) { const e = A.project.electronics; if (e.files[name] !== content) { codeChanged(); track('code', `Edited ${name}`); } e.files[name] = content; e.filesEdited = true; if (!e.activeFile) e.activeFile = name; if (A.mode === 'elec') renderTabs(); A.changed('electronics'); },
  deleteFile(name: string) { const e = A.project.electronics; if (Object.keys(e.files).length <= 1) return false; delete e.files[name]; if (e.activeFile === name) e.activeFile = Object.keys(e.files)[0]; if (A.mode === 'elec') renderTabs(); A.changed('electronics'); return true; },
  renameFile(from: string, to: string) { const e = A.project.electronics; if (!e.files[from] || e.files[to] != null) return false; e.files[to] = e.files[from]; delete e.files[from]; if (e.activeFile === from) e.activeFile = to; if (A.mode === 'elec') renderTabs(); A.changed('electronics'); return true; },
};

// ------------------------------------------------------------------ product input → hardware
export function elecDial(d: number) {
  if (target === 'physical') { dev?.forward('enc', d); return; }
  HW.encCount += d;
  const enc = A.bench.bound('encoder');
  if (enc && runtime?.running) enc.model.sim!.turn(d);
  else if (!runtime?.running) nudge();
}
export function elecPress(down: boolean) {
  if (target === 'physical') { dev?.forward('btn', down ? 1 : 0); return; }
  const b = A.bench.bound('button');
  if (b) b.model.sim!.press(down);
  if (!runtime?.running && down) nudge();
  const pb = document.querySelector('.card .pushbtn'); pb?.classList.toggle('dn', down);
}
let nudgeT = 0;
function nudge() { if (performance.now() - nudgeT > 2500) { nudgeT = performance.now(); toast('Press ▶ Run to start the firmware'); } }
const HW = { encCount: 0 };

// ------------------------------------------------------------------ editor + tabs
function gutter() { const n = ($('#code') as HTMLTextAreaElement).value.split('\n').length; $('#gutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); }
function renderTabs() {
  const t = $('#fileTabs'); t.innerHTML = '';
  const e = A.project.electronics;
  const names = Object.keys(e.files).sort((a, b) => (a.includes('/') ? 1 : 0) - (b.includes('/') ? 1 : 0) || a.localeCompare(b));
  if (!e.files[e.activeFile]) e.activeFile = names[0];
  for (const n of names) {
    const b = el('button', n === e.activeFile ? 'on' : ''); b.textContent = n;
    b.onclick = () => { e.activeFile = n; renderTabs(); };
    b.ondblclick = () => { if (Object.keys(e.files).length > 1 && confirmDelete(n)) { delete e.files[n]; renderTabs(); A.changed('electronics'); } };
    t.appendChild(b);
  }
  const add = el('button', 'add'); add.textContent = '+'; add.title = 'New file (or drop a .hex/.py/.ino)';
  add.onclick = () => newFile();
  t.appendChild(add);
  const ta = $('#code') as HTMLTextAreaElement;
  ta.value = e.files[e.activeFile] ?? ''; gutter();
  $('#langLbl')?.remove();
}
function confirmDelete(n: string) { return window.confirm?.(`Delete ${n}?`) ?? false; }
function newFile() {
  const inp = el('input'); inp.type = 'file'; inp.accept = '.py,.ino,.h,.cpp,.c,.hex,.txt';
  inp.onchange = async () => {
    const f = inp.files?.[0]; if (!f) return;
    const name = f.name.endsWith('.hex') ? 'firmware.hex' : f.name.endsWith('.py') && f.name !== 'main.py' ? 'lib/' + f.name : f.name;
    A.project.electronics.files[name] = await f.text();
    A.project.electronics.activeFile = name; A.project.electronics.filesEdited = true;
    renderTabs(); A.changed('electronics'); toast('Added ' + name);
  };
  inp.click();
}

// ------------------------------------------------------------------ bench
function liveHTML(c: CompInstance) {
  switch (kind(c)) {
    case 'generic': return `<div class="gen"><div class="big genv">idle</div><div class="genn">${esc(customOf(c.type)!.interface.toUpperCase())}${customOf(c.type)!.i2cAddress != null ? ' · 0x' + customOf(c.type)!.i2cAddress!.toString(16) : ''}</div></div>`;
    case 'led': return '<svg width="40" height="40"><circle cx="20" cy="20" r="11" fill="#401010" class="ledc"/></svg>';
    case 'button': return '<button class="pushbtn" title="Hold to press"></button>';
    case 'encoder': return '<button class="encbtn" data-d="-1">↺</button><svg width="50" height="50" style="margin:0 6px"><g class="knob"><circle cx="25" cy="25" r="20" fill="#3a3a3f" stroke="#555"/><rect x="23.5" y="8" width="3" height="10" rx="1.5" fill="#ff7a2f"/></g></svg><button class="encbtn" data-d="1">↻</button><span class="big encn" style="position:absolute;bottom:3px;right:6px;font-size:10px"></span>';
    case 'pot': return `<input type="range" min="0" max="1" step="0.001" value="0.5" class="potr"><span class="big potv" style="position:absolute;bottom:3px;font-size:10px"></span>`;
    case 'sht40': return '<div style="text-align:center"><div class="big shv"></div><input type="range" min="10" max="32" step="0.1" class="shr"></div>';
    case 'neopixel': { let s = '<svg width="58" height="58">'; for (let i = 0; i < 24; i++) { const a = -Math.PI / 2 + (i * Math.PI * 2) / 24; s += `<circle cx="${29 + Math.cos(a) * 23}" cy="${29 + Math.sin(a) * 23}" r="3.2" fill="#222" class="npd"/>`; } return s + '</svg>'; }
    case 'tft': return '<canvas width="56" height="56" class="tftm" style="border-radius:50%;background:#000"></canvas><span class="big tfts" style="position:absolute;bottom:3px;right:6px;font-size:9px"></span>';
    case 'buzzer': return `<div style="text-align:center"><div class="big bzv">silent</div><label style="font-size:10px"><input type="checkbox" class="bzm" ${audio.muted ? 'checked' : ''}> mute</label></div>`;
    case 'servo': return '<svg width="70" height="50"><rect x="20" y="22" width="30" height="22" rx="3" fill="#2b5cb0"/><g class="arm" transform="rotate(0 35 26)"><rect x="33" y="8" width="4" height="22" rx="2" fill="#eee"/></g><circle cx="35" cy="26" r="4" fill="#ddd"/></svg>';
    case 'relay': return '<div style="text-align:center"><div class="big rlv">OFF</div><div style="font-size:10px">heating call</div></div>';
    case 'haptic': return '<div class="big hpv">idle</div>';
  }
  return '';
}
function pinOpts(sel: number | null) {
  const b = board();
  return '<option value="">—</option>' + b.gpio.map(g => `<option value="${g}" ${g === sel ? 'selected' : ''}>${label(g)}${b.adc.includes(g) ? ' ADC' : ''}${b.strap.includes(g) ? ' ⚠' : ''}</option>`).join('');
}
function renderBench() {
  const box = $('#benchIn'), wires = $('#wires');
  box.innerHTML = ''; box.appendChild(wires);
  const b = board(), comps = A.project.electronics.comps, m = buildPinMap(comps);
  const used = [...m.keys()].sort((x, y) => x - y);
  const H = 274, W = 200, sp = Math.min(15, (H - 62) / Math.max(1, used.length));
  let s = `<svg width="${W}" height="${H}"><rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="10" fill="${b.pcb}" stroke="#ffffff22"/>`;
  s += `<rect x="24" y="${H / 2 - 34}" width="84" height="68" rx="4" fill="#111" stroke="#333"/><text x="66" y="${H / 2 - 4}" fill="#bbb" font-size="11" text-anchor="middle" font-weight="600">${b.chip}</text><text x="66" y="${H / 2 + 12}" fill="#777" font-size="9" text-anchor="middle">${b.lang === 'arduino' ? 'Arduino C++' : b.lang === 'python' ? 'Linux · Python 3' : 'MicroPython'}</text>`;
  s += `<text x="12" y="20" fill="#ddd" font-size="10.5" font-weight="600">${esc(b.name)}</text>`;
  ['3V3', b.logicV === 5 ? '5V' : '5V', 'GND'].forEach((r, i) => { s += `<rect x="${12 + i * 36}" y="${H - 24}" width="30" height="14" rx="3" fill="#00000055"/><text x="${27 + i * 36}" y="${H - 14}" fill="${r === 'GND' ? '#aaa' : '#ffb347'}" font-size="9" text-anchor="middle">${r}</text>`; });
  used.forEach((g, i) => { const y = 34 + i * sp, bad = m.get(g)!.length > 1 && !m.get(g)!.every(u => u.role === 'SDA' || u.role === 'SCL');
    s += `<text x="${W - 20}" y="${y + 3}" fill="${bad ? '#ff8080' : '#cfd6e0'}" font-size="9" text-anchor="end" font-family="JetBrains Mono">${label(g)}</text><rect x="${W - 16}" y="${y - 4}" width="10" height="8" rx="2" fill="#d4af37" data-pad="${g}"/>`; });
  box.appendChild(el('div', 'boardbox', s + '</svg>'));
  const firstOf = new Map<string, string>(); comps.forEach(c => { if (!firstOf.has(c.type)) firstOf.set(c.type, c.uid); });
  for (const c of comps) {
    const L = COMPONENTS[c.type]; if (!L) continue;
    const bound = L.binds && firstOf.get(c.type) === c.uid;
    const d = el('div', 'card' + (L.roles.length > 2 ? ' wide' : '')); d.style.setProperty('--c', c.color); d.dataset.uid = c.uid;
    d.innerHTML = `<div class="ch"><i class="pdot" title="Press Run to check this part"></i><b>${esc(L.name)}</b><button class="x" title="Remove">✕</button></div>${bound ? `<div class="bind">⇄ ${L.bindLabel}</div>` : `<div class="bind dim">${L.binds ? 'bench only (duplicate)' : 'bench only'}</div>`}<div class="live" title="${esc(L.note ?? '')}">${liveHTML(c)}</div><div class="pins">` +
      L.roles.map(r => `<div class="pr"><span class="chip" data-role="${r.id}">${r.id}</span><select data-role="${r.id}" class="${c.pins[r.id] != null && (m.get(c.pins[r.id] as number) ?? []).length > 1 && !['SDA', 'SCL'].includes(r.id) ? 'bad' : ''}">${pinOpts(c.pins[r.id])}</select></div>`).join('') + '</div>';
    d.querySelector<HTMLButtonElement>('.x')!.onclick = () => { comps.splice(comps.indexOf(c), 1); track('part', `Removed the ${L.name}`); wiringChanged(); };
    d.querySelectorAll<HTMLSelectElement>('select').forEach(sel => (sel.onchange = () => { c.pins[sel.dataset.role!] = sel.value === '' ? null : +sel.value; track('wiring', `Rewired the ${L.name} ${sel.dataset.role} to ${sel.value === '' ? 'nothing' : label(+sel.value)}`); wiringChanged(); }));
    const live = d.querySelector('.live')!;
    if (kind(c) === 'button') { const pb = live.querySelector<HTMLButtonElement>('.pushbtn')!; pb.onpointerdown = e => { e.preventDefault(); audio.unlock(); A.bench.model(c.uid)?.sim?.press(true); pb.classList.add('dn'); }; pb.onpointerup = pb.onpointerleave = () => { if (pb.classList.contains('dn')) { A.bench.model(c.uid)?.sim?.press(false); pb.classList.remove('dn'); } }; }
    if (c.type === 'encoder') live.querySelectorAll<HTMLButtonElement>('.encbtn').forEach(x => (x.onclick = () => { const dd = +x.dataset.d!; if (bound) A.product.rotateDial(dd * Math.PI / 10); if (bound) elecDial(dd); else A.bench.model(c.uid)?.sim?.turn(dd); }));
    if (kind(c) === 'pot') { const r = live.querySelector<HTMLInputElement>('.potr')!; r.oninput = () => A.bench.model(c.uid)?.sim?.set(+r.value); }
    if (c.type === 'sht40') { const r = live.querySelector<HTMLInputElement>('.shr')!; r.value = String(A.project.env.roomC); r.oninput = () => { A.project.env.roomC = +r.value; }; }
    if (c.type === 'buzzer') live.querySelector<HTMLInputElement>('.bzm')!.onchange = e => { audio.muted = (e.target as HTMLInputElement).checked; if (audio.muted) audio.silenceAll(); };
    box.appendChild(d);
  }
  requestAnimationFrame(drawWires);
}
export function drawWires() {
  const box = $('#benchIn'), w = $('#wires') as unknown as SVGSVGElement, br = box.getBoundingClientRect();
  w.setAttribute('width', String(box.scrollWidth)); w.setAttribute('height', String(box.clientHeight));
  let s = '';
  for (const c of A.project.electronics.comps) {
    const card = box.querySelector(`.card[data-uid="${c.uid}"]`); if (!card) continue;
    for (const [r, g] of Object.entries(c.pins)) {
      if (g == null) continue;
      const pad = box.querySelector(`[data-pad="${g}"]`), chip = card.querySelector(`.chip[data-role="${r}"]`); if (!pad || !chip) continue;
      const a = pad.getBoundingClientRect(), z = chip.getBoundingClientRect();
      const x1 = a.right - br.left, y1 = a.top + a.height / 2 - br.top, x2 = z.left - br.left, y2 = z.top + z.height / 2 - br.top, dx = Math.max(40, (x2 - x1) * 0.45);
      s += `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" fill="none" stroke="${c.color}" stroke-width="1.6" opacity=".85"/>`;
    }
  }
  w.innerHTML = s;
}
let liveAcc = 0;
/** Per-frame: device model visuals, closed-loop room temperature, emulator speed. */
export function elecFrame(dt: number) {
  A.bench.frame(dt);
  if (runtime?.running && target === 'virtual') {
    const env = A.project.env, heater = A.bench.bound('relay');
    if (heater?.model.state.on) env.roomC = Math.min(32, env.roomC + 0.12 * dt * (runtime.speed?.() ?? 1));
    else env.roomC = Math.max(10, env.roomC + (18 - env.roomC) * 0.008 * dt);
  }
  liveAcc += dt; if (liveAcc < 0.07) return; liveAcc = 0;
  if (A.mode !== 'elec') return;
  const emu = !!runtime?.running && (runtime.kind === 'rp2040-emu' || runtime.kind === 'avr-emu');
  A.viewport.throttle = emu;
  const sp = emu && runtime!.speed ? runtime!.speed() : null;
  $('#speed').textContent = sp != null ? (sp > 0.95 ? 'real time' : `${sp.toFixed(2)}× real time`) : '';
  for (const c of A.project.electronics.comps) {
    const d = document.querySelector(`.card[data-uid="${c.uid}"] .live`); if (!d) continue;
    const st = A.bench.model(c.uid)?.state ?? {};
    if (kind(c) === 'led') { const x = d.querySelector('.ledc') as SVGElement, l = st.brightness ?? 0; x.setAttribute('fill', l > 0 ? `rgba(255,${(60 + 80 * l) | 0},40,${0.35 + 0.65 * l})` : '#401010'); (x as any).style.filter = l > 0 ? `drop-shadow(0 0 ${6 * l}px #ff5a2a)` : 'none'; }
    if (c.type === 'encoder') { d.querySelector('.knob')!.setAttribute('transform', `rotate(${(st.count ?? 0) * 18} 25 25)`); d.querySelector('.encn')!.textContent = String(st.count ?? 0); }
    if (kind(c) === 'pot') d.querySelector('.potv')!.textContent = ((st.value ?? 0.5) * 3.3).toFixed(2) + ' V';
    if (c.type === 'sht40') { d.querySelector('.shv')!.textContent = `${A.project.env.roomC.toFixed(1)} °C · ${A.project.env.rh}%`; const r = d.querySelector('.shr') as HTMLInputElement; if (document.activeElement !== r) r.value = String(A.project.env.roomC); }
    if (c.type === 'neopixel') { const px = st.pixels as number[][] | null; d.querySelectorAll('.npd').forEach((x, i) => { const p = px?.[i]; x.setAttribute('fill', p && p[0] + p[1] + p[2] ? `rgb(${Math.min(255, p[0] * 1.4)},${Math.min(255, p[1] * 1.4)},${Math.min(255, p[2] * 1.4)})` : '#222'); }); }
    if (c.type === 'tft') { (d.querySelector('.tftm') as HTMLCanvasElement).getContext('2d')!.drawImage(A.product.screen, 0, 0, 56, 56); d.querySelector('.tfts')!.textContent = st.mode === 'spi' ? `${st.commands} cmds` : st.mode === 'sim' ? 'sim' : ''; }
    if (c.type === 'buzzer') d.querySelector('.bzv')!.textContent = st.playing ? st.freq + ' Hz' : 'silent';
    if (c.type === 'servo') d.querySelector('.arm')!.setAttribute('transform', `rotate(${(st.angle ?? 90) - 90} 35 26)`);
    if (c.type === 'relay') { const x = d.querySelector('.rlv') as HTMLElement; x.textContent = st.on ? 'ON' : 'OFF'; x.style.color = st.on ? 'var(--heat)' : ''; }
    if (kind(c) === 'generic') { const x = d.querySelector('.genv') as HTMLElement; x.textContent = st.rx || st.tx ? `${st.rx} in · ${st.tx} out${st.last ? ' · ' + st.last : ''}` : st.edges ? `${st.edges} edges` : 'idle'; }
    if (c.type === 'haptic') { const x = d.querySelector('.hpv') as HTMLElement; x.textContent = st.on ? 'buzzing' : 'idle'; x.style.color = st.on ? '#9db4ff' : ''; }
  }
}

function renderChecks() {
  const ch = runChecks(board(), A.project.electronics.comps).map(c => explainCheck(c.msg, c.level, c.uid)).filter(Boolean) as ReturnType<typeof explainCheck>[];
  const e = ch.filter(c => c!.level === 'broken').length, w = ch.filter(c => c!.level === 'warning').length;
  $('#chkBadge').innerHTML = e ? `<span class="badge bad">${e} broken</span>` : w ? `<span class="badge warn">${w} to check</span>` : '<span class="badge ok">OK</span>';
  $('#chkList').innerHTML = ch.length ? ch.map(c => `<div class="chk ${c!.level === 'broken' ? 'err' : c!.level === 'warning' ? 'warn' : 'tip'}" title="${esc(c!.why ?? '')}"><i></i><span>${esc(c!.title)}</span></div>`).join('') + '<a class="chkmore">Details and fixes →</a>' : '<div class="chk ok"><i></i><span>Wiring looks good.</span></div>';
  const more = document.querySelector<HTMLElement>('#chkList .chkmore'); if (more) more.onclick = () => openPanel();
  const rows: [string, number][] = [[board().name, board().cost], ...A.project.electronics.comps.map(c => [COMPONENTS[c.type].name, COMPONENTS[c.type].cost] as [string, number])];
  $('#ebom').innerHTML = rows.map(r => `<tr><td>${esc(r[0])}</td><td>$${r[1].toFixed(2)}</td></tr>`).join('') + `<tr class="tot"><td>Dev-kit total</td><td>$${rows.reduce((a, r) => a + r[1], 0).toFixed(2)}</td></tr>`;
}

function wiringChanged() {
  const e = A.project.electronics;
  if (runtime?.running) { stop(); serial('[sim] Wiring changed, so the firmware was stopped. Press Run again.', 'w'); }
  A.bench.load(board(), e.comps);
  if (!e.filesEdited) e.files = starterFiles(board(), e);
  else serial('[sim] Wiring changed. Check the pin numbers in your code (or Reset code).', 'w');
  renderElec(A); A.changed('electronics'); wiringEdited();
}

/** Apply a wiring change made outside the bench (Claude Code's wiring.json). */
export function applyWiring(boardId: string, comps: CompInstance[], log: [kind: 'part' | 'wiring' | 'board', text: string][]) {
  const e = A.project.electronics, prevLang = board().lang;
  if (runtime?.running) stop();
  const boardChanged = e.board !== boardId;
  e.board = boardId; e.comps = comps;
  if (boardChanged) { compiled = null; if (prevLang !== board().lang) e.filesEdited = false; ($('#board') as HTMLSelectElement).value = boardId; }
  for (const [k, t] of log) track(k, t);
  wiringChanged();
  if (boardChanged && !e.filesEdited) e.activeFile = Object.keys(e.files)[0];
}

/** Add a part to the bench with sensible free pins (shared I2C bus pins are reused). */
function addComponent(type: string) {
  const comps = A.project.electronics.comps, def = COMPONENTS[type];
  if (!def) return;
  const used = new Set(comps.flatMap(c => Object.values(c.pins).filter(v => v != null) as number[]));
  const b = board(); const pins: Record<string, number | null> = {};
  let pool = b.gpio.filter(g => !b.strap.includes(g) && !used.has(g));
  for (const r of def.roles) {
    let g: number | undefined;
    if (r.kind === 'analog') g = pool.find(p => b.adc.includes(p));
    else if (r.kind === 'i2c-sda' || r.kind === 'i2c-scl') {
      for (const c of comps) { const role = COMPONENTS[c.type]?.roles.find(x => x.kind === r.kind); if (role && c.pins[role.id] != null) { g = c.pins[role.id] as number; break; } }
    }
    if (g == null) g = pool.find(p => !b.adc.includes(p)) ?? pool[0];
    pins[r.id] = g ?? null; pool = pool.filter(p => p !== g);
  }
  comps.push({ uid: newUid(), type: def.id, pins, color: nextColor(comps.length) });
  track('part', `Added a ${def.name}`);
  wiringChanged(); toast(def.name + ' added');
}

// ------------------------------------------------------------------ public
export function initElec(app: App) {
  A = app;
  ensureRuntimes();
  $('#board').innerHTML = Object.values(BOARDS).map(b => `<option value="${b.id}">${esc(b.name)} · ${b.fidelity === 'emulated' ? 'emulated' : 'sim'}</option>`).join('');
  initParts(A, addComponent);
  renderLib();
  $('#board').onchange = e => {
    if (runtime?.running) stop();
    const el_ = A.project.electronics, prev = board();
    el_.board = (e.target as HTMLSelectElement).value; track('board', `Switched the board to the ${BOARDS[el_.board].name}`);
    const p = KIT_PRESETS[el_.board] ?? {}, seen = new Set<string>();
    for (const c of el_.comps) {
      const pre = p[c.type];
      if (pre && !seen.has(c.type)) COMPONENTS[c.type].roles.forEach((r, i) => (c.pins[r.id] = pre[i] ?? null));
      else for (const r of COMPONENTS[c.type].roles) if (c.pins[r.id] != null && !board().gpio.includes(c.pins[r.id]!)) c.pins[r.id] = null;
      seen.add(c.type);
    }
    if (prev.lang !== board().lang) el_.filesEdited = false;
    A.bench.load(board(), el_.comps);
    if (!el_.filesEdited) { el_.files = starterFiles(board(), el_); el_.activeFile = Object.keys(el_.files)[0]; }
    else serial('[sim] Board changed and pins were reassigned. Update your code or Reset code.', 'w');
    compiled = null; renderElec(A); A.changed('electronics');
  };
  $$('#target button').forEach(b => (b.onclick = async () => {
    target = b.dataset.t as any;
    $$('#target button').forEach(x => x.classList.toggle('on', x === b));
    if (runtime?.running) await stop();
    if (target === 'physical') {
      if (!SerialDeviceRuntime.supported()) serial('Web Serial is unavailable here. Use Chrome or Edge on the local dev server (npm run dev) to connect a real board.', 'w');
      else if (!dev.connected) { try { await dev.connect(); } catch (err: any) { serial(String(err.message || err), 'e'); } }
    }
    renderElec(A);
  }));
  const ta = $('#code') as HTMLTextAreaElement;
  ta.oninput = () => { const e = A.project.electronics; track('code', `Edited ${e.activeFile}`); e.files[e.activeFile] = ta.value; e.filesEdited = true; gutter(); A.changed('electronics'); bridge.files(); codeChanged(); };
  ta.onscroll = () => { $('#gutter').scrollTop = ta.scrollTop; };
  ta.onkeydown = e => {
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runtime?.running ? stop() : run(); }
  };
  $('#bRun').onclick = () => (runtime?.running ? stop() : run());
  $('#bCompile').onclick = async () => { compiled = null; await compile(); };
  $('#bTpl').onclick = () => { const e = A.project.electronics; e.files = starterFiles(board(), e); e.filesEdited = false; e.activeFile = Object.keys(e.files)[0]; renderTabs(); A.changed('electronics'); toast(e.starter === 'blank' ? 'Code reset to the empty starter' : 'Code reset to the template for the current wiring'); };
  $('#bClr').onclick = () => { $('#serial').innerHTML = ''; partial = ''; };
  const si = $('#serialInput') as HTMLInputElement;
  si.onkeydown = e => {
    if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); runtime?.sendSerial('\x03'); return; }
    if (e.key === 'Enter') { runtime?.sendSerial(si.value + (board().lang === 'arduino' ? '\n' : '\r')); serial('» ' + si.value, 's'); si.value = ''; }
  };
  window.addEventListener('resize', () => { if (A.mode === 'elec') drawWires(); });
  wireDrops();
}

export function renderElec(app: App) {
  A = app;
  renderLib();
  const b = board();
  ($('#board') as HTMLSelectElement).value = b.id;
  const fid = target === 'physical' ? 'physical' : b.fidelity;
  $('#fidelity').innerHTML = `<span class="fidelity ${fid}">${fid === 'physical' ? 'real hardware' : fid === 'emulated' ? 'cycle-level emulation' : 'behavioral sim'}</span>`;
  $('#boardNote').textContent = (target === 'physical' ? 'Runs on your board over USB (Web Serial). Prints "@ff" lines to mirror the 3D model; see lib/ff.py. ' : '') + (b.notes ?? '') + ` ${b.gpio.length} GPIO · ${b.adc.length ? 'ADC ' + b.adc.map(label).join(', ') : 'no ADC'} · $${b.cost}`;
  renderBench(); renderChecks(); renderTabs(); setRunUI();
  const ide = ideName(b.lang); $('#bIde').textContent = ide + ' ↗'; $('#bIde').title = `Code this board the way you would on the real thing: opens ${ide} in its own window`;
}
export const ideName = (lang: string) => (lang === 'python' ? 'Pi Desktop' : lang === 'arduino' ? 'Arduino IDE' : 'Thonny');
