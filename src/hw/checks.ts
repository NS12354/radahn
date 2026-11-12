import type { BoardDef, Check, CheckCtx, CompInstance } from './types';
import { COMPONENTS } from './library/components';
import { pinLabel } from './library/boards';

export function buildPinMap(comps: CompInstance[]) {
  const m = new Map<number, { c: CompInstance; role: string }[]>();
  for (const c of comps) for (const [role, g] of Object.entries(c.pins)) if (g != null) {
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push({ c, role });
  }
  return m;
}

const inGroup = (b: BoardDef, kind: 'spi' | 'i2c', a: number | null, bpin: number | null) => {
  const groups = b[kind];
  if (!groups || a == null || bpin == null) return true; // flexible pin matrix (ESP32)
  const [ka, kb] = kind === 'spi' ? (['sck', 'mosi'] as const) : (['sda', 'scl'] as const);
  return groups.some(g => g[ka]!.includes(a) && g[kb]!.includes(bpin));
};

/** Electrical design-rule checks. Pure: safe to unit test. */
export function runChecks(board: BoardDef, comps: CompInstance[]): Check[] {
  const pinMap = buildPinMap(comps);
  const label = (g: number) => pinLabel(board, g);
  const ctx: CheckCtx = { board, comps, pinMap, label };
  const out: Check[] = [];
  const name = (c: CompInstance) => COMPONENTS[c.type]?.name ?? c.type;

  for (const [g, users] of pinMap) {
    if (users.length > 1) {
      const sharedI2C = users.every(u => u.role === 'SDA') || users.every(u => u.role === 'SCL');
      if (!sharedI2C) out.push({ level: 'err', msg: `${label(g)} is used by ${users.map(u => name(u.c).split(' ')[0] + ' ' + u.role).join(' and ')}.` });
    }
  }

  for (const c of comps) {
    const def = COMPONENTS[c.type];
    if (!def) { out.push({ level: 'err', uid: c.uid, msg: `Unknown component type "${c.type}".` }); continue; }
    for (const r of def.roles) {
      const g = c.pins[r.id];
      if (g == null) { out.push({ level: 'warn', uid: c.uid, msg: `${def.name}: ${r.id} is not connected.` }); continue; }
      if (!board.gpio.includes(g)) { out.push({ level: 'err', uid: c.uid, msg: `${def.name}: ${label(g)} doesn't exist on ${board.name}.` }); continue; }
      if (board.strap.includes(g)) out.push({ level: 'warn', uid: c.uid, msg: `${def.name} on ${label(g)}: strapping pin, so the board may not boot with a load attached.` });
      if (board.family === 'avr' && (g === 0 || g === 1)) out.push({ level: 'warn', uid: c.uid, msg: `${def.name} on ${label(g)} shares the USB serial pins. Uploads and Serial will conflict.` });
      if (r.kind === 'analog') {
        if (!board.adc.length) out.push({ level: 'err', uid: c.uid, msg: `${def.name}: ${board.name} has no analog inputs. Add an MCP3008 ADC.` });
        else if (board.adc2?.includes(g)) out.push({ level: 'warn', uid: c.uid, msg: `${def.name}: ${label(g)} is ADC2, which fails while Wi-Fi is on.` });
        else if (!board.adc.includes(g)) out.push({ level: 'err', uid: c.uid, msg: `${def.name}: ${label(g)} is not an ADC pin (${board.adc.map(label).join(', ')}).` });
      }
      if (r.kind === 'pwm' && board.hwPwm && !board.hwPwm.includes(g)) {
        out.push({ level: board.family === 'avr' ? 'err' : 'warn', uid: c.uid, msg: `${def.name}: ${label(g)} has no hardware PWM (${board.hwPwm.map(label).join(', ')}).` });
      }
    }
    if (def.roles.some(r => r.kind === 'spi-sck') && !inGroup(board, 'spi', c.pins.SCK, c.pins.MOSI)) {
      out.push({ level: 'err', uid: c.uid, msg: `${def.name}: SCK ${c.pins.SCK != null ? label(c.pins.SCK) : '—'} / MOSI ${c.pins.MOSI != null ? label(c.pins.MOSI) : '—'} aren't a hardware SPI pin pair on ${board.name}.` });
    }
    if (def.roles.some(r => r.kind === 'i2c-sda') && !inGroup(board, 'i2c', c.pins.SDA, c.pins.SCL)) {
      out.push({ level: 'err', uid: c.uid, msg: `${def.name}: SDA/SCL aren't a hardware I2C pin pair on ${board.name}.` });
    }
    if (def.drivemA && def.drivemA > board.pinRecmA) out.push({ level: 'warn', uid: c.uid, msg: `${def.name} draws ${def.drivemA} mA from one pin (${board.name} recommends ≤ ${board.pinRecmA} mA).` });
    if (def.checks) out.push(...def.checks(c, ctx));
  }

  const peak = (rail: '3v3' | '5v') => comps.reduce((a, c) => { const d = COMPONENTS[c.type]; return d && d.rail === rail ? a + (d.peakmA ?? d.mA) : a; }, 0);
  const p33 = peak('3v3'), p5 = peak('5v');
  out.push({ level: p33 > board.rail3v3mA ? 'err' : 'ok', msg: `3V3 rail peak ${p33.toFixed(0)} mA of ~${board.rail3v3mA} mA available.` });
  out.push({ level: p5 > board.rail5vmA ? 'warn' : 'ok', msg: `5 V peak ${p5.toFixed(0)} mA of ~${board.rail5vmA} mA from USB/supply.` });

  // de-duplicate identical messages
  const seen = new Set<string>();
  const order = { err: 0, warn: 1, ok: 2 };
  return out.filter(c => (seen.has(c.msg) ? false : (seen.add(c.msg), true))).sort((a, b) => order[a.level] - order[b.level]);
}
