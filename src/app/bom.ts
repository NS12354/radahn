/**
 * Bill of materials from the parts actually in the project. Pure: safe to unit test.
 *
 * Every line names the exact part (manufacturer and part number from the catalog), the
 * quantity per unit and in total, a low–high price with its date and source, stock and
 * confidence. Anything without a price is listed as such (never as $0), and prices older
 * than STALE_DAYS are flagged. Shipping, tax and tooling are excluded and said to be.
 */
import type { Project } from './project';
import { COMPONENTS } from '../hw/library/components';
import { BOARDS } from '../hw/library/boards';
import { CATALOG, POWER_OPTIONS, STALE_DAYS, type CatalogEntry, type Confidence } from '../hw/library/catalog';

export type BomGroup = 'Electronics' | 'Power' | 'Connectors and cables' | 'Enclosure' ;
export interface BomLine {
  group: BomGroup; key: string; name: string; manufacturer: string; mpn: string; supplier: string; supplierUrl?: string; datasheet?: string;
  /** per product */ qty: number;
  unit: { low: number; high: number } | null;
  ext: { low: number; high: number } | null;
  asOf?: string; ageDays?: number; stale: boolean; priceSource?: string;
  stock: string; confidence: Confidence; required: boolean; note?: string;
}
export interface Bom {
  lines: BomLine[];
  /** Per-product totals by group, and overall (priced lines only). */
  subtotals: Record<BomGroup, { low: number; high: number }>;
  total: { low: number; high: number };
  units: number;
  warnings: { level: 'warn' | 'fail'; msg: string }[];
  exclusions: string[];
}

