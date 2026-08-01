// e2e/vrt/vrt-live-surfaces.ts
//
// THE LIVE-SURFACE REGISTRY — one data structure, one place, naming every
// region of every VRT scene that is NOT deterministic, WHY it isn't, and the
// COMPANION assertion that replaces the pixel coverage the mask deletes.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// The VRT tolerance used to be threshold 0.2 / maxDiffPixelRatio 0.05. That
// budget was not absorbing "sub-pixel AA drift" — it was absorbing TWO
// different real signals at once, and measurement (2026-07-31, darwin, the
// tightened 0.1 / 0.01 budget) separated them:
//
//   1. LIVE-VISUALIZER PHASE. `dockscope`'s entire diff IS the sine trace —
//      a running canvas captured at a different phase. `animations:'disabled'`
//      and `reducedMotion:'reduce'` do NOT stop a canvas rAF loop driven by an
//      AnalyserNode: Playwright's animation freeze covers CSS animations and
//      Web Animations, not `requestAnimationFrame` painting into a 2D/WebGL
//      context. Nor does suspending the AudioContext help as much as the scene
//      comments claim — the suspend resolves after a nondeterministic number
//      of frames, so the LAST painted phase varies run to run.
//
//   2. GLOBAL TEXT/AA RASTERIZATION. `mixer` has no visualizer at all and its
//      diff is every glyph edge and every border — identical shapes, different
//      antialiasing. That is a GLOBAL property of the machine, not a property
//      of any one scene, and it is NOT what this file addresses. (PR #1264 is
//      measuring whether it reproduces on a darwin CI runner.)
//
// Masking class (1) is correct and makes the gate mean something. Masking
// class (2) would mean masking the text — i.e. masking the thing the VRT is
// for. So: this file only ever names class-(1) surfaces.
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
// (vrt-capture.ts): it covers each surface with an opaque div — pixel-
// identical to a dead render — and asserts both that the statistics collapse
// AND that the companion rejects them. An assertion you cannot make fail is
// not evidence.

import type { SurfaceCompanion } from './vrt-surface-stats';

export interface LiveSurface {
  /** CSS selector for the non-deterministic region. */
  selector: string;
  /** Where the selector is resolved. 'target' (default) = inside the element
   *  being screenshotted (a card). 'page' = the whole page, for the page-level
   *  composite captures where the surface is outside the card. */
  scope?: 'target' | 'page';
  /** When the selector matches several elements, ALL of them are masked but
   *  the companion measures this index. Default 0. */
  nth?: number;
  /** How many elements the selector must match. Optional, but it is itself
   *  coverage the mask deleted ("the card still has two canvases"), so prefer
   *  setting it. */
  expectCount?: number;
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
  //
  // These three are SCENE-DRIVEN modules (they have a VRT_SCENES entry) that
  // vrt.spec.ts deliberately captured UNMASKED, on the theory that suspending
  // the AudioContext freezes the trace. Measurement says otherwise: their
  // whole diff is the trace, at 2-10 % of the card. The scene stays — driving
  // a real 261 Hz sine through the module is what makes the companion
  // meaningful — but the trace region is now masked and asserted statistically
  // instead of pixel-wise.

