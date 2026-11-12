import type { Check, ComponentDef, DeviceCtx, DeviceModel, RoleDef } from './types';
import { COMPONENTS } from './library/components';
import { PART_PHYS, type PartPhys } from './library/physical';
import { EdgeMeter } from './devices/edge';

/**
 * Parts imported from a link (or defined by hand). The spec is plain JSON
 * that travels inside the project file, so a project that uses one still
 * opens on another machine. registerCustom() turns a spec into a regular
 * ComponentDef with a generic device model for its interface, plus a physical
 * size so auto build can place it.
 */
export type CustomIface = 'digital-in' | 'digital-out' | 'pwm' | 'analog' | 'i2c' | 'spi' | 'uart' | 'ws2812' | 'other';
export interface CustomPartSpec {
  id: string;
  name: string;
  manufacturer?: string | null;
  partNumber?: string | null;
  url?: string | null;
  datasheet?: string | null;
  category: ComponentDef['category'];
  interface: CustomIface;
  roles: (RoleDef & { description?: string })[];
  rail: '3v3' | '5v' | null;
  mA: number;
  peakmA?: number | null;
  logic?: 3.3 | 5 | null;
  supply?: [number | null, number | null];
  i2cAddress?: number | null;
  activeLow?: boolean | null;
  cost: number;
  size?: { w: number; h: number; d: number } | null;
  surface: PartPhys['surface'];
  summary: string;
  uses: string[];
  requirements: string[];
  source: 'claude' | 'heuristic' | 'manual';
  confidence?: 'high' | 'medium' | 'low';
  missing?: string[];
  added: string;
}

