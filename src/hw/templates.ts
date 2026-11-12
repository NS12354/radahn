import type { BoardDef, CompInstance } from './types';
import { FF_PY } from './runtimes/serial-device';

/**
 * Starter firmware generated from the current wiring, plus the driver
 * libraries that get deployed alongside it. The MicroPython drivers here are
 * real drivers: the same files run on the emulated RP2040 and on a physical board.
 */

type Pins = (type: string, role: string, dflt: number) => number;
const pinsOf = (comps: CompInstance[]): Pins => (type, role, d) => {
  const c = comps.find(x => x.type === type);
  return c && c.pins[role] != null ? (c.pins[role] as number) : d;
};
const busId = (b: BoardDef, kind: 'spi' | 'i2c', pin: number) => {
  const key = kind === 'spi' ? 'sck' : 'sda';
  const i = b[kind]?.findIndex(g => g[key]!.includes(pin)) ?? -1;
  return i < 0 ? (kind === 'spi' ? 1 : 0) : i;
};

// ---------------------------------------------------------------- MicroPython libs
export const MPY_LIBS: Record<string, string> = {
  'lib/gc9a01.py': `"""Pure-MicroPython driver for the GC9A01 240x240 round TFT (4-wire SPI).
API mirrors a subset of russhughes/gc9a01_mpy so code ports to the C driver unchanged:
fill, fill_rect, pixel, hline, vline, rect, text(font, s, x, y, fg, bg), color565.
Text uses the built-in 8x8 framebuf font scaled to font.WIDTH x font.HEIGHT.
"""
import time, framebuf
from micropython import const

BLACK = const(0x0000)
BLUE = const(0x001F)
RED = const(0xF800)
GREEN = const(0x07E0)
CYAN = const(0x07FF)
MAGENTA = const(0xF81F)
YELLOW = const(0xFFE0)
WHITE = const(0xFFFF)

def color565(r, g=None, b=None):
    if g is None:
        r, g, b = r
    return ((int(r) & 0xF8) << 8) | ((int(g) & 0xFC) << 3) | (int(b) >> 3)

# Vendor init sequence (from the reference driver). (cmd, data, delay_ms)
_INIT = (
    (0xEF, b'', 0), (0xEB, b'\\x14', 0), (0xFE, b'', 0), (0xEF, b'', 0), (0xEB, b'\\x14', 0),
    (0x84, b'\\x40', 0), (0x85, b'\\xff', 0), (0x86, b'\\xff', 0), (0x87, b'\\xff', 0), (0x88, b'\\x0a', 0),
    (0x89, b'\\x21', 0), (0x8A, b'\\x00', 0), (0x8B, b'\\x80', 0), (0x8C, b'\\x01', 0), (0x8D, b'\\x01', 0),
    (0x8E, b'\\xff', 0), (0x8F, b'\\xff', 0), (0xB6, b'\\x00\\x00', 0), (0x36, b'\\x48', 0), (0x3A, b'\\x05', 0),
    (0x90, b'\\x08\\x08\\x08\\x08', 0), (0xBD, b'\\x06', 0), (0xBC, b'\\x00', 0), (0xFF, b'\\x60\\x01\\x04', 0),
    (0xC3, b'\\x13', 0), (0xC4, b'\\x13', 0), (0xC9, b'\\x22', 0), (0xBE, b'\\x11', 0), (0xE1, b'\\x10\\x0e', 0),
    (0xDF, b'\\x21\\x0c\\x02', 0), (0xF0, b'\\x45\\x09\\x08\\x08\\x26\\x2a', 0), (0xF1, b'\\x43\\x70\\x72\\x36\\x37\\x6f', 0),
    (0xF2, b'\\x45\\x09\\x08\\x08\\x26\\x2a', 0), (0xF3, b'\\x43\\x70\\x72\\x36\\x37\\x6f', 0), (0xED, b'\\x1b\\x0b', 0),
    (0xAE, b'\\x77', 0), (0xCD, b'\\x63', 0), (0x70, b'\\x07\\x07\\x04\\x0e\\x0f\\x09\\x07\\x08\\x03', 0), (0xE8, b'\\x34', 0),
    (0x35, b'', 0), (0x21, b'', 0), (0x11, b'', 120), (0x29, b'', 20),
)

class GC9A01:
    def __init__(self, spi, width=240, height=240, reset=None, dc=None, cs=None, backlight=None, rotation=0, buffer_size=0):
        self.spi, self.width, self.height = spi, width, height
        self.dc, self.cs, self.rst, self.bl = dc, cs, reset, backlight
        self._row = bytearray(width * 2)
        if cs:
            cs.init(cs.OUT, value=1)
        if dc:
            dc.init(dc.OUT, value=0)

    def _cmd(self, c, data=None):
        self.cs(0)
        self.dc(0)
        self.spi.write(bytes((c,)))
        if data:
            self.dc(1)
            self.spi.write(data)
        self.cs(1)

    def _data(self, buf):
        self.cs(0)
        self.dc(1)
        self.spi.write(buf)
        self.cs(1)

    def init(self):
        if self.rst:
            self.rst.init(self.rst.OUT, value=1)
            self.rst(0); time.sleep_ms(20); self.rst(1); time.sleep_ms(120)
        for c, d, wait in _INIT:
            self._cmd(c, d)
            if wait:
                time.sleep_ms(wait)
        if self.bl:
            self.bl.init(self.bl.OUT, value=1)

    def _window(self, x0, y0, x1, y1):
        self._cmd(0x2A, bytes((x0 >> 8, x0 & 0xFF, x1 >> 8, x1 & 0xFF)))
        self._cmd(0x2B, bytes((y0 >> 8, y0 & 0xFF, y1 >> 8, y1 & 0xFF)))
        self._cmd(0x2C)

    def fill_rect(self, x, y, w, h, color):
        x = max(0, x); y = max(0, y)
        w = min(w, self.width - x); h = min(h, self.height - y)
        if w <= 0 or h <= 0:
            return
        hi, lo = color >> 8, color & 0xFF
        row = self._row
        for i in range(0, w * 2, 2):
            row[i] = hi
            row[i + 1] = lo
        mv = memoryview(row)[: w * 2]
        self._window(x, y, x + w - 1, y + h - 1)
        self.cs(0)
        self.dc(1)
        for _ in range(h):
            self.spi.write(mv)
        self.cs(1)

    def fill(self, color):
        self.fill_rect(0, 0, self.width, self.height, color)

    def pixel(self, x, y, color):
        self.fill_rect(x, y, 1, 1, color)

    def hline(self, x, y, w, color):
        self.fill_rect(x, y, w, 1, color)

    def vline(self, x, y, h, color):
        self.fill_rect(x, y, 1, h, color)

    def rect(self, x, y, w, h, color):
        self.hline(x, y, w, color); self.hline(x, y + h - 1, w, color)
        self.vline(x, y, h, color); self.vline(x + w - 1, y, h, color)

    def text(self, font, s, x, y, fg=WHITE, bg=BLACK):
        s = str(s)
        sx = max(1, font.WIDTH // 8)
        sy = max(1, font.HEIGHT // 8)
        w = len(s) * 8
        if not w:
            return
        src = framebuf.FrameBuffer(bytearray(w), w, 8, framebuf.MONO_HLSB)
        src.text(s, 0, 0, 1)
        W = w * sx
        fh, fl, bh, bl = fg >> 8, fg & 0xFF, bg >> 8, bg & 0xFF
        line = bytearray(W * 2)
        self._window(x, y, x + W - 1, y + 8 * sy - 1)
        self.cs(0)
        self.dc(1)
        for row in range(8):
            j = 0
            for col in range(w):
                if src.pixel(col, row):
                    hi, lo = fh, fl
                else:
                    hi, lo = bh, bl
                for _ in range(sx):
                    line[j] = hi
                    line[j + 1] = lo
                    j += 2
            for _ in range(sy):
                self.spi.write(line)
        self.cs(1)

    def on(self):
        self._cmd(0x29)

    def off(self):
        self._cmd(0x28)
`,
  'lib/sht4x.py': `"""SHT40/41/45 temperature + humidity over I2C (default address 0x44)."""
import time

def _crc(data):
    crc = 0xFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc

class SHT4x:
    def __init__(self, i2c, address=0x44):
        self.i2c, self.address = i2c, address

    def measure(self):
        """Returns (temperature_c, relative_humidity)."""
        self.i2c.writeto(self.address, b'\\xfd')
        time.sleep_ms(10)
        d = self.i2c.readfrom(self.address, 6)
        if _crc(d[0:2]) != d[2] or _crc(d[3:5]) != d[5]:
            raise OSError('SHT4x CRC mismatch')
        t = -45 + 175 * ((d[0] << 8) | d[1]) / 65535
        rh = -6 + 125 * ((d[3] << 8) | d[4]) / 65535
        return t, max(0.0, min(100.0, rh))
`,
  'lib/rotary_irq_rp2.py': `"""Interrupt-driven quadrature encoder (API-compatible subset of miketeachman's RotaryIRQ)."""
from machine import Pin

class RotaryIRQ:
    RANGE_UNBOUNDED = 1
    RANGE_WRAP = 2
    RANGE_BOUNDED = 3

    def __init__(self, pin_num_clk, pin_num_dt, min_val=0, max_val=10, incr=1,
                 reverse=False, range_mode=1, pull_up=False, half_step=False, invert=False):
        pull = Pin.PULL_UP if pull_up else None
        self._clk = Pin(pin_num_clk, Pin.IN, pull)
        self._dt = Pin(pin_num_dt, Pin.IN, pull)
        self._min, self._max, self._incr = min_val, max_val, incr
        self._dir = -1 if reverse else 1
        self._mode = range_mode
        self._v = min_val
        self._listeners = []
        self._clk.irq(self._isr, Pin.IRQ_FALLING)

    def _isr(self, pin):
        d = (1 if self._dt.value() else -1) * self._dir
        v = self._v + d * self._incr
        if self._mode == self.RANGE_BOUNDED:
            v = max(self._min, min(self._max, v))
        elif self._mode == self.RANGE_WRAP:
            span = self._max - self._min + 1
            v = self._min + (v - self._min) % span
        self._v = v
        for f in self._listeners:
            f()

    def value(self):
        return self._v

    def set(self, value=None, min_val=None, max_val=None, incr=None, reverse=None, range_mode=None):
        if min_val is not None: self._min = min_val
        if max_val is not None: self._max = max_val
        if incr is not None: self._incr = incr
        if reverse is not None: self._dir = -1 if reverse else 1
        if range_mode is not None: self._mode = range_mode
        if value is not None: self._v = value

    def reset(self):
        self._v = 0

    def add_listener(self, f):
        self._listeners.append(f)

    def remove_listener(self, f):
        self._listeners.remove(f)

    def close(self):
        self._clk.irq(None)
`,
  'lib/vga1_8x16.py': '# Font metrics for gc9a01.text (8x8 built-in font scaled 1x2)\nWIDTH = 8\nHEIGHT = 16\n',
  'lib/vga1_bold_16x32.py': '# Font metrics for gc9a01.text (8x8 built-in font scaled 2x4)\nWIDTH = 16\nHEIGHT = 32\n',
};
MPY_LIBS['lib/rotary_irq_esp.py'] = MPY_LIBS['lib/rotary_irq_rp2.py'];
MPY_LIBS['lib/ff.py'] = FF_PY;

