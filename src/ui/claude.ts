import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { App } from './app';
import { $, esc, toast } from './dom';
import { device, applyWiring } from './elec';
import { WIRING_FILE, PARTS_FILE, wiringDoc, catalogDoc, parseWiring, needsApproval, describeChange, type WiringChange } from '../app/wiringdoc';
import { track } from './track';
import { COMPONENTS } from '../hw/library/components';
import { BOARDS, pinLabel } from '../hw/library/boards';

/**
 * Claude Code, in a terminal inside Electronics. The server runs the real
 * `claude` CLI in a folder that mirrors this project's code; edits Claude makes
 * show up in the editor straight away, and your edits reach Claude's folder.
 */
let A: App;
let term: Terminal | null = null, fit: FitAddon | null = null, ws: WebSocket | null = null;
let forProject: string | null = null, running = false;
const sent = new Map<string, string>(); // what the workspace folder has, as far as we know
const CODE = /\.(py|ino|h|hpp|c|cpp)$/i;

const shown = () => document.body.classList.contains('claude-on');
function status(s: string, cls = '') { const e = $('#clStatus'); e.textContent = s; e.className = 'clstatus ' + cls; }

/** CLAUDE.md for the workspace: what the board is, how it's wired, and the house rules. */
/** The robot's joints and what drives them (empty for non-robots). */
function robotDoc(): string {
  const m = A.project.product.built; if (!m) return '';
  const js = m.parts.filter(p => p.joint && p.joint.type !== 'fixed'); if (!js.length) return '';
  const comps = A.project.electronics.comps;
  const drv = (p: typeof js[number]) => { const d = p.joint!.drive; if (!d) return 'nothing yet (moved by the teach slider)'; const c = comps.find(x => x.uid === d.comp); if (!c) return 'a missing part'; const n = COMPONENTS[c.type]?.name ?? c.type; return `${n}${c.type === 'pca9685' ? ` (0x${(c.props?.address ?? 0x40).toString(16)}) channel ${d.channel ?? 0}` : c.type === 'tb6612' || c.type === 'l298n' ? ` motor ${d.channel ? 'B' : 'A'}` : ''}${d.invert ? ', reversed' : ''}`; };
  const axis = (a: number[]) => ['X (left)', 'Y (up)', 'Z (forward)'][a.map(Math.abs).indexOf(Math.max(...a.map(Math.abs)))] + (Math.min(...a) < 0 ? ' reversed' : '');
  const r = m.robot;
  return `## Robot (${r?.kind ?? 'custom'}, ${r?.mobile === 'legs' ? 'walks on legs' : r?.mobile === 'wheels' ? 'drives on wheels' : 'bolted down'}, ${r?.mass ?? '?'} g)
The 3D model moves with the firmware: servo angle 90° = the joint's rest pose shown in the model (angle − 90 = joint degrees; "reversed" flips it).
${js.map(p => `- **${p.name}**: ${p.joint!.type === 'wheel' ? 'wheel' : p.joint!.type === 'prismatic' ? `slides ${p.joint!.min ?? 0}–${p.joint!.max ?? 10} mm` : `rotates ${p.joint!.min ?? -180}° to ${p.joint!.max ?? 180}°`} about ${axis(p.joint!.axis)}; driven by ${drv(p)}`).join('\n')}
${r?.world ? `World: ${r.world.size / 1000} m floor${r.world.obstacles.length ? `, ${r.world.obstacles.length} obstacles (the ultrasonic/IR sensors see them)` : ''}${r.world.track ? ', a dark line track (line sensors read HIGH over it)' : ''}.` : ''}
Libraries in lib/: pca9685.py (Servos.angle(ch, deg)), arm.py (Arm.move_to(x, y, z) inverse kinematics), legs.py (leg IK + gaits), rover.py (Rover.drive(left, right)).

`;
}

