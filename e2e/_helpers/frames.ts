// e2e/_helpers/frames.ts
//
// THE frame-counting helpers for e2e. One export site, imported by specs and by
// e2e/vrt/_shell-faces.ts (which re-exports them, so its existing callers are
// unchanged). Issue #1523 asks for exactly one home for this; adding a second
// local `new Promise(r => requestAnimationFrame(r))` in a spec is how a repo
// ends up with fifteen slightly different settles.
//
// ── why frames and not milliseconds ────────────────────────────────────────
//
// A wall-clock budget is a DIFFERENT NUMBER OF FRAMES ON EVERY RENDERER, so it
// is not one assertion — it is a different assertion per machine. Measured in
// this repo: 7.9 fps under `E2E_SWIFTSHADER=1` against ~60 fps on a real GPU,
// and CI runs ten shards in parallel on top of that. `waitForTimeout(60)` is
// "about four frames" locally and "about half a frame" on CI: the same source
// line, two incompatible claims. `waitFrames(page, 4)` is four frames on both.
//
// ── why ONE page.evaluate for the whole wait ───────────────────────────────
//
// The obvious implementation — a loop that evaluates once per frame — is one
// CDP round trip per frame, on the SAME main thread it is waiting for. On a
// loaded runner that costs several times what it measures, and CLAUDE.md's
// instrument rule names this exact shape ("never sample a page-side quantity
// with a Playwright-side poll loop"). The rAF chain below runs entirely in the
// page; Playwright waits on one promise.
//
// ── when NOT to use this ───────────────────────────────────────────────────
//
// If what you are waiting for is OBSERVABLE — a value in the store, a class on
// an element, text in a status line — wait on THAT with an auto-retrying
// `expect` or `expect.poll`. A frame count is the right tool when the thing you
// need is "the render/poll loop has run", which is genuinely a count of frames
// and nothing else: a negative assertion ("this must NOT change"), or a stimulus
// that only an rAF-driven reader can observe.

import type { Page } from '@playwright/test';

/**
 * Wait `n` ANIMATION FRAMES, counted inside the page.
 *
 * ⚠ A backgrounded or fully occluded page throttles rAF hard, and a page with
 * no compositor work at all may not schedule frames on a timer you would
 * recognise. This resolves when the page has painted `n` times, whenever that
 * is — which is the point — so pair it with the test's own timeout rather than
 * a wall-clock cap of its own.
 */
export async function waitFrames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = (): void => {
          if (--left <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/**
 * Two rAFs — long enough for a state change to be applied AND painted.
 *
 * Two rather than one because Svelte flushes its DOM updates in a microtask
 * that can land after the current frame's callback has already run: frame 1
 * schedules, frame 2 shows. This is the smallest honest "it is on screen now".
 */
export async function settle(page: Page): Promise<void> {
  await waitFrames(page, 2);
}
