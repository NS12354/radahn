// Protects the features that spend the owner's Anthropic credits (Plan AI,
// part-from-URL) when the studio is hosted publicly.
//
//  - Access code: set FF_ACCESS_CODE on the host. Callers send it in the
//    `x-ff-access` header (the studio asks for it once and remembers it in the
//    browser). Hosted without a code configured, the site's key is never used:
//    this fails closed, and visitors can still bring their own key.
//  - Rate limit: FF_AI_PER_HOUR calls per visitor (IP) per hour, default 20.
//    Counts live in memory, so each server instance keeps its own tally; it is
//    a brake on runaway use, and the access code is the real gate.
//
//  - Own key: a visitor who saved their own Anthropic key (aikey.mjs) skips
//    both, and the request runs on their account. They get a looser cap
//    (FF_OWN_KEY_PER_HOUR, default 120) that only stops this site being used
//    as a free relay.
//
// On the local dev server (no VERCEL env) the code check is skipped unless
// FF_ACCESS_CODE is set, so `npm run dev` keeps working as before.
import crypto from 'node:crypto';
import { ownKey } from './aikey.mjs';

const hosted = () => !!process.env.VERCEL;
const perHour = () => Math.max(1, +(process.env.FF_AI_PER_HOUR ?? 20) || 20);
const ownPerHour = () => Math.max(1, +(process.env.FF_OWN_KEY_PER_HOUR ?? 120) || 120);
const hits = new Map(); // 'owner|ip' or 'own|ip' -> timestamps (ms) in the last hour

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function sameCode(given, want) { return crypto.timingSafeEqual(sha(given), sha(want)); }

export function clientIp(headers) {
  const h = (k) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  return String(h('x-real-ip') ?? h('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
}

function limit(bucket, max) {
  const now = Date.now(), hour = 3600_000;
  const list = (hits.get(bucket) ?? []).filter(t => now - t < hour);
  if (list.length >= max) {
    const wait = Math.ceil((hour - (now - list[0])) / 60_000);
    hits.set(bucket, list);
    return { status: 429, body: { error: `You've reached the limit of ${max} AI requests an hour. Try again in about ${wait} minute${wait === 1 ? '' : 's'}.` } };
  }
  list.push(now); hits.set(bucket, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < hour)) hits.delete(k);
  return null;
}

/**
 * Decide how an AI request runs. Returns { stop } with { status, body } to send
 * back, or { apiKey } (the visitor's own key, or undefined for the site's key).
 */
export function aiAccess(headers) {
  const own = ownKey(headers.cookie);
  if (own) { const stop = limit('own|' + clientIp(headers), ownPerHour()); return stop ? { stop } : { apiKey: own }; }
  const stop = guardAI(headers);
  return stop ? { stop } : { apiKey: undefined };
}

/** The site's own key: access code + per-visitor cap. Returns null when it may go ahead, else { status, body }. */
export function guardAI(headers) {
  const code = process.env.FF_ACCESS_CODE ?? '';
  if (!code) {
    if (hosted()) return { status: 401, body: { error: 'This site has no shared AI access. Use your own Anthropic API key.', needCode: true, noShared: true } };
    return null; // local dev server
  }
  const raw = headers['x-ff-access'];
  const given = String((Array.isArray(raw) ? raw[0] : raw) ?? '');
  if (!given) return { status: 401, body: { error: 'This feature needs the access code or your own Anthropic API key.', needCode: true } };
  if (!sameCode(given, code)) return { status: 401, body: { error: 'That access code is not right.', needCode: true, wrong: true } };
  return limit('owner|' + clientIp(headers), perHour());
}
