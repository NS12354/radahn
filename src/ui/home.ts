import { $, el, esc } from './dom';
import { BOARDS } from '../hw/library/boards';
import { listProjects, persistent, type ProjectMeta } from '../app/store';

/** Actions the home screen asks the app to perform. */
export interface HomeHost {
  openProject(id: string): void;
  newBlank(board: string): void;
  newExample(): void;
  openFile(): void;
  openFolder(): void;
  duplicateProject(id: string): void;
  deleteProject(id: string, name: string): void;
  startTour(): void;
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
  $('#homeBoard').innerHTML = Object.values(BOARDS).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $('#hBlank').onclick = e => { if ((e.target as HTMLElement).closest('select')) return; host.newBlank(($('#homeBoard') as HTMLSelectElement).value); };
  $('#hExample').onclick = () => host.newExample();
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
  if (!all.length) { g.appendChild(el('div', 'hempty', 'No projects yet. Start a blank one above, or open the The First Step to look around.')); return; }
  if (!list.length) { g.appendChild(el('div', 'hempty', `No projects match “${esc(query)}”.`)); return; }
  for (const p of list) g.appendChild(card(p));
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
