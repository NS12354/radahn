/**
 * Access to the AI features on a hosted studio (server/guard.mjs, server/aikey.mjs).
 * Two ways in:
 *  - the site's access code: kept in this browser, sent as `x-ff-access`;
 *  - the visitor's own Anthropic API key: sent once to /api/ai-key, which checks
 *    it and keeps it in an encrypted httpOnly cookie. This page never stores it.
 */
const CODE_KEY = 'ff.access';
const storedCode = () => { try { return localStorage.getItem(CODE_KEY) ?? ''; } catch { return ''; } };
const rememberCode = (c: string) => { try { if (c) localStorage.setItem(CODE_KEY, c); else localStorage.removeItem(CODE_KEY); } catch { /* private mode */ } };

let base = './';
export const setAccessBase = (b: string) => { base = b; };

export interface KeyStatus { ownKey: boolean; hint: string | null; ownerKey: boolean }
export async function keyStatus(): Promise<KeyStatus | null> {
  const r = await fetch(base + 'api/ai-key', { credentials: 'same-origin' }).catch(() => null);
  if (!r?.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
  return r.json();
}
async function saveKey(key: string): Promise<KeyStatus> {
  const r = await fetch(base + 'api/ai-key', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => null);
  if (!r) throw new Error('Could not reach the server.');
  const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `Server error ${r.status}`);
  return j;
}
export async function removeKey() {
  await fetch(base + 'api/ai-key', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remove: true }) }).catch(() => null);
}

const KEY_HELP = 'Create one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. Requests then run on your Anthropic account. The key is kept encrypted in a cookie for this site; it is never stored on the server and this page can’t read it back.';

/**
 * The access dialog. `why`: 'need' (an AI feature asked), 'wrong' (bad code),
 * 'manage' (from the menu). `shared`: whether the site offers an access code.
 * Resolves 'code' or 'key' when the visitor is set to go, null if cancelled.
 */
export function aiAccessDialog(why: 'need' | 'wrong' | 'manage', shared: boolean, status?: KeyStatus | null): Promise<'code' | 'key' | null> {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'ffcode';
    let tab: 'code' | 'key' = shared && why !== 'manage' ? 'code' : 'key';
    const draw = (err = '') => {
      const lead = why === 'manage' ? 'Use your own Anthropic API key for the AI features (Plan updates, reading parts from a link).'
        : why === 'wrong' ? 'That code didn’t work. Check it, or use your own Anthropic API key instead.'
        : shared ? 'AI features use Claude. Enter the site’s access code, or use your own Anthropic API key.'
        : 'AI features use Claude. Add your own Anthropic API key to use them.';
      const own = status?.ownKey ? `<div class="ffkey"><span>Using your key <code>${status.hint ?? ''}</code></span><button type="button" class="btn" id="ffRemove">Remove</button></div>` : '';
      d.innerHTML = `<form method="dialog">
        <h3>Claude access</h3>
        <p>${lead}</p>
        ${own}
        ${shared && why !== 'manage' ? `<div class="fftabs"><button type="button" data-t="code" class="${tab === 'code' ? 'on' : ''}">Access code</button><button type="button" data-t="key" class="${tab === 'key' ? 'on' : ''}">Your own API key</button></div>` : ''}
        ${tab === 'code'
          ? '<input type="password" name="code" autocomplete="off" placeholder="Access code">'
          : `<input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="${status?.ownKey ? 'Replace with another key: sk-ant-…' : 'sk-ant-…'}"><p class="ffsmall">${KEY_HELP}</p>`}
        <p class="fferr" role="alert">${err}</p>
        <div class="acts"><button class="btn" value="cancel" formnovalidate>${why === 'manage' ? 'Close' : 'Cancel'}</button><button class="btn primary" value="ok">${tab === 'code' ? 'Continue' : 'Check and save key'}</button></div>
      </form>`;
      d.querySelectorAll<HTMLButtonElement>('.fftabs button').forEach(b => b.onclick = () => { tab = b.dataset.t as 'code' | 'key'; draw(); });
      const rm = d.querySelector<HTMLButtonElement>('#ffRemove');
      if (rm) rm.onclick = async () => { await removeKey(); status = { ...(status as KeyStatus), ownKey: false, hint: null }; draw(); };
      const form = d.querySelector('form')!, input = d.querySelector('input')!;
      form.onsubmit = async ev => {
        const sub = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
        if (sub?.value !== 'ok') return; // Cancel closes normally
        ev.preventDefault();
        const v = input.value.trim();
        if (tab === 'code') { if (!v) return draw('Enter the access code.'); rememberCode(v); finish('code'); return; }
        if (!v) { if (status?.ownKey) return finish('key'); return draw('Paste your API key.'); }
        sub.disabled = true; sub.textContent = 'Checking…';
        try { status = await saveKey(v); finish('key'); }
        catch (e: any) { draw(e.message); }
      };
      input.focus();
    };
    let done = false;
    const finish = (r: 'code' | 'key' | null) => { if (done) return; done = true; d.close(); d.remove(); resolve(r); };
    d.addEventListener('close', () => finish(null));
    document.body.appendChild(d);
    draw(); d.showModal();
  });
}

/** POST JSON to an AI endpoint, asking for access when the server wants it. Returns null if the server can't be reached. */
export async function aiFetch(url: string, body: unknown): Promise<Response | null> {
  for (let tries = 0; tries < 4; tries++) {
    const code = storedCode();
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(code ? { 'x-ff-access': code } : {}) }, body: JSON.stringify(body) }).catch(() => null);
    if (!r || r.status !== 401) return r;
    const j = await r.clone().json().catch(() => ({}));
    if (!j.needCode) return r;
    if (j.wrong) rememberCode('');
    const how = await aiAccessDialog(j.wrong ? 'wrong' : 'need', !j.noShared);
    if (!how) throw new Error('This needs an access code or your own Anthropic API key.');
  }
  throw new Error('Couldn’t get access to the AI features.');
}

/** Project menu: see, add, replace or remove your own key. */
export async function manageAiKey() {
  const s = await keyStatus();
  if (!s) throw new Error('This build has no server for AI features. Run npm run dev.');
  return aiAccessDialog('manage', s.ownerKey, s);
}
