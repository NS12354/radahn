// POST /api/assistant { messages } → streamed NDJSON (server/assistant.mjs).
// Runs on the visitor's own Anthropic key (server/guard.mjs).
import { assistantTurn } from '../server/assistant.mjs';
import { aiAccess } from '../server/guard.mjs';
import { json, bodyOf } from './_util.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
  const a = aiAccess(req.headers); if (a.stop) return json(res, a.stop.status, a.stop.body);
  const body = bodyOf(req);
  if (!body) return json(res, 400, { error: 'Bad JSON' });
  res.statusCode = 200;
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-accel-buffering', 'no');
  const send = (ev) => res.write(JSON.stringify(ev) + '\n');
  try { await assistantTurn(body.messages, a.apiKey, send); }
  catch (e) { send({ t: 'error', error: e.message }); }
  res.end();
}
