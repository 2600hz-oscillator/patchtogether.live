# Flake park — what coverage we lost

2026-08-18. Tracking issue: **#1847** (stays OPEN until these are re-enabled).

Owner ruling that produced this:

> *"tests that are unpredictable, nondeterministic, flaky are negative value and should never be tolerated"*
> *"disable all these tests for now with `.fixme` and put a report in myrobots about what coverage we lost."*

This is the report. It is the answer to one question — **what breaks in production that we would no longer catch** — and nothing else.

---

## What was disabled, and what was deliberately not

A census of every CI run in the 96 hours to 2026-08-18 classified 263 distinct failing tests into three groups. Only one of them is nondeterministic.

| group | disposition |
|---|---|
| VRT baseline churn — intentional design changes invalidating PNGs | **left enabled.** Correct failures. |
| Other correct branch-local failures | **left enabled.** Tests doing their job. |
| **Nondeterministic** — same SHA, failed then **passed on retry** | **parked with `test.fixme`** |
| DOOM | **not touched.** See the exclusions section. |

The separation is derived from the census's own per-test classification, not re-judged here: a test is nondeterministic if it recovered on retry at least once at a SHA where it had failed. It is a clean partition — no test appears in two groups.

**Every one of the parked tests recovered on retry at some point, which means the jobs reported SUCCESS.** That is the thing worth carrying out of this exercise: none of this debt was visible in the green/red signal. 697 flaky observations rode inside green jobs.

### The parked population, by subsystem

Observation counts are from the census window; they are historical measurements, not thresholds.

| subsystem | specs | tests | flaky observations |
|---|---|---|---|
| patch / canvas gesture surface | 9 | 18 | 236 |
| clip player, transport, automation | 13 | 21 | 120 |
| real-source-chain audio + CV | 12 | 15 | 106 |
| video producers + node lifetime | 8 | 9 | 101 |
| registry sweeps (parked per subject) | 2 | 18 | 83 |
| workflow shell + dock | 6 | 10 | 17 |
| heavy-WebGL floor (`webgl-smoke`) | 2 | 2 | 16 |

---

## What breaks in production that we would no longer catch

### The patch and canvas gesture surface

The largest single hole, and the newest.

