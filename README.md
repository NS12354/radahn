# Formframe

Hardware prototyping studio for product managers, designers and hardware engineers. It combines product form, the on-device UI, interaction logic, **emulated electronics running real firmware**, and design review in one browser canvas, so you can try an idea before you buy parts.

```
Design ─ 3D form (built-in parametric model or your own GLB/STL/STEP), materials, fit check, BOM
Prototype ─ clickable interaction state machine: dial, press, LEDs, haptics, screens
Electronics ─ wire a board + parts, write MicroPython / Arduino / Python, Run.
              The dial, display, LED ring and room sensor on the 3D model ARE the hardware.
Review ─ comments pinned in 3D, saved with the project
```

## Quick start

```bash
npm install               # also copies the Python simulator and STEP importer into public/vendor/
npm run setup:toolchain   # once: arduino-cli, or avr-gcc + ArduinoCore-avr (for compiling sketches)
npm run dev               # http://localhost:5173
npm test                  # unit + end-to-end firmware tests (≈15 s)
npm run build             # static build in dist/ (no compiler: falls back to precompiled examples / .hex upload)
```

Requires Node 20+. Chrome or Edge is recommended (Web Serial and folder save use Chromium APIs).

## What runs where

| Board | Language | How it runs | Fidelity |
|---|---|---|---|
| Raspberry Pi Pico / Pico W | MicroPython | **Real MicroPython v1.24.1 firmware** on an emulated RP2040 ([rp2040js](https://github.com/wokwi/rp2040js)). GPIO, PWM, PIO, SPI (+DMA), I2C, ADC and USB-CDC are bridged to virtual parts. | Cycle-level |
| Arduino Uno R3 | Arduino C++ | Compiled with avr-gcc or arduino-cli, run on an emulated ATmega328P ([avr8js](https://github.com/wokwi/avr8js)). Timers, GPIO, USART, SPI, TWI, ADC. | Cycle-level |
| ESP32-S3, ESP32-C3 | MicroPython | Behavioral simulation of the `machine` API (Skulpt). No browser ESP32 emulator exists. | Behavioral |
| Raspberry Pi 5 / Zero 2 W | Python 3 | Behavioral simulation of `gpiozero`, `smbus2`, Adafruit `neopixel`. | Behavioral |
| **Physical board** | MicroPython | Any real MicroPython board over **Web Serial**: files written via raw REPL (like `mpremote`), soft reset, serial monitor. `lib/ff.py` mirrors the board onto the 3D model and forwards 3D dial and press input to it. | Real hardware |

Virtual parts speak the real protocols, not mocks. For example, the NeoPixel ring decodes WS2812 timing from pin edges, the GC9A01 decodes SPI `CASET/RASET/RAMWR`, and the SHT40 answers I2C 0x44 with CRC-checked frames. That's why the same `main.py` and drivers run unchanged on a real Pico.

### The emulator runs slower than real time

rp2040js typically runs at 0.3–0.5× real time on a laptop, and the speed is shown next to the target selector. Time-based code (`sleep_ms`, `ticks_ms`) uses emulated time, so behavior stays correct, just slower. Wiring and protocol errors show up exactly as on hardware.

### Known emulator limits

- `machine.I2C.scan()` hangs on the RP2040 emulator (rp2040js can't do zero-length probe writes). Address devices directly.
- The emulated RP2040 has no flash filesystem. Library files are loaded as in-memory modules and `main.py` runs from the raw REPL. On a physical board the files are written to flash normally.
- The ESP32 and Pi simulations are behavioral, so ISR latency, Wi-Fi, BLE and timing-exact drivers aren't modeled. Verify on hardware.

## Electrical checks

Rule checks run continuously against the wiring and the selected board:
- pin conflicts (shared I2C allowed), pins that don't exist, strapping pins, USB serial pins
- ADC-capable pins (ADC2 vs Wi-Fi on ESP32; no ADC on the Pi) and hardware PWM pins
- hardware SPI/I2C pin pairs per instance (RP2040 mux table, fixed Uno/Pi pins)
- per-pin drive current, 3V3 and 5 V rail budgets (peak), 3.3 V parts on 5 V logic, WS2812 level shifting, servo supply

At runtime the simulators also flag floating inputs, missing pull-ups, a passive piezo driven with DC, a servo not at 50 Hz, unanswered I2C addresses, SPI traffic with no device, and more. All of these show in amber in the serial monitor.

## Build a model, or auto-build one

There are three ways to get a product model besides the built-in thermostat:

- **Build your own** (Project menu, or the blank-project screen) puts the product together from shapes: boxes, rounded boxes, cylinders, tubes, spheres, tori, cones and flat panels. Move, rotate and resize parts with the handles (W / E / R) or by typing values in mm. Parts can repeat in a line or around a centre, for grilles and grip ribs. Give a part the Dial, Screen, Press or LED role and the electronics drive it. An LED tube or torus can be split into one segment per pixel.
- **Auto build** reads the board and parts wired in Electronics and lays out an enclosure around them using real dimensions (`src/hw/library/physical.ts`). The display, light ring and encoder become one concentric display, ring and dial. Buttons, pots and LEDs get caps, knobs and lenses. The board sits on standoffs at its real mounting holes, moved toward the wall its ports face, with port cutouts. The remaining modules are packed behind it, and sensors, buzzers and relays get vents, grilles or wire entries. Every decision is listed under the button, and the result is ordinary editable parts. Rebuilding replaces the auto parts and keeps the ones you added.
- The **fit check** flags internal parts that collide or stick out of the enclosure. It approximates footprints as boxes, circles and rings, so treat it as a sanity check, not CAD. Cutouts are drawn as dark patches, since there is no boolean geometry.

## 3D Modeler window

**3D Modeler ↗** (top bar) opens the project's built model in a separate, Blender-style window: Z-up viewport, toolbar, outliner, Properties tabs (Scene, Object, Modifiers, Data, Material), N sidebar, Info editor and status bar. Blender's shortcuts work: G/R/S with X/Y/Z axis locks and typed values, Shift+A, Shift+D, X, H, A, M, F2, F3, Z and Shift+S pies, numpad views (or the number row), and middle-mouse or trackpad navigation. Edits sync live with the studio window through browser storage plus a BroadcastChannel. File ▸ Export writes GLB (metres, Y-up) or STL (mm, Z-up).

**Edit Mode** (Tab) edits a part's vertices, edges and faces. Primitives become editable polygon meshes when you start editing; if you leave without changing anything, they go back to being primitives. Keys: 1/2/3 select vertex/edge/face; G/R/S move/rotate/scale with axis locks and typed values; E extrude (along the normal for faces), I inset, Ctrl+R loop cut, F fill, M merge, X delete, Shift+D duplicate, P separate into a new object, L/Ctrl+L select linked, Shift+N recalculate normals. Alt+Z X-ray selects through the surface. In Object mode, Ctrl+J joins objects and Object ▸ Shade Smooth/Flat and Convert to Mesh are available. Meshes are stored normalised to the part's box (`src/scene/mesh.ts`), so fit checks, auto build and the studio treat them like any other part.

## Is it working?

The light next to the project name answers that at a glance: **Working** (green), **N to check** (amber), **N broken** (red), or **Not tested yet**. Click it for the Problems panel:

- Every problem in the project in one list: wiring, code, the running simulation, the 3D model and interactions. Each is in plain language with why it matters and how to fix it (`src/app/explain.ts`). **Fix it** re-wires parts or adds a pull-up for you where that's safe, and **Show me** jumps to the part or the line of code.
- **Test it** runs your code, turns the dial, presses the buttons, moves the knobs and warms the sensor, then reports which parts responded and which never got a signal.
- Parts on the bench get a status dot (getting signals, silent, problem), and the mode tabs get a dot when something there needs attention.
- Errors are explained in the IDE windows too: an Assistant note under Python errors in Thonny, and a hint under each compiler error in the Arduino IDE.

Advice that only matters on real hardware (power budgets, level shifting) shows as tips, so it doesn't turn the light amber.

## Coding like on the real board

In Electronics, the button next to **Run** opens the board's own coding environment in a separate window. The studio keeps running the emulator, the bench and the 3D model, and the window edits files, runs code and shows serial output through it.

- **Raspberry Pi 5 / Zero 2 W** get a Raspberry Pi OS-style desktop: app menu, panel, windows, **Thonny**, a **Terminal** (`ls`, `cd`, `cat`, `python3 main.py`, `pinout` with your wiring, `i2cdetect -y 1`, `raspi-config`, `vcgencmd`…), a **File Manager**, and **Raspberry Pi Configuration**. Its Interfaces tab works: I2C and SPI start off, like on a fresh Pi.
- **Pico / ESP32** (MicroPython) get **Thonny**: Files pane with the device's files, F5 Run, Stop/Restart, and a Shell that is the board's REPL.
- **Arduino Uno** gets an **Arduino IDE 2-style** editor: Verify / Upload, board selector, Sketchbook / Boards / Library Manager, Output, a Serial Monitor (baud rate and line ending; a mismatched baud rate garbles the output, like on hardware), and a Serial Plotter.

Switching boards in the studio switches the window to the matching environment.

## Blender live link

**Blender ↗** in the top bar (or Project ▸ Open in Blender, or File in the 3D modeler) launches your installed Blender with the Formframe add-on (`blender/formframe_link.py`) and links it to the open project through the dev server (`server/blender.mjs`):

- Parts arrive as mesh objects in millimetres, in **Enclosure / Details / Internals** collections, with a material from the part's colour and finish. The 3D View sidebar has a **Formframe** tab where each object's role (Dial, Screen, Press, LED), explode step and finish are set. Linear arrays become an `FF Array` modifier; radial arrays show as preview copies.
- Anything you do in Blender syncs back within about a second: transforms, Edit Mode changes, any modifier (Boolean cut-outs, Bevel, Subdivision…), new objects, deletes, material colours and collection moves. Formframe receives the evaluated mesh.
- Changes made in Formframe sync to Blender. A geometry hash per object means Blender keeps its own base mesh, modifiers and origin unless the shape actually changed on the Formframe side. A primitive nobody edited stays a primitive.
- The studio window has to stay open while linked; it does the syncing. Blender is found at `/Applications/Blender.app` (or set `BLENDER_PATH`). To link a Blender you started yourself, install the add-on from `http://localhost:5173/api/blender/addon` and use Formframe ▸ Choose Project in its sidebar.

## Parts from a link

In Electronics, **Add from a link** takes a product page or datasheet URL. The dev server fetches the page (and a linked datasheet PDF), and Claude (`claude-opus-5-5`, structured output) extracts the pins, supply, logic level, current, I2C address, size, requirements and uses. You review and edit the result, then it becomes a wireable part, saved in the project file and optionally in your parts library. It gets electrical checks, a BOM line, a generic simulated device for its interface (button, analog slider, output, or a bus device that answers at its I2C address), and a physical size for auto build.

This needs `npm run dev` with Anthropic credentials (`ANTHROPIC_API_KEY`, or an `ant auth login` profile). Without them, a regex parser makes a rough, low-confidence guess for you to correct. Links to localhost or private-network addresses are refused.

## CAD import

Drop a **GLB/GLTF, STL or STEP** file on the app (STEP loads [occt-import-js](https://github.com/kovacsv/occt-import-js) WASM on demand). Every mesh appears in **Parts**. Give it a role:

- **Dial**: rotates about its thinnest axis and is driven by the encoder
- **Screen**: gets the display texture (planar UVs generated if missing)
- **Press**: triggers the button
- **LED / light guide**: glows with the NeoPixel colors
- **Hidden**: excluded from rendering and picking

## Project files (Git-friendly)

**Project → Save to folder** (Chrome/Edge) writes:

```
my-thermostat/
  project.formframe.json     # wiring, interactions, materials, comments (pretty JSON, stable keys)
  firmware/main.py           # one file per source file, so diffs are readable
  firmware/lib/*.py
  model/enclosure.step       # the imported CAD, binary
  .gitattributes
```

**Download project** saves a single JSON with everything embedded. The app also autosaves to `localStorage`. The format is documented in `src/app/project.ts` (`format: "formframe"`, `version: 1`).

## Layout

```
src/
  main.ts                 app shell: modes, pointer input, menu, persistence
  app/                    project schema, internals (fit check, BOM)
  scene/                  three.js viewport, parametric product, CAD importer, Product interface
  proto/                  interaction state machine, screens, C++ export
  hw/
    types.ts              BoardDef, ComponentDef, DeviceModel, Runtime
    library/boards.ts     board definitions + pin presets          ← add boards here
    library/components.ts parts + their device models               ← add parts here
    devices/              protocol decoders: WS2812, GC9A01, SHT40, edge timing
    bench.ts              routes pins/SPI/I2C/ADC between runtimes and devices
    checks.ts             electrical design-rule checks
    templates.ts          starter firmware + MicroPython drivers
    repl.ts               MicroPython raw-REPL deployer (emulator + real boards)
    runtimes/             rp2040 · avr · sim-python · serial-device
server/compile.mjs        Arduino compile (arduino-cli or avr-gcc), also a CLI
public/firmware/          MicroPython UF2 as base64 (built from source: npm run build:micropython)
tests/                    vitest: protocol decoders, checks, and end-to-end firmware runs
docs/                     ARCHITECTURE.md, EXTENDING.md
```

See **docs/EXTENDING.md** to add a board, a component, or a runtime.

## License notes

Bundles MicroPython (MIT), rp2040js and avr8js (MIT), Skulpt (MIT/PSF), three.js (MIT), and occt-import-js (LGPL-2.1, loaded as a separate WASM module). The Arduino core and Adafruit_NeoPixel are fetched by `setup:toolchain` (LGPL), not vendored into the build.
