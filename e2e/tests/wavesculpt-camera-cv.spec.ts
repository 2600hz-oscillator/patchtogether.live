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
 *  cards are on canvas + the edge is in the graph.
 *
 *  Critical rate-vs-window-size invariant: the LFO must NOT complete
 *  exactly N full cycles within the histogram-comparison window or
 *  the camera returns to the start position and the two snapshots
 *  alias to the same frame (the original flake — default 1 Hz LFO ×
 *  1000 ms wait = 1 full cycle = identical-looking histograms even
 *  though the LFO was definitely modulating). LFO_RATE_HZ + the
 *  test's per-window timings (see below) are coupled — keep them
 *  in sync. */
const LFO_RATE_HZ = 0.5;
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
  // Pin the LFO rate so the histogram-window math is deterministic —
  // see LFO_RATE_HZ comment. Mutating params.rate flows through the
  // reconciler → engine.setParam → worklet AudioParam.
  await page.evaluate((hz) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    const lfo = w.__patch.nodes.lfo;
    if (lfo) lfo.params.rate = hz;
  }, LFO_RATE_HZ);
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

/** Sample 5 consecutive rAF-spaced histograms and return the one with
 *  the most non-bin-0 content. The card's rAF loop fills the canvas
 *  with the #050608 background BEFORE drawing ribbons — sampling
 *  during the brief fill-but-pre-draw window catches an all-bin-0
 *  frame. Taking the busiest of 5 samples (≥ 3 of which will be
 *  fully-rendered) sidesteps the race. */
