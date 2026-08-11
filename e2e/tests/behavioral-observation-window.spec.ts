// e2e/tests/behavioral-observation-window.spec.ts
//
// THE BEHAVIORAL SWEEP'S OWN OBSERVATION WINDOW AND ITS BUDGET, under a
// deliberately STARVED MAIN THREAD.
//
// Sibling of spawn-mount-budget.spec.ts. That file tests the harness's MOUNT
// wait; this one tests the harness's OBSERVATION wait and the timeout budgeted
// for it — the two halves of "how long does the sweep look at a module".
//
// WHAT WENT WRONG. `per-module-per-port-behavioral.spec.ts` read a video sink
// as three `locator.evaluate` round trips separated by `waitForTimeout(200)`,
// and budgeted the whole test at a FLAT `inputs × 22 000 ms` whose own comment
// derives that constant from the AUDIO plan ("aggregated read 5×150ms"). On
// main (run 30742314468, shard 3) `lushgarden` — 3 video ports, 96 000 ms —
// timed out on BOTH attempts, and `luma` — 5 video ports, 140 000 ms — timed
// out on its first, while the audio modules on that same shard finished inside
// the same constant. Two defects, one line apart:
//
//   1. PACING. A budget derived from one plan, applied to a different and more
//      expensive one. A video SUT renders continuously on the SAME main thread
//      every Playwright operation in the port needs.
//   2. SOUNDNESS, and this is the one that does not announce itself. 200 ms is
//      not an observation window, it is a bet on the frame rate. MEASURED on
//      one box under `E2E_SWIFTSHADER=1`, lushgarden → videoOut: 200 ms bought
//      22, 23, 25 and 26 rendered frames across four runs, and the free-running
//      rAF rate ranged over 33.9 / 76.9 / 90.7 / 108.3 / 120.4 fps run to run.
//      Headless Chromium's rAF is a main-thread throughput number, not vsync.
//      `computeDelta`'s video arm ORs three criteria, one of which —
//      `varRangeΔ`, the max-minus-min ACROSS the samples — is exactly "how far
//      did the picture move between them". Collapse the samples onto one
//      rendered frame and that criterion is 0 for the control AND the patched
//      run, so it contributes nothing and the gate quietly drops to two
//      criteria, on precisely the machines that are slowest. Nothing fails.
//      The gate just gets less sensitive where it is needed most.
//
// HOW THIS FILE DISCRIMINATES. A canvas is painted ONCE PER rAF with a frame
// counter encoded into its pixels, so a sample carries its own provenance:
// "which rendered frame was this?" is answerable from the pixel alone. The page
// is then run at TWO frame costs — free-running, and under a rAF hog burning
// ~120 ms per frame (~8 fps, the SwiftShader floor CLAUDE.md records) — and BOTH
// units are measured on BOTH:
//
//   * the WALL-CLOCK spacing must buy MATERIALLY DIFFERENT numbers of frames at
//     the two rates. That is the defect, reproduced on demand, and it is a
//     PERMANENT leg rather than a one-off check at authoring time (CLAUDE.md:
//     negative-control the instrument in both directions and keep one of them
//     running). If it ever stops holding, the hog has stopped biting and
//     nothing else in this file is discriminating either.
//   * the FRAME spacing must be IDENTICAL at both rates. That invariance is
//     the fix.
//
// ⚠ Note what the measurement does NOT say: the wall-clock window does not
// collapse to a single frame under load, because once frames are expensive the
// Playwright round trip starts to dominate the gap. It went 29 → 10 frames per
// gap across a 250× change in frame cost. So the old window was uncontrolled in
// BOTH units at once — neither a fixed frame count nor a fixed 200 ms (at
// 250 ms/frame those "200 ms" gaps cost ~2.5 s of wall clock each).
//
// ── THE INSTRUMENT WAS THE BUG (2026-08-03, main RED on run 30791843249) ────
//
// The negative control below shipped comparing the two arms by the ABSOLUTE
// number of frames each "200 ms" gap bought — 29,26 vs 11,11 locally — and
// required a difference of ≥5. On a loaded CI runner it read 15,14 vs 11,11 and
// went red. The tempting reading is "throttling isn't separable on CI". It is
// wrong, and the numbers say so:
//
//   |                             | free arm | hogged arm | true ratio | old metric |
//   |-----------------------------|----------|------------|------------|------------|
//   | local real GPU, quiet       | 119.8fps |  8.33 fps  |   14.4×    | 26 vs 11   |
//   | local SwiftShader, quiet    | 119.8fps |  8.32 fps  |   14.4×    | 26 vs 11   |
//   | local SwiftShader, load 15.5| 111.8fps |  8.27 fps  |   13.5×    | 26,25 vs 11|
//   | CI shard 1/10 (the red run) |  ~71 fps |  ≤8.33 fps |   ~8.5×    | 15 vs 11   |
//
// The property held on CI with an 8.5× margin and the gate failed anyway. That
// makes this the INSTRUMENT, not the result — the two look identical from the
// output, which is the whole reason CLAUDE.md insists on establishing which.
//
// WHY THE METRIC LIED. `readFramesWallClockSpaced` does not measure "what a
// 200 ms wall-clock spacing buys". It measures "what 200 ms PLUS an unbounded,
// frame-rate-dependent Playwright round trip buys" — and that second term is
// ~100× larger on the hogged arm, because every `locator.evaluate` must wait
// for a main thread that yields once per 120 ms frame. MEASURED per gap:
//
//     free-running   26 frames in  215 ms   (round trip     8 ms —  4 %)
//     hogged         11 frames in 1323 ms   (round trip   963 ms — 73 %)
//
// So the metric inflates the hogged arm 6.6× (a true 1.66 frames reads as 11)
// and leaves the free arm alone (23.96 reads as 26). A genuine 14.4× separation
// is compressed to 2.4×, and the gate was an ABSOLUTE difference on the
// compressed pair — which means its margin was set by the free arm's
// uncontrolled fps, not by the effect under test. It is the file's own defence
// #5 committed inside the file: a page-side quantity sampled by a
// Playwright-side poll loop over the very main thread it is measuring.
//
// AND IT WAS UNSOUND, NOT MERELY TIGHT — ask why the GREEN runs were green.
// The hogged arm's raw count is pinned near 11 by the round trip almost
// regardless of the hog (the table above: 30 ms/frame → 16, 250 ms/frame → 10;
// an 8.3× change in frame cost moves it 1.6×). So `fast − slow ≥ 5` needs the
// free arm to clear ~16 frames/gap, i.e. ~76 fps. This file's own header
// records free-running rates as low as 33.9 fps, which would buy ~7 frames —
// a separation of MINUS four. The bound was never satisfiable across the range
// this repo had already measured; it passed where the probe page happened to
// run at 120 fps.
//
// THE FIX, and why it is not a widened tolerance. Both arms are compared by
// their ACHIEVED rAF RATE, measured inside the page, and the bound is a RATIO
// with a floor derived from the hog's own construction ceiling
// (1000/HOG_MS_PER_FRAME). The hogged arm cannot exceed that ceiling on any
// machine — a busy-wait is not something contention can speed up — so exactly
// one of the two arms is at the runner's mercy, and that one gets an explicit,
// loud floor instead of being allowed to silently drag the comparison down.
// The raw wall-clock counts are still taken and still printed, because they are
// the demonstration; they are no longer what anything is gated on.
//
// COST: ~34 s for the whole file on one e2e shard (measured under
// `E2E_SWIFTSHADER=1`), nearly all of it deliberate CPU burn inside this one
// page. The rate probe added by the rewrite is +~5 s of that — 4 windows of
// 500 ms on each of two legs, and the hogged leg's windows overrun to ~720 ms
// because a 120 ms frame cannot end sooner. Well inside CLAUDE.md's ~2 min
// sign-off threshold, and it adds nothing to any other spec.
//
// ⚠ The titles here deliberately avoid the string `BEHAVIORAL input coverage`:
// ci.yml partitions the heavy behavioral lane out of the sharded e2e matrix
// with a `--grep-invert` covering the collab and capacity tags plus that
// string, and this file belongs in the sharded lane where it gates every PR.
//
// ⚠⚠ The two tags are spelled WITHOUT their leading at-sign in this comment ON
// PURPOSE, and must stay that way. `scripts/collab-attest-lib.ts` resolves the
// collab attest basis with COLLAB_TAG_RE, which scans e2e/tests for those tags
// in their at-prefixed form — and it matches the FILE, not the test title. So
// merely quoting the selector verbatim in a comment enrols this spec in that
// basis and makes every edit to it demand a collab re-attest. That is exactly
// what happened on the first push of this PR.

