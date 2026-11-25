/**
 * Accounts (Supabase Auth) and saving projects and scenes to your account.
 *
 * Optional: without a sign-in, everything stays in this browser as before. Signed
 * in, the browser copy is still the working copy (fast, works offline), and every
 * save is mirrored to the `documents` table (supabase/migrations), where row-level
 * security means each person only ever sees their own rows. On sign-in, projects
 * from other computers come down and this browser's come up; signing out removes
 * the account's projects from this browser.
 *
 * Configured with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (both public:
 * the database rules, not the key, protect the data). Without them, accounts are off.
 */
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

export type Kind = 'project' | 'scene';
export interface CloudRow { kind: Kind; id: string; name: string; board: string; thumb: string | null; created: number; updated: number; deleted: boolean }
/** What the sync needs from each local library (store.ts for projects, scene.ts for scenes). */
export interface LocalLib {
  list(): Promise<{ id: string; updated: number; owner?: string }[]>;
  /** The full record to upload: body text plus list fields. */
  read(id: string): Promise<{ name: string; board: string; thumb: string | null; created: number; updated: number; body: string; owner?: string } | null>;
  /** Put a record that came from the account into this browser (without uploading it again). */
  write(id: string, r: { name: string; board: string; thumb: string | null; created: number; updated: number; body: string }, owner: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Mark a browser copy as belonging to an account (so sign-out can clear it). */
  own(id: string, owner: string): Promise<void>;
}

const env = (import.meta as any).env ?? {};
const URL_ = env.VITE_SUPABASE_URL as string | undefined, KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
export const accountsEnabled = !!(URL_ && KEY);
let sb: SupabaseClient | null = null;
export const client = () => (sb ??= accountsEnabled ? createClient(URL_!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } }) : null);

let user: User | null = null, known = false;
export const currentUser = () => user;
/** False until the saved session (if any) has been restored, so nobody is treated as signed out too early. */
export const sessionKnown = () => known;
/** The app saves what's open before signing out, and closes it afterwards (so nothing is re-saved without an owner). */
/** A guest's own copy of The First Step (main.ts): it joins the account they create. */
export const GUEST_FIRST = 'ff.guest.firstStep';
/** Set once an account has synced in this browser: after that, copies nobody owns are never handed to an account. */
const ADOPTED = 'ff.cloud.adopted';
const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } }, del: (k: string) => { try { localStorage.removeItem(k); } catch { /* */ } } };
/**
 * Which copies with no owner may join the signed-in account: a guest's First Step, and,
 * the first time any account is used in this browser, the work made here before accounts.
 * Never another account's leftovers, and never someone else's guest work later on.
 */
function adoptable(id: string, firstAccountHere: boolean) { return ls.get(GUEST_FIRST) === id || firstAccountHere; }
let signOutHooks: { save?: () => Promise<void>; close?: () => Promise<void> | void } = {};
export function onSignOut(h: typeof signOutHooks) { signOutHooks = h; }
export type SyncState = 'off' | 'idle' | 'saving' | 'offline' | 'error';
let state: SyncState = 'off', stateMsg = '';
const listeners = new Set<() => void>();
export const syncState = () => ({ state, msg: stateMsg });
export function onAccountChange(f: () => void) { listeners.add(f); return () => listeners.delete(f); }
const emit = () => listeners.forEach(f => { try { f(); } catch { /* a listener's problem */ } });
function setState(s: SyncState, msg = '') { state = s; stateMsg = msg; emit(); }

const libs = new Map<Kind, LocalLib>();
/** Unowned copies the sign-in sync decided this account may take (see adoptable). */
const adoptedNow = new Set<string>();
export function registerLibrary(kind: Kind, lib: LocalLib) { libs.set(kind, lib); }

