// /api/ai-key → a visitor's own Anthropic key, kept in an encrypted cookie (server/aikey.mjs).
import { aiKeyRoute } from '../server/aikey.mjs';
import { json, bodyOf } from './_util.mjs';

export default async function handler(req, res) {
  const body = req.method === 'POST' ? bodyOf(req) : {};
  if (body === null) return json(res, 400, { error: 'Bad JSON' });
  const r = await aiKeyRoute({ method: req.method, body, cookie: req.headers.cookie, contentType: req.headers['content-type'], secure: true });
  if (r.cookie) res.setHeader('set-cookie', r.cookie);
  json(res, r.status, r.json);
}
