import { describe, it, expect } from 'vitest';
import { screenPart } from '../src/app/screenpart';
import type { BuiltPart } from '../src/app/project';

const part = (id: string, name: string, extra: Partial<BuiltPart> = {}): BuiltPart =>
  ({ id, name, shape: 'cyl', size: [30, 30, 4], pos: [0, 0, 0], rot: [0, 0, 0], color: '#000', finish: 'matte', role: 'body', ...extra });

describe('which model part shows the display', () => {
  it('uses the part with the Screen role', () => {
    expect(screenPart([part('a', 'GC9A01 round LCD module'), part('b', 'Face', { role: 'screen' })])).toEqual({ id: 'b', auto: false });
  });
  it('picks the display part by name when no part has the role', () => {
    expect(screenPart([part('h', 'Housing'), part('l', 'GC9A01 1.28" round LCD module')])).toEqual({ id: 'l', auto: true });
  });
  it('prefers a display window over the module, and never a bezel', () => {
    const r = screenPart([part('m', 'LCD module'), part('z', 'Display bezel', { shape: 'tube' }), part('w', 'Display window', { shape: 'disc' })]);
    expect(r?.id).toBe('w');
    expect(screenPart([part('z', 'Display bezel'), part('f', 'Screen frame')])).toBeNull();
  });
  it('leaves models without a display part alone', () => {
    expect(screenPart([part('h', 'Housing'), part('d', 'Dial ring', { role: 'dial' }), part('c', 'Cylinder')])).toBeNull();
    expect(screenPart([part('x', 'OLED', { role: 'ignore' })])).toBeNull();
  });
});
