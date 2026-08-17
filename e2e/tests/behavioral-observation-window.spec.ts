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
// ── AND THE MEASUREMENT NEVER ESTABLISHED ITS PRECONDITION (2026-08-13, #1502)
//
// All of the above is about what the samples are spaced BY. It says nothing
// about whether the page was rendering when the spacing was measured — and on
// ELEVEN of eighteen audited CI runs it was not: the capture began within
// milliseconds of the navigation and its wall-clock cap expired with the page
// still at 0.04–0.94 fps, 9–180× under the hog's own construction ceiling. The
// full evidence, and why the sibling negative control never hit it, is on the
// describe block below. The structural
// answer is `openProbePage`: navigate, install the hog, and then WAIT — in the
// page — until the achieved rAF rate clears twice the rate at which the capture
// plan breaks even against its own cap, failing loudly if it never does.
//
// This is a PRECONDITION, not a budget. It cannot make a slow capture pass: the
// capture's own cap is unchanged, and a page that renders fast enough to clear
// the precondition finishes the plan with ~5× to spare.
//
// ⚠ The titles here deliberately avoid the string `BEHAVIORAL input coverage`:
// ci.yml partitions the heavy behavioral lane out of the sharded e2e matrix
// with a `--grep-invert` covering the collab and capacity tags plus that
// string, and this file belongs in the sharded lane where it gates every PR.
//
// The two tags are spelled WITHOUT their leading at-sign in this comment. That
// used to be LOAD-BEARING: `scripts/collab-attest-lib.ts` resolved the collab
// attest basis by scanning e2e/tests for those tags in their at-prefixed form,
// matching the FILE rather than the test title, so merely quoting the selector
// verbatim in a comment enrolled this spec in the basis and made every future
// edit demand a collab re-attest (it happened, on the first push of that PR).
// The collab attest was deleted 2026-08-17 and nothing greps for the sigil form
// any more, so this is now only a style leftover — not a rule to enforce.

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

// ── THE PRECONDITION EVERY MEASUREMENT IN THIS FILE NEEDS ──────────────────
//
// Every constant below is DERIVED from the capture plan and its own cap. None
// is a budget, and none may be raised to make a red run green: raising them
// weakens the precondition, it does not buy the capture any time.

/**
 * Rendered frames ONE capture must produce to finish: the first sample lands on
 * frame 1 and each later one `VIDEO_CAPTURE_SPACING_FRAMES` after the previous.
 */
const CAPTURE_FRAMES_NEEDED = (VIDEO_CAPTURES - 1) * VIDEO_CAPTURE_SPACING_FRAMES + 1;

/**
 * The rate BELOW which the capture plan cannot finish inside its own cap —
 * arithmetic, not a measurement: 33 frames / 20 000 ms.
 */
const CAPTURE_BREAK_EVEN_FPS = (CAPTURE_FRAMES_NEEDED * 1000) / VIDEO_CAPTURE_CAP_MS;

/**
 * The rate the page must ALREADY be sustaining before a capture is allowed to
 * start: twice break-even, so the capture has a factor of two in hand.
 *
 * The hog pins a healthy page at HOG_CEILING_FPS = 8.33, which is 5× break-even
 * — so this precondition is satisfiable with 2.5× to spare BY CONSTRUCTION on
 * any page where the hog is the only thing throttling. It is not a tolerance.
 */
const RENDERING_MIN_FPS = CAPTURE_BREAK_EVEN_FPS * 2;

/**
 * How long the page may take to REACH that rate after a navigation.
 *
 * ⚠ This bounds the PRECONDITION, never the capture, and the two must not be
 * confused — that confusion is the bug this constant exists to fix.
 *
 * TWO bounds pin it, and both are ASSERTED at the bottom of this file rather
 * than argued for here:
 *
 *   FROM BELOW, by the measurement. The eleven first-attempt failures tabulated
 *   in the describe block below had each spent 20.0–25.7 s inside the capture
 *   with the page still at 0.04–0.94 fps. 40 s is ~1.55× the longest of those.
 *
 *   FROM ABOVE, by the envelope. A precondition wait that can outlive its own
 *   test converts the cold-start case from the diagnostic red this change
 *   exists to produce into a MUTE Playwright timeout, which is strictly worse
 *   than the flake. The binding constraint is the two-leg negative control:
 *   two pages, each of which can spend PAGE_OPEN_MS + this + a full capture cap.
 *
 *   ⚠ It was 60 s on the first draft and the envelope test caught it: 2 ×
 *   (10 + 60 + 20) = 180 000 ms against a 180 000 ms timeout, i.e. exactly ON
 *   the cliff. That is what the assertion is for.
 *
 * It is a POLICY THRESHOLD ON A MEASUREMENT, not a budget: if a red run ever
 * reports "never reached N fps in 40 s", the page is not rendering at all and
 * THAT is the finding. Raising this weakens the precondition and eats the
 * envelope; it does not buy the capture a single frame.
 */
