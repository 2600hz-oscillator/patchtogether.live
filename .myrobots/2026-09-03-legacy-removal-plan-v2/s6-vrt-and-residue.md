# S6 — the VRT recapture is a REPAIR, and the residue, measured

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md).
**Measured at** `2b34a2f93d`, 2026-09-05.

---

## ⚠ THE RECAPTURE IS NOT BOOKKEEPING. ONE DEAD SELECTOR, 105 SCENES.

`ALL=1 task vrt:commit` → run **33973197510**. `vrt-scope decide` chose FULL on
its own (142 changed renderable files, no changed PATH names a module, so the
blast radius is not derivable) — `ALL=1` was the honest dispatch, not a shortcut.

Result: **393 passed / 105 FAILED**, and **8 baselines committed**
(`19647028f2`). Every one of the 105 is the same error:

```
TimeoutError: locator.waitFor: Timeout 10000ms exceeded.
  - waiting for locator('.svelte-flow__node-analogVco').first() to be visible
```

xyflow tags a node with its NODE TYPE. Since S4a, `emittedTypeFor` resolves every
non-docked module to ONE `moduleShell` type, so `.svelte-flow__node-<moduleType>`
CANNOT APPEAR FOR ANY MODULE. The scenes never reach their screenshot, so
`--update-snapshots=changed` never writes them — which is why a full sweep
produced 8 files instead of ~100.

