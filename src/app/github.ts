/** Browser side of the GitHub integration (server/github.mjs holds the token). */
export interface GhUser { login: string; name?: string; avatar: string }
export interface GhRepo { full: string; private: boolean; branch: string; updated: string; description?: string; language?: string }
export interface GhItem { path: string; dir: boolean; size: number }
let base = '/';
export const setGhBase = (b: string) => { base = b; };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + 'api/github/' + path, body !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' } : { credentials: 'same-origin' }).catch(() => null);
  if (!r) throw new Error('Could not reach the Formframe server.');
  if (r.status === 404 && !(r.headers.get('content-type') ?? '').includes('json')) throw new Error('This build has no server, so GitHub isn\'t available. Run npm run dev.');
  const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `Error ${r.status}`), { status: r.status });
  return j as T;
}
export const gh = {
  status: () => call<{ signedIn: boolean; user: GhUser | null; deviceFlow: boolean; hosted?: boolean }>('status'),
  token: (token: string) => call<{ user: GhUser }>('token', { token }),
  deviceStart: () => call<{ userCode: string; verifyUrl: string; interval: number; expiresIn: number }>('device/start', {}),
  devicePoll: () => call<{ status: 'pending' | 'ok' | 'expired' | 'denied'; interval?: number; user?: GhUser }>('device/poll', {}),
  logout: () => call('logout', {}),
  repos: () => call<{ repos: GhRepo[] }>('repos'),
  branches: (repo: string) => call<{ branches: string[] }>(`branches?repo=${encodeURIComponent(repo)}`),
  tree: (repo: string, ref?: string) => call<{ ref: string; truncated: boolean; items: GhItem[] }>(`tree?repo=${encodeURIComponent(repo)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`),
  file: (repo: string, path: string, ref: string) => call<{ path: string; content: string }>(`file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`),
};

/** Files a dev board project can use. */
export const CODE_EXT = /\.(py|ino|h|hpp|c|cpp|hex)$/i;
/** Drag payload for GitHub files (dragging a folder carries every code file under it). */
export const GH_MIME = 'application/x-formframe-github';
export interface GhDrag { repo: string; ref: string; paths: string[] }
