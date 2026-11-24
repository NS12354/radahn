/**
 * Code that comes with the parts catalog:
 *  - PART_LIBS: small MicroPython drivers (lib/*.py) for parts that need one.
 *    They're plain MicroPython, so they run on the emulated RP2040, in the
 *    behavioral sim and on a real board.
 *  - demoFiles(): a starter program that shows every wired part working, in
 *    the board's language (MicroPython, Python 3 + gpiozero, Arduino C++).
 */
import type { BoardDef, CompInstance } from './types';
import { COMPONENTS } from './library/components';
import { pinLabel } from './library/boards';
import { MPY_LIBS } from './templates';

export const PART_LIBS: Record<string, Record<string, string>> = {
  oled: {
    'lib/ssd1306.py': `"""SSD1306 OLED over I2C. Same API as micropython-lib's ssd1306:
oled = SSD1306_I2C(128, 64, i2c); oled.text('hi', 0, 0); oled.show()
Drawing (text, pixel, line, rect, fill_rect, fill, scroll) comes from framebuf."""
import framebuf

class SSD1306_I2C(framebuf.FrameBuffer):
    def __init__(self, width, height, i2c, addr=0x3C, external_vcc=False):
        self.i2c = i2c
        self.addr = addr
        self.width = width
        self.height = height
        self.pages = height // 8
        self.buffer = bytearray(self.pages * width)
        super().__init__(self.buffer, width, height, framebuf.MONO_VLSB)
        self.init_display()

    def write_cmd(self, c):
        self.i2c.writeto(self.addr, bytearray([0x80, c]))

    def init_display(self):
        for c in (0xAE, 0x20, 0x00, 0x40, 0xA1, 0xA8, self.height - 1, 0xC8, 0xD3, 0x00,
                  0xDA, 0x02 if self.height == 32 else 0x12, 0xD5, 0x80, 0xD9, 0xF1, 0xDB, 0x30,
                  0x81, 0xFF, 0xA4, 0xA6, 0x8D, 0x14, 0xAF):
            self.write_cmd(c)
        self.fill(0)
        self.show()

    def poweroff(self):
        self.write_cmd(0xAE)

    def poweron(self):
        self.write_cmd(0xAF)

    def contrast(self, v):
        self.write_cmd(0x81)
        self.write_cmd(v)

    def invert(self, on):
        self.write_cmd(0xA7 if on else 0xA6)

    def show(self):
        for c in (0x21, 0, self.width - 1, 0x22, 0, self.pages - 1):
            self.write_cmd(c)
        self.i2c.writevto(self.addr, (b'\\x40', self.buffer))
`,
  },
  lcd1602: {
    'lib/i2c_lcd.py': `"""HD44780 character LCD on a PCF8574 I2C backpack (the common blue 16x2 / 20x4).
lcd = I2cLcd(i2c, 0x27, 2, 16); lcd.putstr('Hello'); lcd.move_to(0, 1)
Same method names as dhylands' python_lcd."""
import time

class I2cLcd:
    def __init__(self, i2c, i2c_addr=0x27, num_lines=2, num_columns=16):
        self.i2c = i2c
        self.addr = i2c_addr
        self.num_lines = num_lines
        self.num_columns = num_columns
        self.bl = 0x08
        self.x = 0
        self.y = 0
        self.i2c.writeto(self.addr, bytearray([0]))
        time.sleep_ms(20)
        for _ in range(3):
            self._nibble(0x30)
            time.sleep_ms(5)
        self._nibble(0x20)
        time.sleep_ms(1)
        self.cmd(0x28 if num_lines > 1 else 0x20)
        self.cmd(0x08)
        self.clear()
        self.cmd(0x06)
        self.cmd(0x0C)

    def _nibble(self, v, rs=0):
        b = (v & 0xF0) | self.bl | rs
        self.i2c.writeto(self.addr, bytearray([b | 0x04, b]))

    def cmd(self, c):
        self._nibble(c)
        self._nibble(c << 4)
        if c <= 3:
            time.sleep_ms(2)

    def data(self, d):
        self._nibble(d, 1)
        self._nibble(d << 4, 1)

    def clear(self):
        self.cmd(0x01)
        self.x = 0
        self.y = 0

    def move_to(self, x, y):
        self.x = x
        self.y = y
        a = x + (0x40 if y & 1 else 0) + (self.num_columns if y & 2 else 0)
        self.cmd(0x80 | a)

    def putchar(self, ch):
        if ch == '\\n':
            self.move_to(0, (self.y + 1) % self.num_lines)
            return
        self.data(ord(ch))
        self.x += 1
        if self.x >= self.num_columns:
            self.move_to(0, (self.y + 1) % self.num_lines)

    def putstr(self, s):
        for ch in s:
            self.putchar(ch)

    def backlight_on(self):
        self.bl = 0x08
        self.i2c.writeto(self.addr, bytearray([self.bl]))

    def backlight_off(self):
        self.bl = 0
        self.i2c.writeto(self.addr, bytearray([0]))

    def display_on(self):
        self.cmd(0x0C)

    def display_off(self):
        self.cmd(0x08)

    def show_cursor(self):
        self.cmd(0x0E)

    def hide_cursor(self):
        self.cmd(0x0C)

    def blink_cursor_on(self):
        self.cmd(0x0F)

    def blink_cursor_off(self):
        self.cmd(0x0E)

    def custom_char(self, location, charmap):
        self.cmd(0x40 | ((location & 7) << 3))
        for b in charmap:
            self.data(b)
        self.move_to(self.x, self.y)
`,
  },
  tm1637: {
    'lib/tm1637.py': `"""TM1637 4-digit 7-segment display. API follows mcauser's micropython-tm1637:
tm = TM1637(clk=Pin(2), dio=Pin(3)); tm.show('12 3'); tm.number(-42); tm.numbers(12, 59)"""
from machine import Pin
from time import sleep_us

_SEG = [0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71,
        0x3D, 0x76, 0x06, 0x1E, 0x76, 0x38, 0x55, 0x54, 0x3F, 0x73, 0x67, 0x50, 0x6D, 0x78, 0x3E, 0x1C,
        0x2A, 0x76, 0x6E, 0x5B, 0x00, 0x40, 0x63]

class TM1637:
    def __init__(self, clk, dio, brightness=7):
        self.clk = clk
        self.dio = dio
        self._b = brightness & 7
        self.clk.init(Pin.OUT, value=1)
        self.dio.init(Pin.OUT, value=1)
        sleep_us(10)
        self._data_cmd()
        self._dsp_ctrl()

    def _start(self):
        self.dio(0)
        sleep_us(10)
        self.clk(0)
        sleep_us(10)

    def _stop(self):
        self.dio(0)
        sleep_us(10)
        self.clk(1)
        sleep_us(10)
        self.dio(1)

    def _byte(self, b):
        for i in range(8):
            self.dio((b >> i) & 1)
            sleep_us(10)
            self.clk(1)
            sleep_us(10)
            self.clk(0)
            sleep_us(10)
        self.dio(0)
        self.clk(1)
        sleep_us(10)
        self.clk(0)
        sleep_us(10)

    def _data_cmd(self):
        self._start()
        self._byte(0x40)
        self._stop()

    def _dsp_ctrl(self):
        self._start()
        self._byte(0x88 | self._b)
        self._stop()

    def brightness(self, val=None):
        if val is None:
            return self._b
        self._b = val & 7
        self._data_cmd()
        self._dsp_ctrl()

    def write(self, segments, pos=0):
        self._data_cmd()
        self._start()
        self._byte(0xC0 | pos)
        for s in segments:
            self._byte(s)
        self._stop()
        self._dsp_ctrl()

    def encode_char(self, c):
        o = ord(c)
        if o == 32:
            return 0
        if o == 42:
            return 0x63
        if o == 45:
            return 0x40
        if 65 <= o <= 90:
            return _SEG[o - 55]
        if 97 <= o <= 122:
            return _SEG[o - 87]
        if 48 <= o <= 57:
            return _SEG[o - 48]
        return 0

    def encode_string(self, s):
        return [self.encode_char(c) for c in s]

    def show(self, s, colon=False):
        segs = self.encode_string((s + '    ')[:4])
        if colon:
            segs[1] |= 0x80
        self.write(segs)

    def number(self, num):
        num = max(-999, min(9999, int(num)))
        self.show('%4d' % num)

    def numbers(self, a, b, colon=True):
        self.show('%02d%02d' % (a % 100, b % 100), colon)

    def hex(self, val):
        self.show('%04x' % (val & 0xFFFF))

    def temperature(self, t):
        if t < -9 or t > 99:
            self.show(' Err')
        else:
            self.write(self.encode_string('%2d' % t) + [0x63, 0x39])
`,
  },
  hcsr04: {
    'lib/hcsr04.py': `"""HC-SR04 ultrasonic distance: d = HCSR04(trigger_pin=5, echo_pin=6); d.distance_cm()"""
from machine import Pin, time_pulse_us
import time

class HCSR04:
    def __init__(self, trigger_pin, echo_pin, echo_timeout_us=30000):
        self.trigger = Pin(trigger_pin, Pin.OUT, value=0)
        self.echo = Pin(echo_pin, Pin.IN)
        self.timeout = echo_timeout_us

    def _pulse(self):
        self.trigger.value(0)
        time.sleep_us(5)
        self.trigger.value(1)
        time.sleep_us(10)
        self.trigger.value(0)
        t = time_pulse_us(self.echo, 1, self.timeout)
        if t < 0:
            raise OSError('Out of range')
        return t

    def distance_cm(self):
        return self._pulse() / 58.3

    def distance_mm(self):
        return self._pulse() * 10 / 58.3
`,
  },
  mpu6050: {
    'lib/mpu6050.py': `"""MPU-6050 accelerometer + gyro over I2C: imu = MPU6050(i2c); imu.accel(); imu.angles()"""
import math

class MPU6050:
    def __init__(self, i2c, addr=0x68):
        self.i2c = i2c
        self.addr = addr
        self.i2c.writeto(self.addr, bytearray([0x6B, 0]))   # wake up

    def _raw(self):
        self.i2c.writeto(self.addr, bytearray([0x3B]))
        d = self.i2c.readfrom(self.addr, 14)
        out = []
        for i in range(0, 14, 2):
            v = (d[i] << 8) | d[i + 1]
            out.append(v - 65536 if v > 32767 else v)
        return out

    def accel(self):
        v = self._raw()
        return (v[0] / 16384, v[1] / 16384, v[2] / 16384)

    def gyro(self):
        v = self._raw()
        return (v[4] / 131, v[5] / 131, v[6] / 131)

    def temperature(self):
        return self._raw()[3] / 340 + 36.53

    def angles(self):
        ax, ay, az = self.accel()
        pitch = math.degrees(math.atan2(-ax, math.sqrt(ay * ay + az * az)))
        roll = math.degrees(math.atan2(ay, az))
        return pitch, roll
`,
  },
  aht20: {
    'lib/aht20.py': `"""AHT20 temperature + humidity over I2C: s = AHT20(i2c); t, rh = s.read()"""
import time

class AHT20:
    def __init__(self, i2c, addr=0x38):
        self.i2c = i2c
        self.addr = addr
        time.sleep_ms(40)
        self.i2c.writeto(self.addr, bytearray([0xBE, 0x08, 0x00]))   # calibrate
        time.sleep_ms(10)

    def read(self):
        self.i2c.writeto(self.addr, bytearray([0xAC, 0x33, 0x00]))   # measure
        time.sleep_ms(80)
        d = self.i2c.readfrom(self.addr, 7)
        h = (d[1] << 12) | (d[2] << 4) | (d[3] >> 4)
        t = ((d[3] & 0x0F) << 16) | (d[4] << 8) | d[5]
        return t * 200 / 1048576 - 50, h * 100 / 1048576

    @property
    def temperature(self):
        return self.read()[0]

    @property
    def relative_humidity(self):
        return self.read()[1]
`,
  },
  bh1750: {
    'lib/bh1750.py': `"""BH1750 ambient light over I2C: light = BH1750(i2c); light.luminance()  # lux"""

class BH1750:
    def __init__(self, i2c, addr=0x23):
        self.i2c = i2c
        self.addr = addr
        self.i2c.writeto(self.addr, bytearray([0x01]))   # power on
        self.i2c.writeto(self.addr, bytearray([0x10]))   # continuous, 1 lx resolution

    def luminance(self):
        d = self.i2c.readfrom(self.addr, 2)
        return ((d[0] << 8) | d[1]) / 1.2
`,
  },
  stepper: {
    'lib/stepper.py': `"""28BYJ-48 stepper on a ULN2003: m = Stepper(10, 11, 12, 13); m.step(512); m.angle(90)"""
from machine import Pin
import time

_HALF = [[1, 0, 0, 0], [1, 1, 0, 0], [0, 1, 0, 0], [0, 1, 1, 0], [0, 0, 1, 0], [0, 0, 1, 1], [0, 0, 0, 1], [1, 0, 0, 1]]

class Stepper:
    STEPS_PER_REV = 4096

    def __init__(self, in1, in2, in3, in4, delay_ms=2):
        self.pins = [Pin(p, Pin.OUT, value=0) for p in (in1, in2, in3, in4)]
        self.i = 0
        self.delay = delay_ms

    def step(self, n):
        d = 1 if n > 0 else -1
        for _ in range(abs(n)):
            self.i = (self.i + d) % 8
            for p, v in zip(self.pins, _HALF[self.i]):
                p.value(v)
            time.sleep_ms(self.delay)

    def angle(self, deg):
        self.step(int(deg / 360 * self.STEPS_PER_REV))

    def off(self):
        for p in self.pins:
            p.value(0)
`,
  },
};

