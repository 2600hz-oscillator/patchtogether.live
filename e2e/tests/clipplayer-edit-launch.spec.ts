// e2e/tests/clipplayer-edit-launch.spec.ts
//
// The clip EDIT view can launch the clip you're editing without going back to
// the session grid: NOW (immediate, ignores QNT) + QUEUE (next loop boundary,
// follows QNT). Both target the edited clip's own lane+slot. We assert the
// STABLE observable — the edited clip ends up in the lane's synced `playing`
// set — rather than the transient `queued`/`queuedImmediate` flags the engine
// consumes on the next tick (those race the poll). The NOW-vs-QUEUE timing
// distinction is an engine detail covered by the engine; here we prove the
// editor buttons actually start the clip you're editing.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ── THE TEST BUDGET IS THIS SPEC'S REAL BOUND, AND IT WAS FLAT (#1904) ──────
//
// The poll below was already fixed to accumulate INSIDE the page (see the note
// on `waitLane0Playing`), and this spec still recovered a flake on 9 of the 31
// completed `ci.yml` runs in the window to 2026-08-19 — the single most flaky
// test in the suite. Read off the blob reports, every occurrence is
// `timedOut -> passed` ON THE SAME SHA, failing in two different places:
//
//   Test timeout of 30000ms exceeded.
//     - waiting for getByTestId('clipplayer-editor') to be visible
//     - waiting for getByTestId('clipplayer-edit-now')
//
// Two different subjects timing out means the test did not hang on either one
// — it ran out of BUDGET. Playwright's default per-test timeout is 30 s and
// this suite does not override it, so for any wait that carries no timeout of
// its own the 30 s test budget IS the bound, and a flat bound on a runner that
// swings >=2x is a lottery (#1860).
//
// Scaling it is a bound change, not an assertion change: nothing here claims
// how long the editor takes to open, and the wait exits the instant it does.
// Cost regressions are no longer gated (the budget wrapper was deleted); a
// measurement of the lane rather than of one test.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/**
 * Wait for lane 0 of the clipplayer's synced `playing` set to reach `expected`,
 * sampling INSIDE the page.
 *
 * ── WHY NOT `expect.poll(() => page.evaluate(read))` ─────────────────────────
 * That is one `page.evaluate` round-trip per sample, on the SAME main thread as
 * the thing it measures — so a loaded runner starves the subject and the
 * sampler together (CLAUDE.md, "never sample a page-side quantity with a
 * Playwright-side poll loop"). It is also how this spec actually died on CI:
 * the failure was `page.evaluate: Target page, context or browser has been
 * closed` raised from inside the poll, having burnt the whole 30 s TEST timeout
 * rather than the 5 s poll budget — because a poll timeout cannot interrupt a
 * single evaluate that never comes back.
 *
 * One round trip, a page-side `setInterval` finer than the engine tick, and the
 * accumulated values SURVIVE a stall — so a thread that freezes for 3 s and
 * then runs still reports everything it computed. `samples`/`elapsedMs`/`seen`
 * are returned so a red run is diagnosable instead of a coin flip: "never
 * became 0" and "never looked" are then distinguishable, which they are not
 * from a bare poll timeout.
 */
async function waitLane0Playing(
  page: import('@playwright/test').Page,
  expected: number,
  timeoutMs: number,
) {
  return page.evaluate(
    ({ want, budget }) => new Promise<{
      ok: boolean; seen: string[]; samples: number; elapsedMs: number;
    }>((resolve) => {
      const read = () => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> };
        };
        const nodes = w.__patch?.nodes;
        if (!nodes) return '<no __patch>';
        const cp = Object.values(nodes).find((n) => n.type === 'clipplayer');
        if (!cp) return '<no clipplayer>';
        return String(cp.data?.playing?.[0]);
      };
      const seen = new Set<string>();
      let samples = 0;
      const t0 = performance.now();
      const done = (ok: boolean) => {
        clearInterval(id);
        resolve({ ok, seen: [...seen], samples, elapsedMs: Math.round(performance.now() - t0) });
      };
      const tick = () => {
        samples++;
        const v = read();
        seen.add(v);
        if (v === String(want)) done(true);
        else if (performance.now() - t0 > budget) done(false);
      };
      const id = setInterval(tick, 25);
      tick();
    }),
    { want: expected, budget: timeoutMs },
  );
}

/** Spawn a clipplayer and open its dock pane with lane 0 / slot 0 selected.
 *
 *  ── DEFAULT-SHELL RE-POINT (S2) ──────────────────────────────────────────
 *  The card-era flow (dblclick a lane pad on the CARD → a 959 px editor view
 *  in xyflow space) needed a whole viewport-fitting apparatus
 *  (fitEditorInViewport / frameEditorUntilItFits / clickLaunch — root-caused
 *  2026-08-08) because the launch buttons sat hundreds of px below the fold
 *  at fitView zoom. The face editor band lives in the DOCK PANE — no xyflow
 *  transform, normal scrolling — so that machinery died with the card and a
 *  plain scrollIntoViewIfNeeded is the whole story.
 *
 *  Selection: double-clicking face pad 0 creates lane 0 / slot 0's clip and
 *  selects it for the editor band (the face-clipplayer recipe); the clip's
 *  presence under key '0' is the selection proof (the card's `.sel` L1·S1
 *  label died with it). */
async function openEditorLane0(page: import('@playwright/test').Page) {
  await page.goto('/rack?seed=none');
  await spawnPatch(page, [{ id: 'cp1', type: 'clipplayer', domain: 'audio', position: { x: 200, y: 120 } }]);
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    'cp1',
  );
  const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="cp1"]');
  await expect(pane.getByTestId('clipplayer-face-editor')).toBeVisible({ timeout: 60_000 });
  await pane.getByTestId('clipplayer-pad-0').dblclick();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { type?: string; data?: { clips?: Record<string, unknown> } }> };
          };
          const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
          return Object.keys(cp?.data?.clips ?? {});
        }),
      { message: "double-clicking face pad 0 creates lane 0 / slot 0's clip" },
    )
    .toContain('0');
  return pane;
}

async function clickLaunch(pane: import('@playwright/test').Locator, testId: string) {
  const btn = pane.getByTestId(testId);
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
}

test('@clipplayer edit-view NOW launches the edited clip', async ({ page }) => {
  const pane = await openEditorLane0(page);
  await clickLaunch(pane, 'clipplayer-edit-now');
  const r = await waitLane0Playing(page, 0, 8000);
  expect(r.ok, `lane 0 never reached the edited clip. seen=[${r.seen.join(', ')}] `
    + `samples=${r.samples} elapsedMs=${r.elapsedMs}`).toBe(true);
});

test('@clipplayer edit-view QUEUE launches the edited clip', async ({ page }) => {
  const pane = await openEditorLane0(page);
  await clickLaunch(pane, 'clipplayer-edit-queue');
  const r = await waitLane0Playing(page, 0, 8000);
  expect(r.ok, `lane 0 never reached the edited clip. seen=[${r.seen.join(', ')}] `
    + `samples=${r.samples} elapsedMs=${r.elapsedMs}`).toBe(true);
});
