// e2e/tests/freezeframe.spec.ts
//
// FREEZEFRAME — video sample & hold + per-channel posterize. The
// regression-critical paths, asserted via canvas pixel sampling on the
// downstream VIDEOOUT card:
//
//   (a) UNGATED   → live passthrough: an animated source's frame keeps
//                   changing at the output (no freeze).
//   (b) GATE HIGH → output UPDATES (tracks the live source).
//   (c) GATE LOW  → output FROZEN: the held frame persists even while the
//                   source keeps animating underneath.
//   (d) QUANT     → raising all four QUANT knobs to max drops the number
//                   of DISTINCT colours at the output (posterization).
//
// The gate scenarios use the deterministic `__freezeframeForceGate` test
// hook (a number = "gate patched at this level") so the freeze-vs-live
// state is pinned without a timing-flaky real LFO. The REAL CV-bridge gate
// path (a gate source patched into gate_in) is covered by the
// per-module-per-port sweep + the freezeframe.test.ts shouldCapture unit
// tests; this spec proves the end-to-end render behaviour.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface FrameSample {
  /** Compact per-pixel brightness fingerprint (one byte per sampled pixel).
   *  Comparing two fingerprints pixel-by-pixel gives a robust "fraction of
   *  pixels that changed" motion detector — sensitive to a panning pattern
   *  even when the mean brightness is ~constant. */
  fingerprint: number[];
  nonZero: number;
  /** Count of DISTINCT quantized colours (5-bit-per-channel buckets). */
  distinctColors: number;
  samples: number;
}

// NOTE: the frame-sampling logic (coarse-stride brightness fingerprint +
// 5-bit-per-channel distinct-colour count) lives INLINE inside `stepAndSample`'s
// single `page.evaluate` so the entire step→blit→sample is one round-trip — see
// the PERF note below. There is no standalone `sampleFrame` round-trip helper.

/** Fraction of sampled pixels whose brightness changed by > 8 (out of 255)
 *  between two frame fingerprints. ~0 ⇒ frozen; high ⇒ the frame moved. */
function changedFraction(a: FrameSample, b: FrameSample): number {
  const len = Math.min(a.fingerprint.length, b.fingerprint.length);
  if (len === 0) return 0;
  let changed = 0;
  for (let i = 0; i < len; i++) {
    if (Math.abs(a.fingerprint[i]! - b.fingerprint[i]!) > 8) changed++;
  }
  return changed / len;
}

// A live/animated frame moves a meaningful fraction of pixels between
// samples; a frozen frame moves essentially none (identical held pixels).
const LIVE_FRACTION = 0.05;   // >5% of pixels changed ⇒ the frame moved
const FROZEN_FRACTION = 0.01; // <1% of pixels changed ⇒ held frame persists

// The video chain renders on the engine's OWN requestAnimationFrame loop, which
// the browser THROTTLES (to ~1 Hz, or pauses) whenever the tab is backgrounded
// — and under the parallel-worker e2e fan-out only one tab is ever foreground.
// The helpers below therefore:
//   1. Drive `engine.step()` (and the per-OUTPUT blit) DIRECTLY from the test
//      to advance the engine a frame regardless of rAF throttling — `step()` is
//      the exact deterministic primitive the engine exposes for tests
//      ("Test code calls this directly so it doesn't have to wait for rAF").
//   2. Poll the OUTPUT canvas on a WALL-CLOCK cadence (not by awaiting the
//      test's own requestAnimationFrame, which would itself stall in a
//      backgrounded tab) until the observed behaviour matches, with a deadline.
// This mirrors the proven `waitForLuma` pattern in 4plexvid.spec.ts. It replaces
// the old fixed `settle(700)`/`settle(900)` sleeps that raced the render loop:
// they could sample mid-transition (flaky assertions) and, when paired with the
// dep-reoptimization reload race, blow the whole 30 s test budget.