/** Driver files a set of parts needs (MicroPython boards only). */
export function libsFor(b: BoardDef, comps: CompInstance[]): Record<string, string> {
  if (b.lang !== 'micropython') return {};
  const out: Record<string, string> = {};
  for (const c of comps) Object.assign(out, PART_LIBS[c.type] ?? {});
  const kit: Record<string, string[]> = { sht40: ['lib/sht4x.py'], tft: ['lib/gc9a01.py', 'lib/vga1_8x16.py', 'lib/vga1_bold_16x32.py'], encoder: [b.runtime === 'rp2040-emu' ? 'lib/rotary_irq_rp2.py' : 'lib/rotary_irq_esp.py', 'lib/rotary.py'] };
  for (const c of comps) for (const f of kit[c.type] ?? []) if (MPY_LIBS[f]) out[f] = MPY_LIBS[f];
  return out;
}

// ---------------------------------------------------------------- demo programs
interface Part { c: CompInstance; v: string; p: (role: string) => number | null; name: string }
function parts(comps: CompInstance[]): Part[] {
  const n = new Map<string, number>();
  const base: Record<string, string> = { button: 'btn', limit: 'limit', touch: 'touch', switch: 'sw', pir: 'pir', tilt: 'tilt', reed: 'reed', irsensor: 'ir', joystick: 'joy', encoder: 'dial', pot: 'pot', slidepot: 'slider', ldr: 'light', soil: 'soil', fsr: 'force', gas: 'gas', tmp36: 'tmp36', sht40: 'sht', aht20: 'aht', bh1750: 'lux', mpu6050: 'imu', hcsr04: 'sonar', oled: 'oled', lcd1602: 'lcd', tm1637: 'digits', tft: 'tft', neopixel: 'ring', led: 'led', rgbled: 'rgb', laser: 'laser', buzzer: 'buzz', servo: 'servo', relay: 'relay', solenoid: 'lock', haptic: 'haptic', motor: 'motor', fan: 'fan', pump: 'pump', stepper: 'stepper' };
  return comps.filter(c => COMPONENTS[c.type]).map(c => {
    const b = base[c.type] ?? (c.type.startsWith('led_') ? 'led_' + c.type.slice(4) : c.type.replace(/\W/g, '_'));
    const k = (n.get(b) ?? 0) + 1; n.set(b, k);
    return { c, v: k > 1 ? `${b}${k}` : b, p: (r: string) => c.pins[r] ?? null, name: COMPONENTS[c.type].name };
  });
}
/** ' (not wired yet: SDA, SCL)' when some pins are unconnected. */
const unwired = (x: Part) => { const r = Object.entries(x.c.pins).filter(([, g]) => g == null).map(([k]) => k); return r.length ? ` (not wired yet: ${r.join(', ')})` : ''; };
const ACTIVE_HIGH = new Set(['touch', 'pir']);
const SWITCHES = new Set(['button', 'limit', 'touch', 'switch', 'pir', 'tilt', 'reed', 'irsensor']);
const ANALOG = new Set(['pot', 'slidepot', 'ldr', 'soil', 'fsr', 'gas', 'tmp36']);
const LEDS = (t: string) => t === 'led' || t.startsWith('led_') || t === 'laser';
const ON_WORD: Record<string, [string, string]> = { button: ['pressed', 'released'], limit: ['hit', 'clear'], touch: ['touched', 'released'], switch: ['on', 'off'], pir: ['motion', 'still'], tilt: ['tilted', 'upright'], reed: ['magnet near', 'magnet away'], irsensor: ['obstacle', 'clear'] };

