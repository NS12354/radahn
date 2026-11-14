import type { App } from './app';
import { $, el, opts, toast } from './dom';
import { ACTIONS, LEDCOL, LEDS, STATES, TRIGGERS, drawScreen, step } from '../proto/stateMachine';
import { audio } from '../hw/audio';
import { unhandled } from './health';
import { track } from './track';

let idleTimer: any = null;
let actx: AudioContext | null = null;
function beep(f: number) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = f; g.gain.setValueAtTime(0.06, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.06);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.07);
  } catch { }
}
const log = (msg: string, cls = '') => { const l = $('#log'); const d = el('div', cls); d.textContent = msg; l.prepend(d); while (l.children.length > 8) l.lastChild!.remove(); };

export function redrawScreen(app: App) { drawScreen(app.product.screen, app.sm); app.product.screenUpdated(); }

export function fire(app: App, trig: string) {
  if (app.mode !== 'proto') return;
  clearTimeout(idleTimer);
  const { next, t, index } = step(app.project.interactions, app.sm, trig);
  if (!t) { log(`✕ ${STATES[app.sm.state]} · ${TRIGGERS[trig]}: unhandled`, 'miss'); if (trig !== 'idle') unhandled(STATES[app.sm.state], TRIGGERS[trig]); armIdle(app); return; }
  const prev = app.sm.state;
  Object.assign(app.sm, next);
  if (t.act === 'save') toast(`Target saved · ${app.sm.target.toFixed(1)}°`);
  if (t.led !== 'none') app.product.flashLed(LEDCOL[t.led]);
  if (t.hap) app.product.shake();
  if (t.snd) beep(trig === 'press' ? 1800 : trig === 'long' ? 900 : 1300);
  log(`→ ${STATES[prev]} · ${TRIGGERS[trig]} → ${STATES[t.to]}${t.act !== 'none' ? ' · ' + ACTIONS[t.act] : ''}`, 'fire');
  redrawScreen(app); renderLive(app); drawGraph(app, index); flashTr(index);
  armIdle(app);
}
export function armIdle(app: App) {
  clearTimeout(idleTimer);
  if (app.mode === 'proto' && app.project.interactions.some(t => t.from === app.sm.state && t.trig === 'idle')) idleTimer = setTimeout(() => fire(app, 'idle'), 3000);
}
export function stopIdle() { clearTimeout(idleTimer); }

export function initProto(app: App) {
  $('#bReset').onclick = () => { Object.assign(app.sm, { state: 'home', target: 22, room: 20.5 }); app.product.resetDial(); redrawScreen(app); renderLive(app); drawGraph(app); log('↺ reset'); };
  $('#bWarm').onclick = () => { app.sm.room += 2; redrawScreen(app); renderLive(app); };
  $('#bCool').onclick = () => { app.sm.room -= 2; redrawScreen(app); renderLive(app); };
  $('#bAddTr').onclick = () => { track('interaction', `Added an interaction on the ${STATES[app.sm.state]} screen`); app.project.interactions.push({ from: app.sm.state, trig: 'press', to: 'home', act: 'none', led: 'none', hap: false, snd: true }); renderTrs(app); drawGraph(app); app.changed('interactions'); };
  // simulated room drifts toward target
  setInterval(() => {
    if (app.mode === 'proto' && (app.sm.state === 'home' || app.sm.state === 'eco') && Math.abs(app.sm.target - app.sm.room) > 0.05) {
      app.sm.room += (app.sm.target - app.sm.room) * 0.04; redrawScreen(app); renderLive(app);
    }
  }, 1000);
  log('Ready · switch to Prototype to interact');
  void audio;
}

export function renderLive(app: App) {
  $('#kvState').textContent = STATES[app.sm.state]; $('#kvTarget').textContent = app.sm.target.toFixed(1) + '°'; $('#kvRoom').textContent = app.sm.room.toFixed(1) + '°';
  $('#statebadge').textContent = app.mode === 'elec' ? '' : `state: ${app.sm.state}  ·  target ${app.sm.target.toFixed(1)}°`;
  renderScreens(app);
}

export function renderScreens(app: App) {
  const l = $('#screenList'); l.innerHTML = '';
  for (const [k, n] of Object.entries(STATES)) {
    const cnt = app.project.interactions.filter(t => t.from === k).length;
    const d = el('div', 'item' + (app.sm.state === k ? ' on' : ''), `<span class="sw" style="background:#0b0d10;border-color:#444;border-radius:50%"></span>${n}<span class="meta">${cnt} out</span>`);
    d.onclick = () => { app.sm.state = k; redrawScreen(app); renderScreens(app); renderLive(app); drawGraph(app); };
    l.appendChild(d);
  }
}