- **`card-drop-patch.spec.ts` — all eight tests.** The ONLY coverage of the card-onto-card drop-to-patch gesture (#1780/#1781). 175 observations — a quarter of all flakiness in the window — from a spec one day old and accelerating, across 16 branches including `main`. Its own header records why it must use real pointer drags rather than the `__handleNodeDragStop` hook: **the hook skips drag-origin capture and structurally cannot see the feature's main failure mode.** Every "modal opened" assertion is paired with a "stayed shut" assertion, because a modal that opens on *every* drag would break the most-used gesture in the app. Parked, all of that is unobserved: a modal that opens on a plain carry, a cancel that writes an edge, a commit that stages rows but produces no real edges, an undo that removes half a session, a rear backpanel that opens by default.
- **`clear.spec.ts` + `clear-patch-undo.spec.ts`.** Clear is a destructive toolbar button with **no confirm dialog**, so undo is its only safety net — and that safety net has already been dead once (an origin-less `ydoc.transact` the UndoManager could not see). Parked, an irreversible Clear ships green.
- **`patch-load-leak.spec.ts`.** Five consecutive loads must release the graph they replaced. The 2026-07-29 audio-bog investigation is the reason this exists; parked, that class returns with no signal at all.
- **`matrixmix.spec.ts`.** Undo integrity through the shared `validateEdge` seam — a partial undo leaves a silently different graph, which is the worst shape of bug this app can ship.
- **`patch-panel.spec.ts` + `cable-drag-panel-lock.spec.ts`.** Menu anchoring at viewport edges, and the open/close contract after the no-drag redesign. A menu that opens off-screen is an unreachable patch.
- **`duplicate-module.spec.ts`, `control-surface.spec.ts`.** Duplicate's fresh-id and deep-clone guarantees (the shared-reference bug corrupts both copies at once), and controls rendering within their own card bounds.

### Video producers and node lifetime — the class that keeps shipping

This is the family that has already reached the owner three times (#1720, #1721, #1728, #1574, #1589), and it is the one where a screenshot gate cannot help.

- **`extras-producer-lifetime.spec.ts` — `toybox`.** The #1720 regression net, and unique coverage: a SAVED rack must render TOYBOX's persisted Y.Doc content **with the card never mounted**, which under the faceplate shell is the DEFAULT state, not an edge case. 48 observations across 40 SHAs and 23 branches including `main`. **#1757 was a declared fix for this and it did not hold** — 36 of its 49 observations landed after that fix.
- **`backdraft-preview-toggle.spec.ts` — both tests. ⚠ This pair had `main` RED at the moment of parking, and it is worth understanding rather than just noting.** On `ec8a0b856` both tests were flaky (2 attempts each) and the job reported **SUCCESS**. On `3614b89c0` one of them lost both coin flips and the job reported **FAILURE**. Nothing regressed between them. The spec was already failing on the previous commit; it had simply been winning its retries. This is the census's central finding arriving as a live incident.
  - The tab-switch test is the owner's stated floor for the preview button — *"that on/off persists through tab switches"*. Parked, the toggle can silently revert and re-claim the vertical space it was told to give back.
  - The collapse test is **the only assertion that the dangerous half of a collapse is safe, and that half is invisible in pixels.** Collapsing a view that also owns a producer tears the producer down and the picture returns BLACK or STALE. A VRT baseline structurally cannot catch it, because a stale frame is a valid-looking frame. Parked, a third occurrence of #1721/#1728 reaches the owner rather than CI.
- **`present-survives-card-collapse.spec.ts`.** The owner P0 *"backdraft on dev when card is not expanded and its been sent to a projector, the output stops"*. Parked, a collapse can freeze a live show.
- **`layers-survive-card-collapse.spec.ts`.** #1589 — collapsing TOYBOX must not drop its video layers, and **Export must never write a preset it knows is incomplete.** The second half is a data-loss guarantee, not a rendering one.
- **`backdraft-pure-tv.spec.ts`, `lushgarden.spec.ts`, `mapper.spec.ts`, `reshaper-shapedramps.spec.ts`.** Shader-vs-CPU-mirror agreement, compositing outside plant silhouettes, key threshold responding in the right direction, and the linear raster passthrough that every shaped scan is judged against.

### Real-source-chain audio proofs

This is the class the poly/MIDI rule exists for. The standing finding is that engine-direct substitutes ship silent bugs — it is how POLYHELM shipped green-but-silent, and the same bug class hit the poly wave five times. Every test below drives the REAL default-mode source chain, and nothing else in CI does.

- **`voice-pitch-accuracy.spec.ts` — tidyVco, both notes.** The owner guarantee that *"default tuning always leads to sequence notes matching reality"*, asserted at SHIPPED DEFAULTS with no param overrides. The C5 leg carries the chain-liveness argument that makes it non-fakeable: 0 V is indistinguishable from unpatched, so only the 1 V case proves the cable is live. Parked, a mistuned voice ships.
- **`clap.spec.ts`, `drumseqz.spec.ts` (3 tests), `score.spec.ts`, `blood-audio-output.spec.ts`.** Audible RMS through real trigger chains; the gate ConstantSource → CV-into-gate path; every note of a triplet actually sounding; BLOOD's whole OPL3 music path through the wasm pump and the PCM worklet.
- **`stereo-mono-normal.spec.ts` — charlottesEchos.** A mono source into L must not leave R at digital silence. Five modules declared this normal in their DSP and then defeated it in their factory; charlottesEchos is now unmeasured in every lane.
- **`cv-range-uniformity.spec.ts`, `coverage-groups-3-4-5.spec.ts`.** ADR-004's CV range convention (an LFO must move a param across its FULL range, not the ~10% the pre-scaling engine delivered) and the LFO phase outputs emitting real bipolar CV. A dead or DC-stuck output is invisible to a per-port "edge materializes" assertion.
- **`shapegen-clock.spec.ts`.** Trigger-vs-gate edge semantics on the shared gate cable — regenerate on a rising edge, hold within the window, freeze on a stopped clock.
- **`illogic-face.spec.ts`, `scope-tuner.spec.ts`, `nibbles.spec.ts`.** The two ILLOGIC seams no unit or ART gate can reach (the DOM printing the LIVE graph value; the knobs not contaminating the clean gate); SCOPE's tuner against a known A440 source; NIBBLES advancing at all.

### Clip player, transport and the hardware surfaces that drive it

- **`clip-automation.spec.ts`.** The owner-locked FINAL automation model end to end, including the negative leg that an UNASSIGNED module records nothing, and the live-grab suspension scope. **#1646 was a declared fix for this spec's flakiness and it did not hold** — 26 of its 30 observations landed after it, and rising.
- **`clipplayer-transport-no-controller.spec.ts` — both tests.** The #1165 P0 guard: the card transport must work with NO controller attached, and the mere presence of a `push2Control` module must not disable it. That is the owner-reported break a controller integration caused; parked, it can recur silently.
- **`clipplayer-rate-reset.spec.ts`, `clipplayer-songmode.spec.ts` (3), `clip-prob-default.spec.ts` (2), `clipplayer-card-erase.spec.ts`.** Polyrhythm through the real TIMELORDE tick loop; song-mode record and replay; clip-default probability actually silencing a clip through the real chain; and the stale-note class where erasing a note on a playing clip leaves the voice ringing out.
- **`clipplayer-grid-stability.spec.ts`.** The owner-reported deterministic +2-row jump that lands a double-click in the wrong clip.
- **`clipplayer-controls.spec.ts` (3), `clipplayer-custom-scale.spec.ts`, `clipplayer-clip-view-grid.spec.ts`, `clipplayer-play-every.spec.ts`, `launchpad-keys-record.spec.ts`, `launchpad-perf-controls.spec.ts`.** Transport ownership handoff, the non-destructive row filter, whole-grid sizing, per-note `playEvery`, and the two Launchpad gestures driven through the same decode path real hardware uses.

### Registry sweeps

- **`per-module-per-port-behavioral.spec.ts` — 15 modules** (`analogVco`, `clap`, `cloudseed`, `colorizer`, `cube`, `flipper`, `lfo`, `lines`, `moog911`, `moog921Vco`, `moog962`, `moog995`, `shimmershine`, `treeohvox`, `wavecel`). This is the only dead-input detection outside the behavioral smoke subset, and **`ci.yml` already records that deleting the full behavioral lane left the modules outside that subset with no CI dead-input coverage.** Parking these removes the last of it for those fifteen: a module that exists in the def, accepts a wire, and then silently IGNORES every value that arrives is now unobservable for them. `wavecel` is the one with a written-down hypothesis already — a race against the async wavetable load in the TEST SETUP, documented in the spec's own `spread_cv` analysis. That note is the shape a root cause should take here.
- **`modules.spec.ts` — `bluebox`, `buggles`, `quadralogical`.** The per-module spawn smoke: card render, registry-derived handle count, clean console. It is the only per-module render gate outside the VRT lanes.

### Workflow shell, dock, and the heavy-WebGL floor

- **`workflow-shell.spec.ts` (3), `workflow-shell-faces.spec.ts`, `workflow-dock-ux.spec.ts` (3), `workflow-dock.spec.ts`, `workflow-surfaces.spec.ts`, `workflow-channel-columns.spec.ts`.** The migration seam (a curated face in-lane rather than the un-migrated placeholder), lane tile geometry and header composition, the two-pane dock split with LRU replacement **asserted for BOTH shells**, independent rail zoom, the MIDI DIN clock-source assignment round-trip, and the channel-column reconciler's additivity invariant. The shell-parity legs are what stop a fix landing for one shell only, and they are what goes dark first here.
- **`peakstate-render-smoke.spec.ts`, `wavecel-video-outs.spec.ts`.** PEAKSTATE's per-port render gate (unconsumed outputs stay dark) and WAVECEL's `scope_out` producing a structured, frame-stable trace independent of the on-card preview toggle. Both are `WEBGL_HEAVY_GLOBS` specs, so they resolve only on the `webgl-smoke` floor job.

---

## ⚠ DOOM is excluded by name and untouched

Three DOOM tests appear in the raw flaky data and **none of them was modified**:

| spec | test | observations |
|---|---|---|
| `doom-audio-output.spec.ts` | in-level SFX (pistol) produce audible RMS on a downstream SCOPE | 4 |
| `doom-late-join.spec.ts` | B joins mid-level → hot-drops into the current map as active player 1 | 1 |
| `doom-mp-real.spec.ts` | owner hosts + launches MP as P1, guest one-click hot-joins as P2 | 1 |

The reason is the standing owner ruling — *"do not fuck with doom in any way without specific approval"* — and it is mechanical, not preference. `video/modules/doom.ts` calls `runtime.runTic()` inside `surface.draw`, and `runTic` runs exactly one `dgpt_tick`, so **DOOM's game clock IS the frame clock: one rendered frame = one game tic.** Anything that changes DOOM's timing re-specifies how far the marine walks, in a suite that then asserts on where he ended up. The owner has reserved these three for their own decision.

No DOOM file, spec, wait or timing is touched by this campaign.

---

## Three census rows that could not be parked, and why

The census names 95 nondeterministic tests. 92 declarations were parked. The other three do not resolve to a live test in this tree, and **a list entry naming something that no longer exists is stale rather than actionable** — so each is recorded here instead of being forced:

1. **`clear.spec.ts :: "clear after voice demo removes all nodes + edges ───────"`** — not a second test. It is a **title-extraction artifact in the census**: a box-drawing separator from the log bled into the title. Every occurrence pairs 1:1 with the clean title on the same job, SHA and branch, and `clear.spec.ts` contains exactly one test. That test IS parked, once. So the true distinct population is 94, not 95.
2. **`swolevco.spec.ts :: "SWOLEVCO ratio knob change moves the primary spectrum through the FM path"`** — the subject was **renamed and rewritten** by #1674, whose commit title is *"the swolevco CV test passed with NO CABLE CONNECTED"*. The flaky observation was on the pre-fix version, on one branch, at one SHA. Its successor (`SWOLEVCO ratio sets the modulator frequency — tracked, and free-running at 0`) is a different test written specifically to fix the defect the old one hid. Parking it on the strength of its predecessor's single flake would be over-reach. Left enabled; watch it.
3. **`videoout-detach-display.spec.ts :: "RE-ATTACH is reachable from BOTH the floating output and the underlying card"`** — the file does not exist on `main`. It lives only on the unmerged branch `face/videoout-1821` (#1821). **This one needs an owner or author decision**: when that branch lands, the test lands with a live flake history and no park.

---

## Two things this campaign deliberately did not do

**No test was weakened.** Every parked body and every assertion inside it is byte-identical. They are the record of what the test proved, and a future fixer needs them intact. Nothing was deleted, commented out, or moved.

**No number was raised.** `scripts/e2e-skip-budget.mjs` is deny-by-default and has no count anywhere; it gained NAMED `(spec, reason)` entries grouped by subsystem, each carrying a `why`. Both directions of `scripts/e2e-skip-budget.test.ts` — a stale entry is RED, an unclaimed site is RED, the reasonless set is asserted EMPTY unconditionally — are green against the live inventory, along with its negative controls. No retries were added and no timeout, threshold or budget was widened, because buying green with retries is the same move as widening a threshold.

---

## Coming back off this list

`.fixme` is a parking space, not a verdict. A test leaves it when its nondeterminism is **root-caused and fixed** — never by being deleted, and never by being retried until green. "It passes now" is the same evidence the 42 green runs before a break provided.

Two things make that concrete:

- **Highest-yield target first: `card-drop-patch.spec.ts`.** A quarter of all flakiness in the window, the newest spec on the list, and accelerating.
- **`illogic-face.spec.ts` is the one candidate that may already be fixed.** It is in the parked set because it flaked inside the census window, but the temporal analysis used it as the positive control: after #1834 landed on 08-18 it recorded **zero** flaky observations, while the same method showed #1646 and #1757 did not hold for their specs. That control is what makes the "did not hold" verdicts on the other two credible. If a root cause is wanted for a first un-park, #1834 is already written down.

One implementation note for whoever comes back: the loop-generated cases are parked **per subject** through a named map (`FLAKE_PARK_1847`, and the existing `QUARANTINE` map in `modules.spec.ts`). The shared assertion body still runs for every subject NOT in the map, the rendered title is identical to the live one, and un-parking is a one-entry deletion.
