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
}

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
};

/** Set up the rack for `type`. Returns true if a scene was applied
 *  (so the spec knows to skip the default solo-spawn path). */
export async function applyVrtScene(page: Page, type: string): Promise<boolean> {
  const scene = VRT_SCENES[type];
  if (!scene) return false;
  await spawnPatch(page, scene.nodes, scene.edges);
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
