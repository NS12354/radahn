import type { Bench } from '../bench';
import type { Level, Runtime } from '../types';
import { MPY_LIBS } from '../templates';

declare const Sk: any;

/**
 * Behavioral Python runtime (Skulpt) for boards without a browser emulator
 * (ESP32, Raspberry Pi). Implements the MicroPython `machine` API and Pi
 * `gpiozero`/`smbus2`/`neopixel` on top of the same bench device models.
 * Interrupt handlers run at sleep boundaries with a snapshot of input levels
 * taken at the edge, so quadrature decoding behaves like the real ISR.
 */

let loading: Promise<void> | null = null;
export function loadSkulpt(base: string) {
  if (typeof window !== 'undefined' && (window as any).Sk) return Promise.resolve();
  if (!loading) loading = (async () => {
    for (const f of ['skulpt.min.js', 'skulpt-stdlib.js']) {
      await new Promise<void>((res, rej) => { const s = document.createElement('script'); s.src = base + 'vendor/' + f; s.onload = () => res(); s.onerror = () => rej(new Error('Failed to load ' + f)); document.head.appendChild(s); });
    }
  })();
  return loading;
}

// Python shims. Pure-Python libs from templates (rotary, sht4x) are reused as-is.
const SHIMS: Record<string, string> = {
  _sim: `listeners = []
_busy = [False]
def _service():
    if _busy[0]:
        return
    ev = _hw('events')
    if not ev:
        return
    _busy[0] = True
    try:
        for e in ev:
            _hw('snap', e[3])
            for l in listeners:
                l(e)
            _hw('snap', None)
    finally:
        _busy[0] = False
def _call(f, dev):
    try:
        f(dev)
    except TypeError:
        f()
`,
  micropython: `def const(x):
    return x
def native(f):
    return f
viper = native
def mem_info():
    pass
`,
  time: `from _sim import _service
def sleep(s):
    _sleep(s)
    _service()
def sleep_ms(ms):
    _sleep(ms / 1000)
    _service()
def sleep_us(us):
    _sleep(us / 1000000)
    _service()
def ticks_ms():
    return _hw('ticks')
def ticks_us():
    return _hw('ticks') * 1000
def ticks_diff(a, b):
    return a - b
def ticks_add(a, b):
    return a + b
def time():
    return 1767225600 + _hw('ticks') / 1000
def monotonic():
    return _hw('ticks') / 1000
def perf_counter():
    return _hw('ticks') / 1000
`,
  machine: `from _sim import listeners, _service
class Pin:
    IN = 0
    OUT = 1
    OPEN_DRAIN = 2
    PULL_UP = 1
    PULL_DOWN = 2
    IRQ_FALLING = 4
    IRQ_RISING = 8
    def __init__(self, id, mode=-1, pull=-1, value=None):
        self.id = id
        _hw('pin_mode', id, mode, -1 if pull is None else pull)
        if value is not None:
            self.value(value)
    def init(self, mode=-1, pull=-1, value=None):
        _hw('pin_mode', self.id, mode, -1 if pull is None else pull)
        if value is not None:
            self.value(value)
    def value(self, v=None):
        if v is None:
            return _hw('pin_read', self.id)
        _hw('pin_write', self.id, 1 if v else 0)
    def __call__(self, v=None):
        return self.value(v)
    def on(self):
        self.value(1)
    def off(self):
        self.value(0)
    def high(self):
        self.value(1)
    def low(self):
        self.value(0)
    def toggle(self):
        self.value(0 if _hw('pin_out', self.id) else 1)
    def irq(self, handler=None, trigger=12, hard=False):
        p = self
        if handler is None:
            return
        def l(e):
            if e[0] == 'pin' and e[1] == p.id:
                if (e[2] == 'fall' and trigger & 4) or (e[2] == 'rise' and trigger & 8):
                    handler(p)
        listeners.append(l)
    def __repr__(self):
        return 'Pin(%d)' % self.id
class PWM:
    def __init__(self, pin, freq=1000, duty_u16=None, duty=None, duty_ns=None):
        self.pin = pin if isinstance(pin, Pin) else Pin(pin)
        self._f = freq
        self._d = 0
        if duty is not None:
            self._d = int(duty * 65535 / 1023)
        if duty_u16 is not None:
            self._d = int(duty_u16)
        self._u()
    def _u(self):
        _hw('pwm', self.pin.id, self._f, self._d)
    def freq(self, f=None):
        if f is None:
            return self._f
        self._f = f
        self._u()
    def duty_u16(self, d=None):
        if d is None:
            return self._d
        self._d = int(d)
        self._u()
    def duty(self, d=None):
        if d is None:
            return self._d * 1023 // 65535
        self._d = int(d * 65535 / 1023)
        self._u()
    def duty_ns(self, ns=None):
        if ns is None:
            return int(self._d / 65535 * 1000000000 / self._f)
        self._d = int(ns * self._f / 1000000000 * 65535)
        self._u()
    def deinit(self):
        self._d = 0
        self._u()
class ADC:
    ATTN_0DB = 0
    ATTN_6DB = 2
    ATTN_11DB = 3
    WIDTH_12BIT = 3
    def __init__(self, pin, atten=None):
        self.id = pin.id if isinstance(pin, Pin) else pin
        _hw('adc_init', self.id)
    def read_u16(self):
        return _hw('adc', self.id)
    def read(self):
        return _hw('adc', self.id) >> 4
    def read_uv(self):
        return _hw('adc', self.id) * 3300000 // 65535
    def atten(self, a):
        pass
    def width(self, w):
        pass
class SPI:
    def __init__(self, id=1, baudrate=1000000, polarity=0, phase=0, bits=8, sck=None, mosi=None, miso=None):
        self.sck = sck.id if sck else -1
        self.mosi = mosi.id if mosi else -1
        _hw('spi', self.sck, self.mosi)
    def write(self, b):
        pass
    def deinit(self):
        pass
SoftSPI = SPI
class I2C:
    def __init__(self, id=0, scl=None, sda=None, freq=400000):
        self.sda = sda.id if sda else -1
        self.scl = scl.id if scl else -1
    def writeto(self, addr, buf, stop=True):
        _hw('i2c_w', self.sda, self.scl, addr, list(buf))
        return len(buf)
    def readfrom(self, addr, n, stop=True):
        r = _hw('i2c_r', self.sda, self.scl, addr, n)
        if r is None:
            raise OSError(19)
        return r
    def scan(self):
        return _hw('i2c_scan', self.sda, self.scl)
SoftI2C = I2C
def freq(f=None):
    return 240000000
def reset():
    _hw('reset')
def idle():
    _sleep(0.001)
    _service()
`,
  neopixel: `class NeoPixel:
    def __init__(self, pin, n, bpp=3, timing=1, brightness=1.0, auto_write=None, pixel_order=None):
        self.pin = pin.id if hasattr(pin, 'id') else pin
        self.n = n
        self.buf = [(0, 0, 0)] * n
        self.brightness = brightness
        if auto_write is None:
            auto_write = hasattr(pin, '_board')
        self.auto_write = auto_write
        _hw('np_init', self.pin, n)
    def _c(self, c):
        if isinstance(c, int):
            return ((c >> 16) & 255, (c >> 8) & 255, c & 255)
        return (int(c[0]), int(c[1]), int(c[2]))
    def __len__(self):
        return self.n
    def __setitem__(self, i, c):
        self.buf[i] = self._c(c)
        if self.auto_write:
            self.write()
    def __getitem__(self, i):
        return self.buf[i]
    def fill(self, c):
        self.buf = [self._c(c)] * self.n
        if self.auto_write:
            self.write()
    def write(self):
        b = self.brightness
        flat = []
        for c in self.buf:
            flat.append(int(c[0] * b))
            flat.append(int(c[1] * b))
            flat.append(int(c[2] * b))
        _hw('np_write', self.pin, flat)
    def show(self):
        self.write()
    def deinit(self):
        self.fill((0, 0, 0))
        self.write()
`,
  gc9a01: `# Behavioral stand-in for lib/gc9a01.py (same API, draws directly).
BLACK = 0x0000
BLUE = 0x001F
RED = 0xF800
GREEN = 0x07E0
CYAN = 0x07FF
MAGENTA = 0xF81F
YELLOW = 0xFFE0
WHITE = 0xFFFF
def color565(r, g=None, b=None):
    if g is None:
        r, g, b = r
    return ((int(r) & 0xF8) << 8) | ((int(g) & 0xFC) << 3) | (int(b) >> 3)
class GC9A01:
    def __init__(self, spi, width=240, height=240, reset=None, dc=None, cs=None, backlight=None, rotation=0, buffer_size=0):
        self.width = width
        self.height = height
        _hw('tft_init', spi.sck, spi.mosi, dc.id if dc else -1, cs.id if cs else -1)
    def init(self):
        _hw('tft', 'fill', [0])
    def fill(self, c):
        _hw('tft', 'fill', [c])
    def fill_rect(self, x, y, w, h, c):
        _hw('tft', 'rect', [x, y, w, h, c])
    def hline(self, x, y, w, c):
        _hw('tft', 'rect', [x, y, w, 1, c])
    def vline(self, x, y, h, c):
        _hw('tft', 'rect', [x, y, 1, h, c])
    def pixel(self, x, y, c):
        _hw('tft', 'rect', [x, y, 1, 1, c])
    def rect(self, x, y, w, h, c):
        self.hline(x, y, w, c)
        self.hline(x, y + h - 1, w, c)
        self.vline(x, y, h, c)
        self.vline(x + w - 1, y, h, c)
    def text(self, font, s, x, y, fg=0xFFFF, bg=0x0000):
        _hw('tft', 'text', [str(s), x, y, font.WIDTH, font.HEIGHT, fg, bg])
    def on(self):
        pass
    def off(self):
        pass
`,
  board: 'class _P:\n    def __init__(self, n):\n        self.id = n\n        self._board = True\n    def __repr__(self):\n        return "board.D%d" % self.id\n' + Array.from({ length: 28 }, (_, i) => `D${i} = _P(${i})`).join('\n') + '\nSCK = D11\nMOSI = D10\nMISO = D9\nSDA = D2\nSCL = D3\n',
  smbus2: `class i2c_msg:
    def __init__(self, addr, flags, data):
        self.addr = addr
        self.flags = flags
        self.buf = data
        self.len = len(data)
    @staticmethod
    def write(addr, data):
        return i2c_msg(addr, 0, list(data))
    @staticmethod
    def read(addr, n):
        return i2c_msg(addr, 1, [0] * n)
    def __iter__(self):
        return iter(self.buf)
    def __len__(self):
        return len(self.buf)
class SMBus:
    def __init__(self, bus=1):
        self.sda = 2
        self.scl = 3
    def i2c_rdwr(self, *msgs):
        for m in msgs:
            if m.flags == 1:
                r = _hw('i2c_r', self.sda, self.scl, m.addr, len(m.buf))
                if r is None:
                    raise OSError(121, 'Remote I/O error')
                m.buf = list(r)
            else:
                _hw('i2c_w', self.sda, self.scl, m.addr, m.buf)
    def write_byte(self, addr, v):
        _hw('i2c_w', self.sda, self.scl, addr, [v])
    def read_byte(self, addr):
        return _hw('i2c_r', self.sda, self.scl, addr, 1)[0]
    def close(self):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *a):
        pass
`,
  ff: `# Mirror helper is a no-op in the behavioral sim (the bench already drives the 3D model).
def leds(pixels):
    pass
def screen(*lines):
    pass
def haptic(on):
    pass
def events():
    return []
`,
  signal: `def pause():
    import time
    while True:
        time.sleep(0.05)
`,
  gpiozero: `from _sim import listeners, _call
def _pin(p):
    if isinstance(p, int):
        return p
    if hasattr(p, 'id'):
        return p.id
    return int(str(p).upper().replace('GPIO', '').replace('BCM', ''))
class OutputDevice:
    def __init__(self, pin, active_high=True, initial_value=False, **k):
        self.pin = _pin(pin)
        self.active_high = active_high
        self._v = 0
        _hw('pin_mode', self.pin, 1, -1)
        self._set(1 if initial_value else 0)
    def _set(self, v):
        self._v = 1 if v else 0
        _hw('pin_write', self.pin, self._v if self.active_high else 1 - self._v)
    def on(self):
        self._set(1)
    def off(self):
        self._set(0)
    def toggle(self):
        self._set(0 if self._v else 1)
    @property
    def value(self):
        return self._v
    @value.setter
    def value(self, v):
        self._set(v)
    @property
    def is_active(self):
        return bool(self._v)
    def close(self):
        self.off()
DigitalOutputDevice = OutputDevice
class LED(OutputDevice):
    @property
    def is_lit(self):
        return bool(self._v)
class Buzzer(OutputDevice):
    pass
class PWMOutputDevice:
    def __init__(self, pin, active_high=True, initial_value=0, frequency=100, **k):
        self.pin = _pin(pin)
        self.frequency = frequency
        self._v = 0
        self._set(initial_value)
    def _set(self, v):
        self._v = max(0, min(1, v))
        _hw('pwm', self.pin, self.frequency, int(self._v * 65535))
    def on(self):
        self._set(1)
    def off(self):
        self._set(0)
    @property
    def value(self):
        return self._v
    @value.setter
    def value(self, v):
        self._set(v)
PWMLED = PWMOutputDevice
class TonalBuzzer:
    def __init__(self, pin, **k):
        self.pin = _pin(pin)
    def play(self, tone):
        _hw('pwm', self.pin, tone if isinstance(tone, (int, float)) else 440, 32768)
    def stop(self):
        _hw('pwm', self.pin, 440, 0)
class Servo:
    def __init__(self, pin, initial_value=0, min_pulse_width=0.001, max_pulse_width=0.002, **k):
        self.pin = _pin(pin)
        self._lo = min_pulse_width
        self._hi = max_pulse_width
        self._v = 0
        self._set(initial_value)
    def _set(self, v):
        self._v = max(-1, min(1, v))
        pulse = self._lo + (self._v + 1) / 2 * (self._hi - self._lo)
        _hw('pwm', self.pin, 50, int(pulse / 0.02 * 65535))
    @property
    def value(self):
        return self._v
    @value.setter
    def value(self, v):
        self._set(v)
    def min(self):
        self._set(-1)
    def mid(self):
        self._set(0)
    def max(self):
        self._set(1)
class Button:
    def __init__(self, pin, pull_up=True, bounce_time=None, hold_time=1, **k):
        self.pin = _pin(pin)
        self.pull_up = pull_up
        self.when_pressed = None
        self.when_released = None
        _hw('pin_mode', self.pin, 0, 1 if pull_up else 2)
        b = self
        def l(e):
            if e[0] == 'pin' and e[1] == b.pin:
                pressed = (e[2] == 'fall') == b.pull_up
                f = b.when_pressed if pressed else b.when_released
                if f:
                    _call(f, b)
        listeners.append(l)
    @property
    def is_pressed(self):
        v = _hw('pin_read', self.pin)
        return v == 0 if self.pull_up else v == 1
    @property
    def value(self):
        return 1 if self.is_pressed else 0
    def wait_for_press(self, timeout=None):
        import time
        while not self.is_pressed:
            time.sleep(0.01)
    def wait_for_release(self, timeout=None):
        import time
        while self.is_pressed:
            time.sleep(0.01)
class RotaryEncoder:
    def __init__(self, a, b, bounce_time=None, max_steps=16, threshold_steps=(0, 0), wrap=False, **k):
        self.a = _pin(a)
        self.b = _pin(b)
        self.max_steps = max_steps
        self.wrap = wrap
        self._s = 0
        self.when_rotated = None
        self.when_rotated_clockwise = None
        self.when_rotated_counter_clockwise = None
        _hw('pin_mode', self.a, 0, 1)
        _hw('pin_mode', self.b, 0, 1)
        r = self
        def l(e):
            if e[0] == 'pin' and e[1] == r.a and e[2] == 'fall':
                d = 1 if _hw('pin_read', r.b) else -1
                r._s += d
                m = r.max_steps
                if m:
                    if r.wrap:
                        if r._s > m:
                            r._s = -m
                        elif r._s < -m:
                            r._s = m
                    else:
                        r._s = max(-m, min(m, r._s))
                f = r.when_rotated_clockwise if d > 0 else r.when_rotated_counter_clockwise
                if f:
                    _call(f, r)
                if r.when_rotated:
                    _call(r.when_rotated, r)
        listeners.append(l)
    @property
    def steps(self):
        return self._s
    @steps.setter
    def steps(self, v):
        self._s = v
`,
};
for (const [n, w, h] of [['vga1_8x16', 8, 16], ['vga1_16x32', 16, 32], ['vga1_bold_16x32', 16, 32], ['vga2_8x16', 8, 16]] as const) SHIMS[n] = `WIDTH = ${w}\nHEIGHT = ${h}\n`;

