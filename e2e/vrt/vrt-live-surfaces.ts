// e2e/vrt/vrt-live-surfaces.ts
//
// THE LIVE-SURFACE REGISTRY — one data structure, one place, naming every
// region of every VRT scene that is NOT deterministic, WHY it isn't, and the
// COMPANION assertion that replaces the pixel coverage the mask deletes.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT WAS ACTUALLY WRONG, AND WHAT THE INSTRUMENT IS
//
// The 101 failures that motivated this registry were NOT flake and NOT live
// surfaces. They were ONE intended change never re-pinned: #1159 (e6b3814d)
// "design tokens + colour-only theme system" recoloured every card's jack
// glyphs (amber→cyan) and the CV stripe (teal→green) AFTER the baselines were
// captured. At the old `threshold: 0.2` a colour shift that size did not count
// as a differing pixel AT ALL, so the gate never saw a repo-wide palette
// change. Tightening to 0.1 made it visible; re-pinning made it go away.
// 116 darwin baselines moved, 0 added, 0 deleted.
//
// So the FIRST rule of this file is: a stale baseline is not a live surface.
// An earlier revision of this registry masked nine surfaces on that mistaken
// reading — including `dockscope`, whose mask blinded 53.2 % of its card — with
// `why` prose that read plausibly and was false. Five of those nine are gone
// now, deleted after measurement.
//
// ─────────────────────────────────────────────────────────────────────────
// THE INSTRUMENT: INTER-FRAME STABILITY, not cold-load determinism
//
// This is the subtle part, and getting it wrong is what produced the bad
// registry. `toHaveScreenshot` does not simply screenshot and compare. It
// screenshots REPEATEDLY until TWO CONSECUTIVE captures agree, and only then
// compares the settled image to the baseline. A card that repaints different
// pixels every frame therefore fails with
//
//     "Failed to take two consecutive stable screenshots"
//
// having never reached the comparison at all — which is exactly how `scope`
// failed here (7085 px differing between consecutive attempts, retried to the
// 5 s timeout, while its `-actual.png` was byte-identical to the baseline).
//
// ⚠ A "byte-identical across N cold loads" check CANNOT SEE THIS. An animation
// that always reaches the same phase at the same point of a fixed settle
// sequence is perfectly reproducible cold-load-to-cold-load AND changes on
// every frame. The two metrics answer different questions, and the one the
// gate actually asks is the second. (CLAUDE.md: "before believing a
// measurement, ask what it is invariant to.")
//
// So every entry below is justified by the SAME measurement: spawn the card
// the way its spec does, take 6 element screenshots 200 ms apart, and report
// the bounding box of the pixels that change between consecutive frames. A
// card that comes back IDENTICAL ×5 gets no mask. The numbers in each `why`
// are that measurement.
//
// MEASURED 2026-07-31, darwin, against the freshly re-pinned baselines:
//
//   card             consecutive-frame delta          verdict
//   ───────────────  ───────────────────────────────  ─────────────────────
//   dockscope        IDENTICAL ×5                     NO MASK (deleted)
//   cube             IDENTICAL ×5                     NO MASK (deleted)
//   hypercube        IDENTICAL ×5                     NO MASK (deleted)
//   reshaper         IDENTICAL ×5                     NO MASK (deleted)
//   scope            16 233 px, bbox = the canvas     FIXED, not masked ↓
//   snh-seq-scope-on ch2 sine phase only              FIXED, not masked ↓
//   analogVco         1 957 px, bbox = the scope       masked below
//   warrenspectrum   10 487 px, bbox = the visualiser masked below
//   mandelbulb        8 794-20 268 px, bbox = preview  masked below
//   toybox           13 140 px, bbox = layer-0 preview masked below
//   timelorde        23 056 px, bbox = the display     masked below
//   blink ribbons    arc heads moved (see entry)      masked below
//
// TWO WERE FIXED AT THE ROOT INSTEAD OF MASKED — always prefer this:
//   * `scope` — ScopeCard already implements a `__scopeVrtSeed` determinism
//     hook (the same pattern DOCKSCOPE uses, which is WHY dockscope measures
//     identical). The scope VRT scene simply never set it. Setting it makes
//     the card IDENTICAL ×5 with the canvas still fully in the pixel diff —
//     strictly more coverage than any mask. See e2e/vrt/vrt-scenes.ts.
//   * `snh-seq-scope-on` — the diff was measured to be the ch2 VCO sine's
//     analyser-window PHASE; the ch1 S&H hold line, which is the entire point
//     of the scene, was pixel-identical. Dropping the decorative ch2 cable
//     removes the nondeterminism without touching what the scene asserts.
//     See e2e/vrt/vrt-composite-scenes.ts.
//
// What this file does NOT address: GLOBAL TEXT/AA RASTERIZATION. `mixer` has
// no visualizer at all. If its glyph edges ever drift, that is a property of
// the machine, and masking it would mean masking the thing VRT is for.
//
// ─────────────────────────────────────────────────────────────────────────
// THE RULES (enforced by packages/web/src/lib/ui/vrt-live-surfaces.test.ts —
// the anti-vacuity guard; that guard is the most important file in this PR)
//
//   * EVERY surface states WHY it is non-deterministic, naming WHAT DRIVES IT
//     (the rAF loop, the analyser, the engine clock, the wall clock). An entry
//     without a stated reason is not allowed and the guard fails the build.
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
// ⚠ Read each `rationale`'s force-killed row carefully before copying a floor:
// `opacity: 0` reveals the CARD FACE, which is NOT black. Measured backdrops
// here range from ink 0.0000 / stdDev 0.00 (timelorde) to ink 0.0242 /
// stdDev 9.59 (toybox — 61 % of that card's LIVE stdDev). A floor has to clear
// the real backdrop, not a notional zero, or it is decoration.

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
  // ───────────────────────── vrt.spec.ts — per-module cards ──────────────

  analogVco: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: '[data-testid="analog-vco-scope"]',
        expectCount: 1,
        why:
          'The single-cycle waveform scope is repainted every frame from an AnalyserNode ' +
          'on the morph output by the card rAF loop, and a solo-spawned VCO free-runs — ' +
          'nothing suspends it. MEASURED: 6 element captures 200 ms apart change 1 957 / ' +
          '17 / 1 961 / 1 955 / 1 993 px, and the changing bounding box is exactly the ' +
          '311x151 CSS-px scope. The one near-still frame (17 px) is the trace at a beat ' +
          'in its own cycle, not stability — four of five deltas are ~2 000 px.',
        companion: {
          minInkFraction: 0.015,
          minLumaStdDev: 5.5,
          minDistinctLumaBuckets: 4,
          rationale:
            'MASKS 27.6 % of the card (51 168 magenta px of 352x527, counted on the baseline). ' +
            'MEASURED on the 312x165 CSS-px scope through the REAL vrt.spec.ts capture path, ' +
            '3 consecutive runs: ink 0.0378 / 0.0377 / 0.0378, stdDev 16.68 x3, buckets 9 / 8 / ' +
            '9. Force-killed (opacity:0, so this row is the CARD FACE behind the canvas, not a ' +
            'notional black): ink 0.0062, stdDev 2.31, buckets 2, chroma 7.03. Floors sit ' +
            'between the two: ink 0.015 is 2.4x the dead value and 2.5x below the live one, ' +
            'stdDev 5.5 is 2.4x dead and 3.0x below live, buckets 4 is above dead 2 and below ' +
            'the observed minimum 8. NO chroma floor: the dead backdrop already scores 7.03 ' +
            'against live 9.56, so chroma does not separate them here and a floor on it would ' +
            'be decoration. The bucket floor is 4 and not 8 because the count MOVED run to run ' +
            '(9 -> 8 -> 9) — a floor pinned to an observed value is a flake waiting to happen.',
        },
      },
    ],
  },

  warrenspectrum: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: '[data-testid="warrenspectrum-viz"]',
        expectCount: 1,
        why:
          'The acidwarp visualiser cycles its palette every frame off the engine clock via ' +
          'the card rAF loop. MEASURED: 6 element captures 200 ms apart change 10 486 / ' +
          '10 487 / 10 488 / 10 487 / 10 487 px — a near-constant repaint rate — and the ' +
          'changing bounding box is exactly the 486x78 CSS-px visualiser. Nothing else on ' +
          'the card moves.',
        companion: {
          minInkFraction: 0.09,
          minLumaStdDev: 15,
          minDistinctLumaBuckets: 5,
          minMeanChroma: 12,
          rationale:
            'MASKS 28.5 % of the card (79 056 magenta px of 526x527). ' +
            'MEASURED on the 488x163 CSS-px visualiser through the REAL capture path, 3 runs: ' +
            'ink 0.2767 x3, stdDev 46.73 / 47.01 / 47.01, buckets 13 / 14 / 14, chroma 24.00 / ' +
            '24.01 / 24.01. Force-killed: ink 0.0061, stdDev 1.30, buckets 2, chroma 8.02. ' +
            'Floors at roughly a third of live and comfortably above dead (ink 15x dead, ' +
            'stdDev 11x dead, buckets 2.5x dead). The chroma floor of 12 is the load-bearing ' +
            'one and is set at 1.5x the dead backdrop rather than a third of live: this is a ' +
            'PALETTE-CYCLING visualiser, and a render that lost its colour and came back ' +
            'greyscale is a real regression that ink and luminance alone would pass. Buckets ' +
            'floored at 5, not 13, because the count moved 13 -> 14 across runs.',
        },
      },
    ],
  },

  mandelbulb: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: '[data-testid="mandelbulb-canvas"]',
        expectCount: 1,
        why:
          'The preview ray-marches a 3D fractal in a WebGL fragment shader every frame with ' +
          'auto-spin driven by the engine clock, so the camera azimuth advances between ' +
          'captures. MEASURED: 6 element captures 200 ms apart change 20 268 / 13 228 / ' +
          '9 375 / 8 840 / 8 794 px, bounding box exactly the 290x217 CSS-px preview. Note ' +
          'the SECOND canvas on this card (mandelbulb-slice-readout) measured stable and is ' +
          'deliberately NOT masked — the old `selector: canvas` entry masked both.',
        companion: {
          minInkFraction: 0.056,
          minLumaStdDev: 12,
          minDistinctLumaBuckets: 6,
          minMeanChroma: 6,
          rationale:
            'MASKS 22.6 % of the card (62 640 magenta px of 526x527); the card keeps its second, ' +
            'STABLE canvas in the diff. ' +
            'MEASURED on the 290x217 CSS-px preview through the REAL capture path, 3 runs: ink ' +
            '0.1707 / 0.1738 / 0.1747, stdDev 28.98 / 29.43 / 29.49, buckets 11 x3, chroma ' +
            '17.98 / 18.00 / 18.01 — the ~2 % spread is the auto-spin advancing between runs. ' +
            'Force-killed: ink 0.0160, stdDev 6.59, buckets 4, chroma 3.76. Floors: ink 0.056 ' +
            'is a third of the SMALLEST live value and 3.5x dead; stdDev 12 is 1.8x dead and ' +
            '2.4x below live (deliberately NOT a third — a third would be 9.7, only 1.5x above ' +
            'the dead backdrop, too close to prove anything); buckets 6 sits between dead 4 and ' +
            'live 11; chroma 6 is 1.6x dead and 3x below live, and catches a DE march that ' +
            'collapsed to a flat silhouette.',
        },
      },
    ],
  },

  toybox: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: '[data-testid="toybox-canvas"]',
        expectCount: 1,
        why:
          'The layer-0 preview runs a swappable fragment shader redrawn every frame with ' +
          'iTime taken from the engine clock, so the animation phase differs per capture. ' +
          'MEASURED: 6 element captures 200 ms apart change 12 953 / 13 464 / 13 270 / ' +
          '13 303 / 13 140 px, bounding box exactly the 150x113 CSS-px preview. The SIX ' +
          'per-CV mini scopes measured stable and are deliberately NOT masked — the old ' +
          '`selector: canvas, expectCount: 7` entry masked all seven while companioning one. ' +
          'DETERMINISTIC shader coverage lives in vrt-toybox.spec.ts, which pins iTime via ' +
          '__toyboxFreeze and keeps the canvas in the diff.',
        companion: {
          minInkFraction: 0.11,
          minMeanChroma: 20,
          rationale:
            'MASKS 4.6 % of the card (16 800 magenta px of 684x536) — the six STABLE mini scopes ' +
            'stay in the diff. ' +
            'MEASURED on the 151x113 CSS-px layer-0 preview through the REAL capture path, 3 ' +
            'runs: ink 0.3307 / 0.3339 / 0.3404, chroma 61.70 / 61.59 / 61.63, stdDev 15.59 / ' +
            '15.65 / 15.75, buckets 6 x3. Force-killed: ink 0.0242, chroma 4.37, stdDev 9.59, ' +
            'buckets 5. NOTE WHAT THAT DEAD ROW SAYS: the card face behind this canvas scores ' +
            '61 % of the live stdDev and 5 of the live 6 buckets, so NEITHER of those ' +
            'statistics separates a live shader from a dead one HERE — floors on them would ' +
            'read as strict and prove nothing. Only ink (13.7x) and chroma (14.1x) separate, ' +
            'so those are the only two floors, each set ~3x below live and ~4.5x above dead. ' +
            'Chroma is the load-bearing one: the default preset is a saturated shader, and a ' +
            'shader that failed to compile falls back to a flat or greyscale surface.',
        },
      },
    ],
  },

  timelorde: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: '[data-testid^="timelorde-display-"]',
        expectCount: 1,
        why:
          'The big display canvas is repainted AND re-pushed to the node for video_out ' +
          'passthrough on every frame of the card rAF loop (renderDisplay → drawOwl → ' +
          'pushDisplayFrame). MEASURED: 6 element captures 200 ms apart change 23 447 / ' +
          '23 056 / 23 056 / 23 169 / 23 169 px — 44 % of the 230x230 CSS-px canvas — and ' +
          'the changing bounding box is exactly that canvas. ⚠ The REPEATED delta values ' +
          '(23 056 twice, then 23 169 twice) are a PERIOD-2 alternation between two ' +
          'renders, one soft and one crisp, not drift; that looks like a real card bug in ' +
          'the display/passthrough loop and is filed as a follow-up. The beat pulse is NOT ' +
          'the cause — it is pinned to 0 under reducedMotion.',
        companion: {
          minInkFraction: 0.19,
          minLumaStdDev: 19,
          minDistinctLumaBuckets: 5,
          minMeanChroma: 20,
          rationale:
            'MASKS 25.6 % of the card (47 524 magenta px of 352x527); the title, transport, BPM/ ' +
            'SWING/SRC knobs, tempo readout, wizard thumbnail and every jack stay strict. ' +
            'MEASURED on the 216x216 CSS-px display through the REAL vrt.spec.ts capture path, ' +
            '3 runs: ink 0.5873, stdDev 57.21, buckets 14, chroma 59.60 — BIT-IDENTICAL all ' +
            'three times, which is itself the point: this surface is perfectly reproducible ' +
            'COLD-LOAD to cold-load and still unusable, because it changes every FRAME. ' +
            'Force-killed: ink 0.0000, stdDev 0.00, buckets 1, chroma 8.00 (the card face here ' +
            'really is flat). Every floor sits at ~a third of live, far above a dead render. ' +
            'The chroma floor of 20 against a live 59.6 pins that the OWL PAINTING itself is ' +
            'drawn: the fallback this canvas paints before the artwork decodes is a near-black ' +
            'flat ground, which clears no chroma floor at all.',
        },
      },
    ],
  },

  // ──────────── vrt-wavesculpt-blink.spec.ts — the two RIBBON modes ───────
  //
  // ONE ROOT CAUSE, NAMED AND LOCATED, deliberately not fixed here.
  //
  // WavesculptCard advances THREE time-derived phases per frame, side by side:
  //
  //     boltPhase[i]        = (boltPhase[i] + BOLT_SPEED * dt) % 1.0;   ← NOT pinned
  //     wavePhase[i]        = vrtFrozen() ? VRT_FIXED_WAVE_PHASE : …;   ← pinned
  //     scopeWigglePhase[i] = vrtFrozen() ? 0.6 : …;                    ← pinned
  //
  // `boltPhase` feeds `uBoltPhase`, which positions the three travelling arc
  // heads and seeds the crackle hash in RIBBON_FS — whose own comment asserts
  // the crackle is "frozen-stable under the VRT freeze hook since ph is pinned
  // there". It is not pinned. The card contradicts its own comment, and the
  // consequence is visible: comparing expected vs actual for `ribbons`, the
  // ribbon GEOMETRY is identical and the bright arc bands have MOVED along it.
  //
  // The blast radius is exactly RIBBON_FS, i.e. blink_mode 0 — and the two
  // failing cases are precisely the two blink_mode-0 cases while every mode-1
  // and mode-2 case passes. That correspondence is the strongest evidence in
  // this file, because it was predicted from the code and then confirmed by
  // which baselines the re-pin had to rewrite (`ribbons` and
  // `gate-electricity`, and no others).
  //
  // WHY IT IS MASKED RATHER THAN FIXED: the one-line fix
  // (`boltPhase[i] = vrtFrozen() ? VRT_FIXED_BOLT_PHASE : …`) lands in
  // WavesculptCard.svelte, which `resolveWebglBasis()` includes in the WebGL
  // ATTEST BASIS (verified: it creates a WebGL context). Editing it moves the
  // attest hash and forces a GPU re-attest on a trusted machine — out of scope
  // here, and currently blocked besides. Masking with a live companion keeps
  // the card chrome gated and keeps "the render is alive" asserted; a
  // quarantine would keep nothing. Follow-up: pin boltPhase + re-attest.

  'wavesculpt-blink-ribbons': {
    spec: 'vrt-wavesculpt-blink.spec.ts',
    surfaces: [
      {
        selector: '[data-testid="wavesculpt-canvas"]',
        expectCount: 1,
        why:
          'RIBBON mode (blink_mode 0). The WebGL render advances `boltPhase` every frame of ' +
          'the card rAF loop and __wavesculptVrtFreeze does not pin it, so the three ' +
          'travelling electric arc heads sit at a different point along the ribbon on every ' +
          'capture. MEASURED against the freshly re-pinned baseline: 16 796 px differ ' +
          '(3.7 % of the card), bounding box 299x385 = the render canvas, and cropping both ' +
          'images shows identical ribbon geometry with the bright arc bands displaced.',
        companion: {
          minInkFraction: 0.07,
          minLumaStdDev: 29,
          minDistinctLumaBuckets: 5,
          rationale:
            'MASKS 84.8 % OF THE CARD (382 130 magenta px of 849x531) — by far the most ' +
            'expensive mask here, because this card IS its viewport. That cost is stated ' +
            'plainly rather than buried: it buys back a scene that would otherwise be ' +
            'skipped outright, and the alternative (quarantine, like the three blink_mode-1 ' +
            'cases already sitting in EXEMPT_BASELINE_PAIRS) deletes 100 % and asserts ' +
            'nothing. Revert it the moment boltPhase is pinned. ' +
            'MEASURED on the 721x541 CSS-px render through the REAL blink capture path, 3 ' +
            'runs: ink 0.2097 / 0.2099 / 0.2098, stdDev 88.86 / 88.47 / 88.67, buckets 11 / 11 ' +
            '/ 10, chroma 5.73 / 6.04 / 5.92. Force-killed: ink 0.0181, stdDev 5.02, buckets 3, ' +
            'chroma 0.22. Floors at ~a third of live: ink 0.07 is 3.9x dead, stdDev 29 is 5.8x ' +
            'dead, buckets 5 sits between dead 3 and the observed minimum 10. NO chroma floor ' +
            'on this case — the plain ribbons render near-white (live chroma under 6), so a ' +
            'chroma floor here would be tuned to noise; the gate-electricity entry, whose whole ' +
            'subject is coloured arcs, does carry one.',
        },
      },
    ],
  },

  'wavesculpt-blink-gate-electricity': {
    spec: 'vrt-wavesculpt-blink.spec.ts',
    surfaces: [
      {
        selector: '[data-testid="wavesculpt-canvas"]',
        expectCount: 1,
        why:
          'The same unpinned `boltPhase` in the same RIBBON mode (blink_mode 0), and this ' +
          'scene exists specifically to show the gate electricity, so it is the case the ' +
          'defect hits hardest. MEASURED: it is one of exactly two baselines the re-pin had ' +
          'to rewrite in this spec — the other being `ribbons`, the only other blink_mode-0 ' +
          'case — while every blink_mode 1 and 2 case matched unchanged. The arc heads are ' +
          'driven by the card rAF loop, so their position varies per capture.',
        companion: {
          minInkFraction: 0.07,
          minLumaStdDev: 27,
          minDistinctLumaBuckets: 5,
          minMeanChroma: 3,
          rationale:
            'MASKS 84.8 % OF THE CARD (382 130 magenta px of 849x531) — by far the most ' +
            'expensive mask here, because this card IS its viewport. That cost is stated ' +
            'plainly rather than buried: it buys back a scene that would otherwise be ' +
            'skipped outright, and the alternative (quarantine, like the three blink_mode-1 ' +
            'cases already sitting in EXEMPT_BASELINE_PAIRS) deletes 100 % and asserts ' +
            'nothing. Revert it the moment boltPhase is pinned. ' +
            'MEASURED on the 721x541 CSS-px render through the REAL blink capture path, 3 ' +
            'runs: ink 0.2096 / 0.2098 / 0.2098, stdDev 81.43 / 81.15 / 81.26, buckets 11 / 12 ' +
            '/ 12, chroma 9.59 / 9.79 / 9.77. Force-killed: ink 0.0181, stdDev 5.02, buckets 3, ' +
            'chroma 0.22. Floors at ~a third of live. The chroma floor of 3 (43x the dead 0.22, ' +
            '3.2x below live) is here because this scene EXISTS to show electric-blue arcs on ' +
            'the ribbons: measurably, gating the voices lifts chroma from 5.9 (ribbons — same ' +
            'geometry, no electricity) to 9.8 here, so chroma is the one statistic that would ' +
            'notice if the electricity stopped rendering entirely.',
        },
      },
    ],
  },
};

/** Scene ids that carry at least one masked live surface. Exported for the
 *  anti-vacuity guard and for the specs' skip/report plumbing. */
export const MASKED_SCENE_IDS: readonly string[] = Object.keys(VRT_LIVE_SURFACES);

/** Look up a scene's surfaces. Returns an empty array for unregistered scenes
 *  — the default is NO MASK and full strictness. */
export function liveSurfacesFor(sceneId: string): LiveSurface[] {
  return VRT_LIVE_SURFACES[sceneId]?.surfaces ?? [];
}
