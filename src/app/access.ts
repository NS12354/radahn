/**
 * AI features on a hosted studio are behind an access code (server/guard.mjs).
 * The code is asked for once, kept in this browser, and sent as `x-ff-access`.
 */
const KEY = 'ff.access';
const stored = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const remember = (c: string) => { try { if (c) localStorage.setItem(KEY, c); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

/** Ask for the access code in a small dialog. Resolves null if cancelled. */
export function askAccessCode(wrong: boolean): Promise<string | null> {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'ffcode';
    d.innerHTML = `<form method="dialog">
      <h3>Access code</h3>
      <p>${wrong ? 'That code didn’t work. Check it and try again.' : 'AI features on this site use the owner’s Claude account, so they need the access code. Ask the owner for it.'}</p>
      <input type="password" name="code" autocomplete="off" placeholder="Access code" required>
      <div class="acts"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Continue</button></div>
    </form>`;
    document.body.appendChild(d);
    const input = d.querySelector('input')!;
    d.addEventListener('close', () => { const ok = d.returnValue === 'ok' && input.value.trim(); d.remove(); resolve(ok ? input.value.trim() : null); });
    d.showModal(); input.focus();
  });
}

/** POST JSON to an AI endpoint, asking for the access code when the server wants one. Returns null if the server can't be reached. */
export async function aiFetch(url: string, body: unknown): Promise<Response | null> {
  for (let tries = 0; tries < 3; tries++) {
    const code = stored();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(code ? { 'x-ff-access': code } : {}) }, body: JSON.stringify(body) }).catch(() => null);
    if (!r || r.status !== 401) return r;
    const j = await r.clone().json().catch(() => ({}));
    if (!j.needCode) return r;
    remember('');
    const next = await askAccessCode(!!j.wrong || !!code);
    if (!next) throw new Error('This needs the access code.');
    remember(next);
  }
  throw new Error('That access code didn’t work.');
}
