import { describe, it, expect } from 'vitest';
import { blankProject, defaultProject, type Project } from '../src/app/project';
import { estimatePower } from '../src/app/power';
import { buildBom, bomCsv } from '../src/app/bom';
import { validate } from '../src/app/validate';
import { CATALOG, STALE_DAYS } from '../src/hw/library/catalog';
import { COMPONENTS } from '../src/hw/library/components';
import { BOARDS } from '../src/hw/library/boards';

const comp = (type: string, pins: Record<string, number | null>, uid = type + Math.random().toString(36).slice(2, 6)) => ({ uid, type, pins, color: '#fff' });
const withComps = (board: string, comps: any[]): Project => { const p = blankProject(board); p.electronics.comps = comps; return p; };

describe('parts catalog', () => {
  it('every entry has the fields a buyer needs, and names real library parts', () => {
    for (const e of Object.values(CATALOG)) {
      expect(COMPONENTS[e.id] || BOARDS[e.id], e.id).toBeTruthy();
      expect(e.manufacturer && e.mpn && e.description && e.suppliers.length && e.simulation && e.sourceNote, e.id).toBeTruthy();
      if (e.price) { expect(e.price.low).toBeLessThanOrEqual(e.price.high); expect(e.price.asOf).toMatch(/^\d{4}-\d\d-\d\d$/); expect(e.price.source).toMatch(/not live/); }
      expect(e.verifiedAt, `${e.id} must not claim verification`).toBeUndefined();
    }
  });
});

describe('power estimate', () => {
  it('sums board and parts, typical and peak, from the catalog', () => {
    const p = withComps('esp32', [comp('sht40', { SDA: 21, SCL: 22 }), comp('neopixel', { DIN: 5 })]);
    const e = estimatePower(p);
    expect(e.typicalmA).toBe(CATALOG.esp32.typicalmA! + CATALOG.sht40.typicalmA! + CATALOG.neopixel.typicalmA!);
    expect(e.peakmA).toBe(CATALOG.esp32.peakmA! + CATALOG.sht40.peakmA! + CATALOG.neopixel.peakmA!);
    expect(e.assumptions.join(' ')).toMatch(/Wi-Fi/);
  });
  it('flags a peak above the supply, and gives a battery runtime range', () => {
    const p = withComps('picow', [comp('neopixel', { DIN: 7 })]);
    p.requirements = { power: 'usb' };
    expect(estimatePower(p).issues.some(i => i.level === 'fail' && /more than/.test(i.msg))).toBe(true);
    p.electronics.comps = [comp('sht40', { SDA: 4, SCL: 5 })]; p.requirements.power = 'lipo';
    const e = estimatePower(p);
    expect(e.runtime!.lowH).toBeLessThan(e.runtime!.highH);
    expect(e.runtime!.highH).toBeCloseTo((1200 * 0.85) / e.typicalmA, 0);
    expect(e.runtime!.formula).toMatch(/capacity/);
  });
  it('warns when a 5 V part is fed from a LiPo', () => {
    const p = withComps('picow', [comp('relay', { IN: 16 })]); p.requirements = { power: 'lipo' };
    expect(estimatePower(p).issues.some(i => /5 V/.test(i.msg))).toBe(true);
  });
});

