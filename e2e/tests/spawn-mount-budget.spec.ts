// e2e/tests/spawn-mount-budget.spec.ts
//
// THE HARNESS'S OWN MOUNT WAIT, under a deliberately STARVED MAIN THREAD.
//
// `spawnPatch`'s "is the node in the DOM yet" wait was a flat 5000 ms. That is
// the failure CLAUDE.md names first — "NEVER express a renderer-dependent wait
// in MILLISECONDS — count FRAMES … it is not one assertion, it is a different
// assertion per machine" — and it cost a real CI red: `<webgl2-card>: every
// declared output emits a measurable signal` timed out inside spawnPatch on
// shard 7/10 (run 30727526282), first attempt AND retry, while passing locally
// under the SAME software renderer. Measured on one machine, real GPU vs
// `E2E_SWIFTSHADER=1`: that card's spawn is 190 ms → 1437 ms, a 7.6× renderer
// tax — before CI's slower CPU and ten parallel shards. The budget did not
// change; the number of FRAMES it bought did. (The module itself was deleted
// on 2026-08-10; the measurement is about the renderer, not about it.)
//
// So the fix is a FRAME budget, and this file tests THE FIX rather than the
// module that tripped it. The instrument is what was wrong, so the instrument
// is what gets a test (CLAUDE.md: "negative-control the instrument, not just
// the code").
//
// HOW IT DISCRIMINATES. The page is put under a rAF hog that burns ~120 ms per
// frame — ~8 fps, the rate CLAUDE.md measured under SwiftShader on the
// backdraft work. Then:
//
//   * a node that appears at frame 60 is ~7 s of WALL CLOCK. `waitForMounted`
//     must return, and the elapsed time must EXCEED the old 5000 ms gate —
//     which is precisely the case the old code failed;
//   * a node that never appears, with a 12-FRAME budget, must fail in ~1.5 s —
//     nowhere near the 60 s wall-clock cap. That is what proves the gate is
//     frames rather than the clock: if the cap were doing the work, this would
//     take a minute.
//
// Both halves matter. The first alone could pass with the ms gate merely
// raised; the second alone could pass with no gate at all.
//
// COST: ~9 s on one shard, all of it deliberate CPU burn in this one page.
// It adds nothing to any other spec — a passing spawnPatch still returns the
// instant its node mounts.

import { test, expect } from '@playwright/test';
import { MOUNT_CAP_MS, MOUNT_FRAME_BUDGET, waitForMounted } from './_helpers';

/** ~8 fps — the SwiftShader frame rate CLAUDE.md records for backdraft. */
const HOG_MS_PER_FRAME = 120;

/** The wall-clock gate this wait used to carry, and the number the first case
 *  has to sail past for the test to mean anything. */
const OLD_MS_GATE = 5000;

/**
 * Starve the main thread at a fixed cost per frame, and (optionally) insert a
 * fake mounted node after `appearAtFrame` frames. Everything is driven off the
 * SAME rAF loop, so "frame 60" is 60 frames on any machine — the property the
 * wait under test is supposed to have.
 */
async function starveMainThread(
  page: import('@playwright/test').Page,
  opts: { msPerFrame: number; appearAtFrame?: number; nodeId?: string },
): Promise<void> {
  await page.evaluate(({ msPerFrame, appearAtFrame, nodeId }) => {
    let frame = 0;
    const tick = () => {
      frame++;
      // Busy-wait, not a timer: a timer yields the thread, and yielding is
      // exactly what a WebGL draw does NOT do.
      const until = performance.now() + msPerFrame;
      while (performance.now() < until) { /* burn */ }
      if (appearAtFrame !== undefined && frame === appearAtFrame && nodeId) {
        const el = document.createElement('div');
        el.className = 'svelte-flow__node';
        el.setAttribute('data-id', nodeId);
        document.body.appendChild(el);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { msPerFrame: opts.msPerFrame, appearAtFrame: opts.appearAtFrame, nodeId: opts.nodeId });
}

test.describe('spawnPatch mount budget — FRAMES, not milliseconds', () => {
  test('a node that mounts at frame 60 is waited for, however slow the frames are', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/rack?seed=none');
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

    await starveMainThread(page, {
      msPerFrame: HOG_MS_PER_FRAME,
      appearAtFrame: 60,
      nodeId: 'slow-probe',
    });

    const t0 = Date.now();
    await waitForMounted(page, ['slow-probe']);
    const elapsedMs = Date.now() - t0;

    // 60 frames « the 300-frame budget, so this MUST succeed — and it must have
    // taken longer than the wall-clock gate it replaces, or the case is not
    // exercising anything.
    expect(
      elapsedMs,
      `60 frames at ~${HOG_MS_PER_FRAME} ms/frame took ${elapsedMs} ms of WALL CLOCK. If that ` +
        `is under the old ${OLD_MS_GATE} ms gate this case proves nothing — the main-thread ` +
        `hog is not biting, so re-check it before trusting the green.`,
    ).toBeGreaterThan(OLD_MS_GATE);
    expect(elapsedMs, `…and well inside the ${MOUNT_CAP_MS} ms failure cap`).toBeLessThan(
      MOUNT_CAP_MS,
    );
  });

  test('the FRAME budget is what fails — not the wall-clock cap', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/rack?seed=none');
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

    await starveMainThread(page, { msPerFrame: HOG_MS_PER_FRAME });

    const t0 = Date.now();
    const err = await waitForMounted(page, ['never-appears'], { frames: 12 }).then(
      () => null,
      (e: Error) => e,
    );
    const elapsedMs = Date.now() - t0;

    expect(err, 'a node that never mounts must FAIL the wait').not.toBeNull();
    expect(
      err?.message,
      'and it must say WHICH budget ran out, in the unit it is counted in',
    ).toMatch(/mount FRAME budget exhausted/);
    // THE DISCRIMINATOR. 12 frames at ~120 ms is ~1.5 s. If the wall-clock cap
    // were the real gate this would have taken 60 s, so the elapsed time is
    // what proves the unit.
    expect(
      elapsedMs,
      `a 12-FRAME budget must fail in ~12 frames (~${12 * HOG_MS_PER_FRAME} ms), not at the ` +
        `${MOUNT_CAP_MS} ms cap — it took ${elapsedMs} ms, which means the CLOCK is gating, ` +
        `not the frame count.`,
    ).toBeLessThan(MOUNT_CAP_MS / 4);
  });

  test('the frame budget keeps its measured headroom over a real mount', () => {
    // Cheap, but it guards the number a future edit is most likely to shave.
    // MEASURED worst case (see _helpers.ts): a mount is 3–5 frames on either
    // renderer — the heaviest measured (a live-WebGL2 card) is 5 on a GPU and
    // 4 under SwiftShader. The budget is headroom over THAT, not over a clock.
    const MEASURED_WORST_CASE_FRAMES = 5;
    expect(
      MOUNT_FRAME_BUDGET / MEASURED_WORST_CASE_FRAMES,
      'the frame budget must keep at least 20× headroom over the measured worst-case mount, ' +
        'so runner contention cannot eat it. Re-measure before lowering this.',
    ).toBeGreaterThanOrEqual(20);
    // And the cap must stay a FAILURE BOUND rather than the gate: it has to
    // exceed the budget's duration at the ~8 fps SwiftShader rate for the
    // frames a mount really needs, with room to spare.
    expect(
      MOUNT_CAP_MS,
      'the wall-clock cap must bound a WEDGED page, not a slow one',
    ).toBeGreaterThanOrEqual(20_000);
  });
});