// ---------------------------------------------------------------- uploads
const pending = new Map<string, { kind: Kind; id: string; del?: boolean }>(); // key kind:id
let upT: any = 0, uploading: Promise<void> | null = null;
const PENDING_KEY = 'ff.cloud.pending';
function remember() { try { localStorage.setItem(PENDING_KEY, JSON.stringify([...pending.values()])); } catch { /* */ } }
function recall() { try { for (const p of JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]')) pending.set(`${p.kind}:${p.id}`, p); } catch { /* */ } }

/** A local save or delete happened: mirror it to the account soon (coalesced). */
export function localChanged(kind: Kind, id: string, del = false) {
  if (!user) return;
  pending.set(`${kind}:${id}`, { kind, id, del }); remember();
  clearTimeout(upT); upT = setTimeout(() => void flushUploads(), 1500);
}
/** Upload everything pending now (waits for an upload already under way, then goes again if more came in). */
export async function flushUploads(): Promise<void> {
  clearTimeout(upT);
  while (uploading) await uploading;
  if (!client() || !user || !pending.size) return;
  uploading = uploadAll().finally(() => { uploading = null; });
  return uploading;
}
async function uploadAll() {
  const c = client()!;
  setState('saving');
  const uid = user!.id;
  try {
    for (const [k, p] of [...pending]) {
      const lib = libs.get(p.kind); if (!lib) { pending.delete(k); continue; }
      if (p.del) {
        const { error } = await c.from('documents').update({ deleted: true, body: '', thumb: null, updated: Date.now() }).match({ user_id: uid, kind: p.kind, id: p.id });
        if (error) throw error;
      } else {
        const r = await lib.read(p.id);
        // only this account's copies go up (a copy nobody owns joins an account only through the sign-in sync)
        if (r && (r.owner === uid || (!r.owner && adoptedNow.has(`${p.kind}:${p.id}`)))) {
          const { error } = await c.from('documents').upsert({ user_id: uid, kind: p.kind, id: p.id, name: r.name.slice(0, 300), board: r.board, thumb: r.thumb, body: r.body, created: r.created, updated: r.updated, deleted: false });
          if (error) throw error;
          await lib.own(p.id, uid);
        }
      }
      pending.delete(k); remember();
    }
    setState('idle');
  } catch (e: any) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    setState(offline ? 'offline' : 'error', offline ? 'Offline: changes will be saved to your account when you reconnect' : `Couldn't save to your account: ${e?.message ?? e}`);
    clearTimeout(upT); upT = setTimeout(() => void flushUploads(), offline ? 5000 : 20000);
  }
}

// ---------------------------------------------------------------- full sync (sign-in, start-up, reconnect)
let syncing: Promise<void> | null = null;
export function syncNow() { return (syncing ??= doSync().finally(() => { syncing = null; })); }
async function doSync() {
  const c = client(); if (!c || !user) return;
  const uid = user.id;
  setState('saving');
  try {
    const { data, error } = await c.from('documents').select('kind,id,name,board,thumb,created,updated,deleted').eq('user_id', uid);
    if (error) throw error;
    const remote = new Map((data as CloudRow[]).map(r => [`${r.kind}:${r.id}`, r]));
    const locals = new Map<Kind, Awaited<ReturnType<LocalLib['list']>>>();
    for (const [kind, lib] of libs) locals.set(kind, await lib.list());
    const firstAccountHere = !ls.get(ADOPTED) && ![...locals.values()].some(ls2 => ls2.some(l => l.owner));
    for (const [kind, lib] of libs) {
      const local = locals.get(kind)!;
      const localIds = new Map(local.map(l => [l.id, l]));
      for (const l of local) {
        if (l.owner && l.owner !== uid) continue; // someone else's leftovers: not ours to upload
        if (!l.owner && !adoptable(l.id, firstAccountHere)) continue; // nobody's: stays out of this account
        if (!l.owner) adoptedNow.add(`${kind}:${l.id}`);
        if (!l.owner && ls.get(GUEST_FIRST) === l.id) ls.del(GUEST_FIRST); // the guest copy is this account's now
        const r = remote.get(`${kind}:${l.id}`);
        if (r?.deleted) { if (l.owner === uid && !pending.has(`${kind}:${l.id}`)) await lib.remove(l.id); continue; } // deleted on another computer (unless edited here since)
        if (!r || l.updated > r.updated) pending.set(`${kind}:${l.id}`, { kind, id: l.id }); // newer here (or new): upload
        else if (l.owner !== uid) await lib.own(l.id, uid);
      }
      for (const r of remote.values()) {
        if (r.kind !== kind || r.deleted || pending.get(`${kind}:${r.id}`)?.del) continue; // deleted here, not sent yet: don't bring it back
        const l = localIds.get(r.id);
        if (l && l.updated >= r.updated) continue;
        const { data: full, error: e2 } = await c.from('documents').select('body').match({ user_id: uid, kind, id: r.id }).single();
        if (e2) throw e2;
        await lib.write(r.id, { name: r.name, board: r.board, thumb: r.thumb, created: r.created, updated: r.updated, body: (full as { body: string }).body }, uid);
      }
    }
    remember(); ls.set(ADOPTED, '1');
    setState('idle'); emit();
    await flushUploads();
  } catch (e: any) {
    setState('error', `Couldn't reach your account: ${e?.message ?? e}`);
  }
}

/** Signing out: forget this account's projects in this browser (a shared computer keeps nothing). */
async function clearAccountCopies(uid: string) {
  for (const lib of libs.values()) for (const l of await lib.list()) if (l.owner === uid) await lib.remove(l.id);
}

// ---------------------------------------------------------------- auth
const redirect = () => location.origin + location.pathname;
export async function signIn(email: string, password: string) {
  const { error } = await client()!.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'That email and password don’t match an account.' : error.message);
}
/** Returns true when the account still needs its email confirmed. */
export async function signUp(email: string, password: string) {
  const { data, error } = await client()!.auth.signUp({ email, password, options: { emailRedirectTo: redirect() } });
  if (error) throw new Error(error.message);
  return !data.session;
}
/**
 * Emails carry a 6-digit code rather than a link: mail scanners (common on school and
 * work addresses) open every link in a message, which would use up a one-time link
 * before the person clicks it. A code can only be used by typing it in.
 * (The redirect is still passed so emails sent from an older template keep working.)
 */
