// Formframe Arduino compile service.
// Compiles an Arduino sketch for an AVR board into Intel HEX.
//   1. Uses `arduino-cli` if it's on PATH (full library manager support).
//   2. Otherwise falls back to avr-gcc + a vendored ArduinoCore-avr checkout
//      (see scripts/setup-toolchain.sh). The core is compiled once and cached.
//
// Usage as a library:  const { hex, log } = await compileSketch({ files, board })
// Usage from CLI:      node server/compile.mjs path/to/sketch.ino [uno|nano]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = process.env.FF_ARDUINO_CORE || path.join(ROOT, 'vendor/ArduinoCore-avr');
const EXTRA_LIBS = (process.env.FF_ARDUINO_LIBS || path.join(ROOT, 'vendor')).split(path.delimiter);
const CACHE = path.join(os.tmpdir(), 'formframe-avr-cache');

export const BOARDS = {
  uno:  { mcu: 'atmega328p', fcpu: '16000000L', variant: 'standard', define: 'ARDUINO_AVR_UNO',  fqbn: 'arduino:avr:uno' },
  nano: { mcu: 'atmega328p', fcpu: '16000000L', variant: 'eightanaloginputs', define: 'ARDUINO_AVR_NANO', fqbn: 'arduino:avr:nano' },
};

async function has(cmd) {
  // arduino-cli uses a `version` subcommand; gcc-style tools use --version
  try { await run(cmd, cmd === 'arduino-cli' ? ['version'] : ['--version']); return true; } catch { return false; }
}

