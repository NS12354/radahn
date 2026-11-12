import { RP2040, Simulator, USBCDC, ConsoleLogger, LogLevel, GPIOPinState, I2CMode } from 'rp2040js';
type SimulationClock = Simulator['clock'];
import { bootromB1 } from '../emu/rp2040/bootrom';
import type { Bench } from '../bench';
import type { I2CTarget, Level, Runtime } from '../types';
import { RawRepl } from '../repl';
import { BOARDS } from '../library/boards';
import { nextTick, SpeedMeter } from './scheduler';

const FUNC_SPI = 1, FUNC_I2C = 3;

export function loadUF2(mcu: RP2040, uf2: Uint8Array) {
  for (let o = 0; o + 512 <= uf2.length; o += 512) {
    const dv = new DataView(uf2.buffer, uf2.byteOffset + o, 512);
    if (dv.getUint32(0, true) !== 0x0a324655 || dv.getUint32(4, true) !== 0x9e5d5157) continue;
    const addr = dv.getUint32(12, true), size = dv.getUint32(16, true);
    mcu.flash.set(uf2.subarray(o + 32, o + 32 + size), addr - 0x10000000);
  }
}

/**
 * Real MicroPython on an emulated RP2040 (rp2040js). Peripherals are bridged
 * to the bench: GPIO edges (incl. PWM/PIO), SPI bytes, I2C transactions, ADC.
 * Runs throttled to real time; code is deployed over the raw REPL like mpremote.
 */
export class RP2040Runtime implements Runtime {
  readonly kind = 'rp2040-emu' as const;
  running = false;
  onSerial: (t: string) => void = () => {};
  onStatus: (s: string) => void = () => {};
  onExit: (err: string) => void = () => {};
  mcu!: RP2040;
  clock!: SimulationClock;
  private cdc!: USBCDC;
  private txQueue: number[] = [];
  private wallStart = 0;
  private emuStart = 0;
  private repl: RawRepl | null = null;
  private deploying = false;
  private dec = new TextDecoder();
  private meter = new SpeedMeter();
  private unsub: (() => void)[] = [];

  constructor(private bench: Bench, private firmware: () => Promise<Uint8Array>) {}

