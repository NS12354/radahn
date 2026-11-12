/**
 * Blender-style widgets for the modeler window: menus (with submenus and
 * shortcut hints), pie menus, drag-or-type number fields, collapsible panels
 * and a small SVG icon set.
 */
export const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e;
}
export const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Shortcut label, Blender style: Ctrl on every platform except macOS (⌘). */
export const kc = (s: string) => isMac ? s.replace(/Ctrl/g, '⌘').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧') : s;

// ------------------------------------------------------------------ icons
const P = (d: string, extra = '') => `<svg viewBox="0 0 16 16" class="ic" ${extra}>${d}</svg>`;
export const ICON: Record<string, string> = {
  select: P('<rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-dasharray="2 1.5"/><path d="M6 6l6 2.5-2.6.9L8.5 12z" fill="currentColor"/>'),
  cursor: P('<circle cx="8" cy="8" r="4.5" fill="none" stroke="#ff4d4d" stroke-width="1.6" stroke-dasharray="2.4 2.4"/><circle cx="8" cy="8" r="4.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="2.4 2.4" stroke-dashoffset="2.4"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4" stroke="currentColor"/>'),
  move: P('<path d="M8 1l2.2 2.6H8.8v3.6h3.6V5.8L15 8l-2.6 2.2V8.8H8.8v3.6h1.4L8 15l-2.2-2.6h1.4V8.8H3.6v1.4L1 8l2.6-2.2v1.4h3.6V3.6H5.8z" fill="currentColor"/>'),
  rotate: P('<path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.6 1.6v4h-4z" fill="currentColor"/>'),
  scale: P('<rect x="1.5" y="8.5" width="6" height="6" fill="none" stroke="currentColor"/><path d="M7 9l6.5-6.5M9.5 2.5h4v4" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
  transform: P('<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor"/><path d="M8 1v14M1 8h14" stroke="currentColor"/><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor"/>'),
  view3d: P('<path d="M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7z" fill="none" stroke="currentColor"/><path d="M2.5 4.5L8 7.5l5.5-3M8 7.5v7" fill="none" stroke="currentColor"/>'),
  outliner: P('<path d="M2 3h12M5 7h9M5 11h9M2 3v8h3" fill="none" stroke="currentColor"/>'),
  props: P('<rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor"/><path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor"/>'),
  info: P('<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><path d="M8 7v5M8 4.5v.8" stroke="currentColor" stroke-width="1.6"/>'),
  collection: P('<rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="#e6e6e6"/><path d="M2 6h12" stroke="#e6e6e6"/>'),
  scene: P('<path d="M3 13l3-7 3 7z" fill="#9ba8b9"/><circle cx="11" cy="9" r="3" fill="#c8c8c8"/>'),
  object: P('<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="none" stroke="#ffaf29" stroke-width="1.6"/>'),
  mesh: P('<path d="M8 2l6 11H2z" fill="none" stroke="#ffaf29" stroke-width="1.4"/><circle cx="8" cy="2.5" r="1.3" fill="#ffaf29"/><circle cx="2.5" cy="12.7" r="1.3" fill="#ffaf29"/><circle cx="13.5" cy="12.7" r="1.3" fill="#ffaf29"/>'),
  data: P('<path d="M8 2l6 11H2z" fill="#61c45a"/>'),
  modifier: P('<path d="M10.5 1.8a3.3 3.3 0 0 0-3.9 4.4L2 10.8 5.2 14l4.6-4.6a3.3 3.3 0 0 0 4.4-3.9l-2 2-2.2-.6-.6-2.2z" fill="#6aa2ff"/>'),
  material: P('<circle cx="8" cy="8" r="6" fill="#e05757"/><circle cx="6" cy="6" r="2" fill="#f29b9b"/>'),
  eye: P('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor"/><circle cx="8" cy="8" r="2" fill="currentColor"/>'),
  eyeOff: P('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" opacity=".4"/><path d="M2.5 13.5l11-11" stroke="currentColor"/>'),
  wire: P('<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><ellipse cx="8" cy="8" rx="2.6" ry="6" fill="none" stroke="currentColor"/><path d="M2 8h12" stroke="currentColor"/>'),
  solid: P('<circle cx="8" cy="8" r="6" fill="currentColor"/>'),
  matprev: P('<circle cx="8" cy="8" r="6" fill="currentColor" opacity=".55"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/><circle cx="5.5" cy="5.5" r="1.6" fill="#fff" opacity=".7"/>'),
  rendered: P('<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>'),
  xray: P('<rect x="2" y="2" width="8" height="8" fill="currentColor" opacity=".45"/><rect x="6" y="6" width="8" height="8" fill="none" stroke="currentColor"/>'),
  overlay: P('<circle cx="6" cy="8" r="4.5" fill="none" stroke="currentColor"/><circle cx="10" cy="8" r="4.5" fill="none" stroke="currentColor"/>'),
  magnet: P('<path d="M3 2v6a5 5 0 0 0 10 0V2h-3v6a2 2 0 0 1-4 0V2z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 4h3M10 4h3" stroke="currentColor" stroke-width="1.3"/>'),
  hand: P('<path d="M5 8V3.5a1 1 0 0 1 2 0V7M7 7V2.5a1 1 0 0 1 2 0V7M9 7V3.5a1 1 0 0 1 2 0V8.5M11 6a1 1 0 0 1 2 0v3.5c0 3-2 5-4.5 5S4.5 13 3.5 11L2.3 8.8a1 1 0 0 1 1.7-1L5 9" fill="none" stroke="currentColor" stroke-linejoin="round"/>'),
  zoom: P('<circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 10l4.5 4.5M4.5 6.5h4M6.5 4.5v4" stroke="currentColor" stroke-width="1.4"/>'),
  ortho: P('<path d="M2 5h12M2 8h12M2 11h12M5 2v12M8 2v12M11 2v12" stroke="currentColor" stroke-width=".9"/>'),
  persp: P('<path d="M1 13h14M3 10.5h10M5 8.5h6M8 4v9M4.5 13l2-8.5M11.5 13l-2-8.5" stroke="currentColor" stroke-width=".9" fill="none"/>'),
  wrench: P('<path d="M10.5 1.8a3.3 3.3 0 0 0-3.9 4.4L2 10.8 5.2 14l4.6-4.6a3.3 3.3 0 0 0 4.4-3.9l-2 2-2.2-.6-.6-2.2z" fill="currentColor"/>'),
  auto: P('<path d="M8 1l1.6 3.4L13 6l-3.4 1.6L8 11 6.4 7.6 3 6l3.4-1.6z M12.5 10l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z" fill="currentColor"/>'),
  x: P('<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5"/>'),
  vsel: P('<path d="M3 13L8 3l5 10z" fill="none" stroke="currentColor" opacity=".6"/><circle cx="8" cy="3.5" r="2.2" fill="currentColor"/>'),
  esel: P('<path d="M3 13L8 3l5 10z" fill="none" stroke="currentColor" opacity=".45"/><path d="M3 13L8 3" stroke="currentColor" stroke-width="2.4"/>'),
  fsel: P('<path d="M3 13L8 3l5 10z" fill="currentColor" opacity=".85"/>'),
  logo: `<svg viewBox="0 0 16 16" class="ic"><defs><linearGradient id="lg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#4f7cff"/><stop offset=".55" stop-color="#ff7a2f"/><stop offset="1" stop-color="#33c27f"/></linearGradient></defs><rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="url(#lg)"/></svg>`,
};

// ------------------------------------------------------------------ menus
export interface MenuItem {
  label?: string; shortcut?: string; icon?: string; action?: () => void; sub?: MenuItem[] | (() => MenuItem[]);
  checked?: boolean; disabled?: boolean; sep?: boolean; title?: string; hint?: string;
}
let layer: HTMLElement;
let openRoot: HTMLElement | null = null;
let onCloseCb: (() => void) | null = null;
export function initMenus() {
  layer = $('#menuLayer');
  document.addEventListener('pointerdown', e => { if (openRoot && !(e.target as HTMLElement).closest('.bmenu, .pie, .menubar button')) closeMenus(); }, true);
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && (openRoot || layer.childElementCount)) { e.stopPropagation(); e.preventDefault(); closeMenus(); } }, true);
  window.addEventListener('blur', () => closeMenus());
}
export function closeMenus() { layer.innerHTML = ''; openRoot = null; $$('.menubar button.open').forEach(b => b.classList.remove('open')); const cb = onCloseCb; onCloseCb = null; cb?.(); }
export const menuOpen = () => !!layer?.childElementCount;

