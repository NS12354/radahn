export const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll(s)] as T[];
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
export const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export function opts(o: Record<string, string>, v: string) {
  return Object.entries(o).map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

let toastT: any;
export function toast(m: string) {
  const t = $('#toast');
  t.textContent = m; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
}

export function modal(title: string, sub: string, body: string) {
  $('#mTitle').textContent = title; $('#mSub').textContent = sub; $('#mBody').textContent = body;
  $('#modal').classList.add('show');
}
export function closeModal() { $('#modal').classList.remove('show'); }

/** Ask what to do with unsaved changes before closing something. Enter saves, Escape cancels. */
export function askSave(name: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise(res => {
    const d = document.createElement('div'); d.className = 'savedlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    const n = document.createElement('b'); n.textContent = name || 'this project';
    d.innerHTML = `<div class="sdbox"><h2>Save changes?</h2><p>You made changes to <span></span>. Save them before closing?</p>
      <div class="sdacts"><button type="button" class="btn" data-r="discard">Don’t save</button><span class="sdgap"></span><button type="button" class="btn" data-r="cancel">Cancel</button><button type="button" class="btn primary" data-r="save">Save</button></div></div>`;
    d.querySelector('p span')!.replaceWith(n);
    const done = (r: 'save' | 'discard' | 'cancel') => { d.remove(); document.removeEventListener('keydown', key, true); res(r); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); } };
    d.querySelectorAll<HTMLElement>('[data-r]').forEach(b => (b.onclick = () => done(b.dataset.r as any)));
    d.onclick = e => { if (e.target === d) done('cancel'); };
    document.addEventListener('keydown', key, true);
    document.body.appendChild(d);
    d.querySelector<HTMLElement>('[data-r=save]')!.focus();
  });
}

export async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); }
  catch { toast('Copy blocked. Select the text instead.'); }
}

/** Trigger a download. Returns false if the frame forbids downloads. */
export function download(name: string, data: string | Blob, type = 'application/json') {
  try {
    const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return true;
  } catch { return false; }
}

export function b64encode(buf: ArrayBuffer) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(s: string) {
  const bin = atob(s); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}