export type CodeFor = 'signup' | 'signin' | 'reset';
/** Email a sign-in code (no password needed). */
export async function sendCode(email: string) {
  const { error } = await client()!.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect() } });
  if (error) throw new Error(error.message);
}
export async function sendReset(email: string) {
  const { error } = await client()!.auth.resetPasswordForEmail(email, { redirectTo: redirect() });
  if (error) throw new Error(error.message);
}
/** Send the same kind of code again. */
export async function resendCode(email: string, what: CodeFor) {
  if (what === 'signin') return sendCode(email);
  if (what === 'reset') return sendReset(email);
  const { error } = await client()!.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirect() } });
  if (error) throw new Error(error.message);
}
/** Check a code from an email; on success the person is signed in (for 'reset', ready to choose a new password). */
export async function verifyCode(email: string, token: string, what: CodeFor) {
  const { error } = await client()!.auth.verifyOtp({ email, token, type: what === 'reset' ? 'recovery' : 'email' });
  if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'That code is wrong or has expired. Check the newest email, or send a new code.' : error.message);
}
export async function setPassword(password: string) {
  const { error } = await client()!.auth.updateUser({ password });
  if (error) throw new Error(error.message);
}
export async function signOut() {
  const c = client(), uid = user?.id; if (!c) return;
  await signOutHooks.save?.().catch(() => { /* still try to send what's queued */ });
  for (let i = 0; i < 3 && pending.size; i++) await flushUploads().catch(() => { /* best effort */ }); // saves that land while we sign out
  const unsent = pending.size > 0;
  if (unsent && !window.confirm?.('Some changes haven’t reached your account yet. Sign out anyway? They stay in this browser.')) return;
  await c.auth.signOut();
  await signOutHooks.close?.();
  if (uid && !unsent) await clearAccountCopies(uid);
  pending.clear(); remember();
  emit(); // the lists redraw without the account's projects
}

let recovering = false;
export const inPasswordRecovery = () => recovering;
export function doneRecovering() { recovering = false; emit(); }

/** Start: restore the session (and handle a link from an email), then keep in step. */
export async function initAccounts() {
  const c = client(); if (!c) return;
  recall();
  c.auth.onAuthStateChange((event, session) => {
    const before = user?.id;
    user = session?.user ?? null;
    if (user?.id !== before) adoptedNow.clear(); // a different person: nothing carries over
    if (event === 'PASSWORD_RECOVERY') recovering = true;
    if (!user) setState('off'); else if (state === 'off') setState('idle');
    emit();
    if (user && user.id !== before) setTimeout(() => void syncNow(), 0); // can't await Supabase calls inside this callback
  });
  const { data } = await c.auth.getSession().catch(() => ({ data: { session: null } }));
  user = data.session?.user ?? null; known = true;
  if (user) { setState('idle'); void syncNow(); }
  window.addEventListener('online', () => { if (user) void syncNow(); });
}