/** A starter program for the wired parts, or a skeleton if nothing is wired. */
export function demoFiles(b: BoardDef, comps: CompInstance[]): Record<string, string> | null {
  const ps = parts(comps);
  if (!ps.length) return null;
  if (b.lang === 'arduino') return { 'sketch.ino': arduinoDemo(b, ps) };
  if (b.lang === 'python') return { 'main.py': piDemo(b, ps) };
  return { 'main.py': mpyDemo(b, ps), ...libsFor(b, comps) };
}

function mpyDemo(b: BoardDef, ps: Part[]): string {
  const imp = new Set<string>(['from machine import Pin', 'import time']);
  const setup: string[] = [], loop: string[] = [], every: string[] = [];
  const machine = new Set<string>();
  const buses = new Map<string, string>();
  const bus = (x: Part) => {
    const sda = x.p('SDA'), scl = x.p('SCL'), key = `${sda},${scl}`;
    if (!buses.has(key)) {
      const id = Math.max(0, b.i2c?.findIndex(g => sda != null && g.sda?.includes(sda)) ?? 0);
      const v = buses.size ? `i2c${buses.size + 1}` : 'i2c';
      machine.add('I2C'); buses.set(key, v);
      setup.push(`${v} = I2C(${id}, sda=Pin(${sda}), scl=Pin(${scl}), freq=400000)`);
    }
    return buses.get(key)!;
  };
  const pin = (g: number | null) => (g == null ? 'None' : String(g));
  for (const x of ps) {
    const t = x.c.type, v = x.v;
    setup.push('', `# ${x.name}${unwired(x)}`);
    if (SWITCHES.has(t)) {
      const hi = ACTIVE_HIGH.has(t), [on, off] = ON_WORD[t];
      setup.push(`${v} = Pin(${pin(x.p(x.c.pins.OUT !== undefined ? 'OUT' : 'SIG'))}, Pin.IN${hi ? '' : ', Pin.PULL_UP'})`, `${v}_was = ${v}.value()`);
      loop.push(`if ${v}.value() != ${v}_was:`, `    ${v}_was = ${v}.value()`, `    print('${x.name.split(' (')[0]}:', '${on}' if ${v}_was == ${hi ? 1 : 0} else '${off}')`);
    } else if (ANALOG.has(t)) {
      machine.add('ADC');
      const role = Object.keys(x.c.pins)[0];
      setup.push(`${v} = ADC(Pin(${pin(x.p(role))}))`);
      if (t === 'tmp36') every.push(`print('TMP36: %.1f C' % ((${v}.read_u16() * 3.3 / 65535 - 0.5) * 100))`);
      else every.push(`print('${COMPONENTS[t].reading?.label ?? x.name.split(' ')[0]}: %d%%' % (${v}.read_u16() * 100 // 65535))`);
    } else if (t === 'joystick') {
      machine.add('ADC');
      setup.push(`${v}_x = ADC(Pin(${pin(x.p('VRX'))}))`, `${v}_y = ADC(Pin(${pin(x.p('VRY'))}))`, `${v}_sw = Pin(${pin(x.p('SW'))}, Pin.IN, Pin.PULL_UP)`);
      every.push(`print('Joystick x=%d y=%d %s' % (${v}_x.read_u16() * 200 // 65535 - 100, ${v}_y.read_u16() * 200 // 65535 - 100, 'pressed' if ${v}_sw.value() == 0 else ''))`);
    } else if (t === 'encoder') {
      const mod = b.runtime === 'rp2040-emu' ? 'rotary_irq_rp2' : 'rotary_irq_esp';
      imp.add(`from ${mod} import RotaryIRQ`);
      setup.push(`${v} = RotaryIRQ(pin_num_clk=${pin(x.p('CLK'))}, pin_num_dt=${pin(x.p('DT'))}, min_val=0, max_val=100, range_mode=RotaryIRQ.RANGE_BOUNDED, pull_up=True)`, `${v}_was = ${v}.value()`);
      loop.push(`if ${v}.value() != ${v}_was:`, `    ${v}_was = ${v}.value()`, `    print('Dial:', ${v}_was)`);
    } else if (LEDS(t)) {
      setup.push(`${v} = Pin(${pin(x.p('SIG'))}, Pin.OUT)`);
      loop.push(`${v}.value((time.ticks_ms() // 500) % 2)          # blink`);
    } else if (t === 'rgbled') {
      machine.add('PWM'); imp.add('import math');
      setup.push(...['R', 'G', 'B'].map(r => `${v}_${r.toLowerCase()} = PWM(Pin(${pin(x.p(r))}), freq=1000)`));
      loop.push(`hue = time.ticks_ms() / 1000                    # colour wheel`, ...['r', 'g', 'b'].map((r, i) => `${v}_${r}.duty_u16(int((math.sin(hue + ${i * 2.09}) + 1) * 32767))`));
    } else if (t === 'buzzer') {
      machine.add('PWM');
      setup.push(`${v} = PWM(Pin(${pin(x.p('SIG'))}))`, `${v}.freq(880)`, `${v}.duty_u16(32768)`, `time.sleep_ms(120)                    # a beep at start`, `${v}.duty_u16(0)`);
    } else if (t === 'servo') {
      machine.add('PWM');
      setup.push(`${v} = PWM(Pin(${pin(x.p('PWM'))}), freq=50)`, `def ${v}_angle(deg):`, `    ${v}.duty_ns(int(500000 + deg / 180 * 2000000))   # 0.5-2.5 ms`);
      loop.push(`${v}_angle(abs((time.ticks_ms() // 20) % 360 - 180))   # sweep`);
    } else if (t === 'relay' || t === 'solenoid' || t === 'haptic') {
      const r = Object.keys(x.c.pins)[0];
      setup.push(`${v} = Pin(${pin(x.p(r))}, Pin.OUT, value=0)`);
      loop.push(`${v}.value((time.ticks_ms() // 2000) % 2)          # on 2 s, off 2 s`);
    } else if (t === 'motor') {
      machine.add('PWM');
      setup.push(`${v}_a = PWM(Pin(${pin(x.p('IA'))}), freq=1000)`, `${v}_b = PWM(Pin(${pin(x.p('IB'))}), freq=1000)`, `def ${v}_speed(s):                        # -1 (reverse) .. 1 (forward)`, `    ${v}_a.duty_u16(int(max(0, s) * 65535))`, `    ${v}_b.duty_u16(int(max(0, -s) * 65535))`);
      loop.push(`${v}_speed(((time.ticks_ms() // 40) % 100 - 50) / 50)   # ramp through reverse to forward`);
    } else if (t === 'fan' || t === 'pump') {
      machine.add('PWM');
      setup.push(`${v} = PWM(Pin(${pin(x.p('IN'))}), freq=1000)`);
      loop.push(`${v}.duty_u16(65535 if (time.ticks_ms() // 3000) % 2 else 0)   # 3 s on, 3 s off`);
    } else if (t === 'stepper') {
      imp.add('from stepper import Stepper');
      setup.push(`${v} = Stepper(${['IN1', 'IN2', 'IN3', 'IN4'].map(r => pin(x.p(r))).join(', ')})`);
      loop.push(`${v}.step(32)                               # a little turn each loop`);
    } else if (t === 'hcsr04') {
      imp.add('from hcsr04 import HCSR04');
      setup.push(`${v} = HCSR04(trigger_pin=${pin(x.p('TRIG'))}, echo_pin=${pin(x.p('ECHO'))})`);
      every.push(`print('Distance: %.1f cm' % ${v}.distance_cm())`);
    } else if (t === 'sht40') {
      imp.add('from sht4x import SHT4x');
      setup.push(`${v} = SHT4x(${bus(x)})`);
      every.push(`print('SHT40: %.1f C  %.0f %%RH' % ${v}.measure())`);
    } else if (t === 'aht20') {
      imp.add('from aht20 import AHT20');
      setup.push(`${v} = AHT20(${bus(x)})`);
      every.push(`print('AHT20: %.1f C  %.0f %%RH' % ${v}.read())`);
    } else if (t === 'bh1750') {
      imp.add('from bh1750 import BH1750');
      setup.push(`${v} = BH1750(${bus(x)})`);
      every.push(`print('Light: %d lux' % ${v}.luminance())`);
    } else if (t === 'mpu6050') {
      imp.add('from mpu6050 import MPU6050');
      setup.push(`${v} = MPU6050(${bus(x)})`);
      every.push(`print('Tilt: pitch %d  roll %d' % tuple(round(a) for a in ${v}.angles()))`);
    } else if (t === 'oled') {
      imp.add('from ssd1306 import SSD1306_I2C');
      setup.push(`${v} = SSD1306_I2C(128, 64, ${bus(x)})`);
      every.push(`${v}.fill(0)`, `${v}.text('Formframe', 28, 4)`, `${v}.text('up %d s' % (time.ticks_ms() // 1000), 30, 28)`, `${v}.rect(0, 0, 128, 64, 1)`, `${v}.fill_rect(4, 50, (time.ticks_ms() // 100) % 120, 8, 1)`, `${v}.show()`);
    } else if (t === 'lcd1602') {
      imp.add('from i2c_lcd import I2cLcd');
      setup.push(`${v} = I2cLcd(${bus(x)}, 0x27, 2, 16)`, `${v}.putstr('Hello, maker!')`);
      every.push(`${v}.move_to(0, 1)`, `${v}.putstr('Up %d s   ' % (time.ticks_ms() // 1000))`);
    } else if (t === 'tm1637') {
      imp.add('from tm1637 import TM1637');
      setup.push(`${v} = TM1637(clk=Pin(${pin(x.p('CLK'))}), dio=Pin(${pin(x.p('DIO'))}))`);
      every.push(`${v}.numbers(time.ticks_ms() // 60000, (time.ticks_ms() // 1000) % 60)   # mm:ss`);
    } else if (t === 'neopixel') {
      imp.add('import neopixel');
      setup.push(`${v} = neopixel.NeoPixel(Pin(${pin(x.p('DIN'))}), 24)`);
      loop.push(`for i in range(24):                       # spinning dot`, `    ${v}[i] = (0, 60, 120) if i == (time.ticks_ms() // 60) % 24 else (0, 0, 0)`, `${v}.write()`);
    } else if (t === 'tft') {
      machine.add('SPI'); imp.add('import gc9a01, vga1_bold_16x32 as font');
      setup.push(`${v} = gc9a01.GC9A01(SPI(${Math.max(0, b.spi?.findIndex(g => g.sck?.includes(x.p('SCK') ?? -1)) ?? 1)}, baudrate=40000000, sck=Pin(${pin(x.p('SCK'))}), mosi=Pin(${pin(x.p('MOSI'))})), 240, 240,`, `                     dc=Pin(${pin(x.p('DC'))}, Pin.OUT), cs=Pin(${pin(x.p('CS'))}, Pin.OUT))`, `${v}.init()`, `${v}.fill(gc9a01.BLACK)`);
      every.push(`${v}.text(font, '%3d s' % (time.ticks_ms() // 1000), 72, 104, gc9a01.WHITE, gc9a01.BLACK)`);
    } else {
      setup.push(`# (no example for this part yet: its pins are ${Object.entries(x.c.pins).map(([r, g]) => `${r} ${g == null ? '—' : pinLabel(b, g)}`).join(', ')})`);
    }
  }
  if (machine.size) imp.delete('from machine import Pin'), imp.add(`from machine import ${['Pin', ...machine].join(', ')}`);
  const head = [...imp].sort((a, z) => (a.startsWith('from machine') ? -1 : z.startsWith('from machine') ? 1 : 0));
  return `# MicroPython on ${b.name}: a quick demo of every part you've wired.
# Press Run, then play with the parts on the bench. Edit anything; drivers are in lib/.
${head.join('\n')}
${setup.join('\n')}

print('ready')
n = 0
while True:
${[...loop, ...(every.length ? ['if n % 20 == 0:                           # about once a second', ...every.map(l => '    ' + l)] : [])].map(l => '    ' + l).join('\n') || '    pass'}
    n += 1
    time.sleep_ms(50)
`;
}

