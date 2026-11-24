// Core hardware types shared by the library, the virtual bench and all runtimes.

export type Level = 0 | 1;
export type Lang = 'micropython' | 'python' | 'arduino';
export type RuntimeKind = 'rp2040-emu' | 'avr-emu' | 'sim-python' | 'serial-device';
export type Family = 'rp2040' | 'rp2350' | 'avr' | 'esp32' | 'esp8266' | 'pi';

/** Things on the 3D product that electronics can drive or be driven by. */
export type ProductRole = 'dial' | 'press' | 'screen' | 'ledRing' | 'ambient' | 'heater' | 'haptic';

export interface PinGroup { sck?: number[]; mosi?: number[]; sda?: number[]; scl?: number[] }

export interface BoardDef {
  id: string;
  name: string;
  chip: string;
  family: Family;
  /** Default runtime used when you press Run. */
  runtime: RuntimeKind;
  lang: Lang;
  /** Accuracy label shown in the UI. */
  fidelity: 'emulated' | 'behavioral';
  pfx: string;
  gpio: number[];
  adc: number[];
  adc2?: number[];
  strap: number[];
  /** Hardware SPI / I2C instances and the pins each can use (index = instance number). */
  spi?: PinGroup[];
  i2c?: PinGroup[];
  hwPwm?: number[];
  /** Pins that can only read (e.g. ESP32 GPIO 34-39). */
  inputOnly?: number[];
  /** MicroPython ADC channel → pin, for boards whose ADC(n) isn't a GPIO number (ESP8266 ADC(0) = A0). */
  adcAlias?: Record<number, number>;
  /** Label override, e.g. AVR digital pins D0..D13, A0..A5. */
  label?: (g: number) => string;
  pinMaxmA: number;
  pinRecmA: number;
  rail3v3mA: number;
  rail5vmA: number;
  logicV: 3.3 | 5;
  cost: number;
  pcb: string;
  notes?: string;
}

export interface RoleDef {
  id: string;
  kind: 'digital-in' | 'digital-out' | 'pwm' | 'analog' | 'spi-sck' | 'spi-mosi' | 'i2c-sda' | 'i2c-scl' | 'data';
}

export interface CompInstance {
  uid: string;
  type: string;
  pins: Record<string, number | null>;
  color: string;
  /** Free-form per-instance settings (pot value, i2c address override...). */
  props?: Record<string, any>;
}

export interface Check { level: 'err' | 'warn' | 'ok'; msg: string; uid?: string }

export interface CheckCtx {
  board: BoardDef;
  comps: CompInstance[];
  pinMap: Map<number, { c: CompInstance; role: string }[]>;
  label: (g: number) => string;
}

export interface Env {
  /** Simulated room temperature (°C) and humidity (%RH), shared with the plant model. */
  roomC: number;
  rh: number;
}

/** Product-side outputs the bench can drive (implemented by the 3D product controller). */
export interface ProductIO {
  screenCanvas(): HTMLCanvasElement | OffscreenCanvas | null;
  screenUpdated(): void;
  setLeds(colors: [number, number, number][] | null): void;
  haptic(on: boolean): void;
}

export interface DeviceCtx {
  comp: CompInstance;
  def: ComponentDef;
  /** Drive an input line (by role) into the MCU. */
  setInput(role: string, level: Level): void;
  /** Schedule fn after `ns` of *emulated* time. */
  schedule(ns: number, fn: () => void): void;
  now(): number;
  product: ProductIO | null;
  isBound(): boolean;
  env: Env;
  /** Board logic voltage: the full-scale voltage for analog sensors. */
  logicV: number;
  log(msg: string, level?: 'w' | 'e'): void;
  readPin(role: string): Level;
}

export interface I2CTarget {
  address: number;
  start?(read: boolean): void;
  write(byte: number): boolean;
  read(): number;
  stop?(): void;
}

export interface DeviceModel {
  /** MCU output changed on a pin wired to `role`. tNs = emulated time. */
  onPin?(role: string, level: Level, tNs: number): void;
  /** One SPI byte clocked out on the bus this device's SCK/MOSI are wired to. Returns MISO. */
  onSpi?(byte: number): number | void;
  i2c?: I2CTarget;
  /** Voltage presented on an analog role. */
  adc?(role: string): number;
  /** High-level hooks used by the behavioral Python runtime. */
  sim?: Record<string, (...args: any[]) => any>;
  /** Native picture of a display (OLED, LCD, 7-segment), redrawn when it changes. */
  view?(): HTMLCanvasElement | OffscreenCanvas | null;
  reset?(): void;
  /** Called every animation frame for decay/visual state. */
  frame?(dtSec: number): void;
  state: Record<string, any>;
}

export interface ComponentDef {
  id: string;
  name: string;
  category: 'input' | 'output' | 'display' | 'sensor' | 'actuator';
  roles: RoleDef[];
  binds?: ProductRole;
  bindLabel?: string;
  rail: '3v3' | '5v' | null;
  mA: number;
  /** Peak current used for power budgeting. */
  peakmA?: number;
  /** Current sourced directly from the GPIO pin. */
  drivemA?: number;
  logic?: 3.3 | 5;
  cost: number;
  i2cAddress?: number;
  ui: 'led' | 'button' | 'encoder' | 'pot' | 'sensor' | 'ring' | 'screen' | 'buzzer' | 'servo' | 'relay' | 'haptic'
    | 'toggle' | 'meter' | 'joystick' | 'rgb' | 'motor' | 'stepper' | 'distance' | 'imu' | 'display';
  /** Library section (defaults from category). */
  group?: string;
  /** LED colour, for indicator LEDs. */
  tint?: string;
  /** What the bench card says when it's on, e.g. "pumping" (relay/motor cards). */
  onText?: string;
  /** Slider on the bench card for analog sensors: a physical value and the voltage it produces. */
  reading?: { label: string; unit: string; min: number; max: number; dflt: number; step?: number; volts?: (x: number, vcc: number) => number };
  /** Fidelity notes shown on the card. */
  note?: string;
  create(ctx: DeviceCtx): DeviceModel;
  checks?(c: CompInstance, ctx: CheckCtx): Check[];
  /** Set on parts imported from a link or defined by hand (see hw/custom.ts). */
  custom?: unknown;
}

export interface Runtime {
  readonly kind: RuntimeKind;
  running: boolean;
  start(files: Record<string, string>, opts?: Record<string, any>): Promise<void>;
  stop(): Promise<void> | void;
  /** Drive an MCU input pin. */
  setInput(gpio: number, level: Level): void;
  readOutput(gpio: number): Level;
  schedule(ns: number, fn: () => void): void;
  now(): number;
  /** Raw bytes typed into the serial monitor. */
  sendSerial(text: string): void;
  onSerial: (text: string) => void;
  onStatus: (s: string) => void;
  /** Emulated-time / wall-time ratio (1 = real time). */
  speed?(): number;
}
