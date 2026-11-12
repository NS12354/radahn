/**
 * IDE-window side of the device bridge (see src/ui/devicebridge.ts). The
 * studio owns the project and the running emulator; this window edits files
 * and sends Run / Stop / serial input.
 */
export interface DevBoard { id: string; name: string; chip: string; lang: 'micropython' | 'arduino' | 'python'; runtime: string; fidelity: string; logicV: number; pfx: string; gpio: number[]; adc: number[]; labels: Record<string, string> }
export interface DevComp { name: string; type: string; pins: Record<string, number | null>; i2c: number | null; iface: string | null }
export interface DevState { name: string; files: Record<string, string>; activeFile: string; board: DevBoard; comps: DevComp[]; running: boolean; status: string; backlog: { text: string; cls?: string }[] }

type Handler = (m: any) => void;
const handlers = new Map<string, Set<Handler>>();
let ch: BroadcastChannel | null = null;
export const pid = new URLSearchParams(location.search).get('project') ?? '';
export let state: DevState | null = null;
/** Which app started the current run ('thonny', 'term', 'ide'), so only that one shows its output. */
export let owner = '';
export const setOwner = (o: string) => { owner = o; };

export function on(type: string, fn: Handler) { (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(fn); return () => handlers.get(type)!.delete(fn); }
export function send(type: string, extra: Record<string, any> = {}) { try { ch?.postMessage({ pid, dir: 'ide', type, ...extra }); } catch { } }

/** Connect; resolves with the first state, or null if no studio window answers. */
export function connect(timeout = 1500): Promise<DevState | null> {
  try { ch = new BroadcastChannel('formframe-device'); } catch { return Promise.resolve(null); }
  ch.onmessage = ev => {
    const m = ev.data; if (!m || m.dir !== 'studio' || m.pid !== pid) return;
    if (m.type === 'state') state = m.state;
    if (m.type === 'files' && state) state.files = m.files;
    if (m.type === 'status' && state) { state.running = m.running; state.status = m.text; }
    handlers.get(m.type)?.forEach(f => f(m));
    handlers.get('*')?.forEach(f => f(m));
  };
  return new Promise(res => {
    const t = setTimeout(() => { off(); res(null); }, timeout);
    const off = on('state', () => { clearTimeout(t); off(); res(state); });
    send('hello');
  });
}

/** Studio serial output → lines (MicroPython raw-REPL control bytes and "@ff" mirror lines removed). */
export function lineBuffer(emit: (line: string, partial: boolean) => void) {
  let buf = '';
  return (text: string) => {
    buf += text.replace(/\x04/g, '').replace(/\r/g, '');
    const parts = buf.split('\n'); buf = parts.pop()!;
    for (const p of parts) if (!p.startsWith('@ff ')) emit(p, false);
    if (buf && !buf.startsWith('@ff') && /^(>>> |\.\.\. )$/.test(buf)) { emit(buf, true); buf = ''; }
  };
}
