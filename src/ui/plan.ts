import type { App } from './app';
import { $, $$, el, esc, toast } from './dom';
import { setTrackSink } from './track';
import { healthState } from './health';
import { COMPONENTS } from '../hw/library/components';
import { pinLabel } from '../hw/library/boards';
import { emptyPlan, logEvent, milestones, taskId, type PlanData, type PlanTask, type PlanArea, type TaskStatus, type LogKind, type Milestone } from '../app/plan';
import { friendly } from '../app/explain';
import { hasStateMachine } from '../app/project';

/**
 * Plan tab: milestones that tick themselves, your task board, an automatic
 * activity log, and an AI tracker (Claude) that reads the project and marks
 * what's done with evidence, records unlisted finished work, and suggests
 * what to do next.
 */
let A: App;
const AREA: Record<PlanArea, string> = { electronics: 'Electronics', code: 'Code', model: '3D model', interactions: 'Interactions', review: 'Review', other: 'Other' };
const COLS: [TaskStatus, string][] = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
const ICON: Record<LogKind, string> = { run: '›', crash: '✕', test: '✓', compile: '◇', wiring: '⌁', part: '+', board: '▣', code: '✎', model: '◆', interaction: '↻', review: '¶', milestone: '★', ai: '✦', task: '☐' };
let undo: string | null = null, busy = false;

const plan = (): PlanData => (A.project.plan ??= emptyPlan());
const save = () => A.changed('plan');
const visible = () => document.body.classList.contains('m-plan');

// ------------------------------------------------------------------ automatic tracking
function onTrack(kind: LogKind, text: string, ok?: boolean) {
  const p = plan(); if (!A.projectId) return;
  logEvent(p, kind, text, ok);
  if (kind === 'run') p.lastRun = { at: new Date().toISOString(), errors: 0 };
  if (kind === 'crash' && p.lastRun) p.lastRun.errors++;
  if (kind === 'test') { const m = text.match(/(\d+) failed/); p.lastTest = { at: new Date().toISOString(), passed: !!ok, failed: m ? +m[1] : 0 }; }
  checkMilestones(); save();
  if (visible()) render();
}
function state(): Milestone[] {
  const p = plan(), e = A.project.electronics, h = healthState();
  const probs = h.problems;
  const unconnected = e.comps.reduce((n, c) => n + Object.values(c.pins).filter(v => v == null).length, 0);
  const lastTest = h.lastTest ?? p.lastTest;
  const ranThisSession = h.everRan;
  return milestones({
    parts: e.comps.length, unconnected,
    wiringBroken: probs.filter(x => x.area === 'wiring' && x.level === 'broken').length,
    codeRan: ranThisSession || !!p.lastRun,
    runBroken: ranThisSession ? probs.filter(x => (x.area === 'running' || x.area === 'code') && x.level === 'broken').length : p.lastRun?.errors ?? 0,
    tested: !!lastTest?.passed, lastTest,
    hasModel: A.project.product.source !== 'none',
    modelProblems: probs.filter(x => x.area === 'model' && x.level !== 'tip').length,
    roleTips: probs.filter(x => x.area === 'model' && x.level === 'tip').length,
    interactions: A.project.interactions.length, comments: A.project.comments.length,
    stateMachine: hasStateMachine(A.project),
  });
}
function checkMilestones() {
  const p = plan();
  for (const m of state()) if (m.done && !p.reached[m.id]) { p.reached[m.id] = new Date().toISOString(); logEvent(p, 'milestone', `Milestone: ${m.title}`, true); }
}

