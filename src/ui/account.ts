/**
 * Sign-in page and account controls (src/app/cloud.ts does the work).
 * Signing in is optional: "Continue without an account" keeps everything in this browser.
 */
import { $, esc, toast } from './dom';
import {
  accountsEnabled, currentUser, doneRecovering, inPasswordRecovery, initAccounts, onAccountChange,
  resendCode, sendCode, sendReset, setPassword, signIn, signOut, signUp, syncNow, syncState, verifyCode,
  type CodeFor,
} from '../app/cloud';

type Mode = 'signin' | 'signup' | 'code' | 'reset' | 'newpass' | 'verify';
let mode: Mode = 'signin', sentTo = '', sentFor: CodeFor = 'signin';
let onChange: () => void = () => {};

const page = () => document.getElementById('auth');

export function showAuth(m: Mode = 'signin') {
  if (!accountsEnabled) { toast('Accounts aren’t set up on this site yet'); return; }
  mode = m; render(); page()!.hidden = false;
  setTimeout(() => (page()!.querySelector('input') as HTMLInputElement | null)?.focus(), 0);
}
export function hideAuth() { const p = page(); if (p) p.hidden = true; }

function render(err = '') {
  const p = page(); if (!p) return;
  const typed = (p.querySelector('input[name=email]') as HTMLInputElement | null)?.value ?? ''; // keep the email across errors and mode changes
  const t = {
    signin: ['Sign in', 'Save your projects to your account and open them on any computer.'],
    signup: ['Create your account', 'Your projects are saved to your account. Only you can see them.'],
    code: ['Email me a sign-in code', 'No password needed: we email you a 6-digit code that signs you in.'],
    reset: ['Reset your password', 'We’ll email you a 6-digit code, then you choose a new password.'],
    newpass: ['Choose a new password', 'At least 8 characters.'],
    verify: ['Check your email', ''],
  }[mode];
  const email = `<label class="aufield"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>`;
  const pass = (auto: string) => `<label class="aufield"><span>Password</span><input type="password" name="password" autocomplete="${auto}" minlength="8" required></label>`;
  const body = mode === 'verify'
    ? `<p class="aulead">We sent a 6-digit code to <b>${esc(sentTo)}</b>. Enter it below. It can take a minute to arrive; check spam too.</p>
       <label class="aufield"><span>Code</span><input type="text" name="code" class="aucode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required></label>
       <p class="auerr" role="alert">${esc(err)}</p>
       <button class="btn primary aubig" type="submit">${sentFor === 'reset' ? 'Continue' : 'Verify'}</button>
       <div class="aulinks"><button type="button" class="aulink" data-resend>Send a new code</button><button type="button" class="aulink" data-go="signin">Back to sign in</button></div>`
    : `<p class="aulead">${t[1]}</p>
       ${mode === 'newpass' ? pass('new-password') : email + (mode === 'signin' ? pass('current-password') : mode === 'signup' ? pass('new-password') : '')}
       <p class="auerr" role="alert">${esc(err)}</p>
       <button class="btn primary aubig" type="submit">${{ signin: 'Sign in', signup: 'Create account', code: 'Send code', reset: 'Send code', newpass: 'Save password' }[mode as Exclude<Mode, 'verify'>]}</button>
       ${mode === 'signin' ? `<div class="aulinks"><button type="button" class="aulink" data-go="reset">Forgot password?</button><button type="button" class="aulink" data-go="code">Email me a sign-in code instead</button></div>
         <div class="aualt">New to Formframe? <button type="button" class="aulink" data-go="signup">Create an account</button></div>` : ''}
       ${mode === 'signup' || mode === 'code' || mode === 'reset' ? `<div class="aualt"><button type="button" class="aulink" data-go="signin">Back to sign in</button></div>` : ''}`;
  p.innerHTML = `<div class="aucard" role="dialog" aria-modal="true" aria-labelledby="auTitle">
    <div class="aulogo"><i></i>Formframe</div>
    <form novalidate><h1 id="auTitle">${t[0]}</h1>${body}</form>
    ${mode !== 'newpass' ? '<button type="button" class="aulink auskip" data-close>Continue without an account</button>' : ''}
    <p class="aufine">Without an account, projects stay in this browser only.</p>
  </div>`;
  const emIn = p.querySelector('input[name=email]') as HTMLInputElement | null; if (emIn && typed) emIn.value = typed;
  if (err) (p.querySelector('input[name=password], input[name=code]') as HTMLInputElement | null)?.focus();
  p.querySelector<HTMLButtonElement>('[data-resend]')?.addEventListener('click', async ev => {
    const b = ev.currentTarget as HTMLButtonElement; b.disabled = true;
    try { await resendCode(sentTo, sentFor); toast(`New code sent to ${sentTo}`); } catch (e: any) { render(e.message); return; }
    b.disabled = false;
  });
  p.querySelectorAll<HTMLElement>('[data-go]').forEach(b => (b.onclick = () => { mode = b.dataset.go as Mode; render(); (p.querySelector('input') as HTMLInputElement | null)?.focus(); }));
  p.querySelector<HTMLElement>('[data-close]')?.addEventListener('click', hideAuth);
  const form = p.querySelector('form')!;
  form.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(form), em = String(f.get('email') ?? '').trim(), pw = String(f.get('password') ?? '');
    const code = String(f.get('code') ?? '').replace(/\s+/g, '');
    if (mode === 'verify' && !/^\d{6,10}$/.test(code)) return render('Enter the 6-digit code from the email.');
    if (mode !== 'newpass' && mode !== 'verify' && !/^\S+@\S+\.\S+$/.test(em)) return render('Enter a valid email address.');
    if ((mode === 'signin' || mode === 'signup' || mode === 'newpass') && pw.length < 8) return render('Passwords are at least 8 characters.');
    const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!; btn.disabled = true; btn.textContent = 'One moment…';
    try {
      if (mode === 'signin') { await signIn(em, pw); hideAuth(); toast('Signed in. Your projects are being saved to your account.'); }
      else if (mode === 'signup') { if (await signUp(em, pw)) askCode(em, 'signup'); else { hideAuth(); toast('Account created. Your projects are being saved to it.'); } }
      else if (mode === 'code') { await sendCode(em); askCode(em, 'signin'); }
      else if (mode === 'reset') { await sendReset(em); askCode(em, 'reset'); }
      else if (mode === 'verify') {
        await verifyCode(sentTo, code, sentFor);
        if (sentFor === 'reset') { mode = 'newpass'; render(); }
        else { hideAuth(); toast(sentFor === 'signup' ? 'Account confirmed. Your projects are being saved to it.' : 'Signed in. Your projects are being saved to your account.'); }
      }
      else if (mode === 'newpass') { await setPassword(pw); doneRecovering(); hideAuth(); toast('Password changed. You’re signed in.'); }
    } catch (e: any) { render(e.message); }
  };
  p.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape' && mode !== 'newpass') hideAuth(); };
}

