import { describe, it, expect } from 'vitest';
import { emptyPlan, logEvent, milestones } from '../src/app/plan';
import { blankProject, parseProject, serializeProject } from '../src/app/project';

describe('Plan tab data', () => {
  it('merges repeated activity and keeps typing as one edit session', () => {
    const p = emptyPlan();
    logEvent(p, 'run', 'Ran the code'); logEvent(p, 'run', 'Ran the code'); logEvent(p, 'run', 'Ran the code');
    for (let i = 0; i < 50; i++) logEvent(p, 'code', 'Edited main.py');
    expect(p.log.map(e => e.text)).toEqual(['Ran the code ×3', 'Edited main.py']);
  });
  it('ticks milestones from project facts', () => {
    const base = { parts: 3, unconnected: 0, wiringBroken: 0, codeRan: true, runBroken: 0, tested: true, lastTest: { at: '', passed: true, failed: 0 }, hasModel: true, modelProblems: 0, roleTips: 0, interactions: 2, comments: 0 };
    expect(milestones(base).every(m => m.done)).toBe(true);
    const m = milestones({ ...base, unconnected: 2, runBroken: 1, lastTest: { at: '', passed: false, failed: 2 } });
    expect(m.find(x => x.id === 'wired')).toMatchObject({ done: false, detail: '2 pins not connected' });
    expect(m.find(x => x.id === 'runs')?.detail).toBe('1 error last run');
    expect(m.find(x => x.id === 'tested')?.detail).toBe('2 checks failed');
  });
  it('travels with the project file', () => {
    const p = blankProject(); p.plan = emptyPlan(); p.plan.tasks.push({ id: 't1', title: 'Finish the Pi code', status: 'doing', area: 'code', source: 'user', created: '' });
    expect(parseProject(serializeProject(p)).plan!.tasks[0].title).toBe('Finish the Pi code');
    expect(parseProject(serializeProject(blankProject())).plan).toEqual(emptyPlan()); // older projects get an empty plan
  });
});
