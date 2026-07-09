// e2e/tests/vfpga-p3-composite.spec.ts
//
// vfpga P3 — the COMPOSITE/ANALOG-era bent VFPGA catalog (sync-bender, chroma-rot,
// framestore-howl, databend-cvbs), end-to-end on a REAL WebGL2 context. Each bent
// program needs a video source, so the patch is:
//
//   src (vfpga-runner = smpte-bars) → bent (vfpga-runner = <program>) → OUTPUT
//
// We select the bent program from its card's "load preset…" menu (the production
// hot-swap path), then assert the OUTPUT canvas is (a) NON-BLACK with spatial
// STRUCTURE (the bent picture reaches downstream — a renderer-tolerant floor, NOT
// exact pixels: CI runs SwiftShader) AND (b) DISTINCT from the same source passed
// straight through (a passthru reference), proving the bend actually transforms
// the picture rather than just compiling. Renderer-tolerant throughout (structure
// + a coarse distinctness delta, not pixel equality). The bends are SEEDED-
// deterministic, but vfpga-runner is VRT-exempt (live preview + scopes), so this
// asserts behaviour, not a baseline.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const BENT = ['sync-bender', 'chroma-rot', 'framestore-howl', 'databend-cvbs'] as const;

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

/** A subsampled greyscale fingerprint of the OUTPUT (one luma byte per 4px row-
 *  major step) — a renderer-tolerant SPATIAL signature. Unlike a histogram it is
 *  position-sensitive, so a geometric bend (sync-roll / tear / howl-warp) that
 *  rearranges pixels but preserves the luma distribution still reads as DISTINCT. */
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

/** Mean absolute per-sample difference of two fingerprints (0 = identical), in
 *  0..255 luma units → a coarse "how much did the picture change" delta. */
function fpDelta(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i]! - b[i]!);
  return d / n;
}

/** Set a node's loaded VFPGA via its card preset menu (scoped by SvelteFlow
 *  data-id) + wait for the loaded readout to update. */
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

/** Mean per-pixel saturation (max(R,G,B) - min(R,G,B), 0..255) over the OUTPUT — a
 *  renderer-tolerant "how colourful is it" measure (0 = greyscale, high = vivid). */
async function outputSaturation(page: Page): Promise<number> {
  const canvas = page.locator('[data-testid="video-out-canvas"]');
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      sum += Math.max(r, g, b) - Math.min(r, g, b);
      n++;
    }
    return n ? sum / n : 0;
  });
}

