/**
 * Cross-window sync between the studio and the 3D modeler window.
 * Both windows write to the same IndexedDB store; this channel only says
 * "project X changed" so the other window reloads what it cares about.
 *   built — the modeler wrote product.built (the studio rebuilds its model)
 *   saved — the studio saved the project (the modeler refreshes electronics etc.)
 */
export type SyncMsg = { type: 'built' | 'saved' | 'blender-open' | 'focus-studio'; id: string; from: string };

export const WINDOW_ID = Math.random().toString(36).slice(2);
let ch: BroadcastChannel | null = null;
try { ch = new BroadcastChannel('formframe'); } catch { /* old browser: windows just don't live-sync */ }

export function post(m: Omit<SyncMsg, 'from'>) { try { ch?.postMessage({ ...m, from: WINDOW_ID }); } catch { } }
export function listen(fn: (m: SyncMsg) => void) {
  ch?.addEventListener('message', e => { const m = e.data as SyncMsg; if (m && m.from !== WINDOW_ID) fn(m); });
}

export const modelerUrl = (base: string, id: string) => `${base}modeler.html?project=${encodeURIComponent(id)}`;