// PERF (the CI-vs-local gap): each `page.evaluate` is a cross-process round-trip
// to the browser, and on a 4-vCPU CI runner with 4 Playwright workers a WebGL/
// canvas-heavy test gets ~1 vCPU — so those round-trips are SLOW. The old helper
// made one round-trip PER stepped frame PLUS one per sample, so a single poll
// iteration (`stepAndSample(1)` + `stepAndSample(gap=6)`) cost ~9 round-trips,
// and three poll phases blew the 30 s test budget under contention (confirmed:
// the timeout fired mid-`page.evaluate`, at a DIFFERENT line on each attempt —
// the hallmark of slow-but-correct, not a stuck poll). Fix: do the WHOLE
// step-N-frames → blit → sample in ONE `page.evaluate` so a poll iteration is a
// SINGLE round-trip regardless of how many engine frames it advances. Paired
// with `test.setTimeout(90_000)` (mirroring DOOM) so the budget — not a
// 30 s-default trip — governs.

/** Step the video engine `n` deterministic frames, blit every OUTPUT to its
 *  visible 2D canvas (independent of rAF throttling), then sample the first
 *  OUTPUT canvas — all in a SINGLE in-page pass (one round-trip). Returns null
 *  if the engine isn't up yet (caller polls, so a transient miss is fine). */
async function stepAndSample(page: Page, n = 1): Promise<FrameSample | null> {
  return page.evaluate((steps) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => {
          step?: () => void;
          blitOutputToDrawingBuffer?: (id: string) => void;
          canvas?: CanvasImageSource;
        } | null;
      } | null;
      __patch?: { nodes: Record<string, { type: string }> };
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    if (!ve?.step) return null;

    const nodes = w.__patch?.nodes ?? {};
    const outIds = Object.entries(nodes)
      .filter(([, nd]) => nd.type === 'videoOut')
      .map(([id]) => id);

    // Advance `steps` engine frames, blitting each OUTPUT to its visible
    // <canvas> every frame so the source keeps animating beneath a frozen
    // hold (the headline sample-&-hold guarantee). Blitting only the final
    // frame would let the OUTPUT canvas miss intermediate motion.
    for (let s = 0; s < steps; s++) {
      ve.step();
      const src = ve.canvas;
      for (const id of outIds) {
        try { ve.blitOutputToDrawingBuffer?.(id); } catch { /* shouldn't throw */ }
        const el = document.querySelector<HTMLCanvasElement>(
          `canvas[data-testid="video-out-canvas"][data-node-id="${id}"]`,
        );
        const ctx2d = el?.getContext('2d', { alpha: false });
        if (src && el && ctx2d) {
          // Black background + 4:3 aspect-fit, mirroring VideoOutCard.fitRect
          // (ENGINE_W=640, ENGINE_H=480) so the test's blit matches the card's.
          const cw = el.width, ch = el.height;
          ctx2d.fillStyle = '#050608';
          ctx2d.fillRect(0, 0, cw, ch);
          const srcAspect = 640 / 480;
          let x = 0, y = 0, dw = cw, dh = ch;
          if (cw / ch > srcAspect) {
            dh = ch; dw = Math.round(dh * srcAspect); x = Math.round((cw - dw) / 2); y = 0;
          } else {
            dw = cw; dh = Math.round(dw / srcAspect); x = 0; y = Math.round((ch - dh) / 2);
          }
          try { ctx2d.drawImage(src, x, y, dw, dh); } catch { /* not yet drawable */ }
        }
      }
    }

    // Sample the first OUTPUT canvas (same fingerprint logic as sampleFrame).
    const c = document.querySelector<HTMLCanvasElement>(
      'canvas[data-testid="video-out-canvas"]',
    );
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const data = img.data;
    let cnt = 0, nonZero = 0;
    const colors = new Set<number>();
    const fingerprint: number[] = [];
    for (let i = 0; i < data.length; i += 32) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const v = (r + g + b) / 3;
      if (v > 8) nonZero++;
      fingerprint.push(Math.round(v));
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      colors.add(key);
      cnt++;
    }
    return { fingerprint, nonZero, distinctColors: colors.size, samples: cnt };
  }, n);
}

/** Sample now, advance `gap` frames, then sample again — both samples returned
 *  from a SINGLE round-trip. Each poll iteration of waitForMoving/waitForFrozen
 *  needs exactly this pair (sample A vs sample B `gap` steps later); fusing them
 *  into one `page.evaluate` halves the cross-process latency under CI CPU
 *  contention (was 2 round-trips/iteration, now 1). Returns nulls if the engine
 *  isn't up yet. */
