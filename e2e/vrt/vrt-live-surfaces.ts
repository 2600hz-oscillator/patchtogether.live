// e2e/vrt/vrt-live-surfaces.ts
//
// THE LIVE-SURFACE REGISTRY — one data structure naming every region of every
// VRT scene that is masked out of the pixel diff, WHY, and the COMPANION
// assertion that replaces the coverage the mask deletes.
//
// ─────────────────────────────────────────────────────────────────────────
// EVERY ENTRY BELOW IS DERIVED FROM THE GATE ITSELF. NOTHING ELSE COUNTS.
//
// This list has been wrong three times, and each time for the SAME reason: it
// was derived from something other than the gate it is supposed to serve.
//
//   ROUND 1  Nine surfaces asserted from READING THE CODE. An adversarial
//            verify proved four of the nine `why` statements outright false
//            (byte-identical across five cold loads).
//   ROUND 2  Five derived from three full sweeps, then expanded to seven with
//            a new `vrt-frame-stability` probe measuring 200 ms-apart deltas
//            at a hard 12/255 threshold. The GATE measures `maxDiffPixels` at
//            `threshold: 0.1` after screenshotting until two consecutive
//            captures agree. Different instrument, different question,
//            different answer — and it cost 130 224 px of real coverage:
//            analogVco (27.6 % of its card) and warrenspectrum (28.5 %) were
//            masked on its say-so and BOTH pass STRICT + UNMASKED 10/10.
//   ROUND 3  Every entry is the output of running THE REAL GATE, real config,
//            real tolerance, ten times, against a FRESH UNMASKED baseline. The
//            failure count and the diff pixels/ratio are quoted.
//   ROUND 4  (this one) Round 3 was right about the METHOD and wrong about the
//            INSTRUMENT, twice, in the same direction — both errors made an
//            unstable card look stable. Both are fixed and every entry is
//            re-derived. See "TWO MORE INSTRUMENT BUGS" below; the short
//            version is that `--repeat-each=10` is not ten trials and
//            `VRT_UNMASKED=1` was not measuring the shipping configuration.
//
// ⚠ THE CIRCULARITY TRAP, because it is what makes this easy to get wrong:
// the committed baselines have the magenta mask BAKED IN. Remove a mask,
// re-run, and the live capture is compared against a magenta baseline — it
// differs BY CONSTRUCTION and "proves" the mask was needed. Any honest
// derivation MUST regenerate a fresh unmasked baseline first. `VRT_UNMASKED=1`
// (e2e/vrt/vrt-capture.ts) exists to make that one command:
//
//     # 1. fresh unmasked baselines — git rm first: Playwright only REWRITES
//     #    a snapshot when the comparison fails, but always WRITES a missing one
//     VRT_UNMASKED=1 npx playwright test --config=vrt/vrt.config.ts \
//       --update-snapshots --grep '<scene>'
//     # 2. the real gate, N times, in N SEPARATE PROCESSES — NOT --repeat-each
//     VRT_UNMASKED=1 E2E_PORT=5591 \
//       scripts/vrt-derive-trials.sh '<scene>' 20
//
// `vrt-frame-stability.spec.ts` is RETIRED AS A SOURCE OF TRUTH. It is kept as
// a diagnostic (its bounding box still names WHICH element moves, which is
// useful), but no entry here may cite it as justification. Its predictions
// disagreed with the gate on 2 of 7 cards — a probe that disagrees with the
// gate is worse than no probe, because its output looks authoritative.
//
// ─────────────────────────────────────────────────────────────────────────
// THE 2026-08-01 DERIVATION, IN FULL, RE-RUN UNDER THE CORRECTED INSTRUMENTS.
// darwin, real gate, real config, real tolerance, fresh unmasked baselines,
// and — the round-4 change — N SEPARATE PLAYWRIGHT PROCESSES rather than
// `--repeat-each=N` inside one. "cannot baseline" means `--update-snapshots`
// itself could not produce an expected image (the card never reached two
// consecutive agreeing captures), which is a STRONGER result than any n/N rate.
//
//   scene                          unmasked gate result             verdict
//   ─────────────────────────────  ───────────────────────────────  ─────────
//   analogVco                      10/10 processes PASS             NO MASK ✂
//   warrenspectrum (after fix ↓)   10/10 processes PASS             NO MASK ✂
//   toybox         (after fix ↓)   10/10 processes PASS             NO MASK ✂
//   dockscope                      10/10 processes PASS             no mask
//   reshaper                       10/10 processes PASS             no mask
//   scope                          10/10 processes PASS             no mask
//   cube / snh-seq-scope-on/-off / vco-scope-audio-trace
//                                  3 full sweeps + strict, PASS     no mask
//   timelorde  (UNMASKED)          13/20 processes — 35 % FAIL      MASK ↓
//   timelorde  (WRAP mask, final)  16/16 processes PASS             MASK ↓
//   mandelbulb                     cannot baseline                  MASK ↓
//   wavesculpt-blink-ribbons       cannot baseline                  MASK ↓
//   wavesculpt-blink-gate-elec.    cannot baseline                  MASK ↓
//
// The seven `10/10 processes` rows are one command:
//   E2E_PORT=5591 scripts/vrt-derive-trials.sh \
//     '(analogVco|warrenspectrum|toybox|mandelbulb|dockscope|reshaper|scope) card matches' 10
//   (the run also covered `hypercube`, a scene DELETED with its module on
//   2026-08-10 — it passed 10/10 unmasked too, so dropping it changes nothing
//   about the conclusion; the `seven … rows` count below is the run's, not
//   this table's.)
//
// THREE MASKS DELETED (registry 7 → 4). Two of them by FIXING THE CARD rather
// than hiding it, which is always the better trade and is what `scope` did
// with `__scopeVrtSeed`:
//
//   * warrenspectrum — the acidwarp hue is `snap.frame * (0.5 + viznoise*7.5)`
//     and `snap.frame` increments once per `readSnapshot()`, i.e. once per card
//     rAF ON THE MAIN THREAD. Suspending audio cannot stop it, which is why
//     the usual scene treatment failed and it got masked instead. Unmasked it
//     measured 9/10 pass, 1 fail at 3 024 px / ratio 0.02 (budget 0.01) — a
//     10 % flake rate that had cost 79 056 px (28.5 % of the card) of deleted
//     coverage. A `__warrenspectrumVrtSeed` frame pin (the `__scopeVrtSeed`
//     pattern) makes it 10/10 with the whole visualiser in the diff.
//   * toybox — `__toyboxFreeze(time, seed)` ALREADY EXISTED and
//     vrt-toybox.spec.ts had been using it since the card landed; the per-card
//     scene simply never called it. Exactly the `scope` bug. Unmasked without
//     it the gate could not even write a baseline (9 settle attempts,
//     5 237-6 783 px, then Timeout 15000 ms); with the scene calling it,
//     10/10 with the shader preview AND the six mini scopes in the diff.
//
// ─────────────────────────────────────────────────────────────────────────
// TWO INSTRUMENT BUGS FOUND WHILE DERIVING THIS, both of which had been
// silently corrupting every previous round's numbers:
//
//   A. `expect.toHaveScreenshot.timeout` IS NOT A PLAYWRIGHT OPTION. The VRT
//      config carried `timeout: 15_000` inside that object under a 14-line
//      comment explaining it existed to stop heavy WebGL cards blowing the
//      5000 ms default. Playwright accepts exactly threshold / maxDiffPixels /
//      maxDiffPixelRatio / animations / caret / scale / stylePath /
//      pathTemplate — there is no `timeout` — so the setting was dropped and
//      the real budget stayed 5000 ms. Every "this card cannot settle" reading
//      was taken under a third of the documented budget. Moved to
//      `expect.timeout` (where Playwright reads it) and guarded by
//      packages/web/src/lib/ui/vrt-config-budget.test.ts. Nothing type-checks
//      e2e/** — that workspace has no `typecheck` script and no tsconfig — so
//      the excess property was never rejected.
//
//   B. THE VRT AUDIO FREEZE WAS A SILENT NO-OP, EVERYWHERE, ALWAYS. Nineteen
//      files did `w.__engine?.()?.ctx.suspend()` inside a
//      `catch { /* already suspended */ }`. The AudioContext is not on the root
//      engine; it is on `getDomain('audio').ctx`. Every call threw and every
//      throw was swallowed. Measured: `state=running` after the "freeze"
//      (e2e/vrt/vrt-sr-probe.spec.ts). See e2e/vrt/vrt-audio-freeze.ts — the
//      fix asserts the suspend actually landed instead of assuming it. This
//      retro-explains the scope saga: `scope` needed a synthetic-buffer seed
//      because the freeze meant to stabilise it never ran.
//
// ─────────────────────────────────────────────────────────────────────────
// TWO MORE INSTRUMENT BUGS (round 4). Both were found by trying to CARRY OUT
// an adversarial verifier's instruction to delete the timelorde mask, and both
// erred in the same direction: they made an unstable card read as stable.
//
//   C. `--repeat-each=N` IS NOT N TRIALS. It is ONE playwright process, ONE
//      browser launch, N tests. Rounds 2 and 3 justified every entry with an
//      "n/10" from `--repeat-each=10`, and for any card whose non-determinism
//      is latched PER BROWSER LAUNCH that measures a single draw of the
//      lottery ten times and prints a confident 100 %.
//
//      MEASURED on timelorde, same card, same fresh unmasked baseline:
//
//        --repeat-each=10, x4 invocations   40/40 PASS   (4 real trials)
//        20 SEPARATE PROCESSES              13/20 PASS   (35 % failure)
//        16 separate processes, MASKED      16/16 PASS   (the control)
//
//      The 40/40 is real, reproducible, and wrong — an adversarial verify used
//      exactly that number ("40/40 across 4 repeats") to conclude this mask was
//      unjustified, and deleting it would have shipped a ~35 %-failing card
//      into the gate. The instrument was invariant to the very dimension under
//      test. `scripts/vrt-derive-trials.sh` is the corrected one, and it is
//      what every row of the table above now quotes.
//
//   D. THE DERIVATION SWITCH WAS PERTURBING THE CARD. `VRT_UNMASKED=1` emptied
//      the mask array but still ran the COMPANION + NEGATIVE CONTROL first —
//      two `locator.screenshot()` captures of the surface plus a stylesheet
//      injection that forces `opacity: 0` and back. Those are rasters and DOM
//      mutations on the exact region under test, and the old comment in
//      vrt-capture.ts asserted they were "orthogonal to whether the region is
//      in the pixel diff".
//
//      MEASURED on timelorde, mask empty in BOTH arms, baseline regenerated in
//      each: 20/20 PASS with the companion path, 7/20 PASS without it. So the
//      switch was answering "is this stable after two extra rasters?" while the
//      shipping question after you delete a registry entry is "is this stable
//      with none of that?". Fixed in vrt-capture.ts: the companion path is now
//      skipped under the flag, so the derivation measures what ships.
//
//      ⚠ C and D COMPOUND, and that is why round 3's timelorde number was so
//      far off. Neither is visible in the output; both produce a clean 10/10.
//
// ─────────────────────────────────────────────────────────────────────────
// THE OTHER GEOMETRY CHANGE: warrenspectrum 526x527 -> 527x527, EXPLAINED.
//
// One pixel of width, which is exactly the size at which "real layout shift"
// and "capture artefact" are indistinguishable from the number alone — and
// they need opposite responses. MEASURED (vrt-geom-probe.spec.ts, `warrenspectrum
// capture geometry`, VRT_PROBE=1), spawning the card BOTH ways:
//
//   SOLO  (pre-scene, one node at 80,80)   x=377            width=526
//                                          floor(377)..ceil(903)   = 526 px
//   SCENE (vco at 60,60 + module at 520,60) x=601.0370483…  width=526.0000610…
//                                          floor(601)..ceil(1127.037) = 527 px
//
// The CSS width is the same to within 6e-5 px — float error from multiplying
// the card by the viewport's 0.974074 scale, NOT a resize. The viewport SCALE
// is identical in both (0.974074); only the fitView TRANSLATE differs
// (299.074 vs 94.5185), because the scene puts the module at graph x=520
// instead of x=80. A Playwright element screenshot spans floor(left)..ceil(right)
// in device px, so an identically-sized card at a FRACTIONAL screen x captures
// one pixel wider than at an integral one.
//
// VERDICT: capture artefact of POSITION, not a layout change. The re-pin is
// correct and nothing about the card needs fixing. The general rule, which
// applies to every future scene: ADDING A VRT_SCENES ENTRY CAN MOVE A
// BASELINE'S PIXEL DIMENSIONS BY ±1 WITHOUT ANYTHING RESIZING, because the
// scene relocates the card. Expect it, and check it with the probe rather than
// re-pinning blind — the probe prints both spawns side by side.
//
// ─────────────────────────────────────────────────────────────────────────
// THE RULES (enforced by packages/web/src/lib/ui/vrt-live-surfaces.test.ts —
// the anti-vacuity guard; that guard is the most important file in this PR)
//
//   * EVERY surface states WHY it is non-deterministic, naming WHAT DRIVES IT
//     (the rAF loop, the analyser, the engine clock, the wall clock) AND the
//     gate result that justifies it. An entry without a stated reason is not
//     allowed and the guard fails the build.
//
//   * EVERY surface carries a COMPANION — the coverage the mask just deleted,
//     restated as floors on region statistics (see vrt-surface-stats.ts).
//     Without this a mask is a licence for the surface to render NOTHING AT
//     ALL and still pass forever, which is precisely the vacuous-assertion
//     class this repo keeps producing.
//
//   * EVERY companion must REJECT a flat render. The guard proves this by
//     EVALUATING each companion against DEAD_RENDER_STATS (black flat) and
//     DEAD_RENDER_STATS_GREY (mid-grey flat) — not by reading it. A companion
//     that only sets a ceiling, or whose floors are all zero, fails the guard.
//
//   * Cards with NO entry here get NO mask and are strict everywhere. Absence
//     from this file is the default and the strong position.
//
// The e2e side additionally runs a LIVE negative control on every run
// (vrt-capture.ts): it forces the surface to `opacity: 0` — which is exactly
// what a surface that painted nothing composites to — VERIFIES the kill
// actually landed (computed opacity is really 0, else it throws), and then
// asserts both that the region's ink collapses AND that the companion rejects
// the measurement. An assertion you cannot make fail is not evidence.
//
// ─────────────────────────────────────────────────────────────────────────
// LINUX BASELINES ARE NOT DONE. READ THIS BEFORE DISPATCHING vrt-update.yml.
//
// Everything above was captured and verified on DARWIN. The linux baselines
// still need a `vrt-update.yml` dispatch, and two of them will NOT regenerate
// on their own:
//
//   `snh-seq-scope-on` and `snh-seq-scope-off` will very likely PASS-BUT-BE-
//   STALE on linux. Their linux PNGs were captured when the scene still had the
//   ch2 VCO cable AND when `freezeAudio` was a silent no-op (see B above). Both
//   of those changed; the resulting linux render is different, but a held-DC
//   scope trace moves few enough pixels that the diff can land UNDER the
//   tolerance. `--update-snapshots` only REWRITES a snapshot when the
//   comparison FAILS, so a sub-tolerance-stale baseline comes back with NOTHING
//   COMMITTED and the dispatch reports green. This is the documented A2/#1213
//   hole, and CLAUDE.md's rule applies verbatim:
//
//     git rm e2e/vrt/__screenshots__/vrt-composite.spec.ts/snh-seq-scope-on.png \
//            e2e/vrt/__screenshots__/vrt-composite.spec.ts/snh-seq-scope-off.png
//
//   FIRST, then dispatch — Playwright always writes a MISSING snapshot.
//
// Also note for that dispatch:
//   * `vco-scope-audio-trace` carried `darwinOnly: true` until 2026-08-10 (its
//     determinism argument is keyed to the capture machine's sampleRate/128 =
//     375 Hz). The flag is gone with the platform dimension, so the scene now
//     captures on linux like any other — and if the runner is not at 48 kHz the
//     trace phase will not settle and it will FAIL loudly rather than skip.
//   * `toybox` and `warrenspectrum` now have VRT_SCENES entries, so their linux
//     baselines are stale by construction (the scene changes what is rendered,
//     not just how stable it is) and WILL fail loudly rather than silently.
//   * `timelorde`'s mask moved from the canvas to the wrap, so its linux
//     baseline is stale too — that one also fails loudly (the magenta rect
//     changes size).
//   * `warrenspectrum`'s DARWIN baseline changed pixel geometry (526x527 ->
//     527x527) purely because its new scene relocates the card — see the
//     geometry section above. Expect the same ±1 on linux; it is not a resize,
//     and it fails loudly (a dimension mismatch always does), so no `git rm` is
//     needed for it.
//   * Dispatch UNSCOPED. `-f grep=…` kills the run as `startup_failure` before
//     any job starts.
//   * ⚠ AND DO NOT TRUST A GREEN LINUX DISPATCH AS A DERIVATION. The masks here
//     are derived on darwin with `scripts/vrt-derive-trials.sh`; a dispatch
//     writes ONE capture per scene, which — per instrument bug C above — is one
//     draw of the lottery for any card that is latched per browser launch. If a
//     linux baseline lands and then flakes in the gate, re-derive on linux with
//     the trials harness before touching the mask list.
//
// ⚠ Read each `rationale`'s force-killed row carefully before copying a floor:
// `opacity: 0` reveals the CARD FACE, which is NOT black. Measured backdrops
// here range from ink 0.0000 / stdDev 0.00 (timelorde) to ink 0.0181 /
// stdDev 5.02 (wavesculpt). A floor has to clear the real backdrop, not a
// notional zero, or it is decoration.

