import { state, send, on, lineBuffer, pid, setOwner } from './client';
import { Workspace, menu, info, ask } from './workspace';
import { mountThonny, slug } from './thonny';

/**
 * Raspberry Pi OS-style desktop for Linux boards (Pi 5, Zero 2 W): top panel,
 * app menu, windows, and the apps you'd use to write code on a Pi — Thonny,
 * Terminal, File Manager and Raspberry Pi Configuration. Scripts run on the
 * studio's simulation against the wired parts.
 */
const IC = {
  menu: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5" fill="#c51a4a"/><circle cx="9" cy="11" r="2" fill="#e8507a"/><circle cx="15" cy="11" r="2" fill="#e8507a"/><circle cx="12" cy="15.5" r="2" fill="#e8507a"/><path d="M8 5.5c2 0 3 1 4 2.5 1-1.5 2-2.5 4-2.5" fill="none" stroke="#4caf50" stroke-width="2"/></svg>',
  browser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#4a90d9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" fill="none" stroke="#fff" stroke-width="1.3"/></svg>',
  files: '<svg viewBox="0 0 24 24"><path d="M2 6h7l2 2h11v12H2z" fill="#e8b83c"/><path d="M2 10h20v10H2z" fill="#f5cd57"/></svg>',
  term: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" fill="#2d2d2d"/><path d="M6 9l3 3-3 3M11 15h6" fill="none" stroke="#8ae234" stroke-width="1.8"/></svg>',
  thonny: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="4" fill="#3b5998"/><path d="M7 8h10M12 8v10" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  config: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#6c7a89"/><path d="M12 7v10M7 12h10" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="#fff"/></svg>',
  trash: '<svg viewBox="0 0 48 48"><path d="M12 14h24l-2 28H14z" fill="#d9dde2" stroke="#7b8590"/><path d="M9 11h30v4H9zM19 7h10v4H19z" fill="#bcc3ca" stroke="#7b8590"/></svg>',
  folder48: '<svg viewBox="0 0 48 48"><path d="M4 10h15l4 4h21v26H4z" fill="#e8b83c"/><path d="M4 18h40v22H4z" fill="#f5cd57"/></svg>',
  py48: '<svg viewBox="0 0 48 48"><path d="M10 4h20l8 8v32H10z" fill="#fff" stroke="#9aa5b1"/><path d="M30 4v8h8" fill="#e5e9ed" stroke="#9aa5b1"/><rect x="15" y="22" width="18" height="12" rx="3" fill="#3776ab"/><text x="24" y="31" font-size="8" text-anchor="middle" fill="#ffd43b" font-family="sans-serif" font-weight="700">PY</text></svg>',
  txt48: '<svg viewBox="0 0 48 48"><path d="M10 4h20l8 8v32H10z" fill="#fff" stroke="#9aa5b1"/><path d="M15 20h18M15 25h18M15 30h12" stroke="#9aa5b1"/></svg>',
  wifi: '<svg viewBox="0 0 24 24"><path d="M2 9a14 14 0 0 1 20 0M5.5 12.5a9 9 0 0 1 13 0M9 16a4 4 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  bt: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10-5 4V3l5 4L7 17" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
};
// 40-pin header: physical pin → BCM GPIO, or a power/ground label
const HEADER: (number | string)[] = ['3V3', '5V', 2, '5V', 3, 'GND', 4, 14, 'GND', 15, 17, 18, 27, 'GND', 22, 23, '3V3', 24, 10, 'GND', 9, 25, 11, 8, 'GND', 7, 0, 1, 5, 'GND', 6, 12, 13, 'GND', 19, 16, 26, 20, 'GND', 21];

interface Win { id: number; title: string; icon: string; el: HTMLElement; min: boolean; max: boolean; app: string; destroy?: () => void }

