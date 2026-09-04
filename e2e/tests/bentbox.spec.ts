// e2e/tests/bentbox.spec.ts
//
// BENTBOX — CRT-emulation video OUTPUT. Three concerns:
//   t1 = DETERMINISTIC render-smoke (DRS): the GL CRT pipeline decodes a
//        NON-BLACK, structured, FRAME-STABLE frame (the real pixel gate).
//   t2 = CV-bending knobs round-trip through the patch store (non-render).
//   t3 = the resize handle drag actually grows the card (non-render DOM).
//
// t1 was previously a `spawn → waitForTimeout(250) → no-console-errors` smoke
// with NO pixel assertion. It is now a real DRS: pause the engine rAF loop +
// pin the engine clock AND bentbox's own performance.now()-based noise/drift
// clock (`__bentboxFreezeTime`, a flag-gated test seam in bentbox.ts), drive
// engine.step() a FIXED number of frames synchronously, and read BENTBOX's OWN
// out FBO once via the shared _render-smoke harness. With feedback_gain=0,
// noise=0 and the clock frozen, the only per-frame variation is the field-parity
// toggle (framesElapsed & 1), which returns to the same state across an
// EVEN-count burst → the frozen frame is frame-stable. We assert pixel
// STATISTICS (non-black + spatial structure + a second-burst stability check),
// not pixel-exact content — the module is VRT-exempt (animated by design).
//
// t2/t3 are NON-render (store round-trip / DOM drag): their old waitForTimeout
// settle-waits are replaced with proper deterministic waits (expect.poll on the
// observable state), NOT a render assertion. Goal: 0 waitForTimeout in the file.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

// EVEN count so the field-parity toggle (framesElapsed & 1) returns to the same
// state across a burst → the two bursts read the same frozen parity. 8 is well
// past the feedback ping-pong warm-up to steady state.
const FIXED_STEPS = 8;

/** Pin BOTH clocks before boot: the engine rAF/clock (installRenderSmokeHooks)
 *  AND bentbox's own performance.now()-based noise/drift clock. Must run before
 *  page.goto. */
async function freezeBentbox(page: import('@playwright/test').Page): Promise<void> {
  await installRenderSmokeHooks(page);
  await page.addInitScript(() => {
    (window as unknown as { __bentboxFreezeTime?: number }).__bentboxFreezeTime = 2.0;
  });
}

