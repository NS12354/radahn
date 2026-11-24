/**
 * Claude chat in Electronics (server/assistant.mjs). Works on the hosted site with
 * the visitor's own Anthropic key, and locally. Claude sees the board, wiring and
 * code, answers questions, and proposes file changes the person applies or declines.
 *
 * The conversation is saved per project in this browser (store.ts, not in the
 * project file), so it survives a reload. It is append-only: Claude's turns are
 * sent back exactly as received.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { App } from './app';
import { $, esc, toast } from './dom';
import { device } from './elec';
import { projectFacts } from './claude';
import { aiFetch } from '../app/access';
import { track } from './track';
import { loadChat, saveChat } from '../app/store';

type Msg = Anthropic.Beta.BetaMessageParam;
interface Edit { id: string; path: string; content?: string; summary?: string; invalid?: boolean; state: 'open' | 'applied' | 'declined' }

const CODE = /\.(py|ino|h|hpp|c|cpp)$/i;
let A: App;
type Entry = { who: 'you'; text: string } | { who: 'claude'; text: string; edits: string[]; warn?: string } | { who: 'err'; text: string };
const chats = new Map<string, Chat>();
let busy = false;

const shown = () => document.body.classList.contains('asst-on');
const key = () => A.projectId ?? 'scratch';
type Chat = { history: Msg[]; stateSent: string; edits: Edit[]; log: Entry[] };
const blank = (): Chat => ({ history: [], stateSent: '', edits: [], log: [] });
function chat(): Chat {
  let c = chats.get(key());
  if (!c) { c = blank(); chats.set(key(), c); }
  return c;
}
/** Bring a project's saved chat back (once per project per page load). */
const loaded = new Set<string>();
async function restore() {
  const k = key(); if (!A.projectId || loaded.has(k)) return;
  loaded.add(k);
  const saved = await loadChat<Chat>(k);
  if (saved && Array.isArray(saved.history) && Array.isArray(saved.log) && !chats.get(k)?.log.length) { chats.set(k, { ...blank(), ...saved }); if (shown() && key() === k) render(); }
}
/** Save after every change (reply, apply, decline, new chat). The page's own project id only. */
function persist(k = key()) {
  if (k === 'scratch') return;
  const c = chats.get(k);
  void saveChat(k, c && c.log.length ? c : null).catch(() => { /* storage full or blocked: the chat still works this session */ });
}

/** The project as Claude should see it now. */
function projectState() {
  const files = Object.entries(A.project.electronics.files).filter(([n]) => CODE.test(n)).sort(([a], [b]) => a.localeCompare(b));
  const fence = (n: string) => n.endsWith('.py') ? 'python' : 'cpp';
  return `<project_state>
# ${A.project.name || 'Formframe project'}
${projectFacts()}
## Code files
${files.map(([n, c]) => `### ${n}\n\`\`\`${fence(n)}\n${c}\n\`\`\``).join('\n\n') || '(no code files yet)'}
</project_state>`;
}

// ---- rendering
/** Very small Markdown: code fences, inline code, bold, paragraphs. Escapes everything first. */
function md(s: string) {
  const parts = s.split(/```[\w+-]*\n?/);
  return parts.map((p, i) => i % 2
    ? `<pre>${esc(p.replace(/\n$/, ''))}</pre>`
    : esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').split(/\n{2,}/).map(x => x.trim() ? `<p>${x.replace(/\n/g, '<br>')}</p>` : '').join('')).join('');
}
function lines(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n');
  let add = 0, del = 0; const sx = new Set(x), sy = new Set(y);
  for (const l of y) if (!sx.has(l)) add++;
  for (const l of x) if (!sy.has(l)) del++;
  return `+${add} −${del}`;
}
function editCard(e: Edit) {
  if (e.invalid) return `<div class="asedit bad"><b>${esc(e.path)}</b><span>Claude sent a change that couldn't be read, so it was skipped.</span></div>`;
  const before = A.project.electronics.files[e.path];
  const meta = before == null ? 'new file' : lines(before, e.content!);
  const acts = e.state === 'open'
    ? `<button class="btn" data-dec="${e.id}">Decline</button><button class="btn primary" data-app="${e.id}">Apply</button>`
    : `<span class="asstate">${e.state === 'applied' ? 'Applied' : 'Declined'}</span>`;
  return `<div class="asedit ${e.state}"><div><b>${esc(e.path)}</b> <span class="asmeta">${meta}</span><div class="assum">${esc(e.summary ?? '')}</div></div><div class="asacts"><button class="btn" data-view="${e.id}">View</button>${acts}</div></div>`;
}
function render(streaming = '') {
  const box = $('#asLog'); if (!box) return;
  const c = chat();
  const empty = !c.log.length && !streaming && !busy;
  const entry = (x: Entry) => x.who === 'you' ? `<div class="asmsg you">${esc(x.text).replace(/\n/g, '<br>')}</div>`
    : x.who === 'err' ? `<div class="asmsg err">${esc(x.text)}</div>`
    : `<div class="asmsg claude">${md(x.text)}${x.edits.map(id => c.edits.find(e => e.id === id)).filter((e): e is Edit => !!e).map(editCard).join('')}${x.warn ? `<div class="aswarn">${esc(x.warn)}</div>` : ''}</div>`;
  box.innerHTML = empty
    ? `<div class="asempty"><b>Ask Claude about this project</b><p>Claude can see the board, the wiring and your code. Try:</p>
        <button class="aschip">Explain what main.py does</button><button class="aschip">Why isn't my LED lighting up?</button><button class="aschip">Add a button that turns the buzzer on</button></div>`
    : c.log.map(entry).join('') + (busy ? `<div class="asmsg claude">${streaming ? md(streaming) : ''}<div class="asthink"><i class="spin"></i> ${streaming ? 'Writing…' : 'Thinking…'}</div></div>` : '');
  box.querySelectorAll<HTMLButtonElement>('.aschip').forEach(b => b.onclick = () => { ($('#asInput') as HTMLTextAreaElement).value = b.textContent!; void send(); });
  bindEdits(box);
  box.scrollTop = box.scrollHeight;
  ($('#asSend') as HTMLButtonElement).disabled = busy;
}
function bindEdits(root: HTMLElement) {
  const c = chat(), find = (id?: string) => c.edits.find(e => e.id === id);
  root.querySelectorAll<HTMLButtonElement>('[data-app]').forEach(b => b.onclick = () => {
    const e = find(b.dataset.app); if (!e || e.state !== 'open') return;
    device.setFile(e.path, e.content!); e.state = 'applied'; persist();
    track('code', `Applied Claude's change to ${e.path}`); toast(`Applied to ${e.path}. Press Run to try it.`); rerenderEdits();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-dec]').forEach(b => b.onclick = () => { const e = find(b.dataset.dec); if (e) { e.state = 'declined'; persist(); rerenderEdits(); } });
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => b.onclick = () => {
    const e = find(b.dataset.view); if (!e) return;
    const pre = b.closest('.asedit')!.nextElementSibling;
    if (pre?.classList.contains('asview')) { pre.remove(); return; }
    b.closest('.asedit')!.insertAdjacentHTML('afterend', `<pre class="asview">${esc(e.content ?? '')}</pre>`);
  });
}
const rerenderEdits = () => render();

