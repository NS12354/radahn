/**
 * The bench wiring as a file Claude Code can read and edit (wiring.json), and
 * the catalog of parts it can choose from (PARTS.md). Parsing turns an edited
 * file back into wiring and says exactly what changed, so the studio can apply
 * pin moves straight away but ask before hardware is added or removed.
 */
import type { BoardDef, CompInstance } from '../hw/types';
import { BOARDS, pinLabel } from '../hw/library/boards';
import { COMPONENTS } from '../hw/library/components';
import { newUid, nextColor } from './project';

export const WIRING_FILE = 'wiring.json';
export const PARTS_FILE = 'PARTS.md';

const README = 'Formframe bench wiring. Edit pins freely (use labels like the ones shown, or null to disconnect). '
  + 'To add a part, append {"type": "<id from PARTS.md>", "pins": {...}} (no "id"); to remove one, delete its entry. '
  + 'Adding/removing parts or changing "board" waits for the user to approve in Formframe. Keep "id" on existing parts.';

export function wiringDoc(board: BoardDef, comps: CompInstance[], status?: string): string {
  const doc: Record<string, unknown> = { _readme: README };
  if (status) doc._status = status;
  doc.board = board.id;
  doc.parts = comps.map(c => ({
    id: c.uid, type: c.type, name: COMPONENTS[c.type]?.name ?? c.type,
    pins: Object.fromEntries((COMPONENTS[c.type]?.roles ?? []).map(r => [r.id, c.pins[r.id] == null ? null : pinLabel(board, c.pins[r.id]!)])),
    ...(c.props && Object.keys(c.props).length ? { props: c.props } : {}),
  }));
  return JSON.stringify(doc, null, 2) + '\n';
}

export function catalogDoc(board: BoardDef): string {
  const L = (g: number) => pinLabel(board, g);
  const lines = [
    `# Parts and pins for Formframe`, '',
    `Use these \`type\` ids in ${WIRING_FILE}. Ask the user before adding or removing hardware.`, '',
    `## Boards (the "board" field)`,
    ...Object.values(BOARDS).map(b => `- \`${b.id}\`: ${b.name} (${b.lang})${b.id === board.id ? ' ← current' : ''}`), '',
    `## ${board.name} pins`,
    `- GPIO: ${board.gpio.map(L).join(' ')}`,
    `- Analog (ADC): ${board.adc.map(L).join(' ') || 'none'}`,
    ...(board.i2c ?? []).map((b, i) => `- I2C bus ${i}: SDA ${(b.sda ?? []).map(L).join('/')} · SCL ${(b.scl ?? []).map(L).join('/')}`),
    ...(board.spi ?? []).map((b, i) => `- SPI bus ${i}: SCK ${(b.sck ?? []).map(L).join('/')} · MOSI ${(b.mosi ?? []).map(L).join('/')}`),
    ...(board.strap.length ? [`- Avoid (boot/strapping pins): ${board.strap.map(L).join(' ')}`] : []),
    `- Logic ${board.logicV} V, max ${board.pinMaxmA} mA per pin. Several I2C parts can share the same SDA/SCL pins.`, '',
    `## Parts`,
    ...Object.values(COMPONENTS).map(d => `- \`${d.id}\`: **${d.name}** (${d.category}). Pins: ${d.roles.map(r => `${r.id} (${r.kind})`).join(', ') || 'none'}. ${d.rail ? `Power ${d.rail}, ~${d.mA} mA.` : ''}${d.i2cAddress ? ` I2C 0x${d.i2cAddress.toString(16)}.` : ''}${d.note ? ` ${d.note}` : ''}`),
  ];
  return lines.join('\n') + '\n';
}

export interface WiringChange {
  board: string; comps: CompInstance[];
  added: CompInstance[]; removed: CompInstance[];
  rewired: { uid: string; name: string; role: string; to: string }[];
  boardChanged: boolean;
}
/** Does this change add, remove or swap hardware (needs the user's OK)? */
export const needsApproval = (c: WiringChange) => c.added.length > 0 || c.removed.length > 0 || c.boardChanged;

