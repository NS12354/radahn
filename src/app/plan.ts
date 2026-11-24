/**
 * The Plan tab's data: your tasks, an automatic activity log, and when each
 * milestone was first reached. Stored in the project, so it travels with it.
 */
export type TaskStatus = 'todo' | 'doing' | 'done';
export type PlanArea = 'electronics' | 'code' | 'model' | 'interactions' | 'review' | 'other';
export interface PlanTask {
  id: string; title: string; status: TaskStatus; area: PlanArea;
  /** 'user' typed it, 'ai' found or suggested it */
  source: 'user' | 'ai';
  /** why it's done (AI evidence, or the milestone that finished it) */
  evidence?: string;
  /** optional link to a wired part (uid) or model part (id) */
  ref?: string;
  created: string; doneAt?: string;
}
export type LogKind = 'run' | 'crash' | 'test' | 'compile' | 'wiring' | 'part' | 'board' | 'code' | 'model' | 'interaction' | 'review' | 'milestone' | 'ai' | 'task';
export interface LogEvent { t: string; kind: LogKind; text: string; ok?: boolean }
export interface PlanData {
  tasks: PlanTask[];
  log: LogEvent[];
  /** milestone id → when it was first reached */
  reached: Record<string, string>;
  /** last code run and last Test it, so milestones survive a reload */
  lastRun?: { at: string; errors: number };
  lastTest?: { at: string; passed: boolean; failed: number };
  /** last AI update */
  ai?: { at: string; summary: string; nextStep?: string; risks: string[]; suggestions: { title: string; area: PlanArea; why: string }[] };
}
export const emptyPlan = (): PlanData => ({ tasks: [], log: [], reached: {} });
const LOG_MAX = 400;

let uid = 0;
export const taskId = () => 't' + Date.now().toString(36) + (uid++).toString(36);

/** Append to the activity log, merging repeats of the same thing within a few minutes ("Edited main.py" ×6). */
export function logEvent(p: PlanData, kind: LogKind, text: string, ok?: boolean, mergeMinutes = 5) {
  const last = p.log[p.log.length - 1], now = new Date();
  if (last && last.kind === kind && last.text.replace(/ ×\d+$/, '') === text && now.getTime() - new Date(last.t).getTime() < mergeMinutes * 60e3) {
    const n = +(last.text.match(/ ×(\d+)$/)?.[1] ?? 1) + 1;
    last.text = kind === 'code' ? text : `${text} ×${n}`; // typing is one edit session, not a count last.t = now.toISOString(); if (ok !== undefined) last.ok = ok;
    return false;
  }
  p.log.push({ t: now.toISOString(), kind, text, ok });
  if (p.log.length > LOG_MAX) p.log.splice(0, p.log.length - LOG_MAX);
  return true;
}

// ------------------------------------------------------------------ milestones (computed from the project)
export interface MilestoneInput {
  parts: number; unconnected: number; wiringBroken: number;
  codeRan: boolean; runBroken: number; tested: boolean; lastTest?: { at: string; passed: boolean; failed: number };
  hasModel: boolean; modelProblems: number; roleTips: number;
  interactions: number; comments: number;
  stateMachine?: boolean; // only the thermostat example has an interaction prototype
}
export interface Milestone { id: string; title: string; done: boolean; detail: string; area: PlanArea; go: 'design' | 'proto' | 'elec' | 'review' }
export function milestones(m: MilestoneInput): Milestone[] {
  return [
    { id: 'parts', title: 'Add the parts you need', done: m.parts > 0, detail: m.parts ? `${m.parts} part${m.parts > 1 ? 's' : ''} on the bench` : 'No parts yet', area: 'electronics', go: 'elec' },
    { id: 'wired', title: 'Wire every part', done: m.parts > 0 && !m.unconnected && !m.wiringBroken, detail: !m.parts ? 'Add parts first' : m.unconnected ? `${m.unconnected} pin${m.unconnected > 1 ? 's' : ''} not connected` : m.wiringBroken ? `${m.wiringBroken} wiring problem${m.wiringBroken > 1 ? 's' : ''}` : 'All connected', area: 'electronics', go: 'elec' },
    { id: 'runs', title: 'Code runs without errors', done: m.codeRan && !m.runBroken, detail: !m.codeRan ? 'Not run yet' : m.runBroken ? `${m.runBroken} error${m.runBroken > 1 ? 's' : ''} last run` : 'Ran cleanly', area: 'code', go: 'elec' },
    { id: 'tested', title: 'Test it passes', done: !!m.lastTest?.passed, detail: m.lastTest ? (m.lastTest.passed ? 'Passed' : `${m.lastTest.failed} check${m.lastTest.failed > 1 ? 's' : ''} failed`) : 'Not tested yet', area: 'code', go: 'elec' },
    { id: 'model', title: 'Make a 3D model', done: m.hasModel, detail: m.hasModel ? 'Model in place' : 'No model yet', area: 'model', go: 'design' },
    { id: 'fits', title: 'Electronics fit the case', done: m.hasModel && !m.modelProblems, detail: !m.hasModel ? 'Make a model first' : m.modelProblems ? `${m.modelProblems} fit problem${m.modelProblems > 1 ? 's' : ''}` : 'Everything fits', area: 'model', go: 'design' },
    { id: 'roles', title: 'Model shows the electronics', done: m.hasModel && m.parts > 0 && !m.roleTips, detail: !m.hasModel ? 'Make a model first' : m.roleTips ? `${m.roleTips} part${m.roleTips > 1 ? 's' : ''} not on the model` : 'Dial, screen and lights mapped', area: 'model', go: 'design' },
    ...(m.stateMachine === false ? [] : [{ id: 'interactions', title: 'Design the interactions', done: m.interactions > 0, detail: m.interactions ? `${m.interactions} interaction${m.interactions > 1 ? 's' : ''}` : 'None yet', area: 'interactions', go: 'proto' } as Milestone]),
    { id: 'review', title: 'Clear review comments', done: m.comments === 0, detail: m.comments ? `${m.comments} open` : 'None open', area: 'review', go: 'review' },
  ];
}
