import type { BuiltPart, Project } from './project';
import { COMPONENTS } from '../hw/library/components';

/**
 * Which model part shows the firmware's display.
 *
 * 1. A part you gave the Screen role yourself (one not tied to the electronics).
 * 2. The wired display itself: the model part of the LCD/OLED component you wired.
 *    Auto build also makes a "Display window" in the front panel for it; that is
 *    used only while it still sits in front of the display module, otherwise the
 *    image goes on the module.
 * 3. Any other part with the Screen role.
 * 4. Last resort, for models that aren't linked to the wiring: a part named like a
 *    display (screen / display / LCD / OLED / TFT / window), never a bezel or frame.
 */
const DISPLAY = /\b(screen|display|lcd|oled|tft|e-?ink|e-?paper|window)\b/i;
const NOT = /\b(bezel|frame|housing|case|cover|surround|ring|mount|bracket|cutout|hole)\b/i;
const SKIP_ROLES = new Set(['dial', 'led', 'ignore']);

export type ScreenWhy = 'role' | 'wiring' | 'name';
export interface ScreenPick { id: string; why: ScreenWhy; /** true unless you set the Screen role yourself */ auto: boolean }

/** Wired components that are displays. */
export function displayComps(p: Pick<Project, 'electronics'>): string[] {
  return p.electronics.comps.filter(c => { const d = COMPONENTS[c.type]; return d?.ui === 'screen' || d?.category === 'display'; }).map(c => c.uid);
}

/** Is `w` (a window) in front of module `m`, over its face? */
function covers(w: BuiltPart, m: BuiltPart) {
  const r = Math.max(m.size[0], m.size[1]) / 2;
  const front = m.pos[2] + m.size[2] / 2;
  return Math.hypot(w.pos[0] - m.pos[0], w.pos[1] - m.pos[1]) <= r && w.pos[2] >= front - 1 && w.pos[2] - front <= 15;
}

export function screenPart(parts: BuiltPart[], displays: string[] = []): ScreenPick | null {
  const shows = (p: BuiltPart) => !SKIP_ROLES.has(p.role) && p.size[0] * p.size[1] > 0;
  const area = (p: BuiltPart) => p.size[0] * p.size[1];

  // 1. your own choice
  const chosen = parts.find(p => p.role === 'screen' && !p.auto && !(p.comp && displays.includes(p.comp)));
  if (chosen) return { id: chosen.id, why: 'role', auto: false };

  // 2. the wired display
  for (const uid of displays) {
    const mine = parts.filter(p => p.comp === uid && shows(p));
    const module = mine.filter(p => p.role !== 'screen' && !NOT.test(p.name)).sort((a, b) => area(b) - area(a))[0];
    const window = mine.find(p => p.role === 'screen');
    if (window && (!module || covers(window, module))) return { id: window.id, why: 'wiring', auto: true };
    if (module) return { id: module.id, why: 'wiring', auto: true };
  }

  // 3. any Screen role
  const role = parts.find(p => p.role === 'screen');
  if (role) return { id: role.id, why: 'role', auto: !!role.auto };

  // 4. by name
  const rank = (p: BuiltPart) => (/\b(window|screen)\b/i.test(p.name) ? 2 : 0) + (p.shape === 'disc' || p.shape === 'rect' ? 1 : 0);
  const c = parts.filter(p => shows(p) && DISPLAY.test(p.name) && !NOT.test(p.name)).sort((a, b) => rank(b) - rank(a) || area(b) - area(a))[0];
  return c ? { id: c.id, why: 'name', auto: true } : null;
}
