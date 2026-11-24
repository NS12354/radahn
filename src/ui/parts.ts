import type { App } from './app';
import { aiFetch } from '../app/access';
import { $, $$, el, esc, toast } from './dom';
import { COMPONENTS } from '../hw/library/components';
import type { RoleDef } from '../hw/types';
import { track } from './track';
import { cardKind, customOf, libraryParts, registerCustom, removeFromLibrary, saveToLibrary, specFromExtraction, type CustomPartSpec } from '../hw/custom';

/**
 * Electronics ▸ "Add from a link": paste a part's page or datasheet, the dev
 * server reads it (server/part-from-url.mjs), you review what it found, and it
 * becomes a wireable part in this project (and optionally your library).
 */
let A: App;
let add: (type: string) => void;
let draft: CustomPartSpec | null = null;
let draftNotes: string[] = [];

const KINDS: Record<RoleDef['kind'], string> = { 'digital-in': 'Digital in', 'digital-out': 'Digital out', pwm: 'PWM out', analog: 'Analog in', 'spi-sck': 'SPI SCK', 'spi-mosi': 'SPI MOSI', 'i2c-sda': 'I2C SDA', 'i2c-scl': 'I2C SCL', data: 'Data out' };
const IFACES = { 'digital-in': 'Digital input', 'digital-out': 'Digital output', pwm: 'PWM output', analog: 'Analog', i2c: 'I2C', spi: 'SPI', uart: 'UART (serial)', ws2812: 'WS2812 data', other: 'Other' };
const SURF = { none: 'Nothing (inside)', button: 'Button cap', knob: 'Knob', pot: 'Pot knob', indicator: 'Indicator lens', display: 'Display window', sound: 'Sound holes', vents: 'Vents (needs air)', wires: 'Wire entry' };
const CATS = { input: 'Input', output: 'Output', display: 'Display', sensor: 'Sensor', actuator: 'Actuator' };
const opts = (o: Record<string, string>, v: string) => Object.entries(o).map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(n)}</option>`).join('');

export function initParts(app: App, addComponent: (type: string) => void) {
  A = app; add = addComponent;
  for (const s of libraryParts()) if (!COMPONENTS[s.id] || customOf(s.id)) registerCustom(s);
  $('#bPartUrl').onclick = () => read();
  ($('#partUrl') as HTMLInputElement).onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') read(); };
  $('#bPartManual').onclick = () => {
    draft = specFromExtraction({ name: 'Custom part', category: 'sensor', interface: 'digital-in', pins: [{ id: 'SIG', kind: 'digital-in' }], rail: '3v3', logicV: 3.3, typicalmA: 1, surface: 'none', confidence: 'high' }, { source: 'manual' }, takenIds());
    draftNotes = []; renderReview();
  };
}

const takenIds = () => new Set([...Object.keys(A.project.electronics.custom ?? {}), ...libraryParts().map(p => p.id)]);

async function read() {
  const url = ($('#partUrl') as HTMLInputElement).value.trim();
  if (!url) { toast('Paste a link first'); return; }
  const box = $('#partReview');
  box.innerHTML = `<div class="busy"><i></i><span>Reading ${esc(new URL(url, location.href).hostname)}… (pages with a datasheet take up to a minute)</span></div>`;
  $('#bPartUrl').setAttribute('disabled', '');
  try {
    const r = await aiFetch(A.base + 'api/part-from-url', { url });
    if (!r) throw new Error('Could not reach the Formframe dev server. Reading links needs `npm run dev`.');
    if (r.status === 404) throw new Error('This build has no server, so it can’t read links. Run `npm run dev`, or define the part by hand.');
    const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error ?? `Server error ${r.status}`);
    draft = specFromExtraction(j.part, { url: j.url, datasheet: j.datasheet, source: j.source }, takenIds());
    draftNotes = j.notes ?? [];
    renderReview();
  } catch (e: any) {
    box.innerHTML = `<div class="err">${esc(e.message)}</div><div class="acts"><button class="btn" id="prManual">Define it by hand</button></div>`;
    $('#prManual').onclick = () => $('#bPartManual').click();
  } finally { $('#bPartUrl').removeAttribute('disabled'); }
}

function renderReview() {
  const s = draft, box = $('#partReview');
  if (!s) { box.innerHTML = ''; return; }
  const src = s.source === 'claude' ? 'Read by Claude' : s.source === 'heuristic' ? 'Rough guess (no AI)' : 'Defined by hand';
  const conf = s.source === 'manual' ? '' : `<span class="conf ${s.confidence ?? 'low'}" title="How sure the reader is">${s.confidence ?? 'low'} confidence</span>`;
  box.innerHTML = `
    <div class="ph"><b>${esc(s.name)}</b>${conf}</div>
    <div class="note" style="margin:0 0 6px">${esc(src)}${s.url ? ` · <a class="lnk" href="${esc(s.url)}" target="_blank" rel="noopener">page</a>` : ''}${s.datasheet ? ` · <a class="lnk" href="${esc(s.datasheet)}" target="_blank" rel="noopener">datasheet</a>` : ''}</div>
    ${draftNotes.map(n => `<div class="note" style="color:var(--warn);margin:0 0 4px">${esc(n)}</div>`).join('')}
    ${s.summary ? `<div style="color:var(--text2);line-height:1.45;margin-bottom:4px">${esc(s.summary)}</div>` : ''}
    <div class="row"><label>Name</label><input type="text" data-f="name" value="${esc(s.name)}"></div>
    <div class="row"><label>Type</label><select data-f="category">${opts(CATS, s.category)}</select></div>
    <div class="row"><label>Interface</label><select data-f="interface">${opts(IFACES, s.interface)}</select></div>
    <h5>Pins to wire <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--faint)">(not VCC/GND)</span></h5>
    <div id="prPins">${s.roles.map((r, i) => `<div class="prow" title="${esc(r.description ?? '')}"><input type="text" data-p="${i}" value="${esc(r.id)}" maxlength="6"><select data-k="${i}">${opts(KINDS, r.kind)}</select><button data-x="${i}" title="Remove pin">✕</button></div>`).join('')}</div>
    <a class="lnk" id="prAddPin" style="font-size:11px">+ add pin</a>
    <h5>Power</h5>
    <div class="row"><label>Rail</label><select data-f="rail">${opts({ '3v3': '3.3 V rail', '5v': '5 V rail', '': 'GPIO / own supply' }, s.rail ?? '')}</select></div>
    <div class="row"><label>Logic</label><select data-f="logic">${opts({ '3.3': '3.3 V', '5': '5 V', '': 'Unknown' }, s.logic ? String(s.logic) : '')}</select></div>
    <div class="row"><label>Current</label><input type="number" data-f="mA" value="${s.mA}" min="0" step="0.1" title="Typical mA"><input type="number" data-f="peakmA" value="${s.peakmA ?? ''}" min="0" step="1" placeholder="peak" title="Peak mA"></div>
    ${s.interface === 'i2c' ? `<div class="row"><label>I2C addr</label><input type="text" data-f="i2c" value="${s.i2cAddress != null ? '0x' + s.i2cAddress.toString(16) : ''}" placeholder="0x76"></div>` : ''}
    <h5>Build</h5>
    <div class="row"><label>Size mm</label><input type="number" data-sz="w" value="${s.size?.w ?? ''}" placeholder="W" step="0.1"><input type="number" data-sz="h" value="${s.size?.h ?? ''}" placeholder="H" step="0.1"><input type="number" data-sz="d" value="${s.size?.d ?? ''}" placeholder="D" step="0.1"></div>
    <div class="row"><label>On case</label><select data-f="surface">${opts(SURF, s.surface)}</select></div>
    <div class="row"><label>Price $</label><input type="number" data-f="cost" value="${s.cost}" min="0" step="0.01"></div>
    ${s.requirements.length ? `<h5>Requirements</h5><ul>${s.requirements.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${s.uses.length ? `<h5>Typical uses</h5><ul>${s.uses.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${s.missing?.length ? `<h5>Not found</h5><ul style="color:var(--faint)">${s.missing.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <div class="note" style="margin-top:6px">Bench: ${({ button: 'push button (drives its input)', pot: 'slider (sets its analog voltage)', led: 'activity light (shows its output duty)', generic: 'bus monitor (answers on its bus, counts traffic)' })[cardKind(s)]}</div>
    <label class="keep"><input type="checkbox" id="prLib" checked> Also save to my parts library</label>
    <div class="acts"><button class="btn" id="prCancel">Cancel</button><button class="btn primary" id="prAdd">Add to project</button></div>`;
  box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach(i => (i.onchange = () => {
    const f = i.dataset.f!, v = i.value;
    if (f === 'name') s.name = v.trim() || s.name;
    else if (f === 'category') s.category = v as any;
    else if (f === 'interface') { s.interface = v as any; if (v === 'i2c' && !s.roles.some(r => r.kind === 'i2c-sda')) s.roles = [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }]; }
    else if (f === 'rail') s.rail = (v || null) as any;
    else if (f === 'logic') s.logic = v ? (+v as 3.3 | 5) : null;
    else if (f === 'mA') s.mA = Math.max(0, +v || 0);
    else if (f === 'peakmA') s.peakmA = v ? Math.max(0, +v) : null;
    else if (f === 'i2c') { const n = parseInt(v, 16); s.i2cAddress = isFinite(n) && n >= 3 && n <= 0x77 ? n : null; }
    else if (f === 'surface') s.surface = v as any;
    else if (f === 'cost') s.cost = Math.max(0, +v || 0);
    renderReview();
  }));
  box.querySelectorAll<HTMLInputElement>('[data-sz]').forEach(i => (i.onchange = () => {
    const z = s.size ?? { w: 20, h: 15, d: 4 }; (z as any)[i.dataset.sz!] = Math.max(0.5, +i.value || 0.5); s.size = z;
  }));
  box.querySelectorAll<HTMLInputElement>('[data-p]').forEach(i => (i.onchange = () => { s.roles[+i.dataset.p!].id = i.value.toUpperCase().replace(/[^A-Z0-9_+-]/g, '').slice(0, 6) || 'IO'; renderReview(); }));
  box.querySelectorAll<HTMLSelectElement>('[data-k]').forEach(i => (i.onchange = () => { s.roles[+i.dataset.k!].kind = i.value as any; renderReview(); }));
  box.querySelectorAll<HTMLButtonElement>('[data-x]').forEach(b => (b.onclick = () => { if (s.roles.length > 1) { s.roles.splice(+b.dataset.x!, 1); renderReview(); } }));
  $('#prAddPin').onclick = () => { s.roles.push({ id: 'IO' + (s.roles.length + 1), kind: 'digital-in' }); renderReview(); };
  box.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => e.stopPropagation()));
  $('#prCancel').onclick = () => { draft = null; renderReview(); };
  $('#prAdd').onclick = () => {
    const ids = s.roles.map(r => r.id);
    if (new Set(ids).size !== ids.length) { toast('Two pins have the same label'); return; }
    const e = A.project.electronics;
    (e.custom ??= {})[s.id] = s;
    registerCustom(s);
    if (($('#prLib') as HTMLInputElement).checked) saveToLibrary(s);
    track('part', `Imported the ${s.name}${s.url ? ' from a link' : ''}`);
    draft = null; renderReview(); ($('#partUrl') as HTMLInputElement).value = '';
    add(s.id);
  };
}

