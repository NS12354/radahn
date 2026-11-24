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
| Raspberry Pi Pico / Pico W, Seeed XIAO RP2040, Adafruit QT Py RP2040, Adafruit Feather RP2040, Waveshare RP2040-Zero | MicroPython | **Real MicroPython v1.24.1 firmware** on an emulated RP2040 ([rp2040js](https://github.com/wokwi/rp2040js)). GPIO, PWM, PIO, SPI (+DMA), I2C, ADC and USB-CDC are bridged to virtual parts, on every pin the chip can mux them to. | Cycle-level |
| Arduino Uno R3, Arduino Nano, Arduino Pro Mini 5 V | Arduino C++ | Compiled with avr-gcc or arduino-cli, run on an emulated ATmega328P ([avr8js](https://github.com/wokwi/avr8js)). Timers, GPIO, USART, SPI, TWI, ADC. | Cycle-level |
| Raspberry Pi Pico 2 / 2 W | MicroPython | Behavioral simulation (no RP2350 emulator yet). Same pinout and code as the Pico. | Behavioral |
| ESP32 DevKitC, ESP32-S3 DevKitC-1, Seeed XIAO ESP32-S3, Arduino Nano ESP32, ESP32-C3 SuperMini, ESP32-C6, Wemos S2 Mini, NodeMCU / Wemos D1 mini (ESP8266) | MicroPython | Behavioral simulation of the `machine` API (Skulpt). No browser ESP32 emulator exists. Input-only pins, ADC2/Wi-Fi and boot pins are checked. | Behavioral |
| Raspberry Pi 5, 4 B, 3 B+, Zero 2 W | Python 3 | Behavioral simulation of `gpiozero`, `smbus2`, Adafruit `neopixel`. | Behavioral |
| **Physical board** | MicroPython | Any real MicroPython board over **Web Serial**: files written via raw REPL (like `mpremote`), soft reset, serial monitor. `lib/ff.py` mirrors the board onto the 3D model and forwards 3D dial and press input to it. | Real hardware |

Virtual parts speak the real protocols, not mocks. For example, the NeoPixel ring decodes WS2812 timing from pin edges, the GC9A01 decodes SPI `CASET/RASET/RAMWR`, and the SHT40 answers I2C 0x44 with CRC-checked frames. That's why the same `main.py` and drivers run unchanged on a real Pico.

### Parts

43 parts in five groups (search the **Add component** list):

- **Buttons, switches & knobs:** push button, slide switch, limit switch, TTP223 touch, rotary encoder, potentiometer, slide pot, thumb joystick.
- **Sensors:** SHT40, AHT20, TMP36, BH1750 light, MPU-6050 IMU, HC-SR04 ultrasonic, PIR motion, tilt, reed, IR obstacle, LDR, soil moisture, force (FSR), MQ-2 gas.
- **Displays:** GC9A01 round LCD, SSD1306 OLED, 16x2 LCD (I2C backpack), TM1637 7-segment.
- **Lights & sound:** NeoPixel ring, red/green/blue/yellow/white LEDs, RGB LED, laser, piezo buzzer.
- **Motors, relays & power:** SG90 servo, 28BYJ-48 stepper (ULN2003), DC motor (L9110S), fan, pump, relay, solenoid, haptic motor.

Each one has a device model that speaks the real part's protocol:
- the OLED decodes the SSD1306 command set and GDDRAM writes
- the LCD decodes HD44780 nibbles through the PCF8574 backpack
- the 7-segment decodes TM1637 start/stop frames from pin edges
- the stepper counts half steps from the coil pattern
- the HC-SR04 answers a trigger pulse with a timed echo

Displays draw onto the product's screen. Auto build cuts a correctly sized window for them.

In a blank project, adding parts writes a demo program for all of them in the board's language (MicroPython, Python with gpiozero, or Arduino C++). MicroPython drivers (`lib/ssd1306.py`, `lib/i2c_lcd.py`, `lib/tm1637.py`, `lib/hcsr04.py`, `lib/mpu6050.py`, `lib/aht20.py`, `lib/bh1750.py`, `lib/stepper.py`) are added with their part. They are plain MicroPython, so they run on the emulated Pico, in the simulator and on a real board. To add your own board or part, see `src/hw/library/boards.ts`, `components.ts` and `src/hw/devices/parts.ts`.

### Robots

The home screen has five robot templates. Each comes with the 3D model, its joints, the electronics wired to drive them, a world to move in, and firmware:

| Template | Hardware | Firmware |
|---|---|---|
| **Robot arm** | 4 axes + gripper, PCA9685, MG996R/SG90, servo supply | Inverse kinematics (`arm.move_to(x, y, z)`), pick-and-place, plays poses recorded in teach mode. Real MicroPython on the emulated Pico. |
| **Obstacle-avoiding rover** | 2WD, TB6612FNG, HC-SR04, wheel encoders | Drives around a room and backs away from obstacles the sonar sees. |
| **Line follower** | 2WD, two TCRT5000 line sensors | Follows a dark line around a track. |
| **Robot dog** | 12 DS3218 servos on a PCA9685, MPU-6050 | Leg IK, creep gait, turning, IMU balancing. |
| **Hexapod** | 18 MG996R servos on two PCA9685s (0x40, 0x41) | Leg IK, tripod gait, turning. |

How it works (`src/app/kinematics.ts`, `src/app/robot.ts`):

- **Joints.** Any part can be attached to a parent part and given a joint, in the Design inspector under *Robot joint*:
  - A joint can rotate (revolute), slide (prismatic) or spin (wheel).
  - Each joint has an axis, a pivot and limits.
  - It is driven by a servo, a PCA9685 channel, a stepper, a motor, or a motor-driver channel.
  - The firmware's real signals drive the joint. For example, the PCA9685 model decodes the I2C register writes into pulse widths, and those become angles.
  - Joints move at the servo's rated speed.
- **Wheels.** Driven wheel speeds are fitted to a body velocity and turn rate by least squares, which covers both 2WD and skid steer. Walls and obstacles block the body.
- **Legs.** Walking uses a kinematic contact model:
  - Planted feet don't slip.
  - The lowest foot rests on the floor.
  - When the centre of mass leaves the support polygon, the body tips about the edge of its support until another foot lands. If none does, it falls over.
  - A servo only holds about 60% of its stall torque continuously. When the load is higher, the joint sags.
  - This is not a full rigid-body dynamics engine. Fast dynamic gaits such as trotting and running aren't modelled faithfully.
- **Sensors read the world.**
  - The ultrasonic and IR sensors raycast to obstacles and walls.
  - Line sensors read the track under them.
  - The MPU-6050 reads the body's tilt.
  - Wheel encoders count slots as the wheels turn.
- **Teach mode.** While no firmware is running, the Robot panel's sliders move the joints. *Record pose* saves the current pose, and *Use in code* writes the recorded poses into `POSES` in `main.py`.
- **Power checks.** Servos on a PCA9685 are counted against the servo supply (BEC), using each servo's stall current.

**ROS.**
- *Export URDF* writes a URDF in metres, Z up, x forward. It has box/cylinder/sphere geometry, limits and estimated inertia, so it loads in RViz and Gazebo.
- *Import URDF* turns a URDF into parts and joints. Mesh visuals become placeholder boxes.
- The **ROS 2 bridge** connects to `rosbridge_server` (`ros2 launch rosbridge_server rosbridge_websocket_launch.xml`):
  - It publishes `/joint_states` (with the URDF's joint names) and `/formframe/pose`.
  - It listens to `/cmd_vel` (wheeled robots, while no firmware is running) and `/formframe/joint_commands`.

### Looks, physics and the beginner view

**Rendering** (`src/scene/viewport.ts`, `detail.ts`, `photo.ts`):
- Physically based materials, lit by a studio environment of softboxes.
- A key light with soft shadows fitted to whatever is in view, plus a shadow-catching floor.
- Ground-truth ambient occlusion (GTAO) and gentle bloom for LEDs, with ACES tone mapping.
- **⚡ Fast** turns off the post-processing (it's used automatically while an emulator runs).
- **📷 Photo** path-traces the view (three-gpu-pathtracer) into a near-photographic image you can save. It needs a real GPU.

**Detailed models.** Parts can use a detailed model instead of a plain shape (`detail: "servo:mg996r"`, `"pcb:picow"`, `"module:hcsr04"`, …). The models are built procedurally, with no asset files:
- Servos have mounting ears, splined output, horns, labels and leads.
- Wheels have treaded tyres; there are also yellow TT gear motors.
- Circuit boards are styled per board family, with traces, silkscreen, chips, gold header pins and USB.
- Also: HC-SR04, PCA9685 and motor-driver modules, drilled anodised links, battery packs, casters, shells and a camera head.

**Physics** (`src/app/physics.ts`, Rapier) is on for every robot and scene (*Physics: Realistic*):
- Each link is a rigid body, and servos weigh what they really weigh.
- Joints are motors capped at the servo's stall torque, so weak servos sag.
- Wheels get traction from friction. Walking, turning and falling over come from the physics.
- **Objects have weight.** Each object in the world has a material: foam, cardboard box, plastic, wood, metal, or fixed in place. The material sets its weight (from its size, or a set `mass`) and its friction.
  - Robots push light things, stall against heavy ones and can't pass through anything. A 450 g rover shoves a 200 g cardboard box across the room but can't budge a 1.8 kg wooden crate.
  - Grippers hold objects by friction alone.
  - Change a material, or add a box with **+ Box**, in the Robot panel.
- Continuous collision detection stops fast parts tunnelling through thin objects.
- *Off* is a faster ideal-motion model. It ignores weight and lets robots pass through things.

**Crash tests and damage** (`src/app/damage.ts`, `src/app/crash.ts`; Review → *Crash test*).

- **Tests.** Drop a robot or device from any height and orientation (flat, face down, edge, corner …), drive or throw it into a wall, or hit it with an object of any mass and speed. The test plays out in the 3D view.
- **What gets measured.** The physics records three loads for every part, averaged over about 2 ms the way a real impact with some give is:
  - peak contact force (N);
  - deceleration (g);
  - for servo-driven joints, the twist on the gears (N·m).
- **Ratings.** Each part is rated by what it is:
  - display glass and sensor transducers crack;
  - PCB solder joints fail under shock;
  - Li-ion cells dent or puncture, which is flagged as unsafe;
  - enclosures crack, with strength scaling with wall thickness;
  - servo gears strip at about 2.5× (plastic) or 3.5× (metal) stall torque;
  - brackets, wheels and fingers snap off.
- **Damage levels.**
  - Under 50% of a rating, nothing shows.
  - 50–80% is a knock.
  - 80–100% is damaged: it still works, but is weakened.
  - At 100% the part breaks.
  - Repeated knocks add fatigue.
- **What breaks does.** Damage is saved on the model and tinted on it (amber for damaged, red for broken) until **Repair**.
  - Stripped servos go limp.
  - Snapped links fall off.
  - Broken sensors read nothing.
  - A broken board, battery or motor driver means the firmware can't move anything.
- **Live damage.** Robots also take damage from hard collisions while they run; normal driving and walking don't cause any.
- **Calibration examples.**
  - The auto-built thermostat survives 0.3 m. A 1 m flat drop cracks the display glass; 1.5 m face down also weakens the bezel.
  - The robot dog shrugs off 0.3 m; a 1 m drop strips its shoulder servos.
  - A rover bumping a wall at 0.5 m/s is fine.
- The ratings are engineering ballparks for hobby hardware: good for comparing designs and finding weak spots, not for certifying a product.

**Beginner view.**
- **Simple** (the default) hides expert settings: Plan and GitHub, Blender, part import from links, URDF/ROS, mass, and advanced inspector rows. **Advanced** shows everything.
- **▶ Run** in the top bar works from any tab. The code keeps running in Design and Review, so you can watch the robot.
- The **coach** card says what to do next, in plain words. **Show me** points at the right control, and steps tick off as you do them. *Project → Show the coach* brings it back.

### Scenes: several robots in one world

**Scenes** on the home screen put robots from your projects into one shared world, like a digital twin of a cell, a floor or a fleet. `src/app/scene.ts` is the document and `src/app/twin.ts` is the simulator.

- **Copies, not duplicates.** Each robot in a scene points at a robot project in your library, with its own name, position and heading. Add the same design several times (three rovers, two arms), give each copy its own name, and each one runs its own firmware on its own emulated board. *Open in editor* edits the design, and every copy picks up the change the next time the scene opens.
- **One shared world.** All robots share the floor, walls, line track, obstacles and blocks. Any arm can pick up any block, robots bump into each other, and one robot's sonar sees the others. *+ Block* with an arm selected puts a block (and a pad) where that arm's demo reaches.
- **Run together.** *Run all* starts every robot's firmware. Each robot also has its own Run/Stop. The console shows every robot's serial output, labelled by name, with a tab per robot.
- **Arrange.** Drag a robot to move it and Shift-drag to turn it, or type X, Z and heading. Robots can only be moved while stopped. *Reset* puts robots and blocks back where they started.
- **Physics.** *Physics: Realistic* puts the whole scene in one rigid-body world. Robots collide with and push each other and the blocks, grippers hold by friction, and each servo is limited by its torque. It's on by default; *Off* uses the faster ideal-motion model. The setting is saved with the scene; robots' own physics settings don't apply in a scene.
- **Limits.** Every emulated chip (RP2040, ATmega) shares one CPU, so three or more run noticeably slower than real time; a behavioral board (ESP32, Pi) is lighter. Physical boards and the ROS 2 bridge don't join scenes.

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

## GitHub: bring code from your repositories

The **GitHub** tab signs in to GitHub, lists your repositories, and lets you browse any branch and preview files.
Drag a file or a whole folder onto the **Electronics** tab (hovering it opens it) or onto the code panel, or tick files and press **Add to Electronics**.
Files land where the board expects them: on MicroPython boards `main.py`/`code.py` become `main.py` and other `.py` files go in `lib/`; on Arduino a `.ino` replaces the sketch and `.h/.cpp` sit beside it; a `.hex` is used as firmware. You're asked before anything is replaced. Files from your desktop can be dropped the same way.

- **Sign in with GitHub** uses GitHub's device flow: set `GITHUB_CLIENT_ID` in `.env` (an OAuth App with *Enable Device Flow* ticked) and restart.
- Or paste a **personal access token** (`repo` scope, or fine-grained with Contents: read).
- The token is held by the Formframe server in a session tied to an httpOnly cookie; the browser never sees it. Sessions are in memory, so restarting the server signs you out.

## Claude Code in Electronics

In **Electronics**, the **✻ Claude Code** tab beside the Serial monitor runs the real [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI in a terminal. Ask it to write or fix your firmware; files it creates or edits appear in the code tabs as it works (the tab flashes), and edits you make in the editor reach it too. Press **Wide** for a bigger terminal.

- **Wiring and hardware.** The folder also has `wiring.json` (every part on the bench and its pins, as board labels like `GP16`) and `PARTS.md` (the parts and boards Claude can choose from, with each board's pins). Claude edits `wiring.json`:
  - moving pins of parts already on the bench applies straight away;
  - adding or removing parts, or changing the board, shows an **Approve / Decline** card in the Claude panel and changes nothing until you approve (Claude is also told to ask you in the chat first);
  - bad edits (a pin the board doesn't have, an unknown part) are rejected.
  After each edit Formframe rewrites `wiring.json` with what is actually wired and a `_status` line (applied / approved / declined / why it was rejected), so Claude knows the outcome. Every change is logged in the Plan.
- Each project gets its own folder at `~/.formframe/workspaces/<project id>/` holding the project's code plus a generated `CLAUDE.md` (board, language, every wired part and its pins, house rules), so Claude knows what it's coding for. Only code files (`.py`, `.ino`, `.h`, `.cpp`, `.c`) sync back.
- Needs `claude` installed and signed in (`npm install -g @anthropic-ai/claude-code`). Set `CLAUDE_PATH` in the environment if it isn't on your shell's PATH. The first time in each project folder Claude asks whether to trust it.
- It runs commands on the machine running the Formframe server, so the server only accepts terminal connections from this computer (loopback address and same-origin page). It is not for a shared or hosted deployment.
- The terminal uses `node-pty`, a native module. If your npm blocks install scripts, run `npm install-scripts approve node-pty` then `npm rebuild node-pty`.

## Plan: what's done and what's left

The **Plan** tab keeps track of the project:

- **Milestones** tick themselves from the project: parts added, everything wired, code runs without errors, Test it passes, 3D model made, electronics fit the case, model shows the electronics, interactions designed, review comments cleared.
- **Tasks**: your own To do / In progress / Done board. Type a task and press Enter; drag cards between columns; double-click to rename.
- **Activity** records what you do automatically: code runs and crashes, Test it results, compiles, parts added and rewired, board switches, code edits, auto builds, model edits from the 3D modeler or Blender, interactions and review comments.
- **Update with AI** sends Claude the project (parts, wiring, your code, milestones, problems, recent activity and tasks). It marks tasks done only with evidence from the project, records finished work you didn't list, summarizes where things stand, names the next step, and suggests tasks you can add. It runs only when you click, needs `ANTHROPIC_API_KEY`, and **Undo** reverses an update.

The plan is saved inside the project file.

## Testing

```
npm test            # unit tests (the Arduino compile test needs npm run setup:toolchain)
npm run test:e2e    # browser tests: studio, modeler, IDE windows, emulators, Blender link (skipped without Blender)
```

End-to-end tests need Chromium: run `npx playwright install chromium` once, or point `FF_CHROMIUM` at an existing build. CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests, build and browser tests on every push.

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
# radahn