function build(items: MenuItem[], title?: string): HTMLElement {
  const m = h('div', 'bmenu');
  if (title) m.appendChild(h('div', 'mtitle', esc(title)));
  for (const it of items) {
    if (it.sep) { m.appendChild(h('div', 'msep')); continue; }
    if (it.title) { m.appendChild(h('div', 'mhead', esc(it.title))); continue; }
    const row = h('div', 'mi' + (it.disabled ? ' dis' : '') + (it.sub ? ' hasub' : ''));
    row.innerHTML = `<span class="mic">${it.checked != null ? (it.checked ? '<span class="chk on"></span>' : '<span class="chk"></span>') : it.icon ? ICON[it.icon] ?? '' : ''}</span><span class="ml">${esc(it.label ?? '')}</span><span class="ms">${it.sub ? '▸' : esc(it.shortcut ? kc(it.shortcut) : '')}</span>`;
    if (it.hint) row.title = it.hint;
    row.onpointerenter = () => {
      $$('.mi.subopen', m).forEach(r => r.classList.remove('subopen'));
      // close deeper menus
      let n = m.nextElementSibling; while (n) { const x = n.nextElementSibling; n.remove(); n = x; }
      if (it.sub && !it.disabled) {
        row.classList.add('subopen');
        const sub = build(typeof it.sub === 'function' ? it.sub() : it.sub);
        layer.appendChild(sub);
        const r = row.getBoundingClientRect();
        place(sub, r.right - 2, r.top - 4, r.left);
      }
    };
    row.onclick = e => { e.stopPropagation(); if (it.disabled || it.sub) return; closeMenus(); it.action?.(); };
    m.appendChild(row);
  }
  return m;
}
function place(m: HTMLElement, x: number, y: number, flipX?: number) {
  m.style.left = '0px'; m.style.top = '0px';
  const w = m.offsetWidth, hh = m.offsetHeight;
  if (x + w > innerWidth - 4) x = flipX != null ? flipX - w + 2 : innerWidth - w - 4;
  if (y + hh > innerHeight - 4) y = Math.max(4, innerHeight - hh - 4);
  m.style.left = Math.max(4, x) + 'px'; m.style.top = Math.max(4, y) + 'px';
}
/** Open a popup menu at a point (e.g. Shift+A at the mouse). */
export function popup(items: MenuItem[], x: number, y: number, title?: string, onClose?: () => void) {
  closeMenus();
  const m = build(items, title); layer.appendChild(m); openRoot = m; onCloseCb = onClose ?? null;
  place(m, x - 20, y - 14);
}
/** Header menubar: click opens, hovering siblings while open switches menus. */
export function menubar(el: HTMLElement, menus: Record<string, () => MenuItem[]>) {
  el.classList.add('menubar');
  for (const [name, items] of Object.entries(menus)) {
    const b = h('button', '', esc(name));
    const open = () => {
      closeMenus(); b.classList.add('open');
      const m = build(items()); layer.appendChild(m); openRoot = m;
      const r = b.getBoundingClientRect(); place(m, r.left, r.bottom + 1);
    };
    b.onclick = e => { e.stopPropagation(); if (b.classList.contains('open')) closeMenus(); else open(); };
    b.onpointerenter = () => { if (openRoot && !b.classList.contains('open') && $$('.menubar button.open').length) open(); };
    el.appendChild(b);
  }
}

