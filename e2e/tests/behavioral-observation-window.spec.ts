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
// COST: ~15 s on one e2e shard, nearly all of it deliberate CPU burn inside
// this one page. It adds nothing to any other spec.
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

/** Read the probe canvas the OLD way: one round trip per sample, separated by
 *  a wall-clock wait. Returns the painted frame index of each sample. */
async function readFramesWallClockSpaced(page: Page, n: number, spacingMs: number): Promise<number[]> {
  const frames: number[] = [];
  for (let i = 0; i < n; i++) {
    frames.push(
      await page.locator(PROBE_CANVAS).evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        // Pixel (1,0) carries the flat field = frame % 256.
        return ctx.getImageData(1, 0, 1, 1).data[0]!;
      }),
    );
    if (i < n - 1) await page.waitForTimeout(spacingMs);
  }
  return frames;
}

test.describe('behavioral sweep — the video observation window is FRAMES, not milliseconds', () => {
  test('samples land exactly N rendered frames apart, however slow the frames are', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/rack');
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
      await page.goto('/rack');
      await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
      await installFrameProbeCanvas(page, { msPerFrame });
      const wall = await readFramesWallClockSpaced(page, VIDEO_CAPTURES, OLD_MS_SPACING);
      const frameSpaced = await captureCanvasStatsFrameSpaced(page, PROBE_CANVAS, {
        captures: VIDEO_CAPTURES,
        spacingFrames: VIDEO_CAPTURE_SPACING_FRAMES,
        capMs: VIDEO_CAPTURE_CAP_MS,
      });
      const gaps = (xs: number[]) => xs.slice(1).map((f, i) => f - xs[i]!);
      return { wall: gaps(wall), frames: gaps(frameSpaced!.frames) };
    };

    const fast = await leg(0);
    const slow = await leg(HOG_MS_PER_FRAME);

    // THE DEFECT, REPRODUCED, as a PERMANENT leg of the suite rather than a
    // one-off check at authoring time. MEASURED on one box, one renderer, one
    // page, varying ONLY the per-frame cost:
    //
    //     hog 0 ms/frame   → 200 ms bought 29, 26 frames
    //     hog 30 ms/frame  → 200 ms bought 16, 16 frames
    //     hog 120 ms/frame → 200 ms bought 11, 11 frames
    //     hog 250 ms/frame → 200 ms bought 10, 10 frames
    //
    // Same code, same assertion text, a 2.9× different observation window. That
    // is CLAUDE.md's "it is not one assertion — it is a different assertion per
    // machine", reproduced on demand. (It does not collapse all the way to one
    // frame because the Playwright round trip dominates once frames are
    // expensive — which is its own indictment: the window was never 200 ms of
    // anything either. At 250 ms/frame those "200 ms" gaps cost ~2.5 s each.)
    const fastMax = Math.max(...fast.wall);
    const slowMax = Math.max(...slow.wall);
    expect(
      fastMax - slowMax,
      `a ${OLD_MS_SPACING} ms WALL-CLOCK spacing bought ${fast.wall.join(',')} frames on a free-running ` +
        `page and ${slow.wall.join(',')} frames at ~${(1000 / HOG_MS_PER_FRAME).toFixed(1)} fps. If those ` +
        `are the same, the main-thread hog is not biting and NOTHING in this file is ` +
        `discriminating — fix the hog before trusting any green here.`,
    ).toBeGreaterThanOrEqual(5);

    // …and the fix, measured the same way on the same two pages: the FRAME
    // spacing is the same window on both, which is the entire property a
    // renderer-independent wait is supposed to have.
    expect(
      { fast: fast.frames, slow: slow.frames },
      `the FRAME spacing must be identical at both frame rates — that invariance is the fix. ` +
        `Wall-clock, for contrast, moved ${slowMax} → ${fastMax} frames.`,
    ).toEqual({
      fast: fast.frames.map(() => VIDEO_CAPTURE_SPACING_FRAMES),
      slow: slow.frames.map(() => VIDEO_CAPTURE_SPACING_FRAMES),
    });
  });

  test('the wall-clock cap BOUNDS the failure — the frame count is the gate', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/rack');
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
