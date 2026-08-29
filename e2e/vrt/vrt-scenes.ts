// e2e/vrt/vrt-scenes.ts
//
// VRT scene registry — per-module recipes for setting up the rack so
// the module's canvas shows REAL CONTENT instead of an empty / masked
// region in its baseline.
//
// The default vrt.spec.ts behaviour spawns just the module and snaps a
// screenshot. For modules with a canvas that's only interesting once
// driven by an upstream signal (SCOPE — when patched, etc.),
// we register a scene here describing the auxiliary patch (extra
// modules + cables) and an optional pre-screenshot pause.
//
// After driving the canvas with a deterministic signal we SUSPEND the
// AudioContext so the analyser-driven trace freezes. Subsequent rAF
// loops keep reading the same frozen buffer → pixel-stable across
// runs, so VRT's tolerance budget can stay tight even with the canvas
// included in the diff.
//
// Modules with a scene are also REMOVED from VRT_MODULE_MASKS so the
// canvas region IS included in the pixel diff (the baseline shows the
// actual rendered content; future regressions in the rendering path
// catch a real diff instead of being silently masked).

import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch, type SpawnNode, type SpawnEdge } from '../tests/_helpers';
import { freezeAudioContext } from './vrt-audio-freeze';

interface VrtSceneBase {
  /** Extra nodes + the module under test. The module-under-test's id
   *  MUST be 'vrt-1' so the existing card-selector in vrt.spec.ts
   *  still finds it. */
  nodes: SpawnNode[];
  /** Cables. */
  edges: SpawnEdge[];
  /** Pre-screenshot pause (ms). Lets the audio worklet generate enough
   *  signal for the analyser to fill its buffer before we freeze the
   *  AudioContext. */
  settleMs?: number;
  /** Optional extra setup AFTER spawnPatch (e.g. load a file into a
   *  card, seek a <video> to a fixed frame + pause). Runs before the
   *  settle pause. Used by the videoOut/VIDEOBOX scene to drive a
   *  deterministic decoded frame into the output canvas. */
  afterSpawn?: (page: Page) => Promise<void>;
}

/**
 * THE FREEZE IS DENY-BY-DEFAULT, ENFORCED BY THE TYPE.
 *
 * `freezeAudio: false` captures off a RUNNING graph. Every faced module in the
 * roster today is struck or silent, so a scene that skips the suspend looks
 * exactly as green as one that takes it — right up until the first free-running
 * voice, which then cannot baseline at all. The opt-out therefore may not be a
 * bare boolean: the union below makes `freezeAudioWhy` REQUIRED whenever
 * `freezeAudio` is false, so the justification is co-located with the decision
 * and `tsc` refuses the undeclared form.
 *
 * ⚠ This replaced `SCENE_FREEZE_OFF_CEILING = 7` (deleted 2026-08-10). The
 * ceiling counted these entries and could say nothing about any of them; the
 * `why` names each one. Contrary to the plan that scheduled the deletion, the
 * ceiling was NOT redundant with `FREEZE_OPT_OUTS` in vrt-meta.test.ts — that
 * record counts `bootWithFace(…, { freezeAudio })` CALL SITES in the face specs,
 * a different mechanism over a different population. Both are still gated;
 * neither is counted.
 */
export type VrtScene = VrtSceneBase &
  (
    | {
        /** When true (the default), freeze the AudioContext after settleMs so
         *  the trace stays pixel-stable across runs. */
        freezeAudio?: true;
        freezeAudioWhy?: never;
      }
    | {
        /** Capture with the AudioContext RUNNING. */
        freezeAudio: false;
        /** REQUIRED with `freezeAudio: false`: what makes this scene
         *  deterministic INSTEAD of the suspend. Asserted non-trivial in
         *  vrt-meta.test.ts. */
        freezeAudioWhy: string;
      }
  );

/** Absolute path to the trimmed lobby clip used to drive a real decoded
 *  <video> frame through VIDEOBOX -> VIDEO-OUT for the videoOut baseline. */
const LOBBY_CLIP = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

/** Registry. Keyed by the module-under-test's type. Modules NOT in
 *  this map fall back to the default vrt.spec.ts behaviour (spawn
 *  alone, no extra setup). */
