/**
 * MicroPython raw-REPL file uploader. Works over any byte stream: the emulated
 * RP2040's USB-CDC or a real board over Web Serial.
 *
 *   Ctrl-C ×2 → stop running program
 *   Ctrl-A    → enter raw REPL ("raw REPL; CTRL-B to exit\r\n>")
 *   code + Ctrl-D → execute; reply "OK<stdout>\x04<stderr>\x04>"
 *   Ctrl-B    → back to friendly REPL;  Ctrl-D → soft reset, runs main.py
 */
export interface ByteLink {
  write(data: string): Promise<void> | void;
}

const modName = (path: string) => path.split('/').pop()!.replace(/\.py$/, '');

export class RawRepl {
  private buf = '';
  private waiters: { re: RegExp | string; resolve: (s: string) => void; reject: (e: Error) => void; timer: any }[] = [];

  /** Wall-clock timeout per step. Emulators on slow machines need generous values. */
  timeout = 30000;
  constructor(private link: ByteLink) {}

  /** Feed bytes received from the device. */
  feed(text: string) {
    this.buf += text;
    if (this.buf.length > 200_000) this.buf = this.buf.slice(-100_000);
    this.check();
  }

  private check() {
    for (const w of [...this.waiters]) {
      const idx = typeof w.re === 'string' ? this.buf.indexOf(w.re) : this.buf.search(w.re);
      if (idx >= 0) {
        const len = typeof w.re === 'string' ? w.re.length : (this.buf.slice(idx).match(w.re)![0].length);
        const consumed = this.buf.slice(0, idx + len);
        this.buf = this.buf.slice(idx + len);
        clearTimeout(w.timer);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(consumed);
      }
    }
  }

  expect(re: RegExp | string, timeoutMs = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      const w = { re, resolve, reject, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`Timed out waiting for ${re} (got: ${JSON.stringify(this.buf.slice(-120))})`)); }, timeoutMs) };
      this.waiters.push(w);
      this.check();
    });
  }

  async enter() {
    this.buf = '';
    await this.link.write('\r\x03\x03');
    await new Promise(r => setTimeout(r, 120));
    this.buf = '';
    await this.link.write('\x01');
    await this.expect('raw REPL; CTRL-B to exit\r\n>', this.timeout);
  }

  /** Execute code in raw REPL. Throws with the device traceback on error. */
  async exec(code: string, timeoutMs = this.timeout): Promise<string> {
    await this.link.write(code);
    await this.link.write('\x04');
    await this.expect('OK', timeoutMs);
    const out = await this.expect('\x04', timeoutMs);
    const err = await this.expect('\x04', timeoutMs);
    await this.expect('>', timeoutMs);
    const e = err.slice(0, -1);
    if (e.trim()) throw new Error(e.trim());
    return out.slice(0, -1);
  }

  async writeFile(path: string, content: string, chunk = 192) {
    const dirs = path.split('/').slice(0, -1);
    let pre = 'import os\n';
    let acc = '';
    for (const d of dirs) { acc += (acc ? '/' : '') + d; pre += `try:\n os.mkdir(${JSON.stringify(acc)})\nexcept OSError:\n pass\n`; }
    await this.exec(`${pre}f=open(${JSON.stringify(path)},'w')`);
    for (let i = 0; i < content.length; i += chunk) {
      await this.exec(`f.write(${JSON.stringify(content.slice(i, i + chunk))})`);
    }
    await this.exec('f.close()');
  }

  /** Upload files, then soft-reset so main.py runs. */
  async deploy(files: Record<string, string>, onProgress?: (msg: string) => void) {
    await this.enter();
    for (const [p, c] of Object.entries(files)) {
      onProgress?.(`writing ${p} (${c.length} B)`);
      await this.writeFile(p, c);
    }
    await this.link.write('\x02');
    await this.expect('>>> ', 3000).catch(() => {});
    await this.link.write('\x04'); // soft reset → main.py
  }

  /**
   * Run without a filesystem (emulator): register every non-main file as an
   * in-memory module in sys.modules, then stream main.py's execution.
   * Resolves once main has started; `onExit` fires with any traceback.
   */
  async runInRam(files: Record<string, string>, onProgress?: (msg: string) => void, onExit?: (err: string) => void) {
    await this.enter();
    await this.exec(`import sys
def _ffmod(name, src):
    g = {'__name__': name}
    exec(src, g)
    class _M:
        pass
    m = _M()
    for k in g:
        setattr(m, k, g[k])
    sys.modules[name] = m
`);
    const mainKey = Object.keys(files).find(f => /(^|\/)main\.py$/.test(f)) ?? Object.keys(files)[0];
    // dependencies first: modules imported by other modules load in listing order
    const libs = Object.keys(files).filter(f => f !== mainKey && f.endsWith('.py'));
    libs.sort((a, b) => (files[b].includes(modName(a)) ? 1 : 0) - (files[a].includes(modName(b)) ? 1 : 0));
    for (const f of libs) {
      onProgress?.(`loading ${f}`);
      await this.exec(`_ffmod(${JSON.stringify(modName(f))}, ${JSON.stringify(files[f])})`, this.timeout * 2);
    }
    onProgress?.(`running ${mainKey}`);
    await this.link.write(files[mainKey]);
    await this.link.write('\x04');
    await this.expect('OK', this.timeout);
    // stream until the program exits: "<stdout>\x04<stderr>\x04>"
    this.expect(/\x04([\s\S]*?)\x04>/, 2 ** 31 - 1).then(m => onExit?.(m.slice(1, -2).trim()), () => {});
  }

  cancelAll() { for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new Error('cancelled')); } this.waiters = []; }
}
