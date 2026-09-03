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
| 2 | `rackDefault` fold (10 consumers → `rack`; fixture deleted), 6788fc913 | DONE — 13-file smoke green, --list unchanged |
| 3 | URL-flip wave 1: 80/144 mechanical-pool files flipped (URLs + `:has` locators), 6588ed099 | DONE — pool run 373 passed/129 skipped; 64 reds REVERTED to legacy boot (family-b/e queue below) |
| 4 | manual-pool flips + family-(c) first cuts, 992d47151 (11 legacy-subject tests deleted with manifest rows; audio-in/ptzcam/toybox-randomize/frogger/modtris/workflow-media/workflow-viewport-nav reverted → family-(b) queue) | DONE — 55 passed/1 skipped; REPEAT=3 on 9 changed files 75 passed; positive control on locator class (kria) |
| 5 | in-card-title fold-and-delete, c396f44a9 — see manifest | DONE |
| 6 | rings family-(b) rewrite, 4da834115 — THE PATTERN: tile via `:has`, dock ladder `control-<param>` + Y.Doc read-back; REPEAT=3; positive control (suppressed click → red poll) | DONE — rackLegacy 57→56 |
| … | URL-flip remainder: the 64 reverted reds (below) — per-family triage, not a blanket flip (cheap-rescue DISPROVEN, see below) | pending |
| … | helper flips: `_per-module-per-port-shared.ts`, `_toybox-fixture-helpers.ts`, `carl-rackspace.helpers.ts`, `rack-session.ts` `LEGACY_RACK_URL` | pending — each gated on its spec family |
| 7 | readout family (resofilter, sample-hold, clouds, cloudseed), 1ba0470cf — def formatter feeds the controls (aria-valuetext/aria-checked/titles); both directions asserted | DONE — REPEAT=3 18 passed; resofilter control red-then-green; rackLegacy 56→52 |
| 8 | midi-device trio (midi-cv-buddy, midi-lane on rackLegacy; midi-out-buddy from the 64) — connect = `shell-cell-<family>-connect` ACTION cell; device picker = dock `<family>-device-body-<node>`; name button = `tile-name-label-button`; handles shell-agnostic on the wrapper | DONE — 13 tests green, REPEAT=3 30 passed, midi-out-buddy control red-then-green; ⚠ waitForTimeout ledger keys on TEST TITLES — the two ledgered 300ms waits kept their titles verbatim |
| 9 | menus/annotate/undo/scope pair (node-context-menu, module-annotate, ui-refresh, scope-tuner, scope-xy-intensity), 04970192e | DONE — `.tile-name` is the right-click target; scope tuner speaks via the dock graticule aria-label |
| 10 | foxy + pentemelodica, 52674e05d — dock `foxy-face-*` canvases, hero lanes; OUTPUT read = videoOut tile thumb canvas | DONE |
| 11 | lfo-modulation-visible fold-and-delete, fea86503e — shell renders no CV motion (OWNER item in Defects); wait-ledger shrunk via accept | DONE |
| 12 | fader + fader-midi-assign, a84297e52 — pointer-drag on dock sliders (scrollIntoView first!), radiogroup exact indices, MIDI-learn on dock controls | DONE |
| 13 | param-edit-undo + poly-chord, de9bea8f4 — dock wheel-edit = one undo step; cart-face grid mapped | DONE |
| 14 | note-entry + keyboard-nav, 8a22592fe — `cart-face-{gate,pitch,chord}-{i}` same NoteEntry; lazy cells + draft-restore deltas asserted honestly | DONE — rackLegacy 36 |
| 15 | dx7-syx-load, b9c348d59 — upload cell IS the file input; dock-Esc hazard recorded | DONE |
| 16 | cable-z-order, e6eb559e2 — DRAG GRIP recipe: tile centre is `nodrag`, name row is a button → drag from `.tile-kind` | DONE — rackLegacy 34 |
| 17 | clipplayer family (8 files) — the dock face is near-parity (same LaunchPanel/NotePanel components: pads keep `data-clip`/`data-state`, cells/menus/deck testids identical; two dock PANES can be open at once, per-node testids disambiguate; `__openDockFullView(id)` global). 3 card-parity tests fold-deleted (manifest); 5 parked bodies re-pointed at the dock (fixme kept); PRODUCT FIX: `clipplayerSelectClip` guard (see Defects). arrange pop-out `cliparrange-editor` replaces the card's inline `.song-tl` (blocks/.sel/drag/del all carry) | DONE — rackLegacy 34→26 |
| 18 | vfpga four — preset picker = the tile/dock SELECTOR cell (`shell-cell-vfpga-preset`, role=button + `[role=option]` listbox; `.val` span replaces the deleted `vfpga-loaded` readout); OUTPUT pixel reads = the videoOut tile thumb canvas (`video-tile-thumb`, 2D-readable, 160×120 — foxy's recipe); FABRIC toggle = dock `vfpga-face-fabric-toggle` (floorplan component + testids unchanged); handle sweep ports to the shell wrapper (14 handles, spread 0). ⚠ TRAP re-confirmed: retitling a test orphans its waitForTimeout ledger row AND makes the wait read NEW — title restored verbatim | DONE — rackLegacy 26→22 |
| 19 | toybox-control-surface + score + seqtris + bluebox + painter — toybox console face = SAME layer-tab testids, dials are `toybox-dial-layer:<n>:<param>` (the dial IS the role=slider; right-click → `control-context-menu` → `ctx-surface-<cs>`); cs board = `cs-board-knob/-dial-<module>-<param>`; score face = staff panel + tool CELLS (`score-value/accidental/key/dyn/tie/stop/loop/pages`; END selector = none/here; page-nav arrows RENDER ONLY at >1 page; readouts live on the staff aria-label); seqtris binder = dock `seqtris-face-connect`→`-port-{i}`→`-unbind`; bluebox keypad = dock `control-btn_*` (⚠ tile ranks the SAME testids — scope to the dock or strict-mode violates); painter = `painter-face-*` 1:1. 2 score tests fold-deleted (manifest) | DONE — rackLegacy 22→17 |
| 20 | shapegen pair + blood pair — shapegen preview = dock `shapegen-face-canvas` (`shapegen-output-body`); the card's [CLOCKED] badge has NO shell home and its sub-claim died (the regen counters ARE the clock observable; manifest). blood: the music + ingame tests join the first test's dock boot path (`blood-face-frame` + `data-blood-status`; readiness budget +BOOT_MS because the dock boot is SEQUENTIAL, per the file's own measured header) — the music test was already UN-PARKED upstream, so re-pointing rewrote no parked body | DONE — rackLegacy 17→13 |
| 21 | patch-panel + aut-patch-panel + reshaper-shapedramps + mixmstrs-stereo-expand + multi-output — the shell lane rail has ONE drill trigger (`patch-trigger`; the card's left/right corner PAIR died — right-trigger + right-edge-anchor claims folded, manifest); mixmstrs' per-channel SECTIONS are a documented product delta (#1762, noted at the PatchPanel mount in ModuleShell): flat INPUT/OUTPUT drill, ports intact; closed handles stack at the node TOP-LEFT corner (~28px inset, rail ~250px below); stereo-expand menus are portaled + shell-agnostic; video pixel reads = per-node `video-tile-thumb`. ⚠ TRAP hit a 3rd time: retitling around a ledgered waitForTimeout — this time fixed by ANNOTATING the wait (`// pacing:` ≥40 chars) + `task lint:waits:accept` (diff = exactly the orphaned line) | DONE — rackLegacy 13→8 |
| 22 | docs + launchpad-scene-repeats + es9-per-leg-patching — docs right-click target = `.tile-name` (the card `.title` counterpart), type class → `:has([data-shell-type=…])`; scene-repeat flair = the dock face's `clipplayer-scene-repeat-{n}` with IDENTICAL ×N/∞ text (open the pane in buildChain); es9's two `Ret1` section drills → flat INPUT drill (#1762). ⚠ python-edit trap: an assert BEFORE the write aborts silently and the OLD file runs green on legacy — re-grep the fixture after every scripted edit | DONE — rackLegacy 8→5 |
| 23 | automation pair — automation-cv-record: pads/arm live in the dock pane (opened in spawnOwnerPatch); both gamepad-CV owner cases green. clip-automation: `openCpDock` idempotent helper at the two helpers all tests route through; module-menu right-click = `.tile-kind`; the OVERRIDE moved semantics (card: appears/disappears → face: ALWAYS-visible lamp-button, enabled only while an override holds — asserts flipped to enabled/disabled); the card's per-◉ 🟡→🔴 countdown COLOUR ORDER died (face REC lamp is a single-bit pulse) → test asserts the PULSE (both states + ≥3 transitions, control-verified red when unarmed); parked test's per-lane assigned-count chip → ASSIGNED lamp data-lit + synced autoAssign map. ⚠ PRODUCT PARITY CONFIRMED: the shell tile knob drag fires the SAME touch-suspend seam (the grab test passed unmodified) | DONE — rackLegacy 5→3 |
| 24 | joystick + live-glyphs — BOTH BLOCKER WARNINGS DISSOLVED UPSTREAM: joystick was faced 2026-09-01 (wave 3) and its FACE describe already carried the identical #1963 drag/release/re-centre contract → the 3-test legacy arm FOLDED (manifest); live-glyphs' screens have shell homes after all — the DOCK HERO glyph system (`shell-glyph-meter`/`shell-glyph`(envelope)/`shell-glyph-dual`+`shell-glyph-wave`, same components ⇒ same data-lit/data-mode/data-trace-peak), and two panes make BOTH meter sides assertable where the card's shared testid could only assert the driven one | DONE — rackLegacy 3→1 |
| 25 | 62-queue drain 1: six bankable singles — pong + skifree (card-mounts legs → tile + dock `*-face-canvas`; handle presence on the wrapper), scoreboard (pixel leg → `scoreboard-face-canvas`), reconciler-node-type-swap (paint leg → `synesthesia-face-vu-a`; the legacy card's unguarded snap.levelsA read died with the card), picturebox-asset-select (meanLuma → videoOut tile thumb), slider-drag (three-channel guarantee → tile `control-<param>` role=slider). Each was the ledger's ONE measured failing leg | DONE |
| … | card-DOM rewrites remaining (rackLegacy 3): joystick (⚠ known parity blocker — check the generic-face endgame memory first), live-glyphs (⚠ glyph screens have NO obvious tile home — needs design study like lfo-modulation did), joystick and live-glyphs still carry their blocker warnings. ⚠ save-group-and-naming: DO NOT rewrite — owner ruling 1 DELETES groups entirely; its group half dies in the group sub-slice (S4), reconcile there. Then the 62-queue families (toybox 15, samsloop 6, timelorde 4, video-*, vst pair, coverage sweeps, per-module sweeps + rack-session/helper flips, ai-smoke, livecode, midi, camera-input, gibribbon, nibbles, organize-modules, patch-menu-redesign, patch-panel-nested, es9-card-shows-state, cube, chromaconsole, duplicate-module (park), foxy-freeze, clip-media-recover-reachable) | pending |
| … | family (c) machinery deletions + skip-budget same-commit | pending |
| … | #1847 park reconciliation (28 files) | pending |
| last | DOOM sub-slice: 14 re-points. ⚠ OWNER RULING (2026-09-03, via coordinator, recorded in the build-brief): DOOM gets IDENTICAL coverage on the new UI INCLUDING COLLAB — every legacy-navigating DOOM spec is RE-POINTED, never folded or deleted; the collab multiplayer legs keep their FULL assertion set on the face surface; definition of done = a coverage diff showing ZERO lost assertions. The doom face shares DoomSurface with the card, so re-points should be selector/boot-path only — but VERIFY each assertion still measures the same product property from the face mount. Waits/budgets/ledger untouched; doom-session-survives-card-collapse needs nothing | pending |

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

| in-card-title.spec.ts (WHOLE FILE, 3 tests: card-title placement, card rename persist, quarantined @collab rename-sync) | card-title chrome is card-only; rename affordance moved to the shell `.tile-name` | `module-rename.spec.ts` (default shell: tile-name rename + doc persistence + error paths); livecode rename-validation. ⚠ **NAMED COVERAGE LOSS for the owner: the @collab rename-sync case dies with the file.** It was quarantined dark since task #101 (relay-contention), so nothing that ran goes dark — but no @collab rename-sync coverage remains anywhere, and task #101's eventual fix needs a NEW home on the default shell. Same-commit: timings row pruned (422→421), both skip-budget entries pruned, `e2e-skip-budget.test.ts` + `e2e-report-audit.test.ts` collab scenarios re-anchored on the now-empty collab budget. |

| rings.spec :: "model button cycles + updates label" — the LABEL half | card readout (`rings-model-name`), no face home by ruling | param half REWRITTEN: dock `control-model` toggle ↔ Y.Doc; audio identity of the two models pinned by the model-switch audio test in the same file |
| sample-hold.spec :: the `samplehold-mode-hint` QUANTIZER assertion | derived-state card readout, no face home | the mode's BEHAVIOR (continuous quantize with no gate) is the same test's scope-peak assertion — the readout was commentary on it |
| cloudseed.spec :: `cs-preset-prev`/`cs-preset-next` wrap-around arrows | card-only affordance | preset SELECTION rewritten onto the dock `control-preset_index` radiogroup; name + decay follow via tile aria-valuetext |

| lfo-modulation-visible.spec.ts (WHOLE FILE, 2 tests) | subject = modulation VISIBLY moving the card fader thumb; the shell renders no CV motion (measured — see Defects) | modulation-reaches-the-param/audio is pinned by filter-cv-depth.spec.ts + modulation.spec.ts (both green on the default shell); the visible-thumb affordance leaves the product with the fleet. Same-commit: timings row pruned (421→420), wait-ledger shrunk 4 lines via `task lint:waits:accept` (diff reviewed = exactly the dead file's lines) |

| fader.spec :: exact `.fill()` values on card inputs | card `<input>` semantics; shell sliders are drawn controls | rewritten: pointer-drag writes the param in the dragged direction + radiogroup transitions assert exact indices (a STRONGER gesture claim, weaker value-exactness — the def clamps stay unit-tested) |
| fader-midi-assign :: `fader-ab-midi-badge` / `fader-drywet-midi-badge` | card-only per-fader badges | CC-drives-param asserted directly; the shared bound-badge behaviour is pinned by midi-learn.spec.ts on the shell |
| dx7-syx-load :: `dx7-syx-status` "loaded 32 voices" text | card-only load receipt | the load's visible receipt on the shell = the preset selector auto-flipping to USER_00 (aria-label) + the popup's ≥41 options; the audible patch-difference L2 assertion unchanged. ⚠ dock-Esc hazard: closing a face listbox with Escape closes the WHOLE dock full view — close by re-selecting instead |

| clipplayer-card-parity :: "control strip switches the 4 card views (grid / clip / arranger / control)" | card-only view chrome — the dock face paints grid + editor + deck AT ONCE; there is no view to switch | face-clipplayer's legs assert every face surface paints (grid/editor band/deck lamps) |
| clipplayer-card-parity :: "keyboard 1–8 gate on FOCUS-WITHIN (clicked into), NOT mere selection" | the card's digit-key view-switch machinery (kb-active chip, strip views) died with the card; the face has no digit handler | n/a — the guarded affordance left the product with the fleet (velocity modifier survives as the deck VEL toggle + Shift-click, asserted in the same file) |
| clipplayer-card-parity :: "an unfocused clip-player does NOT starve a co-present NUMPAD+ of computer keys" | the hijack surface under guard WAS the card's global digit handler; no default-shell surface listens for digits | numpad-plus key capture is pinned by numpad-plus-face.spec.ts; the hijacking code is deleted with the card |

Also rewritten (not deleted), same commit: HOLD-8/stuck-shift-blur halves of the
velocity test died with the card keyboard; the VELOCITY CYCLING claim survives
on the deck VEL toggle (`aria-pressed`) + Shift-click. clip-view-grid's
card-GEOMETRY half (grow/restore tier) died with the card; its FULL-GRID
rendering half (57 rows × 16→128 cells) survives on the dock roll (parked body,
fixme kept). songmode's card-inline `.song-tl` legs moved onto the
`cliparrange-editor` pop-out (same blocks/.sel/drag/del semantics, probed).

| joystick :: the "(legacy card)" describe (3 tests: spawn/pad-mounts, drag+release-persists, dblclick re-centres) | duplicate arm — the FACE describe in the same file asserts the identical #1963 contract through the shipping surface (pad drag both axes, release persists, dblclick re-centres, readout deletion) | the FACE describe in the same file |
| save-group-and-naming.spec.ts (DISPOSITION, not yet deleted) | DO-NOT-REWRITE per owner ruling 1 — groups die entirely; the file is the LAST rackLegacy consumer and dies WITH the fixture in the S4 group sub-slice | S4 group sub-slice reconciles; until then the file still runs green on the legacy alias |
| clip-automation :: the 🟡→🔴 countdown COLOUR-ORDER sub-claim (in "the REC countdown lamp pulses…") | the card painted per-◉ cd-yellow/cd-red classes; the face REC lamp is a single-bit StatusLed pulse (readout ruling) | the PULSE assertion in the same test (both states + ≥3 transitions; disarm → dark) |
| clip-automation :: the per-lane assigned-COUNT chip asserts (parked module-assign test) | card readout (`clipplayer-auto-assigned-<lane>` count text); the face has ONE ASSIGNED lamp per node | the lamp's data-lit + the synced `autoAssign` map, asserted in the same (parked) body |
| patch-panel :: the right-trigger halves ("both triggers open the SAME menu"; RIGHT-edge anchoring in the parked edge-alignment test) | the card's corner trigger PAIR — the shell lane rail mounts ONE drill trigger | the single-trigger claims in the same tests; the #1647 first-frame anchor leg survives on the left edge |
| aut-patch-panel :: the MIXMSTRS per-channel section-nav rows | a documented product delta of the shell rail (#1762 — `groupingStrategy: 'auto'`, sections would re-derive the handle stack) | the flat INPUT drill's collapsed-stereo-row + handle-parity assertions in the same test |
| shapegen-clock :: the [CLOCKED] badge sub-assertion (inside the parked s&h test) | card-only chrome — the face has no clocked indicator; the clock's observable is the regen/advance counter pair the same test pins | the engine-counter assertions in the same (parked) test |
| score :: "tie tool — picking two notes creates a Tie object + SVG path" | card two-click tie-tool mechanics | score-face.spec.ts test 3 (TIE cell adds a tie + arc AND removes one — a remover the card never had) |
| score :: "page count is capped at 4 — add button disabled at max" | the card's add-button; the face's PAGES roster IS the cap | score.spec.ts page-nav rewrite pins the roster exactly ['1','2','3','4']; grow/shrink non-destructive in score-face.spec.ts test 4 |

Collection: 3077 → 3066 → 3063 → 3061 → 3058 → 3056 → **3053** tests in 504 files (joystick legacy arm −3).

## Readout-family REWRITE recipe (proven on 4 files, commit 7)

The card's "label follows the param" tests survive on the shell because THE
DEF FORMATTER FEEDS THE CONTROLS: `control-<param>` carries `aria-valuetext`
speaking the def vocabulary (tile knob: short/long form; dock segmented:
long-form names as per-segment `title`, `aria-checked` tracks the param;
dock radiogroups for enum params). Drive `setNodeParams` → assert
aria-valuetext/aria-checked; drive the control → read the Y.Doc back. Probe a
tile/dock with a scratch spec dumping `[data-testid^="control-"]` +
aria-valuetext before writing (the tile and dock paint DIFFERENT primitives
for the same param — resofilter's mode is a knob in the lane and a segmented
in the dock).

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
(toybox/samsloop/timelorde are real card-DOM families. card-drop-patch stays
in the parks phase; in-card-title was deleted — see manifest.)

**⚠ The cheap-rescue hypothesis is DISPROVEN (measured).** 20 of the 1-3-test
reds were re-flipped and run: 25 passed / 24 failed — every file kept exactly
its deeper card-DOM leg; NONE fully rescued. All 20 reverted to legacy. The
failing leg per file (bankable triage — this is the family-(b) work item list
for these files):
- midi-out-buddy :133 "Connect MIDI… reveals OUT device + channel selectors"
- perf-midi-cc-coalesce :237/:350/:439 (CC burst coalescing — binds knobs on
  card DOM)
- picturebox-asset-select :179 (gate→slot display)
- pong :54 / skifree :178 (card mounts + canvas + io presence)
- reconciler-node-type-swap :77 ("its card paints" leg)
- recorderbox-recover-reachable :40 (Save/Discard inside the card)
- samsloop-boundaries-roundtrip :54, -download :31, -persistence :57 (record
  flows through card UI)
- scoreboard :66 (SEQ gate increments counter + preview pixels)
- slider-drag :106 (ADSR Attack card Fader drag)
- video-controls :561 (FEEDBACK wet knob), video-preview-downscale :395
  (on-card preview), wavecel-video-outs :197, waveform-trace-shape :69
- workflow-spawn-reveal :206 (off-screen lane add pan geometry)
- vst-bridge :57 / vst-lane-autowire :208 (mocked-helper flows via card)
- camera-input :154/:240/:317 (device picker/hints — camera project)

## Defects found in the product by S2

- **⚠ FOR THE OWNER — shell tiles do not render CV modulation motion
  (measured).** A 5 Hz LFO patched into qbrt `cutoff_cv`: the tile's
  `control-cutoff` pointer, `--v` custom property and `aria-valuenow` were
  byte-identical across 8 samples over ~1 s, while the legacy card's fader
  thumb visibly followed the same modulation (lfo-modulation-visible's
  subject). This LOOKS deliberate — CV modulation must not write the Y.Doc
  (write-storm ruling), the shell controls read params, and animating knobs
  would break face-VRT determinism (zdet probes measured faces byte-stable) —
  but no ruling names it. Surfaced rather than silently absorbed:
  lfo-modulation-visible.spec.ts was deleted with its subject (manifest row);
  if the owner wants live-modulation feedback on faces it is NEW product work,
  not a test rewrite.
- patch-panel and multi-output warrant a closer product look during their
  family rewrites (menu triggers / video zone reads).
- **FIXED (commit 17): `clipplayerSelectClip` bounded on `CLIP_COUNT` (64, the
  visible 8×8 grid) while flat clip keys are stride-64 (`lane*64+slot`, up to
  455) — dblclicking ANY pad outside lane 0 on the face created the clip but
  could never open it in the editor band.** The legacy card had its own
  selection path, so only the promoted face could show it (the
  shared-derivation-repaired-only-on-the-surface-you-looked-at class;
  face-clipplayer's own dblclick leg asserted clip CREATION, not editor
  binding — a near-miss). Found by the rewritten custom-scale per-lane leg
  (red before the fix, green after = the positive control). Guard now spans
  `CLIP_LANES * SCENE_STRIDE`; pinned at source in clipplayer-face-model.

## The family-(b) rewrite cookbook (proven across commits 6–16)

1. PROBE FIRST with a scratch spec (`zz-probe-tmp.spec.ts`, deleted after):
   dump `[data-testid]` on the tile and the dock, plus outerHTML of the
   control you need. The tile and dock paint DIFFERENT primitives for the
   same param (knob in lane, segmented/slider in dock).
2. Locators: tile = `.svelte-flow__node[data-id=X] [data-testid="module-shell"]`
   (or `:has([data-shell-type="T"])` by type); dock = `shell-open-dock` click
   → `dock-full-view`; off-viewport tiles → `__openDockFullView(id)` global.
3. Controls carry `control-<paramId>`; family cells `shell-cell-<family>-<key>`;
   def vocabulary lives in aria-valuetext / segment titles / aria-labels.
4. Drags: `scrollIntoViewIfNeeded()` first (dock ladder exceeds 720px);
   node-drag grip = `.tile-kind` (centre is nodrag, name row is a button);
   right-click target = `.tile-name`/`.tile-kind` for the module menu, the
   control itself for the MIDI menu.
5. NEVER Escape to close a face popup (closes the whole dock) — re-select.
6. NEVER `:has`-rewrite a negative card-absence assertion (inverts it).
7. Battery per family: run once, REPEAT=3, ONE positive control
   (suppress the driving gesture → the assert must go red, restore → green),
   e2e tsc, `--list` after anything that could empty a set, `task lint` when
   a ledgered waitForTimeout's test title moved (keep titles verbatim), and
   timings-row prune + budget-entry prune in any commit that deletes a file.

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
