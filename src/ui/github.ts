import type { App } from './app';
import { $, el, esc, toast, copyText } from './dom';
import { gh, setGhBase, CODE_EXT, GH_MIME, type GhRepo, type GhItem, type GhUser } from '../app/github';
import { importFromGitHub } from './elec';
import { highlight, langOf } from '../device/editor';

/**
 * GitHub tab: sign in, pick a repository and branch, browse and preview its
 * files, then drag files or folders into Electronics (or press Add).
 */
let A: App;
const S = {
  user: null as GhUser | null, deviceFlow: false, repos: [] as GhRepo[], q: '',
  repo: null as GhRepo | null, branches: [] as string[], ref: '', items: [] as GhItem[], truncated: false,
  open: new Set<string>(), checked: new Set<string>(), codeOnly: true, preview: null as null | { path: string; content: string } | { path: string; error: string },
  loading: '', device: null as null | { userCode: string; verifyUrl: string },
};
const LAST = 'ff.gh.last';
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=Formframe';
const visible = () => document.body.classList.contains('m-github');

// ------------------------------------------------------------------ data
async function refreshStatus() {
  try { const s = await gh.status(); S.user = s.user; S.deviceFlow = s.deviceFlow; if (S.user && !S.repos.length) await loadRepos(); }
  catch (e: any) { S.user = null; S.loading = ''; toast(e.message); }
  render();
}
async function loadRepos() {
  S.loading = 'repos'; render();
  try {
    S.repos = (await gh.repos()).repos;
    const last = (() => { try { return JSON.parse(localStorage.getItem(LAST) ?? 'null'); } catch { return null; } })();
    const r = last && S.repos.find(x => x.full === last.repo);
    if (r && !S.repo) await openRepo(r, last.ref);
  } catch (e: any) { if (e.status === 401) S.user = null; toast(e.message); }
  S.loading = ''; render();
}
async function openRepo(r: GhRepo, ref?: string) {
  S.repo = r; S.ref = ref ?? r.branch; S.items = []; S.checked.clear(); S.open.clear(); S.preview = null; S.loading = 'tree'; render();
  try {
    const [b, t] = await Promise.all([gh.branches(r.full), gh.tree(r.full, S.ref)]);
    S.branches = b.branches; S.items = t.items; S.ref = t.ref; S.truncated = t.truncated;
    // open folders that contain code, one level deep
    for (const it of S.items) if (it.dir && !it.path.includes('/') && S.items.some(x => !x.dir && x.path.startsWith(it.path + '/') && CODE_EXT.test(x.path))) S.open.add(it.path);
    try { localStorage.setItem(LAST, JSON.stringify({ repo: r.full, ref: S.ref })); } catch { }
  } catch (e: any) { toast(e.message); }
  S.loading = ''; render();
}
async function preview(path: string) {
  S.preview = { path, content: '' }; render();
  try { const f = await gh.file(S.repo!.full, path, S.ref); S.preview = { path, content: f.content }; }
  catch (e: any) { S.preview = { path, error: e.message }; }
  render();
}
const filesUnder = (path: string) => S.items.filter(x => !x.dir && (x.path === path || x.path.startsWith(path + '/')) && CODE_EXT.test(x.path)).map(x => x.path);
async function add(paths: string[]) {
  if (!S.repo || !paths.length) return;
  const r = await importFromGitHub({ repo: S.repo.full, ref: S.ref, paths });
  if (r.added.length) { S.checked.clear(); render(); }
}

// ------------------------------------------------------------------ sign in
async function signInDevice() {
  try {
    const d = await gh.deviceStart(); S.device = { userCode: d.userCode, verifyUrl: d.verifyUrl }; render();
    window.open(d.verifyUrl, '_blank', 'noopener');
    let wait = d.interval * 1000;
    const end = Date.now() + d.expiresIn * 1000;
    while (S.device && Date.now() < end) {
      await new Promise(r => setTimeout(r, wait));
      const p = await gh.devicePoll();
      if (p.status === 'ok') { S.device = null; S.user = p.user!; toast(`Signed in as ${p.user!.login}`); await loadRepos(); return; }
      if (p.status === 'denied' || p.status === 'expired') { S.device = null; toast(p.status === 'denied' ? 'Sign-in was cancelled on GitHub' : 'The code expired. Try again.'); render(); return; }
      wait = (p.interval ?? d.interval) * 1000;
    }
  } catch (e: any) { S.device = null; toast(e.message); render(); }
}
async function signInToken(token: string) {
  try { const r = await gh.token(token); S.user = r.user; toast(`Signed in as ${r.user.login}`); await loadRepos(); }
  catch (e: any) { toast(e.message); }
  render();
}