export class SimPythonRuntime implements Runtime {
  readonly kind = 'sim-python' as const;
  running = false;
  onSerial: (t: string) => void = () => {};
  onStatus: (s: string) => void = () => {};
  onExit: (err: string) => void = () => {};
  private t0 = 0;
  private stop_ = false;
  private runId = 0;
  private sleeps = new Set<{ t: any; res: () => void }>();
  private out = new Map<number, Level>();
  private mode = new Map<number, number>();
  private pull = new Map<number, number>();
  private inputs = new Map<number, Level>();
  private events: any[] = [];
  private snap: Record<number, Level> | null = null;
  private warned = new Set<string>();
  private tftOk = false;
  private spiPins: { sck: number; mosi: number } | null = null;
  private lastI2C = new Map<number, number>();

  constructor(private bench: Bench, private base = './') {}

  private warn(key: string, msg: string) { if (!this.warned.has(key)) { this.warned.add(key); this.onSerial(`\r\n[sim] ${msg}\r\n`); } }
  private label(g: number) { return this.bench.label(g); }
  private wired(g: number, what: string) {
    if (!this.bench.board.gpio.includes(g)) { this.warn('nx' + g, `${this.label(g)} isn't a usable pin on ${this.bench.board.name}.`); return false; }
    if (!this.bench.pinMap.get(g)) { this.warn('nc' + g, `${this.label(g)} (${what}) isn't connected to any component.`); return false; }
    return true;
  }
  private at(g: number, type: string) { return this.bench.pinMap.get(g)?.find(u => u.c.type === type); }

