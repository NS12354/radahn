import { describe, it, expect } from 'vitest';
import { wiringDoc, parseWiring, needsApproval, describeChange, catalogDoc } from '../src/app/wiringdoc';
import { BOARDS } from '../src/hw/library/boards';
import type { CompInstance } from '../src/hw/types';

const pico = BOARDS.picow;
const comps = (): CompInstance[] => [
  { uid: 'b1', type: 'button', pins: { SIG: 6 }, color: '#f00' },
  { uid: 's1', type: 'sht40', pins: { SDA: 4, SCL: 5 }, color: '#0f0' },
];
const edit = (f: (d: any) => void) => { const d = JSON.parse(wiringDoc(pico, comps())); f(d); return JSON.stringify(d); };

describe('wiring.json for Claude Code', () => {
  it('shows pins as board labels', () => {
    const d = JSON.parse(wiringDoc(pico, comps(), 'Applied.'));
    expect(d.board).toBe('picow'); expect(d._status).toBe('Applied.');
    expect(d.parts[0]).toMatchObject({ id: 'b1', type: 'button', pins: { SIG: 'GP6' } });
  });
  it('round-trips with no change', () => {
    const c = parseWiring(wiringDoc(pico, comps()), { board: 'picow', comps: comps() });
    expect(describeChange(c)).toBe(''); expect(needsApproval(c)).toBe(false);
  });
  it('applies pin moves without approval', () => {
    const c = parseWiring(edit(d => { d.parts[0].pins.SIG = 'GP7'; }), { board: 'picow', comps: comps() });
    expect(needsApproval(c)).toBe(false);
    expect(c.rewired).toEqual([{ uid: 'b1', name: 'Push button (to GND)', role: 'SIG', to: 'GP7' }]);
    expect(c.comps[0].pins.SIG).toBe(7);
  });
  it('needs approval to add or remove hardware or change the board', () => {
    const add = parseWiring(edit(d => d.parts.push({ type: 'buzzer', pins: { SIG: 'GP15' } })), { board: 'picow', comps: comps() });
    expect(needsApproval(add)).toBe(true); expect(add.added[0].pins.SIG).toBe(15);
    expect(describeChange(add)).toBe('add a Passive piezo buzzer (SIG GP15)');
    const rm = parseWiring(edit(d => d.parts.splice(1, 1)), { board: 'picow', comps: comps() });
    expect(needsApproval(rm)).toBe(true); expect(rm.removed.map(r => r.uid)).toEqual(['s1']);
    const sw = parseWiring(edit(d => { d.board = 'uno'; d.parts[0].pins.SIG = 'D2'; d.parts[1].pins = { SDA: 'A4', SCL: 'A5' }; }), { board: 'picow', comps: comps() });
    expect(needsApproval(sw)).toBe(true); expect(sw.boardChanged).toBe(true); expect(sw.comps[1].pins.SDA).toBe(18);
  });
  it('rejects bad edits in plain language', () => {
    const cur = { board: 'picow', comps: comps() };
    expect(() => parseWiring('{nope', cur)).toThrow(/isn't valid JSON/);
    expect(() => parseWiring(edit(d => { d.parts[0].pins.SIG = 'GP99'; }), cur)).toThrow(/"GP99" isn't a pin/);
    expect(() => parseWiring(edit(d => d.parts.push({ type: 'flux-capacitor' })), cur)).toThrow(/unknown part type/);
    expect(() => parseWiring(edit(d => { d.parts[0].pins.FOO = 'GP1'; }), cur)).toThrow(/has no "FOO" pin/);
    expect(() => parseWiring(edit(d => { d.parts[0].type = 'led'; }), cur)).toThrow(/can't change the type/);
    expect(() => parseWiring(edit(d => { d.board = 'nope'; }), cur)).toThrow(/Unknown board/);
  });
  it('lists parts and pins for Claude', () => {
    const md = catalogDoc(pico);
    expect(md).toContain('`neopixel`'); expect(md).toContain('GP28'); expect(md).toContain('← current');
  });
});
