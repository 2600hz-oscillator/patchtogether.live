// e2e/tests/toybox-video-input.spec.ts
//
// Dedicated behavioral coverage for TOYBOX's per-layer VIDEO inputs (P2).
//
// The generic per-port behavioral sweep exempts toybox.layer<i>_in because a
// layer input is sampled ONLY when that layer's `kind` is 'video' (a data-side
// flag the sweep can't seed). This spec supplies that: it sets layer 0's kind
// to 'video', wires a self-running video source (ACIDWARP) into layer0_in, and
// asserts:
//   1. the TOYBOX output preview shows non-black content (the input flowed
//      through to the output), and
//   2. it DIFFERS from the off-control (layer 0 = 'off', no input) — proving
//      the layer input genuinely perturbs the output.
//
// Reads the live card preview canvas (toybox-canvas) — the same surface the
// VRT freezes — averaged over a few rAF frames so ACIDWARP's animation is
// captured regardless of phase.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Mean per-channel brightness of the toybox preview canvas, plus a coarse
 *  16-bucket luma histogram signature (so two clearly-different frames produce
 *  different signatures even at similar mean brightness). */
async function sampleCanvas(page: Page): Promise<{ mean: number; sig: number[] } | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-testid="toybox-canvas"]',
    ) as HTMLCanvasElement | null;
    if (!canvas) return null;
    const c2d = canvas.getContext('2d');
    if (!c2d) return null;
    const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    const sig = new Array(16).fill(0) as number[];
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114);
      sum += luma;
      sig[Math.min(15, Math.floor(luma / 16))]!++;
      n++;
    }
    return { mean: n ? sum / n : 0, sig };
  });
}

/** Settle a few rAF frames so the live (non-frozen) preview is painted. */
async function settleFrames(page: Page, n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
}

/** Set TOYBOX layer 0's kind (+ optional contentId) on the live node. */
async function setLayer0Kind(page: Page, kind: string): Promise<void> {
  await page.evaluate(
    ({ kind }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind, contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
      });
    },
    { kind },
  );
}

test.describe('TOYBOX: per-layer video input flows to output', () => {
  test('layer0_in (kind=video) drives the output, distinct from off-control', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // TOYBOX + a self-running video source (ACIDWARP), wired into layer0_in.
    await spawnPatch(
      page,
      [
        { id: 'tb', type: 'toybox', position: { x: 360, y: 40 }, domain: 'video' },
        { id: 'src', type: 'acidwarp', position: { x: 60, y: 40 }, domain: 'video' },
      ],
      [
        {
          id: 'e-src-tb',
          from: { nodeId: 'src', portId: 'out' },
          to: { nodeId: 'tb', portId: 'layer0_in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });

    // ── CONTROL: layer 0 = 'off' (no input sampled) → output is black. ──
    await setLayer0Kind(page, 'off');
    await settleFrames(page);
    const control = await sampleCanvas(page);
    expect(control, 'control sample read').not.toBeNull();
    // Off layer 0 with everything else off → the backwards-compat short-circuit
    // renders layer 0 straight, which is black → near-zero mean brightness.
    expect(control!.mean, 'off-control output is (near) black').toBeLessThan(8);

    // ── PATCHED: layer 0 = 'video' → samples layer0_in (ACIDWARP). ──
    await setLayer0Kind(page, 'video');
    await settleFrames(page);
    const patched = await sampleCanvas(page);
    expect(patched, 'patched sample read').not.toBeNull();

    // 1) The video input flowed through → output is now non-black.
    expect(patched!.mean, 'video-fed output is non-black').toBeGreaterThan(12);

    // 2) The histogram signature differs from the off-control (the input
    //    genuinely perturbed the output, not just a uniform fill).
    let sigDelta = 0;
    for (let i = 0; i < 16; i++) sigDelta += Math.abs(patched!.sig[i]! - control!.sig[i]!);
    expect(sigDelta, 'output luma distribution changed vs off-control').toBeGreaterThan(0);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
