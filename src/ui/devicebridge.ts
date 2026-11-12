import type { App } from './app';
import { bridge, device } from './elec';
import { COMPONENTS } from '../hw/library/components';
import { pinLabel } from '../hw/library/boards';
import { customOf } from '../hw/custom';

/**
 * Studio side of the device IDE window (device.html). The IDE edits files and
 * presses Run / Upload / Stop; the code still runs here, on the emulator wired
 * to the bench and the 3D model, and its serial output is relayed back.
 *
 * Channel 'formframe-device', messages { pid, dir, type, ... }.
 */
export type DevMsg = { pid: string; dir: 'ide' | 'studio'; type: string; [k: string]: any };
let ch: BroadcastChannel | null = null;
let A: App;
let pid: () => string | null;
const backlog: { text: string; cls?: string }[] = [];

export function deviceState() {
  const e = A.project.electronics, b = A.board();
  return {
    name: A.project.name, files: e.files, activeFile: e.activeFile,
    board: { id: b.id, name: b.name, chip: b.chip, lang: b.lang, runtime: b.runtime, fidelity: b.fidelity, logicV: b.logicV, pfx: b.pfx, gpio: b.gpio, adc: b.adc, labels: Object.fromEntries(b.gpio.map(g => [g, pinLabel(b, g)])) },
    comps: e.comps.map(c => ({ name: COMPONENTS[c.type]?.name ?? c.type, type: c.type, pins: c.pins, i2c: COMPONENTS[c.type]?.i2cAddress ?? customOf(c.type)?.i2cAddress ?? null, iface: customOf(c.type)?.interface ?? null })),
    running: device.running(), status: device.status(), backlog,
  };
}

function send(type: string, extra: Record<string, any> = {}) { const id = pid(); if (id) try { ch?.postMessage({ pid: id, dir: 'studio', type, ...extra }); } catch { } }
export function notifyDevice() { send('state', { state: deviceState() }); }

export function initDeviceBridge(app: App, projectId: () => string | null) {
  A = app; pid = projectId;
  try { ch = new BroadcastChannel('formframe-device'); } catch { return; }
  bridge.out = (text, cls) => { backlog.push({ text, cls }); if (backlog.length > 600) backlog.splice(0, backlog.length - 600); send('out', { text, cls }); };
  bridge.status = (running, text) => send('status', { running, text });
  bridge.compile = (text, ok) => send('compile', { text, ok });
  let ft: any = null;
  bridge.files = () => { clearTimeout(ft); ft = setTimeout(() => send('files', { files: A.project.electronics.files }), 250); };
  ch.onmessage = async ev => {
    const m = ev.data as DevMsg;
    if (!m || m.dir !== 'ide' || m.pid !== pid()) return;
    const ack = (ok: boolean, msg = '') => send('ack', { op: m.type, ok, msg, req: m.req });
    switch (m.type) {
      case 'hello': notifyDevice(); break;
      case 'save': device.setFile(m.name, m.content); ack(true); break;
      case 'create': if (A.project.electronics.files[m.name] != null) ack(false, `${m.name} already exists`); else { device.setFile(m.name, m.content ?? ''); ack(true); notifyDevice(); } break;
      case 'delete': ack(device.deleteFile(m.name), 'Can’t delete the last file'); notifyDevice(); break;
      case 'rename': ack(device.renameFile(m.from, m.to), `Can’t rename to ${m.to}`); notifyDevice(); break;
      case 'run': if (m.files) for (const [k, v] of Object.entries<string>(m.files)) device.setFile(k, v); await device.run(); break;
      case 'stop': await device.stop(); break;
      case 'verify': if (m.files) for (const [k, v] of Object.entries<string>(m.files)) device.setFile(k, v); await device.verify(); break;
      case 'send': device.send(m.text); break;
      case 'interrupt': device.interrupt(); break;
      case 'clear': backlog.length = 0; break;
    }
  };
}