// ---------------------------------------------------------------- templates
export function mpyMain(b: BoardDef, comps: CompInstance[]) {
  const P = pinsOf(comps);
  const sda = P('sht40', 'SDA', 4), scl = P('sht40', 'SCL', 5), sck = P('tft', 'SCK', 10), mosi = P('tft', 'MOSI', 11);
  const rot = b.family === 'rp2040' ? 'rotary_irq_rp2' : 'rotary_irq_esp';
  return `# Thermostat firmware: MicroPython on ${b.name}
# Run, then turn the dial and press the display on the 3D model.
# The same files run unchanged on a real board ("Physical board" → Run).
from machine import Pin, SPI, I2C, PWM
from ${rot} import RotaryIRQ
from sht4x import SHT4x
import neopixel, time
import gc9a01, vga1_bold_16x32 as big, vga1_8x16 as small
import ff                                 # mirrors a real board onto the 3D model

dial   = RotaryIRQ(pin_num_clk=${P('encoder', 'CLK', 2)}, pin_num_dt=${P('encoder', 'DT', 3)}, min_val=20, max_val=60,
                   range_mode=RotaryIRQ.RANGE_BOUNDED, pull_up=True)
dial.set(value=44)                        # target = value / 2 -> 22.0 C
btn    = Pin(${P('button', 'SIG', 6)}, Pin.IN, Pin.PULL_UP)    # display press, active low
ring   = neopixel.NeoPixel(Pin(${P('neopixel', 'DIN', 7)}), 24)
sensor = SHT4x(I2C(${busId(b, 'i2c', sda)}, sda=Pin(${sda}), scl=Pin(${scl}), freq=400000))
heat   = Pin(${P('relay', 'IN', 16)}, Pin.OUT, value=0)       # HVAC relay
haptic = Pin(${P('haptic', 'EN', 14)}, Pin.OUT, value=0)
buzz   = PWM(Pin(${P('buzzer', 'SIG', 15)}))
buzz.freq(2400)
buzz.duty_u16(0)
spi    = SPI(${busId(b, 'spi', sck)}, baudrate=40000000, sck=Pin(${sck}), mosi=Pin(${mosi}))
tft    = gc9a01.GC9A01(spi, 240, 240, dc=Pin(${P('tft', 'DC', 12)}, Pin.OUT), cs=Pin(${P('tft', 'CS', 13)}, Pin.OUT))
tft.init()
tft.fill(gc9a01.BLACK)

def click(ms=12):
    buzz.duty_u16(30000)
    haptic.on()
    time.sleep_ms(ms)
    buzz.duty_u16(0)
    haptic.off()

def center(font, s, y, color):
    tft.text(font, s, 120 - len(s) * font.WIDTH // 2, y, color)

eco = False
shown = None
last_read = time.ticks_add(time.ticks_ms(), -5000)
room = 20.0

print("thermostat ready")
while True:
    for ev in ff.events():                # input from the 3D model (real board only)
        if ev[0] == 'enc':
            dial.set(value=max(20, min(60, dial.value() + int(ev[1]))))
        elif ev[0] == 'btn' and ev[1] == '1':
            eco = not eco
    target = dial.value() / 2
    if time.ticks_diff(time.ticks_ms(), last_read) >= 1000:
        room, rh = sensor.measure()
        last_read = time.ticks_ms()

    if btn.value() == 0:                  # pressed
        eco = not eco
        click(40)
        while btn.value() == 0:
            time.sleep_ms(10)

    low = 17.0 if eco else target
    heating = room < low - 0.3
    heat.value(1 if heating else 0)

    if heating:
        color = (255, 90, 20)
    elif room > target + 0.5:
        color = (20, 120, 255)
    else:
        color = (30, 200, 110)
    lit = max(1, min(24, int(abs(target - room) * 6)))
    for i in range(24):
        ring[i] = color if i < lit else (0, 0, 0)
    ring.write()

    now = (target, round(room, 1), eco, heating)
    if now != shown:
        if shown is not None and now[0] != shown[0]:
            click(4)
        tft.fill_rect(40, 56, 160, 120, gc9a01.BLACK)
        center(small, "ECO" if eco else ("HEATING" if heating else "HOLDING"), 62, gc9a01.color565(*color))
        center(big, "%.1f" % target, 100, gc9a01.WHITE)
        center(small, "Room %.1f C" % room, 150, gc9a01.color565(140, 150, 165))
        print("target %.1f  room %.1f  heat %s  eco %s" % (target, room, heating, eco))
        ff.leds([ring[i] for i in range(24)])
        ff.screen("ECO" if eco else ("HEATING" if heating else "HOLDING"), "%.1f" % target, "Room %.1f C" % room)
        shown = now
    time.sleep_ms(20)
`;
}

