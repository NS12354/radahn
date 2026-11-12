/**
 * Plain-language explanations for everything that can go wrong in a
 * prototype: electrical checks, simulator warnings, Python/MicroPython
 * errors and Arduino compiler errors. Pure functions, shared by the studio
 * and the device IDE windows.
 */
export type Level = 'broken' | 'warning' | 'tip';
export type Area = 'wiring' | 'code' | 'running' | 'model' | 'interactions' | 'setup' | 'test';
export type FixKind = 'connect' | 'move' | 'move-adc' | 'move-pwm' | 'move-bus' | 'pullup' | 'none';
export interface Explained {
  level: Level; area: Area; title: string; why?: string; fix?: string;
  /** what "Fix it" does, when it can be done automatically */
  autofix?: { kind: FixKind; uid?: string; role?: string; pin?: number; label: string };
  /** where "Show me" goes */
  at?: { uid?: string; file?: string; line?: number; pin?: number; mode?: 'design' | 'proto' | 'elec' | 'review' };
  raw?: string;
}

/** Beginner names for parts: "GC9A01 1.28\" round LCD" → "display". */
const PLAIN: [RegExp, string][] = [[/GC9A01|round LCD|TFT|OLED|display/i, 'display'], [/NeoPixel|WS2812/i, 'LED ring'], [/SHT40|temp \/ RH|BME|DHT/i, 'temperature sensor'], [/encoder/i, 'dial'], [/potentiometer/i, 'knob'], [/push button|^button/i, 'button'], [/relay/i, 'relay'], [/haptic/i, 'vibration motor'], [/piezo|buzzer/i, 'buzzer'], [/servo/i, 'servo'], [/^LED\b/i, 'LED']];
export const friendly = (name: string) => { for (const [re, n] of PLAIN) if (re.test(name)) return n; return name.replace(/\s*\([^)]*\)/g, '').replace(/\s+[×x]\d+\b/, '').trim(); };
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ electrical design checks
export function explainCheck(msg: string, level: 'err' | 'warn' | 'ok', uid?: string): Explained | null {
  if (level === 'ok') return null;
  const lv: Level = level === 'err' ? 'broken' : 'warning';
  let m: RegExpMatchArray | null;
  if ((m = msg.match(/^(\S+) is used by (.+)\.$/)))
    return { level: 'broken', area: 'wiring', title: `Two parts are plugged into the same pin (${m[1]})`, why: `${m[2]} both use ${m[1]}, so their signals collide and neither works properly.`, fix: 'Move one of them to a free pin.', autofix: { kind: 'move', label: 'Move to a free pin' }, at: { mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): (\w+) is not connected\.$/)))
    return { level: 'warning', area: 'wiring', title: `The ${friendly(m[1])} isn't connected (${m[2]} pin)`, why: `Without a wire on ${m[2]}, the board can't talk to the ${friendly(m[1]).toLowerCase()}.`, fix: 'Pick a pin for it on the bench, or let Formframe choose one.', autofix: { kind: 'connect', uid, role: m[2], label: 'Connect to a free pin' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): (\S+) doesn't exist on (.+)\.$/)))
    return { level: 'broken', area: 'wiring', title: `${cap(friendly(m[1]))} is on a pin this board doesn't have`, why: `${m[2]} isn't a pin on the ${m[3]}.`, fix: 'Move it to one of the board\'s pins.', autofix: { kind: 'move', uid, label: 'Move to a free pin' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+) on (\S+): strapping pin/)))
    return { level: 'tip', area: 'wiring', title: `${cap(friendly(m[1]))} is on a "boot" pin (${m[2]})`, why: 'The board checks this pin while it starts up. A part attached to it can stop the board from booting.', fix: 'Use a different pin if you can.', autofix: { kind: 'move', uid, label: 'Move to a safer pin' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+) on (\S+) shares the USB serial pins/)))
    return { level: 'warning', area: 'wiring', title: `${cap(friendly(m[1]))} is on the USB pins (${m[2]})`, why: 'D0 and D1 carry the USB connection, so uploads and the Serial Monitor will fight with this part.', fix: 'Move it to another digital pin.', autofix: { kind: 'move', uid, label: 'Move to a free pin' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): (\S+) is not an ADC pin/)))
    return { level: 'broken', area: 'wiring', title: `The ${friendly(m[1])} needs an analog pin`, why: `It sends a varying voltage, but ${m[2]} can only read on/off.`, fix: 'Move it to an analog (ADC) pin.', autofix: { kind: 'move-adc', uid, label: 'Move to an analog pin' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): (.+) has no analog inputs/)))
    return { level: 'broken', area: 'wiring', title: `${m[2]} can't read ${friendly(m[1]).toLowerCase()}`, why: 'This board has no analog inputs at all.', fix: 'Add an analog-to-digital converter chip such as the MCP3008, or pick a board with analog pins (e.g. Pico or Uno).', at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): (\S+) is ADC2/)))
    return { level: 'warning', area: 'wiring', title: `The ${friendly(m[1])} will stop reading when Wi-Fi is on`, why: `${m[2]} belongs to the ESP32's second analog unit, which Wi-Fi takes over.`, fix: 'Move it to an ADC1 pin (GPIO1-10).', autofix: { kind: 'move-adc', uid, label: 'Move to an ADC1 pin' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): (\S+) has no hardware PWM/)))
    return { level: lv, area: 'wiring', title: `The ${friendly(m[1])} needs a PWM pin`, why: `It's controlled by fast pulses, which ${m[2]} can't produce.`, fix: 'Move it to a pin that supports PWM.', autofix: { kind: 'move-pwm', uid, label: 'Move to a PWM pin' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): SCK .* aren't a hardware SPI pin pair/)))
    return { level: 'broken', area: 'wiring', title: `The ${friendly(m[1])}'s SCK and MOSI wires don't match`, why: 'SPI parts need a clock (SCK) and data (MOSI) pin from the same SPI group on the board.', fix: 'Move both wires to one of the board\'s SPI pin pairs.', autofix: { kind: 'move-bus', uid, label: 'Use a matching SPI pair' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+): SDA\/SCL aren't a hardware I2C pin pair/)))
    return { level: 'broken', area: 'wiring', title: `The ${friendly(m[1])}'s SDA and SCL wires don't match`, why: 'I2C parts need a data (SDA) and clock (SCL) pin from the same I2C group on the board.', fix: 'Move both wires to one of the board\'s I2C pin pairs.', autofix: { kind: 'move-bus', uid, label: 'Use a matching I2C pair' }, at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(.+) draws (\d+) mA from one pin \((.+) recommends ≤ (\d+) mA\)/)))
    return { level: 'warning', area: 'wiring', title: `The ${friendly(m[1])} pulls too much current from one pin`, why: `It wants ${m[2]} mA; a pin on the ${m[3]} is happy with up to ${m[4]} mA. Too much can damage the pin.`, fix: 'Use a bigger resistor, or switch it through a transistor.', at: { uid, mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^3V3 rail peak (\d+) mA of ~(\d+)/)))
    return { level: 'broken', area: 'wiring', title: 'The 3.3 V supply is overloaded', why: `Parts on 3.3 V can draw ${m[1]} mA together, but the board only supplies about ${m[2]} mA.`, fix: 'Power the hungriest parts from 5 V or a separate supply.', at: { mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^5 V peak (\d+) mA of ~(\d+)/)))
    return { level: 'tip', area: 'wiring', title: 'On real hardware: USB power may not be enough at full brightness', why: `Everything on 5 V can peak at ${m[1]} mA; USB gives about ${m[2]} mA.`, fix: 'Use a separate 5 V supply, or dim LEDs in your code.', at: { mode: 'elec' }, raw: msg };
  if (/NeoPixel ring draws/.test(msg))
    return { level: 'tip', area: 'wiring', title: 'On real hardware: the LED ring needs a bigger power supply at full white', why: msg, fix: 'Keep brightness low in code, or give the ring its own 5 V supply.', at: { uid, mode: 'elec' }, raw: msg };
  if (/3\.3 V part on a 5 V board|uses 3\.3 V logic on a 5 V board/.test(msg))
    return { level: 'warning', area: 'wiring', title: msg.split(' is a 3.3 V')[0].split(' uses 3.3 V')[0] + ' is a 3.3 V part on a 5 V board', why: 'The board\'s 5 V signals can damage parts made for 3.3 V.', fix: 'Use a breakout with a level shifter, or a 3.3 V board.', at: { uid, mode: 'elec' }, raw: msg };
  if (/may not read 3\.3 V data/.test(msg))
    return { level: 'tip', area: 'wiring', title: `On real hardware: the ${friendly(msg.split(' on 5 V')[0])} may need a level shifter`, why: msg, fix: 'Add a 74AHCT125 level shifter between the board and the part.', at: { uid, mode: 'elec' }, raw: msg };
  return { level: lv, area: 'wiring', title: msg, at: { uid, mode: 'elec' }, raw: msg };
}

