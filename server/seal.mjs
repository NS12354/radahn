// Encrypted cookie values (AES-256-GCM) for things that must stay out of the
// page's JavaScript and off the server's disk: GitHub tokens, visitors' own
// Anthropic keys. The key comes from FF_SESSION_SECRET; without one (local dev
// only) a random key is made per server start, which signs everyone out on restart.
import crypto from 'node:crypto';

let devKey = null;
export function sealKey() {
  const secret = process.env.FF_SESSION_SECRET;
  if (secret) return crypto.createHash('sha256').update(secret).digest();
  if (process.env.VERCEL) throw Object.assign(new Error('Sign-in is not set up on this site (FF_SESSION_SECRET is missing).'), { status: 503 });
  return (devKey ??= crypto.randomBytes(32));
}
export function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
export function unseal(raw) {
  try {
    const b = Buffer.from(raw, 'base64url'); if (b.length < 29) return {};
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch (e) { if (e.status) throw e; return {}; } // tampered, old key, or garbage: treat as empty
}
/** The sealed object in cookie `name`, or {}. */
export function readCookie(cookieHeader, name) {
  const m = String(cookieHeader ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`));
  return m ? unseal(m[1]) : {};
}
/** Set-Cookie value: sealed `obj`, or a deletion when `obj` is null. */
export function cookieValue(name, obj, { path, maxAge, secure }) {
  return `${name}=${obj ? seal(obj) : ''}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${obj ? maxAge : 0}${secure ? '; Secure' : ''}`;
}