function piDemo(b: BoardDef, ps: Part[]): string {
  const imp = new Set<string>(['import time']), gz = new Set<string>();
  const setup: string[] = [], loop: string[] = [], every: string[] = [], notes: string[] = [];
  let smbus = false;
  const pin = (g: number | null) => (g == null ? 'None' : String(g));
  for (const x of ps) {
    const t = x.c.type, v = x.v;
    setup.push('', `# ${x.name}${unwired(x)}`);
    if (SWITCHES.has(t)) {
      const role = x.c.pins.OUT !== undefined ? 'OUT' : 'SIG', [on, off] = ON_WORD[t];
      if (t === 'pir') { gz.add('MotionSensor'); setup.push(`${v} = MotionSensor(${pin(x.p(role))})`, `${v}.when_motion = lambda: print('Motion!')`, `${v}.when_no_motion = lambda: print('Still')`); continue; }
      if (ACTIVE_HIGH.has(t)) { gz.add('DigitalInputDevice'); setup.push(`${v} = DigitalInputDevice(${pin(x.p(role))})`, `${v}.when_activated = lambda: print('${x.name.split(' (')[0]}: ${on}')`, `${v}.when_deactivated = lambda: print('${x.name.split(' (')[0]}: ${off}')`); continue; }
      gz.add('Button'); setup.push(`${v} = Button(${pin(x.p(role))})                 # wired to GND, internal pull-up`, `${v}.when_pressed = lambda: print('${x.name.split(' (')[0]}: ${on}')`, `${v}.when_released = lambda: print('${x.name.split(' (')[0]}: ${off}')`);
    } else if (LEDS(t)) { gz.add('LED'); setup.push(`${v} = LED(${pin(x.p('SIG'))})`); loop.push(`${v}.value = (int(time.time() * 2) % 2)          # blink`); }
    else if (t === 'rgbled') { gz.add('RGBLED'); imp.add('import math'); setup.push(`${v} = RGBLED(${pin(x.p('R'))}, ${pin(x.p('G'))}, ${pin(x.p('B'))})`); loop.push(`h = time.time()`, `${v}.color = tuple((math.sin(h + k * 2.09) + 1) / 2 for k in range(3))`); }
    else if (t === 'buzzer') { gz.add('TonalBuzzer'); setup.push(`${v} = TonalBuzzer(${pin(x.p('SIG'))})`, `${v}.play(880)`, `time.sleep(0.12)`, `${v}.stop()`); }
    else if (t === 'servo') { gz.add('Servo'); setup.push(`${v} = Servo(${pin(x.p('PWM'))}, min_pulse_width=0.0005, max_pulse_width=0.0025)`); loop.push(`${v}.value = abs((time.time() * 0.5) % 2 - 1) * 2 - 1   # sweep`); }
    else if (t === 'relay' || t === 'solenoid' || t === 'haptic') { gz.add('OutputDevice'); setup.push(`${v} = OutputDevice(${pin(x.p(Object.keys(x.c.pins)[0]))})`); loop.push(`${v}.value = int(time.time() / 2) % 2               # on 2 s, off 2 s`); }
    else if (t === 'motor') { gz.add('Motor'); setup.push(`${v} = Motor(forward=${pin(x.p('IA'))}, backward=${pin(x.p('IB'))})`); loop.push(`${v}.value = ((time.time() * 25) % 100 - 50) / 50   # reverse .. forward`); }
    else if (t === 'fan' || t === 'pump') { gz.add('PWMOutputDevice'); setup.push(`${v} = PWMOutputDevice(${pin(x.p('IN'))})`); loop.push(`${v}.value = int(time.time() / 3) % 2              # 3 s on, 3 s off`); }
    else if (t === 'hcsr04') { gz.add('DistanceSensor'); setup.push(`${v} = DistanceSensor(echo=${pin(x.p('ECHO'))}, trigger=${pin(x.p('TRIG'))}, max_distance=4)`); every.push(`print('Distance: %.1f cm' % (${v}.distance * 100))`); }
    else if (t === 'encoder') { gz.add('RotaryEncoder'); setup.push(`${v} = RotaryEncoder(${pin(x.p('CLK'))}, ${pin(x.p('DT'))}, max_steps=0)`, `${v}.when_rotated = lambda: print('Dial:', ${v}.steps)`); }
    else if (t === 'stepper') { gz.add('OutputDevice'); setup.push(`${v}_pins = [OutputDevice(p) for p in (${['IN1', 'IN2', 'IN3', 'IN4'].map(r => pin(x.p(r))).join(', ')})]`, `${v}_seq = [(1,0,0,0), (1,1,0,0), (0,1,0,0), (0,1,1,0), (0,0,1,0), (0,0,1,1), (0,0,0,1), (1,0,0,1)]`, `${v}_i = 0`); loop.push(`for _ in range(16):                        # a little turn each loop`, `    ${v}_i = (${v}_i + 1) % 8`, `    for p, s in zip(${v}_pins, ${v}_seq[${v}_i]):`, `        p.value = s`, `    time.sleep(0.002)`); }
    else if (t === 'neopixel') { imp.add('import board, neopixel'); setup.push(`${v} = neopixel.NeoPixel(board.D${pin(x.p('DIN'))}, 24, brightness=0.4, auto_write=False)`); loop.push(`for i in range(24):`, `    ${v}[i] = (0, 60, 120) if i == int(time.time() * 16) % 24 else (0, 0, 0)`, `${v}.show()`); }
    else if (t === 'sht40' || t === 'aht20' || t === 'bh1750' || t === 'mpu6050') {
      smbus = true;
      if (t === 'sht40') { setup.push(`def ${v}_read():`, `    bus.i2c_rdwr(i2c_msg.write(0x44, [0xFD]))`, `    time.sleep(0.01)`, `    m = i2c_msg.read(0x44, 6)`, `    bus.i2c_rdwr(m)`, `    d = list(m)`, `    return -45 + 175 * ((d[0] << 8) | d[1]) / 65535, max(0, min(100, -6 + 125 * ((d[3] << 8) | d[4]) / 65535))`); every.push(`print('SHT40: %.1f C  %.0f %%RH' % ${v}_read())`); }
      if (t === 'aht20') { setup.push(`def ${v}_read():`, `    bus.i2c_rdwr(i2c_msg.write(0x38, [0xAC, 0x33, 0x00]))`, `    time.sleep(0.08)`, `    m = i2c_msg.read(0x38, 7)`, `    bus.i2c_rdwr(m)`, `    d = list(m)`, `    h = (d[1] << 12) | (d[2] << 4) | (d[3] >> 4)`, `    t = ((d[3] & 15) << 16) | (d[4] << 8) | d[5]`, `    return t * 200 / 1048576 - 50, h * 100 / 1048576`); every.push(`print('AHT20: %.1f C  %.0f %%RH' % ${v}_read())`); }
      if (t === 'bh1750') { setup.push(`bus.write_byte(0x23, 0x10)                  # continuous high-res`, `def ${v}_read():`, `    m = i2c_msg.read(0x23, 2)`, `    bus.i2c_rdwr(m)`, `    d = list(m)`, `    return ((d[0] << 8) | d[1]) / 1.2`); every.push(`print('Light: %d lux' % ${v}_read())`); }
      if (t === 'mpu6050') { imp.add('import math'); setup.push(`bus.i2c_rdwr(i2c_msg.write(0x68, [0x6B, 0]))    # wake`, `def ${v}_tilt():`, `    bus.i2c_rdwr(i2c_msg.write(0x68, [0x3B]))`, `    m = i2c_msg.read(0x68, 6)`, `    bus.i2c_rdwr(m)`, `    d = list(m)`, `    a = [((d[i] << 8 | d[i + 1]) - (65536 if d[i] & 0x80 else 0)) / 16384 for i in (0, 2, 4)]`, `    return math.degrees(math.atan2(-a[0], math.hypot(a[1], a[2]))), math.degrees(math.atan2(a[1], a[2]))`); every.push(`print('Tilt: pitch %d  roll %d' % tuple(round(a) for a in ${v}_tilt()))`); }
    } else if (t === 'lcd1602') {
      smbus = true;
      setup.push(`LCD = 0x27                                 # HD44780 on a PCF8574 backpack`, `def lcd_nibble(v, rs=0):`, `    b = (v & 0xF0) | 0x08 | rs                  # 0x08 = backlight, 0x04 = E`, `    bus.write_byte(LCD, b | 0x04)`, `    bus.write_byte(LCD, b)`, `def lcd_cmd(c):`, `    lcd_nibble(c)`, `    lcd_nibble(c << 4)`, `    time.sleep(0.002 if c <= 3 else 0)`, `def lcd_text(s, row=None):`, `    if row is not None:`, `        lcd_cmd(0x80 | (0x40 if row else 0))`, `    for ch in s:`, `        lcd_nibble(ord(ch), 1)`, `        lcd_nibble(ord(ch) << 4, 1)`, `for _ in range(3):`, `    lcd_nibble(0x30)`, `    time.sleep(0.005)`, `lcd_nibble(0x20)`, `for c in (0x28, 0x0C, 0x01, 0x06):`, `    lcd_cmd(c)`, `lcd_text('Hello, maker!')`);
      every.push(`lcd_text('Up %d s   ' % (time.time() - t0), 1)`);
    } else if (ANALOG.has(t) || t === 'joystick') { setup.push(`# The Pi has no analog inputs: read this through an ADC such as an MCP3008 (gpiozero.MCP3008).`); notes.push(x.name); }
    else setup.push(`# Not in this demo yet. On a Pi, use a Python library for it (e.g. luma.oled for OLEDs, RPLCD for LCDs).`);
  }
  if (smbus) { imp.add('from smbus2 import SMBus, i2c_msg'); setup.unshift('bus = SMBus(1)                             # SDA = GPIO2, SCL = GPIO3'); }
  if (gz.size) imp.add(`from gpiozero import ${[...gz].sort().join(', ')}`);
  if (ps.some(x => x.c.type === 'lcd1602')) setup.unshift('t0 = time.time()');
  return `# Python 3 on ${b.name}: a quick demo of every part you've wired (gpiozero + smbus2).
# Press Run, then play with the parts on the bench.
${[...imp].join('\n')}
${setup.join('\n')}

print('ready')
n = 0
while True:
${[...loop, ...(every.length ? ['if n % 20 == 0:', ...every.map(l => '    ' + l)] : [])].map(l => '    ' + l).join('\n') || '    pass'}
    n += 1
    time.sleep(0.05)
`;
}