import { test, expect, type Page } from '@playwright/test';
import {
  captureCanvasStatsFrameSpaced,
  perPortBudgetMs,
  behavioralTimeoutMs,
  BEHAVIORAL_BASELINE_MS,
  AUDIO_CAPTURES,
  VIDEO_CAPTURES,
  VIDEO_CAPTURE_SPACING_FRAMES,
  VIDEO_CAPTURE_CAP_MS,
  SETTLE_MS,
  RUNNER_FACTOR,
  BEHAVIORAL_JOB_TIMEOUT_MS,
} from './_module-coverage-helpers';

/** ~8 fps — the SwiftShader frame rate CLAUDE.md records for backdraft. */
const HOG_MS_PER_FRAME = 120;

/**
 * The rate the hog PINS the page to — BY CONSTRUCTION, not by measurement.
 *
 * The hog busy-waits `HOG_MS_PER_FRAME` *inside* the rAF callback before
 * scheduling the next one, so a frame cannot cost less than that on any
 * machine. Contention can only push the achieved rate BELOW this ceiling; no
 * amount of it can push the rate above. That asymmetry is what makes the
 * comparison below robust rather than tuned: only ONE of the two arms is at the
 * mercy of the runner, so only one of them needs a floor.
 *
 * MEASURED against it, on this box: 8.32 fps quiet, 8.27 fps under a 15.5 load
 * average (14 CPU burners on 10 cores). The ceiling holds to 0.6 %.
 */
