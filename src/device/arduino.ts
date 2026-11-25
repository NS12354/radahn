import { CodeEditor, langOf } from './editor';
import { state, send, on, lineBuffer } from './client';
import { Workspace, menubar, menu, ask, info } from './workspace';
import { explainCompile } from '../app/explain';

/**
 * Arduino IDE 2-style environment for AVR boards. Verify compiles, Upload
 * compiles and runs on the studio's emulated ATmega328P; the Serial Monitor
 * and Serial Plotter read its UART.
 */
const I = {
  verify: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  debug: '<svg viewBox="0 0 24 24"><path d="M8 6l10 6-10 6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12h3" stroke="currentColor" stroke-width="2"/></svg>',
  plotter: '<svg viewBox="0 0 24 24"><path d="M3 18l5-6 4 3 7-9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 21h18" stroke="currentColor" stroke-width="1.6"/></svg>',
  monitor: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M8 10.5h5M10.5 8v5" stroke="currentColor" stroke-width="1.4"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  boards: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 3v3M12 3v3M16 3v3M8 18v3M12 18v3M16 18v3" stroke="currentColor" stroke-width="1.5"/></svg>',
  libs: '<svg viewBox="0 0 24 24"><path d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5-1 3 15.5-3.5 1z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  bug: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="13" rx="5" ry="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v12M7 10L4 8.5M17 10l3-1.5M7 14H4M17 14h3M8 18l-2.5 2M16 18l2.5 2" stroke="currentColor" stroke-width="1.5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  usb: '<svg viewBox="0 0 24 24"><path d="M12 3v14M12 3l-2.5 3h5zM8 9v3l4 2M16 8v2l-4 2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  scroll: '<svg viewBox="0 0 24 24"><path d="M12 4v14M6 12l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.7" fill="none"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20h4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

export function mountArduino(root: HTMLElement, ws: Workspace) {
  const b = state!.board, port = '/dev/cu.usbmodem-virtual';
  const sketch = Object.keys(state!.files).find(n => n.endsWith('.ino'))?.replace(/\.ino$/, '') ?? 'sketch';
  document.title = `${sketch} | Arduino IDE (Formframe)`;
  root.classList.add('ard');
  root.innerHTML = `
    <div class="amenu"></div>
    <div class="atop">
      <button class="around" data-a="verify" title="Verify">${I.verify}</button>
      <button class="around" data-a="upload" title="Upload">${I.upload}</button>
      <button class="around ghost" disabled title="Start Debugging (not supported on this board)">${I.debug}</button>
      <button class="aboard">${I.usb}<span>${esc(b.name)}</span><i>▾</i></button>
      <span class="sp"></span>
      <button class="aicon" data-a="plotter" title="Serial Plotter">${I.plotter}</button>
      <button class="aicon" data-a="monitor" title="Serial Monitor">${I.monitor}</button>
    </div>
    <div class="abody">
      <div class="aside">
        <button data-p="book" title="Sketchbook">${I.book}</button><button data-p="boards" title="Boards Manager">${I.boards}</button>
        <button data-p="libs" title="Library Manager">${I.libs}</button><button data-p="debug" title="Debug">${I.bug}</button><button data-p="search" title="Search">${I.search}</button>
      </div>
      <div class="apanel"></div>
      <div class="acenter">
        <div class="atabs"></div>
        <div class="aedit"></div>
        <div class="asplit"></div>
        <div class="abottom">
          <div class="abtabs"><button data-b="output" class="on">Output</button><button data-b="monitor">Serial Monitor</button><button data-b="plotter">Serial Plotter</button><span class="sp"></span><span class="abtools"></span></div>
          <div class="abview" data-v="output"><pre class="aout"></pre></div>
          <div class="abview" data-v="monitor" hidden>
            <div class="amsg"><input placeholder="Message (Enter to send message to '${esc(b.name)}' on '${port}')"><select class="aend"><option value="">No Line Ending</option><option value="\n" selected>New Line</option><option value="\r">Carriage Return</option><option value="\r\n">Both NL &amp; CR</option></select><select class="abaud">${[300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400].map(r => `<option ${r === 9600 ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
            <div class="awarn" hidden></div>
            <pre class="amon"></pre>
          </div>
          <div class="abview" data-v="plotter" hidden><div class="aleg"></div><canvas class="aplot"></canvas></div>
        </div>
      </div>
    </div>
    <div class="astatus"><span class="alc"></span><span>UTF-8</span><span class="sp"></span><span class="aport"></span><button class="abell" title="Notifications">${I.bell}</button></div>
    <div class="atoast" hidden></div>`;
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const ed = new CodeEditor('ard-ed'); $('.aedit').appendChild(ed.el);
  ed.onChange = v => { if (ws.active) ws.edit(ws.active, v); };
  ed.onCursor = (l, c) => { $('.alc').textContent = `Ln ${l}, Col ${c}`; };

  // ---------------------------------------------------------------- output / monitor / plotter
  const outEl = $('.aout'), mon = $('.amon');
  let autoscroll = true, stamps = false, phase: 'idle' | 'verify' | 'upload' = 'idle';
  const output = (t: string, cls = '') => { const s = document.createElement('span'); s.className = cls; s.textContent = t + '\n'; outEl.appendChild(s); outEl.scrollTop = outEl.scrollHeight; };
  const tab = (v: string) => { root.querySelectorAll<HTMLElement>('.abtabs [data-b]').forEach(x => x.classList.toggle('on', x.dataset.b === v)); root.querySelectorAll<HTMLElement>('.abview').forEach(x => (x.hidden = x.dataset.v !== v)); paintTools(v); if (v === 'plotter') plot(); };
  const sketchBaud = () => +(Object.values(ws.files()).join('\n').match(/Serial\.begin\s*\(\s*(\d+)/)?.[1] ?? 0);
  const garble = (t: string) => t.replace(/[^\s]/g, () => String.fromCharCode([0xfffd, 0xe0, 0xf8, 0x2593, 0x3f, 0xa7][Math.random() * 6 | 0]));
  const series = new Map<string, number[]>();
  const monLine = (t: string) => {
    const want = sketchBaud(), have = +($('.abaud') as HTMLSelectElement).value, bad = want && want !== have;
    const w = $('.awarn'); w.hidden = !bad; if (bad) w.textContent = `The sketch calls Serial.begin(${want}), but the monitor is set to ${have} baud. Pick ${want} in the menu above to read it.`;
    const shown = bad ? garble(t) : t;
    mon.append((stamps ? new Date().toTimeString().slice(0, 8) + '.' + String(Date.now() % 1000).padStart(3, '0') + ' -> ' : '') + shown + '\n');
    while (mon.childNodes.length > 1500) mon.firstChild!.remove();
    if (autoscroll) mon.scrollTop = mon.scrollHeight;
    if (!bad) { // Serial Plotter: numbers, or label:value pairs, separated by spaces, commas or tabs
      const parts = t.trim().split(/[\s,\t]+/).filter(Boolean); let i = 0;
      for (const p of parts) { const m = p.match(/^(?:([\w.]+):)?(-?\d+(?:\.\d+)?)$/); if (!m) continue; const k = m[1] ?? `value ${++i}`; const a = series.get(k) ?? series.set(k, []).get(k)!; a.push(+m[2]); if (a.length > 50) a.shift(); }
      if (!root.querySelector<HTMLElement>('[data-v=plotter]')!.hidden) plot();
    }
  };
  const feed = lineBuffer(t => monLine(t));
  const offOut = on('out', m => {
    if (!m.cls) return feed(m.text);
    if (/^───/.test(m.text)) return;
    if (m.text === 'Stopped.') { output('Disconnected from ' + port, 'dim'); return; }
    if (m.cls === 'e' || m.cls === 'w') output(m.text, m.cls === 'e' ? 'err' : 'warn');
  });
  const offCompile = on('compile', m => {
    if (m.ok === null) { output(m.text, 'dim'); return; }
    if (m.ok) { output(m.text.trim(), ''); if (phase === 'verify') { toast('Done compiling.'); phase = 'idle'; } else if (phase === 'upload') output('Uploading…', 'dim'); }
    else { output(m.text, 'err'); output('Compilation error: exit status 1', 'err'); for (const x of explainCompile(m.text, ws.files())) output(`Tip: ${x.title}${x.fix ? '. ' + x.fix : ''}`.replace(/`/g, ''), 'hint'); toast('Compilation error: exit status 1', true); phase = 'idle'; }
  });
  const offStatus = on('status', m => {
    if (phase === 'upload' && m.running) { output(`avrdude: ${b.chip} on ${port} written and verified.`, ''); output('Done uploading.', ''); toast('Done uploading.'); phase = 'idle'; }
    paintPort();
  });
  for (const o of state!.backlog.slice(-60)) if (!o.cls) feed(o.text);

  // ---------------------------------------------------------------- actions
  function verify() { ws.saveAll(); tab('output'); outEl.textContent = ''; phase = 'verify'; output(`Compiling sketch… (${b.name})`, 'dim'); send('verify', { files: ws.pending() }); }
  function upload() { ws.saveAll(); tab('output'); outEl.textContent = ''; phase = 'upload'; output(`Compiling sketch… (${b.name})`, 'dim'); send('run', { files: ws.pending() }); }
  async function newTab() { const n = await ask('Name for new file', 'helpers.h', 'ard-m'); if (!n) return; if (ws.files()[n] != null) return ws.open(n); ws.create(n, n.endsWith('.h') ? '#pragma once\n\n' : ''); }
  function keys(e: KeyboardEvent) {
    const c = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (c && k === 'r') { verify(); return true; }
    if (c && k === 'u') { upload(); return true; }
    if (c && k === 's') { ws.saveAll(); toast('Saved.'); return true; }
    if (c && e.shiftKey && k === 'm') { tab('monitor'); return true; }
    if (c && e.shiftKey && k === 'n') { newTab(); return true; }
    if (c && e.shiftKey && k === 'f') { panel('search'); return true; }
    return false;
  }
  window.addEventListener('keydown', e => { if (e.defaultPrevented || (e.target as HTMLElement)?.closest?.('.dmodal')) return; if (keys(e)) e.preventDefault(); });
  ($('[data-a=verify]')).onclick = verify; ($('[data-a=upload]')).onclick = upload;
  ($('[data-a=monitor]')).onclick = () => tab('monitor'); ($('[data-a=plotter]')).onclick = () => tab('plotter');
  root.querySelectorAll<HTMLElement>('.abtabs [data-b]').forEach(x => (x.onclick = () => tab(x.dataset.b!)));
  const mi = root.querySelector('.amsg input') as HTMLInputElement;
  mi.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { if (!state!.running) { toast(`Not connected. Upload the sketch to '${b.name}' first.`, true); return; } send('send', { text: mi.value + ($('.aend') as HTMLSelectElement).value }); mi.value = ''; } };
  $('.abaud').onchange = () => { mon.append(`\n--- baud rate set to ${($('.abaud') as HTMLSelectElement).value} ---\n`); };
  $('.aboard').onclick = e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); menu([{ label: `${b.name}  ·  ${port}`, check: true }, { sep: true }, { label: 'Select other board and port…', act: () => info('Select other board and port', `<p>The board comes from the Formframe studio (Electronics ▸ Target). Choose a different board there and this window switches to the matching IDE.</p>`, 'ard-m') }], r.left, r.bottom + 2, 'ard-m'); };
  function paintTools(v: string) {
    const t = $('.abtools'); t.innerHTML = '';
    if (v !== 'monitor' && v !== 'output') return;
    const btn = (ic: string, title: string, on: boolean, fn: () => void) => { const x = document.createElement('button'); x.innerHTML = ic; x.title = title; x.classList.toggle('on', on); x.onclick = () => { fn(); paintTools(v); }; t.appendChild(x); };
    if (v === 'monitor') { btn(I.scroll, 'Toggle Autoscroll', autoscroll, () => (autoscroll = !autoscroll)); btn(I.clock, 'Toggle Timestamp', stamps, () => (stamps = !stamps)); }
    btn(I.clear, 'Clear Output', false, () => { if (v === 'monitor') { mon.textContent = ''; series.clear(); } else outEl.textContent = ''; });
  }
  function plot() {
    const cv = $('.aplot') as HTMLCanvasElement, r = cv.getBoundingClientRect(), dpr = devicePixelRatio;
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
    const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
    const all = [...series.values()].flat(); const lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1, span = hi - lo || 1;
    const cols = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00', '#56b4e9'];
    g.strokeStyle = '#e1e6e6'; g.fillStyle = '#7f8c8d'; g.font = '11px sans-serif';
    for (let i = 0; i <= 4; i++) { const y = 10 + (r.height - 30) * (i / 4); g.beginPath(); g.moveTo(40, y); g.lineTo(r.width - 8, y); g.stroke(); g.fillText((hi - span * i / 4).toFixed(1), 4, y + 4); }
    [...series.entries()].forEach(([, a], si) => { g.strokeStyle = cols[si % cols.length]; g.lineWidth = 1.8; g.beginPath(); a.forEach((v, i) => { const x = 40 + (r.width - 50) * (i / 49), y = 10 + (r.height - 30) * (1 - (v - lo) / span); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); });
    $('.aleg').innerHTML = series.size ? [...series.keys()].map((k, i) => `<span><i style="background:${cols[i % cols.length]}"></i>${esc(k)}</span>`).join('') : '<span class="dim">Print numbers with Serial.println() (or label:value pairs) to plot them.</span>';
  }
  const paintPort = () => { $('.aport').textContent = `${b.name} on ${port} ${state!.running ? '' : '[not connected]'}`; };
  let toastT: any;
  function toast(t: string, err = false) { const x = $('.atoast'); x.textContent = t; x.classList.toggle('err', err); x.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (x.hidden = true), 4000); }

  // ---------------------------------------------------------------- side panels
  let openPanel = '';
  function panel(p: string) {
    openPanel = openPanel === p ? '' : p;
    root.querySelectorAll<HTMLElement>('.aside [data-p]').forEach(x => x.classList.toggle('on', x.dataset.p === openPanel));
    const el = $('.apanel'); el.hidden = !openPanel; el.innerHTML = '';
    const head = (t: string) => { const h = document.createElement('div'); h.className = 'aph'; h.textContent = t; el.appendChild(h); };
    if (openPanel === 'book') { head('SKETCHBOOK'); const sk = document.createElement('div'); sk.className = 'apl'; sk.innerHTML = `<div class="apr b">▾ ${esc(sketch)}</div>`; ws.names().forEach(n => { const r = document.createElement('div'); r.className = 'apr'; r.style.paddingLeft = '22px'; r.textContent = n; r.ondblclick = r.onclick = () => ws.open(n); sk.appendChild(r); }); el.appendChild(sk); }
    if (openPanel === 'boards') { head('BOARDS MANAGER'); el.insertAdjacentHTML('beforeend', `<input class="apf" placeholder="Filter your search…"><div class="apcard"><b>Arduino AVR Boards</b><span>by Arduino</span><div class="dim">1.8.6 installed</div><p>Boards included in this package: Arduino Uno, Arduino Nano, Arduino Mega…</p><button disabled>INSTALLED</button></div><p class="dim apn">ESP32 and Raspberry Pi boards are chosen in the studio's Electronics mode. They open in Thonny.</p>`); }
    if (openPanel === 'libs') {
      head('LIBRARY MANAGER');
      const used = [...new Set([...Object.values(ws.files()).join('\n').matchAll(/#include\s*[<"]([^>"]+)[>"]/g)].map(m => m[1]))];
      const known: Record<string, [string, string, string]> = { 'Adafruit_NeoPixel.h': ['Adafruit NeoPixel', 'by Adafruit', '1.12.3'], 'Wire.h': ['Wire', 'built-in', '1.0'], 'SPI.h': ['SPI', 'built-in', '1.0'], 'Servo.h': ['Servo', 'by Michael Margolis, Arduino', '1.2.2'] };
      el.insertAdjacentHTML('beforeend', '<input class="apf" placeholder="Filter your search…">' + Object.entries(known).map(([h, [n, by, v]]) => `<div class="apcard"><b>${n}</b><span>${by}</span><div class="dim">${v} installed${used.includes(h) ? ' · used by this sketch' : ''}</div><button disabled>INSTALLED</button></div>`).join('') + used.filter(h => !known[h] && !ws.files()[h]).map(h => `<div class="apcard warn"><b>${esc(h)}</b><div>Included by the sketch but not available here.</div></div>`).join(''));
    }
    if (openPanel === 'debug') { head('DEBUG'); el.insertAdjacentHTML('beforeend', `<p class="apn">Debugging is not supported by '${esc(b.name)}'. Use Serial.println() and the Serial Monitor.</p>`); }
    if (openPanel === 'search') {
      head('SEARCH'); const q = document.createElement('input'); q.className = 'apf'; q.placeholder = 'Search'; el.appendChild(q); const res = document.createElement('div'); res.className = 'apl'; el.appendChild(res);
      q.onkeydown = e => e.stopPropagation();
      q.oninput = () => { res.innerHTML = ''; const s = q.value; if (!s) return; for (const n of ws.names()) ws.text(n).split('\n').forEach((l, i) => { if (l.toLowerCase().includes(s.toLowerCase())) { const r = document.createElement('div'); r.className = 'apr'; r.innerHTML = `<b>${esc(n)}:${i + 1}</b> ${esc(l.trim().slice(0, 60))}`; r.onclick = () => { ws.open(n); setTimeout(() => { const off = ws.text(n).split('\n').slice(0, i).join('\n').length + 1; ed.ta.focus(); ed.ta.setSelectionRange(off, off + l.length); }, 0); }; res.appendChild(r); } }); };
      setTimeout(() => q.focus(), 0);
    }
  }
  root.querySelectorAll<HTMLElement>('.aside [data-p]').forEach(x => (x.onclick = () => panel(x.dataset.p!)));
  $('.apanel').hidden = true;

  menubar($('.amenu'), {
    File: () => [{ label: 'New Tab', key: 'Ctrl+Shift+N', act: newTab }, { label: 'Save', key: 'Ctrl+S', act: () => { ws.saveAll(); toast('Saved.'); } }, { sep: true }, { label: 'Close Tab', act: () => ws.active && ws.close(ws.active) }],
    Edit: () => [{ label: 'Undo', key: 'Ctrl+Z', act: () => document.execCommand('undo') }, { label: 'Redo', key: 'Ctrl+Y', act: () => document.execCommand('redo') }, { sep: true }, { label: 'Find in Files…', key: 'Ctrl+Shift+F', act: () => panel('search') }],
    Sketch: () => [{ label: 'Verify/Compile', key: 'Ctrl+R', act: verify }, { label: 'Upload', key: 'Ctrl+U', act: upload }, { sep: true }, { label: 'Include Library ▸ Manage Libraries…', act: () => panel('libs') }],
    Tools: () => [{ label: 'Serial Monitor', key: 'Ctrl+Shift+M', act: () => tab('monitor') }, { label: 'Serial Plotter', act: () => tab('plotter') }, { sep: true }, { label: `Board: "${b.name}"`, act: () => panel('boards') }, { label: `Port: "${port}"`, dis: true }],
    Help: () => [{ label: 'About', act: () => info('About', '<p>An Arduino IDE 2-style editor in Formframe. Sketches compile with avr-gcc or arduino-cli on the dev server and run on the emulated ATmega328P in the studio window.</p>', 'ard-m') }],
  }, 'ard-m');

  // ---------------------------------------------------------------- tabs
  let shown = '';
  function paint() {
    const tabs = $('.atabs'); tabs.innerHTML = '';
    const order = [...ws.tabs].sort((a, c) => (a.endsWith('.ino') ? -1 : c.endsWith('.ino') ? 1 : 0));
    for (const n of order) {
      const t = document.createElement('div'); t.className = 'atab' + (n === ws.active ? ' on' : '');
      t.innerHTML = `<span></span>${n.endsWith('.ino') ? '' : '<b title="Close">✕</b>'}`; (t.querySelector('span') as HTMLElement).textContent = n + (ws.dirty.has(n) ? ' ●' : '');
      t.onclick = e => { if ((e.target as HTMLElement).tagName === 'B') ws.close(n); else ws.open(n); };
      t.oncontextmenu = e => { e.preventDefault(); menu([{ label: 'Rename', act: async () => { const x = await ask('New name', n, 'ard-m'); if (x && x !== n) ws.rename(n, x); } }, { label: 'Delete', dis: n.endsWith('.ino'), act: () => { if (confirm(`Delete ${n}?`)) ws.remove(n); } }], e.clientX, e.clientY, 'ard-m'); };
      tabs.appendChild(t);
    }
    const more = document.createElement('button'); more.className = 'amore'; more.textContent = '⋯'; more.title = 'More'; more.onclick = e => menu([{ label: 'New Tab', act: newTab }, ...ws.names().filter(n => !ws.tabs.includes(n)).map(n => ({ label: 'Open ' + n, act: () => ws.open(n) }))], (e as MouseEvent).clientX, (e as MouseEvent).clientY, 'ard-m'); tabs.appendChild(more);
    if (ws.active !== shown || (ws.active && ed.value !== ws.text(ws.active))) { shown = ws.active; ed.set(ws.active ? ws.text(ws.active) : '', langOf(ws.active || 'a.ino')); }
    paintPort();
  }
  const prev = ws.onChange; ws.onChange = () => { prev(); paint(); };
  for (const n of ws.names()) ws.tabs.includes(n) || ws.tabs.push(n); // the IDE opens every sketch file as a tab
  ws.active = ws.names().find(n => n.endsWith('.ino')) ?? ws.names()[0] ?? '';
  paint(); paintTools('output');
  output(`Formframe ready: '${b.name}' on ${port}. Verify (Ctrl+R) or Upload (Ctrl+U).`, 'dim');
  const split = $('.asplit');
  split.onpointerdown = e => { split.setPointerCapture(e.pointerId); const c = $('.acenter').getBoundingClientRect(); split.onpointermove = m => { $('.abottom').style.height = Math.max(90, Math.min(c.height - 120, c.bottom - m.clientY)) + 'px'; }; split.onpointerup = () => (split.onpointermove = null); };
  return { destroy: () => { offOut(); offCompile(); offStatus(); ws.onChange = prev; } };
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