// ------------------------------------------------------------------ AI tracker
function context() {
  const p = plan(), e = A.project.electronics, b = A.board();
  const code: Record<string, string> = {};
  for (const [n, v] of Object.entries(e.files)) {
    if (n.startsWith('lib/') || n.endsWith('.hex')) continue;
    code[n] = v.length > 12000 ? v.slice(0, 12000) + `\n… (file continues: ${v.length - 12000} more characters not shown)` : v;
  }
  return {
    now: new Date().toISOString(), project: A.project.name, board: b.name,
    parts: e.comps.map(c => ({ name: friendly(COMPONENTS[c.type]?.name ?? c.type), type: COMPONENTS[c.type]?.name ?? c.type, pins: Object.fromEntries(Object.entries(c.pins).map(([r, g]) => [r, g == null ? 'not connected' : pinLabel(b, g)])) })),
    libraries: Object.keys(e.files).filter(n => n.startsWith('lib/')),
    code,
    model: { source: A.project.product.source, parts: A.project.product.built?.parts.map(x => `${x.name}${x.role !== 'body' ? ` (${x.role})` : ''}`).slice(0, 60) ?? [] },
    interactions: A.project.interactions.length, openReviewComments: A.project.comments.length,
    milestones: state().map(m => ({ id: m.id, title: m.title, done: m.done, detail: m.detail, reachedAt: p.reached[m.id] ?? null })),
    problems: healthState().problems.map(x => ({ level: x.level, area: x.area, title: x.title })),
    lastRun: p.lastRun ?? null, lastTest: healthState().lastTest ?? p.lastTest ?? null,
    activity: p.log.slice(-150),
    tasks: p.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, area: t.area, evidence: t.evidence ?? null })),
  };
}
async function updateWithAI() {
  if (busy) return;
  busy = true; render();
  try {
    const r = await fetch(A.base + 'api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: context() }) }).catch(() => null);
    if (!r || r.status === 404) throw new Error('The AI tracker needs the Formframe server (npm run dev).');
    const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error);
    const p = plan(); undo = JSON.stringify(p);
    const now = new Date().toISOString(); let done = 0, moved = 0;
    for (const u of j.taskUpdates ?? []) {
      const t = p.tasks.find(x => x.id === u.id); if (!t || t.status === u.status) continue;
      t.status = u.status; t.evidence = u.evidence; t.doneAt = u.status === 'done' ? now : undefined; moved++; if (u.status === 'done') done++;
    }
    for (const c of j.completed ?? []) {
      if (p.tasks.some(t => t.title.toLowerCase() === String(c.title).toLowerCase())) continue;
      p.tasks.push({ id: taskId(), title: c.title, status: 'done', area: c.area, source: 'ai', evidence: c.evidence, created: now, doneAt: now }); done++;
    }
    p.ai = { at: now, summary: j.summary, nextStep: j.nextStep, risks: j.risks ?? [], suggestions: (j.suggestions ?? []).filter((s: any) => !p.tasks.some(t => t.title.toLowerCase() === String(s.title).toLowerCase())) };
    logEvent(p, 'ai', `AI update: ${done} marked done, ${moved} task${moved === 1 ? '' : 's'} moved, ${p.ai.suggestions.length} suggestion${p.ai.suggestions.length === 1 ? '' : 's'}`, true, 0);
    save(); toast(done ? `AI marked ${done} thing${done > 1 ? 's' : ''} done` : 'AI updated your plan');
  } catch (e: any) { toast(e.message); }
  finally { busy = false; render(); }
}

// ------------------------------------------------------------------ tasks
function addTask(title: string, area: PlanArea, source: 'user' | 'ai' = 'user', status: TaskStatus = 'todo') {
  const t: PlanTask = { id: taskId(), title, status, area, source, created: new Date().toISOString() };
  plan().tasks.push(t); logEvent(plan(), 'task', `Added task: ${title}`); save(); render();
}
function setStatus(t: PlanTask, s: TaskStatus) {
  if (t.status === s) return;
  t.status = s; t.doneAt = s === 'done' ? new Date().toISOString() : undefined;
  if (s !== 'done' && t.source === 'ai' && t.evidence) t.evidence = undefined;
  if (s === 'done') logEvent(plan(), 'task', `Done: ${t.title}`, true);
  save(); render();
}