export function piMain(b: BoardDef, comps: CompInstance[]) {
  const P = pinsOf(comps);
  return `# Thermostat: ${b.name}, Python 3 + gpiozero + smbus2
# Run, then turn the dial and press the display on the 3D model.
from gpiozero import RotaryEncoder, Button, OutputDevice
from smbus2 import SMBus, i2c_msg
import board, neopixel, time

dial   = RotaryEncoder(${P('encoder', 'CLK', 17)}, ${P('encoder', 'DT', 27)}, max_steps=0)
btn    = Button(${P('button', 'SIG', 22)})               # display press, wired to GND
heat   = OutputDevice(${P('relay', 'IN', 23)})           # HVAC relay module
ring   = neopixel.NeoPixel(board.D${P('neopixel', 'DIN', 18)}, 24, brightness=0.4, auto_write=False)
bus    = SMBus(1)                         # SDA = GPIO2, SCL = GPIO3

def read_sht40():
    bus.i2c_rdwr(i2c_msg.write(0x44, [0xFD]))
    time.sleep(0.01)
    msg = i2c_msg.read(0x44, 6)
    bus.i2c_rdwr(msg)
    d = list(msg)
    return -45 + 175 * ((d[0] << 8) | d[1]) / 65535

target = 22.0
eco = False

def rotated():
    global target
    target = 22.0 + dial.steps * 0.5
    print("target", target)

def pressed():
    global eco
    eco = not eco
    print("eco mode", eco)

dial.when_rotated = rotated
btn.when_pressed = pressed

while True:
    room = read_sht40()
    low = 17.0 if eco else target
    heating = room < low - 0.3
    if heating:
        heat.on()
    else:
        heat.off()
    color = (255, 90, 20) if heating else (30, 200, 110)
    lit = max(1, min(24, int(abs(target - room) * 6)))
    for i in range(24):
        ring[i] = color if i < lit else (0, 0, 0)
    ring.show()
    time.sleep(0.5)
`;
}

