import { describe, it, expect } from 'vitest';
import { screenPart } from '../src/app/screenpart';
import type { BuiltPart } from '../src/app/project';

const part = (id: string, name: string, extra: Partial<BuiltPart> = {}): BuiltPart =>
  ({ id, name, shape: 'cyl', size: [30, 30, 4], pos: [0, 0, 0], rot: [0, 0, 0], color: '#000', finish: 'matte', role: 'body', ...extra });

// what auto build makes for a wired LCD (uid "lcd"): module, bezel and a window in front of the module
const module = part('m', 'GC9A01 1.28" round LCD module', { comp: 'lcd', auto: true, pos: [0, 0, 5], size: [38, 38, 4] });
const bezel = part('z', 'Display bezel', { comp: 'lcd', auto: true, shape: 'tube', pos: [0, 0, 8] });
const window = part('w', 'Display window', { comp: 'lcd', auto: true, shape: 'disc', role: 'screen', pos: [0, 0, 7.5], size: [32, 32, 0.3] });

describe('which model part shows the display', () => {
  it('uses the display window while it sits in front of the wired LCD', () => {
    expect(screenPart([module, bezel, window], ['lcd'])).toMatchObject({ id: 'w', why: 'wiring' });
  });
  it('follows the LCD when it was moved away from the window', () => {
    const moved = { ...module, pos: [60, 0, 5] as [number, number, number] };
    expect(screenPart([moved, bezel, window], ['lcd'])).toMatchObject({ id: 'm', why: 'wiring' });
  });
  it('uses the LCD module when there is no window (hand-built model)', () => {
    expect(screenPart([part('h', 'Housing'), { ...module, auto: false }], ['lcd'])).toMatchObject({ id: 'm', why: 'wiring' });
  });
  it('the wired LCD beats a part that only looks like a display by name', () => {
    expect(screenPart([part('s', 'Screen sticker'), module], ['lcd'])?.id).toBe('m');
  });
  it('a Screen role you set yourself wins', () => {
    expect(screenPart([module, window, part('b', 'Face', { role: 'screen' })], ['lcd'])).toEqual({ id: 'b', why: 'role', auto: false });
  });
  it('without wiring links, falls back to the Screen role, then the name', () => {
    expect(screenPart([part('h', 'Housing'), part('l', 'GC9A01 round LCD module')])).toMatchObject({ id: 'l', why: 'name' });
    expect(screenPart([part('z', 'Display bezel'), part('f', 'Screen frame')])).toBeNull();
    expect(screenPart([part('h', 'Housing'), part('d', 'Dial ring', { role: 'dial' }), part('c', 'Cylinder')])).toBeNull();
  });
});
