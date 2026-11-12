// Copy browser-loaded libraries from node_modules into public/vendor/
// (the Python simulator for ESP32 / Raspberry Pi boards, and the STEP importer).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
const files = [
  ['skulpt/dist/skulpt.min.js', 'skulpt.min.js'], ['skulpt/dist/skulpt-stdlib.js', 'skulpt-stdlib.js'],
  ['occt-import-js/dist/occt-import-js.js', 'occt-import-js.js'], ['occt-import-js/dist/occt-import-js.wasm', 'occt-import-js.wasm'],
];
fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const [from, to] of files) {
  const src = path.join(root, 'node_modules', from), dst = path.join(out, to);
  if (!fs.existsSync(src)) { console.warn(`copy-vendor: missing ${from} (run npm install)`); continue; }
  if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs) { fs.copyFileSync(src, dst); n++; }
}
if (n) console.log(`copy-vendor: copied ${n} file(s) to public/vendor/`);