export function arduinoMain(b: BoardDef, comps: CompInstance[]) {
  const P = pinsOf(comps);
  return `// Thermostat firmware: Arduino C++ on ${b.name}
// Compile & Run, then turn the dial and press the display on the 3D model.
#include <SPI.h>
#include <Wire.h>
#include <Adafruit_NeoPixel.h>
#include "gc9a01_mini.h"

const uint8_t PIN_ENC_A = ${P('encoder', 'CLK', 2)};   // INT0
const uint8_t PIN_ENC_B = ${P('encoder', 'DT', 3)};
const uint8_t PIN_BTN   = ${P('button', 'SIG', 4)};
const uint8_t PIN_RING  = ${P('neopixel', 'DIN', 6)};
const uint8_t PIN_RELAY = ${P('relay', 'IN', 7)};
const uint8_t PIN_HAPTIC= ${P('haptic', 'EN', 8)};
const uint8_t PIN_BUZZ  = ${P('buzzer', 'SIG', 5)};
const uint8_t PIN_DC    = ${P('tft', 'DC', 9)};
const uint8_t PIN_CS    = ${P('tft', 'CS', 10)};

Adafruit_NeoPixel ring(24, PIN_RING, NEO_GRB + NEO_KHZ800);
GC9A01Mini tft(PIN_DC, PIN_CS);

volatile int detents = 44;              // target = detents / 2
void onEncoder() {
  if (digitalRead(PIN_ENC_B)) detents++; else detents--;
  detents = constrain(detents, 20, 60);
}

float readSHT40() {
  Wire.beginTransmission(0x44); Wire.write(0xFD); Wire.endTransmission();
  delay(10);
  Wire.requestFrom(0x44, 6);
  uint8_t d[6]; for (int i = 0; i < 6 && Wire.available(); i++) d[i] = Wire.read();
  return -45.0 + 175.0 * ((d[0] << 8) | d[1]) / 65535.0;
}

void click(int ms) {
  tone(PIN_BUZZ, 2400); digitalWrite(PIN_HAPTIC, HIGH);
  delay(ms);
  noTone(PIN_BUZZ); digitalWrite(PIN_HAPTIC, LOW);
}

bool eco = false;
float room = 20.0, shownTarget = -1, shownRoom = -1;
bool shownEco = false, shownHeat = false;
unsigned long lastRead = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_ENC_A, INPUT_PULLUP); pinMode(PIN_ENC_B, INPUT_PULLUP);
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_RELAY, OUTPUT); pinMode(PIN_HAPTIC, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_A), onEncoder, FALLING);
  Wire.begin();
  ring.begin(); ring.setBrightness(120);
  tft.begin(); tft.fill(0x0000);
  Serial.println(F("thermostat ready"));
}

void loop() {
  float target = detents / 2.0;
  if (millis() - lastRead > 1000) { room = readSHT40(); lastRead = millis(); }

  if (digitalRead(PIN_BTN) == LOW) {
    eco = !eco; click(40);
    while (digitalRead(PIN_BTN) == LOW) delay(10);
  }

  float low = eco ? 17.0 : target;
  bool heating = room < low - 0.3;
  digitalWrite(PIN_RELAY, heating);

  uint32_t color = heating ? ring.Color(255, 90, 20) : (room > target + 0.5 ? ring.Color(20, 120, 255) : ring.Color(30, 200, 110));
  int lit = constrain((int)(fabs(target - room) * 6), 1, 24);
  for (int i = 0; i < 24; i++) ring.setPixelColor(i, i < lit ? color : 0);
  ring.show();

  float r1 = round(room * 10) / 10.0;
  if (target != shownTarget || r1 != shownRoom || eco != shownEco || heating != shownHeat) {
    if (shownTarget >= 0 && target != shownTarget) click(4);
    char buf[16];
    tft.fillRect(40, 56, 160, 120, 0x0000);
    const char *mode = eco ? "ECO" : (heating ? "HEATING" : "HOLDING");
    tft.textCentered(mode, 62, 1, 2, heating ? 0xFAC2 : 0x3E4D);
    dtostrf(target, 4, 1, buf); tft.textCentered(buf, 100, 2, 4, 0xFFFF);
    char rb[8]; dtostrf(room, 4, 1, rb); snprintf(buf, sizeof buf, "Room %s C", rb);
    tft.textCentered(buf, 150, 1, 2, 0x8C94);
    Serial.print(F("target ")); Serial.print(target, 1); Serial.print(F("  room ")); Serial.print(room, 1);
    Serial.print(F("  heat ")); Serial.print(heating); Serial.print(F("  eco ")); Serial.println(eco);
    shownTarget = target; shownRoom = r1; shownEco = eco; shownHeat = heating;
  }
  delay(20);
}
`;
}

