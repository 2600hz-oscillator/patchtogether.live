# Plan: per-module "control color" → passthrough to Control Surface / ElectraControl / Electra One hardware

**Goal (user, 2026-06-11):** every module gets a right-click **"Assign control color"** that sets the
color of *that module's* controls. When those controls are proxied onto a **CONTROL SURFACE** or
**ELECTRACONTROL** module, a **color stripe above each knob** shows the source control's color, so you
can instantly see "what's coming from what." The Electra One **hardware** shows its control bars in the
best RGB565 approximation of that color. The surface/electra modules **must NOT keep their own copy** of
the color — it is **passthrough**: they always read the source module's current color.

## Core architectural principle — color is SOURCE-MODULE state, read live (NOT copied)

The color lives on the **source module** (the module whose knob was sent to a surface). The Control
Surface, ElectraControl card, and the generated Electra preset all **derive** the color from the source
module at render / generate time — exactly the way they already read the source param's live *value*.

- This satisfies "they should not maintain their own copy of that state, it's passthrough data."
- It also serves the goal: the color *identifies the source*, so the SAME control shows the SAME color
  everywhere it appears. A per-binding copy (the obvious-but-wrong design) would let two surfaces show
  different colors for the same source — defeating "see what's coming from what." **Do NOT store color
  on `ControlBinding` / `ControlSurfaceData` / `ElectraControlData`.**

> Deviation note: an exploration pass suggested adding `color?` to `ControlBinding`. We deliberately do
> NOT — that's a copy, not passthrough. Per-control *overrides* (below) are a future layer, still stored
> on the source module, still read as passthrough.

## Scope decisions (v1)

- **Per-MODULE color**, applied to all of that module's controls (the module's "tag color"). The ask is
  "the default color of that module's controls" → one color per module. **Per-control override is a
  future extension** (an optional `controlColors?: Record<paramId,string>` on the source module, read with
  the same passthrough resolver) — not in v1.
- **Default color when unassigned:** see Open Decision A.

---

## Data model

**Storage (source module only):** add an optional field to the source module's node `data`:
- `data.controlColor?: string` — 6-digit uppercase hex (`'529DEC'`), matching the Electra preset format
  (`packages/web/src/lib/electra/types.ts:127`, default `'FFFFFF'`).

Set it with a **safe single-key in-place mutation** via the existing node-data seam (mutate.ts /
`setNodeParam`-style), NOT a spread-reassign — same Y.Doc rule that the control-surface mutators document
(`control-surface.ts:152-178`; the "second send-to-surface" `Type already integrated` bug). It is a
one-time user action (right-click → pick), never a per-frame write, so no update-storm risk
([[cv-modulation-live-store-write-storm]]).

**Resolver (pure, the single source of truth for "what color is this control"):**
```
// $lib/graph/control-color.ts
resolveControlColor(sourceNode): string   // node.data.controlColor ?? defaultColorFor(sourceNode)
defaultColorFor(sourceNode): string       // see Open Decision A
quantizeToRgb565(hex): string             // optional: round-trip so the UI swatch matches hardware
```
Pure + unit-tested. Everything (surface stripe, electra stripe, preset gen) calls `resolveControlColor`.

---

## Phase 1 — data + resolver core (no UI)
- Add `controlColor?` to the node-data type; add `setControlColor(moduleId, hex|null)` mutator (safe
  single-key set / delete) next to the other node-data mutators.
- Implement `$lib/graph/control-color.ts` (`resolveControlColor`, `defaultColorFor`, `quantizeToRgb565`).
- **Unit tests:** resolver returns assigned color; falls back to default when unset; default is stable for
  a given source; hex normalization (uppercase, strip `#`, 6-char) ; rgb565 round-trip sanity.
- No visible change yet.

## Phase 2 — assign UI (module right-click)
- Add **"Assign control color ▸"** to the **module-level** menu `NodeContextMenu.svelte` (NOT the per-knob
  `ControlContextMenu.svelte` — the ask is "modules to have a right click").
- Submenu = a small **curated palette popover** (the 6 Electra quick colors + a few more distinct,
  RGB565-friendly swatches, ~10–12) with a "Reset to default" and (Open Decision B) optionally a custom
  hex / native `<input type=color>`. Picking calls `setControlColor`.
- **Optional but recommended:** show a small color swatch/accent on the **source module card** itself
  (e.g., a dot by the title) so the assignment is visible at the source. Keep it subtle.
- **Tests:** e2e — right-click a module → pick a color → assert `data.controlColor` set; "reset" clears it.

