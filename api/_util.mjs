// Small helpers shared by the Vercel functions in this folder.
// (Files starting with _ are not deployed as routes.)
export function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}
/** The parsed JSON body, or null when it's missing or malformed. */
export function bodyOf(req) {
  try { const b = req.body; return typeof b === 'string' ? JSON.parse(b) : b ?? null; } catch { return null; }
}