  private hw(cmd: string, a: any[]): any {
    if (this.stop_) throw new Error('__stop__');
    const b = this.bench;
    switch (cmd) {
      case 'ticks': return Math.round(performance.now() - this.t0);
      case 'events': { const e = this.events; this.events = []; return e; }
      case 'snap': this.snap = a[0]; return null;
      case 'pin_mode': this.mode.set(a[0], a[1]); this.pull.set(a[0], a[2]); this.wired(a[0], a[1] === 1 ? 'output' : 'input'); return null;
      case 'pin_write': {
        const g = a[0]; this.wired(g, 'output');
        if (this.mode.get(g) === 0) this.warn('in' + g, `Writing to ${this.label(g)}, but it's configured as an input. Use Pin.OUT.`);
        this.out.set(g, a[1]); b.pin(g, a[1], this.now());
        if (a[1] && this.at(g, 'buzzer')) this.warn('pz' + g, `Passive piezo on ${this.label(g)} only clicks with a steady HIGH. Drive it with PWM for a tone.`);
        return null;
      }
      case 'pin_out': return this.out.get(a[0]) ?? 0;
      case 'pin_read': {
        const g = a[0];
        if (this.snap && g in this.snap) return this.snap[g];
        const btn = this.at(g, 'button');
        if (btn) {
          const pull = this.pull.get(g), lvl = this.inputs.get(g) ?? 1;
          if (pull === 2) { this.warn('pd' + g, `Button on ${this.label(g)} connects to GND, so PULL_DOWN makes it always read 0. Use PULL_UP.`); return 0; }
          if (pull !== 1 && b.board.lang === 'micropython' && lvl === 1) { this.warn('fl' + g, `${this.label(g)} has no pull resistor, so the input floats when released. Add Pin.PULL_UP.`); return Math.random() < 0.5 ? 0 : 1; }
          return lvl;
        }
        if (this.inputs.has(g)) return this.inputs.get(g);
        return this.out.get(g) ?? 0;
      }
      case 'pwm': {
        const [g, f, d] = a; this.wired(g, 'PWM');
        for (const u of b.pinMap.get(g) ?? []) b.model(u.c.uid)?.sim?.pwm?.(f, d / 65535);
        const servo = this.at(g, 'servo');
        if (servo && (f < 40 || f > 60)) this.warn('sf' + g, `Servo on ${this.label(g)} expects 50 Hz PWM, got ${f} Hz.`);
        if (servo && b.board.family === 'pi' && !b.board.hwPwm?.includes(g)) this.warn('sp' + g, `Software PWM on ${this.label(g)} will make the servo jitter. Hardware PWM: 12, 13, 18, 19.`);
        return null;
      }
      case 'adc_init': {
        const g = a[0], bd = b.board;
        if (!bd.adc.length) this.warn('noadc', `${bd.name} has no analog inputs. Add an external ADC (e.g. MCP3008).`);
        else if (bd.adc2?.includes(g)) this.warn('adc2' + g, `${this.label(g)} is ADC2, which fails while Wi-Fi is on.`);
        else if (!bd.adc.includes(g)) this.warn('na' + g, `${this.label(g)} isn't an ADC pin.`);
        return null;
      }
      case 'adc': return Math.round(Math.max(0, Math.min(1, b.adc(a[0]) / 3.3)) * 65535);
      case 'i2c_w': case 'i2c_r': case 'i2c_scan': {
        const [sda, scl] = a;
        if (cmd === 'i2c_scan') { const found: number[] = []; for (const s of b.slots.values()) if (s.model.i2c && s.c.pins.SDA === sda && s.c.pins.SCL === scl) found.push(s.model.i2c.address); return found; }
        const t = b.i2c(sda, scl, a[2]);
        if (!t) return null;
        if (cmd === 'i2c_w') { t.start?.(false); for (const v of a[3]) t.write(v); t.stop?.(); return null; }
        t.start?.(true); const r: number[] = []; for (let i = 0; i < a[3]; i++) r.push(t.read()); t.stop?.(); return r;
      }
      case 'np_init': {
        if (!this.at(a[0], 'neopixel')) { this.wired(a[0], 'NeoPixel data'); this.warn('npx', `NeoPixel data pin ${this.label(a[0])} isn't wired to the ring.`); }
        else if (a[1] !== 24) this.warn('npn', `The ring has 24 LEDs, but the code declares ${a[1]}.`);
        return null;
      }
      case 'np_write': { const u = this.at(a[0], 'neopixel'); if (u) b.model(u.c.uid)?.sim?.write(a[1]); return null; }
      case 'spi': this.spiPins = { sck: a[0], mosi: a[1] }; return null;
      case 'tft_init': {
        const t = [...b.slots.values()].find(s => s.c.type === 'tft');
        this.tftOk = false;
        if (!t) { this.warn('tftx', 'No display is wired up.'); return null; }
        const bad: string[] = [];
        if (a[0] !== t.c.pins.SCK) bad.push('SCK');
        if (a[1] !== t.c.pins.MOSI) bad.push('MOSI');
        if (a[2] !== t.c.pins.DC) bad.push('DC');
        if (a[3] !== t.c.pins.CS) bad.push('CS');
        if (bad.length) this.warn('tftp', 'Display not responding. Check the ' + bad.join(', ') + ' wiring against your code.');
        else this.tftOk = true;
        return null;
      }
      case 'tft': { if (!this.tftOk) return null; const t = [...b.slots.values()].find(s => s.c.type === 'tft'); t?.model.sim?.op(a[0], a[1]); return null; }
      case 'reset': throw new Error('__stop__');
    }
    return null;
  }

