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
//
// Cost: one page load, one spawn. ~5 s of a single shard.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test('audio health readout is live, and playbackStats exists in this browser', async ({ page }) => {
  await page.goto('/rack');

  const readout = page.locator('[data-testid="audio-health"]');
  await expect(readout).toBeVisible();

  // BEFORE any module: no AudioContext and no scheduler clock, so every field
  // is the unsupported em-dash. This is the leg that makes (2) and (3) below
  // non-vacuous — without it, a readout hardcoded to "36.5ms / 4ms" passes.
  await expect(readout, 'no AudioContext yet → unsupported em-dashes').toContainText('avg —');
  await expect(readout, 'no scheduler clock yet → tick em-dash').toContainText('tick —');

  // Spawn a SEQUENCER: it boots the AudioContext *and* subscribes to the
  // scheduler clock, so it lights both sensors with one node.
  await spawnPatch(page, [{ id: 'seq-1', type: 'sequencer', x: 120, y: 120 }]);

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
  await expect(readout, 'the monitor bound to the live context').not.toContainText('avg —');
  await expect(readout).toContainText(/avg \d+(\.\d+)?ms/);
  await expect(readout).toContainText(/drop \d/);

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
});