  async start(files: Record<string, string>) {
    await this.stop();
    const uf2 = await this.firmware();
    const sim = new Simulator();
    this.clock = sim.clock;
    const mcu = (this.mcu = sim.rp2040);
    mcu.loadBootrom(bootromB1);
    mcu.logger = new ConsoleLogger(LogLevel.Error);
    loadUF2(mcu, uf2);
    this.wirePeripherals();
    this.bench.attach(this);

    this.cdc = new USBCDC(mcu.usbCtrl);
    const connected = new Promise<void>(res => (this.cdc.onDeviceConnected = () => res()));
    this.cdc.onSerialData = bytes => {
      const t = this.dec.decode(bytes, { stream: true });
      this.repl?.feed(t);
      if (!this.deploying) this.onSerial(t);
    };

    mcu.core.PC = 0x10000000;
    this.running = true;
    this.wallStart = performance.now(); this.emuStart = 0;
    this.loop();
    this.onStatus('booting MicroPython…');
    await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('MicroPython did not enumerate USB within 30 s')), 30000))]);

    this.repl = new RawRepl({ write: s => this.sendSerial(s) });
    this.deploying = true;
    try {
      await this.repl.runInRam(files, m => this.onStatus(m), err => {
        if (!this.running) return;
        if (err) this.onSerial('\r\n' + err.replace(/\x04/g, '') + '\r\n');
        this.onStatus(err ? 'program crashed' : 'program finished');
        this.onExit(err);
      });
    } finally { this.deploying = false; }
    this.onStatus('running main.py');
  }

  private wirePeripherals() {
    const mcu = this.mcu, b = this.bench;
    // GPIO: every output change → bench (catches SIO, PWM and PIO driven pins)
    mcu.gpio.forEach((pin, g) => {
      this.unsub.push(pin.addListener(state => {
        if (state === GPIOPinState.High) b.pin(g, 1, this.clock.nanos);
        else if (state === GPIOPinState.Low) b.pin(g, 0, this.clock.nanos);
      }));
    });
    const board = BOARDS.picow;
    const muxed = (pins: number[] | undefined, fn: number) => pins?.find(p => mcu.gpio[p].functionSelect === fn) ?? -1;
    mcu.spi.forEach((spi, i) => {
      // Complete each byte after its real transfer time (async, like the hardware):
      // MicroPython's SPI.write uses DMA, which deadlocks on synchronous completion.
      let rx = 0xff;
      const done = this.clock.createAlarm(() => spi.completeTransmit(rx));
      spi.onTransmit = v => {
        const sck = muxed(board.spi![i].sck, FUNC_SPI), mosi = muxed(board.spi![i].mosi, FUNC_SPI);
        rx = b.spi(sck, mosi, v);
        const hz = spi.clockFrequency || 1e6;
        done.schedule(Math.max(20, (spi.dataBits * 1e9) / hz));
      };
    });
    mcu.i2c.forEach((i2c, i) => {
      let target: I2CTarget | null = null;
      i2c.onStart = () => i2c.completeStart();
      i2c.onConnect = (addr, mode) => {
        const sda = muxed(board.i2c![i].sda, FUNC_I2C), scl = muxed(board.i2c![i].scl, FUNC_I2C);
        target = b.i2c(sda, scl, addr);
        target?.start?.(mode === I2CMode.Read);
        i2c.completeConnect(!!target);
      };
      i2c.onWriteByte = v => i2c.completeWrite(target ? target.write(v) : false);
      i2c.onReadByte = () => i2c.completeRead(target ? target.read() : 0xff);
      i2c.onStop = () => { target?.stop?.(); target = null; i2c.completeStop(); };
    });
    mcu.adc.onADCRead = ch => {
      const v = ch < 4 ? b.adc(26 + ch) : 0.706 - (25 - 27) * 0.001721; // ch4 = on-die temp sensor
      mcu.adc.completeADCRead(Math.max(0, Math.min(4095, Math.round((v / 3.3) * 4095))), false);
    };
  }

  /** Execute in ~8 ms wall-clock slices, keeping emulated time ≈ real time. */
  private loop = () => {
    if (!this.running) return;
    const mcu = this.mcu, clock = this.clock;
    const sliceEnd = performance.now() + 14;
    const target = (performance.now() - this.wallStart) * 1e6;
    const cycleNs = 1e9 / 125e6;
    // drain serial input with flow control (CDC FIFO holds 512 bytes)
    while (this.txQueue.length && this.cdc && this.cdc.txFIFO.itemCount < 400) this.cdc.sendSerialByte(this.txQueue.shift()!);
    let n = 0;
    while (clock.nanos < target) {
      if (mcu.core.waiting) {
        const dt = Math.min(clock.nanosToNextAlarm, target - clock.nanos);
        if (dt <= 0) break;
        clock.tick(dt);
      } else {
        clock.tick(mcu.core.executeInstruction() * cycleNs);
      }
      if ((++n & 0xfff) === 0) {
        if (performance.now() > sliceEnd) break;
        while (this.txQueue.length && this.cdc.txFIFO.itemCount < 400) this.cdc.sendSerialByte(this.txQueue.shift()!);
      }
    }
    // if the emulator can't keep up, slide the wall reference so we don't spiral
    const lag = target - clock.nanos;
    if (lag > 200e6) this.wallStart += lag / 1e6 - 100;
    this.meter.sample(clock.nanos);
    nextTick(this.loop);
  };

  async stop() {
    this.running = false;
    this.repl?.cancelAll(); this.repl = null;
    this.unsub.forEach(u => u()); this.unsub = [];
    this.txQueue = [];
    if (this.bench.runtime === this) this.bench.attach(null);
  }

  /** Send Ctrl-C to the running program (like pressing Ctrl-C in a terminal). */
  interrupt() { this.sendSerial('\x03'); }
  /** Soft reset: re-runs main.py without reloading files. */
  softReset() { this.sendSerial('\x04'); }

  setInput(g: number, level: Level) { this.mcu?.gpio[g]?.setInputValue(!!level); }
  readOutput(g: number): Level {
    const p = this.mcu?.gpio[g];
    if (!p) return 1;
    return (p.outputEnable ? p.outputValue : p.inputValue) ? 1 : 0;
  }
  schedule(ns: number, fn: () => void) { const a = this.clock.createAlarm(fn); a.schedule(ns); }
  now() { return this.clock ? this.clock.nanos : 0; }
  sendSerial(text: string) { for (const ch of new TextEncoder().encode(text)) this.txQueue.push(ch); }
  speed() { return this.meter.ratio; }
}
