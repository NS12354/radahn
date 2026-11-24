// Protects the features that spend the owner's Anthropic credits (Plan AI,
// part-from-URL) when the studio is hosted publicly.
//
//  - Access code: set FF_ACCESS_CODE on the host. Callers send it in the
//    `x-ff-access` header (the studio asks for it once and remembers it in the
//    browser). Hosted without a code configured, the AI features stay off:
//    this fails closed so a missing setting never opens up the key.
//  - Rate limit: FF_AI_PER_HOUR calls per visitor (IP) per hour, default 20.
//    Counts live in memory, so each server instance keeps its own tally; it is
//    a brake on runaway use, and the access code is the real gate.
//
// On the local dev server (no VERCEL env) both checks are skipped unless
// FF_ACCESS_CODE is set, so `npm run dev` keeps working as before.
import crypto from 'node:crypto';

const hosted = () => !!process.env.VERCEL;
const perHour = () => Math.max(1, +(process.env.FF_AI_PER_HOUR ?? 20) || 20);
const hits = new Map(); // ip -> timestamps (ms) in the last hour

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function sameCode(given, want) { return crypto.timingSafeEqual(sha(given), sha(want)); }

export function clientIp(headers) {
  const h = (k) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  return String(h('x-real-ip') ?? h('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
}

/**
 * Check an AI request. Returns null when it may go ahead, otherwise
 * { status, body } to send back as JSON.
 */
export function guardAI(headers) {
  const code = process.env.FF_ACCESS_CODE ?? '';
  if (!code) {
    if (hosted()) return { status: 503, body: { error: 'AI features are switched off on this site (no access code is set up).' } };
    return null; // local dev server
  }
  const raw = headers['x-ff-access'];
  const given = String((Array.isArray(raw) ? raw[0] : raw) ?? '');
  if (!given) return { status: 401, body: { error: 'This feature needs the access code.', needCode: true } };
  if (!sameCode(given, code)) return { status: 401, body: { error: 'That access code is not right.', needCode: true, wrong: true } };

  const ip = clientIp(headers), now = Date.now(), hour = 3600_000;
  const list = (hits.get(ip) ?? []).filter(t => now - t < hour);
  if (list.length >= perHour()) {
    const wait = Math.ceil((hour - (now - list[0])) / 60_000);
    hits.set(ip, list);
    return { status: 429, body: { error: `You've reached the limit of ${perHour()} AI requests an hour. Try again in about ${wait} minute${wait === 1 ? '' : 's'}.` } };
  }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < hour)) hits.delete(k);
  return null;
}