const RENDERING_START_CAP_MS = 40_000;

/**
 * The per-test timeouts, hoisted so the envelope can be ASSERTED rather than
 * hoped for.
 *
 * ⚠ A precondition wait has a failure mode the thing it replaced did not: it can
 * push a test past its OWN timeout, and a Playwright timeout is mute — it names
 * no rate and prints no cadence, which is precisely the diagnosis this change
 * exists to produce. So the worst case (a full cold-start wait on every page the
 * test opens, plus a full capture cap on every capture it takes) is checked
 * against these in the arithmetic block at the bottom of the file. If that check
 * fails, the answer is a cheaper test — not a bigger number here.
 */
const PAGE_TEST_TIMEOUT_MS = 120_000;
/** The two-leg negative control opens TWO pages and captures on each. */
const CONTROL_TEST_TIMEOUT_MS = 180_000;
/** Navigation + hydration wait + probe install, before any of this file's own
 *  waiting starts. Priced at the slow end; it is ~5 s on a quiet CI shard. */
const PAGE_OPEN_MS = 10_000;

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

type RenderingStart = {
  reached: boolean;
  waitedMs: number;
  best: number;
  windows: RateWindow[];
};

/**
 * Block until the page is ACTUALLY producing frames at `minFps`, or give up.
 *
 * WHY THIS EXISTS, and why it is not a widened budget. A capture that starts
 * before the page is rendering is not measuring the frame-spacing property at
 * all — it is measuring how long that page took to boot, in a unit (the
 * capture's wall-clock cap) that cannot say so. See the describe block below
 * for the five CI failures that were exactly this.
 *
 * The wait is a PRECONDITION, so it is asserted, never skipped: a page that
 * never renders is a loud red with the rate it did reach, which is a different
 * message from "frame-spaced samples were not N frames apart".
 *
 * Accumulated ENTIRELY IN THE PAGE (CLAUDE.md defence #5) — one round trip for
 * the whole wait, so the sampler cannot starve the subject it is waiting on.
 * Windows are timed with `setTimeout`, NOT rAF, on purpose: a rAF-paced probe
 * for "is rAF running?" reports nothing at all in exactly the case it exists to
 * detect, and "stalled" would be indistinguishable from "never looked".
 */
async function waitUntilRendering(
  page: Page,
  opts: { minFps: number; capMs: number; windowMs: number },
): Promise<RenderingStart> {
  return await page.evaluate(
    async ({ minFps, capMs, windowMs }) => {
      const g = globalThis as unknown as { __probeFrame?: number };
      const t0 = performance.now();
      const windows: { frames: number; elapsedMs: number; fps: number }[] = [];
      let best = 0;
      for (;;) {
        const w0 = performance.now();
        const f0 = g.__probeFrame ?? 0;
        await new Promise((r) => setTimeout(r, windowMs));
        // Elapsed is measured, never assumed — a starved thread fires the
        // timeout late and dividing by the REQUESTED window would report a rate
        // that never happened.
        const elapsedMs = performance.now() - w0;
        const frames = (g.__probeFrame ?? 0) - f0;
        const fps = elapsedMs > 0 ? (frames * 1000) / elapsedMs : 0;
        windows.push({ frames, elapsedMs, fps });
        if (fps > best) best = fps;
        const waitedMs = performance.now() - t0;
        if (fps >= minFps) return { reached: true, waitedMs, best, windows };
        if (waitedMs >= capMs) return { reached: false, waitedMs, best, windows };
      }
    },
    { minFps: opts.minFps, capMs: opts.capMs, windowMs: opts.windowMs },
  );
}

/**
 * Navigate, install the frame probe at `msPerFrame`, and WAIT UNTIL THE PAGE IS
 * RENDERING before returning — the single entry point every page test in this
 * file uses, so no test can accidentally measure a page that has not started.
 *
 * Returns the precondition's own evidence so the caller can put the cold-start
 * cost into its failure messages and into the report.
 */
