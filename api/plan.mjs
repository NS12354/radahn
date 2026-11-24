// POST /api/plan { context } → AI progress update for the Plan tab (server/plan-ai.mjs).
import { planWithAI } from '../server/plan-ai.mjs';
import { guardAI } from '../server/guard.mjs';
import { json, bodyOf } from './_util.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const stop = guardAI(req.headers); if (stop) return json(res, stop.status, stop.body);
  const body = bodyOf(req);
  if (!body) return json(res, 400, { error: 'Bad JSON' });
  try { json(res, 200, await planWithAI(body.context)); }
  catch (e) { json(res, 400, { error: e.message }); }
}