// ------------------------------------------------------------------ pie menus
export interface PieItem { label: string; icon?: string; action: () => void }
/** Blender pie: items go W, E, S, N, NW, NE, SW, SE. Click an item, or move toward it and release the key. */
export function pie(items: PieItem[], x: number, y: number, key?: string) {
  closeMenus();
  const ang = [180, 0, 270, 90, 135, 45, 225, 315];
  const p = h('div', 'pie'); p.style.left = x + 'px'; p.style.top = y + 'px';
  p.innerHTML = '<div class="pc"></div><div class="pdir"></div>';
  const btns = items.map((it, i) => {
    const a = ang[i] * Math.PI / 180, R = 110;
    const b = h('button', 'pi', `${it.icon ? ICON[it.icon] ?? '' : ''}<span>${esc(it.label)}</span>`);
    b.style.left = Math.cos(a) * R + 'px'; b.style.top = -Math.sin(a) * R * 0.8 + 'px';
    b.onclick = e => { e.stopPropagation(); closeMenus(); it.action(); };
    p.appendChild(b); return { b, a };
  });
  layer.appendChild(p); openRoot = p;
  let hot = -1;
  const mv = (e: PointerEvent) => {
    const dx = e.clientX - x, dy = y - e.clientY, d = Math.hypot(dx, dy);
    hot = -1;
    if (d > 30) { const a = Math.atan2(dy, dx); let best = 9; btns.forEach((t, i) => { let diff = Math.abs(a - t.a); diff = Math.min(diff, Math.PI * 2 - diff); if (diff < best) { best = diff; hot = i; } }); }
    btns.forEach((t, i) => t.b.classList.toggle('hot', i === hot));
    ($('.pdir', p) as HTMLElement).style.transform = `rotate(${-Math.atan2(dy, dx)}rad)`; ($('.pdir', p) as HTMLElement).style.opacity = d > 30 ? '1' : '0';
  };
  const up = (e: KeyboardEvent) => { if (key && e.key.toLowerCase() === key && hot >= 0) { const it = items[hot]; closeMenus(); it.action(); } };
  window.addEventListener('pointermove', mv);
  window.addEventListener('keyup', up);
  onCloseCb = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('keyup', up); };
}