/** Generate forward declarations for top-level functions, like the Arduino builder. */
export function preprocessIno(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
  const protos = [];
  const re = /^([A-Za-z_][\w:<>,\s\*&]*?)\s+([A-Za-z_]\w*)\s*\(([^;{}()]*)\)\s*\{/gm;
  let depth = 0, last = 0, m;
  // only match at brace depth 0
  const depthAt = idx => { for (; last < idx; last++) { const c = noComments[last]; if (c === '{') depth++; else if (c === '}') depth--; } return depth; };
  while ((m = re.exec(noComments))) {
    if (depthAt(m.index) !== 0) continue;
    const [, ret, name, args] = m;
    if (['if', 'for', 'while', 'switch', 'else'].includes(name)) continue;
    if (/\b(class|struct|enum|namespace)\b/.test(ret)) continue;
    protos.push(`${ret.trim()} ${name}(${args.replace(/=[^,]+/g, '').trim()});`);
  }
  // insert prototypes after the last #include so user types are visible
  const lines = src.split('\n');
  let insertAt = 0;
  lines.forEach((l, i) => { if (/^\s*#\s*include/.test(l)) insertAt = i + 1; });
  const head = lines.slice(0, insertAt).join('\n');
  const tail = lines.slice(insertAt).join('\n');
  return `#include <Arduino.h>\n${head}\n// --- auto-generated prototypes ---\n${protos.join('\n')}\n#line ${insertAt + 1}\n${tail}\n`;
}

function flags(b) {
  return {
    common: [`-mmcu=${b.mcu}`, `-DF_CPU=${b.fcpu}`, '-DARDUINO=10819', `-D${b.define}`, '-DARDUINO_ARCH_AVR', '-Os', '-g', '-ffunction-sections', '-fdata-sections', '-w', '-MMD'],
    cpp: ['-std=gnu++11', '-fpermissive', '-fno-exceptions', '-fno-threadsafe-statics', '-flto'],
    c: ['-std=gnu11', '-flto'],
    S: ['-x', 'assembler-with-cpp', '-flto'],
  };
}

async function listSources(dir, recursive = true) {
  const out = [];
  if (!fss.existsSync(dir)) return out;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive && !['examples', 'extras', 'test', 'tests'].includes(e.name)) out.push(...await listSources(p)); }
    else if (/\.(c|cpp|S)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function compileOne(src, obj, b, includes) {
  const f = flags(b);
  const ext = path.extname(src);
  const lang = ext === '.cpp' ? f.cpp : ext === '.c' ? f.c : f.S;
  const cc = ext === '.cpp' ? 'avr-g++' : 'avr-gcc';
  await fs.mkdir(path.dirname(obj), { recursive: true });
  await run(cc, ['-c', ...f.common, ...lang, ...includes.map(i => `-I${i}`), src, '-o', obj], { maxBuffer: 1 << 24 });
}

/** Resolve libraries from #include lines: core libraries (SPI, Wire...) and vendored ones. */
function resolveLibraries(sources) {
  const wanted = new Set();
  for (const s of sources) for (const m of s.matchAll(/#\s*include\s*[<"]([\w./-]+)\.h[>"]/g)) wanted.add(m[1]);
  const dirs = [];
  const roots = [path.join(CORE, 'libraries'), ...EXTRA_LIBS];
  for (const name of wanted) {
    for (const r of roots) {
      if (!fss.existsSync(r)) continue;
      for (const lib of fss.readdirSync(r)) {
        const base = path.join(r, lib);
        const cand = [path.join(base, 'src'), base];
        for (const c of cand) if (fss.existsSync(path.join(c, name + '.h')) && !dirs.includes(c)) dirs.push(c);
      }
    }
  }
  return dirs;
}

async function compileFallback(files, boardId) {
  const b = BOARDS[boardId];
  if (!b) throw new Error(`Unknown AVR board "${boardId}"`);
  if (!fss.existsSync(path.join(CORE, 'cores/arduino/Arduino.h'))) throw new Error(`ArduinoCore-avr not found at ${CORE}. Run scripts/setup-toolchain.sh or install arduino-cli.`);
  if (!(await has('avr-gcc'))) throw new Error('avr-gcc not found. Install arduino-cli, or avr-gcc + avr-libc (apt install gcc-avr avr-libc).');

  const coreInc = [path.join(CORE, 'cores/arduino'), path.join(CORE, 'variants', b.variant)];
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-sketch-'));
  const log = [];
  try {
    // write sketch files
    const srcTexts = [];
    for (const [name, text] of Object.entries(files)) {
      const out = path.join(work, 'sketch', name.endsWith('.ino') ? name + '.cpp' : name);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, name.endsWith('.ino') ? preprocessIno(text) : text);
      srcTexts.push(text);
    }
    const libDirs = resolveLibraries(srcTexts);
    const includes = [...coreInc, ...libDirs, path.join(work, 'sketch')];

    // core (cached per board)
    const coreDir = path.join(CACHE, boardId, 'core');
    const coreA = path.join(coreDir, 'core.a');
    if (!fss.existsSync(coreA)) {
      const srcs = await listSources(path.join(CORE, 'cores/arduino'), false);
      const objs = [];
      for (const s of srcs) { const o = path.join(coreDir, path.basename(s) + '.o'); await compileOne(s, o, b, coreInc); objs.push(o); }
      await run('avr-gcc-ar', ['rcs', coreA, ...objs]);
      log.push(`core: compiled ${srcs.length} files (cached)`);
    }

    // libraries (cached per board + lib path)
    const libObjs = [];
    for (const d of libDirs) {
      const key = crypto.createHash('md5').update(d).digest('hex').slice(0, 10);
      const ld = path.join(CACHE, boardId, 'lib-' + key);
      for (const s of await listSources(d)) {
        if (/_RP2|esp|ESP|nrf|samd|kendyte|rp2040/i.test(path.basename(s))) continue;
        const o = path.join(ld, path.relative(d, s) + '.o');
        if (!fss.existsSync(o)) await compileOne(s, o, b, includes);
        libObjs.push(o);
      }
      log.push(`library: ${path.basename(path.dirname(d)) === 'libraries' ? path.basename(d) : path.basename(d.replace(/\/src$/, ''))}`);
    }

    // sketch
    const sketchObjs = [];
    for (const s of await listSources(path.join(work, 'sketch'))) {
      const o = s + '.o';
      try { await compileOne(s, o, b, includes); }
      catch (e) { throw new Error(cleanErrors(e.stderr || String(e), work)); }
      sketchObjs.push(o);
    }

    const elf = path.join(work, 'sketch.elf'), hex = path.join(work, 'sketch.hex');
    try {
      await run('avr-gcc', [`-mmcu=${b.mcu}`, '-Os', '-flto', '-fuse-linker-plugin', '-Wl,--gc-sections', '-o', elf, ...sketchObjs, ...libObjs, coreA, '-lm']);
    } catch (e) { throw new Error(cleanErrors(e.stderr || String(e), work)); }
    await run('avr-objcopy', ['-O', 'ihex', '-R', '.eeprom', elf, hex]);
    const size = (await run('avr-size', ['-A', elf])).stdout;
    const text = +(size.match(/\.text\s+(\d+)/) || [])[1] || 0, data = +(size.match(/\.data\s+(\d+)/) || [])[1] || 0, bss = +(size.match(/\.bss\s+(\d+)/) || [])[1] || 0;
    log.push(`flash ${text + data} / 32256 bytes · RAM ${data + bss} / 2048 bytes`);
    return { hex: await fs.readFile(hex, 'utf8'), log: log.join('\n'), toolchain: 'avr-gcc' };
  } finally {
    fs.rm(work, { recursive: true, force: true });
  }
}

function cleanErrors(stderr, work) {
  return stderr.split('\n').filter(l => /error|Error|undefined reference/.test(l))
    .map(l => l.replace(new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/sketch/', 'g'), '').replace(/\.ino\.cpp/g, '.ino'))
    .slice(0, 20).join('\n') || stderr.slice(0, 2000);
}

async function compileArduinoCli(files, boardId) {
  const b = BOARDS[boardId];
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-cli-'));
  const name = 'sketch';
  const dir = path.join(work, name);
  await fs.mkdir(dir, { recursive: true });
  const main = Object.keys(files).find(f => f.endsWith('.ino'));
  for (const [f, t] of Object.entries(files)) await fs.writeFile(path.join(dir, f === main ? name + '.ino' : f), t);
  try {
    const { stdout } = await run('arduino-cli', ['compile', '--fqbn', b.fqbn, '--output-dir', path.join(work, 'out'), dir], { maxBuffer: 1 << 24 });
    const hex = await fs.readFile(path.join(work, 'out', name + '.ino.hex'), 'utf8');
    return { hex, log: stdout.trim().split('\n').slice(-3).join('\n'), toolchain: 'arduino-cli' };
  } catch (e) {
    // strip the temp folder (macOS reports it under /private/var/…) so errors read "sketch.ino:2:27"
    const real = await fs.realpath(dir).catch(() => dir), esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const main2 = Object.keys(files).find(f => f.endsWith('.ino')) ?? 'sketch.ino';
    throw new Error((e.stderr || e.stdout || String(e)).replace(new RegExp(`(?:${esc(real)}|${esc(dir)})/`, 'g'), '').replace(/\bsketch\.ino\b/g, main2).slice(0, 3000));
  } finally { fs.rm(work, { recursive: true, force: true }); }
}

/** Is any AVR toolchain installed (arduino-cli, or avr-gcc + vendored core)? */
export async function toolchainAvailable() {
  if (await has('arduino-cli')) return 'arduino-cli';
  if (fss.existsSync(path.join(CORE, 'cores/arduino/Arduino.h')) && await has('avr-gcc')) return 'avr-gcc';
  return null;
}

export async function compileSketch({ files, board = 'uno' }) {
  if (process.env.FF_USE_ARDUINO_CLI !== '0' && await has('arduino-cli')) return compileArduinoCli(files, board);
  return compileFallback(files, board);
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node server/compile.mjs sketch.ino [uno|nano] > out.hex'); process.exit(1); }
  const text = await fs.readFile(file, 'utf8');
  try {
    const r = await compileSketch({ files: { [path.basename(file)]: text }, board: process.argv[3] || 'uno' });
    process.stderr.write(r.log + '\n');
    process.stdout.write(r.hex);
  } catch (e) { console.error(e.message); process.exit(2); }
}