export function renderTrs(app: App) {
  const l = $('#trList'); l.innerHTML = '';
  app.project.interactions.forEach((t, i) => {
    const d = el('div', 'tr'); d.dataset.i = String(i);
    d.innerHTML = `<button class="del" title="Delete">✕</button>
      <div class="g"><select data-k="from">${opts(STATES, t.from)}</select><span class="arr">→</span><select data-k="to">${opts(STATES, t.to)}</select></div>
      <div class="g2"><select data-k="trig">${opts(TRIGGERS, t.trig)}</select><select data-k="act">${opts(ACTIONS, t.act)}</select></div>
      <div class="g2"><select data-k="led">${opts(LEDS, t.led)}</select><div class="hap"><label><input type="checkbox" data-k="hap" ${t.hap ? 'checked' : ''}>Haptic</label><label><input type="checkbox" data-k="snd" ${t.snd ? 'checked' : ''}>Click</label></div></div>`;
    d.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach(s => (s.onchange = () => {
      (t as any)[s.dataset.k!] = s.type === 'checkbox' ? (s as HTMLInputElement).checked : s.value;
      drawGraph(app); renderScreens(app); app.changed('interactions');
    }));
    d.querySelector<HTMLButtonElement>('.del')!.onclick = () => { track('interaction', `Deleted an interaction (${STATES[t.from]} · ${TRIGGERS[t.trig]})`); app.project.interactions.splice(i, 1); renderTrs(app); drawGraph(app); renderScreens(app); app.changed('interactions'); };
    l.appendChild(d);
  });
  $('#trCount').textContent = String(app.project.interactions.length);
}
function flashTr(i: number) { const d = document.querySelector(`.tr[data-i="${i}"]`); if (!d) return; d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 500); }

const NODE: Record<string, [number, number]> = { home: [90, 66], set: [250, 66], eco: [410, 66], away: [570, 66] };
export function drawGraph(app: App, fired = -1) {
  let s = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#6c6c73"/></marker><marker id="ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#4f7cff"/></marker></defs>';
  const groups: Record<string, { from: string; to: string; trigs: string[]; idx: number[] }> = {};
  app.project.interactions.forEach((t, i) => { const k = t.from + '>' + t.to; (groups[k] ||= { from: t.from, to: t.to, trigs: [], idx: [] }); groups[k].trigs.push(TRIGGERS[t.trig]); groups[k].idx.push(i); });
  const keys = Object.keys(NODE);
  for (const g of Object.values(groups)) {
    const a = NODE[g.from], b = NODE[g.to]; if (!a || !b) continue;
    const on = g.idx.includes(fired), col = on ? '#4f7cff' : '#55555b', mk = on ? 'ahb' : 'ah', lbl = [...new Set(g.trigs)].join(' · ');
    const tc = on ? '#cfd9ff' : '#8a8a92';
    if (g.from === g.to) {
      const y = a[1] - 20, h = 26;
      s += `<path d="M${a[0] - 14},${y} C${a[0] - 40},${y - h} ${a[0] + 40},${y - h} ${a[0] + 14},${y}" fill="none" stroke="${col}" stroke-width="${on ? 2 : 1.2}" marker-end="url(#${mk})"/><text x="${a[0]}" y="${y - h * 0.75 - 3}" text-anchor="middle" fill="${tc}" font-size="10">${lbl}</text>`;
    } else {
      const fwd = keys.indexOf(g.from) < keys.indexOf(g.to), dist = Math.abs(b[0] - a[0]), bend = (fwd ? -1 : 1) * (16 + dist * 0.12);
      const x1 = a[0] + (fwd ? 30 : -30), x2 = b[0] + (fwd ? -30 : 30), sy = a[1] + (fwd ? -6 : 6), ey = b[1] + (fwd ? -6 : 6);
      const cx = (x1 + x2) / 2, cy = (sy + ey) / 2 + bend;
      s += `<path d="M${x1},${sy} Q${cx},${cy} ${x2},${ey}" fill="none" stroke="${col}" stroke-width="${on ? 2 : 1.2}" marker-end="url(#${mk})"/><text x="${cx}" y="${(sy + cy) / 2 + (fwd ? -2 : 10)}" text-anchor="middle" fill="${tc}" font-size="10">${lbl}</text>`;
    }
  }
  for (const [k, [x, y]] of Object.entries(NODE)) {
    const cur = app.sm.state === k;
    s += `<g><rect x="${x - 30}" y="${y - 16}" width="60" height="32" rx="8" fill="${cur ? '#2f3a5c' : '#2a2a2c'}" stroke="${cur ? '#4f7cff' : '#45454b'}" stroke-width="${cur ? 2 : 1}"/><text x="${x}" y="${y + 4}" text-anchor="middle" fill="${cur ? '#fff' : '#cfcfd4'}" font-size="11" font-weight="500">${STATES[k]}</text></g>`;
  }
  $('#graph').innerHTML = s;
}
