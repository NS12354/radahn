# MVP audit (2026-11-25)

Formframe's promise for the MVP: **catch component, fit, logic, power and cost mistakes before buying materials.** This file records what the repository does today against that promise, what was wrong, and the direction taken. It is kept short on purpose; `ARCHITECTURE.md` covers the emulation internals.

## Current architecture

- **Stack:** Vite + TypeScript, no UI framework. `index.html` holds the studio markup; `src/main.ts` (`FormframeApp`) owns the project, modes and persistence; `src/ui/*` are panels; `src/scene/*` is Three.js (one `Viewport` per workspace); `src/hw/*` is simulation (boards, parts, device models, runtimes, checks); `src/app/*` is domain logic (project format, store, cloud sync, robots, fit, auto build).
- **Project model:** `Project` (`src/app/project.ts`) is the single source of truth: product model (parametric thermostat, imported CAD, or a model built from parts), electronics (board, components with pin assignments, firmware files), interactions (state machine), comments, plan.
- **Simulation:** real firmware on emulated chips (MicroPython on rp2040js, Arduino on avr8js) or a behavioural Python sim (ESP32, Pi). Device models (`src/hw/devices`, `components.ts`) speak real protocols (SPI display, I2C sensors, WS2812 timing). The bench (`src/hw/bench.ts`) connects runtimes to device models; the renderer reads outputs from the bench/product each frame. A separate interaction state machine drives Prototype mode.
- **Persistence:** IndexedDB per browser, optional Supabase account sync (`src/app/cloud.ts`). Since today: explicit Save (no autosave), with a prompt before closing unsaved work.

## Problems found

| Area | Finding | Status |
|---|---|---|
| Renderer | `new THREE.WebGLRenderer` ran unguarded in the app constructor: without WebGL the whole app failed to boot (no navigation). | **Fixed**: capability check, null renderer, notice with retry; app fully usable (e2e `nogl.spec.ts`). |
| Cost | Design's "BOM estimate / Unit cost" is a hard-coded thermostat list (`src/app/internals.ts`: "Main PCB", "LiPo 1200 mAh", injection-moulding tooling) unrelated to the wired parts. Electronics shows a second, separate "dev-kit" total from per-part `cost` numbers with no source or date. | Being replaced by a BOM derived from selected parts with sourced, dated prices. |
| Component data | `ComponentDef` has name, roles, rail, typical/peak mA, logic level, a bare `cost`, I2C address. No manufacturer, part number, datasheet, supplier, price date or confidence. | Catalog metadata layer added (see below). |
| Power | Rail-budget checks exist (`src/hw/checks.ts`) but no transparent estimate (totals, source capacity, battery runtime, assumptions). | Power model added. |
| Validation | Checks are spread across the health panel, fit panel and electrical checks, with one vague "N things to check" status. No not-checked/unsupported states or confidence. | Central validation with statuses and confidence. |
| Fit | Built models check collisions and containment (`src/app/fit.ts`); the parametric thermostat check is a footprint/volume comparison labelled "Fit check". | Labelled by what it actually checks. |
| Models | New built models started with a Housing, so cases appeared uninvited; deleted parts stayed in the 3D view. | **Fixed** today. |
| Navigation | Six peer modes (Design, Prototype, Electronics, Review, Plan, GitHub); Plan and GitHub are already behind "Advanced". | Validate/Build added; Plan/GitHub stay secondary. |
| Export | Download project JSON, firmware export, PNG snapshot. No build package. | Prototype build package added. |

## Target architecture (MVP)

```
catalog (src/hw/library/catalog.ts)   sourcing + specs per part: MPN, datasheet, supplier, dated price, confidence
   │
   ├─ power  (src/app/power.ts)        pure: typical/peak per part, source, regulator, battery runtime range, assumptions
   ├─ bom    (src/app/bom.ts)          pure: lines from selected parts, subtotals, price age/missing flags, CSV
   ├─ checks (src/hw/checks.ts)        pure: pins, I2C, rails, logic levels (existing)
   ├─ fit    (src/app/fit.ts)          pure: collisions, containment (existing)
   └─ validate (src/app/validate.ts)   pure: aggregates everything into categories × status × confidence
            │
            └─ UI: Validate and Build panels (src/ui/validate.ts, src/ui/build.ts), export package (src/app/exportpkg.ts)
```

Simulation stays separate from presentation: device models and runtimes never touch Three.js; the renderer reads bench/product outputs.

## Core domain models

- `Project`: as above.
- `ComponentDef` (behaviour, pins, electrical) + `CatalogEntry` (sourcing, prices, confidence), joined by part id.
- `PowerEstimate`, `Bom`, `ValidationResult { category, status: passed|warning|failed|not-checked|unsupported|estimated, confidence: verified|datasheet|estimated|visual|unsupported, evidence, fix, canSimulate }`.

## Simulation boundaries

- **Firmware-level:** RP2040 boards (real MicroPython), AVR boards (real compiled Arduino, compiler needed locally).
- **Behavioural:** ESP32/ESP8266/Pi: the `machine`/`gpiozero` APIs are simulated, not the chip.
- **Not simulated:** analog circuits beyond simple voltage sliders, RF/Wi-Fi, thermal, structural loads, battery chemistry.

## Known limitations

- Prices are manually maintained snapshots with dates, not live supplier data.
- Power figures are catalog typical/peak values; real draw depends on firmware and duty cycle.
- Fit checks use part bounding boxes; no connector-insertion or tolerance-stack analysis.
- The enclosure is a 3D-printing-oriented shell; nothing here validates injection moulding.
