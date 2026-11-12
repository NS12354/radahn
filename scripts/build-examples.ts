// Precompile example firmware for the static build (no compiler server there).
import fs from 'node:fs';
import { BOARDS } from '../src/hw/library/boards';
import { defaultFiles } from '../src/hw/templates';
import { kitFor } from '../src/app/project';
// @ts-ignore
import { compileSketch } from '../server/compile.mjs';

for (const id of Object.keys(BOARDS).filter(b => BOARDS[b].lang === 'arduino')) {
  const files = defaultFiles(BOARDS[id], kitFor(id));
  const src = Object.fromEntries(Object.entries(files).filter(([k]) => /\.(ino|h)$/.test(k)));
  const { hex, log } = await compileSketch({ files: src, board: id });
  fs.writeFileSync(`public/firmware/examples/${id}-thermostat-default.hex.txt`, hex);
  console.log(id, log.split('\n').pop());
}
