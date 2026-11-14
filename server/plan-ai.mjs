// Plan tab: Claude reads the project's state, code, activity log and task
// list, then reports what's done (with evidence), what's left, and what to do
// next.  POST /api/plan { context } → { summary, nextStep, taskUpdates, completed, suggestions, risks }
import Anthropic from '@anthropic-ai/sdk';

const AREAS = ['electronics', 'code', 'model', 'interactions', 'review', 'other'];
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'nextStep', 'taskUpdates', 'completed', 'suggestions', 'risks'],
  properties: {
    summary: { type: 'string', description: 'Two or three plain sentences: where the project stands right now.' },
    nextStep: { type: 'string', description: 'The single most useful thing to do next, as an instruction.' },
    taskUpdates: {
      type: 'array', description: 'Changes to tasks already on the list. Only include tasks whose status should change.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] }, evidence: { type: 'string', description: 'The concrete fact from the project that shows this (a log entry, test result, milestone, or what the code does).' } } },
    },
    completed: {
      type: 'array', description: 'Finished work that is NOT already a task, worth recording as done. Skip trivial actions.',
      items: { type: 'object', additionalProperties: false, required: ['title', 'area', 'evidence'], properties: { title: { type: 'string' }, area: { type: 'string', enum: AREAS }, evidence: { type: 'string' } } },
    },
    suggestions: {
      type: 'array', description: 'Up to 5 concrete next tasks that are not already on the list, most important first.',
      items: { type: 'object', additionalProperties: false, required: ['title', 'area', 'why'], properties: { title: { type: 'string' }, area: { type: 'string', enum: AREAS }, why: { type: 'string' } } },
    },
    risks: { type: 'array', items: { type: 'string' }, description: 'Anything likely to cause trouble later (at most 3). Empty if none.' },
  },
};

const SYSTEM = `You keep track of progress on a hardware product prototype built in Formframe (3D product model, interactions, wired electronics, firmware running on an emulated board).
You get the project's current state, its code, an activity log of what the person did, automatic milestones, current problems, and their task list.
Rules:
- Mark a task done only when the provided facts show it is done, and quote that fact as evidence. If the evidence is partial, use "doing". Never invent progress.
- A task can move back from done if the facts now contradict it (e.g. the code it depends on crashes).
- Write for a beginner: short, plain sentences, no jargon without a word of explanation.
- Suggestions must be specific to this project (name the parts, files and screens) and not duplicate existing tasks or milestones that are already done.`;

export async function planWithAI(context) {
  if (!context || typeof context !== 'object') throw new Error('Missing project context.');
  const text = JSON.stringify(context);
  if (text.length > 400_000) throw new Error('This project is too large to send in one update.');
  let client;
  try { client = new Anthropic(); } catch { throw new Error('The AI tracker needs ANTHROPIC_API_KEY (in .env) or an `ant auth login` profile. Restart `npm run dev` after adding it.'); }
  let res;
  try {
    res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Here is the project. Update its progress.\n\n<project>\n${text}\n</project>` }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || /api key|authentication|credentials/i.test(e?.message ?? '')) throw new Error('The AI tracker needs ANTHROPIC_API_KEY (in .env) or an `ant auth login` profile. Restart `npm run dev` after adding it.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('The AI is busy right now. Try again in a minute.');
    throw new Error('The AI update failed: ' + (e?.message ?? e));
  }
  if (res.stop_reason === 'refusal') throw new Error('The AI declined to review this project.');
  if (res.stop_reason === 'max_tokens') throw new Error('The AI reply was cut off. Try again.');
  const out = res.content.find(b => b.type === 'text')?.text;
  if (!out) throw new Error('The AI sent back nothing.');
  return { ...JSON.parse(out), model: res.model };
}
