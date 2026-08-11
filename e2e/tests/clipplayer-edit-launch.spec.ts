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

test.describe.configure({ mode: 'parallel' });

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

/** Margin (screen px) to leave around the editor when framing it. */
const FIT_MARGIN_PX = 24;

/**
 * Zoom the canvas out until the WHOLE editor fits the flow pane.
 *
 * ── WHY THIS EXISTS (root-caused 2026-08-08) ─────────────────────────────────
 * Without it this spec depends on Playwright's scroll-into-view rescuing a
 * control far below the fold, and that is luck, not a test. Measured on the
 * default 1280×720 viewport with a SINGLE spawned node:
 *
 *     xyflow zoom      0.981   (fitView barely zooms out for one node)
 *     editor rect      top 230 → bottom 1189   (959 px tall)
 *     edit-now button  top 1169 → bottom 1189
 *
 * The button sits **449 px below a 720 px viewport**. It passed on CI only
 * because the click's implicit scroll sometimes reached it, and failed 10/10
 * locally where it does not. `locator.click` then burns the FULL 30 s test
 * timeout retrying — alternating "element is outside of the viewport" with
 * piano-roll cells "intercept pointer events" — so the symptom is an opaque
 * timeout that reads like a hang or a crash rather than a layout problem.
 *
 * ⚠ A BIGGER VIEWPORT MAKES IT WORSE. `fitView` zooms IN to frame a single
 * node, so at 1280×1400 the zoom goes to **scale(2)** (xyflow maxZoom), the
 * editor becomes 1955 px tall and the button lands at y 2337. The lever is the
 * ZOOM, not the viewport.
 *
 * ⚠ AND `spawnPatch`'s own `revealWorkflowNodes` cannot help: its early-return
 * is `centre on screen && zoom >= 0.4`, a property of the node's CENTRE and so
 * blind to its HEIGHT. A 959 px card whose middle is comfortably visible passes
 * that check while its bottom row of controls is unreachable. Generalising that
 * check is the real repair for this class, but it is a SHARED helper on every
 * `spawnPatch` caller and is not being changed from inside a spec fix.
 *
 * ⚠ COORDINATE FRAMES — the trap this helper itself fell into first.
 * `getBoundingClientRect()` is WINDOW-relative; xyflow's `getViewport()` x/y is
 * relative to the FLOW PANE, which sits below the app chrome. Mixing them put
 * the editor 24 px lower than asked (bottom 720.3 in a 720 px viewport — a
 * sub-pixel overflow that still fails). Everything here is therefore computed
 * in PANE-relative screen px and converted explicitly.
 */
async function fitEditorInViewport(page: import('@playwright/test').Page) {
  const fit = await page.evaluate((margin) => {
    const w = globalThis as unknown as {
      __flow?: {
        getViewport?: () => { x: number; y: number; zoom: number };
        setViewport?: (vp: { x: number; y: number; zoom: number }) => void;
      };
    };
    const flow = w.__flow;
    const ed = document.querySelector('[data-testid="clipplayer-editor"]');
    const pane = document.querySelector('.svelte-flow');
    if (!flow?.getViewport || !flow.setViewport || !ed || !pane) return null;
    const vp = flow.getViewport();
    const r = ed.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    // WINDOW-relative rect → PANE-relative → flow space.
    const flowLeft = (r.left - p.left - vp.x) / vp.zoom;
    const flowTop = (r.top - p.top - vp.y) / vp.zoom;
    const scale = Math.min(
      1,
      (p.height - 2 * margin) / r.height,
      (p.width - 2 * margin) / r.width,
    );
    const zoom = vp.zoom * scale;
    // Anchor the editor's top-left at (margin, margin) PANE-relative.
    flow.setViewport({ x: margin - flowLeft * zoom, y: margin - flowTop * zoom, zoom });
    return { zoom, editorH: Math.round(r.height), paneH: Math.round(p.height) };
  }, FIT_MARGIN_PX);
  expect(fit, '__flow bridge missing — cannot frame the editor deterministically').not.toBeNull();
  return fit!;
}

