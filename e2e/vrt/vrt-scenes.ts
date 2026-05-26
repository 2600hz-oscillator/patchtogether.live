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