// ------------------------------------------------------------------ render
const ago = (iso: string) => { const d = (Date.now() - new Date(iso).getTime()) / 86400e3; return d < 1 ? 'today' : d < 30 ? `${Math.floor(d)}d ago` : new Date(iso).toLocaleDateString([], { month: 'short', year: 'numeric' }); };
export function render() {
  if (!A || !visible()) return;
  const left = $('#ghLeft'), mid = $('#ghMid'), right = $('#ghRight');
  // ---- account + repos
  if (!S.user) {
    left.innerHTML = `<div class="ghh"><h2>GitHub</h2></div>
      <p class="ghp">Sign in to bring code from your repositories into Electronics.</p>
      ${S.device ? `<div class="ghcode"><span>Enter this code on GitHub</span><b>${esc(S.device.userCode)}</b><a href="${esc(S.device.verifyUrl)}" target="_blank" rel="noopener" class="btn primary">Open github.com/login/device</a><span class="dim"><i class="spin"></i> Waiting for you to approve…</span><button class="btn" id="ghCancel">Cancel</button></div>`
        : `<button class="btn primary ghbig" id="ghDevice" ${S.deviceFlow ? '' : 'disabled'}>Sign in with GitHub</button>
      ${S.deviceFlow ? '' : `<p class="ghnote">To enable this button, create a GitHub OAuth App (Settings ▸ Developer settings ▸ OAuth Apps), tick <b>Enable Device Flow</b>, and put its client ID in <code>.env</code> as <code>GITHUB_CLIENT_ID</code>. Then restart the server.</p>`}
      <div class="ghor"><span>or use a personal access token</span></div>
      <input id="ghTok" type="password" placeholder="ghp_… or github_pat_…" spellcheck="false" autocomplete="off">
      <button class="btn" id="ghTokBtn">Sign in with token</button>
      <p class="ghnote"><a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a token</a> with the <b>repo</b> scope (or a fine-grained token with read access to Contents). It stays on the Formframe server and is never stored in the browser.</p>
      <div class="ghurl"><code>${TOKEN_URL.replace('https://', '')}</code><button class="btn" id="ghCopyUrl">Copy link</button></div>
      <p class="ghnote">If the link doesn't open (some built-in browsers, like VS Code's, block new tabs), copy it into Chrome, Safari or Firefox.</p>`}`;
    $('#ghDevice')?.addEventListener('click', signInDevice);
    $('#ghCopyUrl')?.addEventListener('click', () => copyText(TOKEN_URL));
    $('#ghCancel')?.addEventListener('click', () => { S.device = null; render(); });
    const t = left.querySelector<HTMLInputElement>('#ghTok');
    if (t) { t.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter' && t.value.trim()) signInToken(t.value.trim()); }; $('#ghTokBtn').onclick = () => t.value.trim() && signInToken(t.value.trim()); }
    mid.innerHTML = '<div class="ghempty">Your repositories and their files show up here once you sign in.</div>'; right.innerHTML = '';
    return;
  }
  left.innerHTML = `<div class="ghme"><img src="${esc(S.user.avatar)}" alt=""><div><b>${esc(S.user.name || S.user.login)}</b><span>@${esc(S.user.login)}</span></div><button class="btn" id="ghOut">Sign out</button></div>
    <input id="ghQ" placeholder="Find a repository" value="${esc(S.q)}" spellcheck="false"><div class="ghrepos"></div>`;
  $('#ghOut').onclick = async () => { await gh.logout().catch(() => {}); Object.assign(S, { user: null, repos: [], repo: null, items: [], preview: null }); render(); };
  const q = left.querySelector<HTMLInputElement>('#ghQ')!; q.onkeydown = e => e.stopPropagation(); q.oninput = () => { S.q = q.value; paintRepos(); };
  paintRepos();
  // ---- tree
  if (!S.repo) { mid.innerHTML = `<div class="ghempty">${S.loading === 'repos' ? '<i class="spin"></i> Loading your repositories…' : 'Pick a repository on the left.'}</div>`; right.innerHTML = ''; return; }
  mid.innerHTML = `<div class="ghrh"><b>${esc(S.repo.full)}</b>${S.repo.private ? '<span class="chip">private</span>' : ''}<select id="ghRef">${S.branches.map(b => `<option ${b === S.ref ? 'selected' : ''}>${esc(b)}</option>`).join('') || `<option>${esc(S.ref)}</option>`}</select></div>
    <div class="ghbar"><label class="keep"><input type="checkbox" id="ghCode" ${S.codeOnly ? 'checked' : ''}> Only code files</label><span class="sp"></span><button class="btn primary" id="ghAddSel" ${S.checked.size ? '' : 'disabled'}>Add ${S.checked.size || ''} to Electronics</button></div>
    <div class="ghtree"></div>
    <p class="ghnote">Drag files or folders onto the <b>Electronics</b> tab (it opens) and drop them on the code. ${S.truncated ? 'This repository is very large, so only part of it is listed.' : ''}</p>`;
  ($('#ghRef') as HTMLSelectElement).onchange = e => openRepo(S.repo!, (e.target as HTMLSelectElement).value);
  ($('#ghCode') as HTMLInputElement).onchange = e => { S.codeOnly = (e.target as HTMLInputElement).checked; render(); };
  $('#ghAddSel').onclick = () => add([...S.checked]);
  const tree = $('.ghtree');
  if (S.loading === 'tree') tree.innerHTML = '<div class="ghempty"><i class="spin"></i> Loading files…</div>';
  else paintTree(tree, '');
  // ---- preview
  const p = S.preview;
  right.innerHTML = !p ? '<div class="ghempty">Click a file to preview it.</div>'
    : 'error' in p ? `<div class="ghph"><b>${esc(p.path)}</b></div><div class="ghempty">${esc(p.error)}</div>`
    : `<div class="ghph"><b>${esc(p.path)}</b><button class="btn primary" id="ghAddOne" ${CODE_EXT.test(p.path) ? '' : 'disabled'}>Add to Electronics</button></div><pre class="ghcodev">${p.content ? highlight(p.content, langOf(p.path)) : '<i class="spin"></i>'}</pre>`;
  $('#ghAddOne')?.addEventListener('click', () => add([p!.path]));
}
function paintRepos() {
  const box = $('.ghrepos'); if (!box) return; box.innerHTML = '';
  const list = S.repos.filter(r => !S.q || r.full.toLowerCase().includes(S.q.toLowerCase()));
  if (S.loading === 'repos') box.innerHTML = '<div class="ghempty"><i class="spin"></i></div>';
  for (const r of list) {
    const d = el('div', 'ghrepo' + (S.repo?.full === r.full ? ' on' : ''), `<b>${esc(r.full.split('/')[1])}</b><span>${esc(r.full.split('/')[0])}${r.private ? ' · private' : ''}${r.language ? ' · ' + esc(r.language) : ''} · ${ago(r.updated)}</span>`);
    d.title = r.description ?? ''; d.onclick = () => openRepo(r);
    box.appendChild(d);
  }
  if (!list.length && S.loading !== 'repos') box.appendChild(el('div', 'ghempty', S.repos.length ? 'No match.' : 'No repositories.'));
}
function paintTree(box: HTMLElement, dir: string, depth = 0) {
  const kids = S.items.filter(x => x.path.startsWith(dir ? dir + '/' : '') && !x.path.slice(dir ? dir.length + 1 : 0).includes('/'));
  kids.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
  for (const it of kids) {
    const codeIn = it.dir ? filesUnder(it.path) : CODE_EXT.test(it.path) ? [it.path] : [];
    if (S.codeOnly && !codeIn.length) continue;
    const name = it.path.split('/').pop()!, open = S.open.has(it.path);
    const row = el('div', 'ghrow' + (S.preview?.path === it.path ? ' on' : '') + (codeIn.length ? '' : ' dim'));
    row.style.paddingLeft = 8 + depth * 16 + 'px';
    row.innerHTML = `${codeIn.length && !it.dir ? `<input type="checkbox" ${S.checked.has(it.path) ? 'checked' : ''}>` : '<span class="cb"></span>'}<span class="ic">${it.dir ? (open ? '▾' : '▸') : '·'}</span><span class="nm">${esc(name)}${it.dir ? '/' : ''}</span>${it.dir ? (codeIn.length ? `<span class="n">${codeIn.length}</span>` : '') : `<span class="n">${it.size < 1024 ? it.size + ' B' : Math.round(it.size / 102.4) / 10 + ' KB'}</span>`}`;
    row.draggable = codeIn.length > 0;
    row.ondragstart = e => { e.dataTransfer!.setData(GH_MIME, JSON.stringify({ repo: S.repo!.full, ref: S.ref, paths: codeIn })); e.dataTransfer!.setData('text/plain', codeIn.join('\n')); e.dataTransfer!.effectAllowed = 'copy'; document.body.classList.add('gh-dragging'); };
    row.ondragend = () => document.body.classList.remove('gh-dragging');
    row.querySelector('input')?.addEventListener('click', e => { e.stopPropagation(); (e.target as HTMLInputElement).checked ? S.checked.add(it.path) : S.checked.delete(it.path); render(); });
    row.onclick = () => { if (it.dir) { open ? S.open.delete(it.path) : S.open.add(it.path); render(); } else preview(it.path); };
    box.appendChild(row);
    if (it.dir && open) paintTree(box, it.path, depth + 1);
  }
}

export function initGitHub(app: App) {
  A = app; setGhBase(app.base);
  // hovering the Electronics tab while dragging GitHub files opens it, so you can drop on the code
  const elecTab = document.querySelector<HTMLElement>('#modes [data-m=elec]')!;
  let springT: any = null;
  elecTab.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes(GH_MIME)) { elecTab.classList.add('spring'); springT = setTimeout(() => { A.setMode('elec'); elecTab.classList.remove('spring'); }, 450); } });
  elecTab.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes(GH_MIME)) e.preventDefault(); });
  elecTab.addEventListener('dragleave', () => { clearTimeout(springT); elecTab.classList.remove('spring'); });
  elecTab.addEventListener('drop', async e => { const g = e.dataTransfer?.getData(GH_MIME); if (!g) return; e.preventDefault(); clearTimeout(springT); A.setMode('elec'); await importFromGitHub(JSON.parse(g)); });
}
/** Entering the tab: check the session (cheap) and paint. */
export function showGitHub() { render(); refreshStatus(); }