⚠ **THE KNOWLEDGE WAS ALREADY IN THE TREE.** `e2e/tests/ptzcam.spec.ts:129`
spells the mechanism out verbatim, including the failure mode ("it would have
read as a broken promotion rather than a wrong locator"). It never propagated to
`e2e/vrt/`, and NOTHING COULD MAKE IT: those 25 files are `FULL_MATCH` only, so
they run in no CI job and breaking one costs zero required-lane signal. The S3
map states the same fact from the other side.

**60 sites across 25 files** still wait on that class:

```
git grep -n "svelte-flow__node-" -- e2e/vrt | grep -v moduleShell
```

The re-point is mechanical — `.svelte-flow__node[data-id="<id>"]`, the shape
`ptzcam` and the es9-face legs already use — but it is 25 files and it will
uncover second causes underneath (see `workflow-audio-io-composite` below, which
had TWO). It also interacts with the look-changes ruling: several of these scenes
are owner-preview material.

### The same selector was FOUR VACUOUS GATES in the REQUIRED lane

Worse than a broken scene: `toHaveCount(0)` on a class that cannot exist is
satisfied by a page that rendered NOTHING.

| spec | dead subject(s) |
|---|---|
| `audio-in` | `.svelte-flow__node-audioIn`, `audioin-device-select` |
| `camerainput-shell-source` | `.svelte-flow__node-cameraInput`, `camera-device-select` |
| `loopback-shell-source` | `.svelte-flow__node-loopback`, `loopback-start-capture` |
| `face-clipplayer` | `.svelte-flow__node-clipplayer`, `clipplayer-card` |

MEASURED: `camera-device-select`, `loopback-start-capture` and
`audioin-device-select` are emitted by ZERO product files. Retired at
`d48eb12276`; each test keeps a POSITIVE statement that can still fail.

### `workflow-audio-io-composite` had the defect twice over

It gated on `audioin-device-select` being VISIBLE and settled on
`audioin-status[data-state]` — both emitted only by the pre-promotion surface,
and `AudioInSourceControls.svelte` refuses those spellings BY NAME so the two
could never be confused. The scene could only ever time out. Re-pointed onto
`audioin-face-device` / `audioin-face-action[data-action]` /
`audioout-face-device-select`; verified locally that it now reaches the
screenshot and paints both faceplates properly fitted.

---

## The residue, measured rather than estimated

| vocabulary | at session start | now |
|---|---:|---:|
| `?shell=legacy` (files) | 170 | **0** |
| `?shell=legacy` (sites) | 263 | **0** |
| "legacy card" (lines) | 731 | 578 |
| "legacy card" (files) | 379 | 369 |

AGENTS.md's one remaining `?shell=legacy` is its own NEGATION of it, which is the
correct sentence.

The 578 are a genuine long tail — 1-2 sites per file across ~350 files, almost
all developer comments explaining a face by comparing it to the surface it
replaced. The DENSE core is done: `strict-faces.ts` (40),
`face-rack-status-source.test.ts` (29), `shell-cells.ts` (21),
`ModuleShell.svelte` (14), `_shell-faces.ts` (16), `graph/types.ts` (6),
`module-shell-model.ts` (5), `shell-control-kind.ts` (4), `Canvas.svelte` (5),
`face-readout-source.test.ts` (5), `face-monitor-source.test.ts` (5).

## ⚠ THE ATTEST HASH MOVED AGAIN, AND WILL MOVE ONCE MORE

`bash scripts/webgl-attest-hash.sh` → **`8c4954e95def3fc3…`** (was `9af32fc1…`).
Comments in basis files move it, exactly as the normalizer rule says.

**13 of the 220 basis files still carry "legacy card"**, so finishing the residue
sweep moves it a THIRD time. The attest is still correctly last.

```sh
bash scripts/webgl-attest-hash.sh --list | while read f; do
  grep -qi "legacy card" "$f" && echo "$f"; done
```

## Still carrying the old vocabulary in CODE, reported not silently kept

* `ToyboxConsole.svelte`'s `layout: 'card'` arm — no host mounts it;
  `toybox-face-model.test.ts:175` explicitly defers retiring it to "the removal
  commit" and derives its zone-render count from the union, so the leg
  self-adjusts when the arm goes.
* `legacy-fallback.ts` / `.test.ts` and `laneRenderKind` as NAMES (ruling 2 names
  `laneRenderKind` by example).
* `VIZ_CLAIM_PRIORITY.card` — no production claimant; `CubeHeroPanel` and
  `WavesculptOutputBody` both claim `dock`, and only the unit test uses the lower
  tier. `NodeVizSurfaceHost`'s `MountKind = 'card' | 'dock'` and
  `CUBE_VIEW_SIZES` key off the same word.
* `.dock-rack-sized` / `.mod-card` / `.moog-panel` rules in `_module-card.css` —
  no emitter and no matching root anywhere; the standing prune.
* Five spec FILENAMES (`card-producer-lifetime`,
  `launchpad-monitor-survives-card-collapse`, `layers-survive-card-collapse`,
  `present-survives-card-collapse`, `workflow-rear-card`). ⚠ A spec's filename
  decides its CI lane by prefix match and renaming one moves its `e2e-timings`
  row — deliberately NOT done inside a prose sweep.

## Claims that had INVERTED (verified against the tree, not assumed)

* **Eight defs** said a `testidPrefix` rename is RED because module-docs-lint
  greps the pre-promotion surface for it. MEASURED: seven of the eight prefixes
  appear in ZERO surviving `.svelte`; the CELL arm holds them.
  `electra-connect-button` is the one still really emitted.
* `card-range-source.test.ts` and `card-control-ranges.test.ts` — named by the
  `module-surfaces` skill as the gates holding the no-re-typed-bound rule — DO
  NOT EXIST. ⚠ **Coverage loss**: a re-typed param bound is uncaught outside
  `device-card-source.test.ts` and `treeohvox-range-source.test.ts`.
* The face-migration inventory's TYPED-ENTRY parity leg is gone;
  `midi-lane-face-model.test.ts`'s cell-kind assertion is now the whole guard.
* `renderer-tests` SKILL said the capture path uses `--update-snapshots=all`.
  The CI capture (the ONLY baseline author) uses `=changed`; `=all` is the LOCAL
  diagnostic. `vrt-update.yml`'s own header carries the retraction.
* `#2362` (mixmstrs record-band removal) was NOT already folded. Verified with
  `git log HEAD..origin/main` before merging, not assumed.