describe('bill of materials', () => {
  it('lists exact parts with quantities, dated prices and subtotals', () => {
    const p = withComps('picow', [comp('button', { SIG: 6 }), comp('button', { SIG: 7 }), comp('oled', { SDA: 4, SCL: 5 })]);
    p.requirements = { power: 'lipo', qty: 10 };
    const b = buildBom(p, Date.parse('2026-12-01'));
    const btn = b.lines.find(l => l.key === 'button')!;
    expect(btn.qty).toBe(2); expect(btn.mpn).toMatch(/B3F/); expect(btn.ext!.low).toBeCloseTo(2 * CATALOG.button.price!.low);
    expect(b.lines.some(l => l.group === 'Power' && /LiPo/.test(l.name))).toBe(true);
    expect(b.total.low).toBeCloseTo(b.lines.reduce((a, l) => a + (l.ext?.low ?? 0), 0));
    expect(b.units).toBe(10);
    expect(bomCsv(b)).toMatch(/Qty for 10/);
  });
  it('never prices an unpriced line at zero, and flags stale prices and the budget', () => {
    const p = withComps('picow', [comp('servo', { SIG: 6 })]);
    p.product.source = 'built'; p.product.built = { parts: [{ id: 'h', name: 'Housing', shape: 'rbox', size: [80, 60, 30], pos: [0, 0, 0], rot: [0, 0, 0], color: '#fff', finish: 'matte', role: 'body', kind: 'shell' }], xray: false, auto: { style: 'auto', wall: 2, clearance: 1, battery: false, mount: 'none' }, notes: [] };
    p.requirements = { budget: 1 };
    const later = Date.parse('2026-11-25') + (STALE_DAYS + 5) * 864e5;
    const b = buildBom(p, later);
    const enc = b.lines.find(l => l.group === 'Enclosure')!;
    expect(enc.unit).toBeNull();
    expect(b.warnings.some(w => /no price/.test(w.msg))).toBe(true);
    expect(b.warnings.some(w => /older than/.test(w.msg))).toBe(true);
    expect(b.warnings.some(w => w.level === 'fail' && /budget/.test(w.msg))).toBe(true);
  });
});

describe('validation', () => {
  it('catches a pin used twice, an I2C address clash and 5 V logic on a 3.3 V board', () => {
    const p = withComps('picow', [comp('button', { SIG: 6 }), comp('led', { SIG: 6 }), comp('sht40', { SDA: 4, SCL: 5 }), comp('sht40', { SDA: 4, SCL: 5 }), comp('hcsr04', { TRIG: 10, ECHO: 11 })]);
    const v = validate(p);
    const failed = v.results.filter(r => r.status === 'failed').map(r => r.title).join('\n');
    expect(failed).toMatch(/GP6 is used by/);
    expect(failed).toMatch(/I2C address 0x44/);
    expect(v.results.some(r => r.category === 'Compatibility' && r.status === 'warning' && /5 V logic/.test(r.title))).toBe(true);
    expect(v.summary.status).toBe('blocked');
    for (const r of v.results) { expect(r.evidence).toBeTruthy(); if (r.status === 'failed') expect(r.fix).toBeTruthy(); }
  });
  it('uses every status, and never claims checks it does not do', () => {
    const v = validate(defaultProject());
    const st = new Set(v.results.map(r => r.status));
    for (const s of ['passed', 'estimated', 'not-checked', 'unsupported']) expect(st.has(s as any), s).toBe(true);
    expect(v.results.find(r => r.category === 'Mechanical fit')!.detail ?? '').toMatch(/not a 3D collision check/);
  });
  it('finds unreachable and dead-end states in the interaction table', () => {
    const p = defaultProject();
    p.interactions = [{ from: 'home', trig: 'press', to: 'menu', act: '', led: '', hap: false, snd: false }, { from: 'island', trig: 'press', to: 'home', act: '', led: '', hap: false, snd: false }];
    const t = validate(p).byCategory.Behaviour.map(r => r.title).join('\n');
    expect(t).toMatch(/island can never be reached/);
    expect(t).toMatch(/No way out of menu/);
  });
  it('detects parts colliding and sticking out of the case', () => {
    const p = blankProject('picow'); p.product.source = 'built';
    const box = (id: string, pos: [number, number, number], size: [number, number, number], kind: 'shell' | 'internal') => ({ id, name: id, shape: 'box' as const, size, pos, rot: [0, 0, 0] as [number, number, number], color: '#fff', finish: 'matte', role: 'body' as const, kind });
    p.product.built = { parts: [box('Case', [0, 0, 0], [50, 50, 20], 'shell'), box('A', [0, 0, 0], [10, 10, 5], 'internal'), box('B', [3, 0, 0], [10, 10, 5], 'internal'), box('C', [40, 0, 0], [10, 10, 5], 'internal')], xray: false, auto: { style: 'auto', wall: 2, clearance: 1, battery: false, mount: 'none' }, notes: [] };
    const fit = validate(p).byCategory['Mechanical fit'].map(r => r.title).join('\n');
    expect(fit).toMatch(/A collides with B/);
    expect(fit).toMatch(/C sticks out of the enclosure/);
  });
});