export function contextDoc(): string {
  const e = A.project.electronics, b = A.board();
  const label = (g: number | null) => g == null ? 'not connected' : (b.label?.(g) ?? `${b.pfx}${g}`);
  const lang = b.lang === 'arduino' ? 'Arduino C++ (one .ino sketch, plus optional .h/.cpp beside it)'
    : b.lang === 'micropython' ? 'MicroPython. `main.py` runs at boot; put helper modules in `lib/` and `import` them by name.'
    : 'Python 3 on Raspberry Pi OS (gpiozero / RPi.GPIO style)';
  const parts = e.comps.map(c => {
    const d = COMPONENTS[c.type];
    const pins = Object.entries(c.pins).map(([r, g]) => `${r}→${label(g)}`).join(', ');
    return `- **${d?.name ?? c.type}** (\`${c.uid}\`): ${pins || 'no signal pins'}${d?.i2cAddress ? `, I2C address 0x${d.i2cAddress.toString(16)}` : ''}${c.props?.i2c ? `, I2C address ${c.props.i2c}` : ''}`;
  });
  return `# ${A.project.name || 'Formframe project'}: firmware

This folder is the code for a hardware prototype in **Formframe**. It is kept in sync with the studio:
files you change here appear in the studio's code editor right away (and the other way round).

## Board
${b.name} (${b.chip}). Language: ${lang}
${b.notes}

## Wiring (from the studio's bench)
${parts.join('\n') || '- Nothing is wired yet.'}

${robotDoc()}You can change the wiring by editing \`${WIRING_FILE}\` (the catalog of parts and pins is in \`${PARTS_FILE}\`):
- **Moving pins** of parts already on the bench is applied right away.
- **Adding or removing hardware, or changing the board: ask the user in this chat first and wait for a yes.** Then edit \`${WIRING_FILE}\`; Formframe also shows them an Approve / Decline card and applies nothing until they approve.
- After each edit Formframe rewrites \`${WIRING_FILE}\` with what is actually wired and a \`_status\` line saying what happened (applied, waiting for approval, declined, or why it was rejected). Re-read it before relying on the change, and update the code to match the pins.

## Rules
- Only code files (${b.lang === 'arduino' ? '.ino .h .cpp .c' : '.py'}) sync back to the studio. Keep everything in this folder.
- Use the pins above. Don't assume hardware that isn't on the bench.
- The user runs the code from the studio (Run / Test it); you can't run it from here.${b.lang === 'micropython' ? ' Stick to MicroPython APIs (machine, time, neopixel, framebuf …), not CPython-only modules.' : ''}
- Keep explanations short and beginner-friendly.

(This file is regenerated by Formframe each session.)
`;
}
const codeFiles = () => Object.fromEntries(Object.entries(A.project.electronics.files).filter(([n]) => CODE.test(n)));
const docs = () => ({ 'CLAUDE.md': contextDoc(), [PARTS_FILE]: catalogDoc(A.board()) });