// ------------------------------------------------------------------ simulator warnings while running
export function explainSim(text: string): Explained {
  const msg = text.replace(/^\[sim\]\s*/, '').trim();
  let m: RegExpMatchArray | null;
  if ((m = msg.match(/^(\S+) \((.+)\) isn't connected to any component/)))
    return { level: 'broken', area: 'running', title: `Your code uses ${m[1]}, but nothing is plugged into it`, why: `The code talks to ${m[1]} (${m[2]}), so whatever it's meant to control won't react.`, fix: `Change the pin number in your code to the pin the part is wired to, or move the part to ${m[1]}.`, at: { pin: pinNum(m[1]), mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^(\S+) isn't a usable pin/)))
    return { level: 'broken', area: 'running', title: `Your code uses ${m[1]}, which this board doesn't have`, fix: 'Check the pin number in your code.', at: { pin: pinNum(m[1]), mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^Writing to (\S+), but it's configured as an input/)))
    return { level: 'broken', area: 'running', title: `Your code writes to ${m[1]} but set it up as an input`, why: 'An input pin can only be read, so the part never turns on.', fix: `Create the pin with Pin.OUT, e.g. Pin(${pinNum(m[1])}, Pin.OUT).`, at: { pin: pinNum(m[1]) }, raw: msg };
  if ((m = msg.match(/^Button on (\S+) connects to GND, so PULL_DOWN/)))
    return { level: 'broken', area: 'running', title: 'The button always reads "not pressed"', why: `It connects ${m[1]} to ground when pressed, and PULL_DOWN also holds it at ground, so nothing changes.`, fix: 'Use Pin.PULL_UP, and treat 0 as "pressed".', at: { pin: pinNum(m[1]) }, raw: msg };
  if ((m = msg.match(/^(\S+) has no pull resistor, so the input floats/)))
    return { level: 'broken', area: 'running', title: `The input on ${m[1]} gives random readings`, why: 'With nothing holding the pin high or low, it picks up noise and reads 0 and 1 at random (a "floating" input).', fix: 'Turn on the built-in pull-up: Pin(…, Pin.IN, Pin.PULL_UP).', autofix: { kind: 'pullup', pin: pinNum(m[1]), label: 'Add PULL_UP in the code' }, at: { pin: pinNum(m[1]) }, raw: msg };
  if ((m = msg.match(/^Passive piezo on (\S+) only clicks/)))
    return { level: 'warning', area: 'running', title: 'The buzzer only clicks instead of beeping', why: 'This kind of buzzer needs a fast on/off signal (PWM) to make a tone.', fix: 'Use PWM(Pin(…)) with freq() and duty_u16() instead of turning the pin on.', at: { pin: pinNum(m[1]) }, raw: msg };
  if ((m = msg.match(/^Servo on (\S+) expects 50 Hz PWM, got (\d+)/)))
    return { level: 'broken', area: 'running', title: 'The servo is getting the wrong signal', why: `Servos need 50 pulses a second; your code sends ${m[2]}.`, fix: 'Set the PWM frequency to 50: pwm.freq(50).', at: { pin: pinNum(m[1]) }, raw: msg };
  if (/^Software PWM on/.test(msg)) return { level: 'warning', area: 'running', title: 'The servo will jitter on this pin', why: msg, fix: 'Move it to a hardware PWM pin: GPIO 12, 13, 18 or 19.', raw: msg };
  if ((m = msg.match(/^I2C device 0x([0-9a-f]+) not found/i)) || (m = msg.match(/^SPI traffic on/)))
    return msg.startsWith('SPI')
      ? { level: 'broken', area: 'running', title: 'Your code sends display/SPI data, but nothing is wired to those pins', why: msg, fix: 'Check the SCK and MOSI pin numbers in your code against the bench.', at: { mode: 'elec' }, raw: msg }
      : { level: 'broken', area: 'running', title: `No part answered at I2C address 0x${m[1]}`, why: 'Your code looked for a part at that address, but none is wired to those SDA/SCL pins (or the address is wrong).', fix: 'Check the SDA/SCL pins in your code match the bench, and the address matches the part.', at: { mode: 'elec' }, raw: msg };
  if (/NeoPixel data pin (\S+) isn't wired/.test(msg)) return { level: 'broken', area: 'running', title: 'The LED ring\'s data pin in your code is wrong', why: msg, fix: 'Use the pin the ring\'s DIN is wired to.', at: { mode: 'elec' }, raw: msg };
  if ((m = msg.match(/^The ring has (\d+) LEDs, but the code declares (\d+)/))) return { level: 'warning', area: 'running', title: `Your code thinks the ring has ${m[2]} LEDs (it has ${m[1]})`, fix: `Change the count in NeoPixel(…, ${m[1]}).`, raw: msg };
  if (/No display is wired up/.test(msg)) return { level: 'broken', area: 'running', title: 'Your code draws to a display, but none is wired', fix: 'Add the display in Electronics, or remove the drawing code.', at: { mode: 'elec' }, raw: msg };
  if (/Display not responding/.test(msg)) return { level: 'broken', area: 'running', title: 'The display isn\'t responding', why: msg, fix: 'Compare the display\'s pin numbers in your code with the bench.', at: { mode: 'elec' }, raw: msg };
  if (/no analog inputs/.test(msg)) return { level: 'broken', area: 'running', title: 'This board can\'t read analog values', why: msg, fix: 'Add an MCP3008 ADC, or pick a board with analog pins.', raw: msg };
  if (/registers and timing aren't modelled|register contents and timing aren't modelled/.test(msg)) return { level: 'tip', area: 'running', title: msg.split(':')[0] + ' is simulated simply', why: 'It answers on its bus, but returns zeros for readings. Wiring and addressing are still checked.', raw: msg };
  if (/Wiring changed, so the firmware was stopped/.test(msg)) return { level: 'tip', area: 'running', title: 'You changed the wiring, so the code stopped', fix: 'Press Run again.', raw: msg };
  if (/Wiring changed\. Check the pin numbers/.test(msg)) return { level: 'tip', area: 'code', title: 'You changed the wiring: check your code uses the new pins', why: 'Your code was edited by hand, so Formframe didn\'t update its pin numbers.', fix: 'Update the pin numbers in your code, or press Reset code.', raw: msg };
  if (/Board changed and pins were reassigned/.test(msg)) return { level: 'tip', area: 'code', title: 'You changed the board: check your code uses the new pins', fix: 'Update the pin numbers in your code, or press Reset code.', raw: msg };
  return { level: 'warning', area: 'running', title: msg, raw: msg };
}
const pinNum = (label: string) => { const m = label.match(/(\d+)$/); return m ? +m[1] : undefined; };

// ------------------------------------------------------------------ Python / MicroPython errors
export function explainPython(type: string, message: string, line: number | undefined, files: Record<string, string>, file = 'main.py'): Explained {
  const at = { file, line, mode: 'elec' as const }, where = line ? `Line ${line}` : 'Your code';
  const codeLine = line ? (files[file] ?? '').split('\n')[line - 1]?.trim() : undefined;
  const base = { level: 'broken' as Level, area: 'code' as Area, at, raw: `${type}: ${message}` };
  let m: RegExpMatchArray | null;
  if (type === 'NameError' && (m = message.match(/name '(\w+)' is(?:n't| not) defined/))) {
    const s = suggest(m[1], files);
    return { ...base, title: `${where} uses \`${m[1]}\`, which doesn't exist`, why: `Python doesn't know anything called \`${m[1]}\`${codeLine ? ` in: ${codeLine}` : ''}.`, fix: s ? `Did you mean \`${s}\`? Otherwise create it (or import it) before this line.` : 'Check the spelling, or create it before this line.' };
  }
  if ((type === 'ImportError' || type === 'ModuleNotFoundError') && (m = message.match(/(?:no module named|can't import name) '?([\w.]+)'?/i)))
    return { ...base, title: `The library \`${m[1]}\` isn't in the project`, why: `${where} imports \`${m[1]}\`, but there's no ${m[1]}.py file for it.`, fix: `Add lib/${m[1]}.py (the driver for that part), or remove the import if you don't need it.` };
  if (type === 'SyntaxError' || type === 'IndentationError') {
    const hint = codeLine && /^(if|elif|else|for|while|def|class|try|except|with)\b/.test(codeLine) && !codeLine.endsWith(':') ? 'This line probably needs a colon (:) at the end.' : type === 'IndentationError' ? 'Lines inside an if/for/def must be indented by the same amount (4 spaces).' : 'Look for a missing bracket, quote or colon on this line or the one before.';
    return { ...base, title: `Python can't read ${where.toLowerCase()}`, why: codeLine ? `It's stuck on: ${codeLine}` : message, fix: hint };
  }
  if (type === 'AttributeError' && (m = message.match(/'(\w+)' object has no attribute '(\w+)'/)))
    return { ...base, title: `${where}: a ${m[1]} can't do \`.${m[2]}\``, why: `\`${m[2]}\` isn't something a ${m[1]} has.${codeLine ? ` (${codeLine})` : ''}`, fix: 'Check the spelling, and the part\'s library for the right method name.' };
  if (type === 'TypeError') return { ...base, title: `${where} passes the wrong kind of value`, why: message, fix: 'Check the number and type of the values you pass to the function on this line.' };
  if (type === 'ValueError') return { ...base, title: `${where} uses a value that's out of range`, why: message, fix: 'Check the numbers on this line (pin numbers, frequencies, sizes).' };
  if (type === 'ZeroDivisionError') return { ...base, title: `${where} divides by zero`, fix: 'Check the value you divide by before dividing.' };
  if (type === 'IndexError') return { ...base, title: `${where} reads past the end of a list`, why: message, fix: 'Check the index is smaller than the list length.' };
  if (type === 'KeyError') return { ...base, title: `${where} looks up a key that isn't there`, why: message };
  if (type === 'OSError' && /ENODEV|19|EIO|\b5\b|ETIMEDOUT|110/.test(message))
    return { ...base, area: 'running', title: `${where}: a part didn't answer`, why: 'The board sent a message to a part over I2C/SPI, but nothing answered (OSError).', fix: 'Check the part\'s SDA/SCL (or SPI) pins in your code match the wiring, and that its address is right.' };
  if (type === 'MemoryError') return { ...base, title: 'The board ran out of memory', fix: 'Use smaller buffers, or free memory with gc.collect().' };
  return { ...base, title: `${where} crashed (${type})`, why: message };
}

/** Find a Python traceback / skulpt error in a block of output lines. */
export function parseTraceback(lines: string[]): { type: string; message: string; line?: number; file?: string } | null {
  const sk = lines.map(l => l.match(/^Traceback: (\w+): (.*?)(?: on line (\d+))?$/)).find(Boolean);
  if (sk) return { type: sk[1], message: sk[2], line: sk[3] ? +sk[3] : undefined };
  let line: number | undefined, file: string | undefined;
  for (const l of lines) { const f = l.match(/File "([^"]+)", line (\d+)/); if (f) { line = +f[2]; file = f[1].replace(/^<stdin>$/, 'main.py').replace(/^.*\//, ''); } }
  const last = [...lines].reverse().find(l => /^\w+(Error|Exception|Interrupt)\b/.test(l));
  if (!last) return null;
  const [type, ...rest] = last.split(':');
  return { type: type.trim(), message: rest.join(':').trim(), line, file };
}

// ------------------------------------------------------------------ Arduino compiler errors
export function explainCompile(log: string, files: Record<string, string>): Explained[] {
  const out: Explained[] = [];
  for (const l of log.split('\n')) {
    const m = l.match(/([\w./-]+\.(?:ino|h|cpp|c)):(\d+):(?:\d+:)?\s*(?:fatal )?error:\s*(.*)$/);
    if (!m) continue;
    const file = m[1].replace(/^.*\//, ''), line = +m[2], e = m[3], at = { file, line, mode: 'elec' as const }, base = { level: 'broken' as Level, area: 'code' as Area, at, raw: l.trim() };
    let k: RegExpMatchArray | null;
    if ((k = e.match(/'(\w+)' was not declared in this scope/))) { const s = suggest(k[1], files); out.push({ ...base, title: `Line ${line} uses \`${k[1]}\`, which isn't defined`, fix: s ? `Did you mean \`${s}\`? Otherwise declare it before using it.` : 'Declare it (e.g. int x = 0;) or include the library that provides it.' }); }
    else if (/expected ';' before|expected ',' or ';'/.test(e)) out.push({ ...base, title: `A semicolon is missing near line ${line}`, why: 'Every C++ statement ends with ;', fix: `Add ; at the end of line ${line} (or the line before).` });
    else if ((k = e.match(/([\w./]+\.h): No such file or directory/))) out.push({ ...base, title: `The library ${k[1]} isn't installed`, fix: 'Install it (Library Manager), or check the spelling of the #include.' });
    else if (/expected '}'|expected declaration before '}'/.test(e)) out.push({ ...base, title: `The curly brackets { } don't match up near line ${line}`, fix: 'Every { needs a matching }. Check the function above.' });
    else if (/redefinition of/.test(e)) out.push({ ...base, title: `Something is defined twice (line ${line})`, why: e, fix: 'Rename or remove one of them.' });
    else out.push({ ...base, title: `Line ${line} won't compile`, why: e });
  }
  if (!out.length && /error/i.test(log)) out.push({ level: 'broken', area: 'code', title: 'The sketch didn\'t compile', why: log.split('\n').find(l => /error/i.test(l))?.trim(), raw: log });
  return out;
}

// ------------------------------------------------------------------ helpers
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // swapped letters
  }
  return d[a.length][b.length];
}
/** Closest identifier in the code (for "did you mean"). */
export function suggest(word: string, files: Record<string, string>) {
  const ids = new Set(Object.values(files).join('\n').match(/\b[A-Za-z_]\w*\b/g) ?? []); ids.delete(word);
  let best = '', bd = Math.max(1, Math.min(2, Math.floor(word.length / 3)));
  for (const id of ids) { if (Math.abs(id.length - word.length) > bd) continue; const d = lev(word.toLowerCase(), id.toLowerCase()); if (d <= bd && (!best || d < lev(word.toLowerCase(), best.toLowerCase()))) best = id; }
  return best || null;
}