function arduinoDemo(b: BoardDef, ps: Part[]): string {
  const L = (g: number | null) => (g == null ? '-1 /* not wired */' : b.family === 'avr' && g >= 14 ? 'A' + (g - 14) : String(g));
  const decl: string[] = [], setup: string[] = [], loop: string[] = [], every: string[] = [], helpers: string[] = [];
  let wire = false;
  for (const x of ps) {
    const t = x.c.type, v = x.v, V = v.toUpperCase();
    if (SWITCHES.has(t)) {
      const role = x.c.pins.OUT !== undefined ? 'OUT' : 'SIG', hi = ACTIVE_HIGH.has(t), [on, off] = ON_WORD[t];
      decl.push(`const int PIN_${V} = ${L(x.p(role))};   // ${x.name}`, `int ${v}Was = -1;`);
      setup.push(`pinMode(PIN_${V}, ${hi ? 'INPUT' : 'INPUT_PULLUP'});`);
      loop.push(`int ${v}Now = digitalRead(PIN_${V});`, `if (${v}Now != ${v}Was) { ${v}Was = ${v}Now; Serial.println(${v}Now == ${hi ? 'HIGH' : 'LOW'} ? "${x.name.split(' (')[0]}: ${on}" : "${x.name.split(' (')[0]}: ${off}"); }`);
    } else if (ANALOG.has(t)) {
      decl.push(`const int PIN_${V} = ${L(x.p(Object.keys(x.c.pins)[0]))};   // ${x.name}`);
      if (t === 'tmp36') every.push(`Serial.print("TMP36 C: "); Serial.println((analogRead(PIN_${V}) * 5.0 / 1023 - 0.5) * 100);`);
      else every.push(`Serial.print("${COMPONENTS[t].reading?.label ?? x.name.split(' ')[0]} %: "); Serial.println(analogRead(PIN_${V}) * 100L / 1023);`);
    } else if (t === 'joystick') {
      decl.push(`const int PIN_${V}_X = ${L(x.p('VRX'))}, PIN_${V}_Y = ${L(x.p('VRY'))}, PIN_${V}_SW = ${L(x.p('SW'))};`);
      setup.push(`pinMode(PIN_${V}_SW, INPUT_PULLUP);`);
      every.push(`Serial.print("Joystick x="); Serial.print(analogRead(PIN_${V}_X) - 512); Serial.print(" y="); Serial.print(analogRead(PIN_${V}_Y) - 512); Serial.println(digitalRead(PIN_${V}_SW) ? "" : " pressed");`);
    } else if (LEDS(t)) {
      decl.push(`const int PIN_${V} = ${L(x.p('SIG'))};   // ${x.name}`); setup.push(`pinMode(PIN_${V}, OUTPUT);`);
      loop.push(`digitalWrite(PIN_${V}, (millis() / 500) % 2);   // blink`);
    } else if (t === 'rgbled') {
      decl.push(`const int PIN_${V}_R = ${L(x.p('R'))}, PIN_${V}_G = ${L(x.p('G'))}, PIN_${V}_B = ${L(x.p('B'))};   // PWM pins: ${(b.hwPwm ?? []).map(g => pinLabel(b, g)).join(' ')}`);
      loop.push(`float h = millis() / 1000.0;`, `analogWrite(PIN_${V}_R, (sin(h) + 1) * 127);`, `analogWrite(PIN_${V}_G, (sin(h + 2.09) + 1) * 127);`, `analogWrite(PIN_${V}_B, (sin(h + 4.19) + 1) * 127);`);
    } else if (t === 'buzzer') {
      decl.push(`const int PIN_${V} = ${L(x.p('SIG'))};   // ${x.name}`); setup.push(`tone(PIN_${V}, 880, 120);   // a beep at start`);
    } else if (t === 'servo') {
      decl.push(`const int PIN_${V} = ${L(x.p('PWM'))};   // ${x.name} (or use the Servo library)`); setup.push(`pinMode(PIN_${V}, OUTPUT);`);
      loop.push(`int ${v}Deg = abs((int)((millis() / 20) % 360) - 180);   // sweep`, `digitalWrite(PIN_${V}, HIGH); delayMicroseconds(500 + ${v}Deg * 2000L / 180); digitalWrite(PIN_${V}, LOW);`);
    } else if (t === 'relay' || t === 'solenoid' || t === 'haptic') {
      decl.push(`const int PIN_${V} = ${L(x.p(Object.keys(x.c.pins)[0]))};   // ${x.name}`); setup.push(`pinMode(PIN_${V}, OUTPUT);`);
      loop.push(`digitalWrite(PIN_${V}, (millis() / 2000) % 2);   // on 2 s, off 2 s`);
    } else if (t === 'motor') {
      decl.push(`const int PIN_${V}_A = ${L(x.p('IA'))}, PIN_${V}_B = ${L(x.p('IB'))};   // ${x.name}`);
      loop.push(`int ${v}Spd = (int)((millis() / 40) % 100) * 2 - 100;   // -100 reverse .. 100 forward`, `analogWrite(PIN_${V}_A, ${v}Spd > 0 ? ${v}Spd * 255 / 100 : 0);`, `analogWrite(PIN_${V}_B, ${v}Spd < 0 ? -${v}Spd * 255 / 100 : 0);`);
    } else if (t === 'fan' || t === 'pump') {
      decl.push(`const int PIN_${V} = ${L(x.p('IN'))};   // ${x.name}`); setup.push(`pinMode(PIN_${V}, OUTPUT);`);
      loop.push(`analogWrite(PIN_${V}, (millis() / 3000) % 2 ? 255 : 0);   // 3 s on, 3 s off`);
    } else if (t === 'stepper') {
      decl.push(`const int PIN_${V}[4] = {${['IN1', 'IN2', 'IN3', 'IN4'].map(r => L(x.p(r))).join(', ')}};   // ${x.name}`, `const byte HALF_STEP[8] = {0b1000, 0b1100, 0b0100, 0b0110, 0b0010, 0b0011, 0b0001, 0b1001};`, `int ${v}Phase = 0;`);
      setup.push(`for (int i = 0; i < 4; i++) pinMode(PIN_${V}[i], OUTPUT);`);
      loop.push(`for (int s = 0; s < 32; s++) {   // a little turn each loop`, `  ${v}Phase = (${v}Phase + 1) % 8;`, `  for (int i = 0; i < 4; i++) digitalWrite(PIN_${V}[i], (HALF_STEP[${v}Phase] >> (3 - i)) & 1);`, `  delay(2);`, `}`);
    } else if (t === 'hcsr04') {
      decl.push(`const int PIN_${V}_TRIG = ${L(x.p('TRIG'))}, PIN_${V}_ECHO = ${L(x.p('ECHO'))};   // ${x.name}`);
      setup.push(`pinMode(PIN_${V}_TRIG, OUTPUT);`, `pinMode(PIN_${V}_ECHO, INPUT);`);
      every.push(`digitalWrite(PIN_${V}_TRIG, LOW); delayMicroseconds(2);`, `digitalWrite(PIN_${V}_TRIG, HIGH); delayMicroseconds(10); digitalWrite(PIN_${V}_TRIG, LOW);`, `Serial.print("Distance cm: "); Serial.println(pulseIn(PIN_${V}_ECHO, HIGH, 30000UL) / 58.3);`);
    } else if (t === 'aht20' || t === 'bh1750' || t === 'mpu6050' || t === 'sht40') {
      wire = true;
      if (t === 'bh1750') { setup.push(`Wire.beginTransmission(0x23); Wire.write(0x10); Wire.endTransmission();   // BH1750 continuous`); every.push(`Wire.requestFrom(0x23, 2); { uint16_t raw = Wire.read() << 8; raw |= Wire.read(); Serial.print("Light lux: "); Serial.println(raw / 1.2); }`); }
      if (t === 'aht20') every.push(`Wire.beginTransmission(0x38); Wire.write(0xAC); Wire.write(0x33); Wire.write(0x00); Wire.endTransmission(); delay(80);`, `Wire.requestFrom(0x38, 7); { uint8_t d[7]; for (int i = 0; i < 7; i++) d[i] = Wire.read();`, `  uint32_t h = ((uint32_t)d[1] << 12) | ((uint32_t)d[2] << 4) | (d[3] >> 4), t = ((uint32_t)(d[3] & 15) << 16) | ((uint32_t)d[4] << 8) | d[5];`, `  Serial.print("AHT20 C: "); Serial.print(t * 200.0 / 1048576 - 50); Serial.print("  RH: "); Serial.println(h * 100.0 / 1048576); }`);
      if (t === 'mpu6050') { setup.push(`Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();   // wake MPU-6050`); every.push(`Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(); Wire.requestFrom(0x68, 6);`, `{ int16_t ax = Wire.read() << 8 | Wire.read(), ay = Wire.read() << 8 | Wire.read(), az = Wire.read() << 8 | Wire.read();`, `  Serial.print("Tilt pitch: "); Serial.print(atan2(-ax, sqrt((float)ay * ay + (float)az * az)) * 57.3); Serial.print("  roll: "); Serial.println(atan2(ay, az) * 57.3); }`); }
      if (t === 'sht40') every.push(`Wire.beginTransmission(0x44); Wire.write(0xFD); Wire.endTransmission(); delay(10); Wire.requestFrom(0x44, 6);`, `{ uint16_t tr = Wire.read() << 8; tr |= Wire.read(); Wire.read(); Serial.print("SHT40 C: "); Serial.println(-45 + 175.0 * tr / 65535); while (Wire.available()) Wire.read(); }`);
    } else if (t === 'lcd1602') {
      wire = true;
      helpers.push(`// HD44780 LCD on a PCF8574 backpack (what LiquidCrystal_I2C does)
const uint8_t LCD = 0x27;
void lcdNibble(uint8_t v, uint8_t rs) { uint8_t b = (v & 0xF0) | 0x08 | rs; Wire.beginTransmission(LCD); Wire.write(b | 0x04); Wire.write(b); Wire.endTransmission(); }
void lcdCmd(uint8_t c) { lcdNibble(c, 0); lcdNibble(c << 4, 0); if (c <= 3) delay(2); }
void lcdChar(char ch) { lcdNibble(ch, 1); lcdNibble(ch << 4, 1); }
void lcdPrint(const char *s) { while (*s) lcdChar(*s++); }
void lcdAt(uint8_t col, uint8_t row) { lcdCmd(0x80 | (col + (row ? 0x40 : 0))); }
void lcdBegin() { delay(20); for (int i = 0; i < 3; i++) { lcdNibble(0x30, 0); delay(5); } lcdNibble(0x20, 0); lcdCmd(0x28); lcdCmd(0x0C); lcdCmd(0x01); lcdCmd(0x06); }`);
      setup.push(`lcdBegin();`, `lcdPrint("Hello, maker!");`);
      every.push(`{ char buf[17]; snprintf(buf, sizeof buf, "Up %lu s   ", millis() / 1000); lcdAt(0, 1); lcdPrint(buf); }`);
    } else if (t === 'tm1637') {
      decl.push(`const int PIN_${V}_CLK = ${L(x.p('CLK'))}, PIN_${V}_DIO = ${L(x.p('DIO'))};   // ${x.name}`);
      helpers.push(`// TM1637 two-wire protocol (what the TM1637Display library does)
const uint8_t DIGITS[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
void tmBit(int clk, int dio, uint8_t b) { for (int i = 0; i < 8; i++) { digitalWrite(dio, (b >> i) & 1); delayMicroseconds(5); digitalWrite(clk, HIGH); delayMicroseconds(5); digitalWrite(clk, LOW); } digitalWrite(dio, LOW); digitalWrite(clk, HIGH); delayMicroseconds(5); digitalWrite(clk, LOW); }
void tmStart(int clk, int dio) { digitalWrite(dio, LOW); delayMicroseconds(5); digitalWrite(clk, LOW); }
void tmStop(int clk, int dio) { digitalWrite(dio, LOW); digitalWrite(clk, HIGH); delayMicroseconds(5); digitalWrite(dio, HIGH); }
void tmShow(int clk, int dio, const uint8_t seg[4]) {
  tmStart(clk, dio); tmBit(clk, dio, 0x40); tmStop(clk, dio);
  tmStart(clk, dio); tmBit(clk, dio, 0xC0); for (int i = 0; i < 4; i++) tmBit(clk, dio, seg[i]); tmStop(clk, dio);
  tmStart(clk, dio); tmBit(clk, dio, 0x8F); tmStop(clk, dio);
}`);
      setup.push(`pinMode(PIN_${V}_CLK, OUTPUT); pinMode(PIN_${V}_DIO, OUTPUT); digitalWrite(PIN_${V}_CLK, HIGH); digitalWrite(PIN_${V}_DIO, HIGH);`);
      every.push(`{ unsigned long s = millis() / 1000; uint8_t seg[4] = {DIGITS[s / 600 % 10], (uint8_t)(DIGITS[s / 60 % 10] | 0x80), DIGITS[s % 60 / 10], DIGITS[s % 10]}; tmShow(PIN_${V}_CLK, PIN_${V}_DIO, seg); }   // mm:ss`);
    } else {
      decl.push(`// ${x.name}: no example here yet${t === 'oled' ? ' (use the Adafruit_SSD1306 library)' : ''}. Pins: ${Object.entries(x.c.pins).map(([r, g]) => `${r} ${L(g)}`).join(', ')}`);
    }
  }
  return `// Arduino C++ on ${b.name}: a quick demo of every part you've wired.
// Compile & Run, then play with the parts on the bench.
${wire ? '#include <Wire.h>\n' : ''}
${decl.join('\n')}
${helpers.length ? '\n' + helpers.join('\n\n') + '\n' : ''}
void setup() {
  Serial.begin(115200);${wire ? '\n  Wire.begin();' : ''}
${setup.map(l => '  ' + l).join('\n')}
  Serial.println("ready");
}

unsigned long lastPrint = 0;
void loop() {
${loop.map(l => '  ' + l).join('\n')}
${every.length ? `  if (millis() - lastPrint > 1000) {   // about once a second\n    lastPrint = millis();\n${every.map(l => '    ' + l).join('\n')}\n  }` : ''}
  delay(20);
}
`;
}
