import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; vi.resetModules(); vi.unstubAllGlobals(); });

describe('AI guard (access code + rate limit)', () => {
  beforeEach(() => { delete process.env.FF_ACCESS_CODE; delete process.env.VERCEL; delete process.env.FF_AI_PER_HOUR; });
  const load = async () => (await import('../server/guard.mjs')).guardAI;

  it('lets the local dev server through without a code', async () => {
    expect((await load())({})).toBeNull();
  });
  it('fails closed when hosted without a code configured', async () => {
    process.env.VERCEL = '1';
    expect((await load())({})?.status).toBe(503);
  });
  it('asks for the code, rejects a wrong one, accepts the right one', async () => {
    process.env.VERCEL = '1'; process.env.FF_ACCESS_CODE = 'open-sesame';
    const g = await load();
    expect(g({})).toMatchObject({ status: 401, body: { needCode: true } });
    expect(g({ 'x-ff-access': 'nope' })).toMatchObject({ status: 401, body: { wrong: true } });
    expect(g({ 'x-ff-access': 'open-sesame', 'x-real-ip': '1.2.3.4' })).toBeNull();
  });
  it('caps each visitor per hour', async () => {
    process.env.FF_ACCESS_CODE = 'c'; process.env.FF_AI_PER_HOUR = '3';
    const g = await load(), h = { 'x-ff-access': 'c', 'x-forwarded-for': '9.9.9.9, 10.0.0.1' };
    expect([g(h), g(h), g(h)]).toEqual([null, null, null]);
    expect(g(h)?.status).toBe(429);
    expect(g({ ...h, 'x-forwarded-for': '8.8.8.8' })).toBeNull(); // someone else is unaffected
  });
});

describe('GitHub session in an encrypted cookie', () => {
  const load = async () => (await import('../server/github.mjs')).githubRoute;
  const base = { q: new URLSearchParams(), contentType: 'application/json', secure: true };

  it('signs in with a token, keeps it only in an encrypted cookie, and signs out', async () => {
    process.env.FF_SESSION_SECRET = 'test-secret';
    const token = 'ghp_' + 'a'.repeat(36);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'octo', name: 'Octo', avatar_url: 'x' }), { status: 200 })));
    const route = await load();
    const r = await route({ ...base, method: 'POST', route: 'token', body: { token }, cookie: '' });
    expect(r.status).toBe(200);
    expect(r.cookie).toMatch(/^ff_gh=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/api\/github; Max-Age=\d+; Secure$/);
    expect(r.cookie).not.toContain(token.slice(4, 20)); // not readable
    const cookie = r.cookie!.split(';')[0];
    expect((await route({ ...base, method: 'GET', route: 'status', cookie })).json).toMatchObject({ signedIn: true, user: { login: 'octo' } });
    // a tampered cookie is treated as signed out
    const bad = cookie.slice(0, -3) + (cookie.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await route({ ...base, method: 'GET', route: 'status', cookie: bad })).json.signedIn).toBe(false);
    // so is one sealed with a different secret
    process.env.FF_SESSION_SECRET = 'other'; vi.resetModules();
    expect((await (await load())({ ...base, method: 'GET', route: 'status', cookie })).json.signedIn).toBe(false);
    process.env.FF_SESSION_SECRET = 'test-secret'; vi.resetModules();
    const out = await (await load())({ ...base, method: 'POST', route: 'logout', body: {}, cookie });
    expect(out.cookie).toMatch(/^ff_gh=; .*Max-Age=0/);
  });
  it('refuses to run hosted without a session secret', async () => {
    process.env.VERCEL = '1'; delete process.env.FF_SESSION_SECRET;
    const r = await (await load())({ ...base, method: 'GET', route: 'status', cookie: 'ff_gh=abcdefabcdefabcdefabcdefabcdefabcdef' });
    expect(r.status).toBe(503);
  });
  it('rejects cross-site form posts', async () => {
    const r = await (await load())({ ...base, contentType: 'application/x-www-form-urlencoded', method: 'POST', route: 'logout', body: {}, cookie: '' });
    expect(r.status).toBe(415);
  });
});
