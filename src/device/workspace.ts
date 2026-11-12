import { send, state, on } from './client';

/**
 * Open editor tabs and their unsaved text. Saving (or running, which saves
 * first, like Thonny and the Arduino IDE) sends the file to the studio.
 */
export class Workspace {
  tabs: string[] = [];
  active = '';
  buf = new Map<string, string>();
  dirty = new Set<string>();
  onChange: () => void = () => {};
  constructor() {
    on('files', () => {
      // studio-side edits: refresh clean buffers, keep unsaved ones
      for (const n of [...this.tabs]) { if (state!.files[n] == null) this.close(n, true); else if (!this.dirty.has(n)) this.buf.set(n, state!.files[n]); }
      this.onChange();
    });
    on('state', () => this.onChange());
    window.addEventListener('beforeunload', () => this.saveAll());
  }
  files() { return state?.files ?? {}; }
  names() { return Object.keys(this.files()).sort((a, b) => (a.includes('/') ? 1 : 0) - (b.includes('/') ? 1 : 0) || a.localeCompare(b)); }
  text(n: string) { return this.buf.get(n) ?? this.files()[n] ?? ''; }
  open(n: string) {
    if (this.files()[n] == null) return;
    if (!this.tabs.includes(n)) this.tabs.push(n);
    this.active = n; this.onChange();
  }
  edit(n: string, v: string) { this.buf.set(n, v); if (v !== this.files()[n]) this.dirty.add(n); else this.dirty.delete(n); this.onChange(); }
  save(n = this.active) { if (!n || !this.dirty.has(n)) return; const v = this.text(n); state!.files[n] = v; send('save', { name: n, content: v }); this.dirty.delete(n); this.onChange(); }
  saveAll() { [...this.dirty].forEach(n => this.save(n)); }
  /** Files to send along with Run / Upload (everything unsaved). */
  pending() { const out: Record<string, string> = {}; for (const n of this.dirty) out[n] = this.text(n); for (const n of this.dirty) state!.files[n] = out[n]; this.dirty.clear(); this.onChange(); return out; }
  close(n: string, force = false) {
    if (!force && this.dirty.has(n) && !confirm(`Save changes to ${n}?`)) { this.dirty.delete(n); this.buf.delete(n); }
    else if (!force) this.save(n);
    this.tabs = this.tabs.filter(t => t !== n); this.buf.delete(n); this.dirty.delete(n);
    if (this.active === n) this.active = this.tabs[this.tabs.length - 1] ?? '';
    this.onChange();
  }
  create(n: string, content = '') { send('create', { name: n, content }); state!.files[n] = content; this.open(n); }
  remove(n: string) { send('delete', { name: n }); this.close(n, true); }
  rename(a: string, b: string) { send('rename', { from: a, to: b }); const i = this.tabs.indexOf(a); if (i >= 0) this.tabs[i] = b; if (this.active === a) this.active = b; const v = this.buf.get(a); if (v != null) { this.buf.set(b, v); this.buf.delete(a); } if (this.dirty.delete(a)) this.dirty.add(b); state!.files[b] = state!.files[a]; delete state!.files[a]; this.onChange(); }
}

/** Popup menus shared by the IDE skins. */
export interface MI { label?: string; key?: string; act?: () => void; sep?: boolean; dis?: boolean; check?: boolean }
let openMenu: HTMLElement | null = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; document.querySelectorAll('.mbar .open').forEach(b => b.classList.remove('open')); }
document.addEventListener('pointerdown', e => { if (openMenu && !(e.target as HTMLElement).closest('.dmenu, .mbar button')) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
export function menu(items: MI[], x: number, y: number, cls = '') {
  closeMenu();
  const m = document.createElement('div'); m.className = 'dmenu ' + cls;
  for (const it of items) {
    if (it.sep) { m.appendChild(Object.assign(document.createElement('div'), { className: 'dsep' })); continue; }
    const r = document.createElement('div'); r.className = 'dmi' + (it.dis ? ' dis' : '');
    r.innerHTML = `<span class="dck">${it.check ? '✓' : ''}</span><span class="dl"></span><span class="dk"></span>`;
    (r.querySelector('.dl') as HTMLElement).textContent = it.label ?? ''; (r.querySelector('.dk') as HTMLElement).textContent = it.key ?? '';
    r.onclick = () => { if (it.dis) return; closeMenu(); it.act?.(); };
    m.appendChild(r);
  }
  document.body.appendChild(m); openMenu = m;
  const w = m.offsetWidth, hh = m.offsetHeight;
  m.style.left = Math.min(x, innerWidth - w - 4) + 'px'; m.style.top = Math.min(y, innerHeight - hh - 4) + 'px';
}
export function menubar(el: HTMLElement, menus: Record<string, () => MI[]>, cls = '') {
  el.classList.add('mbar');
  for (const [name, items] of Object.entries(menus)) {
    const b = document.createElement('button'); b.textContent = name;
    const open = () => { closeMenu(); b.classList.add('open'); const r = b.getBoundingClientRect(); menu(items(), r.left, r.bottom, cls); };
    b.onclick = () => (b.classList.contains('open') ? closeMenu() : open());
    b.onpointerenter = () => { if (openMenu && !b.classList.contains('open')) open(); };
    el.appendChild(b);
  }
}
/** Tiny modal prompt in the IDE's own style. */
export function ask(title: string, value: string, cls = ''): Promise<string | null> {
  return new Promise(res => {
    const bg = document.createElement('div'); bg.className = 'dmodal ' + cls;
    bg.innerHTML = `<div class="dbox"><div class="dtitle"></div><input spellcheck="false"><div class="dbtns"><button class="ok">OK</button><button class="cancel">Cancel</button></div></div>`;
    (bg.querySelector('.dtitle') as HTMLElement).textContent = title;
    const inp = bg.querySelector('input')!; inp.value = value;
    const done = (v: string | null) => { bg.remove(); res(v); };
    (bg.querySelector('.ok') as HTMLElement).onclick = () => done(inp.value.trim() || null);
    (bg.querySelector('.cancel') as HTMLElement).onclick = () => done(null);
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); };
    document.body.appendChild(bg); inp.focus(); inp.select();
  });
}
export function info(title: string, html: string, cls = '') {
  const bg = document.createElement('div'); bg.className = 'dmodal ' + cls;
  bg.innerHTML = `<div class="dbox wide"><div class="dtitle"></div><div class="dinfo">${html}</div><div class="dbtns"><button class="ok">OK</button></div></div>`;
  (bg.querySelector('.dtitle') as HTMLElement).textContent = title;
  (bg.querySelector('.ok') as HTMLElement).onclick = () => bg.remove();
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
  document.body.appendChild(bg);
}