import type { SurfaceCompanion } from './vrt-surface-stats';

export interface LiveSurface {
  /** CSS selector for the non-deterministic region.
   *
   *  ⚠ MUST RESOLVE TO EXACTLY ONE ELEMENT. See `expectCount`. */
  selector: string;
  /** Where the selector is resolved. 'target' (default) = inside the element
   *  being screenshotted (a card). 'page' = the whole page, for the page-level
   *  composite captures where the surface is outside the card. */
  scope?: 'target' | 'page';
  /**
   * How many elements the selector must match. REQUIRED, and the anti-vacuity
   * guard pins it to EXACTLY 1.
   *
   * ─── WHY 1, AND NOT "however many the card has" ───────────────────────
   *
   * The first version of this registry allowed `selector: 'canvas'` with
   * `expectCount: 3, nth: 0`. That masked ALL THREE canvases while the
   * companion measured only `nth(0)` — so 2 of the 3 masked regions had NO
   * assertion behind them and could render nothing forever. Across the
   * registry that was 10 masked canvases with no companion, on 3 scenes,
   * inside the very file whose stated purpose is "a mask cannot silently
   * delete coverage". The mask array and the companion set were two
   * different sets and nothing checked they agreed.
   *
   * ONE ENTRY = ONE REGION = ONE COMPANION removes the gap by construction
   * rather than by a rule someone has to remember: there is no index to get
   * wrong, and `mask.length` is `surfaces.length` is `companions.length`.
   * A card with two non-deterministic canvases registers TWO entries with two
   * narrowed selectors and two measured companions.
   *
   * The count is also live coverage in its own right: the mask hides the
   * region, so "this element still exists, and there is still only one of it"
   * is asserted HERE or nowhere. A card that grows a second canvas fails
   * loudly instead of silently acquiring an uncompanioned mask.
   */
  expectCount: 1;
  /** WHY this region is non-deterministic — name WHAT DRIVES IT. Required;
   *  the anti-vacuity guard enforces a real sentence, not a placeholder. */
  why: string;
  /** The coverage the mask deletes, restated as statistics. Required. */
  companion: SurfaceCompanion;
}

