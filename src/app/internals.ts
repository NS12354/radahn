import type { Project } from './project';

/** Internal stack-up for the parametric enclosure: fit check + BOM. */
export interface Internal { id: string; name: string; spec: string; shape: 'disc' | 'box' | 'onpcb'; d?: number; w?: number; l?: number; h?: number; cost: number; lock?: boolean; col?: number }

export const INTERNALS: Internal[] = [
  { id: 'disp', name: '1.28" round LCD', spec: 'Ø38 × 4.5 mm', shape: 'disc', d: 38, h: 4.5, cost: 3.9, lock: true, col: 0x1b1f27 },
  { id: 'pcb', name: 'Main PCB', spec: 'Ø56 × 5 mm (with parts)', shape: 'disc', d: 56, h: 5, cost: 6.2, lock: true, col: 0x1f7a4a },
  { id: 'bat', name: 'LiPo 1200 mAh', spec: '50 × 34 × 6 mm', shape: 'box', w: 50, l: 34, h: 6, cost: 2.8, col: 0x8a8f99 },
  { id: 'relay', name: '24 V HVAC relays ×2', spec: '40 × 15 × 11 mm', shape: 'box', w: 40, l: 15, h: 11, cost: 2.4, col: 0x2b4a8a },
  { id: 'sens', name: 'SHT40 temp / RH sensor', spec: 'on PCB', shape: 'onpcb', cost: 1.1 },
  { id: 'hap', name: 'LRA haptic motor', spec: 'on PCB', shape: 'onpcb', cost: 0.9 },
];

export const PROC = {
  im: { label: 'Housing + dial (molded PC/ABS)', unit: 1.6, tool: 42000 },
  cnc: { label: 'Housing + dial (CNC aluminum)', unit: 21, tool: 0 },
  sla: { label: 'Housing + dial (SLA print)', unit: 18, tool: 0 },
};

export function fitCheck(p: Project) {
  const { dia, depth } = p.product.parametric;
  const innerD = dia * 0.955 - 6, avail = depth - 5.5;
  const rows: { n: string; v: string; ok: boolean }[] = [];
  const bad = new Set<string>();
  let stack = 0;
  const stacked = INTERNALS.filter(c => p.internals[c.id] && c.shape !== 'onpcb');
  for (const c of stacked) {
    const fp = c.shape === 'disc' ? c.d! : Math.hypot(c.w!, c.l!);
    const ok = fp <= innerD; if (!ok) bad.add(c.id);
    rows.push({ n: c.name + ' footprint', v: `${fp.toFixed(1)} / ${innerD.toFixed(1)} mm`, ok });
    stack += c.h! + 1;
  }
  const sok = stack <= avail;
  if (!sok && stacked.length) bad.add(stacked[stacked.length - 1].id);
  rows.push({ n: 'Stack height', v: `${stack.toFixed(1)} / ${avail.toFixed(1)} mm`, ok: sok });
  return { rows, ok: rows.every(r => r.ok), bad, innerD, avail };
}

export function bom(p: Project) {
  const { dia, depth, proc } = p.product.parametric;
  const pr = PROC[proc];
  const scale = Math.pow(dia / 80, 2) * (depth / 26);
  const rows: [string, number][] = INTERNALS.filter(c => p.internals[c.id]).map(c => [c.name, c.cost]);
  rows.push([pr.label, pr.unit * scale]);
  if (pr.tool) rows.push([`Tooling amortized ($${pr.tool / 1000}k)`, pr.tool / Math.max(1, p.product.qty)]);
  rows.push(['Lens, LED ring, fasteners', 1.35], ['Assembly + test', 2.5]);
  return { rows, total: rows.reduce((a, r) => a + r[1], 0) };
}
