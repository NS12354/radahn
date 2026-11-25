import { $, el } from './dom';
import type { Mode } from './app';

/**
 * Guided walkthrough: a spotlight over one UI region at a time plus a card
 * that explains it. Steps can switch the editor mode first. Targets that are
 * hidden or missing fall back to a centred card, so the tour never dead-ends.
 */
interface Step { sel?: string; mode?: Mode; title: string; body: string }

const STEPS: Step[] = [
  { title: 'Welcome to Formframe', body: 'This is a quick tour of the studio. Formframe puts a product’s form, its on-device UI, its interaction logic and its real firmware in one canvas. Use <kbd>→</kbd> / <kbd>←</kbd> to move, <kbd>Esc</kbd> to leave.' },
  { sel: '#modes', mode: 'design', title: 'The main modes', body: '<b>Design</b> the form, <b>Prototype</b> the interactions, wire and program the <b>Electronics</b>, then <b>Review</b> with comments. They all work on the same project.' },
  { sel: '#viewport', mode: 'design', title: 'The product', body: 'Drag to orbit and scroll to zoom. In Design mode you can click a part to select it. <b>Exploded view</b> at the top right pulls the housing apart.' },
  { sel: '#left', mode: 'design', title: 'Parts and CAD', body: 'Here are the parts of the built-in thermostat model. To use your own model, drop in a <b>GLB, STL or STEP</b> file and bind its meshes to roles (Dial, Screen, Press, LED), and the rest of the app will drive them.' },
  { sel: '#right', mode: 'design', title: 'Inspector, fit and cost', body: 'Change a part’s color and finish, resize the enclosure, and watch the <b>fit check</b> and <b>cost estimate</b> update as internal components go in and out.' },
  { sel: '#right', mode: 'proto', title: 'Interactions', body: 'Each row is a transition: <i>in this state, on this trigger, go to that state</i>, with optional LED, haptic and click feedback. Try it: drag the dial in the viewport, or click the display.' },
  { sel: '#bottom', mode: 'proto', title: 'State machine and log', body: 'The graph draws your interaction table. The event log shows each event; <span style="color:var(--warn)">amber</span> lines are events your spec doesn’t handle yet.' },
  { sel: '#right .me .sec', mode: 'elec', title: 'Pick a board', body: 'Some boards run your code exactly as the real chip would; others use a close simulation. Switch to <b>Physical board</b> to run on a real board plugged in by USB.' },
  { sel: '#left', mode: 'elec', title: 'Add parts and wire them', body: 'Add components from the library and pins are assigned for you. You can reassign them on the bench below. <b>Electrical checks</b> catch pin conflicts, overcurrent and missing pull-ups as you go.' },
  { sel: '#right .me', mode: 'elec', title: 'Code and Run', body: 'Edit the firmware, then press <b>Run</b>. Turning the dial and pressing the display on the 3D model drives the running code, and output shows in the serial monitor.' },
  { sel: '#viewport', mode: 'review', title: 'Review', body: 'Click anywhere on the model to pin a comment there. Comments are saved with the project.' },
  { sel: '#bMenu', mode: 'design', title: 'Save and share', body: 'Your work saves automatically (to your account when you’re signed in). Use this menu to download a copy, import a 3D model, or export the device code.' },
  { sel: '.logo', mode: 'design', title: 'Your projects', body: 'Click the logo to get back to the home screen and all your projects.' },
];

let i = -1;
let setMode: (m: Mode) => void = () => {};
let onEnd: (() => void) | null = null;
const SEEN = 'formframe.tour.seen';

export function tourSeen() { try { return !!localStorage.getItem(SEEN); } catch { return true; } }
function markSeen() { try { localStorage.setItem(SEEN, '1'); } catch { } }

export function initTour(sm: (m: Mode) => void) {
  setMode = sm;
  const root = el('div'); root.id = 'tour';
  root.innerHTML = `<div class="spot"></div><div class="tcard" role="dialog" aria-live="polite"><div class="tn"></div><h4></h4><p></p>
    <div class="tf"><button class="btn" data-t="skip">Skip tour</button><span></span><button class="btn" data-t="prev">Back</button><button class="btn primary" data-t="next">Next</button></div></div>`;
  document.body.appendChild(root);
  root.onclick = e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-t]')?.dataset.t;
    if (t === 'next') go(i + 1); else if (t === 'prev') go(i - 1); else if (t === 'skip') endTour();
  };
  window.addEventListener('keydown', e => {
    if (i < 0) return;
    const typing = (e.target as HTMLElement)?.closest?.('input,textarea,select');
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); return; }
    if (typing) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(i - 1); }
  }, true);
  window.addEventListener('resize', () => { if (i >= 0) place(); });
}

export function startTour(done?: () => void) { onEnd = done ?? null; markSeen(); document.body.classList.add('touring'); go(0); }
export const touring = () => i >= 0;

export function endTour() {
  if (i < 0) return;
  i = -1; document.body.classList.remove('touring');
  const cb = onEnd; onEnd = null; cb?.();
}

function go(n: number) {
  if (n >= STEPS.length) return endTour();
  i = Math.max(0, n);
  const s = STEPS[i];
  if (s.mode) setMode(s.mode);
  const c = $('#tour .tcard');
  c.querySelector('.tn')!.textContent = `${i + 1} / ${STEPS.length}`;
  c.querySelector('h4')!.textContent = s.title;
  c.querySelector('p')!.innerHTML = s.body;
  (c.querySelector('[data-t=prev]') as HTMLElement).style.visibility = i ? '' : 'hidden';
  c.querySelector('[data-t=next]')!.textContent = i === STEPS.length - 1 ? 'Finish' : 'Next';
  // let the mode switch lay out before measuring
  requestAnimationFrame(() => requestAnimationFrame(place));
}

function place() {
  const s = STEPS[i]; if (!s) return;
  const spot = $('#tour .spot'), card = $('#tour .tcard');
  const t = s.sel ? document.querySelector<HTMLElement>(s.sel) : null;
  const r = t?.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight, pad = 6, gap = 14;
  if (!r || !r.width || !r.height) {
    spot.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
    card.style.left = (vw - cw) / 2 + 'px'; card.style.top = (vh - ch) / 2 + 'px';
    return;
  }
  const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad), w = Math.min(vw, r.right + pad) - x, h = Math.min(vh, r.bottom + pad) - y;
  spot.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  // prefer below, then right, left, above; otherwise sit inside the target
  const clampX = (v: number) => Math.min(vw - cw - 12, Math.max(12, v));
  const clampY = (v: number) => Math.min(vh - ch - 12, Math.max(12, v));
  let left: number, top: number;
  if (y + h + gap + ch < vh) { left = clampX(x); top = y + h + gap; }
  else if (x + w + gap + cw < vw) { left = x + w + gap; top = clampY(y); }
  else if (x - gap - cw > 0) { left = x - gap - cw; top = clampY(y); }
  else if (y - gap - ch > 0) { left = clampX(x); top = y - gap - ch; }
  else { left = clampX(x + (w - cw) / 2); top = clampY(y + (h - ch) / 2); }
  card.style.left = left + 'px'; card.style.top = top + 'px';
}
