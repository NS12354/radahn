# Architecture

```
            ┌───────────────────────── Product (scene/product.ts) ─────────────────────────┐
            │  ParametricProduct | ImportedProduct (GLB/STL/STEP + role bindings)           │
            │  screen canvas · LED colors · dial angle · press · haptic                     │
            └───────▲───────────────────────────────▲──────────────────────────▲─────────────┘
       setLeds/paint│                      dial/press│(pointer)        ProductIO│
                    │                               │                          │
┌───────────────────┴──────────┐        ┌───────────┴──────────┐   ┌───────────┴───────────┐
│ Bench (hw/bench.ts)          │◀──────▶│ UI (ui/*.ts)         │   │ Interaction SM        │
│ device models per part:      │  sim.* │ bench widgets, code, │   │ (proto/stateMachine)  │
│ encoder · button · GC9A01 ·  │        │ checks, serial       │   │ Prototype mode only   │
│ WS2812 · SHT40 · relay · …   │        └──────────────────────┘   └───────────────────────┘
└──────▲────────▲───────▲──────┘
  pin() │ spi() │ i2c() │ adc()          setInput()/readOutput()/schedule()
┌──────┴────────┴───────┴─────────────────────────────────────────────────────────┐
│ Runtime (hw/runtimes)                                                            │
│  rp2040-emu   rp2040js + MicroPython UF2, USB-CDC raw REPL, real-time throttled  │
│  avr-emu      avr8js + compiled HEX (server/compile.mjs via /api/compile)        │
│  sim-python   Skulpt + Python shims for machine/gpiozero/smbus2/neopixel         │
│  serial-device Web Serial to a real MicroPython board (+ @ff mirror protocol)    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Time

Emulators keep **emulated time** (rp2040js `SimulationClock`, avr8js `cpu.cycles`). The run loop executes in 14 ms wall-clock slices, scheduled via `MessageChannel` (or `setImmediate` in Node), and targets emulated ≈ wall time. When the CPU can't keep up, the wall reference slides so the emulator doesn't spiral. Device models timestamp edges in emulated ns, so WS2812 bit widths and PWM periods are measured correctly however fast the host is.

Input waveforms (encoder quadrature) are scheduled with `runtime.schedule(ns)` in emulated time. The behavioral sim delivers pin edges to Python IRQ handlers at sleep boundaries, along with a **snapshot** of all input levels taken at the edge. That way `dt.value()` inside a CLK ISR reads what a real ISR would.

## SPI on RP2040

MicroPython's `SPI.write` uses DMA. Completing a byte synchronously inside `onTransmit` deadlocks the DMA handshake, so completion is scheduled one byte-time later in emulated time (`dataBits / clockFrequency`), as on hardware.

## Deploying code

Both the emulator and real boards use the raw REPL (`repl.ts`):
- **Emulator:** no flash filesystem, so every non-main `.py` file is executed into an in-memory module registered in `sys.modules`. Then `main.py` streams in raw-REPL exec mode, and Ctrl-C interrupts it.
- **Real board:** files are written to flash with `open().write()` in chunks, then a soft reset runs `main.py`.

## Persistence

`Project` (app/project.ts) is the single source of truth. All edits mutate it and call `app.changed()`, which debounces a `localStorage` autosave. Folder save splits firmware files and the CAD model into sibling files (`@file` references in JSON) for clean Git diffs.

## Testing

`tests/*.e2e.test.ts` boot the real firmware headless in Node: MicroPython on rp2040js, and avr-gcc output on avr8js. They turn the encoder, press the button, and assert on serial output, decoded NeoPixel frames, display SPI traffic and SHT40 reads. Run them after changing any device model or runtime.
