---
name: module-development
description: How to add a new audio or video module. The 6 shared registry files that need an entry, the def + Card + DSP structure, what tests to add.
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

## The 6 shared registry files — one entry each

This is the critical list. **Auto-merge will silently drop entries here if
your branch is stale** (see `pr-workflow` skill, silent-drop section).

| File | What to add |
|------|-------------|
| `packages/web/src/lib/audio/modules/index.ts` | `import { fooDef } from './foo';` + `registerModule(fooDef);` |
| `packages/web/src/lib/ui/Canvas.svelte` | `import FooCard from '$lib/ui/modules/FooCard.svelte';` + a `{:else if node.type === 'foo'}` case |
| `packages/web/src/lib/ui/module-categories.ts` | An entry in the appropriate category array (`AUDIO_VCOS`, `UTILITIES`, etc.) |
| `packages/web/src/lib/graph/types.ts` | If your module introduces a new cable type, add it. Otherwise add the module's id to the right port-compatibility set. |
| `packages/web/src/lib/audio/modules/vrt-meta.test.ts` | Either an entry confirming VRT coverage, OR an exempt-list entry if your module's render isn't deterministic |
| `packages/web/src/lib/audio/cv-scale-registry.test.ts` | If any of your ports are CV-typed but bypass the standard scale (e.g., V/oct intrinsic), add a `PASSTHROUGH_BY_DESIGN` entry |

If you forget one, things compile but the module won't spawn / render / show
in palette / pass type-checks.

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
