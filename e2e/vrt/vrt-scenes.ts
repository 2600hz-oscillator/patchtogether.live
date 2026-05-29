// e2e/vrt/vrt-scenes.ts
//
// VRT scene registry — per-module recipes for setting up the rack so
// the module's canvas shows REAL CONTENT instead of an empty / masked
// region in its baseline.
//
// The default vrt.spec.ts behaviour spawns just the module and snaps a
// screenshot. For modules with a canvas that's only interesting once
// driven by an upstream signal (SCOPE, WAVVIZ — when patched, etc.),
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

export interface VrtScene {
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
  /** When true, freeze the AudioContext after settleMs so the trace
   *  stays pixel-stable across runs. Defaults to true. */
  freezeAudio?: boolean;
  /** Optional extra setup AFTER spawnPatch (e.g. load a file into a
   *  card, seek a <video> to a fixed frame + pause). Runs before the
   *  settle pause. Used by the videoOut/VIDEOBOX scene to drive a
   *  deterministic decoded frame into the output canvas. */
  afterSpawn?: (page: Page) => Promise<void>;
}

/** Absolute path to the trimmed lobby clip used to drive a real decoded
 *  <video> frame through VIDEOBOX -> VIDEO-OUT for the videoOut baseline. */
const LOBBY_CLIP = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

/** Registry. Keyed by the module-under-test's type. Modules NOT in
 *  this map fall back to the default vrt.spec.ts behaviour (spawn
 *  alone, no extra setup). */
export const VRT_SCENES: Record<string, VrtScene> = {
  // SCOPE: drive ch1 with a 220 Hz sine (analogVco default 'sine'
  // output, pitch defaults to 0 V/oct ≈ C4 ≈ 261 Hz). The scope's
  // default timeMs=20 ms window holds ~5 cycles — plenty of trace
  // pixels for the diff to mean something, but few enough that
  // sub-cycle phase variation is bounded.
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
    settleMs: 300,
    freezeAudio: true,
  },

  // RASTERIZE: drive the audio input with a 261 Hz sine (analogVco default
  // sine out, pitch 0 V/oct ≈ C4). RASTERIZE paints the audio samples as
  // voltage-per-pixel into its 640×360 frame in raster order; a steady tone
  // builds drifting horizontal bands. We bump samplesPerFrame to 6000 for
  // the scene (vs the 800 default) so the cursor sweeps the whole frame
  // within the settle window (~38 frames) and the baseline shows a filled,
  // banded frame rather than a couple of painted scanlines. After settle we
  // suspend the AudioContext; RASTERIZE freezes its painting on suspend
  // (ctx.state === 'suspended'), so the on-card canvas is pixel-stable.
  rasterize: {
    nodes: [
      { id: 'src',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      {
        id: 'vrt-1',
        type: 'rasterize',
        position: { x: 520, y: 60 },
        domain: 'audio',
        params: { samplesPerFrame: 6000, gain: 1, cursor: 0, wrap: 0 },
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
    settleMs: 900,
    freezeAudio: true,
  },

  // VIDEO-OUT: drive a real, frozen VIDEOBOX frame into the output so the
  // baseline proves the VIDEOBOX -> VIDEO-OUT path renders video content
  // (the regression this PR fixes — output used to be black). We load the
  // trimmed lobby clip into a VIDEOBOX, seek to a FIXED timestamp, and
  // pause, so the decoded frame is the same one every run. Codec frame-
  // timing isn't bit-identical across platforms, so the darwin baseline is
  // captured here and linux is marked pending (EXEMPT_BASELINE_PAIRS); the
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
    // Don't freeze the AudioContext — there's no analyser-driven trace
    // here; the <video> itself is paused on a fixed frame for stability.
    freezeAudio: false,
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
          thickness4: 0.9, alpha_brightness: 1.6, noise: 0, bloom: 0.45,
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
    // Suspend the AudioContext so the analyser-fed canvases freeze on
    // their last-rendered buffer. Subsequent rAFs paint identical
    // pixels until resume() — which we don't call. The Promise is
    // safe to await: suspend() resolves once the audio thread has
    // actually paused.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (!eng) return;
      try { await eng.ctx.suspend(); } catch { /* already suspended / closed */ }
    });
    // Let one more rAF land so the last-pre-suspend buffer renders.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
  return true;
}
