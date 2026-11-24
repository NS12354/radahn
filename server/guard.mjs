// Who pays for the AI features (Plan AI, part-from-URL).
//
//  - Hosted (Vercel): only visitors' own Anthropic keys (aikey.mjs). The site's
//    key is never used, so a public deployment can't spend the owner's credits.
//    Each visitor gets FF_OWN_KEY_PER_HOUR requests an hour (default 120), which
//    only stops the site being used as a free relay.
//  - Local dev server (no VERCEL env): an own key if one is saved, otherwise the
//    developer's ANTHROPIC_API_KEY from .env, as before.
import { ownKey } from './aikey.mjs';

const hosted = () => !!process.env.VERCEL;
const ownPerHour = () => Math.max(1, +(process.env.FF_OWN_KEY_PER_HOUR ?? 120) || 120);
const hits = new Map(); // ip -> timestamps (ms) in the last hour

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
 * back, or { apiKey }: the visitor's own key, or undefined for the local .env key.
 */
export function aiAccess(headers) {
  const own = ownKey(headers.cookie);
  if (own) { const stop = limit(clientIp(headers), ownPerHour()); return stop ? { stop } : { apiKey: own }; }
  if (hosted()) return { stop: { status: 401, body: { error: 'AI features need your own Anthropic API key.', needKey: true } } };
  return { apiKey: undefined };
}
