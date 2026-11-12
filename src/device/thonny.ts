import { CodeEditor, langOf } from './editor';
import { state, send, on, lineBuffer, owner, setOwner } from './client';
import { Workspace, menubar, menu, ask, info } from './workspace';
import { explainPython, explainSim, parseTraceback } from '../app/explain';

/**
 * Thonny-style Python IDE: the editor MicroPython boards (Pico, ESP32) are
 * usually programmed with, and the default Python IDE on Raspberry Pi OS.
 * Run saves and runs on the studio's emulator; the Shell is the board's REPL.
 */
const I = {
  new: '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v15H6z" fill="#fff" stroke="#5a6b7c"/><path d="M14 2v5h5" fill="#dfe6ee" stroke="#5a6b7c"/></svg>',
  load: '<svg viewBox="0 0 24 24"><path d="M2 6h7l2 2h11v12H2z" fill="#f4c542" stroke="#a8841c"/><path d="M2 10h20l-2 10H2z" fill="#ffd966" stroke="#a8841c"/></svg>',
  save: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" fill="#3d6fb6"/><rect x="7" y="3" width="10" height="6" fill="#dfe8f5"/><rect x="6" y="13" width="12" height="8" fill="#fff"/></svg>',
  run: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#2e9b45"/><path d="M9.5 7.5l7 4.5-7 4.5z" fill="#fff"/></svg>',
  debug: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="13" rx="5" ry="6.5" fill="#7a5a2e"/><path d="M12 6.5v13M7 10l-4-2M17 10l4-2M7 14H3M17 14h4M7.5 18l-3 2.5M16.5 18l3 2.5" stroke="#7a5a2e" stroke-width="1.6"/></svg>',
  over: '<svg viewBox="0 0 24 24"><path d="M4 14a8 8 0 0 1 15-3" fill="none" stroke="#3d6fb6" stroke-width="2.4"/><path d="M21 6v6h-6z" fill="#3d6fb6"/><circle cx="12" cy="19" r="2.5" fill="#3d6fb6"/></svg>',
  into: '<svg viewBox="0 0 24 24"><path d="M12 3v11" stroke="#3d6fb6" stroke-width="2.4"/><path d="M7 11l5 6 5-6z" fill="#3d6fb6"/><circle cx="12" cy="21" r="2" fill="#3d6fb6"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M12 20V8" stroke="#3d6fb6" stroke-width="2.4"/><path d="M7 11l5-6 5 6z" fill="#3d6fb6"/></svg>',
  resume: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="3" height="14" fill="#2e9b45"/><path d="M10 5l10 7-10 7z" fill="#2e9b45"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="#d23b2e"/><rect x="7" y="10.5" width="10" height="3" fill="#fff"/></svg>',
  py: '<svg viewBox="0 0 16 16"><path d="M2 1h8l4 4v10H2z" fill="#fff" stroke="#8796a6"/><path d="M5 7h6M5 9.5h6M5 12h4" stroke="#3d6fb6"/></svg>',
  dir: '<svg viewBox="0 0 16 16"><path d="M1 3h5l1.5 1.5H15V13H1z" fill="#f4c542" stroke="#b08a20"/></svg>',
  chip: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1" fill="#2c3e50"/><path d="M5 1v2M8 1v2M11 1v2M5 13v2M8 13v2M11 13v2M1 5h2M1 8h2M1 11h2M13 5h2M13 8h2M13 11h2" stroke="#8796a6"/></svg>',
  pc: '<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="9" rx="1" fill="#dfe6ee" stroke="#5a6b7c"/><path d="M5 14h6M8 11v3" stroke="#5a6b7c"/></svg>',
};

export interface ThonnyOpts { pi: boolean; /** checked before Run; return a warning to print, or null */ preflight?: () => string | null; home?: string }