function askCode(email: string, what: CodeFor) {
  sentTo = email; sentFor = what; mode = 'verify'; render();
  (page()?.querySelector('input[name=code]') as HTMLInputElement | null)?.focus();
}

// ---- account button (home screen and studio top bar)
function chip(): string {
  const u = currentUser();
  if (!u) return 'Sign in';
  const s = syncState();
  const dot = s.state === 'saving' ? 'saving' : s.state === 'offline' || s.state === 'error' ? 'warn' : 'ok';
  return `<i class="acdot ${dot}"></i>${esc((u.email ?? 'Account').split('@')[0])}`;
}
function statusText() {
  const s = syncState();
  return s.state === 'saving' ? 'Saving to your account…' : s.state === 'offline' || s.state === 'error' ? s.msg : 'All projects saved to your account';
}
function renderButtons() {
  for (const id of ['hAccount', 'bAccount']) {
    const b = document.getElementById(id); if (!b) continue;
    b.hidden = !accountsEnabled;
    b.innerHTML = chip();
    b.title = currentUser() ? `${currentUser()!.email}\n${statusText()}` : 'Sign in to save your projects to your account';
    b.classList.toggle('signed', !!currentUser());
  }
  const m = document.getElementById('acMenu');
  if (m && !m.hidden) fillMenu(m);
}
function fillMenu(m: HTMLElement) {
  const u = currentUser()!;
  m.innerHTML = `<div class="acwho"><b>${esc(u.email ?? '')}</b><span>${esc(statusText())}</span></div>
    <button data-a="sync">Save and refresh now</button><button data-a="pass">Change password</button><button data-a="out">Sign out</button>`;
  m.querySelector<HTMLElement>('[data-a=sync]')!.onclick = () => { m.hidden = true; void syncNow().then(() => toast('Up to date with your account')); };
  m.querySelector<HTMLElement>('[data-a=pass]')!.onclick = () => { m.hidden = true; showAuth('newpass'); };
  m.querySelector<HTMLElement>('[data-a=out]')!.onclick = async () => { m.hidden = true; await signOut(); if (!currentUser()) toast('Signed out. This account’s projects were removed from this browser.'); };
}
function openMenu(anchor: HTMLElement) {
  if (!currentUser()) { showAuth('signin'); return; }
  const m = $('#acMenu');
  if (!m.hidden) { m.hidden = true; return; }
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`; m.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  fillMenu(m); m.hidden = false;
}

/** Wire the buttons and start the account session. `refresh` re-renders the project lists after a sync. */
export async function initAccountUI(refresh: () => void) {
  onChange = refresh;
  for (const id of ['hAccount', 'bAccount']) { const b = document.getElementById(id); if (b) b.onclick = e => { e.stopPropagation(); openMenu(b); }; }
  document.addEventListener('click', e => { const m = document.getElementById('acMenu'); if (m && !m.hidden && !(e.target as HTMLElement).closest('#acMenu')) m.hidden = true; });
  onAccountChange(() => {
    renderButtons();
    if (inPasswordRecovery() && (page()?.hidden ?? true)) showAuth('newpass');
    // redraw the project lists whenever the sync comes to rest (signed in, signed out, or after pulling projects down)
    const st = syncState().state;
    if (st === 'idle' || st === 'off') onChange();
  });
  renderButtons();
  if (!accountsEnabled) return;
  await initAccounts();
  renderButtons();
}
