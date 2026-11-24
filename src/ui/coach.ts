/**
 * The coach: a small card in the 3D view that always says what to do next,
 * in plain words, with a "Show me" that switches to the right tab and
 * highlights the control. Steps tick themselves off from what you actually do
 * (running code, moving a joint, adding parts …), so it never nags about
 * things you've done. Also owns the Simple / Advanced switch.
 */
import type { App, Mode } from './app';
import { $, el, esc } from './dom';
import { firmwareRunning } from './elec';
import { robotSim } from './robot';
import { isRobot } from '../app/robot';

interface Step { id: string; text: string; why: string; mode?: Mode; target?: string; done: (s: Seen) => boolean }
interface Seen { ran: boolean; ranFor: number; orbited: boolean; jogged: boolean; edited: boolean; photo: boolean; parts: number; built: boolean; checked: boolean; selected: boolean }

let A: App;
const seen: Seen = { ran: false, ranFor: 0, orbited: false, jogged: false, edited: false, photo: false, parts: 0, built: false, checked: false, selected: false };
let minimized = false, hidden = false, lastKey = '';

const ROBOT_STEPS: Step[] = [
  { id: 'run', text: 'Press <b>▶ Run</b> at the top to start your robot’s code.', why: 'The code runs on a virtual board, and the 3D robot moves exactly as the real one would.', target: '#bRunTop', done: s => s.ran },
  { id: 'watch', text: 'Watch it move. <b>Drag</b> to look around, <b>scroll</b> to zoom.', why: 'Joints, wheels and sensors are simulated with real physics.', target: '#viewport', done: s => s.orbited || s.ranFor > 12 },
  { id: 'teach', text: 'Press <b>■ Stop</b>, then drag a joint slider in the <b>Robot</b> panel.', why: 'That’s teach mode: pose the robot by hand, then Record pose to save it.', target: '#robotPanel', done: s => s.jogged },
  { id: 'code', text: 'Open <b>Electronics</b> and change a number in <b>main.py</b>, then Run again.', why: 'Try a bigger stride or a faster speed and see what happens.', mode: 'elec', target: '#code', done: s => s.edited },
  { id: 'photo', text: 'Take a picture: press <b>📷 Photo</b> in the corner of the view.', why: 'It renders a photo-realistic image you can save and share.', target: '#vpPhoto', done: s => s.photo },
];
const PRODUCT_STEPS: Step[] = [
  { id: 'parts', text: 'Open <b>Electronics</b> and click a part in <b>Add component</b> (try a button and an LED).', why: 'Parts get wired to free pins automatically, and example code appears.', mode: 'elec', target: '#libList', done: s => s.parts > 0 },
  { id: 'run', text: 'Press <b>▶ Run</b> at the top, then click the parts on the bench.', why: 'Your code runs on a virtual board and the parts react like real ones.', target: '#bRunTop', done: s => s.ran },
  { id: 'build', text: 'Make it a product: in <b>Design</b>, press <b>Auto build</b>.', why: 'Formframe designs an enclosure around your board and parts.', mode: 'design', target: '#secAuto', done: s => s.built },
  { id: 'select', text: 'Click a part of the model to change its size or colour.', why: 'Everything is editable; drag the arrows to move it.', mode: 'design', target: '#viewport', done: s => s.selected },
  { id: 'check', text: 'Click the <b>health badge</b> at the top to see what to fix next.', why: 'It checks wiring, power and fit, and explains each problem.', target: '#bHealth', done: s => s.checked },
  { id: 'photo', text: 'Take a picture: press <b>📷 Photo</b>.', why: 'A photo-realistic render of your product.', target: '#vpPhoto', done: s => s.photo },
];

