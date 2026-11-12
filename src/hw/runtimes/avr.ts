import {
  CPU, avrInstruction, AVRTimer, timer0Config, timer1Config, timer2Config, AVRIOPort, portBConfig, portCConfig, portDConfig,
  AVRUSART, usart0Config, AVRSPI, spiConfig, AVRTWI, twiConfig, AVRADC, adcConfig, PinState, AVRClock, clockConfig,
} from 'avr8js';
import type { Bench } from '../bench';
import type { I2CTarget, Level, Runtime } from '../types';
import { nextTick, SpeedMeter } from './scheduler';

const FREQ = 16e6;
const NS = 1e9 / FREQ;

/** Parse Intel HEX into AVR program memory. */
export function loadHex(hex: string, target: Uint8Array) {
  let base = 0;
  for (const line of hex.split(/\r?\n/)) {
    if (line[0] !== ':') continue;
    const n = parseInt(line.substr(1, 2), 16), addr = parseInt(line.substr(3, 4), 16), type = parseInt(line.substr(7, 2), 16);
    if (type === 0) for (let i = 0; i < n; i++) target[base + addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
    else if (type === 2) base = parseInt(line.substr(9, 4), 16) << 4;
    else if (type === 4) base = parseInt(line.substr(9, 4), 16) << 16;
  }
}

/** Arduino pin number → [port, bit] on an ATmega328P (Uno/Nano). */
const PINMAP: ['B' | 'C' | 'D', number][] = [
  ['D', 0], ['D', 1], ['D', 2], ['D', 3], ['D', 4], ['D', 5], ['D', 6], ['D', 7],
  ['B', 0], ['B', 1], ['B', 2], ['B', 3], ['B', 4], ['B', 5],
  ['C', 0], ['C', 1], ['C', 2], ['C', 3], ['C', 4], ['C', 5],
];

/**
 * Compiled Arduino firmware on an emulated ATmega328P (avr8js): timers, GPIO,
 * USART, SPI, TWI (I2C) and ADC bridged to the bench. Throttled to real time.
 */
export class AVRRuntime implements Runtime {
  readonly kind = 'avr-emu' as const;
  running = false;
  onSerial: (t: string) => void = () => {};
  onStatus: (s: string) => void = () => {};
  cpu!: CPU;
  private ports!: Record<'B' | 'C' | 'D', AVRIOPort>;
  private usart!: AVRUSART;
  private adc!: AVRADC;
  private rx: number[] = [];
  private wallStart = 0;
  private meter = new SpeedMeter();
  private inputLevel = new Map<number, Level>();

  constructor(private bench: Bench) {}

  async start(files: Record<string, string>) {
    await this.stop();
    const hex = files['firmware.hex'];
    if (!hex) throw new Error('No compiled firmware. Compile the sketch first.');
    const prog = new Uint16Array(0x8000 / 2);
    loadHex(hex, new Uint8Array(prog.buffer));
    const cpu = (this.cpu = new CPU(prog));
    new AVRTimer(cpu, timer0Config); new AVRTimer(cpu, timer1Config); new AVRTimer(cpu, timer2Config);
    new AVRClock(cpu, FREQ, clockConfig);
    this.ports = { B: new AVRIOPort(cpu, portBConfig), C: new AVRIOPort(cpu, portCConfig), D: new AVRIOPort(cpu, portDConfig) };
    const b = this.bench;

    // GPIO → bench, per changed bit
    for (const [name, port] of Object.entries(this.ports) as ['B' | 'C' | 'D', AVRIOPort][]) {
      const pins = PINMAP.map((p, g) => ({ g, p })).filter(x => x.p[0] === name);
      const last = new Map<number, Level>();
      port.addListener(() => {
        for (const { g, p } of pins) {
          const st = port.pinState(p[1]);
          if (st !== PinState.High && st !== PinState.Low) continue;
          const l: Level = st === PinState.High ? 1 : 0;
          if (last.get(g) !== l) { last.set(g, l); b.pin(g, l, cpu.cycles * NS); }
        }
      });
    }

    this.usart = new AVRUSART(cpu, usart0Config, FREQ);
    const dec = new TextDecoder();
    this.usart.onByteTransmit = v => this.onSerial(dec.decode(new Uint8Array([v]), { stream: true }));

    const spi = new AVRSPI(cpu, spiConfig, FREQ);
    spi.onByte = v => { const r = b.spi(13, 11, v); cpu.addClockEvent(() => spi.completeTransfer(r), spi.transferCycles); };

    const twi = new AVRTWI(cpu, twiConfig, FREQ);
    let target: I2CTarget | null = null;
    twi.eventHandler = {
      start: () => twi.completeStart(),
      stop: () => { target?.stop?.(); target = null; twi.completeStop(); },
      connectToSlave: (addr, write) => { target = b.i2c(18, 19, addr); target?.start?.(!write); twi.completeConnect(!!target); },
      writeByte: v => twi.completeWrite(target ? target.write(v) : false),
      readByte: () => twi.completeRead(target ? target.read() : 0xff),
    };

    this.adc = new AVRADC(cpu, adcConfig);
    this.bench.attach(this);
    for (const [g, l] of this.inputLevel) this.setInput(g, l);
    this.running = true;
    this.wallStart = performance.now();
    this.onStatus('running firmware.hex');
    this.loop();
  }

  private loop = () => {
    if (!this.running) return;
    const cpu = this.cpu;
    for (let ch = 0; ch < 6; ch++) this.adc.channelValues[ch] = this.bench.adc(14 + ch);
    while (this.rx.length && !this.usart.rxBusy) this.usart.writeByte(this.rx.shift()!);
    const target = ((performance.now() - this.wallStart) * 1e6) / NS;
    const end = performance.now() + 14;
    let n = 0;
    while (cpu.cycles < target) {
      avrInstruction(cpu);
      cpu.tick();
      if ((++n & 0x3fff) === 0 && performance.now() > end) break;
    }
    const lag = (target - cpu.cycles) * NS;
    if (lag > 200e6) this.wallStart += lag / 1e6 - 100;
    this.meter.sample(cpu.cycles * NS);
    nextTick(this.loop);
  };

  stop() {
    this.running = false;
    if (this.bench.runtime === this) this.bench.attach(null);
  }

  setInput(g: number, level: Level) {
    this.inputLevel.set(g, level);
    const m = PINMAP[g];
    if (m && this.ports) this.ports[m[0]].setPin(m[1], !!level);
  }
  readOutput(g: number): Level {
    const m = PINMAP[g];
    if (!m || !this.ports) return 1;
    const st = this.ports[m[0]].pinState(m[1]);
    if (st === PinState.High) return 1;
    if (st === PinState.Low) return 0;
    return (this.inputLevel.get(g) ?? (st === PinState.InputPullUp ? 1 : 0)) as Level;
  }
  schedule(ns: number, fn: () => void) { this.cpu.addClockEvent(fn, Math.max(1, Math.round(ns / NS))); }
  now() { return this.cpu ? this.cpu.cycles * NS : 0; }
  sendSerial(text: string) { for (const c of new TextEncoder().encode(text)) this.rx.push(c); }
  speed() { return this.meter.ratio; }
}