const DAY = 864e5;
export function buildBom(p: Project, now = Date.now()): Bom {
  const lines: BomLine[] = [];
  const add = (group: BomGroup, key: string, qty: number, cat: CatalogEntry | undefined, fallbackName: string, required = true, note?: string) => {
    const pr = cat?.price, ageDays = pr ? Math.floor((now - Date.parse(pr.asOf)) / DAY) : undefined;
    const sup = cat?.suppliers[0];
    lines.push({
      group, key, name: fallbackName, manufacturer: cat?.manufacturer ?? 'Unknown', mpn: cat?.mpn ?? 'No part number on file', supplier: sup ? `${sup.supplier}${sup.sku ? ` ${sup.sku}` : ''}` : 'No supplier on file', supplierUrl: sup?.url, datasheet: cat?.datasheet,
      qty, unit: pr ? { low: pr.low, high: pr.high } : null, ext: pr ? { low: pr.low * qty, high: pr.high * qty } : null,
      asOf: pr?.asOf, ageDays, stale: ageDays != null && ageDays > STALE_DAYS, priceSource: pr?.source,
      stock: cat?.stock ?? 'unknown', confidence: cat?.confidence ?? 'unknown', required: cat?.optional ? false : required, note,
    });
  };
  const board = BOARDS[p.electronics.board];
  if (board) add('Electronics', board.id, 1, CATALOG[board.id], board.name);
  const byType = new Map<string, number>();
  for (const c of p.electronics.comps) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  for (const [type, qty] of byType) add('Electronics', type, qty, CATALOG[type], COMPONENTS[type]?.name ?? type);
  // parts that plug into another part (servos on a servo driver)
  for (const c of p.electronics.comps) for (const [name, n] of COMPONENTS[c.type]?.bom?.(c) ?? []) {
    const ex = lines.find(l => l.key === `extra:${name}`);
    if (ex) { ex.qty += n; } else add('Electronics', `extra:${name}`, n, undefined, name, true, 'Plugs into another part; no catalog entry yet.');
  }
  const power = POWER_OPTIONS[p.requirements?.power ?? ''];
  if (power) for (const part of power.parts) add('Power', part.id, 1, part, part.mpn);
  const wired = p.electronics.comps.reduce((a, c) => a + Object.values(c.pins).filter(v => v != null).length, 0);
  if (wired) add('Connectors and cables', 'jumpers', 1, { id: 'jumpers', manufacturer: 'Generic', mpn: 'Dupont jumper wires, 40-pack', description: '', suppliers: [{ supplier: 'Generic module', sku: 'Dupont 40p' }], price: { low: 2, high: 4, currency: 'USD', asOf: '2026-11-25', source: 'manual estimate (typical hobby-supplier prices; not live)' }, stock: 'unknown', protocols: [], simulation: '', confidence: 'estimated', sourceNote: '' }, 'Jumper wires (breadboard prototype)', true, `${wired} connections plus power and ground.`);
  const shell = p.product.source === 'built' && p.product.built?.parts.some(q => q.kind === 'shell');
  if (shell) add('Enclosure', 'enclosure', 1, undefined, '3D-printed enclosure (PLA/PETG)', true, 'Not priced: depends on the printer or print service. Formframe doesn’t estimate fabrication cost.');
  else if (p.product.source === 'parametric') add('Enclosure', 'enclosure', 1, undefined, 'Enclosure (built-in thermostat model)', true, 'Not priced. The built-in model is a visual reference, not a fabrication design.');

  const groups: BomGroup[] = ['Electronics', 'Power', 'Connectors and cables', 'Enclosure'];
  const subtotals = Object.fromEntries(groups.map(g => [g, { low: 0, high: 0 }])) as Bom['subtotals'];
  for (const l of lines) if (l.ext) { subtotals[l.group].low += l.ext.low; subtotals[l.group].high += l.ext.high; }
  const total = { low: groups.reduce((a, g) => a + subtotals[g].low, 0), high: groups.reduce((a, g) => a + subtotals[g].high, 0) };
  const warnings: Bom['warnings'] = [];
  const unpriced = lines.filter(l => !l.unit);
  if (unpriced.length) warnings.push({ level: 'warn', msg: `${unpriced.length} line${unpriced.length > 1 ? 's have' : ' has'} no price (${unpriced.map(l => l.name).join(', ')}), so the total is incomplete.` });
  const stale = lines.filter(l => l.stale);
  if (stale.length) warnings.push({ level: 'warn', msg: `${stale.length} price${stale.length > 1 ? 's are' : ' is'} older than ${STALE_DAYS} days: check current prices before buying.` });
  const limited = lines.filter(l => l.stock === 'limited');
  if (limited.length) warnings.push({ level: 'warn', msg: `Limited availability: ${limited.map(l => l.name).join(', ')}.` });
  warnings.push({ level: 'warn', msg: 'Prices are manually maintained estimates with the date they were entered, not live supplier prices.' });
  const budget = p.requirements?.budget;
  if (budget && total.low > budget) warnings.push({ level: 'fail', msg: `Even the low estimate ($${total.low.toFixed(2)}) is over the $${budget.toFixed(2)} budget.` });
  else if (budget && total.high > budget) warnings.push({ level: 'warn', msg: `The high estimate ($${total.high.toFixed(2)}) is over the $${budget.toFixed(2)} budget.` });
  return { lines, subtotals, total, units: Math.max(1, p.requirements?.qty ?? 1), warnings, exclusions: ['Shipping', 'Tax and import duties', 'Tooling and moulds', 'Fabrication (printing, PCB assembly)', 'Labour'] };
}

const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** The BOM as CSV (per-product quantities, and for the target quantity). */
export function bomCsv(b: Bom): string {
  const head = ['Group', 'Part', 'Manufacturer', 'Part number', 'Supplier', 'Qty per unit', `Qty for ${b.units}`, 'Unit low (USD)', 'Unit high (USD)', 'Extended low', 'Extended high', 'Price date', 'Price source', 'Stale', 'Stock', 'Confidence', 'Required', 'Datasheet', 'Note'];
  const rows = b.lines.map(l => [l.group, l.name, l.manufacturer, l.mpn, l.supplier, l.qty, l.qty * b.units, l.unit?.low.toFixed(2) ?? 'not priced', l.unit?.high.toFixed(2) ?? 'not priced', l.ext?.low.toFixed(2) ?? '', l.ext?.high.toFixed(2) ?? '', l.asOf ?? '', l.priceSource ?? '', l.stale ? 'yes' : 'no', l.stock, l.confidence, l.required ? 'yes' : 'optional', l.datasheet ?? '', l.note ?? '']);
  rows.push([], ['Total per unit (priced lines)', '', '', '', '', '', '', '', '', b.total.low.toFixed(2), b.total.high.toFixed(2)], ['Excluded', b.exclusions.join('; ')]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