// ---- wiring.json: Claude's edits, the user's approval, and the status we write back
let wiringStatus = '', statusFor = ''; // status line, and the wiring it describes (cleared once the wiring moves on)
let pending: { text: string; change: WiringChange } | null = null;
const plainWiring = () => wiringDoc(A.board(), A.project.electronics.comps);
function currentWiring() {
  const plain = plainWiring();
  if (wiringStatus && plain !== statusFor) wiringStatus = ''; // changed since (e.g. by you on the bench)
  return wiringStatus ? wiringDoc(A.board(), A.project.electronics.comps, wiringStatus) : plain;
}
/** Everything mirrored into Claude's folder. */
const syncFiles = (): Record<string, string> => ({ ...codeFiles(), [WIRING_FILE]: currentWiring() });
function reportWiring(status: string) {
  wiringStatus = status; statusFor = plainWiring();
  const doc = currentWiring(); sent.set(WIRING_FILE, doc); sendWs({ t: 'file', name: WIRING_FILE, content: doc });
}
function apply(c: WiringChange, approved: boolean) {
  const log: [kind: 'part' | 'wiring' | 'board', text: string][] = [];
  const by = approved ? ' (you approved)' : '';
  if (c.boardChanged) log.push(['board', `Claude switched the board to the ${BOARDS[c.board].name}${by}`]);
  for (const a of c.added) log.push(['part', `Claude added a ${COMPONENTS[a.type].name}${by}`]);
  for (const r of c.removed) log.push(['part', `Claude removed the ${COMPONENTS[r.type]?.name ?? r.type}${by}`]);
  if (c.rewired.length) log.push(['wiring', `Claude rewired: ${c.rewired.map(r => `${r.name} ${r.role} → ${r.to}`).join(', ')}`]);
  applyWiring(c.board, c.comps, log);
}
function onWiringEdit(text: string) {
  let c: WiringChange;
  try { c = parseWiring(text, A.project.electronics); }
  catch (e: any) { notice(`Claude's wiring edit wasn't applied: ${e.message}`, 'bad'); reportWiring(`Not applied: ${e.message} Fix the file and save again.`); return; }
  if (needsApproval(c)) { pending = { text, change: c }; renderAsk(); return; }
  const what = describeChange(c);
  const propsChanged = JSON.stringify(c.comps.map(x => x.props ?? null)) !== JSON.stringify(A.project.electronics.comps.map(x => x.props ?? null));
  if (what || propsChanged) { apply(c, false); notice(`Claude ${what ? what.replace(/^move/, 'moved') : 'updated part settings'}.`); }
  reportWiring(what || propsChanged ? `Applied: ${what || 'part settings updated'}.` : 'No change.');
}
function resolve(ok: boolean) {
  const p = pending; pending = null; renderAsk();
  if (!p) return;
  if (!ok) { track('part', `You declined Claude's hardware change: ${describeChange(p.change)}`); reportWiring(`The user declined: ${describeChange(p.change)}. Nothing changed. Ask them before proposing hardware again.`); return; }
  let c: WiringChange;
  try { c = parseWiring(p.text, A.project.electronics); } // the bench may have moved on while waiting
  catch (e: any) { notice(`Couldn't apply: ${e.message}`, 'bad'); reportWiring(`Not applied: ${e.message}`); return; }
  apply(c, true);
  reportWiring(`Approved by the user and applied: ${describeChange(c)}. Update the code to use these pins.`);
  toast('Hardware change applied');
}
function renderAsk() {
  const box = $('#clAsk');
  if (!pending) { box.innerHTML = ''; box.classList.remove('on'); return; }
  const c = pending.change;
  const items = [
    ...(c.boardChanged ? [`Switch the board to the <b>${esc(BOARDS[c.board].name)}</b>`] : []),
    ...c.added.map(a => `Add <b>${esc(COMPONENTS[a.type].name)}</b> <span>${esc(Object.entries(a.pins).map(([r, g]) => `${r} ${g == null ? '—' : pinLabel(BOARDS[c.board], g)}`).join(' · '))}</span>`),
    ...c.removed.map(r => `Remove <b>${esc(COMPONENTS[r.type]?.name ?? r.type)}</b>`),
    ...(c.rewired.length ? [`Move ${esc(c.rewired.map(r => `${r.name} ${r.role} → ${r.to}`).join(', '))}`] : []),
  ];
  box.innerHTML = `<div class="clask-h">✻ Claude wants to change the hardware</div><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>
    <div class="clask-b"><button class="btn primary" id="clYes">Approve</button><button class="btn" id="clNo">Decline</button></div>`;
  box.classList.add('on');
  $('#clYes').onclick = () => resolve(true); $('#clNo').onclick = () => resolve(false);
}
function notice(msg: string, cls = '') { const n = $('#clNotice'); n.textContent = msg; n.className = 'clnotice on ' + cls; clearTimeout((notice as any).t); (notice as any).t = setTimeout(() => n.classList.remove('on'), 7000); }
const sendWs = (o: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

function connect() {
  if (!A.projectId) return;
  disconnect();
  forProject = A.projectId;
  const url = new URL(A.base + 'api/claude/term', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('project', A.projectId);
  status('Connecting…');
  const s = ws = new WebSocket(url);
  s.onopen = () => {
    const files = syncFiles(); sent.clear(); for (const [n, c] of Object.entries(files)) sent.set(n, c);
    sendWs({ t: 'sync', files, docs: lastDocs = docs() });
    fitNow(); sendWs({ t: 'start', cols: term!.cols, rows: term!.rows });
  };
  s.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === 'out') term!.write(m.d);
    else if (m.t === 'started') { running = true; status('Claude Code is running', 'ok'); $('#clDir').textContent = m.dir.replace(/^\/Users\/[^/]+/, '~'); $('#clDir').title = m.dir; term!.focus(); }
    else if (m.t === 'exit') { running = false; status('Claude Code stopped. Press Restart.', ''); term!.write('\r\n\x1b[2m[Claude Code exited]\x1b[0m\r\n'); }
    else if (m.t === 'error') { status(m.msg, 'bad'); term!.write(`\r\n\x1b[31m${m.msg}\x1b[0m\r\n`); }
    else if (m.t === 'file' && m.name === WIRING_FILE) { sent.set(m.name, m.content); onWiringEdit(m.content); }
    else if (m.t === 'file') {
      sent.set(m.name, m.content);
      const before = A.project.electronics.files[m.name];
      if (before !== m.content) { device.setFile(m.name, m.content); flashTab(m.name); track('code', `Claude ${before == null ? 'created' : 'edited'} ${m.name}`); }
    } else if (m.t === 'delete' && m.name === WIRING_FILE) { sent.delete(m.name); reportWiring('wiring.json was deleted, so Formframe put it back. Edit it instead of deleting it.'); }
    else if (m.t === 'delete') {
      sent.delete(m.name);
      if (A.project.electronics.files[m.name] != null && device.deleteFile(m.name)) track('code', `Claude deleted ${m.name}`);
    }
  };
  s.onclose = () => { if (ws === s) { ws = null; running = false; status('Disconnected. Press Restart to reconnect.'); } };
}
function disconnect() { const s = ws; ws = null; running = false; s?.close(); pending = null; wiringStatus = ''; if (A) renderAsk(); }
function flashTab(name: string) {
  for (const b of document.querySelectorAll<HTMLElement>('#fileTabs button')) if (b.textContent === name) { b.classList.remove('clflash'); void b.offsetWidth; b.classList.add('clflash'); }
}