// ------------------------------------------------------------------ number field
export interface NumOpts { label?: string; get: () => number; set: (v: number, final: boolean) => void; step?: number; unit?: string; min?: number; max?: number; prec?: number; dragScale?: number }
/** Blender number field: drag left/right to change, click to type (simple maths allowed), arrows step it. */
export function bnum(o: NumOpts): HTMLElement {
  const step = o.step ?? 1, prec = o.prec ?? (step < 0.1 ? 3 : step < 1 ? 2 : 1);
  const el = h('div', 'bnum');
  el.innerHTML = `<span class="arr l">‹</span>${o.label ? `<span class="nl">${esc(o.label)}</span>` : ''}<span class="nv"></span><span class="arr r">›</span>`;
  const clamp = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  const fmt = (v: number) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(prec)) + (o.unit ? ' ' + o.unit : '');
  const show = () => { ($('.nv', el) as HTMLElement).textContent = fmt(o.get()); };
  show();
  (el as any).refresh = show;
  let sx = 0, start = 0, moved = false, dragging = false;
  el.onpointerdown = e => {
    if ((e.target as HTMLElement).closest('input')) return;
    if (e.button !== 0) return;
    const arr = (e.target as HTMLElement).closest('.arr');
    if (arr) { e.preventDefault(); const v = clamp(o.get() + (arr.classList.contains('l') ? -step : step)); o.set(v, true); show(); return; }
    e.preventDefault(); sx = e.clientX; start = o.get(); moved = false; dragging = true; el.setPointerCapture(e.pointerId);
  };
  el.onpointermove = e => {
    if (!dragging) return;
    const dx = e.clientX - sx;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true; el.classList.add('drag');
    let v = start + dx * step * (o.dragScale ?? 0.25) * (e.shiftKey ? 0.1 : 1);
    if (e.ctrlKey || e.metaKey) v = Math.round(v / (step * 10)) * step * 10;
    o.set(clamp(v), false); show();
  };
  el.onpointerup = e => {
    if (!dragging) return; dragging = false; el.classList.remove('drag');
    try { el.releasePointerCapture(e.pointerId); } catch { }
    if (moved) { o.set(clamp(o.get()), true); show(); return; }
    // click: type a value
    const inp = h('input', 'ninput') as HTMLInputElement; inp.value = String(+o.get().toFixed(prec + 1));
    el.classList.add('edit'); el.appendChild(inp); inp.focus(); inp.select();
    const done = (ok: boolean) => {
      if (!inp.isConnected) return;
      const txt = inp.value.replace(/mm|°|deg/g, '').trim();
      inp.remove(); el.classList.remove('edit');
      if (ok && /^[-+*/().\d\s]+$/.test(txt)) { try { const v = Function(`"use strict";return (${txt})`)(); if (isFinite(v)) o.set(clamp(+v), true); } catch { } }
      show();
    };
    inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  };
  return el;
}

