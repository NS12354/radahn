/**
 * Sourcing and specification data for the parts in the library: what you'd actually
 * buy. Joined to the behavioural part definitions (components.ts, boards.ts) by id.
 *
 * Honesty rules for this file:
 * - Prices are manually maintained estimates (a low–high range, USD), dated by when they
 *   were entered. They are not live supplier prices, and the UI says so.
 * - A datasheet link is given only where the manufacturer's document is well known.
 * - `confidence` says how much to trust the electrical figures:
 *   'datasheet' = taken from the manufacturer's datasheet; 'estimated' = typical
 *   hobby-module values; nothing here is marked 'verified' until someone checks it
 *   against a supplier listing (then set `verifiedAt`).
 */
export type Confidence = 'verified' | 'datasheet' | 'estimated' | 'unknown';
export type Protocol = 'gpio' | 'pwm' | 'analog' | 'i2c' | 'spi' | 'uart' | 'one-wire' | 'ws2812' | 'usb' | 'power';

export interface SupplierRef { supplier: string; sku?: string; url?: string }
export interface CatalogEntry {
  id: string;
  manufacturer: string;
  /** Manufacturer part number (or the common module name when it's a generic breakout). */
  mpn: string;
  description: string;
  datasheet?: string;
  suppliers: SupplierRef[];
  price?: { low: number; high: number; currency: 'USD'; asOf: string; source: string };
  stock: 'in-stock' | 'limited' | 'unknown';
  /** Board/module outline, mm (width × height × thickness). */
  dims?: [number, number, number];
  mounting?: string;
  /** Supply range (V) and logic level (V). */
  supplyV?: [number, number];
  logicV?: 3.3 | 5 | null;
  /** Typical and peak current (mA) at the supply voltage. */
  typicalmA?: number;
  peakmA?: number;
  protocols: Protocol[];
  i2c?: number[];
  libraries?: string[];
  /** What the simulation models for this part. */
  simulation: string;
  confidence: Confidence;
  sourceNote: string;
  verifiedAt?: string;
  /** Optional in a typical build (e.g. a spare connector). */
  optional?: boolean;
}

const ASOF = '2026-11-25', EST = 'manual estimate (typical hobby-supplier prices; not live)';
const generic = (what: string): SupplierRef[] => [{ supplier: 'Generic module', sku: what }];
const p = (low: number, high: number) => ({ low, high, currency: 'USD' as const, asOf: ASOF, source: EST });

