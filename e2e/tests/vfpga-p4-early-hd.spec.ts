// e2e/tests/vfpga-p4-early-hd.spec.ts
//
// vfpga P4 — the EARLY-HD-era bent VFPGA catalog (macroblock-mosh, tmds-sparkle,
// scaler-glitch), end-to-end on a REAL WebGL2 context. Each bent program needs a
// video source, so the patch is:
//
//   src (vfpga-runner = smpte-bars) → bent (vfpga-runner = <program>) → OUTPUT
//
// We select the bent program from its card's "load preset…" menu (the production
// hot-swap path), then assert the OUTPUT canvas is (a) NON-BLACK with spatial
// STRUCTURE (the bent picture reaches downstream — a renderer-tolerant floor, NOT
// exact pixels: CI runs SwiftShader) AND (b) DISTINCT from the same source passed
// straight through (the un-bent reference), proving the bend actually transforms the
// picture rather than just compiling. Renderer-tolerant throughout (structure + a
// coarse distinctness delta, not pixel equality). The bends are SEEDED-deterministic,
// but vfpga-runner is VRT-exempt (live preview + scopes), so this asserts behaviour,
// not a baseline. Mirrors the P3 composite spec.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const BENT = ['macroblock-mosh', 'tmds-sparkle', 'scaler-glitch'] as const;

/** OUTPUT canvas pixel stats (mean luma, non-black fraction, spatial variance). */
async function outputStats(page: Page): Promise<{ mean: number; nonZeroFrac: number; variance: number } | null> {
  const canvas = page.locator('[data-testid="video-out-canvas"]');
  await expect(canvas, 'video-out canvas mounted').toHaveCount(1);
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return { mean, nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean };
  });
}

/** A subsampled greyscale fingerprint of the OUTPUT (one luma byte per 64 bytes) —
 *  a renderer-tolerant SPATIAL signature; position-sensitive, so a geometric bend
 *  (mosh smear / scaler stretch / char-slip) that rearranges pixels reads DISTINCT. */
async function outputFingerprint(page: Page): Promise<number[] | null> {
  const canvas = page.locator('[data-testid="video-out-canvas"]');
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const out: number[] = [];
    for (let i = 0; i < data.length; i += 64) {
      out.push((data[i]! + data[i + 1]! + data[i + 2]!) / 3);
    }
    return out;
  });
}

/** Mean absolute per-sample difference of two fingerprints (0 = identical), 0..255. */
function fpDelta(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i]! - b[i]!);
  return d / n;
}

/** Set a node's loaded VFPGA via its card preset menu + wait for the loaded readout. */
async function loadPreset(page: Page, nodeId: string, vfpga: string, name: string): Promise<void> {
  const sel = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="vfpga-preset"]`);
  await expect(sel, `preset menu for ${nodeId}`).toHaveCount(1);
  await sel.selectOption(vfpga);
  await expect(page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="vfpga-loaded"]`)).toHaveText(name);
}

async function pollStats(page: Page): Promise<{ mean: number; nonZeroFrac: number; variance: number }> {
  let stats = await outputStats(page);
  for (let i = 0; i < 50 && (!stats || stats.nonZeroFrac <= 0.05); i++) {
    await page.waitForTimeout(150);
    stats = await outputStats(page);
  }
  expect(stats, 'OUTPUT canvas readable + non-black').not.toBeNull();
  return stats!;
}