// ------------------------------------------------------------------ render
const ago = (iso: string) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export function render() {
  if (!A || !visible()) return;
  checkMilestones();
  const p = plan(), ms = state(), done = ms.filter(m => m.done).length;
  // milestones
  $('#plMsCount').textContent = `${done}/${ms.length}`;
  ($('#plMsBar') as HTMLElement).style.width = `${(done / ms.length) * 100}%`;
  const ml = $('#plMs'); ml.innerHTML = '';
  for (const m of ms) {
    const d = el('div', 'plm' + (m.done ? ' done' : ''), `<i>${m.done ? '✓' : ''}</i><div><b>${esc(m.title)}</b><span>${esc(m.detail)}${m.done && p.reached[m.id] ? ` · ${ago(p.reached[m.id])}` : ''}</span></div>${m.done ? '' : '<button class="btn">Go</button>'}`);
    d.querySelector('button')?.addEventListener('click', () => A.setMode(m.go));
    ml.appendChild(d);
  }
  // task board
  for (const [s] of COLS) {
    const col = $(`#plCol-${s}`), list = p.tasks.filter(t => t.status === s);
    col.querySelector('.plcount')!.textContent = String(list.length);
    const body = col.querySelector('.plcards') as HTMLElement; body.innerHTML = '';
    for (const t of list) body.appendChild(card(t));
    if (!list.length) body.appendChild(el('div', 'plempty', s === 'todo' ? 'Add what you still need to do, or ask the AI for suggestions.' : s === 'doing' ? 'Drag a task here when you start it.' : 'Finished tasks land here, with evidence when the AI marks them.'));
  }
  // AI
  const ai = p.ai, box = $('#plAi');
  ($('#plAiBtn') as HTMLButtonElement).disabled = busy;
  $('#plAiBtn').innerHTML = busy ? '<i class="spin"></i> Reading your project…' : 'Update with AI';
  ($('#plUndo') as HTMLElement).hidden = !undo;
  box.innerHTML = ai ? `<div class="plsum">${esc(ai.summary)}</div>${ai.nextStep ? `<div class="plnext"><b>Next:</b> ${esc(ai.nextStep)}</div>` : ''}${ai.risks.length ? `<div class="plrisk">${ai.risks.map(r => `<div>Risk: ${esc(r)}</div>`).join('')}</div>` : ''}<div class="plwhen">Updated ${ago(ai.at)}</div>` : '<div class="plsum dim">The AI reads your parts, code, test results and this log, then ticks off what\'s done (with evidence), records finished work you didn\'t list, and suggests what to do next.</div>';
  const sg = $('#plSug'); sg.innerHTML = '';
  for (const s of ai?.suggestions ?? []) {
    const d = el('div', 'plsg', `<div><b>${esc(s.title)}</b><span>${esc(s.why)}</span></div><button class="btn primary">Add</button><button class="btn x" title="Dismiss">✕</button>`);
    (d.querySelector('.primary') as HTMLElement).onclick = () => { ai!.suggestions = ai!.suggestions.filter(x => x !== s); addTask(s.title, s.area, 'ai'); };
    (d.querySelector('.x') as HTMLElement).onclick = () => { ai!.suggestions = ai!.suggestions.filter(x => x !== s); save(); render(); };
    sg.appendChild(d);
  }
  // activity
  const lg = $('#plLog'); lg.innerHTML = '';
  let day = '';
  for (const ev of [...p.log].reverse().slice(0, 200)) {
    const dd = new Date(ev.t).toDateString();
    if (dd !== day) { day = dd; lg.appendChild(el('div', 'plday', dd === new Date().toDateString() ? 'Today' : new Date(ev.t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))); }
    const short = ev.text.length > 110 ? ev.text.split(' (')[0] : ev.text; // long details (Test it results) on hover
    const row = el('div', 'plev ' + (ev.ok === false ? 'bad' : ev.ok ? 'ok' : ''), `<i>${ICON[ev.kind] ?? '•'}</i><span>${esc(short)}${short !== ev.text ? ' <em>…</em>' : ''}</span><time>${time(ev.t)}</time>`);
    if (short !== ev.text) row.title = ev.text;
    lg.appendChild(row);
  }
  if (!p.log.length) lg.appendChild(el('div', 'plempty', 'Everything you do is recorded here: runs, tests, wiring, model edits.'));
}
function card(t: PlanTask) {
  const c = el('div', 'plcard' + (t.source === 'ai' ? ' ai' : ''));
  c.draggable = true; c.dataset.id = t.id;
  const ref = t.ref ? A.project.electronics.comps.find(x => x.uid === t.ref) : null;
  c.innerHTML = `<div class="plct"><input type="checkbox" ${t.status === 'done' ? 'checked' : ''} title="Done"><span class="pltt"></span><button class="x" title="Delete">✕</button></div>
    <div class="plmeta"><span class="chip">${AREA[t.area]}</span>${t.source === 'ai' ? '<span class="chip ai">AI</span>' : ''}${ref ? `<span class="chip">${esc(friendly(COMPONENTS[ref.type]?.name ?? ref.type))}</span>` : ''}${t.doneAt ? `<span class="when">${ago(t.doneAt)}</span>` : ''}</div>
    ${t.evidence ? `<div class="plev2">${esc(t.evidence)}</div>` : ''}`;
  (c.querySelector('.pltt') as HTMLElement).textContent = t.title;
  (c.querySelector('input') as HTMLInputElement).onchange = e => setStatus(t, (e.target as HTMLInputElement).checked ? 'done' : 'todo');
  (c.querySelector('.x') as HTMLElement).onclick = () => { plan().tasks = plan().tasks.filter(x => x !== t); save(); render(); };
  const tt = c.querySelector('.pltt') as HTMLElement;
  tt.ondblclick = () => { tt.contentEditable = 'true'; tt.focus(); document.getSelection()?.selectAllChildren(tt); };
  tt.onblur = () => { if (tt.isContentEditable) { tt.contentEditable = 'false'; const v = tt.textContent?.trim(); if (v && v !== t.title) { t.title = v; save(); } else tt.textContent = t.title; } };
  tt.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); tt.blur(); } if (e.key === 'Escape') { tt.textContent = t.title; tt.blur(); } };
  c.ondragstart = e => { e.dataTransfer?.setData('text/plain', t.id); c.classList.add('drag'); };
  c.ondragend = () => c.classList.remove('drag');
  return c;
}

