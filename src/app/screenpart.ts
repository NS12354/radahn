import type { BuiltPart } from './project';

/**
 * Which model part shows the firmware's display.
 *
 * A part with the Screen role wins. Otherwise, if a part is clearly the
 * display (its name says screen / display / LCD / OLED / TFT / window, as parts
 * made from electronics do, e.g. "GC9A01 1.28" round LCD module"), it shows the
 * display automatically, so a hand-built model lights up without setting roles.
 * Frames around a display (bezel, frame, cover, …) are never picked.
 */
const DISPLAY = /\b(screen|display|lcd|oled|tft|e-?ink|e-?paper|window)\b/i;
const NOT = /\b(bezel|frame|housing|case|cover|surround|ring|mount|bracket|cutout|hole)\b/i;
const SKIP_ROLES = new Set(['dial', 'led', 'ignore']);

export function screenPart(parts: BuiltPart[]): { id: string; auto: boolean } | null {
  const explicit = parts.find(p => p.role === 'screen');
  if (explicit) return { id: explicit.id, auto: false };
  const area = (p: BuiltPart) => p.size[0] * p.size[1];
  const rank = (p: BuiltPart) => (/\b(window|screen)\b/i.test(p.name) ? 2 : 0) + (p.shape === 'disc' || p.shape === 'rect' ? 1 : 0);
  const c = parts.filter(p => !SKIP_ROLES.has(p.role) && DISPLAY.test(p.name) && !NOT.test(p.name) && area(p) > 0)
    .sort((a, b) => rank(b) - rank(a) || area(b) - area(a))[0];
  return c ? { id: c.id, auto: true } : null;
}
