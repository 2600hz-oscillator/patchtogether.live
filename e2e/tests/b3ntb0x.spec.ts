// e2e/tests/b3ntb0x.spec.ts
//
// B3NTB0X — circuit-level NTSC composite re-arch OUTPUT. Real-GL coverage
// (jsdom can't exercise WebGL, so the 4-pass float pipeline is only verifiable
// in a browser): spawn a SHAPES source → B3NTB0X, confirm the card + canvas
// mount, the pipeline decodes a NON-BLACK structured frame, and turning up Sync
// Crush / Enhance VISIBLY changes the output (the Phase-1 proof point).
//
// DETERMINISTIC render-smoke (DRS): the old version did `spawn →
// waitForTimeout(600) → read the on-card 2D canvas` (test 1) and TWO full
// goto+spawn captures with waitForTimeout(500) each (test 2) — three
// un-synchronized clocks (headless rAF throttling, the module's own
// performance.now() subcarrier drift, the card blit cadence). Now: pause the
// engine rAF loop + pin the engine clock AND b3ntb0x's own subcarrier clock
// (`__b3ntb0xFreezeTimeSec`, a flag-gated test seam in b3ntb0x.ts), drive
// engine.step() a FIXED number of frames synchronously, and read B3NTB0X's OWN
// CRT-front FBO once via the shared _render-smoke harness. No waitForTimeout, no
// poll, no animation-diff. With tbc=1, feedback=0, sub_drift=0 the ONLY animation
// source is uTime (frozen) + framesElapsed (a pure function of step count), so the
// frozen frame is bit-stable.
//
// We assert pixel STATISTICS (non-black + spatial structure + a frozen
// clean-vs-bent difference), not pixel-exact content — the module is VRT-exempt.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 8; // 4-pass pipeline + ping-pong: 8 is well past warm to steady state.

/** Pin BOTH clocks before boot: the engine rAF/clock (installRenderSmokeHooks)
 *  AND b3ntb0x's own performance.now()-based subcarrier-drift clock. */
async function freezeB3ntb0x(page: import('@playwright/test').Page): Promise<void> {
  await installRenderSmokeHooks(page);
  await page.addInitScript(() => {
    (window as unknown as { __b3ntb0xFreezeTimeSec?: number }).__b3ntb0xFreezeTimeSec = 2.0;
  });
}

test.describe('B3NTB0X — NTSC composite re-arch output', () => {
  test('spawns + canvas mounts + decodes a non-black, frame-stable frame', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await freezeB3ntb0x(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        // tbc=1 (rock-steady), feedback=0, sub_drift=0 → no intra-pipeline
        // animation source other than uTime (frozen) → bit-stable frozen frame.
        { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video', params: { tbc: 1, feedback: 0, sub_drift: 0 } },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-b3ntb0x'), 'B3NTB0X node visible').toBeVisible();
    await expect(page.locator('[data-testid="b3ntb0x-card"]'), 'card present').toHaveCount(1);
    await expect(page.locator('[data-testid="b3ntb0x-canvas"]'), 'canvas mounted').toHaveCount(1);

    // Drive a FIXED burst synchronously, read B3NTB0X's OWN CRT-front FBO once.
    // The decoded NTSC frame is non-black with spatial structure (the
    // encode→bend→decode→CRT path produced an image).
    const a = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (both clocks frozen) is frame-stable
    // — the property the old waitForTimeout(600)+one-shot canvas read lacked.
    const b = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen CRT output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen CRT output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during B3NTB0X render').toEqual([]);
  });

  test('Sync Crush + Enhance visibly change the decoded output (the bend proof point)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await freezeB3ntb0x(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ONE page-load (was two full goto+spawn captures): spawn CLEAN, read a
    // frozen burst, then setParam the BEND and read a second frozen burst. Both
    // reads are at frozen-clock steady state, so the difference is the BEND, not
    // sync jitter or rAF cadence.
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video',
          params: { sync_crush: 1.0, enhance: 0.0, bias: 0.0, chroma_leak: 0.0, tbc: 1, feedback: 0, sub_drift: 0 } },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    await expect(page.locator('[data-testid="b3ntb0x-canvas"]')).toHaveCount(1);

    const clean = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    assertRenderStats(clean, FIXED_STEPS);

    // Heavy bend: high gain into the clip (Sync Crush) + HF peaking (Enhance) +
    // DC bias + chroma leak — a real composite path mangles the demodulated frame.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __engine?: () => { getDomain?: (d: string) => { setParam?: (id: string, p: string, v: number) => void } | null } | null };
      const vid = w.__engine?.()?.getDomain?.('video');
      vid?.setParam?.('bb', 'sync_crush', 1.9);
      vid?.setParam?.('bb', 'enhance', 0.9);
      vid?.setParam?.('bb', 'bias', 0.3);
      vid?.setParam?.('bb', 'chroma_leak', 0.8);
    });

    const bent = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    expect(bent.framesDelta, 'bent burst advanced the exact frame count').toBe(FIXED_STEPS);

    // The bend shifts DC bias + contrast (crush) + colour (chroma leak), all of
    // which move the aggregate luma stats (NOT a frequency-only change), so the
    // two FROZEN reads differ by a renderer-tolerant margin. Identical frozen
    // frames would diff ≈0.
    const meanDelta = Math.abs(bent.mean - clean.mean);
    const varDelta = Math.abs(bent.variance - clean.variance);
    const nzDelta = Math.abs(bent.nonZeroFrac - clean.nonZeroFrac);
    expect(
      meanDelta > 2 || varDelta > 5 || nzDelta > 0.02,
      `bent output differs from clean (Δmean=${meanDelta.toFixed(2)} Δvar=${varDelta.toFixed(2)} Δnz=${nzDelta.toFixed(3)})`,
    ).toBe(true);

    expect(errors, 'no console / page errors during B3NTB0X bend').toEqual([]);
  });

  // NOTE (Phase 2 lean): the old test 3 ("CV-bending knobs mutate params") was a
  // pure store round-trip → DOWNGRADED to b3ntb0x.test.ts. t1 (structured
  // non-black decode) + t2 (bend-mangles-output) stay here as the ONLY GL pixel
  // gates for this VRT-exempt + per-port-exempt module (plan §1/§6).
});
