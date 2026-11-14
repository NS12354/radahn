#!/usr/bin/env node
// Stand-in for the `claude` CLI in e2e tests: reads CLAUDE.md, then edits files when asked.
import fs from 'node:fs';
import readline from 'node:readline';
const ctx = fs.existsSync('CLAUDE.md') ? fs.readFileSync('CLAUDE.md', 'utf8') : '';
process.stdout.write(`FAKE CLAUDE ready in ${process.cwd()}\r\nboard: ${(ctx.match(/## Board\n(.+)/) ?? [])[1] ?? '?'}\r\n> `);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', l => {
  if (l.includes('add a helper')) { fs.mkdirSync('lib', { recursive: true }); fs.writeFileSync('lib/helper.py', 'def hello():\n    return "hi from claude"\n'); process.stdout.write('Created lib/helper.py\r\n'); }
  else if (l.includes('what is in main')) process.stdout.write(`main.py first line: ${fs.readFileSync('main.py', 'utf8').split('\n')[0]}\r\n`);
  else if (l.includes('move the button')) { const w = JSON.parse(fs.readFileSync('wiring.json', 'utf8')); w.parts.find(p => p.type === 'button').pins.SIG = 'GP7'; fs.writeFileSync('wiring.json', JSON.stringify(w, null, 2)); process.stdout.write('Moved the button\r\n'); }
  else if (l.includes('add an led') || l.includes('add a servo')) { const w = JSON.parse(fs.readFileSync('wiring.json', 'utf8')); w.parts.push(l.includes('led') ? { type: 'led', pins: { SIG: 'GP20' } } : { type: 'servo', pins: { PWM: 'GP21' } }); fs.writeFileSync('wiring.json', JSON.stringify(w, null, 2)); process.stdout.write('Proposed hardware\r\n'); }
  else if (l.includes('wiring status')) process.stdout.write(`STATUS: ${JSON.parse(fs.readFileSync('wiring.json', 'utf8'))._status ?? 'none'}\r\n`);
  else if (l.includes('parts catalog')) process.stdout.write(`CATALOG HAS NEOPIXEL: ${fs.readFileSync('PARTS.md', 'utf8').includes('`neopixel`')}\r\n`);
  else process.stdout.write(`You said: ${l}\r\n`);
  process.stdout.write('> ');
});