/** The project's files changed (any source): push differences to Claude's folder. */
export function claudeFilesChanged() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (A.projectId !== forProject) { disconnect(); status('Switched project. Press Start.'); return; }
  const files = syncFiles();
  if (pending) delete files[WIRING_FILE]; // leave Claude's proposal in place until you decide
  for (const [n, c] of Object.entries(files)) if (sent.get(n) !== c) { sent.set(n, c); sendWs({ t: 'file', name: n, content: c }); }
  for (const n of [...sent.keys()]) if (!(n in files) && n !== WIRING_FILE) { sent.delete(n); sendWs({ t: 'delete', name: n }); }
}
/** Wiring or board changed: refresh CLAUDE.md and PARTS.md so Claude knows. */
let lastDocs: Record<string, string> = {};
export function claudeContextChanged() {
  if (!ws) return;
  const d = docs(), changed = Object.fromEntries(Object.entries(d).filter(([n, c]) => lastDocs[n] !== c));
  if (Object.keys(changed).length) { lastDocs = d; sendWs({ t: 'docs', docs: changed }); }
}

function fitNow() { try { fit?.fit(); } catch { } if (running) sendWs({ t: 'resize', cols: term!.cols, rows: term!.rows }); }
function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontFamily: "'JetBrains Mono', Menlo, monospace", fontSize: 11.5, lineHeight: 1.15, cursorBlink: true, allowProposedApi: false, scrollback: 5000,
    theme: { background: '#0b0c0e', foreground: '#dcdfe6', cursor: '#d97757', selectionBackground: '#76b90055', black: '#1e1e1f', brightBlack: '#6c6c73' },
  });
  fit = new FitAddon(); term.loadAddon(fit);
  term.open($('#claudeTerm'));
  term.onData(d => sendWs({ t: 'in', d }));
  // keep studio shortcuts (space = press, arrows = dial …) from firing while typing to Claude
  $('#claudeTerm').addEventListener('keydown', e => e.stopPropagation());
  new ResizeObserver(() => { clearTimeout((fitNow as any).t); (fitNow as any).t = setTimeout(fitNow, 60); }).observe($('#claudeTerm'));
}

export function showClaude(on: boolean) {
  document.body.classList.toggle('claude-on', on);
  $('#tabSerial').classList.toggle('on', !on); $('#tabClaude').classList.toggle('on', on);
  if (!on) return;
  ensureTerm();
  requestAnimationFrame(() => { fitNow(); if (!ws || A.projectId !== forProject) connect(); else term!.focus(); });
}

export function initClaude(app: App) {
  A = app;
  $('#tabSerial').onclick = () => showClaude(false);
  $('#tabClaude').onclick = () => showClaude(true);
  $('#clRestart').onclick = () => {
    if (ws?.readyState === WebSocket.OPEN && A.projectId === forProject) { term!.clear(); const files = syncFiles(); for (const [n, c] of Object.entries(files)) sent.set(n, c); sendWs({ t: 'sync', files, docs: lastDocs = docs() }); sendWs({ t: 'restart', cols: term!.cols, rows: term!.rows }); }
    else { term?.clear(); connect(); }
  };
  $('#clWide').onclick = () => { document.body.classList.toggle('claude-wide'); $('#clWide').textContent = document.body.classList.contains('claude-wide') ? '⇥ Narrow' : '⇤ Wide'; setTimeout(fitNow, 50); };
  $('#clDir').onclick = () => { navigator.clipboard?.writeText($('#clDir').title).then(() => toast('Folder path copied'), () => { }); };
}
/** Leaving the project (home screen, another project): end the session. */
export function closeClaude() { disconnect(); term?.clear(); showClaude(false); forProject = null; }