export function mountPiDesktop(root: HTMLElement, ws: Workspace) {
  const b = state!.board, proj = slug(state!.name);
  const cfgKey = `ffpi.${pid}`;
  const cfg: { host: string; i2c: boolean; spi: boolean; serial: boolean; onewire: boolean; ssh: boolean; vnc: boolean } = Object.assign({ host: 'raspberrypi', i2c: false, spi: false, serial: false, onewire: false, ssh: false, vnc: false }, (() => { try { return JSON.parse(localStorage.getItem(cfgKey) ?? '{}'); } catch { return {}; } })());
  const saveCfg = () => { try { localStorage.setItem(cfgKey, JSON.stringify(cfg)); } catch { } };
  document.title = `${cfg.host} — ${b.name} (Formframe)`;
  root.classList.add('pios');
  root.innerHTML = `
    <div class="ppanel">
      <button class="pmenu" title="Menu">${IC.menu}</button>
      <div class="plaunch"><button data-l="browser" title="Web Browser">${IC.browser}</button><button data-l="files" title="File Manager">${IC.files}</button><button data-l="term" title="Terminal">${IC.term}</button><button data-l="thonny" title="Thonny">${IC.thonny}</button></div>
      <div class="ptasks"></div>
      <div class="ptray"><span title="Bluetooth">${IC.bt}</span><span title="Wi-Fi: connected">${IC.wifi}</span><span title="Volume">${IC.vol}</span><span class="pclock"></span></div>
    </div>
    <div class="pdesk">
      <div class="dicon" data-o="trash">${IC.trash}<span>Wastebasket</span></div>
      <div class="dicon" data-o="proj">${IC.folder48}<span>${esc(proj)}</span></div>
    </div>
    <div class="pwins"></div>`;
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const clock = () => { $('.pclock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  clock(); setInterval(clock, 15000);

  // ---------------------------------------------------------------- windows
  const wins: Win[] = []; let wid = 0, z = 10;
  function focus(w: Win) { w.el.style.zIndex = String(++z); wins.forEach(x => x.el.classList.toggle('act', x === w)); w.min = false; w.el.hidden = false; paintTasks(); }
  function close(w: Win) { w.destroy?.(); w.el.remove(); wins.splice(wins.indexOf(w), 1); paintTasks(); }
  function openWin(app: string, title: string, icon: string, body: (el: HTMLElement, w: Win) => void | (() => void), size: [number, number] = [760, 520]) {
    const ex = wins.find(w => w.app === app && app !== 'term'); if (ex) { focus(ex); return ex; }
    const el = document.createElement('div'); el.className = 'pwin';
    const area = $('.pwins').getBoundingClientRect(), n = wins.length;
    const W = Math.min(size[0], area.width - 20), Hh = Math.min(size[1], area.height - 20);
    Object.assign(el.style, { width: W + 'px', height: Hh + 'px', left: Math.max(8, (area.width - W) / 2 + n * 24 - 40) + 'px', top: Math.max(8, (area.height - Hh) / 2 + n * 24 - 30) + 'px' });
    el.innerHTML = `<div class="ptitle"><span class="pti">${icon}</span><span class="ptt"></span><span class="sp"></span><button data-w="min" title="Minimise">—</button><button data-w="max" title="Maximise">▢</button><button data-w="close" title="Close">✕</button></div><div class="pbody"></div><div class="pgrip"></div>`;
    (el.querySelector('.ptt') as HTMLElement).textContent = title;
    $('.pwins').appendChild(el);
    const w: Win = { id: ++wid, title, icon, el, min: false, max: false, app };
    wins.push(w);
    const r = body(el.querySelector('.pbody') as HTMLElement, w); if (typeof r === 'function') w.destroy = r;
    el.addEventListener('pointerdown', () => focus(w), true);
    const tb = el.querySelector('.ptitle') as HTMLElement;
    tb.onpointerdown = e => {
      if ((e.target as HTMLElement).closest('button') || w.max) return;
      tb.setPointerCapture(e.pointerId); const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
      tb.onpointermove = m => { el.style.left = Math.max(-W + 80, m.clientX - sx) + 'px'; el.style.top = Math.max(0, m.clientY - sy) + 'px'; };
      tb.onpointerup = () => (tb.onpointermove = null);
    };
    tb.ondblclick = e => { if (!(e.target as HTMLElement).closest('button')) toggleMax(); };
    const toggleMax = () => { w.max = !w.max; el.classList.toggle('max', w.max); };
    el.querySelectorAll<HTMLElement>('[data-w]').forEach(x => (x.onclick = () => { const a = x.dataset.w; if (a === 'close') close(w); if (a === 'max') toggleMax(); if (a === 'min') { w.min = true; el.hidden = true; paintTasks(); } }));
    const grip = el.querySelector('.pgrip') as HTMLElement;
    grip.onpointerdown = e => { grip.setPointerCapture(e.pointerId); const sx = e.clientX, sy = e.clientY, w0 = el.offsetWidth, h0 = el.offsetHeight; grip.onpointermove = m => { el.style.width = Math.max(320, w0 + m.clientX - sx) + 'px'; el.style.height = Math.max(200, h0 + m.clientY - sy) + 'px'; }; grip.onpointerup = () => (grip.onpointermove = null); };
    focus(w);
    return w;
  }
  function paintTasks() {
    const t = $('.ptasks'); t.innerHTML = '';
    for (const w of wins) {
      const btn = document.createElement('button'); btn.className = 'ptask' + (w.el.classList.contains('act') && !w.min ? ' on' : '');
      btn.innerHTML = `${w.icon}<span></span>`; (btn.querySelector('span') as HTMLElement).textContent = w.title;
      btn.onclick = () => { if (w.min || !w.el.classList.contains('act')) focus(w); else { w.min = true; w.el.hidden = true; paintTasks(); } };
      t.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------- apps
  const needs = () => {
    const kinds = new Set(state!.comps.flatMap(c => Object.keys(c.pins).filter(r => c.pins[r] != null).map(r => r))), names = (k: RegExp) => state!.comps.filter(c => Object.keys(c.pins).some(r => k.test(r) && c.pins[r] != null)).map(c => c.name);
    const w: string[] = [];
    if ((kinds.has('SDA') || state!.comps.some(c => c.i2c)) && !cfg.i2c) w.push(`I2C is turned off, so ${names(/^SD[AL]|SCL$/).join(', ') || 'I2C parts'} can't be reached (/dev/i2c-1 is missing). Turn it on in Menu ▸ Preferences ▸ Raspberry Pi Configuration ▸ Interfaces.`);
    if ((kinds.has('SCK') || kinds.has('MOSI')) && !cfg.spi) w.push(`SPI is turned off, so ${names(/^SCK|MOSI$/).join(', ')} can't be reached (/dev/spidev0.0 is missing). Turn it on in Raspberry Pi Configuration ▸ Interfaces.`);
    return w.length ? w.join('\n') : null;
  };
  const apps: Record<string, () => void> = {
    thonny: () => openWin('thonny', 'Thonny', IC.thonny, el => { const t = mountThonny(el, ws, { pi: true, preflight: needs, home: `/home/pi/${proj}` }); el.addEventListener('open-terminal', () => apps.term()); setTimeout(() => t.focus(), 0); return t.destroy; }, [900, 600]),
    term: () => openWin('term', 'Terminal', IC.term, (el, w) => terminal(el, () => close(w)), [720, 440]),
    files: (dir = '') => openWin('files', 'File Manager', IC.files, el => fileManager(el, typeof dir === 'string' ? dir : ''), [760, 480]),
    config: () => openWin('config', 'Raspberry Pi Configuration', IC.config, el => configApp(el), [560, 420]),
    browser: () => openWin('browser', 'Chromium', IC.browser, el => { el.classList.add('pbrowser'); el.innerHTML = `<div class="pburl">localhost</div><div class="pbmsg"><b>No internet in the preview</b><p>This desktop runs inside Formframe. Your code, the wired parts and the terminal work; web browsing doesn't.</p></div>`; }, [700, 420]),
  } as any;
  root.querySelectorAll<HTMLElement>('[data-l]').forEach(x => (x.onclick = () => apps[x.dataset.l!]()));
  root.querySelectorAll<HTMLElement>('.dicon').forEach(d => {
    d.onclick = () => { root.querySelectorAll('.dicon').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); };
    d.ondblclick = () => (d.dataset.o === 'proj' ? (apps.files as any)(proj) : info('Wastebasket', '<p>The wastebasket is empty.</p>', 'pi-m'));
  });
  $('.pmenu').onclick = e => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu([
      { label: 'Programming ▸ Thonny', act: apps.thonny },
      { label: 'Accessories ▸ Terminal', act: apps.term }, { label: 'Accessories ▸ File Manager', act: () => (apps.files as any)() },
      { label: 'Internet ▸ Chromium', act: apps.browser },
      { sep: true },
      { label: 'Preferences ▸ Raspberry Pi Configuration', act: apps.config },
      { sep: true },
      { label: 'Help ▸ About this desktop', act: () => info('About', `<p>A Raspberry Pi OS-style desktop in Formframe, running as <b>${esc(b.name)}</b>. Scripts run on the studio's simulation of the board against the parts you wired, and drive the 3D model.</p>`, 'pi-m') },
      { label: 'Shutdown…', act: shutdown },
    ], r.left, r.bottom + 2, 'pi-m');
  };
  function shutdown() {
    info('Shutdown options', `<div class="pshut"><button data-s="off">Shutdown</button><button data-s="reboot">Reboot</button><button data-s="logout">Logout</button></div>`, 'pi-m');
    document.querySelectorAll<HTMLElement>('.pshut [data-s]').forEach(x => (x.onclick = () => {
      document.querySelector('.dmodal')?.remove();
      if (state!.running) send('stop');
      [...wins].forEach(close);
      if (x.dataset.s === 'off') { const o = document.createElement('div'); o.className = 'poff'; o.innerHTML = '<p>The Pi is off.</p><button>Power on</button>'; root.appendChild(o); (o.querySelector('button') as HTMLElement).onclick = () => { o.remove(); boot(); }; }
      else boot();
    }));
  }
  function boot() { const s = document.createElement('div'); s.className = 'psplash'; s.innerHTML = `${IC.menu}<span>Raspberry Pi OS</span>`; root.appendChild(s); setTimeout(() => s.remove(), 1100); }

  // ---------------------------------------------------------------- terminal
  function terminal(el: HTMLElement, exit: () => void) {
    el.classList.add('pterm');
    const out = document.createElement('div'); out.className = 'ptout'; el.appendChild(out);
    let cwd = '/home/pi', hist: string[] = [], hi = 0, running = false, inp: HTMLInputElement;
    const tid = Math.random().toString(36).slice(2);
    const short = () => (cwd === '/home/pi' ? '~' : cwd.replace('/home/pi', '~'));
    const print = (t: string, cls = '') => { const d = document.createElement('div'); d.className = cls; d.textContent = t; out.insertBefore(d, out.lastElementChild); out.scrollTop = out.scrollHeight; };
    const promptRow = () => {
      out.querySelector('.prow')?.remove();
      const r = document.createElement('div'); r.className = 'prow';
      r.innerHTML = `<span class="pu">pi@${esc(cfg.host)}</span>:<span class="pp">${esc(short())}</span> $ `;
      inp = document.createElement('input'); inp.spellcheck = false; r.appendChild(inp); out.appendChild(r);
      inp.onkeydown = key; setTimeout(() => inp.focus(), 0); out.scrollTop = out.scrollHeight;
    };
    el.onclick = () => inp?.focus();
    const projDir = `/home/pi/${proj}`;
    const dirs: Record<string, string[]> = { '/home/pi': ['Desktop', 'Documents', 'Downloads', proj], '/home/pi/Desktop': [], '/home/pi/Documents': [], '/home/pi/Downloads': [] };
    const filesIn = (d: string) => {
      if (d === projDir) { const names = ws.names(); return [...new Set(names.map(n => n.split('/')[0]))]; }
      if (d.startsWith(projDir + '/')) { const sub = d.slice(projDir.length + 1) + '/'; return ws.names().filter(n => n.startsWith(sub)).map(n => n.slice(sub.length)); }
      return dirs[d] ?? null;
    };
    const resolve = (p: string) => {
      if (!p || p === '~') return '/home/pi';
      let parts = (p.startsWith('/') ? p : p.startsWith('~') ? '/home/pi' + p.slice(1) : cwd + '/' + p).split('/').filter(Boolean);
      const out2: string[] = []; for (const x of parts) { if (x === '.') continue; if (x === '..') out2.pop(); else out2.push(x); }
      return '/' + out2.join('/');
    };
    const isDir = (p: string) => filesIn(p) !== null && (p === projDir || p in dirs || ws.names().some(n => (projDir + '/' + n).startsWith(p + '/')));
    const fileOf = (p: string) => (p.startsWith(projDir + '/') ? p.slice(projDir.length + 1) : null);
    const feed = lineBuffer(t => { if (running) print(t, /^Traceback|Error\b/.test(t) ? 'perr' : ''); });
    const offOut = on('out', m => { if (!running) return; if (!m.cls) feed(m.text); else if (m.cls === 'e' || m.cls === 'w') print(m.text, m.cls === 'e' ? 'perr' : 'pwarn'); });
    const offStatus = on('status', m => { if (running && !m.running && m.text !== 'starting') { running = false; promptRow(); } });
    function key(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.ctrlKey && e.key === 'c') { e.preventDefault(); if (running) { print('^C'); send('stop'); running = false; } else { print(`pi@${cfg.host}:${short()} $ ${inp.value}^C`); inp.value = ''; } promptRow(); return; }
      if (e.ctrlKey && e.key === 'l') { e.preventDefault(); out.innerHTML = ''; promptRow(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (hi > 0) inp.value = hist[--hi]; return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] ?? ''; return; }
      if (e.key === 'Tab') {
        e.preventDefault(); const words = inp.value.split(' '), last = words.pop() ?? '', base = last.includes('/') ? last.slice(0, last.lastIndexOf('/') + 1) : '', stem = last.slice(base.length);
        const opts = (filesIn(resolve(base || '.')) ?? []).filter(n => n.startsWith(stem));
        if (opts.length === 1) { const full = base + opts[0]; inp.value = [...words, full + (isDir(resolve(full)) ? '/' : '')].join(' '); }
        else if (opts.length > 1) { print(`pi@${cfg.host}:${short()} $ ${inp.value}`); print(opts.join('  ')); promptRow(); inp.value = [...words, last].join(' '); }
        return;
      }
      if (e.key !== 'Enter') return;
      const line = inp.value; inp.value = '';
      print(`pi@${cfg.host}:${short()} $ ${line}`, 'pcmd');
      if (line.trim()) { hist.push(line); hi = hist.length; }
      exec(line.trim());
      if (!running) promptRow(); else out.querySelector('.prow')?.remove();
    }
    function exec(line: string) {
      let [cmd, ...args] = line.split(/\s+/);
      if (cmd === 'sudo') { [cmd, ...args] = args; }
      const p = args.filter(a => !a.startsWith('-'));
      switch (cmd) {
        case undefined: case '': return;
        case 'ls': { const d = resolve(p[0] ?? '.'), l = filesIn(d); if (!l) return print(`ls: cannot access '${p[0]}': No such file or directory`); if (args.includes('-l')) l.forEach(n => { const f = fileOf(d + '/' + n), dir = !f || isDir(d + '/' + n); print(`${dir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 pi pi ${String(dir ? 4096 : ws.text(f!).length).padStart(6)} ${new Date().toDateString().slice(4, 10)} ${n}`); }); else print(l.map(n => (isDir(d + '/' + n) ? n + '/' : n)).join('  ')); return; }
        case 'cd': { const d = resolve(p[0] ?? '~'); if (!isDir(d)) return print(`bash: cd: ${p[0]}: No such file or directory`); cwd = d; return; }
        case 'pwd': return print(cwd);
        case 'cat': case 'less': case 'head': { for (const a of p) { const f = fileOf(resolve(a)); if (!f || ws.files()[f] == null) print(`${cmd}: ${a}: No such file or directory`); else ws.text(f).split('\n').slice(0, cmd === 'head' ? 10 : undefined).forEach(l => print(l)); } return; }
        case 'echo': return print(args.join(' ').replace(/^["']|["']$/g, ''));
        case 'clear': out.innerHTML = ''; return;
        case 'whoami': return print('pi');
        case 'hostname': return print(args.includes('-I') ? '192.168.1.42 ' : cfg.host);
        case 'uname': return print(args.includes('-a') ? `Linux ${cfg.host} 6.6.51+rpt-rpi-2712 #1 SMP PREEMPT Debian 1:6.6.51-1+rpt3 aarch64 GNU/Linux` : 'Linux');
        case 'date': return print(new Date().toString());
        case 'history': return hist.forEach((h, i) => print(`${String(i + 1).padStart(5)}  ${h}`));
        case 'exit': exit(); return;
        case 'free': return print('               total        used        free\nMem:           7.9Gi       1.1Gi       6.2Gi'), undefined;
        case 'df': return print('Filesystem      Size  Used Avail Use% Mounted on\n/dev/mmcblk0p2   29G  5.8G   22G  21% /'), undefined;
        case 'vcgencmd': return print(args[0] === 'measure_temp' ? `temp=${(45 + Math.random() * 6).toFixed(1)}'C` : args[0] === 'get_throttled' ? 'throttled=0x0' : 'Usage: vcgencmd measure_temp | get_throttled');
        case 'ip': return print('2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet 192.168.1.42/24 brd 192.168.1.255 scope global dynamic wlan0');
        case 'pip': case 'pip3': return args[0] === 'install' ? print('error: externally-managed-environment\n\n× This environment is externally managed\n╰─> To install Python packages system-wide, try apt install\n    python3-xyz, where xyz is the package you are trying to\n    install.', 'perr') : print('Package    Version\n---------- -------\ngpiozero   2.0.1\nsmbus2     0.4.3\nspidev     3.6');
        case 'apt': case 'apt-get': return print(line.startsWith('sudo') ? 'Reading package lists... Done\nE: The preview has no network, so packages can’t be installed.' : 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock, are you root?', 'perr');
        case 'raspi-config': apps.config(); return print('Opened Raspberry Pi Configuration.');
        case 'thonny': case 'nano': case 'mousepad': case 'geany': { const f = p[0] ? fileOf(resolve(p[0])) : null; apps.thonny(); if (f) { if (ws.files()[f] == null) ws.create(f, ''); ws.open(f); } return; }
        case 'touch': { for (const a of p) { const f = fileOf(resolve(a)); if (!f) print(`touch: cannot touch '${a}': Permission denied`); else if (ws.files()[f] == null) ws.create(f, ''); } return; }
        case 'rm': { for (const a of p) { const f = fileOf(resolve(a)); if (!f || ws.files()[f] == null) print(`rm: cannot remove '${a}': No such file or directory`); else ws.remove(f); } return; }
        case 'mv': { const a = fileOf(resolve(p[0] ?? '')), c = fileOf(resolve(p[1] ?? '')); if (!a || !c) return print('mv: missing file operand'); ws.rename(a, c); return; }
        case 'pinout': return pinout();
        case 'i2cdetect': return i2cdetect();
        case 'pinctrl': case 'raspi-gpio': return print(state!.comps.flatMap(c => Object.entries(c.pins).filter(([, g]) => g != null).map(([r, g]) => `${String(g).padStart(2)}: ${/^(SDA|SCL)$/.test(r) && cfg.i2c ? 'a0' : 'ip'}    pu | ${'hi'} // GPIO${g} = ${c.name} ${r}`)).join('\n') || 'No GPIOs are wired.');
        case 'python': case 'python3': {
          if (!p[0]) return print('Python 3.11.2 (main, Nov 30 2024) [GCC 12.2.0] on linux\nThe interactive prompt isn’t available in this preview. Run a script: python3 main.py');
          const f = fileOf(resolve(p[0])); if (!f || ws.files()[f] == null) return print(`python3: can't open file '${resolve(p[0])}': [Errno 2] No such file or directory`, 'perr');
          const warn = needs(); if (warn) warn.split('\n').forEach(w => print(w, 'pwarn'));
          if (f !== 'main.py') print('(The project runs main.py, which imports your other files.)', 'pdim');
          running = true; setOwner('term'); send('run', { files: ws.pending() }); void tid; return;
        }
        case 'help': return print('Available here: ls cd pwd cat head echo clear touch rm mv python3 thonny nano pinout i2cdetect pinctrl raspi-config vcgencmd hostname uname date free df ip pip history exit');
        default: return print(`bash: ${cmd}: command not found`);
      }
    }
    function pinout() {
      const lab = new Map<number, string>(); state!.comps.forEach(c => Object.entries(c.pins).forEach(([r, g]) => { if (g != null) lab.set(g, `${c.name.split(' ').slice(0, 2).join(' ')} ${r}`); }));
      print(`Description        : ${b.name}`); print(`SoC                : ${b.chip}`); print('');
      print('J8:');
      for (let i = 0; i < 40; i += 2) {
        const L = HEADER[i], R = HEADER[i + 1], f = (x: number | string) => (typeof x === 'number' ? `GPIO${x}` : x);
        const ll = typeof L === 'number' && lab.get(L) ? `(${lab.get(L)}) ` : '', rl = typeof R === 'number' && lab.get(R) ? ` (${lab.get(R)})` : '';
        print(`${(ll + f(L)).padStart(34)} (${String(i + 1).padStart(2)}) (${String(i + 2).padStart(2)}) ${f(R)}${rl}`);
      }
      print(''); print('Wired parts are shown in brackets. Pin numbers are BCM GPIO numbers.', 'pdim');
    }
    function i2cdetect() {
      if (!cfg.i2c) return print('Error: Could not open file `/dev/i2c-1\' or `/dev/i2c/1\': No such file or directory', 'perr');
      const addrs = new Set(state!.comps.map(c => c.i2c).filter((a): a is number => a != null));
      print('     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f');
      for (let r = 0; r < 8; r++) { let s = `${(r * 16).toString(16).padStart(2, '0')}:`; for (let c = 0; c < 16; c++) { const a = r * 16 + c; s += a < 3 || a > 0x77 ? '   ' : addrs.has(a) ? ' ' + a.toString(16).padStart(2, '0') : ' --'; } print(s); }
    }
    print(`Linux ${cfg.host} 6.6.51+rpt-rpi-2712 aarch64`, 'pdim'); print('Type "help" for the commands this preview understands.', 'pdim');
    promptRow();
    return () => { offOut(); offStatus(); };
  }

  // ---------------------------------------------------------------- file manager
  function fileManager(el: HTMLElement, start: string) {
    el.classList.add('pfm');
    let dir = start; // '' = home, proj = project, proj/lib…
    el.innerHTML = `<div class="pfmbar"><button data-n="back" title="Back">←</button><button data-n="up" title="Up">↑</button><button data-n="home" title="Home">⌂</button><div class="pfmpath"></div></div><div class="pfmbody"><div class="pfmside"></div><div class="pfmgrid"></div></div><div class="pfmstat"></div>`;
    const back: string[] = [];
    const go = (d: string) => { back.push(dir); dir = d; paint(); };
    (el.querySelector('[data-n=back]') as HTMLElement).onclick = () => { if (back.length) { dir = back.pop()!; paint(); } };
    (el.querySelector('[data-n=up]') as HTMLElement).onclick = () => go(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
    (el.querySelector('[data-n=home]') as HTMLElement).onclick = () => go('');
    const paint = () => {
      (el.querySelector('.pfmpath') as HTMLElement).textContent = '/home/pi' + (dir ? '/' + dir : '');
      const side = el.querySelector('.pfmside') as HTMLElement;
      side.innerHTML = ['Home', 'Desktop', 'Documents', 'Downloads', proj].map(n => `<div class="pfms${(n === 'Home' ? '' : n) === dir ? ' on' : ''}" data-d="${n === 'Home' ? '' : esc(n)}">${n === proj ? '▸ ' : ''}${esc(n)}</div>`).join('');
      side.querySelectorAll<HTMLElement>('[data-d]').forEach(x => (x.onclick = () => go(x.dataset.d!)));
      const grid = el.querySelector('.pfmgrid') as HTMLElement; grid.innerHTML = '';
      let items: { n: string; dir: boolean; file?: string }[] = [];
      if (dir === '') items = ['Desktop', 'Documents', 'Downloads', proj].map(n => ({ n, dir: true }));
      else if (dir === proj || dir.startsWith(proj + '/')) {
        const sub = dir === proj ? '' : dir.slice(proj.length + 1) + '/';
        const names = ws.names().filter(n => n.startsWith(sub)).map(n => n.slice(sub.length));
        items = [...new Set(names.map(n => n.split('/')[0]))].map(n => ({ n, dir: names.some(x => x.startsWith(n + '/')), file: sub + n }));
      }
      items.sort((a, c) => Number(c.dir) - Number(a.dir) || a.n.localeCompare(c.n));
      for (const it of items) {
        const d = document.createElement('div'); d.className = 'pfi';
        d.innerHTML = `${it.dir ? IC.folder48 : it.n.endsWith('.py') ? IC.py48 : IC.txt48}<span></span>`; (d.querySelector('span') as HTMLElement).textContent = it.n;
        d.onclick = () => { grid.querySelectorAll('.pfi').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); };
        d.ondblclick = () => { if (it.dir) go(dir ? dir + '/' + it.n : it.n); else if (it.file) { apps.thonny(); ws.open(it.file); } };
        d.oncontextmenu = e => { e.preventDefault(); if (!it.file || it.dir) return; menu([{ label: 'Open with Thonny', act: () => { apps.thonny(); ws.open(it.file!); } }, { label: 'Rename…', act: async () => { const x = await ask('Rename', it.n, 'pi-m'); if (x && x !== it.n) ws.rename(it.file!, it.file!.replace(/[^/]+$/, x)); } }, { label: 'Move to Wastebasket', act: () => { if (confirm(`Delete ${it.n}?`)) ws.remove(it.file!); } }], e.clientX, e.clientY, 'pi-m'); };
        grid.appendChild(d);
      }
      grid.oncontextmenu = e => { if (e.target !== grid || !(dir === proj || dir.startsWith(proj + '/'))) return; e.preventDefault(); menu([{ label: 'New File…', act: async () => { const x = await ask('New file', 'untitled.py', 'pi-m'); if (x) ws.create((dir === proj ? '' : dir.slice(proj.length + 1) + '/') + x, ''); } }], e.clientX, e.clientY, 'pi-m'); };
      (el.querySelector('.pfmstat') as HTMLElement).textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
      if (!items.length) grid.innerHTML = '<div class="pfmempty">This folder is empty.</div>';
    };
    paint();
    const prev = ws.onChange; ws.onChange = () => { prev(); paint(); };
    return () => { ws.onChange = prev; };
  }

  // ---------------------------------------------------------------- Raspberry Pi Configuration
  function configApp(el: HTMLElement) {
    el.classList.add('pcfg');
    const tabs = ['System', 'Display', 'Interfaces', 'Performance', 'Localisation']; let cur = 'Interfaces';
    const paint = () => {
      el.innerHTML = `<div class="pctabs">${tabs.map(t => `<button class="${t === cur ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div><div class="pcbody"></div><div class="pcbtns"><button class="cancel">Cancel</button><button class="ok">OK</button></div>`;
      el.querySelectorAll<HTMLElement>('[data-t]').forEach(x => (x.onclick = () => { cur = x.dataset.t!; paint(); }));
      const body = el.querySelector('.pcbody') as HTMLElement;
      const row = (label: string, k: keyof typeof cfg) => `<div class="pcrow"><span>${label}</span><label class="sw"><input type="checkbox" data-k="${k}" ${cfg[k] ? 'checked' : ''}><i></i></label></div>`;
      if (cur === 'Interfaces') body.innerHTML = row('SSH', 'ssh') + row('VNC', 'vnc') + row('SPI', 'spi') + row('I2C', 'i2c') + row('Serial Port', 'serial') + row('1-Wire', 'onewire') + '<p class="pcnote">Parts on the I2C or SPI pins need that interface turned on, just like on a real Pi.</p>';
      else if (cur === 'System') body.innerHTML = `<div class="pcrow"><span>Hostname</span><input data-h value="${esc(cfg.host)}"></div><div class="pcrow"><span>Boot</span><span class="dim">To desktop</span></div><div class="pcrow"><span>Board</span><span class="dim">${esc(b.name)} · ${esc(b.chip)}</span></div>`;
      else body.innerHTML = `<p class="pcnote">Nothing to change here in the preview.</p>`;
      body.querySelectorAll<HTMLInputElement>('[data-k]').forEach(x => (x.onchange = () => { (cfg as any)[x.dataset.k!] = x.checked; }));
      const h = body.querySelector<HTMLInputElement>('[data-h]'); if (h) { h.onkeydown = e => e.stopPropagation(); h.oninput = () => { cfg.host = h.value.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'raspberrypi'; }; }
      (el.querySelector('.ok') as HTMLElement).onclick = () => { saveCfg(); document.title = `${cfg.host} — ${b.name} (Formframe)`; const w = wins.find(x => x.app === 'config'); if (w) close(w); };
      (el.querySelector('.cancel') as HTMLElement).onclick = () => { Object.assign(cfg, JSON.parse(localStorage.getItem(cfgKey) ?? '{}')); const w = wins.find(x => x.app === 'config'); if (w) close(w); };
    };
    paint();
  }

  boot();
  setTimeout(() => apps.thonny(), 400);
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
