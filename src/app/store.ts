import { LEGACY_LS_KEY, parseProject, serializeProject, type Project } from './project';
import { currentUser, localChanged, registerLibrary } from './cloud';

/**
 * Browser-local project library (IndexedDB). Metadata and project bodies live
 * in separate stores so the home screen can list projects without loading
 * every embedded CAD model. Falls back to memory when IndexedDB is blocked
 * (private windows, sandboxed frames); `persistent` tells the UI which it got.
 */
export interface ProjectMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  board: string;
  /** Small JPEG data URL of the viewport, when there is a model to show. */
  thumb?: string;
  /** Account (user id) this copy belongs to, when it is saved to one (cloud.ts). */
  owner?: string;
}

const DB = 'formframe', META = 'meta', DATA = 'data', CHATS = 'chats';
let dbp: Promise<IDBDatabase | null> | null = null;
const mem = { meta: new Map<string, ProjectMeta>(), data: new Map<string, string>(), chats: new Map<string, string>() };
export let persistent = true;

function db() {
  if (!dbp) dbp = new Promise(res => {
    try {
      const r = indexedDB.open(DB, 2);
      r.onupgradeneeded = () => {
        const d = r.result, has = (n: string) => d.objectStoreNames.contains(n);
        if (!has(META)) d.createObjectStore(META, { keyPath: 'id' });
        if (!has(DATA)) d.createObjectStore(DATA);
        if (!has(CHATS)) d.createObjectStore(CHATS); // Claude chat per project (v2)
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { persistent = false; res(null); };
    } catch { persistent = false; res(null); }
  });
  return dbp;
}

function req<T>(r: IDBRequest<T>) { return new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function done(t: IDBTransaction) { return new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); }); }

export const newProjectId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export async function listProjects(): Promise<ProjectMeta[]> {
  const d = await db();
  const all = d ? await req<ProjectMeta[]>(d.transaction(META).objectStore(META).getAll()) : [...mem.meta.values()];
  const me = currentUser()?.id; // signed in: only this account's copies; signed out: only copies no account owns
  return all.filter(m => (me ? m.owner === me : !m.owner)).sort((a, b) => b.updated - a.updated);
}

export async function getMeta(id: string): Promise<ProjectMeta | undefined> {
  const d = await db();
  return d ? req<ProjectMeta | undefined>(d.transaction(META).objectStore(META).get(id)) : mem.meta.get(id);
}

export async function loadProject(id: string): Promise<Project | null> {
  const d = await db();
  const s = d ? await req<string | undefined>(d.transaction(DATA).objectStore(DATA).get(id)) : mem.data.get(id);
  return s ? parseProject(s) : null;
}

/**
 * Save a project body and refresh its metadata. `thumb: null` clears the thumbnail.
 * `edited: false` (e.g. only refreshing the thumbnail) keeps the "last edited" time.
 */
export async function saveProject(id: string, p: Project, thumb?: string | null, edited = true) {
  const prev = await getMeta(id);
  const now = Date.now();
  const meta: ProjectMeta = { id, name: p.name || 'Untitled project', created: prev?.created ?? now, updated: edited || !prev ? now : prev.updated, board: p.electronics.board, thumb: thumb === null ? undefined : thumb ?? prev?.thumb, owner: prev ? prev.owner : currentUser()?.id }; // a new copy belongs to whoever is signed in; an existing one keeps its owner (or none)
  const body = serializeProject(p);
  await putLocal(meta, body);
  localChanged('project', id);
}
async function putLocal(meta: ProjectMeta, body: string) {
  const d = await db();
  if (!d) { mem.meta.set(meta.id, meta); mem.data.set(meta.id, body); return; }
  const t = d.transaction([META, DATA], 'readwrite');
  t.objectStore(META).put(meta); t.objectStore(DATA).put(body, meta.id);
  await done(t);
}