const E: CatalogEntry[] = [
  // ---- boards
  { id: 'picow', manufacturer: 'Raspberry Pi Ltd', mpn: 'SC0918 (Pico W)', description: 'RP2040 board with 2.4 GHz Wi-Fi; Pico (no Wi-Fi) is SC0915.', datasheet: 'https://datasheets.raspberrypi.com/picow/pico-w-datasheet.pdf', suppliers: [{ supplier: 'Raspberry Pi approved resellers', sku: 'SC0918' }], price: p(6, 7), stock: 'unknown', dims: [51, 21, 3.9], mounting: '4 × M2 holes', supplyV: [1.8, 5.5], logicV: 3.3, typicalmA: 25, peakmA: 150, protocols: ['gpio', 'pwm', 'analog', 'i2c', 'spi', 'uart', 'usb'], libraries: ['MicroPython machine', 'Arduino-Pico'], simulation: 'Real MicroPython firmware on an emulated RP2040 (Wi-Fi not simulated).', confidence: 'datasheet', sourceNote: 'Raspberry Pi Pico W datasheet; current is idle-to-busy without Wi-Fi, peak allows for Wi-Fi bursts.' },
  { id: 'pico2w', manufacturer: 'Raspberry Pi Ltd', mpn: 'SC1633 (Pico 2 W)', description: 'RP2350 board with Wi-Fi.', suppliers: [{ supplier: 'Raspberry Pi approved resellers' }], price: p(7, 8), stock: 'unknown', dims: [51, 21, 3.9], supplyV: [1.8, 5.5], logicV: 3.3, typicalmA: 25, peakmA: 150, protocols: ['gpio', 'pwm', 'analog', 'i2c', 'spi', 'uart', 'usb'], simulation: 'Behavioural MicroPython (no RP2350 emulator).', confidence: 'estimated', sourceNote: 'Similar to Pico W; not checked against the Pico 2 W datasheet.' },
  { id: 'esp32', manufacturer: 'Espressif', mpn: 'ESP32-DevKitC-32E', description: 'ESP32-WROOM-32E development board (Wi-Fi + Bluetooth).', datasheet: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/index.html', suppliers: [{ supplier: 'Espressif distributors', sku: 'ESP32-DevKitC-32E' }], price: p(9, 12), stock: 'unknown', dims: [55, 28, 8], mounting: 'Breadboard pins (no holes)', supplyV: [4.75, 5.25], logicV: 3.3, typicalmA: 50, peakmA: 500, protocols: ['gpio', 'pwm', 'analog', 'i2c', 'spi', 'uart', 'usb'], libraries: ['MicroPython machine', 'Arduino-ESP32'], simulation: 'Behavioural MicroPython (machine API); Wi-Fi/Bluetooth not simulated.', confidence: 'estimated', sourceNote: 'Typical with radio idle; Espressif recommends a supply able to deliver 500 mA for Wi-Fi transmit peaks.' },
  { id: 'esp32s3', manufacturer: 'Espressif', mpn: 'ESP32-S3-DevKitC-1', description: 'ESP32-S3 development board.', datasheet: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/index.html', suppliers: [{ supplier: 'Espressif distributors', sku: 'ESP32-S3-DevKitC-1-N8R8' }], price: p(15, 18), stock: 'unknown', supplyV: [4.75, 5.25], logicV: 3.3, typicalmA: 60, peakmA: 500, protocols: ['gpio', 'pwm', 'analog', 'i2c', 'spi', 'uart', 'usb'], simulation: 'Behavioural MicroPython.', confidence: 'estimated', sourceNote: 'Same radio peak guidance as ESP32.' },
  { id: 'uno', manufacturer: 'Arduino', mpn: 'A000066 (Uno R3)', description: 'ATmega328P board.', datasheet: 'https://docs.arduino.cc/hardware/uno-rev3/', suppliers: [{ supplier: 'Arduino Store', sku: 'A000066' }], price: p(27, 28), stock: 'unknown', dims: [68.6, 53.4, 15], mounting: '4 holes', supplyV: [7, 12], logicV: 5, typicalmA: 45, peakmA: 60, protocols: ['gpio', 'pwm', 'analog', 'i2c', 'spi', 'uart', 'usb'], libraries: ['Arduino core'], simulation: 'Real compiled Arduino code on an emulated ATmega328P (needs the local compiler for edited code).', confidence: 'estimated', sourceNote: 'Board draw includes the USB interface chip.' },
  { id: 'nano', manufacturer: 'Arduino', mpn: 'A000005 (Nano)', description: 'ATmega328P compact board.', datasheet: 'https://docs.arduino.cc/hardware/nano/', suppliers: [{ supplier: 'Arduino Store', sku: 'A000005' }], price: p(22, 25), stock: 'unknown', dims: [45, 18, 7], supplyV: [7, 12], logicV: 5, typicalmA: 25, peakmA: 40, protocols: ['gpio', 'pwm', 'analog', 'i2c', 'spi', 'uart', 'usb'], simulation: 'Real compiled Arduino code on an emulated ATmega328P.', confidence: 'estimated', sourceNote: 'Typical hobby figure.' },
  // ---- inputs
  { id: 'encoder', manufacturer: 'Alps Alpine', mpn: 'EC11E18244A5 (or EC11 module)', description: '24-detent incremental encoder with push switch.', suppliers: [{ supplier: 'Digi-Key / Mouser', sku: 'EC11E18244A5' }, ...generic('KY-040 encoder module')], price: p(1, 3), stock: 'unknown', dims: [12, 12, 20], mounting: 'Panel nut, 7 mm thread', supplyV: [0, 5], logicV: null, typicalmA: 0.5, peakmA: 1, protocols: ['gpio'], libraries: ['RotaryIRQ (MicroPython)', 'Encoder (Arduino)'], simulation: 'Quadrature pulses with detents and the push switch.', confidence: 'estimated', sourceNote: 'Passive switch; current is through the pull-ups.' },
  { id: 'button', manufacturer: 'Omron', mpn: 'B3F-1000 (6 mm tactile)', description: 'Momentary push button to GND, internal pull-up.', suppliers: [{ supplier: 'Digi-Key / Mouser', sku: 'B3F-1000' }], price: p(0.1, 0.4), stock: 'unknown', dims: [6, 6, 5], supplyV: [0, 24], logicV: null, typicalmA: 0.1, peakmA: 0.3, protocols: ['gpio'], simulation: 'Press and release, with contact bounce off.', confidence: 'estimated', sourceNote: 'Passive switch.' },
  { id: 'pot', manufacturer: 'Generic', mpn: '10 kΩ rotary potentiometer', description: 'Voltage divider to an ADC pin.', suppliers: generic('10k pot'), price: p(0.3, 1), stock: 'unknown', protocols: ['analog'], typicalmA: 0.33, peakmA: 0.33, logicV: null, simulation: 'Wiper voltage from the slider.', confidence: 'estimated', sourceNote: '3.3 V / 10 kΩ.' },
  { id: 'switch', manufacturer: 'Generic', mpn: 'SPDT slide switch', description: 'Slide switch to GND.', suppliers: generic('SS12D00'), price: p(0.1, 0.3), stock: 'unknown', protocols: ['gpio'], typicalmA: 0.1, logicV: null, simulation: 'On/off.', confidence: 'estimated', sourceNote: 'Passive.' },
  { id: 'touch', manufacturer: 'Generic', mpn: 'TTP223 touch module', description: 'Capacitive touch pad, digital output.', suppliers: generic('TTP223'), price: p(0.3, 1), stock: 'unknown', supplyV: [2, 5.5], logicV: 3.3, typicalmA: 3, peakmA: 3, protocols: ['gpio'], simulation: 'Touch on/off.', confidence: 'estimated', sourceNote: 'Module typical.' },
  { id: 'pir', manufacturer: 'Generic', mpn: 'HC-SR501 PIR module', description: 'Passive-infrared motion sensor (digital out).', suppliers: generic('HC-SR501'), price: p(1, 3), stock: 'unknown', supplyV: [4.5, 20], logicV: 3.3, typicalmA: 0.065, peakmA: 1, protocols: ['gpio'], simulation: 'Motion on/off from the bench.', confidence: 'estimated', sourceNote: 'Module typical (65 µA quiescent).' },
  // ---- sensors
  { id: 'sht40', manufacturer: 'Sensirion', mpn: 'SHT40-AD1B (breakout)', description: '±0.2 °C / ±1.8 %RH temperature and humidity sensor.', datasheet: 'https://sensirion.com/products/catalog/SHT40', suppliers: [{ supplier: 'Adafruit', sku: '4885', url: 'https://www.adafruit.com/product/4885' }], price: p(5, 7), stock: 'unknown', dims: [25, 18, 3], supplyV: [1.08, 3.6], logicV: 3.3, typicalmA: 0.4, peakmA: 0.5, protocols: ['i2c'], i2c: [0x44], libraries: ['sht4x (MicroPython)', 'Adafruit_SHT4x'], simulation: 'I2C measurement commands with CRC; room temperature and humidity from the bench.', confidence: 'datasheet', sourceNote: 'Sensirion SHT4x datasheet (measurement current).' },
  { id: 'aht20', manufacturer: 'Aosong', mpn: 'AHT20 (breakout)', description: 'Temperature and humidity sensor.', suppliers: [{ supplier: 'Adafruit', sku: '4566', url: 'https://www.adafruit.com/product/4566' }], price: p(4, 5), stock: 'unknown', supplyV: [2, 5.5], logicV: 3.3, typicalmA: 0.98, peakmA: 1, protocols: ['i2c'], i2c: [0x38], simulation: 'I2C trigger/read with status byte.', confidence: 'estimated', sourceNote: 'Typical module figure.' },
  { id: 'bh1750', manufacturer: 'ROHM', mpn: 'BH1750FVI (GY-302 module)', description: 'Ambient light sensor, lux output.', suppliers: generic('GY-302 BH1750'), price: p(1.5, 4), stock: 'unknown', supplyV: [3, 5], logicV: 3.3, typicalmA: 0.12, peakmA: 0.19, protocols: ['i2c'], i2c: [0x23, 0x5c], simulation: 'I2C continuous mode; lux from the bench.', confidence: 'datasheet', sourceNote: 'ROHM BH1750FVI datasheet (supply current).' },
  { id: 'ldr', manufacturer: 'Generic', mpn: 'GL5528 LDR + 10 kΩ', description: 'Light-dependent resistor divider.', suppliers: generic('GL5528'), price: p(0.1, 0.5), stock: 'unknown', protocols: ['analog'], typicalmA: 0.3, logicV: null, simulation: 'Divider voltage from the light slider.', confidence: 'estimated', sourceNote: 'Divider current at mid light.' },
  { id: 'tmp36', manufacturer: 'Analog Devices', mpn: 'TMP36GT9Z', description: 'Analog temperature sensor, 10 mV/°C.', suppliers: [{ supplier: 'Digi-Key / Mouser', sku: 'TMP36GT9Z' }], price: p(1.5, 2), stock: 'unknown', supplyV: [2.7, 5.5], logicV: null, typicalmA: 0.05, peakmA: 0.05, protocols: ['analog'], simulation: 'Voltage from the temperature slider.', confidence: 'datasheet', sourceNote: 'ADI TMP35/36/37 datasheet (<50 µA).' },
  { id: 'soil', manufacturer: 'Generic', mpn: 'Capacitive soil moisture sensor v1.2', description: 'Analog moisture probe.', suppliers: generic('Capacitive soil v1.2'), price: p(1, 3), stock: 'unknown', supplyV: [3.3, 5.5], logicV: null, typicalmA: 5, protocols: ['analog'], simulation: 'Voltage from the moisture slider.', confidence: 'estimated', sourceNote: 'Module typical.' },
  { id: 'hcsr04', manufacturer: 'Generic', mpn: 'HC-SR04', description: 'Ultrasonic distance sensor (5 V).', suppliers: generic('HC-SR04'), price: p(1, 3), stock: 'unknown', supplyV: [4.5, 5.5], logicV: 5, typicalmA: 2, peakmA: 15, protocols: ['gpio'], simulation: 'Trigger pulse in, timed echo out.', confidence: 'estimated', sourceNote: 'Module typical; ECHO is 5 V (use a divider on 3.3 V boards).' },
  { id: 'mpu6050', manufacturer: 'TDK InvenSense', mpn: 'MPU-6050 (GY-521 module)', description: '3-axis accelerometer + gyro.', suppliers: generic('GY-521'), price: p(2, 5), stock: 'limited', supplyV: [3, 5], logicV: 3.3, typicalmA: 3.9, peakmA: 4, protocols: ['i2c'], i2c: [0x68, 0x69], simulation: 'Registers for accel/gyro; tilt from the bench.', confidence: 'datasheet', sourceNote: 'MPU-6000/6050 product specification (3.9 mA, accel+gyro). Part is end-of-life; clones common.' },
  // ---- displays
  { id: 'tft', manufacturer: 'Waveshare (GC9A01 controller)', mpn: '1.28inch Round LCD Module', description: '240 × 240 round IPS LCD, SPI.', suppliers: [{ supplier: 'Waveshare', sku: '1.28inch Round LCD Module' }], price: p(10, 14), stock: 'unknown', dims: [38, 38, 4.5], supplyV: [3.3, 5], logicV: 3.3, typicalmA: 20, peakmA: 30, protocols: ['spi'], libraries: ['gc9a01 (MicroPython)', 'TFT_eSPI'], simulation: 'Decodes the SPI command stream (CASET/RASET/RAMWR) into the screen image.', confidence: 'estimated', sourceNote: 'Backlight dominates; brightness-dependent.' },
  { id: 'oled', manufacturer: 'Generic (Solomon SSD1306)', mpn: '0.96" 128×64 I2C OLED', description: 'Monochrome OLED, I2C.', datasheet: 'https://cdn-shop.adafruit.com/datasheets/SSD1306.pdf', suppliers: generic('SSD1306 0.96 I2C'), price: p(3, 6), stock: 'unknown', dims: [27, 27, 4], supplyV: [3.3, 5], logicV: 3.3, typicalmA: 10, peakmA: 25, protocols: ['i2c'], i2c: [0x3c, 0x3d], libraries: ['ssd1306 (MicroPython)', 'Adafruit_SSD1306'], simulation: 'Decodes SSD1306 commands and GDDRAM writes.', confidence: 'estimated', sourceNote: 'Current depends on how many pixels are lit.' },
  { id: 'lcd1602', manufacturer: 'Generic (HD44780 + PCF8574)', mpn: '16×2 LCD with I2C backpack', description: 'Character LCD, 5 V.', suppliers: generic('LCD1602 I2C'), price: p(3, 6), stock: 'unknown', dims: [80, 36, 12], supplyV: [4.5, 5.5], logicV: 5, typicalmA: 25, peakmA: 40, protocols: ['i2c'], i2c: [0x27, 0x3f], simulation: 'Decodes HD44780 nibbles through the PCF8574.', confidence: 'estimated', sourceNote: 'Backlight dominates.' },
  { id: 'tm1637', manufacturer: 'Generic (Titan Micro TM1637)', mpn: '4-digit 7-segment module', description: 'Clock-style display, 2-wire.', suppliers: generic('TM1637 0.56"'), price: p(1, 3), stock: 'unknown', supplyV: [3.3, 5.5], logicV: 3.3, typicalmA: 20, peakmA: 80, protocols: ['gpio'], simulation: 'Decodes start/stop frames from the pin edges.', confidence: 'estimated', sourceNote: 'All segments lit at full brightness ≈ peak.' },
  // ---- outputs
  { id: 'neopixel', manufacturer: 'Adafruit (WS2812B)', mpn: 'NeoPixel Ring 24 × RGB', description: '24 addressable RGB LEDs.', suppliers: [{ supplier: 'Adafruit', sku: '1586', url: 'https://www.adafruit.com/product/1586' }], price: p(15, 18), stock: 'unknown', dims: [66, 66, 3], supplyV: [4, 5.5], logicV: 5, typicalmA: 120, peakmA: 1440, protocols: ['ws2812'], libraries: ['neopixel (MicroPython)', 'Adafruit_NeoPixel'], simulation: 'Decodes WS2812 bit timing from the data pin.', confidence: 'datasheet', sourceNote: 'WS2812B: up to 60 mA per LED at full white (24 × 60 = 1440 mA); typical assumes a dim animation.' },
  { id: 'buzzer', manufacturer: 'Generic', mpn: 'Passive piezo buzzer 12 mm', description: 'Driven by PWM.', suppliers: generic('Passive buzzer 12mm'), price: p(0.2, 1), stock: 'unknown', supplyV: [3, 5], logicV: null, typicalmA: 10, peakmA: 30, protocols: ['pwm'], simulation: 'Plays the PWM frequency through the speakers.', confidence: 'estimated', sourceNote: 'Typical drive.' },
  { id: 'led', manufacturer: 'Generic', mpn: '5 mm LED + 220 Ω', description: 'Indicator LED.', suppliers: generic('5mm LED'), price: p(0.05, 0.2), stock: 'unknown', protocols: ['gpio', 'pwm'], typicalmA: 6, peakmA: 10, logicV: null, simulation: 'On/off and PWM brightness.', confidence: 'estimated', sourceNote: '(3.3 V − 2 V) / 220 Ω.' },
  { id: 'rgbled', manufacturer: 'Generic', mpn: '5 mm RGB LED (common cathode)', description: 'Three-channel LED.', suppliers: generic('RGB LED CC'), price: p(0.1, 0.4), stock: 'unknown', protocols: ['pwm'], typicalmA: 15, peakmA: 30, logicV: null, simulation: 'Colour from three PWM channels.', confidence: 'estimated', sourceNote: '3 × 10 mA max.' },
  { id: 'relay', manufacturer: 'Songle', mpn: 'SRD-05VDC-SL-C (1-channel module)', description: 'Relay module for switching mains/low-voltage loads.', suppliers: generic('1ch 5V relay module'), price: p(1.5, 3), stock: 'unknown', supplyV: [4.5, 5.5], logicV: 3.3, typicalmA: 70, peakmA: 90, protocols: ['gpio'], simulation: 'Coil on/off and contact state.', confidence: 'estimated', sourceNote: 'Coil ≈ 70 mA at 5 V.' },
  { id: 'haptic', manufacturer: 'Generic', mpn: 'LRA/ERM vibration motor + driver', description: 'Haptic feedback.', suppliers: generic('Vibration motor module'), price: p(1, 4), stock: 'unknown', protocols: ['gpio', 'pwm'], typicalmA: 60, peakmA: 100, logicV: 3.3, simulation: 'On/off vibration.', confidence: 'estimated', sourceNote: 'Module typical.' },
  { id: 'servo', manufacturer: 'Tower Pro', mpn: 'SG90', description: '9 g micro servo.', suppliers: generic('SG90'), price: p(1.5, 4), stock: 'unknown', supplyV: [4.8, 6], logicV: 3.3, typicalmA: 100, peakmA: 650, protocols: ['pwm'], simulation: 'Angle from the pulse width, with travel speed.', confidence: 'estimated', sourceNote: 'Stall ≈ 650 mA.' },
];

export const CATALOG: Record<string, CatalogEntry> = Object.fromEntries(E.map(e => [e.id, e]));

/**
 * Power hardware chosen in the product requirements (not wired pin by pin): it adds BOM
 * lines and sets the power budget.
 */
export interface PowerOption { id: string; label: string; volts: number; /** what the source can deliver continuously */ maxmA: number; capacitymAh?: number; parts: CatalogEntry[]; note: string }
export const POWER_OPTIONS: Record<string, PowerOption> = {
  usb: { id: 'usb', label: 'USB 5 V (adapter or computer)', volts: 5, maxmA: 500, parts: [
    { id: 'usb-cable', manufacturer: 'Generic', mpn: 'USB cable (matching the board)', description: 'Power and programming cable.', suppliers: generic('USB cable'), price: p(2, 5), stock: 'unknown', protocols: ['usb', 'power'], simulation: 'Not simulated.', confidence: 'estimated', sourceNote: 'Typical.' },
  ], note: '500 mA assumes a computer USB 2.0 port; a 5 V / 2 A adapter gives more.' },
  'usb-2a': { id: 'usb-2a', label: 'USB 5 V / 2 A wall adapter', volts: 5, maxmA: 2000, parts: [
    { id: 'adapter-5v2a', manufacturer: 'Generic', mpn: '5 V 2 A USB wall adapter', description: 'Wall power.', suppliers: generic('5V 2A adapter'), price: p(5, 10), stock: 'unknown', protocols: ['power'], simulation: 'Not simulated.', confidence: 'estimated', sourceNote: 'Typical.' },
    { id: 'usb-cable', manufacturer: 'Generic', mpn: 'USB cable (matching the board)', description: 'Power cable.', suppliers: generic('USB cable'), price: p(2, 5), stock: 'unknown', protocols: ['usb', 'power'], simulation: 'Not simulated.', confidence: 'estimated', sourceNote: 'Typical.' },
  ], note: 'Adapter rating, not measured.' },
  lipo: { id: 'lipo', label: 'LiPo 1S 1200 mAh + USB charger', volts: 3.7, maxmA: 1000, capacitymAh: 1200, parts: [
    { id: 'lipo-1200', manufacturer: 'Generic', mpn: '3.7 V 1200 mAh LiPo (JST-PH)', description: 'Rechargeable cell with protection circuit.', suppliers: [{ supplier: 'Adafruit', sku: '258', url: 'https://www.adafruit.com/product/258' }], price: p(8, 11), stock: 'unknown', dims: [34, 62, 5], supplyV: [3.0, 4.2], protocols: ['power'], simulation: 'Not simulated (runtime is estimated).', confidence: 'estimated', sourceNote: 'Capacity is nominal; usable capacity is lower.' },
    { id: 'tp4056', manufacturer: 'Generic (NanJing Top Power TP4056)', mpn: 'TP4056 USB-C charger with DW01 protection', description: '1 A single-cell charger with over/under-voltage protection.', suppliers: generic('TP4056 USB-C protected'), price: p(0.5, 2), stock: 'unknown', dims: [26, 17, 4], protocols: ['power'], simulation: 'Not simulated.', confidence: 'estimated', sourceNote: 'Charge current set by a resistor (1 A default on most modules).' },
  ], note: 'The board regulates the cell to 3.3 V (VSYS on Pico, 5 V pin on ESP32 DevKitC is not suitable below ~4.3 V: check your board).' },
};

/** How old a price can be before it's flagged as stale (days). */
export const STALE_DAYS = 180;
