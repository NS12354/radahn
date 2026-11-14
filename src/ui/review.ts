import * as THREE from 'three';
import type { App } from './app';
import { $, el, esc } from './dom';
import { track } from './track';

export function renderComments(app: App, focusLast = false) {
  const l = $('#cmtList'); l.innerHTML = '';
  const cs = app.project.comments;
  $('#cmtCount').textContent = cs.length ? String(cs.length) : '';
  if (!cs.length) l.appendChild(el('div', 'empty', 'No comments yet.'));
  cs.forEach((c, i) => {
    const d = el('div', 'cmt', `<div class="h"><b>${i + 1}</b>${esc(c.part)}<span style="margin-left:auto">${new Date(c.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div><textarea placeholder="Add a comment…"></textarea><div class="r"><span style="color:var(--faint)">Pinned in 3D · saved with the project</span><a>Resolve</a></div>`);
    const ta = d.querySelector('textarea')!; ta.value = c.text;
    ta.oninput = () => { c.text = ta.value; app.changed('review'); };
    d.querySelector('a')!.onclick = () => { track('review', `Resolved a comment on the ${c.part}${c.text ? `: “${c.text.slice(0, 60)}”` : ''}`, true); cs.splice(i, 1); renderComments(app); app.changed('review'); };
    l.appendChild(d);
    if (focusLast && i === cs.length - 1) setTimeout(() => ta.focus(), 0);
  });
  renderPins(app);
}

export function addComment(app: App, worldPoint: THREE.Vector3, part: string) {
  const local = app.product.group.worldToLocal(worldPoint.clone());
  app.project.comments.push({ p: [local.x, local.y, local.z], text: '', part, t: new Date().toISOString() });
  track('review', `Added a review comment on the ${part}`);
  renderComments(app, true); app.changed('review');
}

export function renderPins(app: App) {
  const p = $('#pins'); p.innerHTML = '';
  if (app.mode !== 'review') return;
  app.project.comments.forEach((_, i) => { const d = el('div', 'pin', `<span>${i + 1}</span>`); d.dataset.i = String(i); p.appendChild(d); });
}

export function placePins(app: App) {
  if (app.mode !== 'review') return;
  const vr = $('#viewport').getBoundingClientRect();
  document.querySelectorAll<HTMLElement>('#pins .pin').forEach(d => {
    const c = app.project.comments[+d.dataset.i!]; if (!c) return;
    const w = app.product.group.localToWorld(new THREE.Vector3(...c.p));
    const s = app.viewport.project(w);
    d.style.left = s.x - vr.left + 'px'; d.style.top = s.y - vr.top + 'px'; d.style.display = s.behind ? 'none' : '';
  });
}
