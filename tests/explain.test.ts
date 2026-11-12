import { describe, it, expect } from 'vitest';
import { explainCheck, explainSim, explainPython, explainCompile, parseTraceback, suggest } from '../src/app/explain';
import { runChecks } from '../src/hw/checks';
import { BOARDS } from '../src/hw/library/boards';
import { kitFor } from '../src/app/project';

const files = { 'main.py': 'from sht4x import SHT4x\nsensor = SHT4x(i2c)\nwhile True:\n    t = sensr.temperature\n' };

describe('plain-language problems', () => {
  it('reads MicroPython and simulator tracebacks and suggests the typo fix', () => {
    const mp = parseTraceback(['Traceback (most recent call last):', '  File "<stdin>", line 4, in <module>', "NameError: name 'sensr' isn't defined"])!;
    expect(mp).toMatchObject({ type: 'NameError', line: 4, file: 'main.py' });
    const x = explainPython(mp.type, mp.message, mp.line, files);
    expect(x.title).toBe('Line 4 uses `sensr`, which doesn\'t exist');
    expect(x.fix).toMatch(/Did you mean `sensor`/);
    expect(x.at).toMatchObject({ file: 'main.py', line: 4 });
    const sk = parseTraceback(["Traceback: ImportError: No module named 'bme280' on line 1"])!;
    expect(explainPython(sk.type, sk.message, sk.line, files).title).toMatch(/library `bme280` isn't in the project/);
    expect(explainPython('SyntaxError', 'invalid syntax', 3, { 'main.py': 'a\nb\nif x > 2\n' }).fix).toMatch(/colon/);
    expect(suggest('pritn', { a: 'print(1)' })).toBe('print');
  });

  it('turns wiring checks into fixable problems', () => {
    const comps = kitFor('picow'); comps[1].pins.SIG = comps[0].pins.CLK; // button on the encoder's pin
    const checks = runChecks(BOARDS.picow, comps).map(c => explainCheck(c.msg, c.level, c.uid)).filter(Boolean);
    const clash = checks.find(c => /same pin/.test(c!.title))!;
    expect(clash.level).toBe('broken'); expect(clash.autofix?.kind).toBe('move');
    const loose = explainCheck('Push button (to GND): SIG is not connected.', 'warn', 'u1')!;
    expect(loose.title).toBe("The button isn't connected (SIG pin)"); expect(loose.autofix).toMatchObject({ kind: 'connect', uid: 'u1', role: 'SIG' });
  });

  it('explains simulator warnings and Arduino compiler errors', () => {
    expect(explainSim('[sim] GP9 (output) isn\'t connected to any component.').title).toBe('Your code uses GP9, but nothing is plugged into it');
    const fl = explainSim('[sim] GP6 has no pull resistor, so the input floats when released. Add Pin.PULL_UP.');
    expect(fl.autofix).toMatchObject({ kind: 'pullup', pin: 6 });
    const errs = explainCompile("/tmp/x/thermostat.ino:12:3: error: 'ledPn' was not declared in this scope\n/tmp/x/thermostat.ino:20:1: error: expected ';' before '}' token", { 'thermostat.ino': 'int ledPin = 3;' });
    expect(errs.map(e => e.title)).toEqual(['Line 12 uses `ledPn`, which isn\'t defined', 'A semicolon is missing near line 20']);
    expect(errs[0].fix).toMatch(/ledPin/);
  });
});
