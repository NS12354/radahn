import { describe, it, expect } from 'vitest';
import { autoBuild } from '../src/app/autobuild';
import { fitBuilt, bounds } from '../src/app/fit';
import { BOARDS } from '../src/hw/library/boards';
import { blankProject, defaultAutoOpts, kitFor, parseProject, serializeProject } from '../src/app/project';

const mk = (type: string, i = 0) => ({ uid: `${type}${i}`, type, pins: {}, color: '#fff' });
const roles = (r: ReturnType<typeof autoBuild>) => new Set(r.parts.map(p => p.role));

describe('auto build', () => {
  it('turns the thermostat kit into a round dial with a screen, a 24-segment light ring and a press', () => {
    const r = autoBuild(BOARDS.picow, kitFor('picow'), defaultAutoOpts());
    expect(r.style).toBe('round');
    expect(r.size[0]).toBeLessThan(100);
    for (const role of ['dial', 'screen', 'led'] as const) expect(roles(r).has(role)).toBe(true);
    expect(r.parts.find(p => p.role === 'led')!.segments).toBe(24);
    expect(r.notes.join(' ')).toMatch(/behind the display/);
    expect(fitBuilt(r.parts).filter(f => f.level !== 'ok')).toEqual([]);
  });

  it('lays out a row of controls in a rectangular case and keeps every board inside', () => {
    for (const id of Object.keys(BOARDS)) {
      const comps = ['button', 'button', 'pot', 'led', 'buzzer', 'sht40', 'relay', 'servo'].map(mk);
      const r = autoBuild(BOARDS[id], comps, { ...defaultAutoOpts(), battery: true });
      expect(r.style, id).toBe('rect');
      expect(r.parts.filter(p => p.role === 'press')).toHaveLength(2);
      expect(fitBuilt(r.parts).filter(f => f.level === 'err'), id).toEqual([]);
    }
  });

  it('gives a bare board a minimal case with its port cutouts and standoffs', () => {
    const r = autoBuild(BOARDS.pi5, [], { ...defaultAutoOpts(), mount: 'none' });
    const b = bounds(r.parts)!;
    expect(b.size[0]).toBeGreaterThan(85);
    expect(r.parts.filter(p => /cutout/.test(p.name)).length).toBe(4);
    expect(r.parts.filter(p => /Standoff/.test(p.name)).length).toBe(4);
  });

  it('survives a project round-trip', () => {
    const p = blankProject();
    const r = autoBuild(BOARDS.picow, kitFor('picow'), defaultAutoOpts());
    p.product.source = 'built';
    p.product.built = { parts: r.parts, xray: false, auto: defaultAutoOpts(), notes: r.notes };
    const back = parseProject(serializeProject(p));
    expect(back.product.built!.parts).toEqual(r.parts);
  });
});