export function mountThonny(root: HTMLElement, ws: Workspace, opts: ThonnyOpts) {
  const b = state!.board, mpy = !opts.pi;
  const devName = b.id === 'picow' ? 'Raspberry Pi Pico' : b.name;
  const home = opts.home ?? (opts.pi ? '/home/pi/' + slug(state!.name) : '~/' + slug(state!.name));
  root.classList.add('thonny');
  root.innerHTML = `
    <div class="tmbar"></div>
    <div class="ttools">
      <button data-a="new" title="New (Ctrl+N)">${I.new}</button><button data-a="load" title="Load (Ctrl+O)">${I.load}</button><button data-a="save" title="Save (Ctrl+S)">${I.save}</button>
      <span class="tsep"></span>
      <button data-a="run" title="Run current script (F5)">${I.run}</button><button data-a="debug" disabled title="Debug current script (Ctrl+F5)">${I.debug}</button>
      <button disabled title="Step over (F6)">${I.over}</button><button disabled title="Step into (F7)">${I.into}</button><button disabled title="Step out">${I.out}</button><button disabled title="Resume (F8)">${I.resume}</button>
      <button data-a="stop" title="Stop/Restart backend (Ctrl+F2)">${I.stop}</button>
    </div>
    <div class="tbody">
      <div class="tfiles"><div class="tfh">Files ✕</div><div class="tfsec"><div class="tfloc">${I.pc} This computer</div><div class="tfpath"></div><div class="tflist" data-l="pc"></div></div>${mpy ? `<div class="tfsec dev"><div class="tfloc">${I.chip} ${esc(devName)}</div><div class="tflist" data-l="dev"></div></div>` : ''}</div>
      <div class="tmain">
        <div class="ttabs"></div>
        <div class="tedit"></div>
        <div class="tsplit"></div>
        <div class="tshell"><div class="tsh">Shell ✕</div><div class="tsout"></div></div>
      </div>
    </div>
    <div class="tstatus"><span class="tlc"></span><span class="sp"></span><button class="tinterp"></button></div>`;
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const ed = new CodeEditor('thonny-ed'); $('.tedit').appendChild(ed.el);
  ed.onChange = v => { if (ws.active) ws.edit(ws.active, v); };
  ed.onCursor = (l, c) => { $('.tlc').textContent = `Ln ${l}, Col ${c}`; };
  $('.tinterp').textContent = mpy ? `MicroPython (${devName}) • ${b.id === 'picow' ? 'Board CDC @ /dev/ttyACM0' : 'USB Serial @ /dev/ttyUSB0'}` : 'Local Python 3 • /usr/bin/python3';
  $('.tinterp').onclick = () => info('Thonny options · Interpreter', `<p>Which kind of interpreter should Thonny use for running your code?</p><p><b>${mpy ? `MicroPython (${esc(devName)})` : 'Local Python 3'}</b></p><p>${mpy ? `Port: <code>${b.id === 'picow' ? '/dev/ttyACM0' : '/dev/ttyUSB0'}</code> · ${b.fidelity === 'emulated' ? 'real MicroPython firmware on an emulated ' + esc(b.chip) : 'behavioral MicroPython simulation of the ' + esc(b.chip)}` : 'Your script runs against the parts wired in the Formframe studio.'}</p><p class="dim">The interpreter follows the board chosen in the studio's Electronics mode.</p>`, 'thonny-m');

  // ---------------------------------------------------------------- shell
  const sout = $('.tsout');
  let inp: HTMLInputElement, hist: string[] = [], hi = 0, echo = '';
  const line = (t: string, cls = '') => {
    const d = document.createElement('div'); d.className = 'sl ' + cls; d.textContent = t;
    sout.insertBefore(d, sout.lastElementChild); while (sout.children.length > 800) sout.firstElementChild!.remove();
    sout.scrollTop = sout.scrollHeight;
  };
  const prompt = () => {
    const p = document.createElement('div'); p.className = 'sl sin'; p.innerHTML = '<span class="pr">&gt;&gt;&gt; </span>';
    inp = document.createElement('input'); inp.spellcheck = false; p.appendChild(inp); sout.appendChild(p);
    inp.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = inp.value; inp.value = ''; if (v) { hist.push(v); hi = hist.length; }
        line('>>> ' + v, 'cmd');
        if (!mpy) { if (v.trim()) line('This preview runs your scripts but has no live Python prompt. Use Run (F5).', 'sys'); return; }
        if (!state!.running) { line('Backend is not running. Press Stop/Restart (Ctrl+F2) to connect, or Run (F5).', 'err'); return; }
        echo = v; send('send', { text: v + '\r' });
      } else if (e.key === 'ArrowUp') { e.preventDefault(); if (hi > 0) inp.value = hist[--hi]; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] ?? ''; }
      else if (e.ctrlKey && e.key === 'c') { e.preventDefault(); interrupt(); }
      else if (e.ctrlKey && e.key === 'd' && mpy) { e.preventDefault(); line('MPY: soft reboot', 'sys'); send('send', { text: '\x04' }); }
    };
  };
  prompt();
  sout.onclick = e => { if (e.target === sout || (e.target as HTMLElement).classList.contains('sl')) inp.focus(); };
  if (mpy) line(`MicroPython v1.24.1 on 2024-11-29; ${b.id === 'picow' ? 'Raspberry Pi Pico W with RP2040' : esc(b.name) + ' with ' + b.chip}`, 'banner'), line('Type "help()" for more information.', 'banner');
  else line('Python 3.11.2 (/usr/bin/python3)', 'banner');
  let tb = false, recent: string[] = [];
  // Assistant: explain errors in plain language right under them
  let lastAssist = '';
  const code = (t: string) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
  const assist = (title: string, fix?: string) => {
    if (title === lastAssist) return; lastAssist = title; // the board prints some tracebacks twice
    const d = document.createElement('div'); d.className = 'sl assist'; d.innerHTML = `<b>Assistant</b> ${code(title)}${fix ? `<br><span>${code(fix)}</span>` : ''}`;
    sout.insertBefore(d, sout.lastElementChild); sout.scrollTop = sout.scrollHeight;
  };
  const feed = lineBuffer((t, partial) => {
    recent.push(t); if (recent.length > 14) recent.shift();
    if (/^\[sim\]/.test(t)) { const x = explainSim(t); line(t, 'warn'); assist(x.title, x.fix); return; }
    if (/^Traceback: /.test(t) || /^\w+(Error|Exception)\b/.test(t)) { const p = parseTraceback(/^Traceback: /.test(t) ? [t] : recent); if (p && p.type !== 'KeyboardInterrupt') { line(t, 'err'); const x = explainPython(p.type, p.message, p.line, state!.files, p.file && state!.files[p.file] != null ? p.file : 'main.py'); assist(x.title, x.fix); recent = []; tb = false; return; } }
    if (partial) return; // the device's own ">>> " prompt: ours is always there
    if (echo && (t === echo || t === '>>> ' + echo)) { echo = ''; return; }
    if (/^Traceback|^\s+File "/.test(t)) tb = true;
    const err = tb || /^\w+Error\b|^\w+Exception\b/.test(t);
    if (!/^\s+File "|^Traceback/.test(t) && tb && /^\w/.test(t)) tb = false;
    line(t, err ? 'err' : '');
  });
  for (const o of state!.backlog.slice(-80)) out(o);
  function out(m: { text: string; cls?: string }) {
    if (owner === 'term') return;
    if (!m.cls) return feed(m.text);
    if (/^───/.test(m.text)) return line(mpy ? 'MPY: soft reboot' : '', mpy ? 'sys' : 'gap');
    if (m.text === 'Stopped.') return line(mpy ? '' : 'Backend terminated.', 'sys');
    line(m.text, m.cls === 'e' ? 'err' : m.cls === 'w' ? 'warn' : 'sys');
    if (/^\[sim\]/.test(m.text)) { const x = explainSim(m.text); assist(x.title, x.fix); }
  }
  const offOut = on('out', out);
  const offStatus = on('status', () => paintRun());

  // ---------------------------------------------------------------- actions
  function run() {
    const warn = opts.preflight?.(); if (warn) line(warn, 'warn');
    if (ws.active && ws.active.endsWith('.py')) ws.save();
    const files = ws.pending();
    line(mpy ? '%Run -c $EDITOR_CONTENT' : `%Run ${ws.active && !ws.active.includes('/') ? ws.active : 'main.py'}`, 'cmd');
    if (ws.active && ws.active !== 'main.py' && ws.active.endsWith('.py') && !ws.active.includes('/')) line(`(${mpy ? 'The board boots' : 'The project runs'} main.py, which imports your other files.)`, 'sys');
    lastAssist = ''; setOwner('thonny'); send('run', { files });
  }
  function stop() { if (state!.running) send('stop'); else { line(mpy ? 'Connecting to ' + devName + '…' : 'Starting Python…', 'sys'); setOwner('thonny'); send('run', { files: ws.pending() }); } }
  function interrupt() { if (state!.running) { line('KeyboardInterrupt', 'err'); send('interrupt'); } }
  async function newFile() { const n = await ask('New file name', 'untitled.py', 'thonny-m'); if (!n) return; if (ws.files()[n] != null) { ws.open(n); return; } ws.create(n, ''); }
  function load() { info('Open from', `<p>Pick a file from the Files pane on the left${mpy ? `, either <b>This computer</b> or <b>${esc(devName)}</b>` : ''}.</p>`, 'thonny-m'); }
  async function saveAs() { const a = ws.active; if (!a) return; const n = await ask('Save as', a, 'thonny-m'); if (n && n !== a) { ws.save(a); ws.rename(a, n); } }
  function keys(e: KeyboardEvent) {
    const c = e.ctrlKey || e.metaKey;
    if (e.key === 'F5') { run(); return true; }
    if (c && e.key === 'F2') { stop(); return true; }
    if (c && e.key.toLowerCase() === 's') { if (e.shiftKey) saveAs(); else ws.save(); return true; }
    if (c && e.key.toLowerCase() === 'n') { newFile(); return true; }
    if (c && e.key.toLowerCase() === 'w') { if (ws.active) ws.close(ws.active); return true; }
    if (e.ctrlKey && e.key === 'c' && !(ed.ta.selectionStart !== ed.ta.selectionEnd)) { interrupt(); return true; }
    return false;
  }
  // shortcuts work anywhere in the window (or, on the Pi desktop, while Thonny's window is in front)
  const inFront = () => { const w = root.closest('.pwin'); return !w || w.classList.contains('act'); };
  const onKey = (e: KeyboardEvent) => { if (e.defaultPrevented || !inFront() || (e.target as HTMLElement)?.closest?.('.dmodal')) return; if (keys(e)) e.preventDefault(); };
  window.addEventListener('keydown', onKey);
  root.querySelectorAll<HTMLButtonElement>('.ttools [data-a]').forEach(btn => (btn.onclick = () => ({ new: newFile, load, save: () => ws.save(), run, stop, debug: () => {} } as any)[btn.dataset.a!]()));
  const paintRun = () => { ($('.ttools [data-a=run]') as HTMLButtonElement).disabled = false; root.classList.toggle('busy', !!state!.running); };
  paintRun();

  menubar($('.tmbar'), {
    File: () => [{ label: 'New', key: 'Ctrl+N', act: newFile }, { label: 'Open…', key: 'Ctrl+O', act: load }, { sep: true }, { label: 'Save', key: 'Ctrl+S', act: () => ws.save() }, { label: 'Save as…', key: 'Shift+Ctrl+S', act: saveAs }, { label: 'Save all files', act: () => ws.saveAll() }, { sep: true }, { label: 'Close', key: 'Ctrl+W', act: () => ws.active && ws.close(ws.active) }],
    Edit: () => [{ label: 'Undo', key: 'Ctrl+Z', act: () => document.execCommand('undo') }, { label: 'Redo', key: 'Ctrl+Y', act: () => document.execCommand('redo') }, { sep: true }, { label: 'Select all', key: 'Ctrl+A', act: () => { ed.focus(); ed.ta.select(); } }, { label: 'Clear shell', key: 'Ctrl+L', act: () => { while (sout.children.length > 1) sout.firstElementChild!.remove(); send('clear'); } }],
    View: () => [{ label: 'Files', check: !root.classList.contains('nofiles'), act: () => root.classList.toggle('nofiles') }, { label: 'Shell', check: !root.classList.contains('noshell'), act: () => root.classList.toggle('noshell') }],
    Run: () => [{ label: 'Run current script', key: 'F5', act: run }, { label: 'Debug current script', key: 'Ctrl+F5', dis: true }, { sep: true }, { label: 'Interrupt execution', key: 'Ctrl+C', act: interrupt, dis: !state!.running }, { label: 'Stop/Restart backend', key: 'Ctrl+F2', act: stop }, ...(mpy ? [{ label: 'Send EOF / Soft reboot', key: 'Ctrl+D', act: () => { line('MPY: soft reboot', 'sys'); send('send', { text: '\x04' }); } }] : []), { sep: true }, { label: 'Configure interpreter…', act: () => $('.tinterp').click() }],
    Tools: () => [{ label: 'Manage packages…', act: () => info('Manage packages', `<p>Installed in this project:</p><ul>${ws.names().filter(n => n.startsWith('lib/')).map(n => `<li><code>${esc(n.slice(4).replace(/\.py$/, ''))}</code></li>`).join('') || '<li class="dim">none</li>'}</ul><p class="dim">${mpy ? 'Drop .py drivers into lib/ with File ▸ New (lib/name.py).' : 'Standard library plus gpiozero and smbus2 are available.'}</p>`, 'thonny-m') }, { label: 'Open system shell…', dis: !opts.pi, act: () => root.dispatchEvent(new CustomEvent('open-terminal', { bubbles: true })) }],
    Help: () => [{ label: 'About this editor', act: () => info('About', '<p>A Thonny-style Python editor in Formframe. Code runs on the board emulator in the studio window, which also drives the bench and the 3D model.</p>', 'thonny-m') }],
  }, 'thonny-m');

  // ---------------------------------------------------------------- files + tabs
  function fileRow(n: string, where: 'pc' | 'dev') {
    const d = document.createElement('div'); d.className = 'tfr' + (n === ws.active && where === 'pc' ? ' on' : '');
    const depth = n.split('/').length - 1;
    d.innerHTML = `${I.py}<span></span>`; (d.querySelector('span') as HTMLElement).textContent = n.split('/').pop()!; d.style.paddingLeft = 6 + depth * 14 + 'px';
    d.ondblclick = () => ws.open(n);
    d.oncontextmenu = e => { e.preventDefault(); menu([{ label: 'Open', act: () => ws.open(n) }, { label: 'Rename…', act: async () => { const t = await ask('Rename', n, 'thonny-m'); if (t && t !== n) ws.rename(n, t); } }, { label: 'Delete', act: () => { if (confirm(`Delete ${n}?`)) ws.remove(n); } }, { sep: true }, { label: 'New file…', act: newFile }], e.clientX, e.clientY, 'thonny-m'); };
    return d;
  }
  function paint() {
    $('.tfpath').textContent = home;
    const pc = root.querySelector('[data-l=pc]') as HTMLElement; pc.innerHTML = '';
    const names = ws.names(), dirs = new Set(names.filter(n => n.includes('/')).map(n => n.split('/')[0]));
    for (const dname of dirs) { const r = document.createElement('div'); r.className = 'tfr dir'; r.innerHTML = `${I.dir}<span>${esc(dname)}</span>`; pc.appendChild(r); names.filter(n => n.startsWith(dname + '/')).forEach(n => pc.appendChild(fileRow(n, 'pc'))); }
    names.filter(n => !n.includes('/')).forEach(n => pc.appendChild(fileRow(n, 'pc')));
    const dev = root.querySelector('[data-l=dev]') as HTMLElement | null;
    if (dev) { dev.innerHTML = ''; names.filter(n => n.endsWith('.py')).forEach(n => { const r = fileRow(n, 'dev'); r.insertAdjacentHTML('beforeend', `<span class="sz">${Math.max(1, Math.round(ws.text(n).length / 1024 * 10) / 10)} KB</span>`); dev.appendChild(r); }); }
    const tabs = $('.ttabs'); tabs.innerHTML = '';
    for (const n of ws.tabs) {
      const t = document.createElement('div'); t.className = 'ttab' + (n === ws.active ? ' on' : '');
      t.innerHTML = `<span></span><b title="Close">✕</b>`; (t.querySelector('span') as HTMLElement).textContent = (mpy ? '[ ' + n.split('/').pop() + ' ]' : n.split('/').pop()) + (ws.dirty.has(n) ? ' *' : '');
      t.onclick = e => { if ((e.target as HTMLElement).tagName === 'B') ws.close(n); else ws.open(n); };
      tabs.appendChild(t);
    }
    if (ws.active !== shown || (ws.active && ed.value !== ws.text(ws.active))) { shown = ws.active; ed.set(ws.active ? ws.text(ws.active) : '', langOf(ws.active || 'a.py')); }
    $('.tedit').classList.toggle('empty', !ws.active);
  }
  let shown = '';
  const prev = ws.onChange; ws.onChange = () => { prev(); paint(); };
  if (!ws.tabs.length) { const n = ws.names().find(x => x === 'main.py') ?? ws.names()[0]; if (n) ws.open(n); }
  paint();

  // resizable shell
  const split = $('.tsplit');
  split.onpointerdown = e => { split.setPointerCapture(e.pointerId); const main = $('.tmain').getBoundingClientRect(); split.onpointermove = m => { $('.tshell').style.height = Math.max(70, Math.min(main.height - 120, main.bottom - m.clientY)) + 'px'; }; split.onpointerup = () => (split.onpointermove = null); };

  return { focus: () => ed.focus(), destroy: () => { offOut(); offStatus(); ws.onChange = prev; window.removeEventListener('keydown', onKey); }, run };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
