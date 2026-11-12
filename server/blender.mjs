// Live link between the Formframe studio (browser) and Blender.
//
// The dev server is the hub: the studio pushes the project's model here, the
// Blender add-on (blender/formframe_link.py) polls for it, and sends its own
// version back the same way. Each push bumps a per-project revision; a poller
// only gets versions written by the other side.
//
//   POST /api/blender/open   { project, name }        launch Blender with the add-on
//   POST /api/blender/push   { project, from, model }  from: 'formframe' | 'blender'
//   GET  /api/blender/poll?project=&since=&for=        newer model from the other side
//   GET  /api/blender/projects                         projects waiting for Blender
//   GET  /api/blender/addon                            the add-on file, for manual install
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADDON = path.join(here, '..', 'blender', 'formframe_link.py');
const state = new Map(); // project → { rev, from, model, name, seen: { blender, formframe }, pid }

const CANDIDATES = [process.env.BLENDER_PATH, '/Applications/Blender.app/Contents/MacOS/Blender', '/Applications/Blender.app/Contents/MacOS/blender', '/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', 'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe'].filter(Boolean);
export const blenderPath = () => CANDIDATES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;

const entry = id => { if (!state.has(id)) state.set(id, { rev: 0, from: null, model: null, name: '', seen: {}, pid: null }); return state.get(id); };
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const ID = /^[\w-]{1,64}$/;

function readBody(req) {
  return new Promise((res, rej) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 50e6) { rej(new Error('Model too large')); req.destroy(); } });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(new Error('Bad JSON')); } });
  });
}

export function blenderApi(server) {
  server.middlewares.use('/api/blender', async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const route = url.pathname.replace(/^\/+/, '');
      if (req.method === 'GET' && route === 'addon') { res.setHeader('content-type', 'text/x-python'); res.setHeader('content-disposition', 'attachment; filename="formframe_link.py"'); return res.end(fs.readFileSync(ADDON)); }
      if (req.method === 'GET' && route === 'projects') return send(200, { projects: [...state.entries()].filter(([, s]) => s.model).map(([id, s]) => ({ id, name: s.name, rev: s.rev })) });
      if (req.method === 'GET' && route === 'poll') {
        const id = url.searchParams.get('project') ?? '', since = +(url.searchParams.get('since') ?? 0), who = url.searchParams.get('for');
        if (!ID.test(id) || (who !== 'blender' && who !== 'formframe')) return send(400, { error: 'bad request' });
        const s = entry(id); s.seen[who] = Date.now();
        const other = who === 'blender' ? 'formframe' : 'blender';
        const status = { rev: s.rev, blender: Date.now() - (s.seen.blender ?? 0) < 4000, formframe: Date.now() - (s.seen.formframe ?? 0) < 4000 };
        if (s.model && s.rev > since && s.from === other) return send(200, { ...status, from: s.from, model: s.model });
        return send(200, status);
      }
      if (req.method === 'POST' && route === 'push') {
        const { project, from, model } = await readBody(req);
        if (!ID.test(project ?? '') || (from !== 'blender' && from !== 'formframe') || !model) return send(400, { error: 'bad request' });
        const s = entry(project); s.rev++; s.from = from; s.model = model; s.name = model.name ?? s.name; s.seen[from] = Date.now();
        return send(200, { rev: s.rev });
      }
      if (req.method === 'POST' && route === 'open') {
        const { project, name } = await readBody(req);
        if (!ID.test(project ?? '')) return send(400, { error: 'bad request' });
        const s = entry(project); s.name = name ?? s.name;
        if (alive(s.pid) || Date.now() - (s.seen.blender ?? 0) < 4000) return send(200, { already: true });
        const exe = blenderPath();
        if (!exe) return send(404, { error: 'Blender was not found. Install it, or set BLENDER_PATH to the Blender executable and restart `npm run dev`.' });
        const origin = `http://${req.headers.host ?? 'localhost:5173'}`;
        const child = spawn(exe, ['--python', ADDON, '--', '--formframe-server', origin, '--formframe-project', project], { detached: true, stdio: 'ignore' });
        child.unref(); s.pid = child.pid;
        return send(200, { launched: true, pid: child.pid });
      }
      send(404, { error: 'not found' });
    } catch (e) { send(400, { error: e.message }); }
  });
}
