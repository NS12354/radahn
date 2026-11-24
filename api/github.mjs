// /api/github/<route> → GitHub tab API (server/github.mjs). vercel.json rewrites
// /api/github/:route* here as ?__route=…, keeping the original query string.
import { githubRoute } from '../server/github.mjs';
import { json, bodyOf } from './_util.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://x'), q = url.searchParams;
  const route = String(q.get('__route') ?? '').replace(/^\/+/, ''); q.delete('__route');
  const body = req.method === 'POST' ? bodyOf(req) : {};
  if (body === null) return json(res, 400, { error: 'Bad JSON' });
  const r = await githubRoute({ method: req.method, route, q, body, cookie: req.headers.cookie, contentType: req.headers['content-type'], secure: true });
  if (r.cookie) res.setHeader('set-cookie', r.cookie);
  json(res, r.status, r.json);
}