export const ARDUINO_LIBS: Record<string, string> = {
  'gc9a01_mini.h': `// Minimal GC9A01 driver for AVR: init, fillRect, scaled 5x7 text. ~1 KB flash.
#pragma once
#include <Arduino.h>
#include <SPI.h>

static const uint8_t FONT5x7[][5] PROGMEM = {
  {0,0,0,0,0},{0,0,0x5f,0,0},{0,7,0,7,0},{0x14,0x7f,0x14,0x7f,0x14},{0x24,0x2a,0x7f,0x2a,0x12},{0x23,0x13,8,0x64,0x62},{0x36,0x49,0x55,0x22,0x50},{0,5,3,0,0},
  {0,0x1c,0x22,0x41,0},{0,0x41,0x22,0x1c,0},{8,0x2a,0x1c,0x2a,8},{8,8,0x3e,8,8},{0,0x50,0x30,0,0},{8,8,8,8,8},{0,0x60,0x60,0,0},{0x20,0x10,8,4,2},
  {0x3e,0x51,0x49,0x45,0x3e},{0,0x42,0x7f,0x40,0},{0x42,0x61,0x51,0x49,0x46},{0x21,0x41,0x45,0x4b,0x31},{0x18,0x14,0x12,0x7f,0x10},{0x27,0x45,0x45,0x45,0x39},{0x3c,0x4a,0x49,0x49,0x30},{1,0x71,9,5,3},
  {0x36,0x49,0x49,0x49,0x36},{6,0x49,0x49,0x29,0x1e},{0,0x36,0x36,0,0},{0,0x56,0x36,0,0},{0,8,0x14,0x22,0x41},{0x14,0x14,0x14,0x14,0x14},{0x41,0x22,0x14,8,0},{2,1,0x51,9,6},
  {0x32,0x49,0x79,0x41,0x3e},{0x7e,0x11,0x11,0x11,0x7e},{0x7f,0x49,0x49,0x49,0x36},{0x3e,0x41,0x41,0x41,0x22},{0x7f,0x41,0x41,0x22,0x1c},{0x7f,0x49,0x49,0x49,0x41},{0x7f,9,9,1,1},{0x3e,0x41,0x41,0x51,0x32},
  {0x7f,8,8,8,0x7f},{0,0x41,0x7f,0x41,0},{0x20,0x40,0x41,0x3f,1},{0x7f,8,0x14,0x22,0x41},{0x7f,0x40,0x40,0x40,0x40},{0x7f,2,4,2,0x7f},{0x7f,4,8,0x10,0x7f},{0x3e,0x41,0x41,0x41,0x3e},
  {0x7f,9,9,9,6},{0x3e,0x41,0x51,0x21,0x5e},{0x7f,9,0x19,0x29,0x46},{0x46,0x49,0x49,0x49,0x31},{1,1,0x7f,1,1},{0x3f,0x40,0x40,0x40,0x3f},{0x1f,0x20,0x40,0x20,0x1f},{0x7f,0x20,0x18,0x20,0x7f},
  {0x63,0x14,8,0x14,0x63},{3,4,0x78,4,3},{0x61,0x51,0x49,0x45,0x43},
};

class GC9A01Mini {
 public:
  GC9A01Mini(uint8_t dc, uint8_t cs) : dc_(dc), cs_(cs) {}
  void begin() {
    pinMode(dc_, OUTPUT); pinMode(cs_, OUTPUT); digitalWrite(cs_, HIGH);
    SPI.begin(); SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
    static const uint8_t init[] PROGMEM = {0xEF,0, 0xEB,1,0x14, 0xFE,0, 0xEF,0, 0x36,1,0x48, 0x3A,1,0x05, 0x21,0, 0x11,0x80, 0x29,0x80, 0};
    const uint8_t *p = init;
    for (;;) {
      uint8_t c = pgm_read_byte(p++); if (!c) break;
      uint8_t n = pgm_read_byte(p++);
      cmd(c);
      for (uint8_t i = 0; i < (n & 0x7f); i++) data(pgm_read_byte(p++));
      if (n & 0x80) delay(120);
    }
  }
  void fill(uint16_t c) { fillRect(0, 0, 240, 240, c); }
  void fillRect(int x, int y, int w, int h, uint16_t c) {
    window(x, y, x + w - 1, y + h - 1);
    digitalWrite(dc_, HIGH); digitalWrite(cs_, LOW);
    for (long i = (long)w * h; i > 0; i--) { SPI.transfer(c >> 8); SPI.transfer(c); }
    digitalWrite(cs_, HIGH);
  }
  void text(const char *s, int x, int y, uint8_t sx, uint8_t sy, uint16_t fg) {
    for (; *s; s++, x += 6 * sx) glyph(*s, x, y, sx, sy, fg);
  }
  void textCentered(const char *s, int y, uint8_t sx, uint8_t sy, uint16_t fg) {
    text(s, 120 - (int)strlen(s) * 3 * sx, y, sx, sy, fg);
  }
 private:
  uint8_t dc_, cs_;
  void cmd(uint8_t c) { digitalWrite(dc_, LOW); digitalWrite(cs_, LOW); SPI.transfer(c); digitalWrite(cs_, HIGH); }
  void data(uint8_t d) { digitalWrite(dc_, HIGH); digitalWrite(cs_, LOW); SPI.transfer(d); digitalWrite(cs_, HIGH); }
  void window(int x0, int y0, int x1, int y1) {
    cmd(0x2A); data(x0 >> 8); data(x0); data(x1 >> 8); data(x1);
    cmd(0x2B); data(y0 >> 8); data(y0); data(y1 >> 8); data(y1);
    cmd(0x2C);
  }
  void glyph(char ch, int x, int y, uint8_t sx, uint8_t sy, uint16_t fg) {
    if (ch >= 'a' && ch <= 'z') ch -= 32;
    if (ch < 32 || ch > 'Z') ch = 32;
    window(x, y, x + 5 * sx - 1, y + 7 * sy - 1);
    digitalWrite(dc_, HIGH); digitalWrite(cs_, LOW);
    for (uint8_t row = 0; row < 7; row++)
      for (uint8_t r = 0; r < sy; r++)
        for (uint8_t col = 0; col < 5; col++) {
          bool on = pgm_read_byte(&FONT5x7[ch - 32][col]) & (1 << row);
          uint16_t c = on ? fg : 0;
          for (uint8_t k = 0; k < sx; k++) { SPI.transfer(c >> 8); SPI.transfer(c); }
        }
    digitalWrite(cs_, HIGH);
  }
};
`,
};

/** Default project files for a board, from the current wiring. */
export function defaultFiles(b: BoardDef, comps: CompInstance[]): Record<string, string> {
  if (b.lang === 'arduino') return { 'thermostat.ino': arduinoMain(b, comps), ...ARDUINO_LIBS };
  if (b.lang === 'python') return { 'main.py': piMain(b, comps) };
  return { 'main.py': mpyMain(b, comps), ...MPY_LIBS };
}

/** Empty starter code for a blank project. */
export function blankFiles(b: BoardDef): Record<string, string> {
  if (b.lang === 'arduino') return { 'sketch.ino': `// ${b.name}\n// Add parts from the left panel, write your code, then Compile & Run.\n\nvoid setup() {\n  Serial.begin(115200);\n  Serial.println("ready");\n}\n\nvoid loop() {\n}\n` };
  return { 'main.py': `# ${b.lang === 'python' ? 'Python' : 'MicroPython'} on ${b.name}\n# Add parts from the left panel, write your code, then press Run.\n\nprint("ready")\n` };
}