async function openProbePage(page: Page, msPerFrame: number): Promise<RenderingStart> {
  await page.goto('/rack?shell=legacy&seed=none');
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await installFrameProbeCanvas(page, { msPerFrame });

  const start = await waitUntilRendering(page, {
    minFps: RENDERING_MIN_FPS,
    capMs: RENDERING_START_CAP_MS,
    windowMs: FPS_WINDOW_MS,
  });
  expect(
    start.reached,
    `the page never reached ${RENDERING_MIN_FPS.toFixed(2)} fps in ` +
      `${RENDERING_START_CAP_MS} ms — it peaked at ${start.best.toFixed(2)} fps. That rate is ` +
      `2× the ${CAPTURE_BREAK_EVEN_FPS.toFixed(2)} fps at which a ${CAPTURE_FRAMES_NEEDED}-frame ` +
      `capture plan breaks even against its own ${VIDEO_CAPTURE_CAP_MS} ms cap, and a healthy ` +
      `hogged page sits at ${HOG_CEILING_FPS.toFixed(2)} fps, so this is NOT the hog and NOT a ` +
      `budget: the page is not rendering. Windows: ${fmtWindows(start.windows.slice(-8))}`,
  ).toBe(true);
  // Recorded on GREEN runs too. Cold start is invisible from a pass/fail, and
  // this number is the only way to see it drifting before it starts failing.
  test.info().annotations.push({
    type: 'rendering-start',
    description:
      `${Math.round(start.waitedMs)} ms to ${RENDERING_MIN_FPS.toFixed(2)} fps ` +
      `(hog ${msPerFrame} ms/frame, peak ${start.best.toFixed(1)} fps, ` +
      `${start.windows.length} window(s) of ${FPS_WINDOW_MS} ms)`,
  });
  return start;
}

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
  // ── THE COLD START WAS THE BUG (root-caused 2026-08-13, #1502 / #1567) ────
  //
  // This test rode green main runs as `1 flaky` + SUCCESS for weeks. The blob
  // reports of EIGHTEEN consecutive completed CI runs were downloaded, merged
  // with `playwright merge-reports --reporter json` and audited with
  // `scripts/e2e-report-audit.mjs`; it flaked on ELEVEN of them, always with
  // the same first-attempt error, e.g.
  //
  //   video capture: only 1/3 samples spaced 16 FRAMES after 1 rendered FRAMES
  //   / 22278 ms. The 20000 ms cap BOUNDS THE FAILURE; it is not the gate —
  //   hitting it means the rAF loop stalled, not that the renderer is slow.
  //
  // THE MESSAGE'S DIAGNOSIS WAS WRONG, and that is what kept this open. Every
  // one of the eleven, as (rendered frames / elapsed ms → achieved fps):
  //
  //   1/21757  1/21906  1/24955  1/20001  2/20114  1/22278
  //   19/20103  1/22082  1/23168  11/20049  1/25653
  //
  // i.e. 0.04–0.94 fps, EVERY ONE of them 9× to 180× under the hog's 8.33 fps
  // CONSTRUCTION ceiling. Not one is a near-miss at the margin. And three of
  // the eleven rendered 2, 11 and 19 frames, so the loop was demonstrably
  // ALIVE — "stalled" was simply false for those. `elapsed >= capMs` is a
  // TOTAL: it fires identically on a dead loop and a slow one and cannot tell
  // you which. The message asserted "stalled" for all eleven anyway.
  //
  // WHAT ACTUALLY SEPARATES THE CASES — a measurement, not a hypothesis. The
  // NEGATIVE CONTROL below runs the SAME capture, with the SAME hog, against
  // the SAME page, and flaked ZERO times in those same eighteen runs. Its only
  // structural difference is that it spends ~6 s probing the page (four 500 ms
  // rAF-rate windows, then three wall-clock-spaced reads) BEFORE it captures.
  // At the observed 11/18 rate, eighteen clean runs of an equally-exposed test
  // has probability (7/18)^18 ≈ 3e-8, so the asymmetry is the finding: the
  // flake is in the first seconds after the navigation, not in the capture.
  //
  // Durations agree. Over the first twelve runs audited, the nine passes took
  // 9.3–10.9 s eight times and 19.2 / 26.5 s twice — a long right tail that
  // crosses the 20 s cap rather than a bimodal healthy/broken split.
  //
  // SO THE TEST WAS MEASURING ITS OWN PRECONDITION. The capture began within
  // milliseconds of the navigation, and its wall-clock cap then bounded "how
  // long did this page take to start rendering" in a unit that cannot say so.
  // THE FIX IS NOT A BIGGER CAP: `openProbePage` now waits, in the page, until
  // the page is sustaining 2× the rate at which the capture plan breaks even
  // against its own cap — and FAILS LOUDLY, naming the achieved rate, if it
  // never does. The capture then measures frame spacing, which is what it
  // claims to measure. What the wait costs on a healthy page is one 500 ms
  // window; what it buys is that a slow boot is a wait instead of a red.
  //
  // ⚠ NOT VERIFIED: that the page's rAF cadence recovers on every CI runner
  // within RENDERING_START_CAP_MS. The cold start was measured from CI blob
  // reports, not reproduced locally — a 4-vCPU runner with four sibling workers
  // is the environment that produces it, and this file's hog (a deliberate
  // busy-wait) is a bad citizen on it. If a red run reports "never reached
  // N fps", that is a NEW finding and the cap is not the thing to change.
  test('samples land exactly N rendered frames apart, however slow the frames are', async ({
    page,
  }) => {
    test.setTimeout(PAGE_TEST_TIMEOUT_MS);
    const start = await openProbePage(page, HOG_MS_PER_FRAME);

    const t0 = Date.now();
    const cap = await captureCanvasStatsFrameSpaced(page, PROBE_CANVAS, {
      captures: VIDEO_CAPTURES,
      spacingFrames: VIDEO_CAPTURE_SPACING_FRAMES,
      capMs: VIDEO_CAPTURE_CAP_MS,
    });
    const elapsedMs = Date.now() - t0;

    expect(cap, 'the probe canvas must be readable').not.toBeNull();
    expect(cap!.frames, `${VIDEO_CAPTURES} samples`).toHaveLength(VIDEO_CAPTURES);

    // The cold-start cost and the in-capture cadence, on EVERY message from
    // here down: they are what tell "this page was still booting" apart from
    // "frame-spaced sampling is broken", and the five CI failures above are
    // exactly the pair that used to be indistinguishable.
    const cadence =
      `Precondition: ${Math.round(start.waitedMs)} ms to reach ` +
      `${RENDERING_MIN_FPS.toFixed(2)} fps (peak ${start.best.toFixed(1)} fps). ` +
      `Capture: first frame ${Math.round(cap!.firstFrameMs)} ms in, longest inter-frame gap ` +
      `${Math.round(cap!.maxFrameGapMs)} ms.`;

    const gaps = cap!.frames.slice(1).map((f, i) => f - cap!.frames[i]!);
    expect(
      gaps,
      `every gap must be exactly ${VIDEO_CAPTURE_SPACING_FRAMES} FRAMES (unit: frames, not ms). ` +
        `Got frames ${cap!.frames.join(',')} in ${elapsedMs} ms of wall clock. ${cadence}`,
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
        `main-thread hog is not biting — re-check it before trusting the green above. ${cadence}`,
    ).toBeGreaterThan((VIDEO_CAPTURES - 1) * OLD_MS_SPACING);
    expect(
      elapsedMs,
      `…and well inside the ${VIDEO_CAPTURE_CAP_MS} ms failure cap. This is the ONE assertion ` +
        `in this test that is wall clock on a renderer-dependent page, so it is the one to read ` +
        `sceptically: with the precondition established the capture needs ` +
        `${CAPTURE_FRAMES_NEEDED} frames at ~${HOG_MS_PER_FRAME} ms ≈ ` +
        `${Math.round(CAPTURE_FRAMES_NEEDED * HOG_MS_PER_FRAME)} ms, ~5× inside the cap. ${cadence}`,
    ).toBeLessThan(VIDEO_CAPTURE_CAP_MS);
  });

  test('NEGATIVE CONTROL: the 200 ms spacing is a DIFFERENT window at a different frame rate', async ({
    page,
  }) => {
    test.setTimeout(CONTROL_TEST_TIMEOUT_MS);

    // Both halves run against the SAME page, the SAME renderer and the SAME
    // build — the ONLY variable is how expensive a frame is. A navigation tears
    // the previous hog's rAF loop down, so the two legs cannot contaminate
    // each other.
    const leg = async (msPerFrame: number) => {
      // ⚠ This leg used to rely on `measureRafRate` INCIDENTALLY absorbing the
      // page's cold start — it waits on `setTimeout`, so a stalled rAF loop
      // costs it a low window rather than a failure, and taking the best of
      // four hides it entirely. That accident is why this test flaked 0/12
      // while its sibling above flaked 5/12. Relying on it is not a design, so
      // the precondition is now explicit and shared.
      await openProbePage(page, msPerFrame);
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
    test.setTimeout(PAGE_TEST_TIMEOUT_MS);
    // Same precondition, for the same reason and with an extra one: this test
    // asserts the cap stops the capture at ~2 s, so a page that has not started
    // rendering would blow that bound too. It has not flaked, but it carries
    // the identical exposure — an unexercised path is not a safe one.
    await openProbePage(page, HOG_MS_PER_FRAME);

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

  test("this file's OWN tests survive their own worst case, so a red is never MUTE", () => {
    // WHAT A PRECONDITION WAIT CAN BREAK THAT THE OLD CODE COULD NOT.
    // `openProbePage` may spend up to RENDERING_START_CAP_MS before the capture
    // even starts, and the capture may then spend up to VIDEO_CAPTURE_CAP_MS.
    // If that sum can exceed a test's own timeout, the cold-start case stops
    // producing the diagnostic red this change exists to produce and starts
    // producing a PLAYWRIGHT TIMEOUT — which names no rate, prints no cadence
    // and reads as infrastructure trouble. That is a strictly worse outcome
    // than the flake, so it is asserted rather than reasoned about.
    const pageWorstCaseMs = PAGE_OPEN_MS + RENDERING_START_CAP_MS + VIDEO_CAPTURE_CAP_MS;

    // The two single-page tests open ONE page and take ONE capture on it.
    expect(
      pageWorstCaseMs,
      `a single-page test's worst case is ${pageWorstCaseMs} ms (open ${PAGE_OPEN_MS} + ` +
        `precondition ${RENDERING_START_CAP_MS} + capture cap ${VIDEO_CAPTURE_CAP_MS}) against a ` +
        `${PAGE_TEST_TIMEOUT_MS} ms test timeout. If this fails the cold-start case reports as a ` +
        `MUTE Playwright timeout instead of "the page never reached N fps" — shorten the ` +
        `precondition cap or the capture plan; do NOT just raise the timeout, because the timeout ` +
        `is not what tells you anything.`,
    ).toBeLessThan(PAGE_TEST_TIMEOUT_MS);

    // The negative control opens TWO pages and captures on each, and also pays
    // the rate probe + the three wall-clock-spaced reads per leg. Those extra
    // terms are bounded by the same page budget, so two of it is the bound —
    // and this is the constraint that actually BINDS RENDERING_START_CAP_MS.
    // It caught the 60 s first draft sitting exactly ON its timeout.
    expect(
      2 * pageWorstCaseMs,
      `the two-leg negative control's worst case is ${2 * pageWorstCaseMs} ms against its ` +
        `${CONTROL_TEST_TIMEOUT_MS} ms timeout — same reasoning, twice the pages. This is the ` +
        `bound that sizes RENDERING_START_CAP_MS (currently ${RENDERING_START_CAP_MS} ms); it is ` +
        `not the timeout that should move.`,
    ).toBeLessThan(CONTROL_TEST_TIMEOUT_MS);

    // …and the margin is asserted too, so it cannot be silently eaten down to
    // the cliff the 60 s draft was sitting on. A worst case that merely FITS
    // has no room for the runner overhead Playwright itself adds on a failing
    // attempt (trace, video, screenshot, teardown).
    const controlMarginRatio = CONTROL_TEST_TIMEOUT_MS / (2 * pageWorstCaseMs);
    expect(
      controlMarginRatio,
      `the two-leg control's worst case leaves only ${controlMarginRatio.toFixed(2)}× margin. ` +
        `Playwright's own failing-attempt overhead (trace + video + screenshot + teardown) is not ` +
        `in the model, so a worst case that merely fits is a mute timeout waiting to happen.`,
    ).toBeGreaterThan(1.2);

    // …and the precondition must be SATISFIABLE by the page this file builds,
    // or every one of these tests is a red waiting to happen. The hog's
    // construction ceiling is the only rate a healthy hogged page can be at.
    expect(
      HOG_CEILING_FPS,
      `the hogged page runs at ${HOG_CEILING_FPS.toFixed(2)} fps by construction and the ` +
        `precondition demands ${RENDERING_MIN_FPS.toFixed(2)} fps. If the hog is ever made ` +
        `heavier than the precondition allows, every test in this file fails on its OWN setup.`,
    ).toBeGreaterThan(RENDERING_MIN_FPS);
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
