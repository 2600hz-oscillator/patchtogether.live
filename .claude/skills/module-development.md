---
name: module-development
description: How to add a new audio or video module. Glob+palette-driven registration (no shared-registry edits), the def + Card + DSP structure, what tests to add, and the few files still hand-maintained.
---

# Module development

## The shape of a module

A module is a unit on the patch canvas. Audio modules have an AudioWorklet
backend; video modules have a WebGL render pass. Many modules do both.

Per-module files:

- `packages/web/src/lib/audio/modules/<name>.ts` — module **def** (params,
  ports, lifecycle, message handlers). This is the main thread API.
- `packages/web/src/lib/audio/modules/<name>.test.ts` — unit tests for the
  def (ports schema, param ranges, CV scale registry, etc.).
- `packages/web/src/lib/ui/modules/<Name>Card.svelte` — the visible card on
  the canvas. Knobs, sliders, custom UI.
- `packages/dsp/src/<name>.ts` — AudioWorklet processor (audio modules only).
  Top-level files in this directory are auto-built into worklet bundles;
  shared helpers go under `packages/dsp/src/lib/`.
- `e2e/tests/<name>.spec.ts` — E2E coverage (spawn, knob writes, port
  patches, expected pixel outputs).
- ART (optional): `art/scenarios/<name>/...` for audio output regression.
- VRT: `e2e/vrt/__screenshots__/vrt.spec.ts/<platform>/<name>.png` — captured
  by the standard VRT iterator (no per-module spec needed unless your module
  is on the exempt list).

## Registration is glob + palette-driven — NO shared-registry edits

