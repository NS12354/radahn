// Claude chat in the Electronics panel: answers questions about the project and
// proposes code changes, which the studio shows for the person to apply or decline.
// Works on the hosted site (with the visitor's own key) and on `npm run dev`.
//
//   POST /api/assistant { messages } → streamed NDJSON events:
//     { t: 'text', d }                 reply text as it is written
//     { t: 'done', content, edits, stop }   the full assistant turn (send it back
//                                      unchanged next time), plus validated edits
//     { t: 'error', error }
//
// The browser keeps the conversation. Each user turn carries the current project
// state when it changed (files, board, wiring); history is append-only, so
// Claude's earlier reasoning stays valid across turns.
import Anthropic from '@anthropic-ai/sdk';

const MAX_BODY_CHARS = 3_000_000;
const MAX_FILE = 200_000;
const PATH = /^(?:lib\/)?[\w.-]{1,80}\.(py|ino|h|hpp|c|cpp)$/;

const SYSTEM = `You are Claude, helping someone build a hardware prototype in Formframe, a browser studio where firmware runs on an emulated dev board wired to real parts (sensors, displays, LEDs, motors, servos) and drives a 3D model of the product.

Each user turn may include a <project_state> block: the board, the wiring (which part pin goes to which board pin), and the full text of every code file. It is always the latest state; trust it over anything said earlier.

How to help:
- Answer questions about the code, the wiring and the parts plainly. Many people here are beginners: short sentences, and explain any jargon in a few words.
- When code should change, call write_file once per file with the complete new file content (not a diff), and a one-line summary. Change only the files that need it. The person sees each change and chooses whether to apply it, so describe what you changed and how to try it (usually: press Run).
- Use the pins exactly as wired in project_state. If the wiring itself needs to change, say which pin to move where; you cannot rewire it yourself.
- Write code for the board's language (MicroPython, Arduino C++ or Python 3, as stated) and the libraries already in the project.
- If something can't be done on this board or with these parts, say so instead of guessing.`;

const TOOLS = [{
  name: 'write_file',
  description: 'Propose the complete new content of one code file in the project (create it if it does not exist). The person reviews the change and applies or declines it.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['path', 'content', 'summary'],
    properties: {
      path: { type: 'string', description: 'File name as shown in project_state, e.g. "main.py", "lib/servo.py" or "thermostat.ino".' },
      content: { type: 'string', description: 'The full file content after the change.' },
      summary: { type: 'string', description: 'One short line: what changed in this file.' },
    },
  },
  eager_input_streaming: true,
}];

/** Light shape check: the conversation comes from the browser. */
function checkMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Nothing to send.');
  if (JSON.stringify(messages).length > MAX_BODY_CHARS) throw new Error('This conversation is too long. Start a new chat.');
  if (messages[0]?.role !== 'user' || messages.at(-1)?.role !== 'user') throw new Error('The conversation must start and end with your message.');
  for (const m of messages) if (m?.role !== 'user' && m?.role !== 'assistant') throw new Error('Bad conversation format.');
}

/** Tool inputs stream without server-side validation, so check each one here. */
function editsOf(content) {
  const edits = [];
  for (const b of content) {
    if (b.type !== 'tool_use' || b.name !== 'write_file') continue;
    const i = b.input ?? {};
    const ok = typeof i.path === 'string' && PATH.test(i.path) && !i.path.includes('..') && typeof i.content === 'string' && i.content.length <= MAX_FILE && typeof i.summary === 'string';
    edits.push(ok ? { id: b.id, path: i.path, content: i.content, summary: i.summary.slice(0, 300) } : { id: b.id, invalid: true, path: String(i.path ?? '?').slice(0, 100) });
  }
  return edits;
}

/**
 * Run one assistant turn. `send(event)` is called for each NDJSON event.
 * apiKey: the visitor's own key, or undefined for the local .env key.
 */
export async function assistantTurn(messages, apiKey, send) {
  checkMessages(messages);
  let client;
  try { client = new Anthropic(apiKey ? { apiKey } : undefined); }
  catch { throw new Error('Claude needs an Anthropic API key. Add yours from the Project menu (Claude API key).'); }
  try {
    const stream = client.beta.messages.stream({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    stream.on('text', d => send({ t: 'text', d }));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') return send({ t: 'error', error: 'Claude declined to help with this request.' });
    const truncated = msg.stop_reason === 'max_tokens';
    send({ t: 'done', content: msg.content, edits: truncated ? [] : editsOf(msg.content), stop: msg.stop_reason, model: msg.model });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error(apiKey ? 'Anthropic rejected your API key. Add it again from the Project menu (Claude API key).' : 'Claude needs an Anthropic API key. Add yours from the Project menu (Claude API key).');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is busy right now (rate limit). Try again in a minute.');
    if (e instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(e.message)) throw new Error('Your Anthropic account is out of credits. Top it up in the Anthropic Console.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude couldn't answer (${e.status ?? 'error'}): ${e.message}`);
    throw new Error('Claude couldn\'t answer: ' + (e?.message ?? e));
  }
}

export const _test = { editsOf, checkMessages };