  scope: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 1,
        why:
          "SCOPE's trace canvas is repainted every frame from an AnalyserNode " +
          'window by a requestAnimationFrame loop in the card. Playwright ' +
          "animations:'disabled' freezes CSS/Web animations only — it cannot stop " +
          'a rAF that paints into a 2D context, and the scene\'s ' +
          'AudioContext.suspend() resolves after a nondeterministic number of ' +
          'frames, so the last painted WINDOW PHASE varies run to run. The trace ' +
          'shape is identical; its x-offset is not.',
        companion: {
          minInkFraction: 0.04,
          minLumaStdDev: 10,
          minDistinctLumaBuckets: 5,
          rationale:
            'MEASURED on the 290x293 CSS-px trace canvas, 3 consecutive runs: ' +
            'ink 0.1138 / 0.1136 / 0.1138, stdDev 28.66 / 28.49 / 28.52, buckets 11 / ' +
            '11 / 11 — run-to-run spread under 0.2 %, because phase drift moves WHERE ' +
            'the ink is, not HOW MUCH. Force-killed the same region scores 0 / 0.00 / 1. ' +
            'Floors sit at roughly a third of the measured value: far enough below to ' +
            'ignore drift, far enough above zero that a blank canvas cannot clear them, ' +
            'and tight enough that losing the trace and keeping only the grid fails.',
        },
      },
    ],
  },

  dockscope: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 1,
        why:
          'DOCKSCOPE re-plots its VECTOR trace at live pixel size on every meter ' +
          'frame off a rAF loop. The scene pins __dockscopeVrtSeed so the SIGNAL ' +
          'is synthetic and fixed, but the seed does not pin WHICH FRAME the ' +
          'capture lands on, and the plot window advances per frame — so the ' +
          'captured phase still moves. This is the scene whose measured diff was ' +
          'literally the sine trace and nothing else.',
        companion: {
          minInkFraction: 0.035,
          minLumaStdDev: 9,
          minDistinctLumaBuckets: 4,
          rationale:
            'MEASURED on the 261x126 CSS-px rail canvas, 3 consecutive runs: ink ' +
            '0.1079 / 0.1079 / 0.1079, stdDev 26.26 x3, buckets 9 x3 — bit-identical ' +
            'across runs. Force-killed: 0 / 0.00 / 1. The seeded trace is the ONLY ' +
            'non-background content in this canvas, so ink fraction measures "the ' +
            'trace is drawn at all" directly. Floors at ~a third of measured. This ' +
            'companion is the ONLY trace coverage dockscope has — no other spec ' +
            'renders it — so it is deliberately the strictest of the three.',
        },
      },
    ],
  },

  analogVco: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 1,
        why:
          'ANALOG VCO now carries a single-cycle waveform scope fed by an ' +
          'AnalyserNode on the morph output, repainted from a rAF loop. Already ' +
          'masked by the legacy VRT_MODULE_MASKS table for exactly this reason — ' +
          'this entry moves it into the registry AND gives it the companion the ' +
          'old table never had.',
        companion: {
          minInkFraction: 0.012,
          minLumaStdDev: 6,
          minDistinctLumaBuckets: 4,
          rationale:
            'MEASURED on the 312x165 CSS-px scope canvas, 3 consecutive runs: ink ' +
            '0.0377 / 0.0377 / 0.0376, stdDev 16.69 / 16.69 / 16.67, buckets 9 / 9 / 8. ' +
            'Force-killed: 0 / 0.00 / 1. Note the bucket count MOVED (9 -> 8), which is ' +
            'why the bucket floor is 4 and not 8 — a floor pinned to the observed ' +
            'maximum is a flake waiting to happen. Ink and stdDev floors at ~a third ' +
            'of measured. A solo-spawned VCO free-runs, so the trace needs no patch.',
        },
      },
    ],
  },

  // ─────────── MIGRATED FROM VRT_MODULE_MASKS — same mask, new companion ───
  //
  // These were already masked by the pre-registry `VRT_MODULE_MASKS` table, so
  // moving them here changes NOTHING about the captured pixels and needs no
  // baseline regen. What changes is that the deleted coverage is now asserted:
  // before, each of these cards could have stopped rendering entirely and the
  // baseline would not have moved by one pixel. Every floor below is derived
  // from three consecutive probe runs (VRT_PROBE=1, see
  // e2e/vrt/vrt-surface-probe.spec.ts) against the force-killed region.

  cube: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 3,
        nth: 0,
        why:
          'CUBE renders a live rotating 3D scene into a WebGL2 canvas from its own ' +
          'requestAnimationFrame loop — the camera advances every frame off the ' +
          'engine clock, so no two captures land on the same orientation. The two ' +
          'smaller canvases are snapshot-driven OUTPUT scopes on the same rAF. ' +
          'expectCount pins all three: the mask hides them, so their PRESENCE is ' +
          'only asserted here.',
        companion: {
          minInkFraction: 0.05,
          minLumaStdDev: 15,
          minDistinctLumaBuckets: 5,
          rationale:
            'MEASURED on the 312x254 CSS-px main render, 3 consecutive runs: ink ' +
            '0.1553 x3, stdDev 47.30 x3, buckets 14 x3 (bit-identical — the rotation ' +
            'is deterministic under the pinned settle, it is the FRAME BOUNDARY that ' +
            'is not). Force-killed: 0 / 0.00 / 1. Floors at ~a third of measured, so a ' +
            'blank GL buffer or a render that lost its geometry fails while ordinary ' +
            'frame-to-frame motion does not.',
        },
      },
    ],
  },

  hypercube: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 3,
        nth: 0,
        why:
          'HYPERCUBE is the CUBE render path applied to a Schlegel-projected ' +
          'tesseract: a live WebGL2 render advanced every frame by the card rAF ' +
          'loop, plus two snapshot-driven OUTPUT scope canvases on the same loop. ' +
          'The 4D rotation never repeats within a capture window.',
        companion: {
          minInkFraction: 0.05,
          minLumaStdDev: 14,
          minDistinctLumaBuckets: 5,
          rationale:
            'MEASURED on the 312x254 CSS-px main render, 3 consecutive runs: ink ' +
            '0.1559 x3, stdDev 43.33 x3, buckets 14 x3. Force-killed: 0 / 0.00 / 1. ' +
            'Floors at ~a third of measured. A tesseract that collapsed to a point or ' +
            'a cleared buffer drops ink and spread to ~0 and fails immediately.',
        },
      },
    ],
  },

  warrenspectrum: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 1,
        why:
          'WARRENSPECTRUM carries the acidwarp visualiser canvas — a palette-cycling ' +
          'render driven off the engine clock by a rAF loop, so the palette phase ' +
          'differs on every capture even when the geometry is identical.',
        companion: {
          minInkFraction: 0.09,
          minLumaStdDev: 15,
          minDistinctLumaBuckets: 5,
          minMeanChroma: 8,
          rationale:
            'MEASURED on the 488x163 CSS-px visualiser. Probe path, 3 runs: ink 0.2767 ' +
            'x3, stdDev 46.80 / 46.80 / 46.81, buckets 13 / 13 / 12, chroma 24.02 / ' +
            '24.02 / 24.00. REAL vrt.spec.ts path, 3 runs: buckets 11 / 14 / 11. ' +
            'Force-killed: 0 / 0.00 / 1 / 0.00. Note buckets swing 11-14 ACROSS RUNS, ' +
            'so the bucket floor is 5, not 12 — a floor pinned to an observed value ' +
            'here would have flaked on the second run. The chroma floor is here ' +
            'because a colour-cycling visualiser rendering in greyscale is a real ' +
            'regression that ink and luminance alone would not catch.',
        },
      },
    ],
  },

  mandelbulb: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 1,
        why:
          'MANDELBULB ray-marches a 3D fractal every frame in a WebGL fragment ' +
          'shader with auto-spin driven by the engine clock, so the camera azimuth ' +
          'advances between captures. The DE march is also GPU-precision dependent.',
        companion: {
          minInkFraction: 0.06,
          minLumaStdDev: 10,
          minDistinctLumaBuckets: 5,
          minMeanChroma: 5,
          rationale:
            'MEASURED on the 290x217 CSS-px preview. Probe path, 3 runs: ink 0.1956 / ' +
            '0.1987 / 0.2017, stdDev 31.91 / 32.22 / 32.50, buckets 12 x3, chroma ' +
            '18.31 / 18.36 / 18.40. REAL vrt.spec.ts path, 3 runs: ink 0.1795 / 0.1748 ' +
            '/ 0.1763, stdDev 29.93 / 29.60 / 29.59, buckets 11 x3. Note the two paths ' +
            'disagree by ~12 % — the spin has advanced a different amount by the time ' +
            'each settles — which is exactly why the floors sit at ~a third of ' +
            'measured: 0.06 is ~2.9x below the smallest value ever observed on either ' +
            'path. Force-killed: 0 / 0.00 / 1 / 0.00.',
        },
      },
    ],
  },

  reshaper: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 1,
        why:
          'RESHAPER blits its coordinate-remap output to an on-card WebGL preview ' +
          'from the engine clock blit loop. Unpatched it shows the idle remap field ' +
          'rather than black, and the blit lands on a different engine frame each ' +
          'capture.',
        companion: {
          minInkFraction: 0.08,
          minLumaStdDev: 17,
          minDistinctLumaBuckets: 3,
          rationale:
            'MEASURED on the 308x174 CSS-px preview, 3 consecutive runs: ink 0.2542 ' +
            'x3, stdDev 52.14 x3, buckets 5 x3. Force-killed: 0 / 0.00 / 1. The bucket ' +
            'floor is 3 (not 5) because the idle field is a low-tone-count image and a ' +
            'floor pinned to the observed value would be a flake waiting to happen.',
        },
      },
    ],
  },

  toybox: {
    spec: 'vrt.spec.ts',
    surfaces: [
      {
        selector: 'canvas',
        expectCount: 7,
        nth: 0,
        why:
          'TOYBOX runs a swappable fragment shader; the layer-0 preview canvas is ' +
          'redrawn every frame with iTime taken from the engine clock, so the ' +
          'animation phase differs per capture. The six small canvases are the ' +
          'per-parameter mini previews on the same render loop. The DETERMINISTIC ' +
          'shader coverage is vrt-toybox.spec.ts, which pins iTime via ' +
          '__toyboxFreeze and includes the canvas in the diff.',
        companion: {
          minInkFraction: 0.14,
          minLumaStdDev: 5,
          minDistinctLumaBuckets: 3,
          minMeanChroma: 20,
          rationale:
            'MEASURED on the 151x113 CSS-px layer-0 preview. Probe path, 3 runs: ink ' +
            '0.4178 / 0.4224 / 0.4254, stdDev 15.88 / 15.93 / 16.12, buckets 6 x3, ' +
            'chroma 61.63 / 61.67 / 61.89. REAL vrt.spec.ts path, 3 runs: ink 0.3543 / ' +
            '0.3479 / 0.3475, stdDev 16.04 / 15.89 / 15.92, chroma 61.59 / 61.62 / ' +
            '61.62 — ~18 % lower ink than the probe, because the shader animation is ' +
            'at a different phase. Force-killed: 0 / 0.00 / 1 / 0.00. The chroma floor ' +
            'of 20 is the load-bearing one: the default preset is a saturated shader, ' +
            'and a shader that failed to compile falls back to a flat or greyscale ' +
            'surface that clears ink but not chroma.',
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