**This is the current model as of PR #551 (`976d1846`).** You no longer hand-edit
a list of shared registry files; the codegen auto-discovers your module. The old
"edit 6 shared files" process is dead — the registry files literally say so in
their headers (`audio/modules/index.ts`: *"GLOB-DRIVEN… Adding a module no longer
requires editing this file."*).

How discovery works:

- **Def auto-registration** — drop `packages/web/src/lib/audio/modules/<name>.ts`
  that `export`s a `<name>Def` (an object carrying `type` + `factory`). It is
  picked up via `import.meta.glob` in `audio/modules/index.ts` (and the parallel
  `meta/modules/index.ts` / `video/modules/index.ts`). **No `import` + no
  `registerModule()` edit.**
- **Palette placement** — the def carries `palette: { top, sub }` (e.g.
  `{ top: 'Audio modules', sub: 'VCOs' }`). `module-categories.ts` reads
  `def.palette` directly; its legacy `MODULE_CATEGORIES` hand-map is now `{}`. A
  unit test asserts every registered def declares a palette, so a forgotten
  palette fails loudly (and the module renders under Uncategorized meanwhile).
- **Card auto-resolution** — `Canvas.svelte` builds `nodeTypes` via
  `buildNodeTypes` from `$lib/ui/modules-card-map`, which globs
  `./modules/*Card.svelte`. By convention `PascalCase(type) + 'Card'` resolves
  the component (e.g. `analogVco → AnalogVcoCard`); for an off-convention name,
  set a `card: 'XyzCard'` field on the def itself (still zero shared-file edits).
  There is **no** `{:else if node.type === 'foo'}` switch — only a `timelorde`
  auto-spawn special-case remains.
- **`graph/types.ts ModuleType`** is an **open branded string**
  (`CoreModuleType | (string & {})`) — every registered module type is valid
  with **no edit** to this file. Only touch it if you introduce a genuinely new
  cable type (the port-compatibility surface).

Run `scripts/new-module.ts` — it already encodes this scaffold.

## The few files still hand-maintained

These are NOT auto-generated; a new module still needs an entry here, and they
remain the cross-PR conflict surface (see `pr-workflow` silent-drop section):

| File | What to add |
|------|-------------|
| `packages/web/src/lib/docs/module-manifest.ts` | A one-line `DESCRIPTIONS[<type>]` entry — **gated by its own unit test**; a new module fails `unit` without it. (Ship real, robust module docs too — not just this one-liner.) |
| `e2e/vrt/vrt-exemptions.ts` | Only if your module's render is non-deterministic (animated 3D, CRT feedback): add `EXEMPT_FROM_VRT` with a reason, or an `EXEMPT_BASELINE_PAIRS` entry for a per-platform baseline that's still pending. |
| `packages/web/src/lib/ui/modules-card-map.test.ts` | Add the new type to `EXPECTED_NODE_TYPES` (the coverage self-test's expected set). |
| `e2e/tests/per-module-per-port*.spec.ts` + the per-port driver lists | Only if your module needs a bespoke driver or a per-port exemption; most modules are auto-enrolled. |

`label:` strings on the def **MUST be lowercase** (the card CSS uppercases for
display) — a guard in `packages/web/src/lib/dev/registry-manifest.test.ts` fails
CI on any uppercase label.

## Adding the module def

The def is a typed object — look at any existing module for shape (`vca.ts`,
`mixer.ts` are minimal; `helm.ts`, `wavesculpt.ts` are full-featured).

Key fields:

- `id` (snake-case, matches filename and CSS class).
- `displayName`, `displayCategory`.
- `inputs`, `outputs` — port arrays with `{id, type, label?}`. `type` is one
  of the cable types declared in `graph/types.ts` (`audio`, `cv`, `gate`,
  `pitch`, `midi`, `video`, etc.).
- `params` — array of `{id, label, defaultValue, min, max, curve, units?}`.
  `curve` is `linear | log | discrete`. `units` is a display string.
- `create()` — the lifecycle: instantiate AudioWorkletNode, set up routing,
  return an API object the Card will use.
- `schemaVersion` — bump on any breaking change to `node.data` shape.
- `card` — points to the `.svelte` component.

## Adding the AudioWorklet processor

In `packages/dsp/src/<name>.ts`. Top-level files are auto-discovered by the
esbuild config; no manual registration. Conventions:

- Register `process()` with `parameters` matching the def's `params`.
- For things that change rarely (button presses, sample-rate changes), use
  `port.onmessage` not AudioParam automation.
- Heavy state goes in module-scope; avoid per-block allocations.
- For shared logic across modules (wavetable interpolation,
  filter coefficients), put helpers in `packages/dsp/src/lib/` — the build
  excludes that subdirectory from worklet entries; helpers get inlined via
  `bundle:true`.

## Card UI

Use the existing `<Knob>`, `<Button>`, etc. primitives. Look at
`HelmCard.svelte` and `WavesculptCard.svelte` for complex layouts; simpler
modules like `VcaCard.svelte` for the minimum.

The card receives `node` (the graph node), `engine` (an AudioContext-bound
reactive store), and `patch` (the full patch state). Read live AudioParam
values via `engine.readParam(node, 'paramId')` — NOT `node.params.paramId`
(which is the user's last knob set, not the CV-summed value).

## Tests

For the module to be considered "done":

- **Unit test** (`<name>.test.ts`): asserts ports schema, param defaults,
  basic def integrity. Existing modules have ~20-40 assertions each.
- **E2E spec** (`e2e/tests/<name>.spec.ts`): spawn the module, write each
  knob, verify each interaction. Use the patch-store harness to verify
  state changes.
- **VRT**: covered automatically by the iterator-based `e2e/vrt/vrt.spec.ts`
  unless your module is exempt — in which case explicitly state the reason
  in `vrt-meta.test.ts`.
- **ART** (audio modules with deterministic DSP): scenario under
  `art/scenarios/<name>/...` that drives the module with a fixed input and
  compares the output buffer against a `.f32` baseline.
- **CV-scale registry**: if your module has CV inputs that use intrinsic
  scaling (e.g., V/oct on a pitch input), add an entry to
  `PASSTHROUGH_BY_DESIGN` in `cv-scale-registry.test.ts`.

## Schema migrations

When you bump `schemaVersion`, add a migration in the patch-loader so
v1-saved patches keep working. If no users have saved a v1 patch (still
pre-launch in many cases), this can be skipped — confirm with the user.

## Naming-rule reminders

- Module files: `kebab-case.ts`.
- Card components: `PascalCase.svelte`.
- Port ids: `snake_case`.
- Param ids: `camelCase`.

(Yes, the mix is inconsistent; it matches existing precedent across the
codebase. Don't introduce a new style.)