// ---- sending
async function send() {
  if (busy) return;
  const input = $('#asInput') as HTMLTextAreaElement, text = input.value.trim();
  if (!text) return;
  const c = chat(), k = key();
  // answer the tool calls from Claude's last turn, then the project state if it changed, then the message
  const last = c.history.at(-1);
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = last?.role === 'assistant' && Array.isArray(last.content)
    ? (last.content as Anthropic.Beta.BetaContentBlockParam[]).filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use').map(b => {
      const e = c.edits.find(x => x.id === b.id);
      const r = !e || e.invalid ? 'The change could not be read and was skipped.' : e.state === 'applied' ? 'Applied.' : e.state === 'declined' ? 'Declined by the user.' : 'Not applied yet (the user moved on without deciding).';
      return { type: 'tool_result', tool_use_id: b.id, content: r, ...(e?.invalid ? { is_error: true } : {}) };
    }) : [];
  const state = projectState();
  const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
  if (state !== c.stateSent) content.push({ type: 'text', text: state });
  content.push({ type: 'text', text });
  const turn: Msg = { role: 'user', content };
  c.log.push({ who: 'you', text });
  input.value = ''; busy = true; render();
  let streamed = '';
  try {
    const r = await aiFetch(A.base + 'api/assistant', { messages: [...c.history, turn] });
    if (!r) throw new Error('Could not reach the Formframe server.');
    if (r.status === 404) throw new Error('This build has no server for Claude. Run npm run dev.');
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `Server error ${r.status}`); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', done: any = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === 'text') { streamed += ev.d; render(streamed); }
        else if (ev.t === 'done') done = ev;
        else if (ev.t === 'error') throw new Error(ev.error);
      }
      if (end) break;
    }
    if (!done) throw new Error('The reply was cut off. Try again.');
    c.history.push(turn, { role: 'assistant', content: done.content });
    if (state !== c.stateSent) c.stateSent = state;
    const edits: Edit[] = (done.edits ?? []).map((e: Omit<Edit, 'state'>) => ({ ...e, state: 'open' }));
    c.edits.push(...edits);
    const reply = (done.content as { type: string; text?: string }[]).filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim();
    c.log.push({ who: 'claude', text: reply || (edits.length ? 'Here are the changes:' : '(no reply)'), edits: edits.map(e => e.id), ...(done.stop === 'max_tokens' ? { warn: 'The reply hit its length limit, so any code changes in it were dropped. Ask for a smaller change.' } : {}) });
    track('code', `Asked Claude: ${text.slice(0, 80)}`);
  } catch (e: any) {
    c.log.pop(); // keep the conversation as it was; put the message back to retry
    input.value = text;
    c.log.push({ who: 'err', text: e.message });
  } finally { busy = false; persist(k); render(); }
}

export function showAssistant(on: boolean) {
  document.body.classList.toggle('asst-on', on);
  $('#tabAsst').classList.toggle('on', on);
  if (on) { document.body.classList.remove('claude-on'); $('#tabClaude').classList.remove('on'); $('#tabSerial').classList.remove('on'); render(); ($('#asInput') as HTMLTextAreaElement).focus(); }
  else if (!document.body.classList.contains('claude-on')) $('#tabSerial').classList.add('on');
}

export function initAssistant(app: App) {
  A = app;
  $('#tabAsst').onclick = () => showAssistant(!shown());
  $('#tabSerial').addEventListener('click', () => showAssistant(false));
  $('#tabClaude').addEventListener('click', () => showAssistant(false));
  $('#asSend').onclick = () => { void send(); };
  $('#asNew').onclick = () => { chats.delete(key()); persist(); render(); };
  const input = $('#asInput') as HTMLTextAreaElement;
  input.addEventListener('keydown', e => {
    e.stopPropagation(); // keep studio shortcuts (space = press, arrows = dial) out of the chat box
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  });
}
/** Switching project: show that project's chat. */
export function assistantProjectChanged() { void restore(); if (shown()) render(); }