## Phase 3 — passthrough stripes on Control Surface + ElectraControl cards
- **ControlSurfaceCard.svelte:** for each proxied knob, render a **color stripe above the knob**, color =
  `resolveControlColor(patch.nodes[binding.moduleId])` — a LIVE read of the source module (passthrough).
  Add a grid row to `.cs-knob` (`grid-template-rows: <stripe> var(--cs-dial-h) auto auto`, ~line 482-550),
  insert the stripe element before `<Knob>` (~line 317). Re-derives via the existing `cardVersion` Yjs pump.
- **ElectraControlCard.svelte:** same — stripe as first child of `.ec-slot` (~line 186-242 / CSS 298-306),
  color from `resolveControlColor(source)`.
- Because the value is already read passthrough via `resolveSurfaceParam` (ControlSurfaceCard:153-180,
  ElectraControlCard:128-150), the color read sits right beside it — same pattern, no new copy.
- **Tests:** VRT a Control Surface card and an ElectraControl card each holding controls from 2 source
  modules with different colors → two distinct stripes. Passthrough test: change a source module's color →
  the stripe on the surface updates with no stale copy.

## Phase 4 — Electra One hardware passthrough
- Thread the source module's color into preset generation. The generator already sets every control's
  `c.color` (`electra/preset.ts:543-555`, defaulting to `PAGE_COLOR`). Add `color` to `SurfaceBinding`
  (`preset.ts:45-69`) **resolved at build time** in `host.ts buildLiveGenInput` (~:90-113) via
  `resolveControlColor(sourceNode)`, then in preset.ts: `c.color = b.color ?? PAGE_COLOR[...] ?? 'FFFFFF'`.
  (Still passthrough — the color is resolved from the source module each time the preset is regenerated,
  which the host already does on change. Nothing is stored on the Electra node.)
- Device converts 24-bit hex → RGB565 itself → the control "bars" appear in ~that color. **Don't overthink
  the conversion** (the firmware owns it); optionally pre-`quantizeToRgb565` the UI swatch so on-screen
  matches hardware ("do our best").
- **Tests:** unit-test the pure generator — a binding whose source module has `controlColor='F45C51'`
  emits an Electra control with `color:'F45C51'`; unset → falls back to the page default. (Hardware itself
  can't be e2e'd; the generator is the gate.)

## Phase 5 — tests + docs
- Integration/passthrough test: assign color on source → assert (a) surface stripe, (b) electra stripe,
  (c) generated preset `c.color` all reflect it; change it → all three update; **nothing** is stored on the
  binding/surface/electra node (grep the persisted data to prove no copy).
- 3×-flake-check new e2e/VRT. `task typecheck`. Module docs note the feature.
- VRT/`webgl`-unrelated, but the surface/electra cards have VRT baselines → regenerate (linux+darwin).

---

## Locked decisions (user, 2026-06-11)

**A. Default color = AUTO, distinct per module.** `defaultColorFor(sourceNode)` derives a stable, distinct
hue from a hash of the module id (per *instance*, so two of the same module type are still distinguishable)
→ HSL→hex, snapped to be RGB565-legible. So controls are instantly colour-coded by source the moment they
land on a surface, and "Assign control color" just overrides. (Unit-test: stable for a given id, well
spread across hues, never near-white/near-black.)

**B. Picker = curated palette + custom hex.** Palette popover = ~10–12 distinct RGB565-friendly swatches
(Electra's 6 quick colors + a few) + a **custom hex / `<input type=color>`** + "Reset to default". The
custom path shows a `quantizeToRgb565` preview swatch so the user sees what the hardware will actually
render.

**C. Granularity = per-module only (v1).** One color per module → all its controls. Per-knob override is a
deferred follow-up (optional `data.controlColors?: Record<paramId,string>` on the source, resolved by the
same passthrough resolver — `resolveControlColor(node, paramId?)`). Build the resolver with an optional
`paramId` arg now so the override layer drops in later with no refactor.

**D. Show the color on the source module card = YES.** Small subtle swatch/dot by the source module's
title so the assignment is visible where it's set, not only on the surface.

## Risks / notes
- VRT baselines for ControlSurfaceCard + ElectraControlCard will change (new stripe) → regenerate on both
  OSes via the VRT update workflow.
- RGB565 banding: some pastel/low-sat colors collapse on the device (forum: "colors in RGB565"). The
  curated palette (Decision B) sidesteps this; if custom hex is allowed, the quantized swatch preview warns
  the user what they'll actually get.
- Keep the color OFF the binding/surface/electra persisted data (passthrough). A test should assert this so
  a future contributor doesn't "optimize" it into a copy.
- ElectraControl positional grid: color travels with the *resolved source*, not the slot, so the
  row-major↔control-set translation (`host.ts electraPosOfSlot`) is unaffected.