  async start(files: Record<string, string>) {
    await this.stop();
    await loadSkulpt(this.base);
    const id = ++this.runId;
    this.stop_ = false; this.running = true; this.t0 = performance.now();
    this.out.clear(); this.mode.clear(); this.pull.clear(); this.events = []; this.snap = null; this.warned.clear(); this.tftOk = false;
    for (const [g, l] of this.bench.inputs) this.inputs.set(g, l);
    this.bench.attach(this);

    const self = this;
    Sk.builtins._hw = new Sk.builtin.func(function (...args: any[]) {
      const js = args.map(x => Sk.ffi.remapToJs(x));
      const r = self.hw(js[0], js.slice(1));
      return r == null ? Sk.builtin.none.none$ : Sk.ffi.remapToPy(r);
    });
    Sk.builtins._sleep = new Sk.builtin.func(function (s: any) {
      if (self.stop_) throw new Error('__stop__');
      const ms = Math.max(0, Sk.ffi.remapToJs(s) * 1000);
      return Sk.misceval.promiseToSuspension(new Promise<any>(res => {
        const o = { t: 0 as any, res: () => res(Sk.builtin.none.none$) };
        o.t = setTimeout(() => { self.sleeps.delete(o); o.res(); }, ms);
        self.sleeps.add(o);
      }));
    });

    // Module resolution: shims first, then project files (lib/*.py), then Skulpt stdlib.
    const userMods: Record<string, string> = {};
    for (const [p, src] of Object.entries({ ...MPY_LIBS, ...files })) if (p.endsWith('.py')) userMods[p.split('/').pop()!.replace(/\.py$/, '')] = src;
    const mainKey = Object.keys(files).find(f => /(^|\/)main\.py$/.test(f)) ?? Object.keys(files)[0];
    const resolve = (name: string) => SHIMS[name] ?? (name !== 'main' ? userMods[name] : undefined);
    Sk.sysmodules = new Sk.builtin.dict([]);
    Sk.configure({
      output: (t: string) => { if (this.runId === id) this.onSerial(t.replace(/\n/g, '\r\n')); },
      __future__: Sk.python3, yieldLimit: 40, execLimit: null,
      read: (f: string) => {
        const m = f.match(/^src\/lib\/(\w+)\.(py|js)$/);
        if (m && resolve(m[1]) != null) { if (m[2] === 'py') return resolve(m[1]); throw 'File not found'; }
        if (/^src\/lib\/(\w+)\/__init__\.(py|js)$/.test(f) && resolve(f.split('/')[2]) != null) throw 'File not found';
        if (Sk.builtinFiles?.files[f] !== undefined) return Sk.builtinFiles.files[f];
        throw 'File not found: ' + f;
      },
    });
    this.onStatus('running ' + mainKey);
    Sk.misceval.asyncToPromise(() => Sk.importMainWithBody('<stdin>', false, files[mainKey], true), {
      '*': () => { if (this.stop_ || this.runId !== id) throw new Error('__stop__'); },
    }).then(() => { if (this.runId === id) { this.running = false; this.onStatus('program finished'); this.onExit(''); } })
      .catch((e: any) => {
        if (this.runId !== id) return;
        this.running = false;
        const msg = String(e?.toString?.() ?? e);
        if (msg.includes('__stop__')) { this.onStatus('stopped'); return; }
        this.onSerial('\r\nTraceback: ' + msg + '\r\n');
        this.onStatus('program crashed'); this.onExit(msg);
      });
  }

  stop() {
    this.stop_ = true; this.runId++; this.running = false;
    this.sleeps.forEach(o => { clearTimeout(o.t); o.res(); }); this.sleeps.clear();
    if (this.bench.runtime === this) this.bench.attach(null);
  }

  setInput(g: number, level: Level) {
    const prev = this.inputs.get(g) ?? 1;
    this.inputs.set(g, level);
    if (prev !== level && this.running) {
      const snap: Record<number, Level> = {};
      for (const [k, v] of this.inputs) snap[k] = v;
      this.events.push(['pin', g, level ? 'rise' : 'fall', snap]);
    }
  }
  readOutput(g: number): Level { return this.out.get(g) ?? 1; }
  schedule(ns: number, fn: () => void) { setTimeout(fn, ns / 1e6); }
  now() { return (performance.now() - this.t0) * 1e6; }
  sendSerial() { /* no REPL in behavioral mode */ }
  speed() { return 1; }
}
