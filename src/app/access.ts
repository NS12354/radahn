/**
 * AI features on the hosted studio run on the visitor's own Anthropic API key
 * (server/guard.mjs, server/aikey.mjs). The key is sent once to /api/ai-key,
 * which checks it and keeps it in an encrypted httpOnly cookie; this page never
 * stores it.
 */
let base = './';
export const setAccessBase = (b: string) => { base = b; };

export interface KeyStatus { ownKey: boolean; hint: string | null }
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
 * The key dialog. `why`: 'need' (an AI feature asked) or 'manage' (from the menu).
 * Resolves true when a key is saved and ready, false if closed without one.
 */
export function aiKeyDialog(why: 'need' | 'manage', status?: KeyStatus | null): Promise<boolean> {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'ffcode';
    const draw = (err = '') => {
      const lead = why === 'manage' ? 'Use your own Anthropic API key for the AI features (Plan updates, reading parts from a link).' : 'AI features use Claude. Add your own Anthropic API key to use them.';
      const own = status?.ownKey ? `<div class="ffkey"><span>Using your key <code>${status.hint ?? ''}</code></span><button type="button" class="btn" id="ffRemove">Remove</button></div>` : '';
      d.innerHTML = `<form method="dialog">
        <h3>Claude API key</h3>
        <p>${lead}</p>
        ${own}
        <input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="${status?.ownKey ? 'Replace with another key: sk-ant-…' : 'sk-ant-…'}"><p class="ffsmall">${KEY_HELP}</p>
        <p class="fferr" role="alert">${err}</p>
        <div class="acts"><button class="btn" value="cancel" formnovalidate>${why === 'manage' ? 'Close' : 'Cancel'}</button><button class="btn primary" value="ok">Check and save key</button></div>
      </form>`;
      const rm = d.querySelector<HTMLButtonElement>('#ffRemove');
      if (rm) rm.onclick = async () => { await removeKey(); status = { ownKey: false, hint: null }; draw(); };
      const form = d.querySelector('form')!, input = d.querySelector('input')!;
      form.onsubmit = async ev => {
        const sub = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
        if (sub?.value !== 'ok') return; // Cancel closes normally
        ev.preventDefault();
        const v = input.value.trim();
        if (!v) { if (status?.ownKey) return finish(true); return draw('Paste your API key.'); }
        sub.disabled = true; sub.textContent = 'Checking…';
        try { status = await saveKey(v); finish(true); }
        catch (e: any) { draw(e.message); }
      };
      input.focus();
    };
    let done = false;
    const finish = (r: boolean) => { if (done) return; done = true; d.close(); d.remove(); resolve(r); };
    d.addEventListener('close', () => finish(false));
    document.body.appendChild(d);
    draw(); d.showModal();
  });
}

/** POST JSON to an AI endpoint, asking for the visitor's key when the server wants one. Returns null if the server can't be reached. */
export async function aiFetch(url: string, body: unknown): Promise<Response | null> {
  for (let tries = 0; tries < 3; tries++) {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    if (!r || r.status !== 401) return r;
    const j = await r.clone().json().catch(() => ({}));
    if (!j.needKey) return r;
    if (!(await aiKeyDialog('need'))) throw new Error('AI features need your own Anthropic API key (Project menu ▸ Claude API key).');
  }
  throw new Error('Couldn’t use your Anthropic key. Try adding it again from the Project menu.');
}

/** Project menu: see, add, replace or remove your own key. */
export async function manageAiKey() {
  const s = await keyStatus();
  if (!s) throw new Error('This build has no server for AI features. Run npm run dev.');
  return aiKeyDialog('manage', s);
}