const HOG_CEILING_FPS = 1000 / HOG_MS_PER_FRAME; // 8.33

/**
 * How far apart the two arms must be, as a RATE RATIO.
 *
 * ⚠ This is deliberately NOT an absolute frame count. See the header: an
 * absolute count of what a 200 ms spacing "bought" is contaminated by the
 * Playwright round trip, asymmetrically, in the arm that makes the separation
 * look SMALL — so its margin is set by the fast arm's uncontrolled fps rather
 * than by the effect under test. A rate ratio divides that contamination out.
 *
 * WHAT IT STILL CATCHES, which is the question a loosened bound has to answer.
 * The gate pins the hog to within 4× of its configured strength:
 *   - hog removed entirely  → ratio 1.0     → RED
 *   - hog at 30 ms/frame (33 fps, the file's own measured mid-point) → ~3.4 → RED
 *   - hog at 60 ms/frame (16.7 fps)         → ~6.7 → green, correctly: still an
 *     order-of-magnitude-ish separation, which is all this leg claims.
 * So a hog that silently stops biting, or is weakened by more than ~4×, fails.
 *
 * MEASURED ratios: 14.4× (real GPU, quiet), 14.4× (SwiftShader, quiet), 13.5×
 * (SwiftShader under load 15.5), and ~8.5× on the CI runner whose red run
 * prompted this rewrite. 4 is under half the worst of those.
 */
const SEPARATION_FLOOR = 4;

/**
 * The floor the FREE-RUNNING arm must clear — DERIVED from the two constants
 * above, never chosen. If a runner cannot deliver this, the hog is not the only
 * thing throttling the page and NOTHING in this file is discriminating; that is
 * a loud red, not a skip (CLAUDE.md: a gate that cannot fail is decoration).
 *
 * MEASURED headroom: 111.8 fps under a 15.5 load average locally (3.4×), and
 * ~71 fps on the CI runner that went red (2.1×).
 */
const FAST_ARM_FLOOR_FPS = SEPARATION_FLOOR * HOG_CEILING_FPS; // 33.3

/**
 * The rate probe: N windows, and the arm's rate is the BEST of them.
 *
 * NOT an average. Contention is BURSTY, and a single window is at its mercy —
 * MEASURED on the free-running arm under a 15.5 load average, three consecutive
 * 500 ms windows read 3.0, 2.4 and 111.8 fps. A mean (or any one window) would
 * have reported a page "at 3 fps" that is demonstrably capable of 112, and the
 * ratio gate would have gone red with a FALSE verdict — the exact
 * instrument-under-load failure this rewrite exists to remove. Even quiet, the
 * first window routinely reads low (12.0 / 14.0 fps) because the page is still
 * settling.
 *
 * The estimator's BIAS is the reason a max is legitimate here: it can only make
 * the hogged arm look FASTER (harder to pass), because that arm's ceiling is
 * fixed by construction — so the max can never manufacture a separation, only
 * fail to hide behind a stall.
 */
const FPS_WINDOW_MS = 500;
const FPS_WINDOWS = 4;

/** The wall-clock spacing the video capture used to use. */
const OLD_MS_SPACING = 200;

const PROBE_CANVAS = 'canvas[data-testid="frame-probe-canvas"]';

/**
 * Install a canvas that paints its own rAF frame NUMBER into pixel (0,0), and
 * starve the main thread at a fixed cost per frame.
 *
 * Encoding the frame index into the image is what makes both halves of this
 * file decidable: a sample's `variance` is then a pure function of WHICH
 * RENDERED FRAME it was taken on, so "were these two samples the same frame?"
 * is answerable from the sample alone. Everything — the paint and the burn —
 * hangs off the SAME rAF loop, so "frame 9" is frame 9 on any machine.
 */
