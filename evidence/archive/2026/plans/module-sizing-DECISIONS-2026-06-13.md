# Module sizing / rack — LOCKED DECISIONS (user, 2026-06-13)

Companion to `module-sizing-rack-format.md`. These override/confirm the plan.
(That companion file no longer exists — removed in the 117→40 corpus triage,
**#1175**. This decisions file is now the surviving record.)

> **DECISIONS RECORD. All three phases have since landed; kept because it is the
> only statement of WHY the rack is shaped this way.**
> - **Phase 1 — shipped** as **#759** ("exact Nu module sizing — pixel-perfect
>   rack grid (Phase 1)"). The `size?: RackSize` / `hp?: number` def fields the
>   "Width + grid model" section specifies are live on `NodeDef` in
>   `packages/web/src/lib/graph/types.ts`, with `lib/ui/rack-sizes.ts` as the
>   per-module mapping.
> - **Phase 2 (lock a module to a slot) — shipped**: `node.data.rackLocked` is
>   read in `Canvas.svelte`, and per the decision it is a right-click
>   Lock/Unlock persisted in the patch, not a drag-to-screw affordance.
> - **Phase 3 ("back of rack" — jacks only) — shipped** as the rear-card flip on
>   TAB (**#1169**; `rearView` in `Canvas.svelte`).
> Nothing here is outstanding work — including the "pick the HP unit + the
> common-size set + map each module to an hp" sub-task, which `rack-sizes.ts`
> discharges with a per-module hp. Do not delete: the per-module 1u/3u table and
> the "uniform 3u slot grid + 1u sub-positioning" simplification are user rulings
> that the code implements but does not explain.

## 1. Tall tier = `3u` — CONFIRMED.
`--rack-3u-h = 3 × --rack-1u-h`. 1u = stereoVCA (180px wide, fixed-height token
`--rack-1u-h: 176px`). Phase 1 = HEIGHT only; width stays per-module.

## 2. Per-module tier (overrides the agent's borderline defaults)
| module | tier |
|---|---|
| adsr | **1u** |
| filter | **1u** |
| sequencer | **3u** |
| mixer | **1u** |
| scope | **1u** |
| midiLane | **3u** |
| analogVco | **1u** |
| peaks | **3u** |
| resofilter | **1u** |
| chowkick | **3u** |
| drummergirl | **3u** |
| audioOut | **1u** |
| scoreboard | **1u** |
| cameraInput | **3u** |
| timelorde | **3u** |

(Non-borderline modules follow the agent's plan classification; this table only
pins the ones the user explicitly called.)

## 3. Phase-2 rack model — KEY SIMPLIFICATION
The virtual rack is a uniform grid of **3u-tall slots — NO row differentiation**.
A **1u module is placed inside a 3u slot at one of 3 vertical positions**
(top / middle / bottom third). This removes the need for the "every-Nth-row is
1u" presets entirely (those are superseded). A 3u module fills a whole slot.

→ The agent's Phase-2 row-preset list (every 0 / 1 / other / third / fourth /
single) is DROPPED. Replace with: uniform 3u slot grid + 1u sub-positioning.

## Phase-2 answers (user, 2026-06-13)
- **1u stacking:** a 3u slot holds up to **THREE** 1u modules — one per
  top/middle/bottom third (each third is an independent drop target).
- **Width:** keep per-module width + snap X to a grid, AND introduce a
  Eurorack-style **HP horizontal-size concept**: find a set of **common HP
  sizes** to standardize most modules onto, but UNIQUE hp sizes are fine
  (especially big modules like MIXMSTRS). So width = quantized-to-HP where it
  fits, bespoke where it doesn't.
- **Rack bounds:** infinite canvas + snap to a uniform **3u grid** (no fixed
  rack width; keep free pan/zoom).
- **Migration:** rack is **opt-in**; free-floating stays the default. "Screw
  down" snaps + locks a module into the nearest slot. Existing patches load
  unchanged.

## Width + grid model (user, 2026-06-13) — SUPERSEDES earlier width Q
- **All widths are a multiple of 1u.** The grid unit is a SQUARE **1u × 1u
  tile**. A module is `hp × 1u` wide (hp = integer ≥ 1) and **1u or 3u** tall.
  So the underlying canvas grid snaps to 1u×1u tiles in BOTH axes.
- Token: `--rack-unit` (the square tile, ≈ stereoVCA footprint). 1u-h =
  `--rack-unit`; 3u-h = `calc(3 * --rack-unit)`; width = `calc(hp * --rack-unit)`.
  (Implementation note: pick `--rack-unit` ≈ 180px from stereoVCA; stereoVCA =
  1hp × 1u. Big modules like MIXMSTRS take many hp. Unique hp is fine.)
- `hp?: number` (width in 1u units) added to the def alongside `size?: '1u'|'3u'`.
- Snap-on-screw-down: a module's **screen** (scope/video canvas) ENLARGES or
  CONTRACTS to snap to the grid — **whichever is the SMALLER resize** (round to
  nearest grid line, not always up/down).

## The Lock affordance (user, 2026-06-13)
The ability to LOCK a module to a rack slot is **right-click → "Lock" /
"Unlock"** (NOT a "screw"/drag-to-icon affordance). A locked module can't be
dragged off its slot until unlocked, and the lock state persists in the patch.

## Canvas grid styling (user, 2026-06-13)
The 3u snap grid renders on the canvas as **light dotted lines**, colored from
the active **theme** (e.g. the Matrix theme → green dotted lines). Subtle —
a guide, not a dominant element.