async function busiestHistogram(page: Page): Promise<number[]> {
  // Sample 5 rAF-spaced frames + pick the one with the most non-bin-0
  // content. The card's rAF loop fills the canvas with the #050608
  // background BEFORE drawing ribbons — a single-shot capture can
  // land in the brief fill-but-pre-draw window. Sampling 5 rAFs
  // gives a high probability that at least one lands fully-rendered.
  //
  // If ALL 5 come back as all-bin-0 (the linux-CI flake — happens
  // when the LFO has the camera pointed at the back wall for the
  // entire 5-frame window), retry the 5-sample sweep up to 3 times
  // spaced 200 ms apart. By that point the LFO has moved enough
  // that the camera is back on-screen at least once.
  for (let retry = 0; retry < 3; retry++) {
    let best: number[] = [];
    let bestNonBg = -1;
    for (let i = 0; i < 5; i++) {
      const h = await viewportHistogram(page);
      const nonBg = h.slice(1).reduce((a, b) => a + b, 0);
      if (nonBg > bestNonBg) {
        best = h;
        bestNonBg = nonBg;
      }
      if (i < 4) await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    }
    if (bestNonBg > 0) return best;
    if (retry < 2) await page.waitForTimeout(200);
  }
  // Fallback — three full 5-sample sweeps all came back all-bin-0.
  // Return one final fresh single-sample snapshot so the caller has
  // something to compare; the test threshold will catch the issue.
  return viewportHistogram(page);
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
      // LFO is pinned to LFO_RATE_HZ (0.5 Hz) by spawnLfoIntoCamera —
      // so over ~800 ms we see ~40 % of one sine cycle, plenty of
      // variance for the stddev check below. (The viewport-histogram
      // test below also depends on this rate — see the why-half-period
      // comment there.) Sample every 100 ms for 8 samples; assert
      // standard deviation > threshold.
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

      // Sample N histograms across a full half-period of the LFO.
      //
      // Why a half-period: at LFO_RATE_HZ=0.5Hz, the LFO completes
      // one full sine cycle every 2000 ms — so over a 1000 ms window
      // the camera sweeps from one extreme through the center to the
      // OPPOSITE extreme. Crucially, the start + end of the window
      // are at distinct LFO phases (0° vs 180°) → distinct camera
      // positions → distinct visual frames. The original flake was
      // a 1000 ms window at default 1Hz LFO: that's a FULL cycle, so
      // camera returns to the start and the two endpoint histograms
      // alias to the same frame even though modulation was active.
      //
      // Why N samples (not just 2 endpoints): WAVESCULPT's render is
      // animated independent of the camera (boltPhase, wavePhase, the
      // BENTBOX post-pass feedback chain), so an individual rAF can
      // land on a frame where ribbons happen to be obscured by the
      // post-pass cycle. Taking the MAX L1 over all pairs of N samples
      // means we only need any single pair to show motion — robust to
      // single-frame coincidence.
      const SAMPLE_COUNT = 5;
      const WINDOW_MS = 1000;
      const GAP_MS = Math.floor(WINDOW_MS / (SAMPLE_COUNT - 1));
      const hists: number[][] = [];
      const camValues: number[] = [];
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        // Capture engine.readParam side-by-side with histogram so we
        // can prove the camera *was* actually changing even if the
        // histogram metric is too coarse to register it.
        const camVal = await readEngineParam(page, 'ws', port);
        camValues.push(camVal ?? 0);
        hists.push(await busiestHistogram(page));
        if (i < SAMPLE_COUNT - 1) await page.waitForTimeout(GAP_MS);
      }
      for (const h of hists) {
        expect(h.length, 'histogram captured').toBe(8);
      }

      // Sanity check #1: the LFO *was* reaching the engine during the
      // window. If camera values are flat, the LFO is broken and the
      // visual-histogram check below would be testing the wrong thing.
      const camMean = camValues.reduce((a, b) => a + b, 0) / camValues.length;
      const camStddev = Math.sqrt(
        camValues.reduce((s, v) => s + (v - camMean) * (v - camMean), 0) / camValues.length,
      );
      expect(
        camStddev,
        `${port} engine.readParam stddev across the histogram window = ${camStddev.toFixed(4)} (cam samples: ${camValues.map((v) => v.toFixed(3)).join(', ')}) — LFO must reach the engine for the histogram check to be meaningful`,
      ).toBeGreaterThan(0.05);

      // Find the max L1 across all pairs of histograms. The two
      // furthest-apart camera positions in the window define the
      // pair with the strongest expected histogram delta; we take
      // the max so single-frame post-pass noise can't suppress it.
      let maxDist = 0;
      let bestPair: [number, number] = [0, 0];
      for (let i = 0; i < hists.length; i++) {
        for (let j = i + 1; j < hists.length; j++) {
          const d = histogramDistance(hists[i]!, hists[j]!);
          if (d > maxDist) {
            maxDist = d;
            bestPair = [i, j];
          }
        }
      }
      // Pre-fix: WebGL camera read node.params.pos_x (static knob);
      // ribbons still animated via traveling-wave phase but the
      // L1 luminance-histogram distance was typically < 2 pixels.
      // Post-fix: the camera moves with the LFO → ribbon positions
      // shift → histogram distance is real.
      //
      // Per-axis: pos_x / pos_z / zoom produce big histogram swings
      // (≥ 50). pos_y + rot are more subtle — moving the camera
      // up/down or rotating around Y shifts mostly VERTICAL pixel
      // positions which the 8-bin luminance histogram doesn't
      // discriminate well; typical L1 on those axes is 10-30. Use
      // an axis-specific threshold so the test still catches
      // "camera not moving at all" without false-failing on subtle
      // axes where the L1 metric is naturally smaller.
      const PER_AXIS_THRESHOLD: Record<CameraPort, number> = {
        pos_x: 50,
        pos_z: 50,
        // zoom: the LFO sweeps zoom through 0.3..3 (full range); at
        // either extreme the ribbons collapse to a tiny pixel area
        // so the luminance histogram doesn't move as many pixels as
        // pos_x/pos_z. Local readings hover around 30-50; 20 is
        // well above the static-camera baseline (~0-5).
        zoom:  20,
        pos_y: 5,
        rot:   5,
      };
      const threshold = PER_AXIS_THRESHOLD[port];
      expect(
        maxDist,
        `${port} viewport max-pair-L1 = ${maxDist} (best pair indices ${bestPair[0]} vs ${bestPair[1]}; threshold ${threshold}; histograms: ${hists.map((h, idx) => `[${idx}]=[${h.join(',')}]`).join(' ')} cam: ${camValues.map((v) => v.toFixed(3)).join(', ')})`,
      ).toBeGreaterThan(threshold);
    });
  }
});