/** Show only the parts whose name, id or notes match; hide empty sections. */
function filterLib(q: string) {
  const words = q.toLowerCase().split(' ').filter(Boolean);
  let head: HTMLElement | null = null, shown = 0;
  const flush = () => { if (head) head.style.display = shown ? '' : 'none'; };
  for (const n of Array.from($('#libList').children) as HTMLElement[]) {
    if (n.tagName === 'H4') { flush(); head = n; shown = 0; continue; }
    const hay = (n.textContent + ' ' + (n.dataset.t ?? '') + ' ' + (n.title ?? '')).toLowerCase();
    const ok = words.every(w => hay.includes(w));
    n.style.display = ok ? '' : 'none';
    if (ok) shown++;
  }
  flush();
}

/** The "Add component" list: built-in parts, then parts from this project and your library. */
export function renderLib() {
  const builtIn = Object.values(COMPONENTS).filter(d => !(d as any).custom);
  const mine = new Map<string, CustomPartSpec>();
  for (const s of Object.values(A.project.electronics.custom ?? {})) mine.set(s.id, s);
  for (const s of libraryParts()) if (!mine.has(s.id)) mine.set(s.id, s);
  const lib = $('#libList'); lib.innerHTML = '';
  const GROUPS: [string, string][] = [['input', 'Buttons, switches & knobs'], ['sensor', 'Sensors'], ['display', 'Displays'], ['output', 'Lights & sound'], ['actuator', 'Motors, relays & power'], ['robotics', 'Robotics']];
  for (const [cat, title] of GROUPS) {
    const ls = builtIn.filter(l => (l.group ?? l.category) === cat);
    if (!ls.length) continue;
    lib.appendChild(el('h4', 'libh', `${esc(title)} <span>${ls.length}</span>`));
    for (const l of ls) { const b = btn(l.id, `${esc(l.name)}<span>$${l.cost.toFixed(2)}${l.binds ? ' · ⇄ ' + l.bindLabel : ''}</span>`, ''); if (l.note) b.title = l.note; lib.appendChild(b); }
  }
  if (!document.getElementById('libFind')) {
    const f = el('input', 'libfind') as HTMLInputElement; f.id = 'libFind'; f.type = 'search'; f.placeholder = `Search ${builtIn.length} parts…`;
    f.oninput = () => filterLib(f.value);
    lib.parentElement!.insertBefore(f, lib);
  }
  if (mine.size) lib.appendChild(el('h4', 'libh', `Imported <span>${mine.size}</span>`));
  for (const s of mine.values()) {
    const inLib = libraryParts().some(p => p.id === s.id);
    const b = btn(s.id, `${inLib ? '<span class="rm" title="Remove from my library">✕</span>' : ''}${esc(s.name)}<span>$${s.cost.toFixed(2)} · ${esc(s.interface)}${s.url ? ' · ↗' : ''}</span>`, 'cust');
    b.title = `${s.summary}${s.requirements.length ? '\n\nNeeds: ' + s.requirements.join('; ') : ''}`;
    lib.appendChild(b);
  }
  $('#linkNote').textContent = mine.size ? `${mine.size} imported` : '';
  filterLib((document.getElementById('libFind') as HTMLInputElement | null)?.value ?? '');
  function btn(id: string, html: string, cls: string) {
    const b = el('button', cls, html); b.dataset.t = id;
    b.onclick = e => {
      if ((e.target as HTMLElement).closest('.rm')) { e.stopPropagation(); removeFromLibrary(id); renderLib(); toast('Removed from your library (projects that use it keep it)'); return; }
      const s = mine.get(id);
      if (s) { (A.project.electronics.custom ??= {})[id] = s; registerCustom(s); }
      add(id);
    };
    return b;
  }
  void $$;
}
