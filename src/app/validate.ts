/**
 * One place that answers "will this work?": every check, grouped by category, each with
 * a status, how much to trust it, the evidence, the fix, and whether the simulation can
 * still run. Pure (no DOM): the Validate panel and the export package both read it.
 *
 * Deterministic rules only. Nothing here asks an AI to decide whether wiring is safe.
 */
import type { Project } from './project';
import { runChecks } from '../hw/checks';
import { COMPONENTS } from '../hw/library/components';
import { BOARDS } from '../hw/library/boards';
import { CATALOG } from '../hw/library/catalog';
import { fitBuilt, bounds } from './fit';
import { fitCheck } from './internals';
import { estimatePower } from './power';
import { buildBom } from './bom';

export type Category = 'Wiring' | 'Compatibility' | 'Power' | 'Behaviour' | 'Mechanical fit' | 'Components' | 'Cost' | 'Simulation coverage';
export type Status = 'passed' | 'warning' | 'failed' | 'not-checked' | 'unsupported' | 'estimated';
export type Trust = 'verified' | 'datasheet' | 'estimated' | 'visual' | 'unsupported';
export interface Result {
  category: Category; status: Status; confidence: Trust;
  title: string; detail?: string;
  /** the rule or data the result rests on */ evidence: string;
  fix?: string; parts?: string[];
  /** can Run still be used with this open? */ canSimulate: boolean;
}
export interface Validation { results: Result[]; byCategory: Record<Category, Result[]>; summary: { status: 'ready' | 'issues' | 'blocked'; failed: number; warnings: number; notChecked: number; text: string } }

export const CATEGORIES: Category[] = ['Wiring', 'Compatibility', 'Power', 'Behaviour', 'Mechanical fit', 'Components', 'Cost', 'Simulation coverage'];