test.describe('BENTBOX — CRT-emulation output', () => {
  test('spawns + canvas mounts + decodes a non-black, frame-stable frame', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await freezeBentbox(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // Spawn a SHAPES source feeding into BENTBOX so the bending pipeline has
    // real input to chew on. feedback_gain=0 + noise=0 → with the clocks frozen
    // the only per-frame variation is the field-parity toggle (stable across an
    // even-count burst) → a bit-stable frozen frame.
    await spawnPatch(
      page,
      [
        { id: 'shapes', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        { id: 'bb',     type: 'bentbox', position: { x: 500, y: 100 }, domain: 'video', params: { feedback_gain: 0, noise: 0 } },
      ],
      [
        {
          id: 'e-shapes-bb',
          from: { nodeId: 'shapes', portId: 'out' },
          to: { nodeId: 'bb', portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    // Presence on the default shell: the faceplate tile (the CRT preview is
    // dock-only `fullViewBody`; the FBO reads below are the real pixel gate).
    await expect(
      page.locator('.svelte-flow__node[data-id="bb"] [data-testid="module-shell"]'),
      'BENTBOX faceplate visible',
    ).toBeVisible();

    // Drive a FIXED burst synchronously, read BENTBOX's OWN out FBO once.
    // The CRT-decoded frame is non-black with spatial structure (the
    // encode→bend→decode→CRT path produced an image).
    const a = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (both clocks frozen, even-count
    // burst → same field parity) is frame-stable — the property the old
    // waitForTimeout(250)+no-pixel-read smoke lacked.
    const b = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen CRT output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen CRT output variance is frame-stable').toBeLessThan(1.0);

  });

  test('CV-bending knobs mutate params via patch store', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'bb', type: 'bentbox', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('.svelte-flow__node[data-id="bb"] [data-testid="module-shell"]')).toHaveCount(1);

    // Drive a bending knob via direct patch-store mutation (the same path
    // CV inputs use after the engine bridge writes through). Sweeping
    // hsync_drift + wavefold is what produces the canonical AVEmod look.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['bb'];
        if (!n) return;
        n.params.hsync_drift = 0.4;
        n.params.wavefold    = 0.6;
        n.params.feedback_gain = 0.5;
      });
    });

    // Deterministic wait: poll the store until the mutation has committed
    // through the Y.Doc transaction (replaces the old waitForTimeout(120)
    // settle). expect.poll re-reads until the values land or it times out.
    await expect.poll(() => page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['bb'];
      return n ? `${n.params.hsync_drift},${n.params.wavefold},${n.params.feedback_gain}` : '';
    }), 'bending knobs committed to the patch store').toBe('0.4,0.6,0.5');

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['bb'];
      return {
        hsync_drift: n?.params.hsync_drift,
        wavefold: n?.params.wavefold,
        feedback_gain: n?.params.feedback_gain,
      };
    });

    expect(params.hsync_drift).toBe(0.4);
    expect(params.wavefold).toBe(0.6);
    expect(params.feedback_gain).toBe(0.5);
  });

  test('resize handle is present + drag grows the preview (and persists the size)', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'bb', type: 'bentbox', position: { x: 200, y: 100 }, domain: 'video' },
    ]);

    // The face handle lives in the dock pane (`fullViewBody`) and sizes the
    // PREVIEW there, writing the SAME `data.width`/`data.height` keys the
    // card's node-resize wrote — one persisted truth per idea.
    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
        'function',
      undefined,
      { timeout: 30_000 },
    );
    await page.evaluate(
      (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
      'bb',
    );
    const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="bb"]');
    await expect(pane.getByTestId('bentbox-output-body')).toBeVisible({ timeout: 60_000 });

    const preview = pane.getByTestId('bentbox-face-canvas');
    const handle = pane.getByTestId('bentbox-face-resize-handle');
    await expect(preview).toHaveCount(1);
    await expect(handle, 'resize handle present').toHaveCount(1);

    const initial = await preview.evaluate(
      (el) => (el as HTMLElement).getBoundingClientRect(),
    );

    // hover() auto-scrolls the pane so the handle is truly under the pointer
    // (a boundingBox taken while it sits below the pane fold hands the drag to
    // whatever is painted at those screen coordinates instead).
    await handle.hover();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 100, sy + 80, { steps: 5 });
    await page.mouse.move(sx + 200, sy + 160, { steps: 5 });
    await page.mouse.up();

    // Deterministic wait: poll the persisted truth both surfaces share — the
    // drag writes `data.width`/`data.height` per pointermove (the pane's
    // `max-width:100%` can CLAMP the painted wrap, so the store is the honest
    // observable; the visual check below allows the clamp).
    const readPersisted = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: { width?: number; height?: number } }> };
        };
        const d = w.__patch.nodes['bb']?.data ?? {};
        return { width: d.width ?? 0, height: d.height ?? 0 };
      });
    await expect.poll(
      async () => (await readPersisted()).width,
      'data.width grew after the resize drag',
    ).toBeGreaterThan(initial.width + 20);
    const persisted = await readPersisted();
    expect(persisted.height, `data.height persisted (${persisted.height})`).toBeGreaterThan(360);

    // The painted preview tracks data.width up to the pane's own width.
    const paneWidth = await pane.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    const painted = await preview.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    expect(
      painted,
      `preview painted at data.width or the pane clamp (painted=${painted} pane=${paneWidth})`,
    ).toBeGreaterThanOrEqual(Math.min(persisted.width, paneWidth) - 40);
  });
});
