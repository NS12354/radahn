// GitHub for the studio's GitHub tab: sign in (OAuth device flow, or a
// personal access token), list repositories, browse a branch, read files.
//
// The access token never reaches the browser's JavaScript: it is kept in an
// encrypted, httpOnly cookie (AES-256-GCM) and every GitHub call goes through
// here. Nothing is stored on the server, so this works the same on the local
// dev server and on a serverless host (Vercel), where each request may land on
// a fresh instance. The key comes from FF_SESSION_SECRET; without one (local
// dev only) a random key is made per server start, which signs you out on restart.
import crypto from 'node:crypto';

const API = 'https://api.github.com';
const COOKIE = 'ff_gh';
const SCOPES = 'repo read:user';
const MAX_FILE = 1_000_000;
const MAX_AGE = 30 * 24 * 3600; // seconds

let devKey = null;
function key() {
  const secret = process.env.FF_SESSION_SECRET;
  if (secret) return crypto.createHash('sha256').update(secret).digest();
  if (process.env.VERCEL) throw Object.assign(new Error('GitHub sign-in is not set up on this site (FF_SESSION_SECRET is missing).'), { status: 503 });
  return (devKey ??= crypto.randomBytes(32));
}
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function open(raw) {
  try {
    const b = Buffer.from(raw, 'base64url'); if (b.length < 29) return {};
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch (e) { if (e.status) throw e; return {}; } // tampered, old key, or garbage: treat as signed out
}
function readSession(cookieHeader) {
  const m = String(cookieHeader ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  return m ? open(m[1]) : {};
}
function sessionCookie(s, secure) {
  const empty = !s.token && !s.device;
  return `${COOKIE}=${empty ? '' : seal(s)}; HttpOnly; SameSite=Lax; Path=/api/github; Max-Age=${empty ? 0 : MAX_AGE}${secure ? '; Secure' : ''}`;
}

const clientId = () => process.env.GITHUB_CLIENT_ID || '';
async function gh(token, path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Formframe', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
  if (r.status === 401) throw Object.assign(new Error('GitHub sign-in expired. Sign in again.'), { status: 401 });
  if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw Object.assign(new Error('GitHub rate limit reached. Try again in a few minutes.'), { status: 429 });
  if (r.status === 404) throw Object.assign(new Error('Not found on GitHub (or this token can\'t see it).'), { status: 404 });
  if (!r.ok) throw Object.assign(new Error(`GitHub answered ${r.status}.`), { status: 502 });
  return r.json();
}
const seg = (s) => String(s ?? '').split('/').map(encodeURIComponent).join('/');
const REPO = /^[\w.-]+\/[\w.-]+$/;
const user = (u) => ({ login: u.login, name: u.name, avatar: u.avatar_url });

function readBody(req) {
  return new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) { rej(new Error('Too large')); req.destroy(); } }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { rej(new Error('Bad JSON')); } }); });
}

/**
 * One GitHub API request, independent of the server framework.
 * route: path after /api/github/ (e.g. "tree"); q: URLSearchParams; body: parsed JSON (POST).
 * Returns { status, json, cookie? } where cookie is a Set-Cookie value to send.
 */
