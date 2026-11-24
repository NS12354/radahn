// "Use your own Anthropic key": a visitor's key is checked with Anthropic, then
// kept in an encrypted httpOnly cookie (seal.mjs), never on the server and never
// readable by the page's JavaScript. AI requests that carry it run on the
// visitor's own account, so they skip the site's access code.
//
//   GET  /api/ai-key            → { ownKey, hint, ownerKey }
//   POST /api/ai-key { key }    → check and save it
//   POST /api/ai-key { remove } → forget it
import { readCookie, cookieValue, sealKey } from './seal.mjs';

export const AI_COOKIE = 'ff_ai';
const MAX_AGE = 30 * 24 * 3600;
const FORMAT = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const hint = (k) => `${k.slice(0, 10)}…${k.slice(-4)}`;

/** The visitor's own key from the request cookie, or null. */
export function ownKey(cookieHeader) {
  try { const k = readCookie(cookieHeader, AI_COOKIE).key; return typeof k === 'string' && FORMAT.test(k) ? k : null; }
  catch { return null; } // site has no session secret: no own keys
}

/** Ask Anthropic whether a key works (lists models: free, uses no tokens). */
async function check(key) {
  const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) throw Object.assign(new Error('Could not reach Anthropic to check the key. Try again.'), { status: 502 });
  if (r.status === 401) throw Object.assign(new Error('Anthropic says that key isn’t valid. Check you copied all of it.'), { status: 400 });
  if (r.status === 403) throw Object.assign(new Error('That key isn’t allowed to use the API (check its permissions in the Anthropic Console).'), { status: 400 });
  if (!r.ok) throw Object.assign(new Error(`Anthropic answered ${r.status} while checking the key. Try again.`), { status: 502 });
}

export async function aiKeyRoute({ method, body, cookie, contentType, secure }) {
  const opts = { path: '/api', maxAge: MAX_AGE, secure };
  try {
    sealKey();
    if (method === 'GET') {
      const k = ownKey(cookie);
      return { status: 200, json: { ownKey: !!k, hint: k ? hint(k) : null, ownerKey: !!process.env.FF_ACCESS_CODE || !process.env.VERCEL } };
    }
    if (method !== 'POST') return { status: 405, json: { error: 'GET or POST' } };
    if (!String(contentType ?? '').startsWith('application/json')) return { status: 415, json: { error: 'JSON only' } };
    if (body?.remove) return { status: 200, json: { ownKey: false }, cookie: cookieValue(AI_COOKIE, null, opts) };
    const key = String(body?.key ?? '').trim();
    if (!FORMAT.test(key)) return { status: 400, json: { error: 'That doesn’t look like an Anthropic API key (it starts with sk-ant-).' } };
    await check(key);
    return { status: 200, json: { ownKey: true, hint: hint(key) }, cookie: cookieValue(AI_COOKIE, { key }, opts) };
  } catch (e) { return { status: e.status ?? 400, json: { error: e.message } }; }
}