export function validate(p: Project, opts: { ranOk?: boolean } = {}): Validation {
  const R: Result[] = [];
  const board = BOARDS[p.electronics.board], comps = p.electronics.comps;
  const nameOf = (uid?: string) => { const c = comps.find(x => x.uid === uid); return c ? COMPONENTS[c.type]?.name ?? c.type : undefined; };

  // ---- wiring + compatibility (existing electrical rules)
  if (!board) R.push({ category: 'Wiring', status: 'failed', confidence: 'verified', title: `Unknown board "${p.electronics.board}"`, evidence: 'Board library', fix: 'Pick a board in Electronics.', canSimulate: false });
  else {
    for (const c of runChecks(board, comps)) {
      const power = /rail|mA of|from one pin/.test(c.msg), compat = /input-only|ADC|PWM|strapping|USB serial|SPI pin pair|I2C pin pair|doesn't exist/.test(c.msg);
      const cat: Category = power ? 'Power' : compat ? 'Compatibility' : 'Wiring';
      R.push({ category: cat, status: c.level === 'err' ? 'failed' : c.level === 'warn' ? 'warning' : 'passed', confidence: power ? 'estimated' : 'verified', title: c.msg, evidence: power ? `Board rail limits for ${board.name} and part current figures` : `${board.name} pin map (GPIO, ADC, PWM, bus pin groups)`, fix: c.level === 'ok' ? undefined : fixFor(c.msg), parts: c.uid ? [nameOf(c.uid)!].filter(Boolean) : undefined, canSimulate: !(c.level === 'err' && /used by|doesn't exist/.test(c.msg)) });
    }
    // I2C address conflicts on the same bus
    const i2c = new Map<string, string[]>();
    for (const c of comps) {
      const def = COMPONENTS[c.type]; if (!def?.roles.some(r => r.kind === 'i2c-sda')) continue;
      const addr = (c as any).props?.address ?? def.i2cAddress ?? CATALOG[c.type]?.i2c?.[0]; if (addr == null) continue;
      const key = `${c.pins.SDA}/${c.pins.SCL}@${addr}`; i2c.set(key, [...(i2c.get(key) ?? []), def.name]);
    }
    let i2cClash = false;
    for (const [key, names] of i2c) if (names.length > 1) {
      i2cClash = true; const addr = +key.split('@')[1];
      R.push({ category: 'Compatibility', status: 'failed', confidence: 'datasheet', title: `I2C address 0x${addr.toString(16)} is used by ${names.join(' and ')} on the same bus`, evidence: 'Default I2C addresses from the parts catalog', fix: 'Change one part’s address (most modules have an address jumper), or put it on the other I2C bus.', parts: names, canSimulate: true });
    }
    if (!i2cClash && i2c.size) R.push({ category: 'Compatibility', status: 'passed', confidence: 'datasheet', title: `${i2c.size} I2C device${i2c.size > 1 ? 's' : ''}, no address conflicts`, evidence: 'Default I2C addresses from the parts catalog', canSimulate: true });
    // logic level: a 5 V part talking to a 3.3 V board
    for (const c of comps) {
      const cat = CATALOG[c.type], def = COMPONENTS[c.type]; if (!def) continue;
      const lv = cat?.logicV ?? def.logic;
      if (lv === 5 && board.logicV === 3.3 && def.roles.some(r => r.kind === 'digital-in' || r.kind === 'data' || r.kind === 'i2c-sda'))
        R.push({ category: 'Compatibility', status: 'warning', confidence: cat ? 'datasheet' : 'estimated', title: `${def.name} uses 5 V logic; ${board.name} pins are 3.3 V`, detail: 'Its outputs can exceed what the board’s pins tolerate.', evidence: `Logic levels: part ${lv} V, board ${board.logicV} V`, fix: 'Add a level shifter or a resistor divider on the signals going into the board.', parts: [def.name], canSimulate: true });
    }
    // supply voltage the board can't provide
    for (const c of comps) {
      const cat = CATALOG[c.type]; if (!cat?.supplyV) continue;
      if (cat.supplyV[0] > 5.5) R.push({ category: 'Power', status: 'failed', confidence: cat.confidence === 'datasheet' ? 'datasheet' : 'estimated', title: `${COMPONENTS[c.type]?.name ?? c.type} needs at least ${cat.supplyV[0]} V`, evidence: 'Catalog supply range', fix: 'Add a separate supply for it.', canSimulate: true });
    }
    if (!comps.length) R.push({ category: 'Wiring', status: 'not-checked', confidence: 'verified', title: 'No parts wired yet', evidence: 'Electronics is empty', fix: 'Add parts in Electronics.', canSimulate: true });
  }

  // ---- power
  const pw = estimatePower(p);
  R.push({ category: 'Power', status: 'estimated', confidence: 'estimated', title: `About ${pw.typicalmA} mA typical, ${pw.peakmA} mA peak`, detail: pw.source ? `${pw.source.label}: ${pw.marginPct}% headroom at peak${pw.runtime ? `; battery roughly ${pw.runtime.lowH}–${pw.runtime.highH} h` : ''}.` : undefined, evidence: 'Sum of catalog typical and peak currents (see Build → Power)', canSimulate: true });
  for (const i of pw.issues) R.push({ category: 'Power', status: i.level === 'fail' ? 'failed' : 'warning', confidence: 'estimated', title: i.msg, evidence: 'Power estimate', fix: i.fix, parts: i.parts, canSimulate: true });

  // ---- behaviour
  const sm = p.interactions ?? [];
  if (sm.length) {
    const states = new Set<string>(['home']); for (const t of sm) { states.add(t.from); states.add(t.to); }
    const reach = new Set<string>(['home']); let grew = true;
    while (grew) { grew = false; for (const t of sm) if (reach.has(t.from) && !reach.has(t.to)) { reach.add(t.to); grew = true; } }
    const dead = [...states].filter(s => !reach.has(s)), stuck = [...reach].filter(s => !sm.some(t => t.from === s));
    R.push({ category: 'Behaviour', status: dead.length ? 'warning' : 'passed', confidence: 'verified', title: dead.length ? `State${dead.length > 1 ? 's' : ''} ${dead.join(', ')} can never be reached from Home` : `All ${states.size} states are reachable from Home`, evidence: 'Interaction table: reachability from the initial state', fix: dead.length ? 'Add a transition into them, or delete them.' : undefined, canSimulate: true });
    if (stuck.length) R.push({ category: 'Behaviour', status: 'warning', confidence: 'verified', title: `No way out of ${stuck.join(', ')}`, evidence: 'Interaction table: states with no outgoing transition', fix: 'Add a transition back (a timeout or a press).', canSimulate: true });
  }
  R.push(opts.ranOk
    ? { category: 'Behaviour', status: 'passed', confidence: 'estimated', title: 'The code ran without errors in the simulator', evidence: 'Last Run / Test it', canSimulate: true }
    : { category: 'Behaviour', status: 'not-checked', confidence: 'estimated', title: 'The code hasn’t been run since it last changed', evidence: 'No run recorded', fix: 'Press Run (or Test it) and use the inputs.', canSimulate: true });

  // ---- mechanical fit
  const built = p.product.source === 'built' ? p.product.built : null;
  if (built?.parts.length) {
    const rows = fitBuilt(built.parts);
    for (const r of rows) R.push({ category: 'Mechanical fit', status: r.level === 'err' ? 'failed' : r.level === 'warn' ? 'warning' : 'passed', confidence: 'visual', title: r.msg, evidence: 'Bounding shapes of each part (boxes, circles, rings), not a CAD kernel', fix: r.level === 'err' ? 'Move or resize the part in Product, or rebuild the case with Auto build.' : undefined, canSimulate: true });
    const max = p.requirements?.maxSize, b = bounds(built.parts);
    if (max && b) { const over = b.size.some((v, i) => v > max[i] + 0.5); R.push({ category: 'Mechanical fit', status: over ? 'failed' : 'passed', confidence: 'visual', title: over ? `The model (${b.size.map(Math.round).join(' × ')} mm) is bigger than the ${max.join(' × ')} mm limit` : `Within the ${max.join(' × ')} mm size limit`, evidence: 'Model bounding box vs. the requirement', fix: over ? 'Shrink the case or rearrange parts.' : undefined, canSimulate: true }); }
    R.push({ category: 'Mechanical fit', status: 'unsupported', confidence: 'unsupported', title: 'Connector access, cable space, tolerances and printability aren’t checked', evidence: 'Not implemented', canSimulate: true });
  } else if (p.product.source === 'parametric') {
    const f = fitCheck(p);
    R.push({ category: 'Mechanical fit', status: 'estimated', confidence: 'estimated', title: f.ok ? 'Internal parts fit the built-in model’s footprint' : 'An internal part is bigger than the built-in model’s space', detail: 'This compares footprints and stack height, not a 3D collision check.', evidence: 'Footprint and stack-height comparison', canSimulate: true });
  } else R.push({ category: 'Mechanical fit', status: 'not-checked', confidence: 'unsupported', title: p.product.source === 'imported' ? 'Fit isn’t checked for imported CAD models' : 'No model to check yet', evidence: p.product.source === 'imported' ? 'Imported meshes have no part metadata' : 'Product has no parts', fix: 'Add parts in Electronics (they appear in Product), then Auto build a case.', canSimulate: true });

  // ---- components, cost, simulation coverage
  const types = [p.electronics.board, ...new Set(comps.map(c => c.type))];
  const unsourced = types.filter(t => !CATALOG[t]);
  R.push({ category: 'Components', status: unsourced.length ? 'warning' : 'passed', confidence: 'estimated', title: unsourced.length ? `No part number or supplier on file for ${unsourced.map(t => COMPONENTS[t]?.name ?? BOARDS[t]?.name ?? t).join(', ')}` : 'Every part has a manufacturer part number and supplier', evidence: 'Parts catalog', fix: unsourced.length ? 'Look the part up before ordering; its specs are typical module values.' : undefined, canSimulate: true });
  const unverified = types.filter(t => CATALOG[t] && !CATALOG[t].verifiedAt);
  if (unverified.length) R.push({ category: 'Components', status: 'estimated', confidence: 'estimated', title: `${unverified.length} part${unverified.length > 1 ? 's’' : '’s'} catalog data hasn’t been checked against a supplier listing`, evidence: 'Catalog verifiedAt field', fix: 'Confirm part numbers and specs with the supplier before ordering.', canSimulate: true });
  const bom = buildBom(p);
  for (const w of bom.warnings) R.push({ category: 'Cost', status: w.level === 'fail' ? 'failed' : 'warning', confidence: 'estimated', title: w.msg, evidence: 'Bill of materials', canSimulate: true });
  R.push({ category: 'Cost', status: 'estimated', confidence: 'estimated', title: `Parts ≈ $${bom.total.low.toFixed(2)}–$${bom.total.high.toFixed(2)} per unit`, detail: `Excludes ${bom.exclusions.join(', ').toLowerCase()}.`, evidence: 'Bill of materials (manually maintained price estimates)', canSimulate: true });
  if (board) R.push({ category: 'Simulation coverage', status: board.fidelity === 'emulated' ? 'passed' : 'estimated', confidence: board.fidelity === 'emulated' ? 'verified' : 'estimated', title: board.fidelity === 'emulated' ? `${board.name}: your real firmware runs on an emulated chip` : `${board.name}: behavioural simulation of its programming API, not the chip`, evidence: 'Board runtime', canSimulate: true });
  for (const t of new Set(comps.map(c => c.type))) { const s = CATALOG[t]?.simulation; if (s) R.push({ category: 'Simulation coverage', status: 'passed', confidence: 'estimated', title: `${COMPONENTS[t]?.name ?? t}: ${s}`, evidence: 'Device model', canSimulate: true }); }
  if (board && ['picow', 'pico2w', 'esp32', 'esp32s3', 'esp32c3', 'esp32c6', 'xiaos3', 'nanoesp32', 'esp32s2', 'esp8266', 'd1mini'].includes(board.id)) R.push({ category: 'Simulation coverage', status: 'unsupported', confidence: 'unsupported', title: 'Wi-Fi and Bluetooth aren’t simulated', evidence: 'No radio model', canSimulate: true });

  const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, R.filter(r => r.category === c)])) as Validation['byCategory'];
  const failed = R.filter(r => r.status === 'failed').length, warnings = R.filter(r => r.status === 'warning').length, notChecked = R.filter(r => r.status === 'not-checked').length;
  const status = failed ? 'blocked' : warnings || notChecked ? 'issues' : 'ready';
  const text = failed ? `${failed} problem${failed > 1 ? 's' : ''} to fix before building` : warnings ? `No blockers; ${warnings} warning${warnings > 1 ? 's' : ''} to review` : notChecked ? 'No problems found; some checks haven’t run yet' : 'Ready to build a first prototype';
  return { results: R, byCategory, summary: { status, failed, warnings, notChecked, text } };
}

function fixFor(msg: string): string {
  if (/is used by/.test(msg)) return 'Move one of them to a free pin on the bench.';
  if (/not connected/.test(msg)) return 'Pick a pin for it on the bench.';
  if (/input-only/.test(msg)) return 'Move it to a pin that can drive outputs.';
  if (/ADC2/.test(msg)) return 'Use an ADC1 pin if you need Wi-Fi.';
  if (/not an ADC pin|no analog/.test(msg)) return 'Move it to one of the listed ADC pins.';
  if (/hardware PWM/.test(msg)) return 'Move it to a PWM-capable pin.';
  if (/strapping/.test(msg)) return 'Prefer another pin, or make sure the part doesn’t pull it at boot.';
  if (/USB serial/.test(msg)) return 'Use a different pin.';
  if (/SPI pin pair|I2C pin pair/.test(msg)) return 'Use a hardware bus pin pair (the bench suggests one).';
  if (/rail peak|5 V peak/.test(msg)) return 'Power the heavy loads from a separate supply.';
  if (/from one pin/.test(msg)) return 'Drive it through a transistor or MOSFET.';
  return 'See the message.';
}