export const VRT_SCENES: Record<string, VrtScene> = {
  // MOOG960: the 960 "auto-runs on placement" (its own docs), and the card
  // polls a LIVE active-column indicator every rAF. So a bare spawn captures a
  // MOVING playhead and the baseline records whichever column the screenshot
  // happened to catch — measured on a plain spawn: column 0 at t=0, 2 at 600ms,
  // 3 at 1200ms. It rode along for months because the timing was repeatable;
  // when the topbar lost a row the pane grew 34px, the fitView zoom moved and
  // linux started landing on a different column than the capture had — CI's
  // moog960-diff.png is exactly the column-2 and column-3 headers plus their
  // knob rings, 6537px, while 135 sibling scenes passed.
  //
  // Fixed at the SOURCE of the non-determinism rather than by masking the grid
  // (which is the scene's whole subject) or by dropping the card from
  // STRICT_VRT_MODULES (whose ratchet correctly refuses to shrink): column 2's
  // MODE is set to STOP (2 = halt holding this column, see moog960.ts), so the
  // pointer advances off column 0, lands on column 1 and HALTS. Measured:
  // isRunning=false, currentColumn=1, identical at 600ms and 1200ms — and
  // because the card blanks the indicator when the transport is stopped, NO
  // column is highlighted at all. There is no timing left to race.
  moog960: {
    nodes: [
      {
        id: 'vrt-1',
        type: 'moog960',
        position: { x: 60, y: 60 },
        domain: 'audio',
        params: { mode2: 2 },
      },
    ],
    edges: [],
    settleMs: 400,
  },

  // SYNESTHESIA: drive copy A's input with a 261 Hz sine (analogVco default
  // 'sine' out, pitch 0 V/oct ≈ C4) so band 2 (low-mid 200–1k Hz) lights its VU
  // meter deterministically; copy B is left dark. After settle we freeze the
  // AudioContext — the worklet stops posting snapshots, so the last meter
  // levels hold and the two VU canvases are pixel-stable across runs.
  synesthesia: {
    nodes: [
      { id: 'src',   type: 'analogVco',   position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'vrt-1', type: 'synesthesia', position: { x: 520, y: 60 }, domain: 'audio' },
    ],
    edges: [
      {
        id: 'e_src_syn',
        from: { nodeId: 'src',   portId: 'sine' },
        to:   { nodeId: 'vrt-1', portId: 'a_in' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
    settleMs: 500,
    freezeAudio: true,
  },

  // SCOPE: a real analogVco sine is wired into ch1 (so the audio path is
  // exercised), and `__scopeVrtSeed` is pinned so the trace paints a FIXED
  // synthetic 261 Hz window instead of whichever live analyser buffer the
  // capture happens to land on. Exactly the DOCKSCOPE pattern below.
  //
  // ⚠ THE SEED USED TO BE MISSING HERE, and that was the whole bug.
  // MEASURED 2026-07-31 (darwin, tightened budget): without it, six
  // consecutive element captures of the scope card 200 ms apart differ by
  // ~16 000 px each, with the changing bounding box exactly the 288x293 CSS-px
  // trace canvas — i.e. the card NEVER settles. `toHaveScreenshot` needs two
  // consecutive stable captures before it will even compare, so the test died
  // as "Failed to take two consecutive stable screenshots" after retrying to
  // the 5 s timeout, while the `-actual.png` it finally wrote was byte-
  // identical to the baseline. Suspending the AudioContext does NOT fix this:
  // the card keeps repainting from `eng.read(node,'snapshot')` on the shared
  // meter frame. With the seed set, the same measurement returns IDENTICAL ×5.
  //
  // ch2Freq: 0 makes the seeded ch2 buffer all zeros (sin(0) ≡ 0), i.e. the
  // flat centre line an unpatched channel already showed — so the seed changes
  // the trace's PHASE DETERMINISM and not the picture's meaning. The canvas
  // stays fully inside the pixel diff; this is a fix, not a mask.
  scope: {
    nodes: [
      { id: 'src',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'vrt-1', type: 'scope',     position: { x: 520, y: 60 }, domain: 'audio' },
    ],
    edges: [
      {
        id: 'e_src_scope',
        from: { nodeId: 'src',   portId: 'sine' },
        to:   { nodeId: 'vrt-1', portId: 'ch1'  },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
    afterSpawn: async (page) => {
      // Pin the seed BEFORE the settle so every paint is the deterministic one.
      await page.evaluate(() => {
        (globalThis as unknown as {
          __scopeVrtSeed?: { ch1Freq?: number; ch2Freq?: number; ch2Phase?: number };
        }).__scopeVrtSeed = { ch1Freq: 261, ch2Freq: 0 };
      });
      // A few rAFs so the seeded repaint lands before the settle window.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(
          () => new Promise<void>((r) => requestAnimationFrame(() => r())),
        );
      }
    },
    settleMs: 300,
    freezeAudio: true,
  },

  // DOCKSCOPE (P2.5b): the slim 1u rail scope. A real analogVco sine is
  // wired into ch1 (the audio path is exercised), but we pin
  // `__dockscopeVrtSeed` so the trace paints a fixed synthetic 220 Hz
  // sine instead of the live analyser window: the card re-plots its
  // VECTOR trace at live pixel size every meter frame, and the seed
  // keeps the plotted window phase-locked run-to-run (RASTERIZE's seed
  // pattern + SCOPE's scene shape).
  dockscope: {
    nodes: [
      { id: 'src',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'vrt-1', type: 'dockscope', position: { x: 520, y: 60 }, domain: 'audio' },
    ],
    edges: [
      {
        id: 'e_src_dockscope',
        from: { nodeId: 'src',   portId: 'sine' },
        to:   { nodeId: 'vrt-1', portId: 'ch1'  },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
    afterSpawn: async (page) => {
      // Pin the seed BEFORE settle so every paint is the deterministic one.
      await page.evaluate(() => {
        (globalThis as unknown as { __dockscopeVrtSeed?: boolean })
          .__dockscopeVrtSeed = true;
      });
      // A few rAFs so the seeded repaint lands before the settle window.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(
          () => new Promise<void>((r) => requestAnimationFrame(() => r())),
        );
      }
    },
    settleMs: 300,
    freezeAudio: true,
  },

  // RASTERIZE: drive the audio input with a 261 Hz sine (analogVco default
  // sine out, pitch 0 V/oct ≈ C4). RASTERIZE paints the audio samples as
  // voltage-per-pixel into its 640×480 frame in raster order; a steady tone
  // builds horizontal bands (now 640×480 / 4:3 per pipeline flip).
  //
  // VRT determinism (task #198): freeze-on-AudioContext-suspend alone leaves
  // the cursor at a wall-clock-dependent position (how many rAF ticks land
  // before suspend resolves varies run-to-run by ±a few frames; at default
  // samplesPerFrame each frame advances the cursor ~0.78 scanlines (#2001), so over
  // a settle window the cursor wanders by tens of rows → same band pattern
  // shifted vertically → 16%-pixel diffs busting the tolerance budget).
  //
  // We set `__rasterizeVrtSeed` BEFORE spawn so the factory's first paint
  // is one deterministic full-frame fill from a fixed 261 Hz synthetic
  // sine — no analyser, no wall clock, identical pixels every run. The
  // analogVco source is still wired (the audio domain is exercised) but
  // its samples never reach the painter while seed mode is active.
  // Mirrors FOXY's `__foxyVrtSeed` + PEAKSTATE's `__peakstateVrtSeed`.
  rasterize: {
    nodes: [
      { id: 'src',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      {
        id: 'vrt-1',
        type: 'rasterize',
        position: { x: 520, y: 60 },
        domain: 'audio',
        params: { samplesPerFrame: 8000, gain: 1, cursor: 0, wrap: 0 },
      },
    ],
    edges: [
      {
        id: 'e_src_rasterize',
        from: { nodeId: 'src',   portId: 'sine' },
        to:   { nodeId: 'vrt-1', portId: 'in' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
    afterSpawn: async (page) => {
      // Pin the seed BEFORE settle so the first paint is the
      // deterministic one. The factory's advanceOncePerFrame checks the
      // flag on every call and paints once-then-holds.
      await page.evaluate(() => {
        (globalThis as unknown as { __rasterizeVrtSeed?: boolean })
          .__rasterizeVrtSeed = true;
      });
      // A couple of rAFs so the seed paint lands + the card's blit catches it.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(
          () => new Promise<void>((r) => requestAnimationFrame(() => r())),
        );
      }
    },
    settleMs: 300,
    freezeAudio: true,
  },

  // VIDEO-OUT: drive a real, frozen VIDEOBOX frame into the output so the
  // baseline proves the VIDEOBOX -> VIDEO-OUT path renders video content
  // (the regression this PR fixes — output used to be black). We load the
  // trimmed lobby clip into a VIDEOBOX, seek to a FIXED timestamp, and
  // pause, so the decoded frame is the same one every run. Codec frame-timing
  // is not bit-identical ACROSS platforms, which is why this scene used to be
  // captured on darwin and deferred on linux; with one baseline set, authored
  // by the platform that gates, that comparison never crosses platforms. The
  // hard non-black + moving gate lives in tests/videobox-output.spec.ts.
  videoOut: {
    nodes: [
      { id: 'vb',    type: 'videobox', position: { x: 60,  y: 60 }, domain: 'video' },
      { id: 'vrt-1', type: 'videoOut', position: { x: 520, y: 60 }, domain: 'video' },
    ],
    edges: [
      {
        id: 'e_vb_out',
        from: { nodeId: 'vb',    portId: 'video' },
        to:   { nodeId: 'vrt-1', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
    freezeAudio: false,
    freezeAudioWhy:
      'no analyser-driven trace in this scene — determinism comes from the ' +
      '<video> element itself, seeked to a fixed frame and paused in afterSpawn.',
    settleMs: 400,
    async afterSpawn(page) {
      await page.setInputFiles('[data-testid="videobox-file-input"]', LOBBY_CLIP);
      await page.locator('[data-testid="videobox-card"][data-has-local-file="true"]')
        .waitFor({ state: 'attached', timeout: 8000 });
      // Seek to a fixed frame + pause so the decoded frame is the same
      // every run (no wall-clock playback advance during capture).
      await page.evaluate(async () => {
        const v = document.querySelector('[data-testid="videobox-video"]') as HTMLVideoElement | null;
        if (!v) return;
        v.pause();
        await new Promise<void>((resolve) => {
          const onSeeked = (): void => { v.removeEventListener('seeked', onSeeked); resolve(); };
          v.addEventListener('seeked', onSeeked, { once: true });
          v.currentTime = 1.5; // mid-clip — past the title card, in moving footage
          // Guard: if the seek is a no-op (already there), resolve anyway.
          if (Math.abs(v.currentTime - 1.5) < 0.01 && v.readyState >= 2) {
            v.removeEventListener('seeked', onSeeked); resolve();
          }
        });
      });
      // Let a few engine frames upload the frozen frame into the output FBO.
      await page.waitForTimeout(250);
    },
  },

  // RUTTETRA (authentic forward-scatter scope): SHAPES → RUTTETRA; pure
  // function of a procedural, time-independent source → pixel-stable.
  // The SHAPES source is a TRIANGLE (vertically asymmetric — apex up) so
  // the baseline locks RUTTETRA's vertical ORIENTATION too: a Y-flip of
  // the input sample (the fix in fix/ruttetra-input-vflip) visibly moves
  // the apex, which a centered circle could not have caught.
  ruttetra: {
    nodes: [
      { id: 'src',   type: 'shapes',   position: { x: 60,  y: 60 }, domain: 'video', params: { shape: 2, zoom: 2.2 } },
      { id: 'vrt-1', type: 'ruttetra', position: { x: 520, y: 60 }, domain: 'video' },
    ],
    edges: [
      {
        id: 'e_src_ruttetra',
        from: { nodeId: 'src',   portId: 'out' },
        to:   { nodeId: 'vrt-1', portId: 'z'   },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
    freezeAudio: false,
    freezeAudioWhy:
      'RUTTETRA is a pure function of a procedural, time-independent SHAPES ' +
      'source, so the render is pixel-stable without suspending anything.',
    settleMs: 400,
  },

  // FOXY (hybrid SWOLEVCO→RASTERIZE→XYZ→live-wavetable→WAVECEL): FOXY is
  // SELF-DRIVING — its internal mini-SWOLEVCO feeds the raster, so it needs
  // no upstream patch. We spawn it alone, let the internal chain run long
  // enough for the raster to fill + the wavetable to build, then FREEZE the
  // AudioContext. FOXY's bridge halts on suspend (ctx.state === 'suspended'),
  // so the raster painting, XYZ field, and animated wavetable all stop on a
  // fixed frame → pixel-stable across runs. The card's three preview
  // canvases (RASTER / XYZ / live WAVETABLE) are INCLUDED in the diff (no
  // mask) so the baseline proves the whole chain renders real content.
  foxy: {
    nodes: [
      { id: 'vrt-1', type: 'foxy', position: { x: 120, y: 60 }, domain: 'audio' },
    ],
    edges: [],
    // FOXY v2 has TWO drifting rasters + a Box; the live fill is timing-
    // dependent, so freeze-on-suspend alone leaves >5% pixel drift between
    // runs. We set `__foxyVrtSeed` so FOXY paints BOTH rasters once from fixed
    // synthetic waveforms (no analyser, no wall-clock) → pixel-stable Box +
    // wavetable. freezeAudio still suspends so nothing re-drifts after.
    afterSpawn: async (page) => {
      await page.evaluate(() => {
        (globalThis as unknown as { __foxyVrtSeed?: boolean }).__foxyVrtSeed = true;
      });
      // A few rAFs so the seed paint lands + the wavetable display catches it.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
    },
    settleMs: 600,
    freezeAudio: true,
  },

  // WAVESCULPT (alpha-rotate regression lock): pins the ALPHA layer VISIBLE
  // at a non-zero rotation; render-freeze hook makes the time-driven render
  // deterministic. Was VRT-exempt; de-exempted via the freeze.
  wavesculpt: {
    nodes: [
      { id: 'src',   type: 'shapes',     position: { x: 60,  y: 60 }, domain: 'video' },
      {
        id: 'vrt-1',
        type: 'wavesculpt',
        position: { x: 520, y: 60 },
        domain: 'audio',
        params: {
          rot: 0.3, pos_z: 0.35, zoom: 1.3,
          // noise/bloom are no longer params — WAVESCULPT's light CRT pass is
          // unconditional (bloom 0.4, noise 0.05 baked into BENT_FS). The
          // frozen uTime keeps the grain deterministic, so the capture is
          // still bit-stable; it just carries the module's real look now.
          thickness4: 0.9, alpha_brightness: 1.6,
        },
      },
    ],
    edges: [
      {
        id: 'e_src_alpha',
        from: { nodeId: 'src',   portId: 'out' },
        to:   { nodeId: 'vrt-1', portId: 'alpha_in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
    freezeAudio: true,
    settleMs: 500,
    async afterSpawn(page) {
      await page.evaluate(() => {
        (globalThis as unknown as { __wavesculptVrtFreeze?: boolean }).__wavesculptVrtFreeze = true;
      });
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
    },
  },
  // SPECTROGRAPH (scrolling sonogram video generator): the card preview is
  // a LIVE scrolling buffer driven by an AnalyserNode — never bit-stable
  // across runs (column count + buffered FFT both depend on wall-clock
  // scheduling). We set __spectrographVrtFreeze BEFORE driving rAFs so the
  // module fills its WHOLE column buffer ONCE from a FIXED synthetic
  // spectrum (three loud peaks over a quiet floor) and HOLDS it — the
  // preview canvas then paints identical pixels every run. No audio source
  // is needed (the freeze overrides the FFT readout entirely), so
  // freezeAudio is false. Parallels WAVESCULPT's __wavesculptVrtFreeze +
  // PEAKSTATE's __peakstateVrtSeed.
  spectrograph: {
    nodes: [{ id: 'vrt-1', type: 'spectrograph', position: { x: 120, y: 60 }, domain: 'audio' }],
    edges: [],
    freezeAudio: false,
    freezeAudioWhy:
      '__spectrographVrtFreeze overrides the FFT readout entirely and holds one ' +
      'fixed synthetic spectrum, so no audio source and no suspend are involved.',
    settleMs: 400,
    afterSpawn: async (page) => {
      await page.evaluate(() => {
        (globalThis as unknown as { __spectrographVrtFreeze?: boolean }).__spectrographVrtFreeze = true;
      });
      // A few rAFs so the one-shot frozen fill lands + the preview catches it.
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
    },
  },

  // CUBE: NO scene. The card's headline visual is now a LIVE, rotating 3D
  // WebGL2 render (issue #2) — the camera + rAF keep animating regardless of an
  // AudioContext freeze, so the canvas can't be pinned to a deterministic single
  // frame. CUBE therefore drops its VRT scene and masks its <canvas> elements
  // (see VRT_MODULE_MASKS.cube); the VRT gate is the deterministic card chrome
  // (knobs / dropdowns / toggles / handles). The 3D render + slice/spread math
  // are covered by the cube-dsp unit tests, the worklet capture test, the
  // node-ART baselines, and the per-port e2e.
  // PEAKSTATE (animated mandala generator): the module is self-driving
  // (internal pen + ring buffer + 3D rotation, no external signal). The
  // pen trajectory is wall-clock driven, so two runs freeze at slightly
  // different points along the trail. We set `__peakstateVrtSeed` so the
  // module paints ONCE from a deterministic 120-sample ring + frozen
  // rotation, then HOLDS that frame across subsequent draws → pixel-
  // stable RGB preview + 3D + mono outputs. No audio is involved, so
  // freezeAudio is false (the AudioContext suspend isn't what's freezing
  // the render; the seed flag is).
  peakstate: {
    nodes: [
      { id: 'vrt-1', type: 'peakstate', position: { x: 120, y: 60 }, domain: 'video' },
    ],
    edges: [],
    freezeAudio: false,
    freezeAudioWhy:
      'no audio is involved: __peakstateVrtSeed paints once from a deterministic ' +
      '120-sample ring + frozen rotation and HOLDS it — the seed flag is the freeze.',
    afterSpawn: async (page) => {
      await page.evaluate(() => {
        (globalThis as unknown as { __peakstateVrtSeed?: boolean }).__peakstateVrtSeed = true;
      });
      // A few rAFs so the seed paint lands + the preview canvas catches it.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
    },
    settleMs: 500,
  },

  // BACKDRAFT (video feedback generator): drive in_a / in_b + both key
  // masks from SHAPES sources, let the feedback loop settle, then FREEZE
  // BACKDRAFT (params.freeze = 1) so the time-evolving accumulator holds
  // its last output — pixel-stable across runs. We use SHAPES (fully
  // procedural + time-independent: rotate 0, no uTime) for every input so
  // the source + masks are identical every run; with BACKDRAFT frozen the
  // captured frame is deterministic.
  //
  //   in_a    <- big centred circle  (the seed image being smeared)
  //   in_b    <- tiled 5×5 squares    (crossfaded in by MIX=0.5)
  //   lighten <- tiled triangles      (LIGHTEN boosts feedback where bright)
  //   darken  <- big centred square   (DARKEN cuts feedback in the middle)
  //
  // The baseline should show a video-feedback TUNNEL/SPIRAL: the spatial
  // transform (ZOOM 1.06 + ROTATE 6°/iter) re-zooms + re-rotates the
  // fed-back frame a little each pass, so the echoes spiral inward into a
  // tunnel — the iconic feedback look, not flat brightness accumulation.
  // The triangle lighten-mask boosts the trail; the centre-square darken
  // punches a dim hole. No audio is involved, so we don't freeze the
  // AudioContext.
  backdraft: {
    nodes: [
      // Sparse, SMALL sources (mostly black) so the transformed feedback
      // echoes — not a flat source wash — dominate the frame. in_a = a
      // tiny centred circle that the tunnel drags inward into a spiral;
      // in_b = a few tiled squares. MIX leans hard toward in_a.
      { id: 'src_a',  type: 'shapes', position: { x: 40,  y: 40  }, domain: 'video', params: { shape: 0, tile: 0, zoom: 0.28 } },
      { id: 'src_b',  type: 'shapes', position: { x: 40,  y: 260 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 3, zoom: 0.45 } },
      // lighten = tiled triangles → BOOST bands (feedback runs hot, → white).
      { id: 'mask_l', type: 'shapes', position: { x: 40,  y: 480 }, domain: 'video', params: { shape: 2, tile: 1, tileN: 4, zoom: 0.9 } },
      // darken = tiled squares in the CORNERS so it trims the outer trail
      // but leaves the central tunnel/spiral intact + visible.
      { id: 'mask_d', type: 'shapes', position: { x: 40,  y: 700 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 5, zoom: 0.5 } },
      // ZOOM>1 + ROTATE≠0 => an inward-zooming, twisting tunnel (spiral).
      // delay=0 taps the most-recent frame so the transform compounds every
      // frame (deepest tunnel); high feedback keeps many echoes alive.
      { id: 'vrt-1',  type: 'backdraft', position: { x: 520, y: 60 }, domain: 'video',
        params: { mix: 0.12, feedback: 0.97, delay: 0, luma: 1.0, chroma: 1.5, r: 1.0, g: 1.0, b: 1.0,
                  lighten: 1.0, darken: 0.5, zoom: 1.15, rotate: 16, offsetX: 0, offsetY: 0 } },
    ],
    edges: [
      { id: 'e_a', from: { nodeId: 'src_a',  portId: 'out' }, to: { nodeId: 'vrt-1', portId: 'in_a'    }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'e_b', from: { nodeId: 'src_b',  portId: 'out' }, to: { nodeId: 'vrt-1', portId: 'in_b'    }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'e_l', from: { nodeId: 'mask_l', portId: 'out' }, to: { nodeId: 'vrt-1', portId: 'lighten' }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'e_d', from: { nodeId: 'mask_d', portId: 'out' }, to: { nodeId: 'vrt-1', portId: 'darken'  }, sourceType: 'mono-video', targetType: 'video' },
    ],
    freezeAudio: false,
    freezeAudioWhy:
      'a VIDEO feedback loop: the scene pins the frame by writing backdraft\'s own ' +
      'freeze param AFTER the settle window, which an AudioContext suspend cannot do.',
    settleMs: 700,
    async afterSpawn(page) {
      // Let the feedback loop run + settle (settleMs covers this), then
      // FREEZE BACKDRAFT so its output stops evolving and the capture is
      // pixel-stable. We set freeze AFTER the settle window so the trails
      // have built up + the spatial transform has compounded into a deep
      // tunnel/spiral before we pin the frame.
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['vrt-1'];
          if (n) n.params.freeze = 1;
        });
      });
      // A few rAFs so the freeze param reaches the engine + the last
      // pre-freeze frame is the one held + blitted.
      await page.waitForTimeout(150);
    },
  },

  // LUSH GARDEN: the garden is spawn-clock-driven + RNG-placed, so the
  // default solo spawn is nondeterministic. __lushgardenVrtSeed re-seeds
  // the factory with a FIXED, fully-grown 24-plant set (fixed RNG) and
  // suppresses all further spawning — the scene then only has to wait for
  // the referenced cutout textures to finish their lazy fetch+bake
  // (pendingLoads → 0). The clean preview is time-invariant afterwards
  // (only the un-previewed psychedelic output animates), so the capture
  // is pixel-stable with no mask.
  lushgarden: {
    nodes: [
      { id: 'vrt-1', type: 'lushgarden', position: { x: 80, y: 80 }, domain: 'video' },
    ],
    edges: [],
    afterSpawn: async (page) => {
      await page.evaluate(() => {
        (globalThis as unknown as { __lushgardenVrtSeed?: number }).__lushgardenVrtSeed = 0x5eed;
      });
      // Wait until the seeded plant set exists AND every referenced cutout
      // has settled (ready or failed) — then the render is deterministic.
      await page.waitForFunction(() => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } | null;
          } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        if (!ve?.read) return false;
        const seeded = ve.read('vrt-1', 'vrtSeeded');
        const pending = ve.read('vrt-1', 'pendingLoads');
        const ready = ve.read('vrt-1', 'readyCount');
        return seeded === 1 && pending === 0 && typeof ready === 'number' && ready > 0;
      }, undefined, { timeout: 20000 });
    },
    // A few more blit ticks after the last bake so the preview shows the
    // final composite.
    settleMs: 400,
    freezeAudio: false,
    freezeAudioWhy:
      '__lushgardenVrtSeed pins a fixed 24-plant set and suppresses further ' +
      'spawning, so the previewed surface is time-invariant with no suspend.',
  },

  // ── FROGGER — the CARD scene that let the module leave EXEMPT_FROM_VRT ────
  //
  // The exemption said "animated sprite motion (cars/logs/turtles) + auto-start
  // defeat deterministic single-frame capture" and named its own exit
  // condition: a deterministic-time hook that can freeze the game at a KNOWN
  // TICK. `__froggerVrtTicks` is that hook.
  //
  // ⚠ FROGGER NEEDS NO SEED, WHICH IS WHY THIS IS THREE LINES AND NIBBLES IS
  // NOT. There is no `Math.random` anywhere in `frogger-state.ts`: the sprite
  // table is a fixed clone, the traffic is deterministic and `dtSeconds` is a
  // constant. The board was ALREADY a pure function of tick count — the only
  // nondeterminism was HOW MANY ticks landed before the screenshot.
  //
  // ⚠ AND THE PIN SUPPRESSES THE GAME RATHER THAN FREEZING IT, which is
  // strictly stronger than the audio suspend this scene also performs. The
  // factory rebuilds the state, steps it exactly this many ticks, and then
  // never steps again — so the captured board is TIME-INVARIANT, not "whichever
  // frame the settle happened to reach". (The scheduler clock is a Web Worker
  // `setInterval` and is NOT gated on the AudioContext, so `freezeAudio` alone
  // could never have stopped this game.)
  //
  // ⚠ SET FROM `afterSpawn`, I.E. AFTER CONSTRUCTION — which the factory
  // handles, because it reads the global BOTH at construction (the face
  // harness installs it via `addInitScript`) and once more in the tick (this
  // path). A construction-only read would leave this scene silently unpinned.
  frogger: {
    nodes: [
      { id: 'vrt-1', type: 'frogger', position: { x: 80, y: 80 }, domain: 'audio' },
    ],
    edges: [],
    afterSpawn: async (page) => {
      await page.evaluate(() => {
        // ⚠ NOT A POPULATION COUNT — it is a POSITION on the game's own
        // timeline: how far into the first life this baseline sits. 96 ticks x
        // 25 ms = 2.4 s of play, which is past the auto-start, well into the
        // traffic's travel (the sprite clock runs at ~100 Hz of game time
        // inside the 40 Hz real tick, so ~240 sprite ticks have landed) and two
        // seconds off the 60 s timer — so the frame differs from the boot frame
        // in the traffic layout AND in the HUD, and cannot be reached by a
        // stepper that never ran. Nothing patched into the steering inputs, so
        // the frog sits at its spawn cell and no gate has fired.
        (globalThis as unknown as { __froggerVrtTicks?: number }).__froggerVrtTicks = 96;
      });
      // A few rAFs so the pinned board is painted before the suspend.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
    },
    settleMs: 300,
    freezeAudio: true,
  },

  // ── GIBRIBBON — the CARD scene the rewrite's designed-in seams unlock ─────
  //
  // The retired exemption said "animated scrolling ribbon + sprites defeat
  // deterministic single-frame capture"; the rewritten engine is a pure
  // function of (seed, scheduler tick count, inputs), so this scene pins all
  // three time terms and the picture is TIME-INVARIANT:
  //
  //   __gibribbonVrtSeed   pins the xorshift stream (course tie-breaks + the
  //                        per-run reseed chain);
  //   __gibribbonVrtTicks  rebuilds the run and steps it EXACTLY this many
  //                        scheduler ticks with idle inputs, then SUPPRESSES
  //                        all further stepping (the frogger/pong shape —
  //                        stronger than a freeze, which holds whichever frame
  //                        the harness caught);
  //   __videoEngineFreezeTime is deliberately NOT needed here: with the tick
  //                        pin suppressing the stepper the render phase is
  //                        constant too (paint is a pure function of engine
  //                        state; there is no wall-clock term in the frame).
  //
  // ⚠ SET FROM `afterSpawn`, i.e. AFTER construction — the factory handles
  // it, reading both globals at construction (the face harness's addInitScript
  // path) AND once more in the tick (this path).
  //
  // 168 ticks × 25 ms = 4.2 s of ATTRACT self-play: past the count-in, into a
  // populated course with the bot scoring — so the frame shows the ribbon,
  // sprites/line-art, the lookahead lane, a non-zero SCORE and the ATTRACT
  // label (the honest-self-play claim, in pixels).
  gibribbon: {
    nodes: [
      { id: 'vrt-1', type: 'gibribbon', position: { x: 80, y: 80 }, domain: 'video' },
    ],
    edges: [],
    afterSpawn: async (page) => {
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __gibribbonVrtSeed?: number; __gibribbonVrtTicks?: number; __gibribbonVrtNoWad?: boolean;
        };
        w.__gibribbonVrtSeed = 0xc0de;
        w.__gibribbonVrtTicks = 168;
        // Pin the ART PATH too: the WAD decode is async and the file's
        // presence varies by environment (gitignored, setup-fetched), so the
        // capture pins to the line-art fallback — a real shipped path.
        w.__gibribbonVrtNoWad = true;
      });
      // A few rAFs so the pinned board paints before the capture settles.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
    },
    settleMs: 300,
    freezeAudio: false,
    freezeAudioWhy:
      '__gibribbonVrtTicks suppresses the stepper after exactly 168 scheduler ticks and the '
      + 'paint is a pure function of the engine state (no wall-clock term), so the surface is '
      + 'time-invariant with no suspend — and an audio suspend could not have stopped it anyway '
      + '(the game clock is a Web Worker interval).',
  },

  // NIBBLES (snake game module): the game state is RNG-seeded and
  // tick-driven, so the on-card framebuffer evolves frame-to-frame.
  // We set globalThis.__nibblesVrtSeed BEFORE spawning so the factory
  // seeds with a fixed value (mirrors FOXY's __foxyVrtSeed). With
  // freezeAudio suspending the AudioContext the on-card preview poll
  // stops pulling new ImageData snapshots, so the captured frame is
  // pixel-stable run-to-run.
  nibbles: {
    nodes: [
      { id: 'vrt-1', type: 'nibbles', position: { x: 80, y: 80 }, domain: 'video' },
    ],
    edges: [],
    afterSpawn: async (page) => {
      // Pin the RNG seed so the snake position + food placement are
      // identical across runs. NIBBLES checks globalThis.__nibblesVrtSeed
      // on each draw frame and one-shot-resets the game once it sees the
      // flag — so setting it AFTER spawn is fine.
      await page.evaluate(() => {
        (globalThis as unknown as { __nibblesVrtSeed?: number }).__nibblesVrtSeed = 0xC0DE;
      });
      // A few rAFs so the seeded reset + paint land before we suspend audio.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
    },
    // Long enough that a few game ticks run + bake some snake motion + a
    // pellet eat (per spec at default tick_ms=80ms, ~12 ticks/sec).
    settleMs: 500,
    freezeAudio: true,
  },

  // TOYBOX: FIXED AT THE ROOT INSTEAD OF MASKED.
  //
  // The layer-0 preview runs a fragment shader with iTime taken from the engine
  // clock, so a solo spawn repaints every frame. MEASURED 2026-08-01 through
  // the REAL gate at the real tolerance, UNMASKED: `--update-snapshots` could
  // not even WRITE a baseline — 9 consecutive settle attempts differing 5 237-
  // 6 783 px (ratio 0.02) and then "Failed to take two consecutive stable
  // screenshots. Timeout 15000ms exceeded". That is stronger than an n/10
  // failure rate: the gate cannot produce an expected image at all.
  //
  // But the card ALREADY SHIPS THE FIX: `__toyboxFreeze(time, seed)` pins iTime,
  // renders one frame at that time, blits it into the on-card canvas, fills the
  // six per-CV scope rings deterministically from `seed`, and sets `frozen` so
  // the preview stops ticking. vrt-toybox.spec.ts has used it since the card
  // landed and its baselines are pixel-stable. The main per-card scene simply
  // never called it — the exact shape of the `scope` bug (`__scopeVrtSeed`
  // existed and the scene did not set it), and the exact same remedy: pin it and
  // keep the canvas fully inside the pixel diff. Strictly more coverage than the
  // 4.6 % mask it replaces, because the six mini scopes AND the shader preview
  // are now both diffed.
  toybox: {
    nodes: [{ id: 'vrt-1', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    edges: [],
    afterSpawn: async (page) => {
      // Wait for the hook to be installed (onMount) rather than assuming it.
      await page.waitForFunction(
        () => typeof (globalThis as { __toyboxFreeze?: unknown }).__toyboxFreeze === 'function',
        undefined,
        { timeout: 10_000 },
      );
      await page.evaluate(() => {
        const g = globalThis as unknown as { __toyboxFreeze?: (t?: number, s?: number) => void };
        g.__toyboxFreeze?.(2.0, 0xC0DE);
      });
      // A few frames so the pinned render + the frozen scope draws land.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
    },
    settleMs: 300,
    freezeAudio: false,
    freezeAudioWhy:
      'the card exposes __toyboxFreeze, which pins BOTH the render time and the ' +
      'RNG seed — a strictly stronger freeze than suspending the AudioContext.',
  },
};

/** Set up the rack for `type`. Returns true if a scene was applied
 *  (so the spec knows to skip the default solo-spawn path). */
export async function applyVrtScene(page: Page, type: string): Promise<boolean> {
  const scene = VRT_SCENES[type];
  if (!scene) return false;
  await spawnPatch(page, scene.nodes, scene.edges);
  if (scene.afterSpawn) await scene.afterSpawn(page);
  await page.waitForTimeout(scene.settleMs ?? 300);
  if (scene.freezeAudio !== false) {
    // Suspend the AudioContext so the analyser-fed canvases freeze on their
    // last-rendered buffer, and ASSERT the suspend landed.
    //
    // ⚠ This block used to read `w.__engine?.()?.ctx.suspend()` inside a
    // `catch { /* already suspended */ }`. The root engine has no `.ctx` — the
    // AudioContext is on `getDomain('audio')` — so it threw on every call, the
    // catch ate it, and NO VRT SCENE HAS EVER ACTUALLY FROZEN ITS AUDIO. See
    // e2e/vrt/vrt-audio-freeze.ts for the measurement (`state=running` after
    // the "freeze") and the full writeup.
    await freezeAudioContext(page, `VRT scene "${type}"`);
    // Let one more rAF land so the last-pre-suspend buffer renders.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
  return true;
}
