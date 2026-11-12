import type { BoardDef, CompInstance } from '../hw/types';
import { COMPONENTS } from '../hw/library/components';
import { BATTERY, boardPhys, partPhys, type PortPhys } from '../hw/library/physical';
import { newUid, type AutoBuildOpts, type BuiltPart } from './project';
import { collide, fitBuilt, solidsOf } from './fit';

/**
 * Auto build: turn the wired electronics into a product model.
 *
 * 1. Front: the display, light ring and encoder become one concentric feature
 *    (window + bezel, segmented light ring, dial ring). Other user-facing parts
 *    (buttons, knobs, pots, indicator LEDs, buzzer) get their own surface parts:
 *    caps, knobs, lenses, sound ports, laid out in a row or along an arc.
 * 2. Inside, from front to back: the parts behind the front panel, the board
 *    (on standoffs at its real mounting holes, pushed toward the wall its ports
 *    face), then the remaining modules shelf-packed into one layer.
 * 3. The enclosure (round or rectangular) is sized around all of that, with
 *    port cutouts, sensor vents, wire entries, a servo horn and a mount.
 *
 * Everything comes out as ordinary editable parts tagged `auto`.
 */
export interface AutoBuildResult { parts: BuiltPart[]; notes: string[]; size: [number, number, number]; style: 'round' | 'rect' }

const ACCENT = '#ff7a2f', DARK = '#0b0d10', HOLE = '#08090b', SHELL = '#ece9e4', METAL = '#b9bdc3', PLATE = '#d8d4cd';
const r1 = (v: number) => Math.round(v * 10) / 10;
const BUILTIN = new Set(['tft', 'neopixel', 'encoder', 'button', 'pot', 'led', 'buzzer', 'sht40', 'relay', 'haptic', 'servo']);
const mm = (v: number) => `${Math.round(v)} mm`;

type SecKind = 'knob' | 'button' | 'pot' | 'indicator' | 'sound' | 'display';
interface Sec { c: CompInstance; kind: SecKind; d: number; x: number; y: number }

