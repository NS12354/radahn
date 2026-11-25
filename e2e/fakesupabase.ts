import type { Page, BrowserContext } from '@playwright/test';

/**
 * A stand-in for Supabase (Auth + the `documents` table) for the browser tests.
 * Rows live in `db`, shared by every page that uses the same instance, like two
 * computers signed in to one account. It enforces "your own rows only" the way
 * the real row-level security policies do.
 */
export function fakeSupabase(opts: { confirmEmail?: boolean } = {}) {
  const users = new Map<string, { id: string; email: string; password: string }>();
  /** Emails "sent": the newest code for each address and what it's for. */
  const mail: { email: string; code: string; type: 'email' | 'recovery' }[] = [];
  const sendCode = (email: string, type: 'email' | 'recovery') => { mail.push({ email, code: String(100000 + mail.length * 7919 % 900000), type }); };
  const db: any[] = [];
  const tokens = new Map<string, string>(); // access token -> user id
  let n = 0;
  const session = (u: { id: string; email: string }) => {
    const t = `tok-${u.id}-${++n}`; tokens.set(t, u.id);
    const user = { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    return { access_token: t, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `r-${t}`, user };
  };
  const who = (h: Record<string, string>) => tokens.get((h.authorization ?? '').replace(/^Bearer /, ''));
  const filters = (u: URL) => [...u.searchParams].filter(([k, v]) => k !== 'select' && v.startsWith('eq.')).map(([k, v]) => [k, decodeURIComponent(v.slice(3))] as const);
  const match = (row: any, f: (readonly [string, string])[]) => f.every(([k, v]) => String(row[k]) === v);

  async function attach(target: Page | BrowserContext) {
    await target.route('https://supabase.test/**', async route => {
      const r = route.request(), u = new URL(r.url()), h = r.headers();
      const json = (status: number, body?: unknown) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      // ---- auth
      if (u.pathname === '/auth/v1/signup') {
        const { email, password } = r.postDataJSON();
        const usr = { id: `user-${users.size + 1}`, email, password }; users.set(email, usr);
        if (opts.confirmEmail) { sendCode(email, 'email'); return json(200, session(usr).user); } // no session until the code is entered
        return json(200, session(usr));
      }
      if (u.pathname === '/auth/v1/otp') {
        const { email } = r.postDataJSON();
        if (!users.has(email)) users.set(email, { id: `user-${users.size + 1}`, email, password: '' });
        sendCode(email, 'email'); return json(200, {});
      }
      if (u.pathname === '/auth/v1/recover') { const { email } = r.postDataJSON(); if (users.has(email)) sendCode(email, 'recovery'); return json(200, {}); }
      if (u.pathname === '/auth/v1/resend') { const { email } = r.postDataJSON(); sendCode(email, 'email'); return json(200, {}); }
      if (u.pathname === '/auth/v1/verify') {
        const { email, token, type } = r.postDataJSON();
        const last = [...mail].reverse().find(m => m.email === email);
        const usr = users.get(email);
        if (!usr || !last || last.code !== token || (last.type === 'recovery') !== (type === 'recovery')) return json(403, { code: 'otp_expired', msg: 'Token has expired or is invalid', error_code: 'otp_expired' });
        last.code = 'used';
        return json(200, session(usr));
      }
      if (u.pathname === '/auth/v1/token') {
        const b = r.postDataJSON();
        if (u.searchParams.get('grant_type') === 'password') {
          const usr = users.get(b.email);
          if (!usr || usr.password !== b.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' });
          return json(200, session(usr));
        }
        return json(400, { error: 'unsupported' });
      }
      if (u.pathname === '/auth/v1/user' && r.method() === 'PUT') {
        const id = who(h); const usr = [...users.values()].find(x => x.id === id); if (!usr) return json(401, { msg: 'not signed in' });
        const b = r.postDataJSON(); if (b.password) usr.password = b.password;
        return json(200, session(usr).user);
      }
      if (u.pathname === '/auth/v1/user') { const id = who(h); const usr = [...users.values()].find(x => x.id === id); return usr ? json(200, session(usr).user) : json(401, { msg: 'not signed in' }); }
      if (u.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      // ---- documents (row-level security: own rows only)
      if (u.pathname === '/rest/v1/documents') {
        const uid = who(h); if (!uid) return json(401, { message: 'JWT required' });
        const f = filters(u);
        if (r.method() === 'GET') {
          const rows = db.filter(x => x.user_id === uid && match(x, f));
          const cols = (u.searchParams.get('select') ?? '*').split(',');
          const pick = (x: any) => cols[0] === '*' ? x : Object.fromEntries(cols.map(c => [c, x[c]]));
          if ((h.accept ?? '').includes('vnd.pgrst.object')) return rows.length === 1 ? json(200, pick(rows[0])) : json(406, { message: 'not one row' });
          return json(200, rows.map(pick));
        }
        if (r.method() === 'POST') {
          for (const row of [].concat(r.postDataJSON())) {
            if ((row as any).user_id !== uid) return json(403, { message: 'new row violates row-level security policy' });
            const i = db.findIndex(x => x.user_id === uid && x.kind === (row as any).kind && x.id === (row as any).id);
            if (i >= 0) db[i] = { ...db[i], ...(row as any) }; else db.push({ ...(row as any) });
          }
          return json(201);
        }
        if (r.method() === 'PATCH') { const ch = r.postDataJSON(); for (const x of db) if (x.user_id === uid && match(x, f)) Object.assign(x, ch); return json(204); }
      }
      return json(404, { message: `fake supabase: no ${r.method()} ${u.pathname}` });
    });
  }
  /** The code in the newest email to this address. */
  const codeFor = (email: string) => [...mail].reverse().find(m => m.email === email)?.code ?? '';
  return { db, users, mail, codeFor, attach };
}