export function initPlan(app: App) {
  A = app;
  setTrackSink(onTrack);
  const inp = $('#plNew') as HTMLInputElement, area = $('#plArea') as HTMLSelectElement;
  area.innerHTML = Object.entries(AREA).map(([k, v]) => `<option value="${k}" ${k === 'other' ? 'selected' : ''}>${k === 'other' ? 'Any area' : v}</option>`).join('');
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter' && inp.value.trim()) { addTask(inp.value.trim(), area.value as PlanArea); inp.value = ''; } };
  $('#plAdd').onclick = () => { if (inp.value.trim()) { addTask(inp.value.trim(), area.value as PlanArea); inp.value = ''; } else inp.focus(); };
  $('#plAiBtn').onclick = () => updateWithAI();
  $('#plUndo').onclick = () => { if (!undo) return; A.project.plan = JSON.parse(undo); undo = null; save(); render(); toast('Undid the AI update'); };
  for (const [s] of COLS) {
    const col = $(`#plCol-${s}`);
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = e => { e.preventDefault(); col.classList.remove('over'); const t = plan().tasks.find(x => x.id === e.dataTransfer?.getData('text/plain')); if (t) setStatus(t, s); };
  }
  setInterval(() => { if (visible()) render(); }, 60_000); // keep "x min ago" fresh
}
export const resetPlanUndo = () => { undo = null; };
void $$;
