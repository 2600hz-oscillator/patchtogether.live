// e2e/tests/wavesculpt-camera-cv.spec.ts
//
// Bulletproof regression coverage for the WAVESCULPT camera-CV pipeline
// — every one of the 5 camera params (pos_x, pos_y, pos_z, zoom, rot)
// gets driven by an LFO and we assert:
//
//   1. The engine sees the combined (knob + audio-rate CV) value via
//      engine.readParam(node, paramId) — proving the shadow-gain
//      analyser tap in the factory's tick() is wired right.
//   2. The WebGL 3D viewport canvas pixel histogram CHANGES across
//      ~1 sec of LFO modulation — proving the WebGL render reads the
//      live combined value (not the static knob). This catches the
//      regression where PR #225 fixed audio + joystick UI but the
//      WebGL camera stayed parked on `node.params.pos_x`.
//
// Each assertion runs for each of the 5 camera ports; the spec is
// intentionally exhaustive (one test per port × per assertion class
// = 10 tests). If a single port regresses the test name pins exactly
// which one + which symptom.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const CAMERA_PORTS = ['pos_x', 'pos_y', 'pos_z', 'zoom', 'rot'] as const;
type CameraPort = (typeof CAMERA_PORTS)[number];

/** Spawn an LFO patched to WAVESCULPT.<port>. Returns once both
 *  cards are on canvas + the edge is in the graph. */
async function spawnLfoIntoCamera(page: Page, port: CameraPort): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',        position: { x: 60, y: 100 } },
      { id: 'ws',  type: 'wavesculpt', position: { x: 460, y: 100 }, domain: 'audio' },
    ],
    [
      {
        id: 'e_lfo_ws',
        from: { nodeId: 'lfo', portId: 'phase0' },
        to:   { nodeId: 'ws',  portId: port },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );
  // Settle a beat so the LFO starts emitting + the engine's paramTap
  // analyser captures non-zero samples.
  await page.waitForTimeout(400);
}

/** Read engine.readParam(node, paramId) — returns intrinsic-knob +
 *  most-recent-CV-sample (engine.ts:540-548). */
async function readEngineParam(page: Page, nodeId: string, paramId: string): Promise<number | null> {
  return await page.evaluate(
    ({ nid, pid }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          readParam: (n: { id: string; type: string; domain: string }, k: string) => number | undefined;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes[nid];
      if (!node) return null;
      const v = eng.readParam(node, pid);
      return typeof v === 'number' ? v : null;
    },
    { nid: nodeId, pid: paramId },
  );
}

/** Read N consecutive engine.readParam samples spaced `gapMs` apart.
 *  Used to assert "this value is moving" (LFO modulation visible) vs
 *  "this value is parked" (CV not wired through). */
async function readEngineParamSeries(
  page: Page, nodeId: string, paramId: string, n: number, gapMs: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = await readEngineParam(page, nodeId, paramId);
    samples.push(v ?? 0);
    if (i < n - 1) await page.waitForTimeout(gapMs);
  }
  return samples;
}

/** Pixel-histogram digest of the WAVESCULPT viewport canvas. Bucket
 *  per-channel luminance into 8 bins; total bins = 8 (we only need a
 *  coarse digest to catch "camera moved"). */
async function viewportHistogram(page: Page): Promise<number[]> {
  return await page.evaluate(() => {
    const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
    if (!c) return [];
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return [];
    const w = c.width, h = c.height;
    if (w === 0 || h === 0) return [];
    const data = ctx2d.getImageData(0, 0, w, h).data;
    const bins = new Array(8).fill(0) as number[];
    // Sample every 16th pixel for speed (~4K samples on a 256x256).
    for (let i = 0; i < data.length; i += 4 * 16) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const lum = (r + g + b) / 3;
      const bin = Math.min(7, Math.floor(lum / 32));
      bins[bin]++;
    }
    return bins;
  });
}

/** L1 distance between two histograms. Bigger = more difference. */
function histogramDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return d;
}

test.describe.configure({ mode: 'parallel' });

test.describe('WAVESCULPT: camera-CV pipeline — engine sees combined (knob + CV) value', () => {
  for (const port of CAMERA_PORTS) {
    test(`LFO → WAVESCULPT.${port}: engine.readParam moves over a 1s LFO sweep`, async ({ page }) => {
      await spawnLfoIntoCamera(page, port);
      // LFO default rate ≈ 1 Hz → over ~800 ms we should see a
      // non-trivial sweep of the combined value. Sample every 100 ms
      // for 8 samples; assert standard deviation > threshold.
      const series = await readEngineParamSeries(page, 'ws', port, 8, 100);
      const mean = series.reduce((a, b) => a + b, 0) / series.length;
      const variance = series.reduce((s, v) => s + (v - mean) * (v - mean), 0) / series.length;
      const stddev = Math.sqrt(variance);
      // Pre-fix: no LFO modulation reached the engine for camera params
      // (the engine.readParam returned only the intrinsic knob, parked
      // at default) → stddev ≈ 0. Post-fix: LFO at ±1 sweeps through
      // the param range → stddev > 0.05.
      expect(stddev, `${port} engine.readParam stddev over 800ms = ${stddev.toFixed(4)} (samples: ${series.map((s) => s.toFixed(3)).join(', ')})`).toBeGreaterThan(0.05);
    });
  }
});

test.describe('WAVESCULPT: camera-CV pipeline — WebGL viewport reflects the live value', () => {
  for (const port of CAMERA_PORTS) {
    test(`LFO → WAVESCULPT.${port}: viewport canvas histogram changes over 1s`, async ({ page }) => {
      await spawnLfoIntoCamera(page, port);

      // Wait until the ribbons are actually on-screen. WAVESCULPT
      // ribbons always render (no gate required since the
      // traveling-wave-at-rest fix in PR #221), but WebGL shader
      // compile + first FBO render takes a few rAFs after the card
      // mounts. If we snapshot too early we get a black canvas
      // (all pixels in bin 0 = the #050608 background fill), the
      // histograms tie at zero, and the test flake-fails. Poll up
      // to 3s for a frame with any non-bin-0 content.
      await expect
        .poll(async () => {
          const h = await viewportHistogram(page);
          return h.slice(1).reduce((a, b) => a + b, 0);
        }, {
          message: `${port}: ribbons never rendered (canvas stayed all-black for 3s)`,
          timeout: 3_000,
          intervals: [100, 200, 400],
        })
        .toBeGreaterThan(0);

      const h1 = await viewportHistogram(page);
      expect(h1.length, 'first histogram captured').toBe(8);
      // Wait one full LFO period (~1s at default 1Hz) — the camera
      // should sweep enough that the ribbon positions / colours / sizes
      // shift noticeably.
      await page.waitForTimeout(1000);
      const h2 = await viewportHistogram(page);
      expect(h2.length, 'second histogram captured').toBe(8);
      const dist = histogramDistance(h1, h2);
      // Pre-fix: WebGL camera read node.params.pos_x (static knob);
      // ribbons still animated via traveling-wave phase, so the
      // histogram MIGHT shift a little but typically < 30 pixels in
      // L1 distance. Post-fix: camera moves with the LFO → the whole
      // ribbon arrangement shifts → much bigger histogram change.
      // Threshold = 50: well above the static-camera animation
      // baseline + tolerates per-axis differences (moving the camera
      // along Y axis changes the scene less dramatically than along X).
      expect(
        dist,
        `${port} viewport histogram L1 = ${dist} after 1s of LFO modulation (h1=[${h1.join(',')}] h2=[${h2.join(',')}])`,
      ).toBeGreaterThan(50);
    });
  }
});