/** A labelled column of number fields (Location X/Y/Z…). */
export function bvec(label: string, fields: NumOpts[]) {
  const row = h('div', 'brow vec');
  row.appendChild(h('label', 'bl', esc(label)));
  const col = h('div', 'bcol'); fields.forEach(f => col.appendChild(bnum(f))); row.appendChild(col);
  return row;
}

/** Collapsible Blender panel. */
const collapsed = new Set<string>(JSON.parse((() => { try { return localStorage.getItem('ffm.collapsed') ?? '[]'; } catch { return '[]'; } })()));
export function panel(id: string, title: string, body: (el: HTMLElement) => void, extraHead = '') {
  const p = h('div', 'bpanel' + (collapsed.has(id) ? ' shut' : ''));
  const hd = h('div', 'bph', `<span class="tri">▾</span><span>${esc(title)}</span>${extraHead}`);
  hd.onclick = e => {
    if ((e.target as HTMLElement).closest('button, select, input')) return;
    p.classList.toggle('shut'); if (p.classList.contains('shut')) collapsed.add(id); else collapsed.delete(id);
    try { localStorage.setItem('ffm.collapsed', JSON.stringify([...collapsed])); } catch { }
  };
  const b = h('div', 'bpb'); body(b);
  p.append(hd, b); return p;
}
export function brow(label: string, ctrl: HTMLElement | string) {
  const r = h('div', 'brow'); r.appendChild(h('label', 'bl', esc(label)));
  if (typeof ctrl === 'string') r.insertAdjacentHTML('beforeend', ctrl); else r.appendChild(ctrl);
  return r;
}
export function bselect(opts: Record<string, string>, value: string, onChange: (v: string) => void) {
  const s = h('select', 'bsel') as HTMLSelectElement;
  s.innerHTML = Object.entries(opts).map(([k, v]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${esc(v)}</option>`).join('');
  s.onchange = () => onChange(s.value);
  s.onkeydown = e => e.stopPropagation();
  return s;
}
export function bcheck(label: string, value: boolean, onChange: (v: boolean) => void) {
  const l = h('label', 'bchk', `<input type="checkbox" ${value ? 'checked' : ''}><span class="box"></span><span>${esc(label)}</span>`);
  (l.querySelector('input') as HTMLInputElement).onchange = e => onChange((e.target as HTMLInputElement).checked);
  return l;
}
export function btext(value: string, onChange: (v: string) => void, placeholder = '') {
  const i = h('input', 'btext') as HTMLInputElement; i.value = value; i.placeholder = placeholder; i.spellcheck = false;
  i.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') i.blur(); };
  i.onchange = () => onChange(i.value);
  return i;
}