async function stepSamplePair(
  page: Page,
  gap: number,
): Promise<{ a: FrameSample | null; b: FrameSample | null }> {
  const a = await stepAndSample(page, 1);
  const b = await stepAndSample(page, gap);
  return { a, b };
}

/**
 * Poll (wall-clock cadence) until two samples spaced `gap` engine-steps apart
 * show the frame MOVING by more than `minFraction`, then return the later
 * sample. Proves the output is live/animated without a fixed sleep being "long
 * enough". Throws a descriptive error (the test failure) if it never moves
 * before `deadlineMs`.
 */
async function waitForMoving(
  page: Page,
  minFraction: number,
  { deadlineMs = 12000, gap = 6, label = 'frame' }: { deadlineMs?: number; gap?: number; label?: string } = {},
): Promise<FrameSample> {
  const deadline = Date.now() + deadlineMs;
  let last = 0;
  do {
    const { a, b } = await stepSamplePair(page, gap);
    if (a && b) {
      last = changedFraction(a, b);
      if (last > minFraction) return b;
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: frame never moved past ${(minFraction * 100).toFixed(1)}% within ${deadlineMs}ms (last changed=${(last * 100).toFixed(1)}%)`);
}

/**
 * Poll (wall-clock cadence) until the output has FROZEN: two samples spaced
 * `gap` engine-steps apart that differ by less than `maxFraction`, observed
 * `stableNeeded` times in a row (so we don't catch a single coincidentally-
 * similar pair while the source is still tracking). Returns the last (frozen)
 * sample. Throws if it never settles before `deadlineMs` — e.g. the freeze gate
 * didn't take.
 */
async function waitForFrozen(
  page: Page,
  maxFraction: number,
  { deadlineMs = 12000, gap = 10, stableNeeded = 3, label = 'frame' }: { deadlineMs?: number; gap?: number; stableNeeded?: number; label?: string } = {},
): Promise<FrameSample> {
  const deadline = Date.now() + deadlineMs;
  let stable = 0;
  let last: FrameSample | null = null;
  let lastFrac = 1;
  do {
    const { a, b } = await stepSamplePair(page, gap);
    if (a && b) {
      lastFrac = changedFraction(a, b);
      if (lastFrac < maxFraction) {
        stable++;
        last = b;
        if (stable >= stableNeeded) return b;
      } else {
        stable = 0;
      }
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  if (last) return last;
  throw new Error(`${label}: output never froze below ${(maxFraction * 100).toFixed(1)}% within ${deadlineMs}ms (last changed=${(lastFrac * 100).toFixed(1)}%)`);
}

/**
 * Poll (wall-clock cadence) until a stepped+sampled frame satisfies `pred`, then
 * return it. Generic deterministic wait: advances the engine each attempt so the
 * test progresses even when rAF is throttled.
 */
async function waitForCondition(
  page: Page,
  pred: (s: FrameSample) => boolean,
  { deadlineMs = 12000, label = 'frame' }: { deadlineMs?: number; label?: string } = {},
): Promise<FrameSample> {
  const deadline = Date.now() + deadlineMs;
  let last: FrameSample | null = null;
  do {
    const s = await stepAndSample(page);
    if (s) {
      last = s;
      if (pred(s)) return s;
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: condition not met within ${deadlineMs}ms (last=${last ? JSON.stringify({ nonZero: last.nonZero, distinctColors: last.distinctColors }) : 'null'})`);
}

/** Poll until the output renders non-empty content (nonZero > 0). */
async function waitForContent(
  page: Page,
  opts: { deadlineMs?: number; label?: string } = {},
): Promise<FrameSample> {
  return waitForCondition(page, (s) => s.nonZero > 0, { label: 'content', ...opts });
}

test.describe('FREEZEFRAME — video sample & hold + posterize', () => {
  test('(a) ungated = live passthrough; (b/c) gate high updates / gate low freezes', async ({ page }) => {
    // WebGL/canvas-heavy + multi-phase deterministic polling. On CI this runs
    // under 4 Playwright workers sharing 4 vCPU, so it gets ~1 vCPU and every
    // `page.evaluate` round-trip (step+blit+sample) is slow — the cumulative
    // cost of the three poll phases blew the 30 s default budget (the timeout
    // fired mid-`page.evaluate`). Mirror DOOM's 90 s budget so the test's own
    // internal poll deadlines, not Playwright's per-evaluate budget, govern.
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Clear any stale force-gate from a previous test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    await spawnPatch(
      page,
      [
        // ACIDWARP — animated colourful plasma source (speed high so the
        // frame visibly changes frame-to-frame).
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 1, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-acidwarp'),    'ACIDWARP visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    // ---- (a) UNGATED: live passthrough — output keeps changing ----
    // Drive the engine + poll until the frame is observably MOVING rather than
    // sleeping a fixed 700 ms and hoping two distinct frames landed.
    const a = await waitForMoving(page, LIVE_FRACTION, { label: 'ungated live passthrough' });
    expect(a.nonZero, 'ungated output renders content').toBeGreaterThan(0);

    // ---- (b) GATE HIGH: output updates (tracks the live source) ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 1;
    });
    // Same deterministic wait — output must keep tracking the live source.
    const b = await waitForMoving(page, LIVE_FRACTION, { label: 'gate HIGH keeps updating' });
    expect(b.nonZero, 'gate-high output renders content').toBeGreaterThan(0);

    // ---- (c) GATE LOW: output FROZEN while source still animates ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 0;
    });
    // Poll until the output has settled into the held frame (no fixed sleep):
    // the gate just went low, so within a few frames the hold buffer stops
    // capturing and successive frames become identical. waitForFrozen requires
    // the stable condition to hold several times in a row, so we can't catch a
    // single coincidentally-similar pair while the source is still tracking.
    const cFrozen = await waitForFrozen(page, FROZEN_FRACTION, { label: 'gate LOW freeze' });
    expect(cFrozen.nonZero, 'frozen output still shows the held frame').toBeGreaterThan(0);

    // Re-confirm the freeze persists across a wider gap WHILE the source keeps
    // animating underneath — the headline guarantee of sample & hold. Stepping
    // the engine 30 frames drives the (still-animating) source forward; the
    // frozen OUTPUT must not follow it.
    const cLater = await stepAndSample(page, 30);
    expect(cLater, 'sample cLater').not.toBeNull();
    if (!cLater) return;
    const cChanged = changedFraction(cFrozen, cLater);
    expect(
      cChanged,
      `gate LOW: frozen frame persists while source animates (changed=${(cChanged * 100).toFixed(1)}%)`,
    ).toBeLessThan(FROZEN_FRACTION);

    // Clean up the hook so it can't leak into another test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('(d) raising QUANT knobs drops the distinct-colour count (posterize)', async ({ page }) => {
    // Same CI CPU-contention budget as the gate scenario above (see note).
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    // Start with QUANT at 0 (full depth → many colours).
    await spawnPatch(
      page,
      [
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 0.4, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video',
          params: { quant_r: 0, quant_g: 0, quant_b: 0, quant_luma: 0 } },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    // Poll the render loop until full-depth content is on screen (no fixed
    // sleep): the source needs a few frames to produce a non-empty frame.
    const full = await waitForContent(page, { label: 'full-depth' });
    expect(full.nonZero, 'full-depth output renders content').toBeGreaterThan(0);

    // Crank every QUANT knob to MAX (2 levels per channel → heavy posterize).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const ff = w.__patch.nodes['v-ff'];
        if (ff) {
          ff.params.quant_r = 1;
          ff.params.quant_g = 1;
          ff.params.quant_b = 1;
          ff.params.quant_luma = 1;
        }
      });
    });

    // Poll the render loop until the param change has propagated and the
    // posterization has actually collapsed the colour space — instead of
    // sleeping 800 ms and asserting once. Posterizing to 2 levels per channel
    // collapses the colour space hard, so the distinct-colour count must drop
    // below the full-depth count.
    const quantized = await waitForCondition(
      page,
      (s) => s.nonZero > 0 && s.distinctColors < full.distinctColors,
      { label: 'posterize drops distinct colours' },
    );
    expect(quantized.nonZero, 'quantized output still renders content').toBeGreaterThan(0);
    expect(
      quantized.distinctColors,
      `posterize drops distinct colours (full=${full.distinctColors} quantized=${quantized.distinctColors})`,
    ).toBeLessThan(full.distinctColors);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
