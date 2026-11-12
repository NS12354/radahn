import { describe, it, expect } from 'vitest';
import { runChecks } from '../src/hw/checks';
import { BOARDS } from '../src/hw/library/boards';
import { kitFor } from '../src/app/project';

describe('electrical checks', () => {
  it('passes the default kit on every board without errors', () => {
    for (const id of Object.keys(BOARDS)) {
      const errs = runChecks(BOARDS[id], kitFor(id)).filter(c => c.level === 'err');
      expect(errs.map(e => e.msg), id).toEqual([]);
    }
  });
  it('flags pin conflicts, missing ADC, and wrong SPI pins', () => {
    const b = BOARDS.picow, kit = kitFor('picow');
    kit.find(c => c.type === 'button')!.pins.SIG = kit.find(c => c.type === 'relay')!.pins.IN;
    kit.find(c => c.type === 'tft')!.pins.SCK = 9;
    kit.push({ uid: 'p', type: 'pot', pins: { WIPER: 20 }, color: '#fff' });
    const msgs = runChecks(b, kit).filter(c => c.level === 'err').map(c => c.msg).join('\n');
    expect(msgs).toMatch(/GP16 is used by/);
    expect(msgs).toMatch(/hardware SPI pin pair/);
    expect(msgs).toMatch(/not an ADC pin/);
    const pi = runChecks(BOARDS.pi5, [{ uid: 'p', type: 'pot', pins: { WIPER: 5 }, color: '#fff' }]);
    expect(pi.some(c => /no analog inputs/.test(c.msg))).toBe(true);
  });
});
