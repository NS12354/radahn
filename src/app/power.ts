/**
 * Transparent power estimate from catalog figures. Pure: no DOM, safe to unit test.
 *
 * Typical = everything doing its usual job; peak = everything at its worst at once
 * (all LEDs white, radio transmitting, motors stalled), which is the number a supply
 * must survive. Battery runtime is a range: usable capacity (70–85 % of nominal) divided
 * by an average current between typical and a 25 % share of the peak extra.
 */
import type { Project } from './project';
import { COMPONENTS } from '../hw/library/components';
import { BOARDS } from '../hw/library/boards';
import { CATALOG, POWER_OPTIONS, type Confidence, type PowerOption } from '../hw/library/catalog';

export interface PowerLine { id: string; name: string; qty: number; typicalmA: number; peakmA: number; confidence: Confidence; from: 'catalog' | 'library' | 'missing' }
export interface PowerIssue { level: 'fail' | 'warn'; msg: string; fix: string; parts?: string[] }
export interface PowerEstimate {
  lines: PowerLine[];
  typicalmA: number;
  peakmA: number;
  source: PowerOption | null;
  /** Headroom between the source's continuous rating and the peak, % of the rating (negative = over). */
  marginPct: number | null;
  runtime: { lowH: number; highH: number; formula: string } | null;
  issues: PowerIssue[];
  assumptions: string[];
}

export function estimatePower(p: Project): PowerEstimate {
  const lines: PowerLine[] = [];
  const board = BOARDS[p.electronics.board], bc = CATALOG[p.electronics.board];
  if (board) lines.push(bc?.typicalmA != null
    ? { id: board.id, name: board.name, qty: 1, typicalmA: bc.typicalmA, peakmA: bc.peakmA ?? bc.typicalmA, confidence: bc.confidence, from: 'catalog' }
    : { id: board.id, name: board.name, qty: 1, typicalmA: 0, peakmA: 0, confidence: 'unknown', from: 'missing' });
  const byType = new Map<string, number>();
  for (const c of p.electronics.comps) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  for (const [type, qty] of byType) {
    const def = COMPONENTS[type], cat = CATALOG[type], name = def?.name ?? type;
    if (cat?.typicalmA != null) lines.push({ id: type, name, qty, typicalmA: cat.typicalmA, peakmA: cat.peakmA ?? cat.typicalmA, confidence: cat.confidence, from: 'catalog' });
    else if (def) lines.push({ id: type, name, qty, typicalmA: def.mA, peakmA: def.peakmA ?? def.mA, confidence: 'estimated', from: 'library' });
    else lines.push({ id: type, name, qty, typicalmA: 0, peakmA: 0, confidence: 'unknown', from: 'missing' });
  }
  const typicalmA = round1(lines.reduce((a, l) => a + l.typicalmA * l.qty, 0));
  const peakmA = round1(lines.reduce((a, l) => a + l.peakmA * l.qty, 0));
  const source = POWER_OPTIONS[p.requirements?.power ?? ''] ?? null;
  const issues: PowerIssue[] = [];
  const assumptions = [
    'Figures come from the parts catalog (typical and peak current at each part’s supply voltage); real draw depends on your code and how often things are on.',
    'Peak assumes everything is at its worst at the same time.',
  ];
  const missing = lines.filter(l => l.from === 'missing');
  if (missing.length) issues.push({ level: 'warn', msg: `No current data for ${missing.map(l => l.name).join(', ')}, so the totals are low.`, fix: 'Check the datasheet and treat the estimate as a lower bound.', parts: missing.map(l => l.id) });
  const radio = ['picow', 'pico2w', 'esp32', 'esp32s3', 'esp32c3', 'esp32c6', 'xiaos3', 'nanoesp32', 'esp32s2', 'esp8266', 'd1mini'].includes(p.electronics.board);
  if (radio) assumptions.push('Wi-Fi/Bluetooth bursts are included in the board’s peak; average radio use varies a lot with how often it transmits.');
  let marginPct: number | null = null, runtime: PowerEstimate['runtime'] = null;
  if (source) {
    marginPct = round(((source.maxmA - peakmA) / source.maxmA) * 100);
    if (peakmA > source.maxmA) issues.push({ level: 'fail', msg: `Peak ${peakmA} mA is more than ${source.label} can deliver (${source.maxmA} mA).`, fix: 'Use a bigger supply, limit LED brightness in code, or don’t run the heavy loads at once.' });
    else if (marginPct < 20) issues.push({ level: 'warn', msg: `Only ${marginPct}% headroom between the peak (${peakmA} mA) and the supply (${source.maxmA} mA).`, fix: 'Leave at least 20% margin for inrush and ageing.' });
    if (source.capacitymAh) {
      const avg = typicalmA + Math.max(0, peakmA - typicalmA) * 0.25;
      const highH = typicalmA > 0 ? (source.capacitymAh * 0.85) / typicalmA : Infinity, lowH = avg > 0 ? (source.capacitymAh * 0.7) / avg : Infinity;
      runtime = { lowH: round1(lowH), highH: round1(highH), formula: `runtime ≈ usable capacity ÷ average current = (${source.capacitymAh} mAh × 0.70–0.85) ÷ ${round(avg)}–${typicalmA} mA` };
      const needs5 = p.electronics.comps.filter(c => (CATALOG[c.type]?.supplyV?.[0] ?? 0) > 4.0);
      if (needs5.length) issues.push({ level: 'warn', msg: `${[...new Set(needs5.map(c => COMPONENTS[c.type]?.name ?? c.type))].join(', ')} need${needs5.length === 1 ? 's' : ''} about 5 V, but a LiPo gives 3.0–4.2 V.`, fix: 'Add a 5 V boost converter, or pick 3.3 V parts.', parts: [...new Set(needs5.map(c => c.type))] });
      assumptions.push('Battery: 70–85% of the nominal capacity is usable; protection and regulator losses are folded into that.');
    }
  } else issues.push({ level: 'warn', msg: 'No power source chosen, so headroom and battery life can’t be checked.', fix: 'Pick one under Product → Requirements → Power source.' });
  return { lines, typicalmA, peakmA, source, marginPct, runtime, issues, assumptions };
}

const round = (v: number) => Math.round(v);
const round1 = (v: number) => Math.round(v * 10) / 10;