async function installFrameProbeCanvas(
  page: Page,
  opts: { msPerFrame: number },
): Promise<void> {
  await page.evaluate(({ msPerFrame }) => {
    const c = document.createElement('canvas');
    // Small on purpose: the readback is not what this file measures, and a
    // 4 MP canvas would make the hog's frame cost the readback's, not ours.
    c.width = 64;
    c.height = 64;
    c.setAttribute('data-testid', 'frame-probe-canvas');
    document.body.appendChild(c);
    const ctx = c.getContext('2d')!;
    let frame = 0;
    // Publish the counter BEFORE the first rAF fires. `page.evaluate` returns
    // as soon as the rAF is SCHEDULED, so a reader that arrives inside the
    // first frame period would otherwise see `undefined` and silently compute
    // NaN — and at 120 ms/frame that window is 120 ms wide, i.e. hit every
    // time on the hogged leg and never on the free-running one. A measurement
    // that is NaN on exactly one of the two arms is the worst kind.
    (globalThis as unknown as { __probeFrame: number }).__probeFrame = 0;
    const tick = () => {
      frame++;
      // A flat field whose LEVEL is the frame number (mod 256). Distinct
      // frames therefore have distinct means AND distinct variances once the
      // marker pixel is drawn, so no two frames can alias.
      ctx.fillStyle = `rgb(${frame % 256},${frame % 256},${frame % 256})`;
      ctx.fillRect(0, 0, c.width, c.height);
      // Marker pixel: pins the variance to the frame index so a sample carries
      // its own provenance.
      ctx.fillStyle = `rgb(255,${frame % 256},0)`;
      ctx.fillRect(0, 0, 1, 1);
      (globalThis as unknown as { __probeFrame: number }).__probeFrame = frame;
      // Busy-wait, not a timer: a timer yields the thread, and yielding is
      // exactly what a WebGL draw does NOT do.
      const until = performance.now() + msPerFrame;
      while (performance.now() < until) { /* burn */ }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { msPerFrame: opts.msPerFrame });
}

type RateWindow = { frames: number; elapsedMs: number; fps: number };

/**
 * The page's ACHIEVED rAF rate, accumulated ENTIRELY INSIDE THE PAGE.
 *
 * This is the ground truth the assertions below are built on, and it is
 * measured the way CLAUDE.md's defence #5 requires: one `page.evaluate`, all
 * `FPS_WINDOWS` windows inside it, zero protocol traffic between samples. The
 * previous instrument did the opposite — it inferred the rate from a
 * Playwright-side loop whose own round trips landed on the very main thread it
 * was measuring — and that is precisely why it read the hogged arm ~6.6× too
 * fast (see the header).
 *
 * Every window is returned, not just the best, so a red run says whether the
 * runner stalled once or was slow throughout. "Starved for 1.5 s then fine" and
 * "genuinely slow" are different facts and must not print the same number.
 */
async function measureRafRate(page: Page): Promise<{ fps: number; windows: RateWindow[] }> {
  const windows = await page.evaluate(
    async ({ windowMs, count }) => {
      const g = globalThis as unknown as { __probeFrame: number };
      const out: { frames: number; elapsedMs: number; fps: number }[] = [];
      for (let i = 0; i < count; i++) {
        const t0 = performance.now();
        const f0 = g.__probeFrame;
        await new Promise((r) => setTimeout(r, windowMs));
        // Elapsed is measured, never assumed: a starved thread fires the
        // timeout late, and dividing by the REQUESTED window would then report
        // a rate that never happened.
        const elapsedMs = performance.now() - t0;
        const frames = g.__probeFrame - f0;
        out.push({ frames, elapsedMs, fps: (frames * 1000) / elapsedMs });
      }
      return out;
    },
    { windowMs: FPS_WINDOW_MS, count: FPS_WINDOWS },
  );
  return { fps: Math.max(...windows.map((w) => w.fps)), windows };
}

const fmtWindows = (ws: RateWindow[]) =>
  ws.map((w) => `${w.frames}f/${Math.round(w.elapsedMs)}ms=${w.fps.toFixed(1)}fps`).join(' ');

type WallGap = { frames: number; gapMs: number; roundTripMs: number };

/**
 * Read the probe canvas the OLD way: one round trip per sample, separated by a
 * wall-clock wait — the defective pattern, reproduced verbatim so the file is
 * still exercising the real thing.
 *
 * INSTRUMENTED, though, which is the new part: each gap reports the wall clock
 * it ACTUALLY spent and how much of that was the Playwright round trip. That
 * decomposition is what turns "200 ms bought 11 frames" from a mystery into a
 * finding — the gap was never 200 ms.
 */
async function readFramesWallClockSpaced(
  page: Page,
  n: number,
  spacingMs: number,
): Promise<{ frames: number[]; gaps: WallGap[] }> {
  const rows: { frame: number; tBefore: number; tAfter: number }[] = [];
  for (let i = 0; i < n; i++) {
    const tBefore = Date.now();
    const frame = await page.locator(PROBE_CANVAS).evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      // Pixel (1,0) carries the flat field = frame % 256.
      return ctx.getImageData(1, 0, 1, 1).data[0]!;
    });
    rows.push({ frame, tBefore, tAfter: Date.now() });
    if (i < n - 1) await page.waitForTimeout(spacingMs);
  }
  return {
    frames: rows.map((r) => r.frame),
    gaps: rows.slice(1).map((r, i) => ({
      frames: r.frame - rows[i]!.frame,
      gapMs: r.tAfter - rows[i]!.tAfter,
      roundTripMs: r.tAfter - r.tBefore,
    })),
  };
}

