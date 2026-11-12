import { describe, it, expect } from 'vitest';
import { specFromExtraction, registerCustom, cardKind } from '../src/hw/custom';
import { COMPONENTS } from '../src/hw/library/components';
import { blankProject, defaultAutoOpts, parseProject, serializeProject } from '../src/app/project';
import { autoBuild } from '../src/app/autobuild';
import { BOARDS } from '../src/hw/library/boards';
import { runChecks } from '../src/hw/checks';
// @ts-ignore
import { htmlToText, heuristic } from '../server/part-from-url.mjs';

const bme = { name: 'BME280 breakout', partNumber: 'BME280', category: 'sensor', interface: 'i2c', summary: 'Temp, humidity, pressure', uses: ['weather station'], requirements: ['Pull-ups on SDA/SCL'],
  pins: [{ id: 'SDA', kind: 'i2c-sda', description: '' }, { id: 'SCL', kind: 'i2c-scl', description: '' }], supplyMinV: 1.7, supplyMaxV: 3.6, logicV: 3.3, rail: '3v3',
  typicalmA: 0.7, peakmA: 1, i2cAddress: '0x77', activeLow: null, priceUSD: 9.95, sizeMm: { w: 25, h: 18, d: 4 }, surface: 'vents', confidence: 'high', missing: [] };

describe('parts from links', () => {
  it('turns an extraction into a wireable, checkable part', () => {
    const s = specFromExtraction(bme, { url: 'https://example.com/bme280', source: 'claude' }, new Set());
    expect(s.i2cAddress).toBe(0x77);
    registerCustom(s);
    expect(COMPONENTS[s.id].roles.map(r => r.kind)).toEqual(['i2c-sda', 'i2c-scl']);
    expect(cardKind(s)).toBe('generic');
    const comp = { uid: 'u1', type: s.id, pins: { SDA: 18, SCL: 19 }, color: '#fff' };
    // 3.3 V part on a 5 V Uno is flagged
    expect(runChecks(BOARDS.uno, [comp]).some(c => /3.3 V logic on a 5 V board/.test(c.msg))).toBe(true);
  });

  it('travels inside the project file and drives auto build', () => {
    const s = specFromExtraction({ ...bme, name: 'Arcade button', interface: 'digital-in', pins: [{ id: 'SW', kind: 'digital-in' }], surface: 'button' }, { source: 'manual' }, new Set());
    const p = blankProject();
    p.electronics.custom = { [s.id]: s };
    p.electronics.comps.push({ uid: 'b1', type: s.id, pins: { SW: 5 }, color: '#fff' });
    delete (COMPONENTS as any)[s.id]; // simulate opening on a fresh machine
    const back = parseProject(serializeProject(p));
    expect(COMPONENTS[s.id].name).toBe('Arcade button');
    const r = autoBuild(BOARDS.picow, back.electronics.comps, defaultAutoOpts());
    expect(r.parts.some(x => x.role === 'press' && x.comp === 'b1')).toBe(true);
  });

  it('reads a page without AI as a rough first guess', () => {
    const html = `<html><head><title>Mini PIR Motion Sensor | Example Shop</title><meta name="description" content="Detects motion up to 3&amp;nbsp;m"></head>
      <body><script>var x=1</script><table><tr><td>Supply</td><td>3.3V - 5V</td></tr><tr><td>Current</td><td>15 mA</td></tr><tr><td>Size</td><td>24 x 18 x 6 mm</td></tr></table><a href="/files/pir.pdf">Datasheet</a> $4.50</body></html>`;
    const page = { url: 'https://shop.example/pir', ...htmlToText(html, 'https://shop.example/pir') };
    expect(page.datasheets[0].href).toBe('https://shop.example/files/pir.pdf');
    expect(page.text).not.toMatch(/var x/);
    const g = heuristic(page);
    expect(g.name).toBe('Mini PIR Motion Sensor');
    expect(g.sizeMm).toEqual({ w: 24, h: 18, d: 6 });
    expect(g.priceUSD).toBe(4.5);
    expect(g.confidence).toBe('low');
  });
});
