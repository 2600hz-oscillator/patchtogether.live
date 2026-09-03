# S2 progress ledger — the e2e inversion

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md). IN PROGRESS.
**Branch:** `feat/legacy-removal`, S2 begins at `8e1b705e6` (S1.5 close).
**Baseline collection:** `Total: 3077 tests in 506 files` (verified at S2 start).
**This file is the resume point.** A successor reads this top-to-bottom, then the
category table, then picks up at the first unchecked row. Re-derive before
trusting: `scratchpad/s2-derive.mjs` (method = S0 §M2 + §X literal-strip trap)
regenerates every number.

## The denominator at S2 start (re-derived, S0 method)

| | count |
|---|---:|
| spec files total | 553 |
| explicit `shell=legacy` (non-comment) | 311 |
| fixture-implicit (`rack` destructure, zero legacy text) | 113 |
| DENOMINATOR | 424 |
| family (b) card DOM | 157 (126 direct + 31 via helper) |
| family (a) URL-only | 267 |
| — of (a): EXPL URL-flip pool (non-VRT, non-DOOM) | 171 |
| VRT members (S3's, excluded from S2 except S2(c) consumers) | 32 |
| DOOM members in denominator | **14** (see correction below) |
| parked (`test.fixme`) files in denominator | 50 |

⚠ **DOOM count correction:** the plan/brief say "re-point 15". Measured: 16 doom
spec files exist; `face-doom.spec.ts` AND `doom-session-survives-card-collapse.spec.ts`
both boot `/rack?seed=none` already; `_doom-helpers.ts` carries no legacy URL.
**Exactly 14 doom files navigate `?shell=legacy`** — the plan's "15 of 15" sentence
was internally inconsistent with its own named exception. The S2(d) sub-slice is
14 re-points; session-survives needs nothing (as the plan states).

## ⚠ THE THIRD BLIND SPOT (new, found by the flip batch — not in S0/§X)

`.svelte-flow__node-<type>` selectors are SHELL-COUPLED. xyflow stamps the node
wrapper class from the EMITTED node type: legacy emits the module type
(`.svelte-flow__node-backdraft`), the default shell emits `moduleShell` for every
lane node (`emittedTypeFor` in `legacy-fallback.ts`) — so every per-type node
class matches NOTHING on the default shell. S0's classifier called these
"URL-only"; they are not. Measured: 53 of the 113 fixture-implicit files and 57
of the 171 explicit URL-flip pool carry the pattern.

**The shell-agnostic recipe** (from `face-clipplayer.spec.ts` + ModuleShell root):
- by node id: `.svelte-flow__node[data-id="${id}"]` (wrapper) /
  `…[data-id] [data-testid="module-shell"]` (tile)
- by type: `[data-testid="module-shell"][data-shell-type="<type>"]` (tile) or
  `.svelte-flow__node:has([data-shell-type="<type>"])` (wrapper, keeps
  descendant/count/bbox semantics)
- module-internal control DOM: face/surface testids, or dock full view via
  `shell-open-dock` → `dock-full-view`.

Helpers are clean of the pattern except `_card-overflow.ts` (card-DOM helper,
dies later) and `_toybox-fixture-helpers.ts` (toybox = family (b) anyway).

⚠ **The `:has` rewrite INVERTS negative card-absence assertions.** A leg that
asserts `.svelte-flow__node-<type>` has count 0 ("no CARD is mounted") is
CORRECT with the per-type class — the class is emitted only by the legacy card
path, so it stays 0 on the default shell. Rewriting it to
`:has([data-shell-type])` makes it match the FACE tile → count 1 → red (bit
camerainput-shell-source:192 and loopback-shell-source:278; both reverted to
the per-type class). NEVER apply the mechanical rewrite to a negative
assertion whose subject is card absence — check every `toHaveCount(0)`
before rewriting a file.

## Commit sequence (each green, pushed; battery per commit-group)

## Flip-batch measurement (the honest instrument, preview @4752)

First full 113-file run after the flip: **240 passed / 37 skipped / 59 files red**
in 7.7 m. All 21 pre-moved rackLegacy files GREEN (the alias works). Of the 92
flipped "URL-only" files, **33 green as-is, 59 red** — S0's family-(a) label was
an upper bound, as §1.4 warned. The 59 reds split:

- **44 carry `.svelte-flow__node-<type>`** → mechanical `:has([data-shell-type])`
  rewrite applied, re-run pending; still-reds after that are real card-DOM.
- **15 pattern-free reds** (real card-DOM-in-disguise: cartesian/note-entry
  cells, score notation UI, patch-panel menu triggers, fader-thumb geometry,
  vfpga preset menu, seqtris board, es9 jack titles, mixmstrs jack expansion,
  live-glyphs VuMeter/ScopeScreen, param-edit fader, multi-output video zones,
  dx7 syx dropdown, clipplayer clip-delete, aut-patch-panel drill, poly-chord
  picker) → moved onto `rackLegacy`, queued as family (b) rewrites.

### Selector-rewrite re-run (44 pattern carriers, preview @4752)

**24 rescued** (green on default with `:has([data-shell-type])` wrappers):
buggles backdraft-pure-tv clipplayer clip-prob-default clipplayer-rate-reset
insert-on-cable kria illogic launchpad-perf-controls kickdrum karplus
launchpad-clip-launch launchpad-keys-record launchpad-arp midi-learn
nested-module-menu palette push2-clip-launch picturebox-limits ringback tomtom
snaredrum-roll sidecar tidy-vco.

**20 still red** (deeper card DOM — readouts/`.title` targets/glyph screens;
selector rewrite REVERTED on these so they stay valid under legacy, moved onto
`rackLegacy`): clipplayer-custom-scale clipplayer-songmode cloudseed clouds
foxy fader-midi-assign midi-cv-buddy module-annotate lfo-modulation-visible
launchpad-scene-repeats midi-lane pentemelodica node-context-menu
reshaper-shapedramps sample-hold rings resofilter scope-xy-intensity
scope-tuner ui-refresh.

**3 green-by-skip carriers** (clap, clipplayer-controls: #1847-parked bodies;
es9-hardware: hardware-gated) — latent legacy selectors inside parked/skipped
bodies were rewritten to the shell-agnostic form so an unpark/hardware run
works on the default shell. ⚠ Park-reconciliation note: their parked bodies may
read deeper card DOM; re-triage at unpark time.

**rackLegacy population after commit 1: 57 files** (21 S0-known + 15
pattern-free reds + 20 post-rewrite reds + `clipplayer-right-click-menu`, see
trap below). These are S2's family-(b) work queue from the implicit pool.

⚠ **MAPPING TRAP: Playwright truncates the FILE slug in test-results dir names**
(~26 chars). `clipplayer-right-click-menu` failures produced dirs named
`clipplayer-right-click-men-…`, which a startsWith(file + "-") mapping assigns
to `clipplayer.spec.ts` — the long-named file reads FALSELY GREEN. It was
deterministically red all along (7/7). **Never triage a batch from artifact dir
names; parse the line-reporter/JSON output.** The full-batch verification run
(413 tests: 369 passed / 37 skipped / 7 failed, all 7 = right-click-menu)
caught it; that file is now the 57th rackLegacy member (verified 7/7 green on
legacy). Its subject is real: the launch grid is a `clipplayer-pad-{n}` shell
cell with `minWidth: 280` — width-gated OUT of the lane tile by design (the
lane shows cv-lane knob cells), so the pad grid lives in the dock view on the
default shell. Family-(b) rewrite: drive the grid in `dock-full-view` (or fold
into `face-clipplayer.spec.ts`, which already covers grid+pads).

**Known failure shapes for the family-(b) rewrites** (from error contexts):
- shell tile name row is `.tile-name` (ModuleNameLabel, testid suffix
  `tile-name-label`) — card `.title` right-click targets go there.
- card readout testids (`rings-model-name`, mode labels, scale names) have no
  face-tile home (owner ruling: decimals/readouts GONE) — rewrite against face
  affordance or dock view, or fold into the module's existing face spec.
- NodeContextMenu is canvas-level (`lib/ui/Canvas.svelte`), shell-agnostic —
  only the right-click TARGET selector needs changing.

| # | commit | state |
|---|---|---|
| 1 | fixture flip: `rack` → default shell; `rackLegacy` opt-in alias added; 57 still-legacy-dependent files moved onto it; 27 files get shell-agnostic node selectors | DONE — battery: typecheck 0, lint 0, `--list` 3077/506 unchanged, full batch 369 passed/37 skipped/0 red after moves, REPEAT=3 on the 24 rewritten = 180 passed/0 failed |
| 2 | `rackDefault` fold (10 consumers → `rack`; fixture deleted) | pending |
| 3+ | drain `rackLegacy`: node-locator mechanical rewrites back onto default | pending |
| 3 | URL-flip wave 1: 80/144 mechanical-pool files flipped (URLs + `:has` locators), 6588ed099 | DONE — pool run 373 passed/129 skipped; 64 reds REVERTED to legacy boot (family-b/e queue below) |
| 4 | manual-pool flips + family-(c) first cuts (24 files: shell-source legacy legs, es9 legacy arm, master-transport legacy arm, flip-rack legacy arm, menu-clamp canvas-card legs, midi-learn-note leg 2, rings-face card leg, vca-face card describe — see manifest) | verification batch running |
| … | URL-flip remainder: the 64 reverted reds (below) — each needs per-family triage, not a blanket flip | pending |
| … | helper flips: `_per-module-per-port-shared.ts`, `_toybox-fixture-helpers.ts`, `carl-rackspace.helpers.ts`, `rack-session.ts` `LEGACY_RACK_URL` | pending |
| … | card-DOM rewrites / fold-and-delete with named-coverage manifest (owner ruling 5) | pending |
| … | family (c) machinery deletions + skip-budget same-commit | pending |
| … | #1847 park reconciliation (28 files) | pending |
| last | DOOM sub-slice: 14 re-points, boot URL + knob locator only | pending |

## Coverage manifest (fold-and-delete rows land here as they happen)

Format: deleted test → why it dies → where the coverage lives now.

| deleted (file :: test) | class | coverage now |
|---|---|---|
| camerainput-shell-source :: "?shell=legacy is UNCHANGED — real card in lane, no host" | legacy escape hatch + deleted HeadlessSourceHost | same file's default-shell legs; workflow-shell-video per-row card-absence |
| loopback-shell-source :: "?shell=legacy is UNCHANGED — real card in lane, no host" | same | same |
| es9-shell-lifetime :: "preview OFF is unchanged — legacy card in-lane" | legacy renderer arm | the three default-shell lifetime legs in the same file |
| workflow-master-transport :: "…(legacy-cards)" table arm | duplicate arm — drawer routes via DockFullView, never read the flag (file's own comment) | the surviving `faces` arm, identical surface |
| flip-rack-rear-view :: both tests × "legacy (?shell=legacy)" renderer arm (2 tests) | legacy renderer arm of a rack-level parity table | the `shell (default rack)` arm |
| menu-viewport-clamp :: "numpad key remap menu … corner" (canvas card) | card-only anchor (face keymap is dock-only) | numpad-plus-face.spec.ts (portal+clamp); lane-tile drill-down leg in same file (transformed-node escape class) |
| menu-viewport-clamp :: "clip editor note-/clip-probability menus … (canvas)" | card-only anchor (pads dock-only on default) | dock full-view leg in same file (same menus + flyout + backdrop) |
| midi-learn-note :: "the LEGACY CARD's button (SCORE PLAY) binds a NOTE" | compat-surface leg | FACE leg in same file (incl. orphaned `<node>:play` record migration) |
| rings-face :: "the CARD STRUM button drives the SAME seam" | compat-surface leg | dock-cell strum leg + NEGATIVE CONTROL in same file |
| vca-face :: "VCA legacy card — def-owned readout reaches the card" describe (1 test) | card readout path (`paramProps`) | face `aria-valuetext` readout legs in same file |

Collection: 3077 → **3066** tests in 506 files (−11: the rows above).

## The 64 URL-flip reds (reverted to legacy boot; drain per family)

From the 144-file pool run (preview, one pass; failures ARE per-file
measurements, root causes pending per family):
toybox family (toybox-combine-editor -cv-section -disk-loading -feedback
-layer-input -layer-selector -new-content -node-batch -node-controls
-node-menu -presets -presets-io -shadertoy -video-inputs -video-projection),
samsloop (samsloop samsloop-boundaries-roundtrip -download -persistence
-record -window), timelorde (-tap-tempo -transport-state -video,
trails), video-orientation (20 tests), per-module-per-port-outputs,
videoout-drop-patch, camera-input, wavecel-viz, wavecel-video-outs,
waveform-trace-shape, workflow-spawn-reveal, video-preview-downscale,
video-controls, vst-bridge, vst-lane-autowire, slider-drag, skifree,
scoreboard, recorderbox-recover-reachable, reconciler-node-type-swap, pong,
picturebox-asset-select, perf-midi-cc-coalesce, ai-smoke, chromaconsole,
clip-media-recover-reachable, coverage-group-1-sinks, coverage-groups-6-7-8-9,
cube, duplicate-module, es9-card-shows-state, foxy-freeze-locks-wavetable,
gibribbon, in-card-title, livecode, midi, midi-autobind-perfzip,
midi-out-buddy, nibbles, organize-modules, patch-menu-redesign,
patch-panel-nested.
(Some are 1-test reds — likely cheap rescues; toybox/samsloop/timelorde are
real card-DOM families. in-card-title + card-drop-patch remain family (c)
whole-file deletions per the brief.)

## Defects found in the product by S2

*(none yet — every red so far is explainable as face-vs-card DOM shape;
patch-panel and multi-output warrant a closer product look during their
family rewrites)*

## Environment notes for a successor

- Preview server: `E2E_PREVIEW=1 flox activate -- task e2e:serve` (builds with
  `VITE_E2E_HOOKS=1`, boots on the derived port — this worktree: 4752).
- Batch runs: `cd e2e && E2E_USE_PREVIEW=1 E2E_BASE_URL=http://localhost:<port>
  flox activate -- npx playwright test <files>` — NEVER bare `npx playwright test`
  without the env (dev-server reds: `grouping-phase3:116` is the documented one).
- After ANY commit that could empty a derived set:
  `cd e2e && npx playwright test --list | tail -1` — expect `Total: N tests in M files`.
- e2e-timings row pruning rides every spec-deleting commit
  (`e2e-shard-plan.test.ts` reds on orphan rows).