test.describe('vfpga P4 early-HD-era bent VFPGAs', () => {
  for (const program of BENT) {
    test(`${program}: bends the smpte source into distinct non-black output`, async ({ page }) => {
      // Two pure-GL vfpga-runners + an OUTPUT compile fast even on SwiftShader,
      // but give headroom for boot + spawn + first-frame settle + the hot-swap.
      test.setTimeout(60_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await spawnPatch(
        page,
        [
          { id: 'src', type: 'vfpgaRunner', position: { x: 60, y: 80 }, domain: 'video' },
          { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
          { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
        ],
        [
          { id: 'e1', from: { nodeId: 'src', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
          { id: 'e2', from: { nodeId: 'bent', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        ],
        { mountTimeout: 15_000 },
      );

      await expect(page.locator('.svelte-flow__node-vfpgaRunner')).toHaveCount(2);
      await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);

      // Reference render: `bent` = smpte-bars (its own generated bars == a passthru
      // of the src smpte bars at the same settings). Capture that, then swap to the
      // bent program and require the spatial fingerprint to DIFFER.
      await loadPreset(page, 'bent', 'smpte-bars', 'SMPTE bars');
      await pollStats(page);
      await page.waitForTimeout(300); // settle a couple frames so the reference is stable
      const refFp = await outputFingerprint(page);
      expect(refFp, 'reference fingerprint').not.toBeNull();

      // Now load the BENT program and assert structure + distinctness.
      await loadPreset(page, 'bent', program, program);
      const stats = await pollStats(page);

      // (a) STRUCTURE FLOOR: the bent picture reaches OUTPUT with spatial detail.
      expect(stats.nonZeroFrac, `${program}: bent output is non-black (frac=${stats.nonZeroFrac})`).toBeGreaterThan(0.1);
      expect(stats.variance, `${program}: bent output has spatial structure (var=${stats.variance})`).toBeGreaterThan(20);

      // (b) DISTINCTNESS: the bend transformed the picture (the OUTPUT spatial
      // fingerprint differs meaningfully from the un-bent reference). Δluma > 6/255
      // is well above renderer noise but easily met by any bend. mosh is a feedback
      // loop (the reference accumulates over frames) and the scaler/tmds animate, so
      // poll a few frames to let the bend settle off the reference frame.
      let bentFp = await outputFingerprint(page);
      let delta = bentFp ? fpDelta(refFp!, bentFp) : 0;
      for (let i = 0; i < 30 && delta < 6; i++) {
        await page.waitForTimeout(150);
        bentFp = await outputFingerprint(page);
        delta = bentFp ? fpDelta(refFp!, bentFp) : 0;
      }
      expect(delta, `${program}: bent output is DISTINCT from the un-bent reference (Δluma=${delta.toFixed(2)}/255)`).toBeGreaterThan(6);

      expect(errors, 'no console / page errors').toEqual([]);
    });
  }

  // macroblock-mosh TWO-CLIP DATAMOSH (the multi-input flagship): clip B's motion
  // is transferred onto image A. This is the multi-input analog of the poly real-
  // source-chain rule — it wires TWO REAL video sources (not a synthetic stand-in)
  // and proves the SECOND input actually reaches the output at runtime, isolating the
  // B-transfer path so a dead vin2 binding can't hide behind the synthetic storm:
  //
  //   src0(smpte, static) ─┬───────────────────────────→ bent.vin1  (image A)
  //                        └→ srcB(sync-bender, perpetual roll)→ bent.vin2 (motion B)
  //
  // B is a sync-bender whose V-ROLL is a continuous uTime scroll (a perpetual, non-
  // converging motion source — a feedback howl would settle and leave nothing to
  // transfer). With the synthetic motion (p2 mvect) at ZERO, the ONLY thing that can
  // move the output is B's transferred motion (p5 mvectB). So: mvectB=0 → once the
  // reference settles the output is STATIC (A recirculated, no warp); mvectB>0 → B's
  // per-frame motion warps A and the output animates. We assert the temporal change is
  // decisively larger with mvectB on than off — a renderer-tolerant causal proof that
  // clip B's motion reaches the picture (a dead vin2 binding would leave it static).
  test('macroblock-mosh: clip B (vin2) motion transfers onto image A (two-clip datamosh)', async ({ page }) => {
    test.setTimeout(75_000); // 3 runners + output on SwiftShader, two capture phases
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'src0', type: 'vfpgaRunner', position: { x: 40, y: 80 }, domain: 'video' },
        { id: 'srcB', type: 'vfpgaRunner', position: { x: 440, y: 320 }, domain: 'video' },
        { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
      ],
      [
        // image A: the static smpte source straight into vin1.
        { id: 'e1', from: { nodeId: 'src0', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        // motion source B: the same smpte through a self-animating howl → vin2.
        { id: 'e2', from: { nodeId: 'src0', portId: 'vout1' }, to: { nodeId: 'srcB', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        { id: 'e3', from: { nodeId: 'srcB', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin2' }, sourceType: 'video', targetType: 'video' },
        { id: 'e4', from: { nodeId: 'bent', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
      { mountTimeout: 15_000 },
    );

    await loadPreset(page, 'src0', 'smpte-bars', 'SMPTE bars');
    await loadPreset(page, 'srcB', 'sync-bender', 'sync-bender');
    await loadPreset(page, 'bent', 'macroblock-mosh', 'macroblock-mosh');

    // Drive a strong, perpetually-rolling B (sync-bender: high V-roll + shear + line
    // slip = a non-converging multi-directional motion source), and configure the
    // mosh so the ONLY motion source is B's transfer: p1 mosh high (reference
    // dominates so the warp accumulates), p2 synthetic motion 0, p4 quant 0, p5
    // transfer 0 (for now).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const b = w.__patch.nodes['srcB']; if (b) { b.params.p1 = 0.08; b.params.p2 = 0.4; b.params.p3 = 0.4; b.params.p4 = 0.05; }
        const m = w.__patch.nodes['bent']; if (m) { m.params.p1 = 0.9; m.params.p2 = 0; m.params.p4 = 0; m.params.p5 = 0; }
      });
    });
    await pollStats(page);
    await page.waitForTimeout(1500); // let the reference fully converge to steady A

    // Phase 1 — mvectB OFF: B's motion is ignored and there is no synthetic storm,
    // so once the reference has settled the output is static frame-to-frame.
    const a0 = await outputFingerprint(page);
    await page.waitForTimeout(600);
    const a1 = await outputFingerprint(page);
    expect(a0, 'phase-1 fingerprints readable').not.toBeNull();
    const dOff = a0 && a1 ? fpDelta(a0, a1) : 0;

    // Phase 2 — mvectB ON: B's per-frame motion now warps image A; the output must
    // animate. Poll a few frames so the warp accumulates off the settled reference.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { const m = w.__patch.nodes['bent']; if (m) m.params.p5 = 0.3; });
    });
    await page.waitForTimeout(600);
    let dOn = 0;
    for (let i = 0; i < 30 && dOn <= dOff + 5; i++) {
      const b0 = await outputFingerprint(page);
      await page.waitForTimeout(250);
      const b1 = await outputFingerprint(page);
      dOn = b0 && b1 ? fpDelta(b0, b1) : 0;
    }

    // The baseline really is (near) static — proof the comparison is meaningful (a
    // perpetually-animating output would make any Δon trivially pass).
    expect(dOff, `baseline (mvectB=0) is ~static once settled (Δoff=${dOff.toFixed(2)}/255)`).toBeLessThan(5);
    // The output animates decisively MORE with the transfer on — clip B's motion is
    // reaching the picture (renderer-tolerant: a coarse Δluma comparison, not pixel
    // equality). dOn also clears an absolute floor (it really moves under B).
    expect(dOn, `B-transfer animates the output (Δon=${dOn.toFixed(2)} vs Δoff=${dOff.toFixed(2)} /255)`).toBeGreaterThan(dOff + 5);
    expect(dOn, `output visibly animates under B's motion (Δon=${dOn.toFixed(2)}/255)`).toBeGreaterThan(6);
    expect(errors, 'no console / page errors').toEqual([]);
  });

  // macroblock-mosh LEAK AUDIT (the flagship's reference frame-store FBOs): under
  // sustained feedback the register ping-pong pair is allocated ONCE and swapped in
  // place — no per-frame GL allocation. Same audit as framestore-howl: assert the
  // render loop survives many frames with NO console errors AND (where the JS-heap
  // API is available — Chromium) that the heap does not grow unboundedly.
  test('macroblock-mosh: sustained feedback does not leak (FBOs swapped in place)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'vfpgaRunner', position: { x: 60, y: 80 }, domain: 'video' },
        { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'bent', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
      { mountTimeout: 15_000 },
    );
    await loadPreset(page, 'bent', 'macroblock-mosh', 'macroblock-mosh');
    await pollStats(page);

    const heapApi = await page.evaluate(() => 'memory' in performance);
    const heap0 = heapApi ? await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) : 0;

    await page.waitForTimeout(4_000);
    const stillRendering = await outputStats(page);
    expect(stillRendering, 'still rendering after sustained feedback').not.toBeNull();
    expect(stillRendering!.nonZeroFrac, 'feedback loop still producing a picture').toBeGreaterThan(0.05);

    if (heapApi) {
      const heap1 = await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize);
      expect(heap1 - heap0, `JS heap growth bounded (Δ=${((heap1 - heap0) / 1e6).toFixed(1)}MB)`).toBeLessThan(10_000_000);
    }
    expect(errors, 'no console / page errors over the sustained run').toEqual([]);
  });
});
