// e2e/tests/audio-health-readout.spec.ts
//
// ⚠ READ THIS BEFORE ADDING AN ASSERTION HERE.
//
// **`expect(underruns).toBe(0)` IS VACUOUSLY GREEN FOREVER AND MUST NOT BE
// WRITTEN.** Headless Chromium runs a NULL AUDIO SINK — measured on this
// runner: `outputLatency` 0, `baseLatency` 5.3 ms, and an underrun literally
// cannot occur. That assertion would pass with the entire feature deleted. The
// underrun COUNTER's behaviour is negative-controlled in both directions in the
// unit lane (`playback-stats.test.ts`, `audio-health.svelte.test.ts`), which is
// where it can actually fail.
//
// What is left for e2e is the set of facts a unit test is structurally unable
// to see, each of which CAN go red:
//
//   1. `AudioContext.playbackStats` EXISTS in the browser we ship against.
//      If a Chromium bump removes or renames it, every user's readout silently
//      becomes "—" and nothing else in the repo would notice.
//   2. The footer readout is MOUNTED and BOUND to the live context — it prints
//      a real millisecond latency, not the unsupported em-dash. Red if the
//      monitor never starts, never binds, or the poll never runs.
//   3. The scheduler tick histogram reaches the readout ONCE A MODULE STARTS
//      THE CLOCK, and is "—" before that. Red if `peekSchedulerClock` is
//      mis-wired — and the "before" leg is what stops the readout from being
//      satisfied by a hardcoded number.
//   4. The readout costs the footer ZERO HEIGHT. This one is here because it
//      already failed once: as a separate `.status` span the readout overran
//      the row's 147 px of free space, `.cable-legend` compressed until its
//      `li` text wrapped, and the bottombar went 32.375 px → 41 px — shrinking
//      the canvas by 8.6 px and moving 133 VRT baselines. A pure-unit test
//      cannot see a flex row wrap, and it is PLATFORM-DEPENDENT (font metrics
//      decide where the row runs out), so it has to be asserted in the browser
//      on the runner that actually renders CI's baselines.
//
// Cost: one page load, one spawn. ~5 s of a single shard.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test('audio health readout is live, and playbackStats exists in this browser', async ({ page }) => {
  await page.goto('/rack?shell=legacy&seed=none');
  // ⚠ THE FIRST ASSERTION IN A SPEC PAYS FOR THE APP'S LOAD, and `expect`'s
  // default budget is 5 s. `[data-testid="audio-health"]` is UNCONDITIONAL
  // markup in `footer.bottombar` (Canvas.svelte) — there is no state that can
  // withhold it — so "element(s) not found" here never means the readout is
  // broken, only that the bundle had not finished arriving. Measured on
  // ci.yml run 32408464982, e2e shard 1/10: `toBeVisible` failed with
  // `element(s) not found` after exactly 5000 ms, then PASSED on retry, which
  // reddens the whole lane through the flake gate (#1847 — a recovered flake
  // is a failure, not a pass).
  //
  // Settling the network moves the download OUT of the assertion budget
  // instead of enlarging the budget: 229 of the 305 specs that `goto('/rack')`
  // already do exactly this, and raising the timeout would leave the same race
  // with a bigger number in front of it. The `toBeVisible` below is then
  // measuring the READOUT, which is what it claims to measure.
  //
  // ⚠ VALIDATED, because "settle first" is only a fix if the settle lands
  // AFTER the element exists — otherwise it is theatre that changes nothing.
  // Raced against each other on ONE page load (two loads would compare
  // different samples and could invert by luck), 3 runs each, ms since `goto`
  // returned:
  //   · `vite preview` bundle — THE CI CONFIGURATION: readout attached at
  //     236/222/224 ms, networkidle at 631/625/623 ms → +395 to +403 ms AFTER.
  //   · dev server: readout at 796/802/802 ms, networkidle at 942/941/936 ms
  //     → +134 to +146 ms AFTER. (Also the answer to the obvious worry: the
  //     HMR websocket does NOT stop networkidle resolving here. The
  //     `domcontentloaded` in `_helpers.ts` `spawnPatch` is for a narrower
  //     case — retrying after an HMR full-reload tore the context down.)
  // It holds by construction too: the footer cannot render before the chunk
  // that renders it has arrived, and networkidle is 500 ms after the LAST
  // request.
  await page.waitForLoadState('networkidle');

  const readout = page.locator('[data-testid="audio-health"]');
  await expect(readout).toBeVisible();

  // BEFORE any module: no AudioContext and no scheduler clock, so every field
  // is the unsupported em-dash. This is the leg that makes (2) and (3) below
  // non-vacuous — without it, a readout hardcoded to "13.3/36.5ms / 4ms" passes.
  //
  // The readout is `lat BASE/AVG ms · drop COUNT/TIME · tick P99` — average
  // latency is the second half of the `lat` field (see Canvas.svelte: it and
  // `AudioContext.outputLatency` are the same quantity, so they are printed
  // once, not twice).
  await expect(readout, 'no AudioContext yet → unsupported em-dashes').toContainText('lat —/—');
  await expect(readout, 'no playbackStats yet → drop em-dashes').toContainText('drop —/—');
  await expect(readout, 'no scheduler clock yet → tick em-dash').toContainText('tick —');

  // Spawn a SEQUENCER: it boots the AudioContext *and* subscribes to the
  // scheduler clock, so it lights both sensors with one node.
  await spawnPatch(page, [{ id: 'seq-1', type: 'kria', position: { x: 120, y: 120 } }]);

  // (1) The platform fact. Probed on the app's own context, not a throwaway.
  const platform = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { ctx: AudioContext } };
    };
    const ctx = w.__engine?.().getDomain('audio').ctx;
    if (!ctx) return { booted: false, supported: false, fields: [] as string[] };
    const supported = 'playbackStats' in ctx;
    const s = supported ? (ctx as unknown as { playbackStats: object }).playbackStats : null;
    return {
      booted: true,
      supported,
      fields: s ? Object.keys(Object.getPrototypeOf(s) as object) : [],
    };
  });
  expect(platform.booted, 'the engine booted').toBe(true);
  expect(
    platform.supported,
    'AudioContext.playbackStats is GONE from this Chromium — the underrun ' +
      'counter has silently become "—" for every user. See ' +
      'packages/web/src/lib/audio/playback-stats.ts.',
  ).toBe(true);
  // The exact fields the projection reads. A rename here is the failure mode
  // that made FABLE_PERF_PLAN P1-2 name three properties that do not exist.
  for (const f of ['underrunEvents', 'underrunDuration', 'totalDuration', 'averageLatency']) {
    expect(platform.fields, `AudioPlaybackStats.${f}`).toContain(f);
  }

  // (2) The readout is BOUND and POLLING: a real latency, not an em-dash.
  // Poll from Playwright is fine here — this is a DOM text expectation with
  // auto-retry, not a hand-rolled sampling loop over a page-side quantity.
  await expect(readout, 'the monitor bound to the live context').not.toContainText('lat —/—');
  // BOTH halves of `lat base/avg ms` are real numbers. The second one is the
  // average output latency `playbackStats` reports — the field that goes back
  // to an em-dash if `audioHealth.bind()` is never called.
  await expect(readout).toContainText(/lat \d+(\.\d+)?\/\d+(\.\d+)?ms/);
  // `drop COUNT/TIME` — the count AND the starved-time total, both live.
  await expect(readout).toContainText(/drop \d+\/\d/);

  // (3) The tick histogram reaches the readout once the clock is running.
  // Timeout, not a fixed wait: the 1 Hz poll plus the 25 ms tick cadence.
  await expect(readout, 'the scheduler tick histogram reached the footer').toContainText(
    /tick \d+ms/,
    { timeout: 10_000 },
  );

  // No latched processors on a healthy boot — and NOT a vacuous assertion:
  // the badge only renders when the count is non-zero, so this is really
  // "nothing in a clean sequencer patch threw on the render thread", which a
  // genuinely broken DSP build would fail.
  await expect(page.locator('[data-testid="audio-health-dead"]')).toHaveCount(0);

  // ── (4) THE READOUT COSTS THE FOOTER ZERO HEIGHT ──────────────────────────
  //
  // Measured at the VRT viewport, because 1280 px is the width every VRT scene
  // renders at and the width at which the row ran out of room.
  //
  // Two-sided by construction, which is the point:
  //   • hiding the readout must NOT change the bottombar height  → the invariant
  //   • hiding the readout MUST change the row's width           → without this,
  //     the height leg passes just as happily against an element that is
  //     absolutely positioned, empty, or not in the row at all.
  await page.setViewportSize({ width: 1280, height: 720 });
  const geom = await page.evaluate(() => {
    const px = (n: number) => Math.round(n * 1000) / 1000;
    const bar = document.querySelector('footer.bottombar') as HTMLElement;
    const status = document.querySelector('footer.bottombar .status') as HTMLElement;
    const legend = document.querySelector('footer.bottombar .cable-legend') as HTMLElement;
    const health = document.querySelector('[data-testid="audio-health"]') as HTMLElement;

    // NATURAL widths — what the row WANTS. The as-rendered boxes are useless for
    // this: once the row overflows, flex-shrink has ALREADY compressed both
    // groups to fit, so a broken row measures as "fits". Pinning flex-shrink to
    // 0 for the duration of the read makes the overflow observable as a negative
    // number. Deliberately NOT a sum over `.status`'s children — that sum counts
    // an absolutely-positioned child that costs the row nothing, which would
    // make the vacuity guard below pass against a readout that is not in the
    // row at all. (Caught exactly that way: the first version of this probe was
    // a child sum, and `position: absolute` on `.audio-health` sailed through
    // it.) A flex container's own box excludes out-of-flow children by
    // construction.
    const naturalWidths = () => {
      const prev = [status.style.flexShrink, legend.style.flexShrink];
      status.style.flexShrink = '0';
      legend.style.flexShrink = '0';
      const cs = getComputedStyle(bar);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const sw = status.getBoundingClientRect().width;
      const lw = legend.getBoundingClientRect().width;
      const free = bar.getBoundingClientRect().width - padX - sw - lw;
      [status.style.flexShrink, legend.style.flexShrink] = prev;
      return { statusNaturalW: px(sw), legendNaturalW: px(lw), freeSpace: px(free) };
    };
    // Height is read WITHOUT the flex-shrink override — un-shrinking the row is
    // precisely what stops the legend wrapping, so measuring height under it
    // would suppress the failure this assertion exists to catch.
    const read = () => ({ barH: px(bar.getBoundingClientRect().height), ...naturalWidths() });

    const shown = read();
    health.style.display = 'none';
    const hidden = read();
    health.style.display = '';
    return { shown, hidden };
  });

  expect(
    geom.shown.statusNaturalW,
    `NEGATIVE CONTROL for the height check below: hiding [data-testid="audio-health"] ` +
      `must make the .status row NARROWER. It did not (${geom.shown.statusNaturalW} CSS px ` +
      `shown vs ${geom.hidden.statusNaturalW} hidden), so the readout is not participating ` +
      `in the footer row and the height assertion proves nothing.`,
  ).toBeGreaterThan(geom.hidden.statusNaturalW);

  expect(
    geom.shown.barH,
    `THE AUDIO-HEALTH READOUT CHANGED THE FOOTER HEIGHT: ${geom.hidden.barH} CSS px without ` +
      `it, ${geom.shown.barH} with it. The row has run out of horizontal room at 1280 px, so ` +
      `.cable-legend compressed until its li text wrapped. That shrinks the canvas by the same ` +
      `amount and moves every dock/faceplate VRT baseline. Free space in the row: ` +
      `${geom.shown.freeSpace} CSS px (was ${geom.hidden.freeSpace} without the readout); ` +
      `.status wants ${geom.shown.statusNaturalW}, .cable-legend wants ${geom.shown.legendNaturalW}. ` +
      `Shorten the readout or buy width back from the row gaps — see .audio-health in ` +
      `Canvas.svelte.`,
  ).toBe(geom.hidden.barH);

  expect(
    geom.shown.freeSpace,
    `The footer row has only ${geom.shown.freeSpace} CSS px of slack left at 1280 px ` +
      `(.status wants ${geom.shown.statusNaturalW}). Below zero the legend wraps and the ` +
      `canvas height changes; this floor is deliberately above zero so the next thing added ` +
      `to the footer fails HERE rather than as a mystery VRT diff.`,
  ).toBeGreaterThan(8);
});