/**
 * Frame the editor and KEEP framing it until it actually fits.
 *
 * One pass is not enough: the fit is computed from the editor's height at that
 * instant, and the piano roll can still be laying out, so a single-shot fit
 * under-zooms whenever the card grows after it was measured. Re-measuring until
 * the rect stops exceeding the pane converges in one or two passes and is
 * bounded — the alternative is a fit that is correct on average, which is how
 * this spec got here in the first place.
 */
async function frameEditorUntilItFits(page: import('@playwright/test').Page) {
  await expect(async () => {
    await fitEditorInViewport(page);
    const over = await page.evaluate(() => {
      const ed = document.querySelector('[data-testid="clipplayer-editor"]')!.getBoundingClientRect();
      const pane = document.querySelector('.svelte-flow')!.getBoundingClientRect();
      return Math.ceil(ed.bottom - pane.bottom);
    });
    expect(over, `editor still overflows the flow pane by ${over} screen px after re-fitting`)
      .toBeLessThanOrEqual(0);
  }).toPass({ timeout: 10_000 });
}

/**
 * Click a launch button, having FIRST proved it is on screen.
 *
 * The assertion is the point: if the editor ever grows past what the canvas can
 * zoom out to (xyflow clamps at minZoom), this fails in milliseconds saying how
 * far off-screen the control is — instead of a 30 s `locator.click` timeout
 * that reads like a hang. `toPass` absorbs the frame the viewport transform
 * needs to apply, without ever accepting an off-screen control.
 */
async function clickLaunch(page: import('@playwright/test').Page, testId: string) {
  const viewportH = page.viewportSize()?.height ?? 0;
  await expect(async () => {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${testId} has no bounding box`).not.toBeNull();
    expect(
      Math.ceil(box!.y + box!.height),
      `${testId} bottom is ${Math.ceil(box!.y + box!.height)} but the viewport is `
      + `${viewportH} (units: SCREEN px, post-xyflow-zoom, window-relative). The editor `
      + 'no longer fits at a reachable zoom — see fitEditorInViewport.',
    ).toBeLessThanOrEqual(viewportH);
  }).toPass({ timeout: 5000 });
  await page.getByTestId(testId).click();
}

/** Spawn a clipplayer and open the editor on lane 0 / slot 0. */
async function openEditorLane0(page: import('@playwright/test').Page) {
  await page.goto('/rack?shell=legacy&seed=none');
  await spawnPatch(page, [{ id: 'cp1', type: 'clipplayer', domain: 'audio', x: 200, y: 120 }]);
  const card = page.getByTestId('clipplayer-card').first();
  await card.waitFor({ state: 'visible' });
  await card.locator('.pad').first().dblclick(); // → edit view, lane 0 / slot 0
  await page.getByTestId('clipplayer-editor').waitFor({ state: 'visible' });
  // Confirm we're editing L1·S1 so the assertion targets lane 0.
  await expect(page.getByTestId('clipplayer-editor').locator('.sel')).toHaveText('L1·S1');
  await frameEditorUntilItFits(page);
  return card;
}

test('@clipplayer edit-view NOW launches the edited clip', async ({ page }) => {
  await openEditorLane0(page);
  await clickLaunch(page, 'clipplayer-edit-now');
  const r = await waitLane0Playing(page, 0, 8000);
  expect(r.ok, `lane 0 never reached the edited clip. seen=[${r.seen.join(', ')}] `
    + `samples=${r.samples} elapsedMs=${r.elapsedMs}`).toBe(true);
});

test('@clipplayer edit-view QUEUE launches the edited clip', async ({ page }) => {
  await openEditorLane0(page);
  await clickLaunch(page, 'clipplayer-edit-queue');
  const r = await waitLane0Playing(page, 0, 8000);
  expect(r.ok, `lane 0 never reached the edited clip. seen=[${r.seen.join(', ')}] `
    + `samples=${r.samples} elapsedMs=${r.elapsedMs}`).toBe(true);
});
