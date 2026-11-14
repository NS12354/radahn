import { describe, it, expect } from 'vitest';
import { blankProject, defaultProject, parseProject, serializeProject, starterFiles } from '../src/app/project';
import { BOARDS } from '../src/hw/library/boards';
import { step } from '../src/proto/stateMachine';
// @ts-ignore
import { preprocessIno } from '../server/compile.mjs';

describe('project format', () => {
  it('round-trips and rejects foreign JSON', () => {
    const p = defaultProject();
    const back = parseProject(serializeProject(p));
    expect(back.electronics.files['main.py']).toBe(p.electronics.files['main.py']);
    expect(() => parseProject('{"hello":1}')).toThrow(/Not a Formframe project/);
    expect(() => parseProject(JSON.stringify({ ...p, electronics: { ...p.electronics, board: 'nope' } }))).toThrow(/Unknown board/);
  });
});

describe('blank project', () => {
  it('has no model, parts, interactions or internals, and survives a round-trip', () => {
    const p = blankProject();
    expect(p.product.source).toBe('none');
    expect(p.electronics.comps).toEqual([]);
    expect(p.interactions).toEqual([]);
    expect(Object.values(p.internals).some(Boolean)).toBe(false);
    expect(Object.keys(p.electronics.files)).toEqual(['main.py']);
    const back = parseProject(serializeProject(p));
    expect(back.product.source).toBe('none');
    expect(back.electronics.starter).toBe('blank');
    expect(back.interactions).toEqual([]);
  });
  it('keeps a blank skeleton when parts are added or the board changes', () => {
    const p = blankProject('uno');
    expect(Object.keys(p.electronics.files)).toEqual(['sketch.ino']);
    p.electronics.comps.push({ uid: 'x', type: Object.keys(p.internals)[0], pins: {}, color: '#fff' } as any);
    expect(starterFiles(BOARDS.picow, p.electronics)['main.py']).not.toMatch(/thermostat/i);
  });
  it('treats old projects without a starter as the The First Step', () => {
    const p: any = JSON.parse(serializeProject(defaultProject())); delete p.electronics.starter;
    expect(parseProject(JSON.stringify(p)).electronics.starter).toBe('thermostat');
  });
});

describe('interaction state machine', () => {
  it('applies actions and reports unhandled events', () => {
    const p = defaultProject();
    let s = { state: 'home', target: 22, room: 20 };
    s = step(p.interactions, s, 'dial_cw').next;
    expect(s).toMatchObject({ state: 'set', target: 22.5 });
    expect(step(p.interactions, { ...s, state: 'eco' }, 'dial_cw').t).toBeNull();
  });
});

describe('Arduino preprocessing', () => {
  it('adds prototypes for functions used before definition', () => {
    const out = preprocessIno('#include <Wire.h>\nvoid setup(){ go(1); }\nvoid loop(){}\nint go(int x){ return x; }\n');
    expect(out).toMatch(/int go\(int x\);/);
    expect(out.indexOf('#include <Arduino.h>')).toBe(0);
  });
});
