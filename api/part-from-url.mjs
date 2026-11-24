// POST /api/part-from-url { url } → a part spec read from a product page or datasheet (server/part-from-url.mjs).
import { partFromUrl } from '../server/part-from-url.mjs';
import { aiAccess } from '../server/guard.mjs';
import { json, bodyOf } from './_util.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
  const a = aiAccess(req.headers); if (a.stop) return json(res, a.stop.status, a.stop.body);
  const body = bodyOf(req);
  if (!body) return json(res, 400, { error: 'Bad JSON' });
  try { json(res, 200, await partFromUrl(String(body.url ?? '').trim(), a.apiKey)); }
  catch (e) { json(res, 400, { error: e.message }); }
}
