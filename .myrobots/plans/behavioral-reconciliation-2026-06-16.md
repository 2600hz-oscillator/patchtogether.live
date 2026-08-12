# Behavioral reconciliation campaign — plan (2026-06-16)

> **TRIAGE 2026-08-04, re-counted 2026-08-12 — STILL UN-EXECUTED.**
> The step-1 blocker — "build the shared **structural-diff video metric** +
> spawn-once-perturb helper" — was never built, so the ~25 animated-video class
> is still parked exactly as described. Counted against the tree today (both maps
> are literals in `e2e/tests/per-module-per-port-behavioral.spec.ts`, at `:102`
> and `:987`): **`BEHAVIORAL_MODULE_EXEMPT` = 77** (was 67 when this was written,
> and unchanged since the 2026-08-04 count) and **`BEHAVIORAL_SWEEP_EXEMPT` =
> 108** (was ~165). Module-level exemptions GREW by 10 while per-port shrank —
> the campaign never started and new modules enrolled themselves into the exempt
> map. ⚠ Do not copy these two numbers anywhere: they are derived here for
> triage only, and a hand-typed population count is exactly what the 2026-08-10
> owner directive forbids.
> What DID change around it: **#986** added a fast REQUIRED `behavioral-smoke`
> subset gate, and **#1318** found that a member of that required subset
> (`resofilter.reso_cv`) was passing on noise — i.e. the "metric must FIT the
> output shape" thesis below has since been independently re-confirmed on a row
> that was supposedly already covered.
> Keep: this is live backlog with the codebase standard stated correctly.

Goal: drive the **behavioral** disabled count to ~0. Dashboard: 110 parametrized,
**67 disabled** = whole-module `test.fixme` entries in `BEHAVIORAL_MODULE_EXEMPT`
(`e2e/tests/per-module-per-port-behavioral.spec.ts`). Plus ~165 per-port entries
in `BEHAVIORAL_SWEEP_EXEMPT` + 3 `SKIP_SPAWN` (cadillac, group, helm) — extra
backlog under the dashboard's module-level number.

## CODEBASE STANDARD (lines 578–597 of the spec) — binding, overrides shortcuts
NO permanent exempt bucket. The old reconcilable-vs-intentional / NON_MEMBER pile
was RETIRED. An entry leaves backlog ONLY by:
- **RE-ENABLE** — drive it in a context where the port genuinely affects the
  observed output, using a metric that FITS the output shape:
  - pitch voices → held-note + cent metric
  - one-shot pulses → per-transient PEAK
  - summed mixers → per-channel sink
  - animated video → spawn-once-perturb + a per-frame STRUCTURAL diff (NOT the
    variance metric that the noise floor swamps)
  Re-enable with ≥3× floor margin, flake-check 3×, remove from the exempt map.
- **DELETE** — ONLY if the input can NEVER affect output under any patching
  (pure terminal sink e.g. audioOut/videoOut, or a passthrough whose out==in).
  Delete the auto-enrolled assertion with a 1-line rationale.

⇒ The "delete-membership for animated-video/games" shortcut is FORBIDDEN: those
inputs DO affect output, so they must be RE-ENABLED with a fitting metric, not
parked/deleted. DELETE is reserved for true sinks/passthroughs only.

## Work split (67 module-exempts)
Each entry already carries a "CONCRETE re-enable path" note (line 599). Use it.
- **Signal / sequencer / controller (~25):** kria, macseq, marbles, grids,
  polyseqz, drumseqz, timelorde, midiclock, midiCvBuddy/midiOutBuddy, numpadPlus,
  sticky, slewSwitch, samsloop, twotracks, clipplayer, stages, tides2, symbiote,
  mixmstrs, hydrogen, unityscalemathematik, vfpgaRunner, shapedramps, shapes →
  RE-ENABLE (base-signal-then-perturb; output-shape metric).
- **Animated video (~25):** b3ntb0x, backdraft, bentbox, mandelbulb, cellshade,
  chromakey, edges, outlines, reshaper, ruttetra, wavesculpt, videobox,
  videovarispeed, peertube, tvLibrarian, cameraInput, quadralogical, foxy, scope,
  archivist, … → RE-ENABLE via spawn-once-perturb + per-frame STRUCTURAL diff
  (build the shared metric once; it unlocks most of this class).
- **Games (~10):** doom, pong, qbert, nibbles, skifree, snes9x, frogger,
  gibribbon, modtris, scoreboard → RE-ENABLE if a control input changes the video
  (observe via structural diff); DELETE only inputs that truly can't (rare).
- **I/O terminals (~4):** audioOut, videoOut → likely DELETE (terminal sinks);
  gamepad, joystick → RE-ENABLE (drive a button → output proxy changes) or DELETE
  if no observable output.

## Execution (one PR per small batch, behavioral is heavy e2e)
1. Build the shared **structural-diff video metric** + spawn-once-perturb helper
   (unlocks the ~25 animated-video class) — its own PR, with 2–3 modules re-enabled
   to prove it.
2. Then batch the signal/sequencer re-enables (each: un-exempt, `task behavioral:one
   -- <mod>`, ≥3× margin, REPEAT=3 flake-check).
3. Games: re-enable observable ones; delete truly-unobservable inputs.
4. Terminal sinks: delete with rationale.
Run targeted `behavioral:one` per module (not the whole suite) to avoid hammering.
After each batch, the dashboard count drops; never re-park as exempt.

## Status at checkpoint
Strategy mis-stated earlier as "delete-membership + fix" — CORRECTED here to the
codebase standard (RE-ENABLE-or-DELETE-true-sinks). Awaiting go to start batch 1
(the structural-diff metric + first animated-video re-enables), or owner may pick
a different starting batch (signal modules are the most mechanical).
