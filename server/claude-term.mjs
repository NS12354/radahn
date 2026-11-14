// Claude Code inside the studio's Electronics panel.
//
// The browser opens a WebSocket to /api/claude/term?project=<id>. We mirror
// the project's code files into a workspace folder (~/.formframe/workspaces/<id>),
// write a CLAUDE.md describing the board and wiring (plus wiring.json, which
// Claude can edit, and PARTS.md, the catalog it can pick parts from), and run the real `claude`
// CLI there in a pseudo-terminal. Keystrokes and screen output stream over the
// socket; files Claude changes on disk are sent back to the studio, and edits
// made in the studio are written to disk, so both sides stay in step.
//
// This runs commands on the machine that hosts the server, so it only accepts
// connections from this computer (loopback address + same-origin page).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.FF_WORKSPACES || path.join(os.homedir(), '.formframe', 'workspaces');
const CODE = /\.(py|ino|h|hpp|c|cpp)$/i;
const MAX = 1_000_000;
// code files, plus the bench wiring (edits to it are validated and approved in the studio)
const synced = (n) => CODE.test(n) || n === 'wiring.json';
const DOCS = new Set(['CLAUDE.md', 'PARTS.md']); // written for Claude to read; not synced back
const SKIP = /(^|\/)(\.|node_modules\/|__pycache__\/|build\/)/; // dot-files/folders (.claude, .git), caches

function findClaude() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try { return execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim() || null; }
  catch { return null; }
}
/**
 * Environment for the embedded `claude`: the server's own environment minus
 * Anthropic credentials (the studio's ANTHROPIC_API_KEY from .env is for the
 * studio's features, and would override your Claude Code login) and minus any
 * Claude Code session variables inherited from whatever launched the server
 * (they make claude act as a sub-session, e.g. not saving its transcript).
 * Claude Code then uses your normal login and keeps its own history.
 */
export function termEnv(src = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID$|CLAUDE_EFFORT$|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$|ANTHROPIC_BASE_URL$)/.test(k)) continue;
    env[k] = v;
  }
  // opt-in: a key just for the terminal, if you'd rather it bill an API key than your login
  if (src.CLAUDE_TERM_API_KEY) env.ANTHROPIC_API_KEY = src.CLAUDE_TERM_API_KEY;
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' };
}
const loopback = (a = '') => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const safeName = (n) => typeof n === 'string' && n.length < 200 && !n.startsWith('/') && !n.split('/').includes('..') && !n.includes('\\') && !n.includes('\0');

/** Every code file under dir, as workspace-relative paths. */
function listCode(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (SKIP.test(r + (d.isDirectory() ? '/' : ''))) continue;
    if (d.isDirectory()) out.push(...listCode(dir, r));
    else if (synced(r)) out.push(r);
  }
  return out;
}

export async function claudeTermApi(server) {
  const [{ WebSocketServer }, pty] = await Promise.all([import('ws'), import('node-pty').then(m => m.default ?? m).catch(() => null)]);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8e6 });
  server.httpServer?.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.endsWith('/api/claude/term')) return; // Vite's own HMR socket etc.
    const origin = req.headers.origin ?? '';
    let sameOrigin = false; try { sameOrigin = new URL(origin).host === req.headers.host; } catch { }
    if (!loopback(req.socket.remoteAddress) || !sameOrigin) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, ws => session(ws, url.searchParams.get('project') ?? ''));
  });

  function session(ws, project) {
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    if (!/^[\w-]{1,80}$/.test(project)) { send({ t: 'error', msg: 'Open a project first.' }); return ws.close(); }
    if (!pty) { send({ t: 'error', msg: 'The terminal component (node-pty) is not installed. Run: npm install' }); return ws.close(); }
    const dir = path.join(ROOT, project);
    fs.mkdirSync(dir, { recursive: true });
    const known = new Map(); // name → content we last wrote or sent (suppresses echoes)
    let term = null, watcher = null;
    const timers = new Map();

    const write = (name, content) => {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      known.set(name, content);
      if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== content) fs.writeFileSync(p, content);
    };
    const writeDocs = (docs) => { for (const [n, c] of Object.entries(docs ?? {})) if (DOCS.has(n) && typeof c === 'string') fs.writeFileSync(path.join(dir, n), c); };
    const remove = (name) => { known.delete(name); fs.rmSync(path.join(dir, name), { force: true }); };

    function onDisk(name) {
      if (!safeName(name) || SKIP.test(name) || !synced(name)) return;
      clearTimeout(timers.get(name));
      timers.set(name, setTimeout(() => {
        timers.delete(name);
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) { if (known.has(name)) { known.delete(name); send({ t: 'delete', name }); } return; }
        const st = fs.statSync(p); if (!st.isFile() || st.size > MAX) return;
        const content = fs.readFileSync(p, 'utf8');
        if (known.get(name) === content) return;
        known.set(name, content); send({ t: 'file', name, content });
      }, 120));
    }
    function watch() {
      watcher = fs.watch(dir, { recursive: true }, (_e, f) => f && onDisk(String(f).split(path.sep).join('/')));
      watcher.on('error', () => { });
    }

    function start(cols, rows) {
      if (term) return;
      const bin = findClaude();
      if (!bin) { send({ t: 'error', msg: 'Claude Code is not installed on this computer. Install it with: npm install -g @anthropic-ai/claude-code   (then press Restart)' }); return; }
      try {
        term = pty.spawn(bin, [], { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: dir, env: termEnv() });
      } catch (e) { send({ t: 'error', msg: `Couldn't start Claude Code: ${e.message}` }); return; }
      term.onData(d => send({ t: 'out', d }));
      term.onExit(({ exitCode }) => { term = null; send({ t: 'exit', code: exitCode }); });
      send({ t: 'started', dir });
    }

    ws.on('message', raw => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      try {
        if (m.t === 'sync') {
          // the studio's files are the truth when a session starts
          const files = m.files ?? {};
          for (const [n, c] of Object.entries(files)) if (safeName(n) && synced(n) && typeof c === 'string') write(n, c);
          for (const n of listCode(dir)) if (!(n in files)) remove(n);
          writeDocs(m.docs);
          if (!watcher) watch();
        } else if (m.t === 'file' && safeName(m.name) && synced(m.name) && typeof m.content === 'string') write(m.name, m.content);
        else if (m.t === 'delete' && safeName(m.name)) remove(m.name);
        else if (m.t === 'docs') writeDocs(m.docs);
        else if (m.t === 'start') start(m.cols, m.rows);
        else if (m.t === 'restart') { term?.kill(); term = null; start(m.cols, m.rows); }
        else if (m.t === 'in' && typeof m.d === 'string') term?.write(m.d);
        else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) term?.resize(Math.min(500, m.cols | 0), Math.min(200, m.rows | 0));
      } catch (e) { send({ t: 'error', msg: e.message }); }
    });
    ws.on('close', () => { term?.kill(); watcher?.close(); for (const t of timers.values()) clearTimeout(t); });
  }
}