const KINDS: RoleDef['kind'][] = ['digital-in', 'digital-out', 'pwm', 'analog', 'spi-sck', 'spi-mosi', 'i2c-sda', 'i2c-scl', 'data'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || 'part';

/** Which bench card a custom part uses (one of the built-in card types, or a generic bus card). */
export function cardKind(s: Pick<CustomPartSpec, 'interface' | 'roles'>): 'button' | 'pot' | 'led' | 'generic' {
  if (s.interface === 'digital-in' && s.roles.some(r => r.kind === 'digital-in')) return 'button';
  if (s.interface === 'analog' && s.roles.some(r => r.kind === 'analog')) return 'pot';
  if ((s.interface === 'digital-out' || s.interface === 'pwm') && s.roles.some(r => r.kind === 'digital-out' || r.kind === 'pwm')) return 'led';
  return 'generic';
}

function model(spec: CustomPartSpec, ctx: DeviceCtx): DeviceModel {
  const kind = cardKind(spec);
  const state: Record<string, any> = { down: false, value: 0.5, brightness: 0, rx: 0, tx: 0, edges: 0, last: '' };
  const firstIn = spec.roles.find(r => r.kind === 'digital-in')?.id;
  const firstOut = spec.roles.find(r => r.kind === 'digital-out' || r.kind === 'pwm' || r.kind === 'data')?.id;
  const m = new EdgeMeter();
  const idle = spec.activeLow === false ? 0 : 1;
  let told = false;
  const tell = (what: string) => { if (told) return; told = true; ctx.log(`[sim] ${spec.name}: ${what}. Its register contents and timing aren't modelled, so reads return zeros. Wiring, addressing and bus traffic are real.`, 'w'); };
  const dm: DeviceModel = {
    state,
    reset() { m.reset(); state.rx = state.tx = state.edges = 0; for (const r of spec.roles) if (r.kind === 'digital-in') ctx.setInput(r.id, idle); },
    onPin(role, level, t) { state.edges++; if (role === firstOut) m.edge(level, t); },
    frame() { if (kind === 'led') state.brightness = m.duty(ctx.now()); },
    sim: {
      press(down: boolean) { state.down = down; if (firstIn) ctx.setInput(firstIn, down ? (idle ? 0 : 1) : idle); },
      set(v: number) { state.value = v; },
      pwm(_f: number, d: number) { state.brightness = d; },
    },
  };
  if (spec.roles.some(r => r.kind === 'analog')) dm.adc = () => state.value * (spec.logic ?? 3.3);
  if (spec.interface === 'i2c' && spec.i2cAddress != null) {
    dm.i2c = {
      address: spec.i2cAddress,
      start() { tell(`answered at I2C 0x${spec.i2cAddress!.toString(16)}`); },
      write(b) { state.rx++; state.last = '0x' + b.toString(16).padStart(2, '0'); return true; },
      read() { state.tx++; return 0; },
    };
  }
  if (spec.interface === 'spi') dm.onSpi = b => { state.rx++; state.last = '0x' + b.toString(16).padStart(2, '0'); if (state.rx === 1) tell('received SPI bytes'); return 0; };
  return dm;
}

function checks(spec: CustomPartSpec): ComponentDef['checks'] {
  return (c, x) => {
    const out: Check[] = [];
    if (spec.logic === 3.3 && x.board.logicV === 5) out.push({ level: 'warn', uid: c.uid, msg: `${spec.name} uses 3.3 V logic on a 5 V board. Use a level shifter or a 5 V-tolerant breakout.` });
    if (spec.logic === 5 && x.board.logicV === 3.3 && spec.roles.some(r => r.kind === 'digital-in' || r.kind === 'analog')) out.push({ level: 'warn', uid: c.uid, msg: `${spec.name} outputs 5 V logic into a 3.3 V board. Divide or level-shift its outputs.` });
    if (spec.supply?.[0] != null && spec.supply[0] > 5.5) out.push({ level: 'err', uid: c.uid, msg: `${spec.name} needs at least ${spec.supply[0]} V, more than the dev board's rails. Give it its own supply.` });
    if (spec.rail === '3v3' && spec.supply?.[1] != null && spec.supply[1] < 3.0) out.push({ level: 'err', uid: c.uid, msg: `${spec.name} is rated up to ${spec.supply[1]} V; 3.3 V will damage it.` });
    return out;
  };
}

export function toDef(spec: CustomPartSpec): ComponentDef {
  const kind = cardKind(spec);
  return {
    id: spec.id, name: spec.name, category: spec.category, roles: spec.roles.map(r => ({ id: r.id, kind: r.kind })),
    rail: spec.rail, mA: spec.mA || 0, peakmA: spec.peakmA ?? undefined, logic: spec.logic ?? undefined, cost: spec.cost || 0,
    i2cAddress: spec.i2cAddress ?? undefined,
    drivemA: kind === 'led' && spec.rail == null ? Math.min(12, spec.mA || 5) : undefined,
    ui: kind === 'button' ? 'button' : kind === 'pot' ? 'pot' : kind === 'led' ? 'led' : 'sensor',
    note: `${spec.summary}${spec.requirements.length ? '\nNeeds: ' + spec.requirements.join('; ') : ''}\nSimulated generically (${spec.interface}).`,
    create: ctx => model(spec, ctx),
    checks: checks(spec),
    custom: spec,
  } as ComponentDef;
}

export function registerCustom(spec: CustomPartSpec) {
  COMPONENTS[spec.id] = toDef(spec);
  const s = spec.size ?? { w: 20, h: 15, d: 4 };
  PART_PHYS[spec.id] = { body: { shape: 'box', w: s.w, h: s.h, d: s.d, color: '#3b4a5a' }, surface: spec.surface };
}
export const customOf = (type: string): CustomPartSpec | undefined => (COMPONENTS[type] as any)?.custom;

/** Turn the server's extraction into a spec, with safe defaults for anything missing. */
export function specFromExtraction(x: any, meta: { url?: string | null; datasheet?: string | null; source: CustomPartSpec['source'] }, taken: Set<string>): CustomPartSpec {
  const base = 'x_' + slug(x.partNumber || x.name || 'part');
  let id = base; for (let i = 2; taken.has(id) || (COMPONENTS[id] && !customOf(id)); i++) id = `${base}_${i}`;
  const seen = new Set<string>();
  const roles = (Array.isArray(x.pins) ? x.pins : []).filter((p: any) => p?.id).map((p: any) => {
    let rid = String(p.id).toUpperCase().replace(/[^A-Z0-9_+-]/g, '').slice(0, 6) || 'IO';
    for (let i = 2; seen.has(rid); i++) rid = rid.slice(0, 5) + i;
    seen.add(rid);
    return { id: rid, kind: KINDS.includes(p.kind) ? p.kind : 'digital-in', description: p.description ?? '' };
  });
  if (!roles.length) roles.push({ id: 'SIG', kind: 'digital-in', description: '' });
  const addr = typeof x.i2cAddress === 'string' ? parseInt(x.i2cAddress, 16) : typeof x.i2cAddress === 'number' ? x.i2cAddress : null;
  const numOr = (v: any, d: number | null = null) => (typeof v === 'number' && isFinite(v) ? v : d);
  return {
    id, name: String(x.name || 'Imported part').slice(0, 60), manufacturer: x.manufacturer ?? null, partNumber: x.partNumber ?? null,
    url: meta.url ?? null, datasheet: meta.datasheet ?? null,
    category: ['input', 'output', 'display', 'sensor', 'actuator'].includes(x.category) ? x.category : 'sensor',
    interface: x.interface ?? 'other', roles,
    rail: x.rail === '3v3' || x.rail === '5v' ? x.rail : null,
    mA: numOr(x.typicalmA, 1)!, peakmA: numOr(x.peakmA), logic: x.logicV === 5 ? 5 : x.logicV === 3.3 ? 3.3 : null,
    supply: [numOr(x.supplyMinV), numOr(x.supplyMaxV)],
    i2cAddress: addr != null && addr >= 0x03 && addr <= 0x77 ? addr : null,
    activeLow: typeof x.activeLow === 'boolean' ? x.activeLow : null,
    cost: numOr(x.priceUSD, 0)!, size: x.sizeMm && x.sizeMm.w > 0 ? { w: +x.sizeMm.w, h: +x.sizeMm.h || +x.sizeMm.w, d: +x.sizeMm.d || 3 } : null,
    surface: x.surface && x.surface !== 'none' ? x.surface : 'none',
    summary: String(x.summary ?? ''), uses: Array.isArray(x.uses) ? x.uses.map(String) : [], requirements: Array.isArray(x.requirements) ? x.requirements.map(String) : [],
    source: meta.source, confidence: x.confidence ?? undefined, missing: Array.isArray(x.missing) ? x.missing.map(String) : [],
    added: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ browser-wide part library
const LIB = 'formframe.partlib.v1';
export function libraryParts(): CustomPartSpec[] { try { return Object.values(JSON.parse(localStorage.getItem(LIB) ?? '{}')); } catch { return []; } }
export function saveToLibrary(s: CustomPartSpec) { try { const all = JSON.parse(localStorage.getItem(LIB) ?? '{}'); all[s.id] = s; localStorage.setItem(LIB, JSON.stringify(all)); } catch { } }
export function removeFromLibrary(id: string) { try { const all = JSON.parse(localStorage.getItem(LIB) ?? '{}'); delete all[id]; localStorage.setItem(LIB, JSON.stringify(all)); } catch { } }