export interface LiveSurfaceScene {
  /** Which spec owns this scene — so a reader can find the capture site, and
   *  so the guard can check the spec actually routes through the shared
   *  helper instead of hand-rolling a `mask:` array. */
  spec: string;
  surfaces: LiveSurface[];
}

/** Keyed by SCENE ID = the snapshot file name without `.png`. For
 *  vrt.spec.ts that is the module type; for the composite specs it is the
 *  scene's own id. One key space, no aliases. */
export const VRT_LIVE_SURFACES: Record<string, LiveSurfaceScene> = {
  // ⚠ THE TWO PER-MODULE CARD SCENES ARE GONE WITH THE SWEEP THAT CAPTURED THEM.
  //
  // `mandelbulb` and `timelorde` were keyed by MODULE TYPE because that is what
  // a `vrt.spec.ts` scene id was — one screenshot per legacy card. That spec is
  // deleted, so both scene ids name a baseline that no longer exists and a
  // surface no capture visits. Their masks' arguments are not lost: each named
  // a live animated canvas on the CARD, and the faceplate equivalents are
  // covered by `workflow-shell-faces.spec.ts` scenes with their own entries.
  //
  // Every remaining key in this registry belongs to a COMPOSITE or FACE spec,
  // which is why the structure guards above (an owning spec file that exists, a
  // committed baseline per scene id) stay meaningful rather than becoming a
  // formality.


  // ⚠ THE ROSTER IS EMPTY, AND THAT IS THE END OF A PRESCRIPTION RATHER THAN A
  // RELAXATION. Its last two members were `wavesculpt-blink-ribbons` and
  // `-gate-electricity`, which masked 84.8 % of their frame — the most
  // expensive masks here — because unpinned `boltPhase` made the two
  // blink_mode-0 scenes impossible to baseline (13 settle attempts, then
  // "Failed to take two consecutive stable screenshots").
  //
  // Their own note wrote the exit condition and the order: *"unblock the camera
  // pass → re-attest → apply the one-line pin → DELETE BOTH ENTRIES BELOW and
  // re-pin two unmasked baselines."* All four steps are done. Pass C
  // (`camera-input.spec.ts`) passes — measured, not assumed — the real-GPU
  // attest was paid on this branch, and `VRT_FIXED_BOLT_PHASE` ships in
  // `WavesculptVizSurface.svelte` beside the wave and wiggle pins it parallels.
  // Both scenes now capture their real render, unmasked and strict.
  //
  // An empty roster means NO MASK ANYWHERE and full strictness everywhere. The
  // machinery stays: `expectVrtSceneScreenshot` still routes every capture, so
  // the next mask has to register, and registering still obliges a companion
  // and a per-run negative control. Adding a key is how a mask happens; there
  // is no other way in.
};

/** Scene ids that carry at least one masked live surface. Exported for the
 *  anti-vacuity guard and for the specs' skip/report plumbing. */
export const MASKED_SCENE_IDS: readonly string[] = Object.keys(VRT_LIVE_SURFACES);

/** Look up a scene's surfaces. Returns an empty array for unregistered scenes
 *  — the default is NO MASK and full strictness. */
export function liveSurfacesFor(sceneId: string): LiveSurface[] {
  return VRT_LIVE_SURFACES[sceneId]?.surfaces ?? [];
}