export async function githubRoute({ method, route, q, body, cookie, contentType, secure }) {
  let changed = false, s = {}, status = 200, json;
  const send = (code, obj) => { status = code; json = obj; };
  const save = (next) => { s = next; changed = true; };
  try {
    key(); // fails clearly when a hosted site has no FF_SESSION_SECRET
    s = readSession(cookie);
    if (method === 'POST' && !String(contentType ?? '').startsWith('application/json')) send(415, { error: 'JSON only' }); // blocks cross-site form posts
    else await handle();
  } catch (e) { send(e.status ?? 400, { error: e.message }); }
  return { status, json, cookie: changed ? sessionCookie(s, secure) : undefined };

  async function handle() {
      if (route === 'status') return send(200, { signedIn: !!s.token, user: s.user ?? null, deviceFlow: !!clientId(), hosted: !!process.env.VERCEL });

      // ---- sign in with a personal access token
      if (route === 'token' && method === 'POST') {
        const { token } = body ?? {};
        if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(String(token ?? '').trim())) return send(400, { error: 'That doesn\'t look like a GitHub token (it starts with ghp_ or github_pat_).' });
        const u = await gh(token.trim(), '/user');
        save({ token: token.trim(), user: user(u) });
        return send(200, { signedIn: true, user: s.user });
      }
      // ---- sign in with GitHub (device flow: the user types a code on github.com)
      if (route === 'device/start' && method === 'POST') {
        if (!clientId()) return send(400, { error: 'Sign in with GitHub needs GITHUB_CLIENT_ID in .env (an OAuth app with device flow enabled).' });
        const r = await fetch('https://github.com/login/device/code', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId(), scope: SCOPES }) });
        const j = await r.json();
        if (!r.ok || j.error) return send(400, { error: j.error_description ?? 'GitHub refused the sign-in request. Is device flow enabled for the OAuth app?' });
        save({ ...s, device: { code: j.device_code, interval: j.interval ?? 5, expires: Date.now() + j.expires_in * 1000 } });
        return send(200, { userCode: j.user_code, verifyUrl: j.verification_uri, interval: s.device.interval, expiresIn: j.expires_in });
      }
      if (route === 'device/poll' && method === 'POST') {
        if (!s.device) return send(400, { error: 'No sign-in in progress.' });
        if (Date.now() > s.device.expires) { save({ ...s, device: undefined }); return send(200, { status: 'expired' }); }
        const r = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId(), device_code: s.device.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
        const j = await r.json();
        if (j.access_token) { const u = await gh(j.access_token, '/user'); save({ token: j.access_token, user: user(u) }); return send(200, { status: 'ok', user: s.user }); }
        if (j.error === 'slow_down') { save({ ...s, device: { ...s.device, interval: s.device.interval + 5 } }); return send(200, { status: 'pending', interval: s.device.interval }); }
        if (j.error === 'authorization_pending') return send(200, { status: 'pending', interval: s.device.interval });
        save({ ...s, device: undefined });
        return send(200, { status: j.error === 'access_denied' ? 'denied' : 'expired' });
      }
      if (route === 'logout' && method === 'POST') { save({}); return send(200, { signedIn: false }); }

      if (!s.token) return send(401, { error: 'Sign in to GitHub first.' });
      // ---- browse
      if (route === 'repos') {
        const list = await gh(s.token, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
        return send(200, { repos: list.map(r => ({ full: r.full_name, private: r.private, branch: r.default_branch, updated: r.pushed_at, description: r.description, language: r.language })) });
      }
      const repo = q.get('repo') ?? '';
      if (!REPO.test(repo)) return send(400, { error: 'Bad repository name.' });
      if (route === 'branches') {
        const list = await gh(s.token, `/repos/${seg(repo)}/branches?per_page=100`);
        return send(200, { branches: list.map(b => b.name) });
      }
      if (route === 'tree') {
        const ref = q.get('ref') || (await gh(s.token, `/repos/${seg(repo)}`)).default_branch;
        const t = await gh(s.token, `/repos/${seg(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
        return send(200, { ref, truncated: !!t.truncated, items: t.tree.filter(x => x.type === 'blob' || x.type === 'tree').map(x => ({ path: x.path, dir: x.type === 'tree', size: x.size ?? 0 })) });
      }
      if (route === 'file') {
        const path = q.get('path') ?? '', ref = q.get('ref') ?? '';
        if (!path || path.includes('..')) return send(400, { error: 'Bad path.' });
        const f = await gh(s.token, `/repos/${seg(repo)}/contents/${seg(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
        if (Array.isArray(f) || f.type !== 'file') return send(400, { error: 'That is a folder.' });
        if (f.size > MAX_FILE) return send(400, { error: `${path} is over 1 MB.` });
        const buf = Buffer.from(f.content ?? '', 'base64');
        if (buf.subarray(0, 8000).includes(0)) return send(400, { error: `${path} is a binary file.` });
        return send(200, { path, content: buf.toString('utf8'), sha: f.sha });
      }
      send(404, { error: 'not found' });
  }
}

/** Local dev server (Vite middleware). */
export function githubApi(server) {
  server.middlewares.use('/api/github', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let body = {};
    if (req.method === 'POST') { try { body = await readBody(req); } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: e.message })); } }
    const r = await githubRoute({ method: req.method, route: url.pathname.replace(/^\/+/, ''), q: url.searchParams, body, cookie: req.headers.cookie, contentType: req.headers['content-type'], secure: false });
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    if (r.cookie) res.setHeader('set-cookie', r.cookie);
    res.statusCode = r.status; res.end(JSON.stringify(r.json));
  });
}