test.describe('behavioral sweep — the video observation window is FRAMES, not milliseconds', () => {
  test('samples land exactly N rendered frames apart, however slow the frames are', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await installFrameProbeCanvas(page, { msPerFrame: HOG_MS_PER_FRAME });

    const t0 = Date.now();
    const cap = await captureCanvasStatsFrameSpaced(page, PROBE_CANVAS, {
      captures: VIDEO_CAPTURES,
      spacingFrames: VIDEO_CAPTURE_SPACING_FRAMES,
      capMs: VIDEO_CAPTURE_CAP_MS,
    });
    const elapsedMs = Date.now() - t0;

    expect(cap, 'the probe canvas must be readable').not.toBeNull();
    expect(cap!.frames, `${VIDEO_CAPTURES} samples`).toHaveLength(VIDEO_CAPTURES);

    const gaps = cap!.frames.slice(1).map((f, i) => f - cap!.frames[i]!);
    expect(
      gaps,
      `every gap must be exactly ${VIDEO_CAPTURE_SPACING_FRAMES} FRAMES (unit: frames, not ms). ` +
        `Got frames ${cap!.frames.join(',')} in ${elapsedMs} ms of wall clock.`,
    ).toEqual(gaps.map(() => VIDEO_CAPTURE_SPACING_FRAMES));

    // And the samples must be DISTINCT — a capture whose three samples are the
    // same picture makes `computeDelta`'s range criterion vacuous.
    const variances = cap!.samples.map((s) => s.variance);
    expect(
      new Set(variances).size,
      `all ${VIDEO_CAPTURES} samples must be different rendered frames; got variances ` +
        `${variances.join(',')}`,
    ).toBe(VIDEO_CAPTURES);

    // If the hog is not biting, everything above would pass trivially on a fast
    // page and this file would be decoration. 16 frames at ~120 ms is ~1.9 s;
    // the two 200 ms gaps it replaces are 0.4 s.
    expect(
      elapsedMs,
      `${(VIDEO_CAPTURES - 1) * VIDEO_CAPTURE_SPACING_FRAMES} frames at ~${HOG_MS_PER_FRAME} ms ` +
        `took ${elapsedMs} ms of WALL CLOCK. If that is under the ` +
        `${(VIDEO_CAPTURES - 1) * OLD_MS_SPACING} ms of wall-clock gaps it replaces, the ` +
        `main-thread hog is not biting — re-check it before trusting the green above.`,
    ).toBeGreaterThan((VIDEO_CAPTURES - 1) * OLD_MS_SPACING);
    expect(elapsedMs, `…and well inside the ${VIDEO_CAPTURE_CAP_MS} ms failure cap`)
      .toBeLessThan(VIDEO_CAPTURE_CAP_MS);
  });

  test('NEGATIVE CONTROL: the 200 ms spacing is a DIFFERENT window at a different frame rate', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // Both halves run against the SAME page, the SAME renderer and the SAME
    // build — the ONLY variable is how expensive a frame is. A navigation tears
    // the previous hog's rAF loop down, so the two legs cannot contaminate
    // each other.
    const leg = async (msPerFrame: number) => {
      await page.goto('/rack?shell=legacy&seed=none');
      await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
      await installFrameProbeCanvas(page, { msPerFrame });
      // GROUND TRUTH first, in the page. Everything else on this leg is a
      // consequence of this number.
      const rate = await measureRafRate(page);
      const wall = await readFramesWallClockSpaced(page, VIDEO_CAPTURES, OLD_MS_SPACING);
      const frameSpaced = await captureCanvasStatsFrameSpaced(page, PROBE_CANVAS, {
        captures: VIDEO_CAPTURES,
        spacingFrames: VIDEO_CAPTURE_SPACING_FRAMES,
        capMs: VIDEO_CAPTURE_CAP_MS,
      });
      return {
        rate,
        wall,
        frames: frameSpaced!.frames.slice(1).map((f, i) => f - frameSpaced!.frames[i]!),
      };
    };

    const fast = await leg(0);
    const slow = await leg(HOG_MS_PER_FRAME);

    const nominal = (fps: number) => ((fps * OLD_MS_SPACING) / 1000).toFixed(2);
    const context =
      `free-running arm ${fast.rate.fps.toFixed(1)} fps [${fmtWindows(fast.rate.windows)}] · ` +
      `hogged arm ${slow.rate.fps.toFixed(1)} fps [${fmtWindows(slow.rate.windows)}]`;

    // ── 1. THE HOG BITES. ────────────────────────────────────────────────────
    // Asserted against the CONSTRUCTION ceiling, so contention cannot fake a
    // pass: a loaded runner can only push this arm further below the bound.
    expect(
      slow.rate.fps,
      `the hogged arm must be pinned at or under its ${HOG_CEILING_FPS.toFixed(2)} fps ` +
        `CONSTRUCTION ceiling (a ${HOG_MS_PER_FRAME} ms busy-wait inside the rAF callback). ` +
        `It read ${slow.rate.fps.toFixed(1)} fps. Above the ceiling means the burn loop is not ` +
        `running — the hog has stopped biting and NOTHING in this file is discriminating. ` +
        `Windows: ${fmtWindows(slow.rate.windows)}`,
    ).toBeLessThanOrEqual(HOG_CEILING_FPS * 1.15);

    // ── 2. THE RUNNER COULD DELIVER A GENUINE FAST ARM. ──────────────────────
    // The one quantity here that the machine controls. Loud on failure and
    // never skipped: if this box cannot outrun the hog by ${SEPARATION_FLOOR}×,
    // the comparison below is untestable HERE, which is a red, not a pass.
    expect(
      fast.rate.fps,
      `the free-running arm reached only ${fast.rate.fps.toFixed(1)} fps, under the ` +
        `${FAST_ARM_FLOOR_FPS.toFixed(1)} fps floor DERIVED from ${SEPARATION_FLOOR}× the ` +
        `${HOG_CEILING_FPS.toFixed(2)} fps hog ceiling. Something other than the hog is throttling ` +
        `this page, so the separation this file asserts cannot be evaluated here — this is not a ` +
        `budget to raise. Windows (best-of-${FPS_WINDOWS} is used, so a single stall is already ` +
        `tolerated): ${fmtWindows(fast.rate.windows)}`,
    ).toBeGreaterThanOrEqual(FAST_ARM_FLOOR_FPS);

    // ── 3. THE DEFECT, REPRODUCED — IN THE UNIT THAT SURVIVES A LOADED RUNNER.
    // A wall-clock spacing is a DIFFERENT observation window at a different
    // frame rate; the size of that difference is a RATE RATIO. MEASURED on this
    // box, varying ONLY the per-frame cost (page-side rate, then what a nominal
    // 200 ms is worth at it):
    //
    //     hog   0 ms/frame → 119.8 fps → 200 ms is 23.96 frames
    //     hog 120 ms/frame →   8.3 fps → 200 ms is  1.66 frames
    //
    // 14.4×. Same code, same assertion text, a 14.4× different observation
    // window — CLAUDE.md's "it is not one assertion, it is a different
    // assertion per machine", reproduced on demand and kept as a PERMANENT leg
    // rather than a one-off check at authoring time.
    //
    // ⚠ WHAT THIS ONE ADDS OVER 1 AND 2, honestly: not much arithmetic. Gates 1
    // and 2 together already force the ratio above 33.3 / (8.33 × 1.15) = 3.48,
    // so this bound only claims the last 15 %. It is kept because it is the
    // only place the PROPERTY is stated in the unit the file exists to defend,
    // and because it stays the invariant if either individual bound is ever
    // re-derived. It is NOT a third independent measurement — gate 4 is.
    expect(
      fast.rate.fps / slow.rate.fps,
      `a ${OLD_MS_SPACING} ms WALL-CLOCK spacing is worth ${nominal(fast.rate.fps)} rendered frames on ` +
        `the free-running page and ${nominal(slow.rate.fps)} at ~${HOG_CEILING_FPS.toFixed(1)} fps — a ` +
        `${(fast.rate.fps / slow.rate.fps).toFixed(1)}× different window from ONE unchanged constant. ` +
        `If that ratio collapses toward 1 the hog is not biting and NOTHING in this file is ` +
        `discriminating. ${context}`,
    ).toBeGreaterThanOrEqual(SEPARATION_FLOOR);

    // ── 4. …AND THE SPACING WAS NEVER 200 ms OF ANYTHING EITHER. ─────────────
    // An INDEPENDENT indictment of the old window, in the other unit. Each
    // "200 ms" gap on the hogged arm is dominated by the Playwright round trip,
    // because every `locator.evaluate` has to wait for a main thread that
    // yields once per ${HOG_MS_PER_FRAME} ms frame. MEASURED: 1323–1350 ms per
    // gap, of which 963–990 ms is round trip — the wait is 15 % of its own
    // window. Robust by construction: contention can only make this bigger.
    //
    // This is also exactly why the raw wall-clock FRAME COUNTS below are
    // reported and NOT gated on. That round-trip term inflates the hogged arm's
    // count ~6.6× (a true 1.66 frames reads as 11) while leaving the
    // free-running arm's alone (23.96 reads as 26), so an ABSOLUTE difference
    // between the two counts is compressed 14.4× → 2.4× and its margin ends up
    // set by the free-running arm's uncontrolled fps rather than by the effect.
    // On the CI runner of run 30791843249 that arm ran at ~71 fps instead of
    // ~120 and the counts came out 15 vs 11 — a 4-frame difference against a
    // ≥5 bound, RED, while the underlying separation was still ~8.5×.
    const slowGapMs = Math.max(...slow.wall.gaps.map((g) => g.gapMs));
    const fmtGaps = (gs: WallGap[]) =>
      gs.map((g) => `${g.frames}f in ${g.gapMs}ms (round trip ${g.roundTripMs}ms)`).join(' · ');
    expect(
      slowGapMs,
      `each "${OLD_MS_SPACING} ms" gap on the hogged arm must actually COST far more than ` +
        `${OLD_MS_SPACING} ms of wall clock — that is the second half of "uncontrolled in BOTH ` +
        `units". Hogged: ${fmtGaps(slow.wall.gaps)}. Free-running, for contrast: ` +
        `${fmtGaps(fast.wall.gaps)}.`,
    ).toBeGreaterThan(OLD_MS_SPACING * 2);

    // ── 5. THE FIX. ──────────────────────────────────────────────────────────
    // Measured the same way on the same two pages: the FRAME spacing is the
    // same window on both, which is the entire property a renderer-independent
    // wait is supposed to have.
    expect(
      { fast: fast.frames, slow: slow.frames },
      `the FRAME spacing must be identical at both frame rates — that invariance is the fix. ` +
        `The wall clock, for contrast, moved ${nominal(slow.rate.fps)} → ${nominal(fast.rate.fps)} ` +
        `frames per ${OLD_MS_SPACING} ms across the same two pages. ${context}`,
    ).toEqual({
      fast: fast.frames.map(() => VIDEO_CAPTURE_SPACING_FRAMES),
      slow: slow.frames.map(() => VIDEO_CAPTURE_SPACING_FRAMES),
    });
  });

  test('the wall-clock cap BOUNDS the failure — the frame count is the gate', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await installFrameProbeCanvas(page, { msPerFrame: HOG_MS_PER_FRAME });

    // A spacing no ~8 fps page can satisfy inside a 2 s cap: 2 × 400 frames is
    // ~96 s of frame time. The capture must give up ON THE CAP and SAY SO in
    // frames, so a red run is diagnosable as "the loop stalled" vs "too slow".
    const capMs = 2_000;
    const t0 = Date.now();
    const err = await captureCanvasStatsFrameSpaced(page, PROBE_CANVAS, {
      captures: VIDEO_CAPTURES,
      spacingFrames: 400,
      capMs,
    }).then(() => null, (e: Error) => e);
    const elapsedMs = Date.now() - t0;

    expect(err, 'an unsatisfiable frame spacing must FAIL, not return short').not.toBeNull();
    expect(
      err?.message,
      'and it must report the shortfall in FRAMES, plus the role of the cap',
    ).toMatch(/rendered FRAMES/);
    expect(
      err?.message,
      'the message must name the cap as a BOUND, so nobody reads it as the gate',
    ).toMatch(/BOUNDS THE FAILURE/);
    // The cap did the stopping here BECAUSE the frame count was unreachable —
    // and it stopped at the cap, not at the default test timeout.
    expect(
      elapsedMs,
      `the cap must stop it at ~${capMs} ms, not run to the test timeout`,
    ).toBeLessThan(capMs * 5);
  });
});