test.describe('vfpga P3 composite-era bent VFPGAs', () => {
  for (const program of BENT) {
    test(`${program}: bends the smpte source into distinct non-black output`, async ({ page, rack, errorWatch }) => {
      // Two pure-GL vfpga-runners + an OUTPUT compile fast even on SwiftShader,
      // but give headroom for boot + spawn + first-frame settle + the hot-swap.
      test.setTimeout(60_000);


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

      // Source stays smpte-bars (the default). REFERENCE render: wire src straight
      // to OUTPUT by loading a known-identity program on `bent` first? Simpler: the
      // reference is `bent` = smpte-bars too (its OWN generated bars, which equals
      // a passthru of the src smpte bars at the same settings). Capture that, then
      // swap to the bent program and require the histogram to DIFFER.
      await loadPreset(page, 'bent', 'smpte-bars', 'SMPTE bars');
      await pollStats(page);
      // settle a couple frames so the reference is stable.
      await page.waitForTimeout(300);
      const refFp = await outputFingerprint(page);
      expect(refFp, 'reference fingerprint').not.toBeNull();

      // Now load the BENT program and assert structure + distinctness.
      await loadPreset(page, 'bent', program, program);
      const stats = await pollStats(page);

      // (a) STRUCTURE FLOOR: the bent picture reaches OUTPUT with spatial detail.
      expect(stats.nonZeroFrac, `${program}: bent output is non-black (frac=${stats.nonZeroFrac})`).toBeGreaterThan(0.1);
      expect(stats.variance, `${program}: bent output has spatial structure (var=${stats.variance})`).toBeGreaterThan(20);

      // (b) DISTINCTNESS: the bend actually transformed the picture (the OUTPUT
      // SPATIAL fingerprint differs meaningfully from the un-bent reference). A
      // mean-abs luma delta of >6/255 is well above renderer noise but easily met
      // by any of the bends (geometric remap, chroma rotation, datapath mangle).
      // Poll a few frames so an animated bend (sync-roll / howl) has settled off
      // the reference frame.
      let bentFp = await outputFingerprint(page);
      let delta = bentFp ? fpDelta(refFp!, bentFp) : 0;
      for (let i = 0; i < 25 && delta < 6; i++) {
        await page.waitForTimeout(150);
        bentFp = await outputFingerprint(page);
        delta = bentFp ? fpDelta(refFp!, bentFp) : 0;
      }
      expect(delta, `${program}: bent output is DISTINCT from the un-bent reference (Δluma=${delta.toFixed(2)}/255)`).toBeGreaterThan(6);

    });
  }

  // framestore-howl MULTI-OUTPUT: the catalog's first 2-output spec. vout2 is the
  // FRAME-STORE SEND (the warped recirculated feedback frame). This proves the
  // host's SECOND video output actually flows through the patch graph to a real
  // sink — the first spec to exercise vout2 end-to-end (the runner's vout2 path
  // existed but no spec drove it). We wire bent.vout2 (NOT vout1) → OUTPUT and
  // require a non-black, structured frame: the feedback send is live + patchable.
  test('framestore-howl: vout2 (frame-store send) flows to a real sink, non-black', async ({ page, rack, errorWatch }) => {
    test.setTimeout(60_000);

    await spawnPatch(
      page,
      [
        { id: 'src', type: 'vfpgaRunner', position: { x: 60, y: 80 }, domain: 'video' },
        { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        // The discriminator: route the SECOND output (vout2 = frame-store send).
        { id: 'e2', from: { nodeId: 'bent', portId: 'vout2' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
      { mountTimeout: 15_000 },
    );
    await expect(page.locator('.svelte-flow__node-vfpgaRunner')).toHaveCount(2);
    await loadPreset(page, 'bent', 'framestore-howl', 'framestore-howl');
    // Feed the howl a few frames so the recirculated (warped) frame builds up on
    // the send tap, then require the OUTPUT (driven by vout2) to be non-black +
    // structured — proving the 2nd output carries real signal downstream.
    const stats = await pollStats(page);
    expect(stats.nonZeroFrac, `vout2 send reaches OUTPUT non-black (frac=${stats.nonZeroFrac})`).toBeGreaterThan(0.1);
    expect(stats.variance, `vout2 send has spatial structure (var=${stats.variance})`).toBeGreaterThan(20);
  });

  // framestore-howl LEAK AUDIT (the flagship's feedback FBOs): under sustained
  // feedback the register ping-pong pair is allocated ONCE and swapped in place
  // (swapRegisters exchanges the {fbo,texture} map entries — no per-frame GL
  // allocation), disposed on hot-swap/teardown. This asserts the render loop
  // survives many frames with NO console errors AND (where the JS-heap API is
  // available — Chromium) that the heap does not grow unboundedly across a long
  // run. Renderer-tolerant: the heap check is skipped if performance.memory is
  // absent; the no-error + still-rendering floor always runs.
  test('framestore-howl: sustained feedback does not leak (FBOs swapped in place)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
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
    await loadPreset(page, 'bent', 'framestore-howl', 'framestore-howl');
    await pollStats(page);

    const heapApi = await page.evaluate(() => 'memory' in performance);
    const heap0 = heapApi ? await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) : 0;

    // Run the feedback loop for a sustained window (many frames). If the feedback
    // FBOs were reallocated per frame (the leak this audit guards), the heap +
    // GPU memory would climb and errors would surface.
    await page.waitForTimeout(4_000);
    const stillRendering = await outputStats(page);
    expect(stillRendering, 'still rendering after sustained feedback').not.toBeNull();
    expect(stillRendering!.nonZeroFrac, 'feedback loop still producing a picture').toBeGreaterThan(0.05);

    if (heapApi) {
      const heap1 = await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize);
      // A no-leak feedback loop holds two fixed FBOs → JS heap should not balloon.
      // Generous ceiling (10MB) absorbs GC jitter + unrelated app allocation while
      // still catching a real per-frame FBO/texture leak (which is tens of MB/s).
      expect(heap1 - heap0, `JS heap growth bounded (Δ=${((heap1 - heap0) / 1e6).toFixed(1)}MB)`).toBeLessThan(10_000_000);
    }
    expect(errors, 'no console / page errors over the sustained run').toEqual([]);
  });

  // chroma-rot Y/C TRANSPLANT (the multi-input flagship): luma from IIN1, chroma
  // from IIN2. This wires TWO REAL sources and proves the SECOND input's CHROMA
  // reaches the output at runtime (the multi-input analog of the poly real-source-
  // chain rule). The discriminator isolates the transplant path: make IIN1 colourful
  // and IIN2 GREYSCALE (saturation 0). With p5 cxfer=0 the output keeps IIN1's own
  // (colourful) chroma; with cxfer=1 it takes IIN2's (zero) chroma → the output
  // desaturates to ~greyscale. A dead vin2 binding would leave it colourful.
  test('chroma-rot: clip B (vin2) chroma transplants onto image A (Y/C, two-source)', async ({ page, rack, errorWatch }) => {
    test.setTimeout(75_000);

    await spawnPatch(
      page,
      [
        { id: 'srcA', type: 'vfpgaRunner', position: { x: 40, y: 80 }, domain: 'video' },
        { id: 'srcB', type: 'vfpgaRunner', position: { x: 40, y: 360 }, domain: 'video' },
        { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'srcA', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'srcB', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin2' }, sourceType: 'video', targetType: 'video' },
        { id: 'e3', from: { nodeId: 'bent', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
      { mountTimeout: 15_000 },
    );
    await loadPreset(page, 'srcA', 'smpte-bars', 'SMPTE bars');
    await loadPreset(page, 'srcB', 'smpte-bars', 'SMPTE bars');
    await loadPreset(page, 'bent', 'chroma-rot', 'chroma-rot');

    // Full transplant (cxfer=1) throughout — the output's chroma is ENTIRELY clip
    // B's. No chroma gain overdrive (p2=1) and no crawl (p4=0) so the measured
    // saturation tracks B's chroma directly. The discriminator is then srcB's OWN
    // saturation: colourful B → colourful output; greyscale B → greyscale output.
    const setSrcBSat = (sat: number) =>
      page.evaluate((s) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const b = w.__patch.nodes['srcB']; if (b) b.params.p2 = s; });
      }, sat);
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { const m = w.__patch.nodes['bent']; if (m) { m.params.p2 = 1; m.params.p4 = 0; m.params.p5 = 1; } });
    });

    // Phase 1 — colourful chroma source (B saturated).
    await setSrcBSat(1);
    await pollStats(page);
    await page.waitForTimeout(600);
    const satColorB = await outputSaturation(page);

    // Phase 2 — greyscale chroma source (B desaturated). Same luma (IIN1), same
    // cxfer; only B's chroma changed → the output must desaturate.
    await setSrcBSat(0);
    await page.waitForTimeout(600);
    let satGrayB = await outputSaturation(page);
    for (let i = 0; i < 20 && !(satGrayB < satColorB * 0.7); i++) {
      await page.waitForTimeout(150);
      satGrayB = await outputSaturation(page);
    }
    // eslint-disable-next-line no-console
    console.log(`[chroma-transplant] satColorB=${satColorB.toFixed(1)} satGrayB=${satGrayB.toFixed(1)}`);

    // Clip B's chroma drives the output's colour: a vivid B gives a vivid output, a
    // greyscale B desaturates it decisively (a ≥30% swing observed ~41%). A dead
    // vin2 binding would leave the output's colour unchanged between the two.
    expect(satColorB, `colourful chroma source → colourful output (sat=${satColorB.toFixed(1)})`).toBeGreaterThan(12);
    expect(satGrayB, `greyscale chroma source desaturates the output (satGrayB=${satGrayB.toFixed(1)} < satColorB=${satColorB.toFixed(1)})`).toBeLessThan(satColorB * 0.7);
  });

  // chroma-rot SECOND OUTPUT: vout2 = the separated LUMA (Y) plane (the S-video Y
  // tap). Route vout2 → OUTPUT and require it non-black + structured AND ~greyscale
  // (it is luma replicated to RGB, so saturation ≈ 0) — distinguishing it from the
  // colourful vout1 composite.
  test('chroma-rot: vout2 (the separated Y/luma plane) flows to a sink, non-black + greyscale', async ({ page, rack, errorWatch }) => {
    test.setTimeout(60_000);

    await spawnPatch(
      page,
      [
        { id: 'src', type: 'vfpgaRunner', position: { x: 60, y: 80 }, domain: 'video' },
        { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        // The discriminator: route the SECOND output (vout2 = the Y/luma plane).
        { id: 'e2', from: { nodeId: 'bent', portId: 'vout2' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
      { mountTimeout: 15_000 },
    );
    await loadPreset(page, 'src', 'smpte-bars', 'SMPTE bars');
    await loadPreset(page, 'bent', 'chroma-rot', 'chroma-rot');
    const stats = await pollStats(page);

    expect(stats.nonZeroFrac, `vout2 Y-plane reaches OUTPUT non-black (frac=${stats.nonZeroFrac})`).toBeGreaterThan(0.1);
    expect(stats.variance, `vout2 Y-plane has spatial structure (var=${stats.variance})`).toBeGreaterThan(20);
    // It is the LUMA plane (greyscale), not the colourful composite — saturation ~0.
    const sat = await outputSaturation(page);
    expect(sat, `vout2 is the luma (Y) plane → ~greyscale (sat=${sat.toFixed(1)})`).toBeLessThan(8);
  });
});
