import { $, el, esc } from './dom';
import { BOARDS, boardOptions } from '../hw/library/boards';
import { ROBOT_KINDS } from '../app/robots';
import { listProjects, persistent, type ProjectMeta } from '../app/store';
import { listScenes, type SceneMeta } from '../app/scene';

/** Actions the home screen asks the app to perform. */
export interface HomeHost {
  openProject(id: string): void;
  newBlank(board: string): void;
  newExample(): void;
  newRobot(kind: string): void;
  openFile(): void;
  openFolder(): void;
  duplicateProject(id: string): void;
  deleteProject(id: string, name: string): void;
  startTour(): void;
  newScene(): void;
  openScene(id: string): void;
  deleteScene(id: string, name: string): void;
}

let host: HomeHost;
let query = '';

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function initHome(h: HomeHost) {
  host = h;
  $('#homeBoard').innerHTML = boardOptions();
  $('#hBlank').onclick = e => { if ((e.target as HTMLElement).closest('select')) return; host.newBlank(($('#homeBoard') as HTMLSelectElement).value); };
  $('#hExample').onclick = () => host.newExample();
  $('#hRobots').innerHTML = ROBOT_KINDS.map(r => `<button class="start robot" data-k="${r.id}"><div class="ic ic-robot ic-${r.id}"></div><b>${esc(r.name)}</b><span>${esc(r.blurb)}</span></button>`).join('');
  $('#hRobots').querySelectorAll<HTMLElement>('button').forEach(b => (b.onclick = () => host.newRobot(b.dataset.k!)));
  $('#hOpen').onclick = () => host.openFile();
  $('#hFolder').onclick = () => host.openFolder();
  $('#hTour').onclick = () => host.startTour();
  ($('#homeSearch') as HTMLInputElement).oninput = e => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); renderHome(); };
}

export function showHome() {
  document.body.classList.add('at-home');
  renderHome();
}
export function hideHome() { document.body.classList.remove('at-home'); }
export const atHome = () => document.body.classList.contains('at-home');

export async function renderHome() {
  const all = await listProjects();
  const list = query ? all.filter(p => p.name.toLowerCase().includes(query)) : all;
  $('#homeCount').textContent = all.length ? String(all.length) : '';
  $('#homeSearch').style.display = all.length > 4 ? '' : 'none';
  $('#homeWarn').style.display = persistent ? 'none' : '';
  const g = $('#homeGrid'); g.innerHTML = '';
  if (!all.length) { renderScenes(); g.appendChild(el('div', 'hempty', 'No projects yet. Start a blank one above, or open the The First Step to look around.')); return; }
  if (!list.length) { renderScenes(); g.appendChild(el('div', 'hempty', `No projects match “${esc(query)}”.`)); return; }
  for (const p of list) g.appendChild(card(p));
  renderScenes();
}

async function renderScenes() {
  const g = $('#sceneGrid'); if (!g) return;
  const all = await listScenes();
  g.innerHTML = '';
  const add = el('button', 'start scenenew');
  add.innerHTML = '<div class="ic ic-scene"></div><b>New scene</b><span>Put robots from your projects in one world, name them, and run them all at once</span>';
  add.onclick = () => host.newScene();
  g.appendChild(add);
  for (const s of all) g.appendChild(sceneCard(s));
}
function sceneCard(s: SceneMeta) {
  const c = el('div', 'pcard');
  c.tabIndex = 0;
  c.innerHTML = `<div class="th">${s.thumb ? `<img src="${s.thumb}" alt="">` : '<span class="blank">Empty scene</span>'}</div>
    <div class="pi"><b title="${esc(s.name)}">${esc(s.name)}</b><span>${s.robots} robot${s.robots === 1 ? '' : 's'} · edited ${ago(s.updated)}</span></div>
    <div class="pa"><button data-x="del" title="Delete">Delete</button></div>`;
  c.onclick = e => { if ((e.target as HTMLElement).closest('[data-x]')) host.deleteScene(s.id, s.name); else host.openScene(s.id); };
  c.onkeydown = e => { if (e.key === 'Enter' && e.target === c) host.openScene(s.id); };
  return c;
}

function card(p: ProjectMeta) {
  const c = el('div', 'pcard');
  c.tabIndex = 0;
  c.innerHTML = `<div class="th">${p.thumb ? `<img src="${p.thumb}" alt="">` : '<span class="blank">No model</span>'}</div>
    <div class="pi"><b title="${esc(p.name)}">${esc(p.name)}</b><span>${esc(BOARDS[p.board]?.name ?? p.board)} · edited ${ago(p.updated)}</span></div>
    <div class="pa"><button data-x="dup" title="Duplicate">Duplicate</button><button data-x="del" title="Delete">Delete</button></div>`;
  c.onclick = e => {
    const x = (e.target as HTMLElement).closest<HTMLElement>('[data-x]')?.dataset.x;
    if (x === 'dup') host.duplicateProject(p.id);
    else if (x === 'del') host.deleteProject(p.id, p.name);
    else host.openProject(p.id);
  };
  c.onkeydown = e => { if (e.key === 'Enter' && e.target === c) host.openProject(p.id); };
  return c;
}