test.describe('behavioral sweep — the timeout is DERIVED from the observation plan', () => {
  // Pure arithmetic. No page, no renderer: these guard the numbers a future
  // edit is most likely to shave, and they are what stop the next timeout from
  // being "fixed" by inflating a constant.

  test('the AUDIO budget still reproduces the constant it replaces', () => {
    // THE CALIBRATION. `RUNNER_FACTOR` is not free: it is pinned by the
    // requirement that the model reproduce the flat 22 000 ms/port that has
    // been passing on this lane for the audio plan. If this drifts, the model
    // has been retuned rather than re-derived — which is exactly the "raise the
    // constant" move this change exists to avoid.
    const HISTORICAL_FLAT_PER_PORT_MS = 22_000;
    const audio = perPortBudgetMs('audio', SETTLE_MS.sameDomainScope);
    expect(
      Math.abs(audio - HISTORICAL_FLAT_PER_PORT_MS) / HISTORICAL_FLAT_PER_PORT_MS,
      `the derived AUDIO budget (${audio} ms) must stay within 10 % of the ${HISTORICAL_FLAT_PER_PORT_MS} ms ` +
        `flat constant it replaces — the audio plan did not get slower, so its budget must not ` +
        `get looser. RUNNER_FACTOR is currently ${RUNNER_FACTOR}.`,
    ).toBeLessThan(0.1);
  });

  test('the VIDEO budget covers the per-port cost that actually overran on CI', () => {
    // MEASURED: on run 30742314468 shard 3, lushgarden's 3 video ports needed
    // MORE than 96 000 ms, i.e. >32 000 ms per port, on both attempts.
    const OBSERVED_CI_VIDEO_PER_PORT_MS = 32_000;
    const video = perPortBudgetMs('video', SETTLE_MS.other);
    expect(
      video,
      `the derived VIDEO budget (${video} ms/port) must exceed the ${OBSERVED_CI_VIDEO_PER_PORT_MS} ms/port ` +
        `that overran on CI, with headroom — a budget that merely matches the failure has no margin ` +
        `for the next slower runner.`,
    ).toBeGreaterThan(OBSERVED_CI_VIDEO_PER_PORT_MS * 1.4);
    expect(
      video,
      'and the VIDEO plan must budget MORE than the AUDIO plan — that asymmetry is the whole finding',
    ).toBeGreaterThan(perPortBudgetMs('audio', SETTLE_MS.sameDomainScope));
  });

  test('the budget fits the CI job it runs in, with the margin stated', () => {
    // What a DERIVED budget is structurally unable to see: ITSELF GROWING. Two
    // more ports on a module, or a wider capture plan, and the per-test timeout
    // moves without anyone choosing to move it — and because a timeout only
    // spends wall clock when it FIRES, the first symptom would be a shard dying
    // on the JOB's ceiling, which reports as infrastructure trouble rather than
    // as a test failure. So the ceiling is asserted, in two directions.
    //
    // ⚠ This is a REAL, tight envelope, not a formality: one wedged 5-port
    // video test now spends ~9.8 of the job's 20 minutes across its two
    // attempts. That is the operational price of a budget honest enough to
    // cover a video port, and it is why the number is pinned here.
    const ATTEMPTS = 2; // playwright.config.ts: retries: 1 on CI
    const CEILING = BEHAVIORAL_JOB_TIMEOUT_MS * 0.75; // leave the shard its other ~17 tests

    // (a) The largest VIDEO plan that exists in the sweep today must fit.
    //     `luma` — 5 drivable inputs onto a video sink — is the biggest; it is
    //     also one of the two modules that overran the old flat budget.
    const LARGEST_VIDEO_PLAN_PORTS = 5;
    const worst = behavioralTimeoutMs(LARGEST_VIDEO_PLAN_PORTS, 'video', SETTLE_MS.other) * ATTEMPTS;
    expect(
      worst,
      `the largest video plan in the sweep (${LARGEST_VIDEO_PLAN_PORTS} ports, luma) can burn ` +
        `${Math.round(worst / 1000)} s across ${ATTEMPTS} attempts, against a ` +
        `${BEHAVIORAL_JOB_TIMEOUT_MS / 60_000}-minute job ceiling (ci.yml behavioral-coverage ` +
        `timeout-minutes) that also has ~17 other tests to run. If this trips, the fix is a ` +
        `CHEAPER OBSERVATION PLAN — not a bigger job timeout.`,
    ).toBeLessThan(CEILING);

    // (b) …and the HEADROOM is asserted too, so the margin cannot be silently
    //     eaten by a plan change that still happens to fit today. Expressed as
    //     the port count the budget can actually carry, which is the number a
    //     future author needs.
    const capacityPorts = Math.floor(
      (CEILING / ATTEMPTS - BEHAVIORAL_BASELINE_MS) / perPortBudgetMs('video', SETTLE_MS.other),
    );
    expect(
      capacityPorts,
      `the job envelope carries ${capacityPorts} video ports in ONE test; the biggest module in ` +
        `the sweep needs ${LARGEST_VIDEO_PLAN_PORTS}. Keep at least 2 ports of headroom so the ` +
        `NEXT video module does not land straight on the cliff — if this fails, make the video ` +
        `observation plan cheaper (fewer captures, or a tighter frame spacing) rather than ` +
        `raising the ceiling.`,
    ).toBeGreaterThanOrEqual(LARGEST_VIDEO_PLAN_PORTS + 2);
  });

  test('NEGATIVE CONTROL: the budget MOVES when the observation plan moves', () => {
    // A budget blind to the plan it budgets is exactly what was wrong before,
    // and it would look identical from the outside: a number that is simply
    // large enough today. Perturb each input the plan is made of and require
    // the number to respond — negative-control the instrument, not the code.
    const base = behavioralTimeoutMs(3, 'video', SETTLE_MS.other);

    expect(
      behavioralTimeoutMs(4, 'video', SETTLE_MS.other),
      'one more PORT must cost budget',
    ).toBeGreaterThan(base);
    expect(
      behavioralTimeoutMs(3, 'video', SETTLE_MS.other + 500),
      'a longer SETTLE must cost budget',
    ).toBeGreaterThan(base);
    expect(
      behavioralTimeoutMs(3, 'audio', SETTLE_MS.other),
      'a different SINK KIND must give a different budget',
    ).not.toBe(base);
    // And the capture counts are real inputs, not decoration.
    expect(AUDIO_CAPTURES, 'the audio plan must declare its capture count').toBeGreaterThan(1);
    expect(VIDEO_CAPTURES, 'the video plan must declare its capture count').toBeGreaterThan(1);
    expect(
      VIDEO_CAPTURE_SPACING_FRAMES,
      'the video spacing must be ≥2 frames or consecutive samples can be the same picture',
    ).toBeGreaterThanOrEqual(2);
  });
});
