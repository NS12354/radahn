/**
 * Small code editor for the device IDEs: a transparent textarea over a
 * syntax-highlighted <pre>, with a line-number gutter, auto-indent, Tab
 * indentation and a cursor-position callback. Colours come from CSS classes
 * (.k keyword, .s string, .c comment, .n number, .f function, .p preprocessor,
 * .b builtin) so each IDE skin can theme it.
 */
export type Lang = 'python' | 'cpp' | 'text';
const PY_K = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const PY_B = new Set('print range len int float str bool list dict set tuple abs min max sum round open input enumerate zip map filter sorted isinstance super self'.split(' '));
const C_K = new Set('if else for while do switch case default break continue return void int long short char float double bool byte boolean unsigned signed const static volatile struct class public private protected new delete true false nullptr NULL uint8_t uint16_t uint32_t int8_t int16_t int32_t size_t String auto sizeof typedef enum'.split(' '));
const C_B = new Set('setup loop pinMode digitalWrite digitalRead analogRead analogWrite delay delayMicroseconds millis micros Serial begin print println available read write tone noTone map constrain attachInterrupt digitalPinToInterrupt HIGH LOW INPUT OUTPUT INPUT_PULLUP LED_BUILTIN Wire SPI'.split(' '));

const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
export function highlight(src: string, lang: Lang): string {
  if (lang === 'text') return esc(src);
  const py = lang === 'python';
  const re = py
    ? /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[0-9a-f]+\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/gi
    : /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b\d+(?:\.\d+)?[uUlLfF]*\b|\b0x[0-9a-fA-F]+\b)|([A-Za-z_]\w*)(?=\s*\()|(^[ \t]*#\s*\w+[^\n]*|[A-Za-z_]\w*)/gm;
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index)); last = re.lastIndex;
    const [t, com, str, num, fn, word] = m;
    if (com) out += `<span class="c">${esc(com)}</span>`;
    else if (str) out += `<span class="s">${esc(str)}</span>`;
    else if (num) out += `<span class="n">${esc(num)}</span>`;
    else if (fn) out += `<span class="${(py ? PY_K : C_K).has(fn) ? 'k' : (py ? PY_B : C_B).has(fn) ? 'b' : 'f'}">${esc(fn)}</span>`;
    else if (word) {
      if (!py && /^\s*#/.test(word)) out += `<span class="p">${esc(word)}</span>`;
      else out += (py ? PY_K : C_K).has(word) ? `<span class="k">${esc(word)}</span>` : (py ? PY_B : C_B).has(word) ? `<span class="b">${esc(word)}</span>` : esc(word);
    } else out += esc(t);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out + esc(src.slice(last)) + '\n';
}

export const langOf = (name: string): Lang => (/\.py$/.test(name) ? 'python' : /\.(ino|c|cpp|h|hpp)$/.test(name) ? 'cpp' : 'text');

export class CodeEditor {
  el: HTMLElement;
  ta: HTMLTextAreaElement;
  private pre: HTMLPreElement;
  private gut: HTMLPreElement;
  lang: Lang = 'python';
  indent = '    ';
  onChange: (v: string) => void = () => {};
  onCursor: (line: number, col: number) => void = () => {};
  onKey: (e: KeyboardEvent) => boolean = () => false;
  constructor(cls = '') {
    this.el = document.createElement('div'); this.el.className = 'ced ' + cls;
    this.el.innerHTML = '<pre class="gut"></pre><div class="cwrap"><pre class="hl"></pre><textarea spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea></div>';
    this.gut = this.el.querySelector('.gut')!; this.pre = this.el.querySelector('.hl')!; this.ta = this.el.querySelector('textarea')!;
    this.ta.oninput = () => { this.paint(); this.onChange(this.ta.value); this.cursor(); };
    this.ta.onscroll = () => { this.pre.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`; this.gut.scrollTop = this.ta.scrollTop; };
    this.ta.onkeyup = this.ta.onclick = () => this.cursor();
    this.ta.onkeydown = e => this.key(e);
  }
  get value() { return this.ta.value; }
  set(v: string, lang: Lang) {
    this.lang = lang; this.indent = lang === 'cpp' ? '  ' : '    ';
    this.ta.value = v; this.ta.scrollTop = 0; this.ta.selectionStart = this.ta.selectionEnd = 0; this.paint(); this.cursor();
  }
  focus() { this.ta.focus(); }
  private paint() {
    this.pre.innerHTML = highlight(this.ta.value, this.lang);
    const n = this.ta.value.split('\n').length;
    this.gut.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n') + '\n';
  }
  private cursor() { const before = this.ta.value.slice(0, this.ta.selectionStart).split('\n'); this.onCursor(before.length, before[before.length - 1].length + 1); }
  private insert(t: string) { this.ta.setRangeText(t, this.ta.selectionStart, this.ta.selectionEnd, 'end'); this.ta.dispatchEvent(new Event('input')); }
  private key(e: KeyboardEvent) {
    if (this.onKey(e)) { e.preventDefault(); return; }
    const ta = this.ta, v = ta.value, s = ta.selectionStart;
    if (e.key === 'Tab') {
      e.preventDefault();
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      if (e.shiftKey) { if (v.startsWith(this.indent, ls)) { ta.setRangeText('', ls, ls + this.indent.length, 'preserve'); ta.dispatchEvent(new Event('input')); } }
      else this.insert(this.indent);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const ls = v.lastIndexOf('\n', s - 1) + 1, line = v.slice(ls, s), lead = line.match(/^[ \t]*/)![0];
      const more = this.lang === 'python' ? /:\s*(#.*)?$/.test(line) : /[{(]\s*$/.test(line);
      this.insert('\n' + lead + (more ? this.indent : ''));
    } else if (e.key === '}' && this.lang === 'cpp') {
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      if (/^[ \t]+$/.test(v.slice(ls, s)) && v.slice(ls, s).length >= this.indent.length) { e.preventDefault(); ta.setRangeText('}', s - this.indent.length, s, 'end'); ta.dispatchEvent(new Event('input')); }
    }
  }
}