/** Parse an edited wiring.json against the current wiring. Throws a plain-language Error if it can't be applied. */
export function parseWiring(text: string, current: { board: string; comps: CompInstance[] }): WiringChange {
  let doc: any;
  try { doc = JSON.parse(text); } catch (e: any) { throw new Error(`wiring.json isn't valid JSON (${e.message}).`); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.parts)) throw new Error('wiring.json needs a "parts" list.');
  const boardId = doc.board ?? current.board;
  const b = BOARDS[boardId];
  if (!b) throw new Error(`Unknown board "${boardId}". Use one of: ${Object.keys(BOARDS).join(', ')}.`);
  const byLabel = new Map<string, number>();
  for (const g of b.gpio) { byLabel.set(pinLabel(b, g).toUpperCase(), g); byLabel.set(String(g), g); }
  const toPin = (v: unknown, where: string): number | null => {
    if (v == null || v === '') return null;
    const g = byLabel.get(String(v).trim().toUpperCase());
    if (g == null) throw new Error(`${where}: "${v}" isn't a pin on the ${b.name}. Use one of ${b.gpio.map(x => pinLabel(b, x)).join(', ')}.`);
    return g;
  };
  const old = new Map(current.comps.map(c => [c.uid, c]));
  const seen = new Set<string>();
  const comps: CompInstance[] = [], added: CompInstance[] = [], rewired: WiringChange['rewired'] = [];
  doc.parts.forEach((p: any, i: number) => {
    const where = `parts[${i}]${p?.type ? ` (${p.type})` : ''}`;
    if (!p || typeof p !== 'object') throw new Error(`${where} should be an object.`);
    const prev = typeof p.id === 'string' ? old.get(p.id) : undefined;
    const type = p.type ?? prev?.type;
    const def = COMPONENTS[type];
    if (!def) throw new Error(`${where}: unknown part type "${type}". See PARTS.md for the ids.`);
    if (prev && prev.type !== type) throw new Error(`${where}: can't change the type of an existing part; remove it and add a new one.`);
    if (prev && seen.has(prev.uid)) throw new Error(`${where}: id "${prev.uid}" is used twice.`);
    const roles = new Set(def.roles.map(r => r.id));
    for (const k of Object.keys(p.pins ?? {})) if (!roles.has(k)) throw new Error(`${where}: the ${def.name} has no "${k}" pin. Its pins are ${[...roles].join(', ') || 'none'}.`);
    const pins: Record<string, number | null> = {};
    for (const r of def.roles) pins[r.id] = toPin(p.pins?.[r.id], `${where}.${r.id}`);
    if (prev) {
      seen.add(prev.uid);
      for (const r of def.roles) if ((prev.pins[r.id] ?? null) !== pins[r.id]) rewired.push({ uid: prev.uid, name: def.name, role: r.id, to: pins[r.id] == null ? 'nothing' : pinLabel(b, pins[r.id]!) });
      comps.push({ ...prev, pins, ...(p.props && typeof p.props === 'object' ? { props: p.props } : {}) });
    } else {
      const c: CompInstance = { uid: newUid(), type: def.id, pins, color: nextColor(current.comps.length + added.length), ...(p.props && typeof p.props === 'object' ? { props: p.props } : {}) };
      comps.push(c); added.push(c);
    }
  });
  const removed = current.comps.filter(c => !seen.has(c.uid));
  return { board: b.id, comps, added, removed, rewired, boardChanged: b.id !== current.board };
}

/** "add a NeoPixel ring on GP16; remove the Buzzer; switch to the Arduino Uno" */
export function describeChange(c: WiringChange): string {
  const b = BOARDS[c.board], L = (g: number | null) => (g == null ? '—' : pinLabel(b, g));
  const out: string[] = [];
  if (c.boardChanged) out.push(`switch the board to the ${b.name}`);
  for (const a of c.added) out.push(`add a ${COMPONENTS[a.type].name} (${Object.entries(a.pins).map(([r, g]) => `${r} ${L(g)}`).join(', ') || 'no pins'})`);
  for (const r of c.removed) out.push(`remove the ${COMPONENTS[r.type]?.name ?? r.type}`);
  if (c.rewired.length) out.push(`move ${c.rewired.map(r => `${r.name} ${r.role} → ${r.to}`).join(', ')}`);
  return out.join('; ');
}