export function initCoach(app: App) {
  A = app;
  // Simple / Advanced
  const adv = (() => { try { return localStorage.getItem('ff.advanced') === '1'; } catch { return false; } })();
  document.body.classList.toggle('simple', !adv);
  const box = $('#bAdvanced') as HTMLInputElement; box.checked = adv;
  box.onchange = () => { document.body.classList.toggle('simple', !box.checked); try { localStorage.setItem('ff.advanced', box.checked ? '1' : '0'); } catch { /* private mode */ } };
  try { hidden = localStorage.getItem('ff.coach') === 'off'; } catch { /* */ }

  const card = el('div'); card.id = 'coach'; $('#viewport').appendChild(card);
  // what the user does
  A.viewport.controls.addEventListener('start', () => { seen.orbited = true; });
  $('#vpPhoto').addEventListener('click', () => { seen.photo = true; });
  $('#bHealth').addEventListener('click', () => { seen.checked = true; });
  document.addEventListener('input', e => { if ((e.target as HTMLElement).closest?.('#robotPanel .rpr')) seen.jogged = true; if ((e.target as HTMLElement).id === 'code') seen.edited = true; }, true);
  setInterval(tick, 1000);
}

/** Forget progress for a new project (opened projects start where their state says). */
export function coachProject() { Object.assign(seen, { ran: false, ranFor: 0, orbited: false, jogged: false, edited: false, photo: false, checked: false, selected: false }); lastKey = ''; tick(); }

function tick() {
  const card = document.getElementById('coach'); if (!card || !A.projectId) { if (card) card.style.display = 'none'; return; }
  const robot = isRobot(A.project.product.built ?? null) && !!robotSim();
  const steps = robot ? ROBOT_STEPS : PRODUCT_STEPS;
  if (firmwareRunning()) { seen.ran = true; seen.ranFor++; }
  seen.parts = A.project.electronics.comps.length;
  seen.built = A.project.product.source === 'built';
  seen.selected ||= !!A.selected;
  seen.edited ||= A.project.electronics.filesEdited;
  const i = steps.findIndex(s => !s.done(seen));
  if (hidden || A.mode === 'github' || A.mode === 'plan' || document.body.classList.contains('present')) { card.style.display = 'none'; return; }
  card.style.display = '';
  const key = `${robot}|${i}|${minimized}`;
  if (key === lastKey) return;
  lastKey = key;
  card.classList.toggle('min', minimized);
  const dots = steps.map((_, k) => `<i class="${k < i || i < 0 ? 'done' : k === i ? 'cur' : ''}"></i>`).join('');
  if (i < 0) {
    card.innerHTML = `<div class="ch"><b>🎉 You’ve got the basics</b><button class="x" id="coachX" title="Hide the coach">✕</button></div><div class="cbody"><div class="dots">${dots}</div><div class="why">Try another robot from the home screen, or switch on <b>Advanced</b> at the top for every setting.</div></div>`;
  } else {
    const s = steps[i];
    card.innerHTML = `<div class="ch"><b>Next step ${i + 1} of ${steps.length}</b><button class="x" id="coachMin" title="${minimized ? 'Expand' : 'Collapse'}">${minimized ? '▴' : '▾'}</button><button class="x" id="coachX" title="Hide the coach">✕</button></div>
      <div class="cbody"><div class="dots">${dots}</div><div class="step">${s.text}</div><div class="why">${esc(s.why)}</div>
      <div class="cbtns"><button class="btn primary" id="coachShow">Show me</button><button class="btn" id="coachSkip">Skip</button></div></div>`;
    $('#coachShow').onclick = () => show(s);
    $('#coachSkip').onclick = () => { const k = steps.indexOf(s); (seen as any)[['ran', 'orbited', 'jogged', 'edited', 'photo'][k] ?? 'checked'] = true; force(s); };
    $('#coachMin').onclick = () => { minimized = !minimized; tick(); };
  }
  $('#coachX').onclick = () => { hidden = true; try { localStorage.setItem('ff.coach', 'off'); } catch { /* */ } card.style.display = 'none'; };
}
/** Skip: mark this step as done whatever its check is. */
function force(s: Step) { s.done = () => true; lastKey = ''; tick(); }

function show(s: Step) {
  if (s.mode && A.mode !== s.mode) A.setMode(s.mode);
  setTimeout(() => {
    const t = s.target ? document.querySelector<HTMLElement>(s.target) : null;
    if (!t) return;
    t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    t.classList.remove('coach-pulse'); void t.offsetWidth; t.classList.add('coach-pulse');
    setTimeout(() => t.classList.remove('coach-pulse'), 4200);
  }, 120);
}

/** Re-open the coach (from the menu). */
export function showCoach() { hidden = false; try { localStorage.removeItem('ff.coach'); } catch { /* */ } lastKey = ''; tick(); }