export async function deleteProject(id: string) {
  await removeLocal(id);
  localChanged('project', id, true);
}
async function removeLocal(id: string) {
  const d = await db();
  if (!d) { mem.meta.delete(id); mem.data.delete(id); mem.chats.delete(id); return; }
  const t = d.transaction([META, DATA, CHATS], 'readwrite');
  t.objectStore(META).delete(id); t.objectStore(DATA).delete(id); t.objectStore(CHATS).delete(id);
  await done(t);
}

/** One-time import of the old single-slot localStorage autosave. */
export async function migrateLegacy() {
  let s: string | null = null;
  try { s = localStorage.getItem(LEGACY_LS_KEY); } catch { return; }
  if (!s) return;
  try { await saveProject(newProjectId(), parseProject(s)); } catch { /* unreadable: drop it */ }
  try { localStorage.removeItem(LEGACY_LS_KEY); } catch { }
}

// ------------------------------------------------------------------ unload journal
// IndexedDB writes are asynchronous and can be cut off when a tab closes.
// localStorage writes are synchronous, so pending changes are journalled
// there on pagehide and restored into the store on the next start.
const J = 'formframe.journal.';
export function journalWrite(id: string, p: Project) {
  try { localStorage.setItem(J + id, JSON.stringify({ t: Date.now(), body: serializeProject(p) })); return true; } catch { return false; } // over quota (large CAD): best effort
}
export function journalClear(id: string) { try { localStorage.removeItem(J + id); } catch { } }
/** Restore every journalled project that is newer than its stored copy. Returns how many were restored. */
export async function journalRecover() {
  let keys: string[] = [];
  try { keys = Object.keys(localStorage).filter(k => k.startsWith(J)); } catch { return 0; }
  let n = 0;
  for (const k of keys) {
    const id = k.slice(J.length);
    try {
      const j = JSON.parse(localStorage.getItem(k) ?? 'null');
      const meta = await getMeta(id);
      if (j?.body && (!meta || j.t > meta.updated)) { await saveProject(id, parseProject(j.body)); n++; }
    } catch { /* unreadable journal: drop it */ }
    journalClear(id);
  }
  return n;
}

/** The Claude chat for a project (kept in this browser, separate from the project file). */
export async function loadChat<T>(id: string): Promise<T | null> {
  const d = await db();
  const s = d ? await req<string | undefined>(d.transaction(CHATS).objectStore(CHATS).get(id)).catch(() => undefined) : mem.chats.get(id);
  try { return s ? JSON.parse(s) as T : null; } catch { return null; }
}
export async function saveChat(id: string, chat: unknown | null) {
  const d = await db(), body = chat ? JSON.stringify(chat) : null;
  if (!d) { if (body) mem.chats.set(id, body); else mem.chats.delete(id); return; }
  const t = d.transaction(CHATS, 'readwrite');
  if (body) t.objectStore(CHATS).put(body, id); else t.objectStore(CHATS).delete(id);
  await done(t);
}

// ---- the project library as the account sync sees it (cloud.ts)
registerLibrary('project', {
  list: async () => {
    const d = await db();
    const all = d ? await req<ProjectMeta[]>(d.transaction(META).objectStore(META).getAll()) : [...mem.meta.values()];
    return all.map(m => ({ id: m.id, updated: m.updated, owner: m.owner }));
  },
  read: async id => {
    const m = await getMeta(id); if (!m) return null;
    const d = await db();
    const body = d ? await req<string | undefined>(d.transaction(DATA).objectStore(DATA).get(id)) : mem.data.get(id);
    return body == null ? null : { name: m.name, board: m.board, thumb: m.thumb ?? null, created: m.created, updated: m.updated, body, owner: m.owner };
  },
  write: (id, r, owner) => putLocal({ id, name: r.name, board: r.board, thumb: r.thumb ?? undefined, created: r.created, updated: r.updated, owner }, r.body),
  remove: id => removeLocal(id),
  own: async (id, owner) => {
    const m = await getMeta(id); if (!m || m.owner === owner) return;
    const d = await db(); const nm = { ...m, owner };
    if (!d) { mem.meta.set(id, nm); return; }
    const t = d.transaction(META, 'readwrite'); t.objectStore(META).put(nm); await done(t);
  },
});
