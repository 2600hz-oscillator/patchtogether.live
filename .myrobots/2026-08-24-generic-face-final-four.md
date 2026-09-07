# The last four `generic-face` modules — verified dispositions (2026-08-24)

Evidence, not instruction. Every claim below was read off `origin/main` @ `99a961b08`;
re-verify before acting, because these verdicts expire exactly like the ones in
`module-faceplates.md` did.

`docs/design/face-migration.generated.md` reports **148 of 198 done**, and of the 152
`generic-face` modules only **four** are not done: `joystick`, `moog960`,
`synesthesia`, `vfpgaRunner`. The other 43 remaining are `bespoke-surface`.

## `joystick` — BLOCKED, and the inventory does not say so

The inventory entry (`face-migration-inventory.ts:346`) is
`disposition: 'generic-face'` with **no blocker**, and its note says *"migrate onto
the shared `xy` cell (#1509 §3)"*. The `xy` cell exists, so the note reads like a
straightforward job. **It is not**, and `module-faceplates.md` STOP 1 already
recorded it as filed rather than shipped (#1974).

Re-verified in code, because that skill also says such verdicts expire:

- `curated-face.ts:131-143` `laneOrder` — a declared `xyPads` entry's **`x` key is
  dock-only** (a pad is square; a lane knob column is 46 px, `--kcol-max`).
- `curated-face.ts:156-161` `foldedOrder` — the pad's **`y` partner is folded away
  at EVERY tier**, dock included, so the dock paints the pad once instead of twice.

joystick's only params are `pos_x` / `pos_y` (`joystick.ts:77-78`). Both keys are
therefore removed before any lane tier renders, so **every lane tier resolves to
zero controls**: a title, a patch panel, and no stick, on a module whose whole
purpose is a performance gesture. Today the un-promoted module shows its legacy
card in the lane, so promotion is a real parity loss, not a cosmetic one.

⚠ **A path exists that does NOT lose parity, and it should be considered before
anyone calls this permanently blocked**: `NON_SHELL_LANE_TYPES`
(`legacy-fallback.ts`) keeps the LEGACY CARD in the lane while the dock full-view
still reads `migrated()` and renders the face. That is exactly the videoOut /
cameraInput precedent — the stick stays operable in the lane, and the dock gets a
real faceplate. It is a design decision with a tradeoff, not a mechanical fix, so
it wants an explicit owner call rather than an agent's judgement.

## `vfpgaRunner` — buildable; STOP 2 is satisfiable

Its card carries a card-only `<select data-testid="vfpga-preset">`
(`VfpgaRunnerCard.svelte:265`) and the header says *"VFPGAs ARE the presets (one
option per spec)"* — i.e. the primary way a program gets into the module. STOP 2
would refuse promotion if that had no shell representation.

It does: `shell-cells.ts` defines `kind: 'selector'`, and **wavesculpt already ships
three `selector` cells plus a `file` cell** (`:580-615`). So the preset dropdown maps
to a `selector` cell and promotion drops nothing. Video module ⇒ also owes the
SCREEN ON/OFF toggle (owner ruling 2026-08-18).

## `moog960` — buildable; the design is settled, the work is not small

36 params: 24 step pots `r{1..3}s{1..8}` (0..1 linear), 3 `range{1..3}`, 8
`mode{1..8}`, and `rate`.

⚠ **`range*` and `mode*` are `0..2 discrete` — the moog962 SELECTABILITY TRAP.**
A 3-state discrete param drawn as a knob has ~two reachable positions across the
whole dial, so a drag quantises back and the control is inert. Each needs an
`options` roster so `paramCellKind` derives a segmented cell.

**The real names are in the def's own `docs.explanation`, so nothing is fabricated:**
- `range{1..3}` → **×1 / ×2 / ×4** (per-row CV scaling)
- `mode{1..8}` → **normal / SKIP / STOP** (SKIP jumps past the step; STOP halts
  holding that column)

Proposed bands — 6 pages, which is **under `DOCK_TAB_MIN_BANDS = 7`, so it renders
untabbed as one column, and that is correct**: do not pad pages to force the rail.

1. `clock` — `rate`
2. `ranges` — `range1..3`
3. `row1` — `r1s1..r1s8`
4. `row2` — `r2s1..r2s8`
5. `row3` — `r3s1..r3s8`
6. `stepmode` — `mode1..8`

Hero: `{ control: 'rate' }` — the one knob a hand rides; it is the only param that
is not part of the grid. ⚠ Page ids must never be `signal` or `voice`
(`rearFieldPlan` renders a colliding id's band twice — the dx7 scar).

Open items the builder still owes:
- **Glyph.** `'scope'` is wrong: it resolves via `glyphBinding` to `live-audio`,
  which needs a primary `audio` output, and moog960 outputs only `cv` + `gate`.
  Pick from `'scope' | 'meter' | 'envelope' | 'waveform' | 'algorithm' | 'none'`
  against what `glyphBinding` actually returns for this def — do not guess.
- **Width.** Eight cells across is a wide plate; compact is the default and width
  must be EARNED, so this needs a NAMED entry in the width gate carrying the thing
  that consumes it (the 8-column step grid IS the sequence).
- Adding `options` to a ParamDef is a **contract change** → `task docs:accept` +
  review the `contract-lock` diff, and ⚠ it can re-rank the module's push card.
- VRT: a face PR touches a shared roster file whose path names no module, so a bare
  `task vrt:commit` derives FULL. Pass `GREP=moog960`.

## `synesthesia` — buildable, largest of the four

~22 params in a symmetric A/B structure (`a_mode`/`b_mode`, `a_bipolar`/`b_bipolar`,
`a_master`/`b_master`, `a_gain1..4`/`b_gain1..4`, `a_envdepth1..4`/`b_envdepth1..4`)
over a large per-band output set (audio / env_slow / env_fast / gate / trig / raster
per band). The four `*_mode` / `*_bipolar` params are `0..1 discrete` — the same
selectability trap, same remedy.

## So the honest remaining count is THREE, not four

…and none of the three is a quick win. "Only 4 generic-face modules left" reads like
an afternoon; it is three substantial faces plus one design decision for the owner.
