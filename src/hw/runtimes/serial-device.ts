import type { Bench } from '../bench';
import type { Level, ProductIO, Runtime } from '../types';
import { RawRepl } from '../repl';

/**
 * A physical MicroPython board over Web Serial (Chrome/Edge, secure context).
 * Run = write the project files to the board's filesystem via raw REPL, then
 * soft-reset so main.py runs, exactly like mpremote.
 *
 * Mirroring: lines the firmware prints as `@ff {json}` (see lib/ff.py) update
 * the 3D model (LEDs, screen text, haptic). Turning the 3D dial or pressing the
 * 3D display sends `@ffin enc 1` / `@ffin btn 1|0` lines the firmware can read
 * with ff.events(), so the model can also drive the real board.
 */
export class SerialDeviceRuntime implements Runtime {
  readonly kind = 'serial-device' as const;
  running = false;
  onSerial: (t: string) => void = () => {};
  onStatus: (s: string) => void = () => {};
  onExit: (err: string) => void = () => {};
  port: any = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reading = false;
  private repl: RawRepl;
  private deploying = false;
  private line = '';
  private t0 = performance.now();

  constructor(private bench: Bench, private product: () => ProductIO | null) {
    this.repl = new RawRepl({ write: s => this.write(s) });
  }

  static supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
  get connected() { return !!this.port; }

  async connect() {
    if (!SerialDeviceRuntime.supported()) throw new Error('Web Serial is not available in this browser or frame. Use Chrome or Edge on the local dev server.');
    const port = await (navigator as any).serial.requestPort();
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.readLoop();
    const info = port.getInfo?.() ?? {};
    this.onStatus(`connected${info.usbVendorId ? ` (USB ${info.usbVendorId.toString(16)}:${(info.usbProductId ?? 0).toString(16)})` : ''}`);
  }

  async disconnect() {
    this.reading = false;
    try { this.writer?.releaseLock(); await this.port?.close(); } catch { }
    this.port = null; this.writer = null; this.running = false;
    this.onStatus('disconnected');
  }

  private async readLoop() {
    this.reading = true;
    const dec = new TextDecoder();
    while (this.reading && this.port?.readable) {
      const reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const t = dec.decode(value, { stream: true });
          this.repl.feed(t);
          if (!this.deploying) this.handleText(t);
        }
      } catch (e) { this.onStatus('serial error: ' + (e as Error).message); break; }
      finally { reader.releaseLock(); }
    }
  }

  private handleText(t: string) {
    // pass everything through except mirror lines
    let visible = '';
    for (const ch of t) {
      this.line += ch;
      if (ch === '\n') {
        const l = this.line; this.line = '';
        if (l.startsWith('@ff ')) this.mirror(l.slice(4)); else visible += l;
      }
    }
    if (this.line && !'@ff '.startsWith(this.line.slice(0, 4))) { visible += this.line; this.line = ''; }
    if (visible) this.onSerial(visible);
  }

  private mirror(json: string) {
    let m: any; try { m = JSON.parse(json); } catch { return; }
    const p = this.product();
    if (!p) return;
    if (Array.isArray(m.leds)) p.setLeds(m.leds.map((c: number[]) => [c[0] | 0, c[1] | 0, c[2] | 0]));
    if (typeof m.haptic === 'boolean') p.haptic(m.haptic);
    if (Array.isArray(m.screen)) {
      const cv = p.screenCanvas() as HTMLCanvasElement; const g = cv.getContext('2d')!;
      g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      m.screen.forEach((s: string, i: number) => { g.font = `${i === 1 ? 600 : 400} ${i === 1 ? 72 : 30}px "JetBrains Mono", monospace`; g.fillText(String(s), cv.width / 2, cv.height * (0.32 + i * 0.18)); });
      p.screenUpdated();
    }
  }

  private async write(s: string) {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(new TextEncoder().encode(s));
  }

  async start(files: Record<string, string>) {
    if (!this.port) await this.connect();
    this.deploying = true;
    try { await this.repl.deploy(files, m => this.onStatus(m)); }
    finally { this.deploying = false; }
    this.running = true;
    this.onStatus('running main.py on the board');
  }

  async stop() { if (this.port) await this.write('\x03\x03'); this.running = false; }

  /** Forward 3D-model input to the firmware (read with ff.events()). */
  forward(ev: 'enc' | 'btn', v: number) { if (this.port && this.running) this.write(`@ffin ${ev} ${v}\r\n`).catch(() => {}); }

  setInput(_g: number, _l: Level) { /* real pins are driven by real parts */ }
  readOutput(): Level { return 1; }
  schedule(ns: number, fn: () => void) { setTimeout(fn, ns / 1e6); }
  now() { return (performance.now() - this.t0) * 1e6; }
  sendSerial(text: string) { this.write(text).catch(() => {}); }
}

/** Device-side helper deployed as lib/ff.py. */
export const FF_PY = `"""Formframe mirror helper for real boards.
Prints @ff JSON lines the Formframe app uses to mirror the 3D model, and reads
@ffin lines sent when you turn/press the 3D model. Harmless when unused.
"""
import sys
try:
    import ujson as json
except ImportError:
    try:
        import json
    except Exception:
        json = None
try:
    import select
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
except Exception:
    _poll = None

def _emit(d):
    if json:
        print('@ff ' + json.dumps(d))

def leds(pixels):
    _emit({'leds': [list(p) for p in pixels]})

def screen(*lines):
    _emit({'screen': [str(s) for s in lines]})

def haptic(on):
    _emit({'haptic': bool(on)})

def events():
    """Returns a list like [['enc', '1'], ['btn', '1']] of 3D-model inputs."""
    out = []
    while _poll and _poll.poll(0):
        line = sys.stdin.readline().strip()
        if line.startswith('@ffin '):
            out.append(line[6:].split())
    return out
`;
