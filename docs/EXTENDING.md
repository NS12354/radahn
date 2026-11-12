# Extending Formframe

## Add a component

Components live in `src/hw/library/components.ts`. A component declares its pins, power and cost, and supplies a **device model** that speaks the real protocol to whatever runtime is attached.

```ts
myLight: {
  id: 'myLight', name: 'BH1750 light sensor', category: 'sensor', ui: 'sensor',
  roles: [{ id: 'SDA', kind: 'i2c-sda' }, { id: 'SCL', kind: 'i2c-scl' }],
  rail: '3v3', mA: 0.2, cost: 1.4, i2cAddress: 0x23,
  create: ctx => {
    let lux = 300;
    return {
      state: { get lux() { return lux; } },
      i2c: {
        address: 0x23,
        write: () => true,                     // accept any command byte
        read: (() => { let n = 0; return () => { const raw = Math.round(lux * 1.2); return n++ % 2 ? raw & 0xff : raw >> 8; }; })(),
      },
      sim: { set: (v: number) => { lux = v; } },  // used by bench UI widgets
    };
  },
  checks: (c, x) => [],                        // optional extra electrical rules
},
```

The hooks a model can implement (see `DeviceModel` in `src/hw/types.ts`):

| Hook | Called when | Use for |
|---|---|---|
| `onPin(role, level, tNs)` | the MCU drives a wired pin (incl. PWM/PIO edges) | LEDs, relays, bit-banged protocols (see `WS2812Decoder`) |
| `onSpi(byte)` | a byte is clocked on the SCK/MOSI pair this part is wired to | displays, shift registers; read `ctx.readPin('DC')`/`'CS'` |
| `i2c` | the MCU addresses this part's I2C address on its SDA/SCL pair | sensors, EEPROMs, IO expanders |
| `adc(role)` | an ADC conversion on the wired pin | pots, analog sensors (return volts) |
| `frame(dt)` | every animation frame | decay, latching, painting to the product |
| `ctx.setInput(role, level)` | (you call it) | drive the MCU's input pin; use `ctx.schedule(ns, fn)` for timed waveforms |

Set `binds: 'dial' | 'press' | 'screen' | 'ledRing' | 'ambient' | 'heater' | 'haptic'` to connect the **first** instance of the part to the 3D product. Add a bench widget for the new `ui` kind in `liveHTML()` / `elecFrame()` in `src/ui/elec.ts`.

Write a decoder test in `tests/devices.test.ts`. The decoders are pure, so they're easy to test.

## Add a board

Append a `BoardDef` to `src/hw/library/boards.ts`:

- `runtime`: `'rp2040-emu' | 'avr-emu' | 'sim-python'` (or a new one, see below)
- `gpio`, `adc`, `adc2`, `strap`, `hwPwm`
- `spi` / `i2c`: hardware instances and the pins each can mux to (omit for an ESP32-style free matrix)
- `pinMaxmA`, `pinRecmA`, `rail3v3mA`, `rail5vmA`, `logicV`
- a pin preset for the thermostat kit in `KIT_PRESETS`

The checks, bench, templates and pin pickers all read from the definition.

For an **AVR variant** (Nano, Pro Mini), add it to `BOARDS` in `server/compile.mjs` with the right `mcu`/`variant`, and extend `PINMAP` in `src/hw/runtimes/avr.ts` if the port mapping differs.

## Add a runtime

Implement `Runtime` from `src/hw/types.ts`:

```ts
start(files)               // deploy + run
stop()
setInput(gpio, level)      // the bench drives inputs
readOutput(gpio)           // devices read DC/CS etc.
schedule(ns, fn); now()    // emulated time
sendSerial(text); onSerial // serial monitor
```

Call `bench.attach(this)` on start, then forward peripheral activity with `bench.pin()`, `bench.spi()`, `bench.i2c()` and `bench.adc()`. Register it in `pickRuntime()` in `src/ui/elec.ts`.

Candidates:
- **ESP32 via QEMU.** Espressif's QEMU fork running on the dev server, with GPIO, SPI and I2C bridged over a WebSocket. Replaces the behavioral ESP32 sim with real firmware.
- **RP2350 (Pico 2).** Follow rp2040js upstream when RP2350 support lands.
- **Arduino upload to physical boards.** STK500 over Web Serial (Uno) or `picotool`-style UF2 copy.

## Rebuild MicroPython

```bash
sudo apt install gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib cmake
npm run build:micropython -- v1.24.1
```

To ship frozen modules (drivers baked into firmware), add a `manifest.py` with `FROZEN_MANIFEST=…` in `scripts/build-micropython.sh`.