export function autoBuild(board: BoardDef, comps: CompInstance[], o: AutoBuildOpts): AutoBuildResult {
  const parts: BuiltPart[] = [], notes: string[] = [];
  const add = (p: Partial<BuiltPart> & Pick<BuiltPart, 'name' | 'shape' | 'size' | 'pos'>): BuiltPart => {
    const q: BuiltPart = { id: newUid(), rot: [0, 0, 0], color: '#cccccc', finish: 'matte', role: 'body', auto: true, ...p };
    q.size = q.size.map(r1) as any; q.pos = q.pos.map(r1) as any;
    parts.push(q); return q;
  };
  const nameOf = (c: CompInstance) => COMPONENTS[c.type]?.name ?? c.type;
  const of = (t: string) => comps.filter(c => c.type === t);
  const custom = (s: string) => comps.filter(c => !BUILTIN.has(c.type) && partPhys(c.type).surface === s);
  const wall = Math.max(0.8, o.wall), clr = Math.max(0, o.clearance);
  const bp = boardPhys(board.id);

  // ---------------------------------------------------------------- front plan
  const tfts = of('tft'), rings = of('neopixel'), encs = of('encoder'), btns = of('button');
  const display = tfts[0] ?? null, ring = rings[0] ?? null;
  const centralDial = encs[0] && (display || ring) ? encs[0] : null;
  const centralKnob = !centralDial && encs[0] ? encs[0] : null;
  const displayPress = display && btns[0] ? btns[0] : null;
  const tftP = partPhys('tft'), ringP = partPhys('neopixel');
  const active = tftP.active!, bezelD = display ? active + 5 : 0;
  const ringOD = ring ? ringP.body.w : 0, ringID = ring ? ringP.body.inner! : 0;

  let rc = Math.max(bezelD / 2, ringOD / 2), dialInner = 0, dialOD = 0;
  if (centralDial) { dialInner = 2 * rc + 2; dialOD = dialInner + 14; rc = dialOD / 2; }
  if (centralKnob) rc = 18;
  const hasCentral = rc > 0;

  const sec: Sec[] = [];
  const push = (c: CompInstance, kind: SecKind, d: number) => sec.push({ c, kind, d, x: 0, y: 0 });
  encs.filter(c => c !== centralDial && c !== centralKnob).forEach(c => push(c, 'knob', 24));
  btns.filter(c => c !== displayPress).forEach(c => push(c, 'button', 15));
  [...of('pot'), ...custom('pot'), ...custom('knob')].forEach(c => push(c, 'pot', 18));
  [...of('led'), ...custom('indicator')].forEach(c => push(c, 'indicator', 8));
  custom('button').forEach(c => push(c, 'button', 15));
  custom('display').forEach(c => push(c, 'display', 38));
  tfts.slice(1).forEach(c => push(c, 'display', 38));
  const FRONT = new Set(['tft', 'encoder', 'button', 'pot', 'led']);
  const onFront = new Set(sec.map(s => s.c));
  const internalComps = comps.filter(c => !FRONT.has(c.type) && c !== ring && !onFront.has(c));

  const style: 'round' | 'rect' = o.style !== 'auto' ? o.style : hasCentral && sec.length <= 3 && bp.w <= 72 ? 'round' : 'rect';
  const gap = 6, maxD = Math.max(0, ...sec.map(s => s.d));
  if (style === 'round' && hasCentral && sec.length) {
    const Ra = rc + gap + maxD / 2, step = (maxD + gap) / Ra;
    sec.forEach((s, i) => { const a = -Math.PI / 2 + (i - (sec.length - 1) / 2) * step; s.x = Ra * Math.cos(a); s.y = Ra * Math.sin(a); });
  } else {
    const rowW = sec.reduce((a, s) => a + s.d, 0) + gap * Math.max(0, sec.length - 1);
    let x = -rowW / 2; const y = hasCentral ? -(rc + gap + maxD / 2) : 0;
    sec.forEach(s => { s.x = x + s.d / 2; s.y = y; x += s.d + gap; });
  }
  let cx = 0, cy = 0;
  let fx0 = hasCentral ? -rc : Infinity, fx1 = hasCentral ? rc : -Infinity, fy0 = hasCentral ? -rc : Infinity, fy1 = hasCentral ? rc : -Infinity;
  for (const s of sec) { fx0 = Math.min(fx0, s.x - s.d / 2); fx1 = Math.max(fx1, s.x + s.d / 2); fy0 = Math.min(fy0, s.y - s.d / 2); fy1 = Math.max(fy1, s.y + s.d / 2); }
  if (!isFinite(fx0)) fx0 = fx1 = fy0 = fy1 = 0;
  if (style === 'rect') { const sx = -(fx0 + fx1) / 2, sy = -(fy0 + fy1) / 2; cx += sx; cy += sy; sec.forEach(s => { s.x += sx; s.y += sy; }); }
  const frontW = fx1 - fx0, frontH = fy1 - fy0;
  const frontR = Math.max(hasCentral ? rc : 0, ...sec.map(s => Math.hypot(s.x - cx, s.y - cy) + s.d / 2));

  // ---------------------------------------------------------------- internal plan
  interface Mod { name: string; w: number; h: number; d: number; color: string; comp: string; type: string; x: number; y: number; shape: 'box' | 'cyl' }
  const mods: Mod[] = internalComps.map(c => { const b = partPhys(c.type).body; return { name: nameOf(c), w: b.w, h: b.h, d: b.d, color: b.color, comp: c.uid, type: c.type, x: 0, y: 0, shape: b.shape === 'cyl' ? 'cyl' : 'box' }; });
  if (o.battery) mods.push({ name: BATTERY.name, w: BATTERY.w, h: BATTERY.h, d: BATTERY.d, color: BATTERY.color, comp: 'battery', type: 'battery', x: 0, y: 0, shape: 'box' });
  const packW = Math.max(bp.w, style === 'rect' ? frontW - 8 : frontR * 1.3, ...mods.map(m => m.w));
  let pw = 0, ph = 0;
  {
    const sorted = [...mods].sort((a, b) => b.h - a.h);
    let x = 0, y = 0, rowH = 0;
    for (const m of sorted) {
      if (x > 0 && x + m.w > packW) { y += rowH + clr; x = 0; rowH = 0; }
      m.x = x + m.w / 2; m.y = y + m.h / 2; x += m.w + clr; rowH = Math.max(rowH, m.h); pw = Math.max(pw, x - clr);
    }
    ph = sorted.length ? y + rowH : 0;
    for (const m of mods) { m.x -= pw / 2; m.y = ph / 2 - m.y; }
  }

  // ---------------------------------------------------------------- enclosure size
  const margin = 6;
  let W = 0, H = 0, Dm = 0;
  const rimDial = style === 'round' && !!centralDial && !sec.length;
  if (style === 'rect') {
    W = Math.max(frontW + 2 * margin, bp.w + 2 * (clr + wall), pw + 2 * (clr + wall), 30);
    H = Math.max(frontH + 2 * margin, bp.h + 2 * (clr + wall), ph + 2 * (clr + wall), 24);
  } else {
    Dm = Math.max(rimDial ? dialOD : 2 * frontR + 2 * margin, Math.hypot(bp.w, bp.h) + 2 * (clr + wall), Math.hypot(pw, ph) + 2 * (clr + wall), 36);
    if (rimDial) dialOD = Dm;
    W = H = Dm;
  }
  W = Math.ceil(W); H = Math.ceil(H);
  const innerHalfX = W / 2 - wall, innerHalfY = H / 2 - wall, Ri = W / 2 - wall;

  // depth stack, front to back
  const ringSlab = ring ? ringP.body.d + 0.4 : 0;
  const l1Depths: number[] = [];
  if (display) l1Depths.push(tftP.body.d + (displayPress ? 0.3 + partPhys('button').body.d : 0));
  if (centralDial || centralKnob) l1Depths.push(partPhys('encoder').body.d);
  sec.forEach(s => l1Depths.push(partPhys(s.c.type).body.d));
  const f1 = Math.max(0, ...l1Depths);
  const l3 = Math.max(0, ...mods.map(m => m.d));
  const D = Math.ceil(Math.max(14, wall + ringSlab + (f1 ? clr + f1 : 0) + clr + bp.t + bp.top + (l3 ? clr + l3 : 0) + clr + wall));
  const zf = D / 2;
  let z = zf - wall;
  const ringZ = z - ringSlab / 2; z -= ringSlab;
  let l1Top = z;
  if (f1) { z -= clr; l1Top = z; z -= f1; }
  z -= clr;
  const boardTop = z, pcbFront = boardTop - bp.top, pcbZ = pcbFront - bp.t / 2, boardBack = pcbFront - bp.t;
  z = boardBack;
  let modTop = z;
  if (l3) { z -= clr; modTop = z; z -= l3; }

  // ---------------------------------------------------------------- shell
  const surf = zf + 1; // front face of the front panel
  const corner = Math.min(6, W / 6, H / 6);
  const dialDepth = 9;
  if (style === 'rect') add({ name: 'Housing', shape: 'rbox', size: [W, H, D], pos: [0, 0, 0], param: corner, color: SHELL, finish: 'matte', kind: 'shell', layer: 0 });
  else if (rimDial) add({ name: 'Housing', shape: 'cyl', size: [Dm, Dm, D - dialDepth + 1.5], pos: [0, 0, -(dialDepth - 1.5) / 2], color: SHELL, finish: 'matte', kind: 'shell', layer: 0 });
  else add({ name: 'Housing', shape: 'cyl', size: [Dm, Dm, D], pos: [0, 0, 0], color: SHELL, finish: 'matte', kind: 'shell', layer: 0 });
  if (style === 'rect') add({ name: 'Front panel', shape: 'rbox', size: [W - 2, H - 2, 1], pos: [0, 0, zf + 0.5], param: Math.max(0.5, corner - 1), color: DARK, finish: 'gloss', kind: 'shell', layer: 2 });
  else add({ name: 'Front panel', shape: 'cyl', size: rimDial ? [dialInner - 0.4, dialInner - 0.4, 1] : [Dm - 2, Dm - 2, 1], pos: [0, 0, zf + 0.5], color: DARK, finish: 'gloss', kind: 'shell', layer: 2 });
  notes.push(`${style === 'round' ? `Round enclosure, Ø${mm(Dm)}` : `Rectangular enclosure, ${mm(W)} × ${mm(H)}`} × ${mm(D)} deep, ${wall} mm walls. ${o.style === 'auto' ? (style === 'round' ? 'Round because the controls are one concentric group.' : hasCentral ? 'Rectangular to fit the row of controls.' : 'Rectangular: no central control.') : ''}`.trim());

  // ---------------------------------------------------------------- central feature
  if (display) {
    add({ name: 'Display bezel', shape: 'tube', size: [bezelD, bezelD, 1.2], pos: [cx, cy, surf + 0.6], param: active + 0.4, color: '#202226', finish: 'satin', kind: 'shell', layer: 3, comp: display.uid });
    add({ name: 'Display window', shape: 'disc', size: [active, active, 0.3], pos: [cx, cy, surf + 0.15], role: 'screen', color: '#000000', finish: 'gloss', layer: 3, comp: display.uid });
    add({ name: nameOf(display) + ' module', shape: 'cyl', size: [tftP.body.w, tftP.body.h, tftP.body.d], pos: [cx, cy, l1Top - tftP.body.d / 2], color: tftP.body.color, kind: 'internal', layer: 1, comp: display.uid });
    notes.push(`${nameOf(display)} → round window Ø${r1(active)} mm with a bezel. It is the Screen, so the firmware draws on it.`);
    if (displayPress) {
      const b = partPhys('button').body;
      add({ name: nameOf(displayPress) + ' (under display)', shape: 'box', size: [b.w, b.h, b.d], pos: [cx, cy, l1Top - tftP.body.d - 0.3 - b.d / 2], color: b.color, kind: 'internal', layer: 1, comp: displayPress.uid });
      notes.push(`${nameOf(displayPress)} → behind the display, so pressing the screen presses the button.`);
    }
  }
  if (ring) {
    const px = ringP.pixels ?? 24;
    add({ name: 'Light ring', shape: 'tube', size: [ringOD, ringOD, 0.8], pos: [cx, cy, surf + 0.4], param: ringID, segments: px, role: 'led', color: '#1a1c20', finish: 'satin', layer: 3, comp: ring.uid });
    add({ name: nameOf(ring) + ' PCB', shape: 'tube', size: [ringOD, ringOD, ringP.body.d], pos: [cx, cy, ringZ], param: ringID, color: ringP.body.color, kind: 'internal', layer: 1, comp: ring.uid });
    notes.push(`${nameOf(ring)} → diffuser ring split into ${px} segments, one per pixel${display ? ', around the display' : ''}.`);
  }
  rings.slice(1).forEach(c => notes.push(`${nameOf(c)}: only one light ring fits on the front. This one is packed inside.`));
  if (centralDial) {
    const dz = rimDial ? surf + 0.5 - dialDepth / 2 : surf + dialDepth / 2, top = dz + dialDepth / 2;
    add({ name: 'Dial ring', shape: 'tube', size: [dialOD, dialOD, dialDepth], pos: [cx, cy, dz], param: dialInner, role: 'dial', color: METAL, finish: 'brushed', kind: 'shell', layer: 4, comp: centralDial.uid });
    add({ name: 'Dial grip', shape: 'box', size: [0.9, 1.4, dialDepth * 0.8], pos: [cx, cy + dialOD / 2, dz], array: { n: 72, mode: 'radial', center: [cx, cy] }, role: 'dial', color: METAL, finish: 'brushed', kind: 'shell', layer: 4, comp: centralDial.uid });
    add({ name: 'Dial notch', shape: 'box', size: [1.6, 5, 0.6], pos: [cx, cy + dialInner / 2 + 3.5, top + 0.3], role: 'dial', color: ACCENT, finish: 'satin', layer: 4, comp: centralDial.uid });
    const e = partPhys('encoder').body, ey = cy - Math.max((display ? tftP.body.w / 2 : 0) + e.h / 2 + 1, ring ? ringID / 2 - e.h / 2 - 1 : 0, dialInner / 2 - 8);
    add({ name: nameOf(centralDial), shape: 'box', size: [e.w, e.h, e.d], pos: [cx, ey, l1Top - e.d / 2], color: e.color, kind: 'internal', layer: 1, comp: centralDial.uid });
    notes.push(`${nameOf(centralDial)} → dial ring Ø${mm(dialOD)}${rimDial ? ' forming the rim' : ''} with grip ribs and a notch. It drives the 3D dial. The gear from ring to encoder is not modelled.`);
  }
  if (centralKnob) {
    const kz = surf + 8;
    add({ name: 'Knob', shape: 'cyl', size: [30, 30, 16], pos: [cx, cy, kz], role: 'dial', color: METAL, finish: 'brushed', layer: 4, comp: centralKnob.uid });
    add({ name: 'Knob grip', shape: 'box', size: [1, 1.2, 14], pos: [cx, cy + 15, kz], array: { n: 36, mode: 'radial', center: [cx, cy] }, role: 'dial', color: METAL, finish: 'brushed', layer: 4, comp: centralKnob.uid });
    add({ name: 'Knob notch', shape: 'box', size: [1.6, 8, 0.6], pos: [cx, cy + 9, kz + 8.3], role: 'dial', color: ACCENT, finish: 'satin', layer: 4, comp: centralKnob.uid });
    add({ name: 'Knob skirt', shape: 'tube', size: [36, 36, 1.2], pos: [cx, cy, surf + 0.6], param: 31, color: '#202226', finish: 'satin', layer: 3, comp: centralKnob.uid });
    const e = partPhys('encoder').body;
    add({ name: nameOf(centralKnob), shape: 'box', size: [e.w, e.h, e.d], pos: [cx, cy, l1Top - e.d / 2], color: e.color, kind: 'internal', layer: 1, comp: centralKnob.uid });
    notes.push(`${nameOf(centralKnob)} → Ø30 mm knob on its shaft. It drives the 3D dial.`);
  }

  // ---------------------------------------------------------------- secondary controls
  let ledRoleUsed = !!ring;
  for (const s of sec) {
    const b = partPhys(s.c.type).body, body = (n = nameOf(s.c)) => add({ name: n, shape: b.shape === 'tube' ? 'cyl' : b.shape, size: [b.w, b.h, b.d], pos: [s.x, s.y, l1Top - b.d / 2], color: b.color, kind: 'internal', layer: 1, comp: s.c.uid });
    if (s.kind === 'knob') {
      add({ name: 'Knob', shape: 'cyl', size: [22, 22, 12], pos: [s.x, s.y, surf + 6], color: METAL, finish: 'brushed', layer: 4, comp: s.c.uid });
      add({ name: 'Knob notch', shape: 'box', size: [1.4, 6, 0.6], pos: [s.x, s.y + 6, surf + 12.3], color: ACCENT, layer: 4, comp: s.c.uid });
      notes.push(`${nameOf(s.c)} → knob. Only the first encoder turns the 3D dial.`);
    } else if (s.kind === 'button') {
      add({ name: 'Button cap', shape: 'cyl', size: [12, 12, 4], pos: [s.x, s.y, surf + 2], role: 'press', color: '#2b2f36', finish: 'satin', layer: 4, comp: s.c.uid });
      add({ name: 'Button bezel', shape: 'tube', size: [15, 15, 1], pos: [s.x, s.y, surf + 0.5], param: 12.6, color: '#202226', finish: 'satin', layer: 3, comp: s.c.uid });
      notes.push(`${nameOf(s.c)} → Ø12 mm cap. Pressing it presses the button.`);
    } else if (s.kind === 'pot') {
      add({ name: 'Pot knob', shape: 'cyl', size: [18, 18, 12], pos: [s.x, s.y, surf + 6], color: '#3a3d42', finish: 'soft', layer: 4, comp: s.c.uid });
      add({ name: 'Pot knob line', shape: 'box', size: [1.2, 6, 0.5], pos: [s.x, s.y + 5, surf + 12.25], color: '#ffffff', layer: 4, comp: s.c.uid });
      notes.push(`${nameOf(s.c)} → Ø18 mm knob.`);
    } else if (s.kind === 'indicator') {
      const lit = !ledRoleUsed; ledRoleUsed = true;
      add({ name: 'Indicator lens', shape: 'cyl', size: [6, 6, 1.6], pos: [s.x, s.y, surf + 0.8], role: lit ? 'led' : 'body', color: '#ffe9c7', finish: 'clear', layer: 3, comp: s.c.uid });
      notes.push(`${nameOf(s.c)} → light pipe with a Ø6 mm lens${lit ? ' that lights up in Prototype mode' : ''}.`);
    } else if (s.kind === 'sound') {
      add({ name: 'Sound port', shape: 'cyl', size: [1.6, 1.6, 0.6], pos: [s.x, s.y + 3.5, surf + 0.3], array: { n: 6, mode: 'radial', center: [s.x, s.y] }, color: HOLE, layer: 3, comp: s.c.uid });
      add({ name: 'Sound port (centre)', shape: 'cyl', size: [1.6, 1.6, 0.6], pos: [s.x, s.y, surf + 0.3], color: HOLE, layer: 3, comp: s.c.uid });
      notes.push(`${nameOf(s.c)} → 7-hole sound port in front of it.`);
    } else if (s.kind === 'display') {
      add({ name: 'Second display', shape: 'disc', size: [active, active, 0.3], pos: [s.x, s.y, surf + 0.15], color: '#000000', finish: 'gloss', layer: 3, comp: s.c.uid });
      add({ name: 'Second display bezel', shape: 'tube', size: [bezelD || active + 5, bezelD || active + 5, 1.2], pos: [s.x, s.y, surf + 0.6], param: active + 0.4, color: '#202226', finish: 'satin', layer: 3, comp: s.c.uid });
      notes.push(`${nameOf(s.c)}: a second window. Only the first display shows the firmware's screen.`);
    }
    body();
  }

  // ---------------------------------------------------------------- board
  let bx = 0, by = 0;
  const sides = [...new Set(bp.ports.map(p => p.side))];
  if (sides.length === 1) {
    const horiz = sides[0] === 'left' || sides[0] === 'right', dir = sides[0] === 'left' || sides[0] === 'bottom' ? -1 : 1, over = 1;
    const along = horiz ? bp.w : bp.h, across = horiz ? bp.h : bp.w;
    const want = style === 'rect' ? (horiz ? innerHalfX : innerHalfY) - 0.3 - (along / 2 + over) : Math.sqrt(Math.max(0, (Ri - 0.3) ** 2 - (across / 2) ** 2)) - (along / 2 + over);
    if (want > 1) { if (horiz) bx = dir * want; else by = dir * want; notes.push(`${board.name} moved ${mm(want)} toward the ${sides[0]} wall, as far as it fits, to bring its ${bp.ports.map(p => p.kind).join(', ')} up to the cutout${bp.ports.length > 1 ? 's' : ''}.`); }
  }
  add({ name: board.name, shape: 'box', size: [bp.w, bp.h, bp.t], pos: [bx, by, pcbZ], color: board.pcb ?? '#1f4d34', finish: 'satin', kind: 'internal', layer: 0, comp: 'board' });
  add({ name: `${board.chip} chip`, shape: 'box', size: [bp.chip, bp.chip, 1], pos: [bx, by, pcbFront + 0.5], color: '#111215', finish: 'satin', kind: 'internal', layer: 0, comp: 'board' });
  for (const p of bp.ports) portParts(p);
  function portParts(p: PortPhys) {
    const horiz = p.side === 'left' || p.side === 'right', sgn = p.side === 'left' || p.side === 'bottom' ? -1 : 1;
    const depth = Math.min(17, Math.max(5, p.w * 0.6)), over = 1;
    const ex = horiz ? bx + sgn * (bp.w / 2 - depth / 2 + over) : bx + p.offset, ey = horiz ? by + p.offset : by + sgn * (bp.h / 2 - depth / 2 + over);
    const zc = pcbFront + p.h / 2;
    add({ name: `${p.kind} connector`, shape: 'box', size: horiz ? [depth, p.w, p.h] : [p.w, depth, p.h], pos: [ex, ey, zc], color: '#c9ccd1', finish: 'polished', kind: 'internal', layer: 0, comp: 'board' });
    // cutout on the outside wall
    let wx: number, wy: number;
    if (style === 'rect') { wx = horiz ? sgn * (W / 2 + 0.1) : ex; wy = horiz ? ey : sgn * (H / 2 + 0.1); }
    else {
      const R = W / 2 + 0.1;
      if (horiz) { wy = ey; wx = sgn * Math.sqrt(Math.max(0, R * R - wy * wy)); } else { wx = ex; wy = sgn * Math.sqrt(Math.max(0, R * R - wx * wx)); }
    }
    const ang = Math.atan2(wy, wx) * 180 / Math.PI;
    add({ name: `${p.kind} cutout`, shape: 'rbox', size: [0.8, p.w + 1, p.h + 1], pos: [wx, wy, zc], rot: [0, 0, r1(ang)], param: 0.4, color: HOLE, finish: 'matte', kind: 'shell', layer: 0, comp: 'board' });
    const end = horiz ? Math.abs(ex) + depth / 2 : Math.abs(ey) + depth / 2;
    const wallAt = style === 'rect' ? (horiz ? innerHalfX : innerHalfY) : Math.sqrt(Math.max(0, Ri * Ri - (horiz ? ey : ex) ** 2));
    const gapMm = wallAt - end;
    if (gapMm > 3) notes.push(`${p.kind} sits ${mm(gapMm)} inside the wall: use a panel-mount extension, or move the board.`);
  }
  // standoffs at the real mounting holes: to the back wall, else to the front wall, else skip
  const backLen = boardBack - (-zf + wall), frontLen = (zf - wall - ringSlab) - pcbFront;
  const blockers = () => parts.filter(p => p.kind === 'internal' && p.comp !== 'board').flatMap(solidsOf);
  let omitted = 0, frontMounted = 0;
  bp.holes.forEach(([hx, hy], i) => {
    const mk = (len: number, zc: number) => ({ id: 'tmp', name: `Standoff ${i + 1}`, shape: 'cyl' as const, size: [5, 5, len] as [number, number, number], pos: [bx + hx, by + hy, zc] as [number, number, number], rot: [0, 0, 0] as [number, number, number], color: '#cfd2d6', finish: 'brushed', role: 'body' as const, kind: 'internal' as const });
    const back = mk(backLen, boardBack - backLen / 2), front = mk(frontLen, pcbFront + frontLen / 2);
    const mods3 = mods.map(m => ({ ...back, name: m.name, size: [m.w, m.h, m.d] as [number, number, number], pos: [m.x, m.y, modTop - m.d / 2] as [number, number, number], shape: 'box' as const }));
    const clear = (s: BuiltPart, others: BuiltPart[]) => s.size[2] > 0.5 && !others.flatMap(solidsOf).some(o => collide(solidsOf(s)[0], o));
    if (backLen > 0.5 && clear(back, mods3)) add({ ...back, id: newUid(), layer: 0, comp: 'board' });
    else if (frontLen > 0.5 && !blockers().some(o => collide(solidsOf(front)[0], o))) { add({ ...front, id: newUid(), layer: 0, comp: 'board' }); frontMounted++; }
    else omitted++;
  });
  if (bp.holes.length) notes.push(`${bp.holes.length - omitted} standoff${bp.holes.length - omitted === 1 ? '' : 's'} at the ${board.name} mounting holes${frontMounted ? ` (${frontMounted} hanging from the front panel because a module sits behind the board)` : ''}.${omitted ? ` ${omitted} left out because a part is in the way.` : ''}`);
  else notes.push(`${board.name} has no mounting holes: hold it with a clip or adhesive pad.`);
  if (bp.hot) {
    add({ name: 'Heat vents', shape: 'box', size: [1.6, 0.8, Math.min(12, D - 6)], pos: [-12.25, H / 2 + 0.1, pcbZ], array: { n: 8, mode: 'linear', step: [3.5, 0, 0] }, color: HOLE, kind: 'shell', layer: 0, comp: 'board' });
    notes.push(`${board.name} runs hot, so there are vent slots in the top wall above it.`);
  }

  // ---------------------------------------------------------------- packed modules
  for (const m of mods) {
    const isServo = m.type === 'servo';
    add({ name: m.name, shape: m.shape, size: [m.w, m.h, m.d], pos: [m.x, m.y, modTop - m.d / 2], color: m.color, finish: 'satin', kind: 'internal', layer: -1, comp: m.comp });
    const edgeY = style === 'rect' ? -H / 2 : -Math.sqrt(Math.max(0, (W / 2) ** 2 - m.x * m.x));
    const surface = partPhys(m.type).surface;
    if (m.type === 'sht40' || surface === 'vents') {
      add({ name: 'Sensor vents', shape: 'box', size: [1.6, 0.8, Math.min(10, D - 6)], pos: [m.x - 7, edgeY - 0.1, modTop - m.d / 2], array: { n: 5, mode: 'linear', step: [3.5, 0, 0] }, color: HOLE, kind: 'shell', layer: 0, comp: m.comp });
      notes.push(`${m.name} → vent slots in the bottom wall so it reads room air, not board heat.`);
    } else if (m.type === 'buzzer' || surface === 'sound') {
      add({ name: 'Sound grille', shape: 'cyl', size: [1.8, 1.8, 0.8], pos: [m.x - 6, edgeY - 0.1, modTop - m.d / 2], rot: [90, 0, 0], array: { n: 5, mode: 'linear', step: [3, 0, 0] }, color: HOLE, kind: 'shell', layer: 0, comp: m.comp });
      notes.push(`${m.name} → inside, with a 5-hole sound grille in the bottom wall below it.`);
    } else if (m.type === 'relay' || surface === 'wires') {
      add({ name: 'Wire entry', shape: 'rbox', size: [12, 0.8, Math.min(7, D - 6)], pos: [m.x, edgeY - 0.1, modTop - m.d / 2], param: 0.4, color: HOLE, kind: 'shell', layer: 0, comp: m.comp });
      notes.push(`${m.name} → wire entry in the bottom wall for its screw terminals.`);
    } else if (isServo) {
      const topY = style === 'rect' ? H / 2 : Math.sqrt(Math.max(0, (W / 2) ** 2 - m.x * m.x));
      add({ name: 'Servo output', shape: 'cyl', size: [6, 6, 4], pos: [m.x + m.w / 2 - 6, topY + 2, modTop - m.d / 2], rot: [90, 0, 0], color: '#f2f2f2', layer: 0, comp: m.comp });
      add({ name: 'Servo horn', shape: 'rbox', size: [22, 2, 6], pos: [m.x + m.w / 2 - 6, topY + 4.5, modTop - m.d / 2], param: 1, color: '#f2f2f2', layer: 0, comp: m.comp });
      notes.push(`${m.name} → output horn through the top wall. Mount the servo against that wall with a bracket (not modelled).`);
    } else if (m.type === 'haptic') notes.push(`${m.name} → inside, pressed against the back so it buzzes the whole case.`);
    else if (m.type === 'battery') notes.push(`${BATTERY.name} battery packed behind the board.`);
  }
  if (mods.length > 1) notes.push(`${mods.length} modules packed in one layer behind the board.`);

  // ---------------------------------------------------------------- mount
  if (o.mount === 'wall') {
    if (style === 'rect') add({ name: 'Wall plate', shape: 'rbox', size: [W + 10, H + 10, 2], pos: [0, 0, -zf - 1], param: corner + 3, color: PLATE, finish: 'matte', kind: 'shell', layer: -2 });
    else add({ name: 'Wall plate', shape: 'cyl', size: [Dm + 14, Dm + 14, 2], pos: [0, 0, -zf - 1], color: PLATE, finish: 'matte', kind: 'shell', layer: -2 });
  } else if (o.mount === 'desk') {
    if (style === 'rect') {
      for (const fz of [D / 2 - 5, -(D / 2 - 5)]) add({ name: 'Foot', shape: 'cyl', size: [8, 8, 3], pos: [-(W / 2 - 8), -H / 2 - 1.5, fz], rot: [90, 0, 0], array: { n: 2, mode: 'linear', step: [W - 16, 0, 0] }, color: '#2b2d31', finish: 'soft', kind: 'shell', layer: 0 });
    } else add({ name: 'Desk stand', shape: 'rbox', size: [Dm * 0.55, 8, D + 6], pos: [0, -Dm / 2 + 1, -1], param: 2, color: PLATE, finish: 'matte', kind: 'shell', layer: 0 });
  }

  if (!comps.length) notes.push('No parts are wired yet, so this is just the board in a case. Add parts in Electronics and auto build again.');
  const fit = fitBuilt(parts).filter(r => r.level !== 'ok');
  if (fit.length) notes.push(`Fit check: ${fit.length} issue${fit.length > 1 ? 's' : ''}. See the fit list.`);
  return { parts, notes, size: [W, H, D], style };
}
