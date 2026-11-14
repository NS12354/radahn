import { describe, it, expect } from 'vitest';
import { autoBuild, mergeRebuild } from '../src/app/autobuild';
import { BOARDS } from '../src/hw/library/boards';
import { defaultAutoOpts, kitFor, type BuiltPart } from '../src/app/project';

const pico = BOARDS.picow;
describe('rebuild from electronics', () => {
  it('builds only what is wired, with no wall plate by default', () => {
    const lcd = kitFor('picow').filter(c => c.type === 'tft');
    const r = autoBuild(pico, lcd, defaultAutoOpts());
    const names = r.parts.map(p => p.name).join(' | ');
    expect(names).toContain('LCD');
    for (const t of ['Relay', 'buzzer', 'Haptic', 'Dial', 'Light ring', 'Wall plate']) expect(names).not.toContain(t);
  });
  it('drops kept model parts of hardware that is no longer wired', () => {
    const kit = kitFor('picow');
    const before = autoBuild(pico, kit, defaultAutoOpts()).parts.map(p => ({ ...p, auto: false })); // e.g. all "kept" / duplicated
    const lcd = kit.filter(c => c.type === 'tft');
    const mine: BuiltPart = { id: 'x', name: 'My logo', shape: 'box', size: [5, 5, 1], pos: [0, 0, 0], rot: [0, 0, 0], color: '#fff', finish: 'matte', role: 'body' };
    const m = mergeRebuild([...before, mine], autoBuild(pico, lcd, defaultAutoOpts()), lcd, false);
    const names = m.parts.map(p => p.name);
    expect(names).toContain('My logo');
    expect(names.join('|')).not.toMatch(/Relay|piezo|Haptic|SHT40|Rotary/);
    expect(m.dropped.join(' ')).toMatch(/Relay/);
    // the still-wired LCD isn't duplicated
    expect(names.filter(n => /LCD module/.test(n))).toHaveLength(1);
  });
});
