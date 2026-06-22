// e2e/tests/synesthesia-video-mode.spec.ts
//
// SYNESTHESIA — two coverage blocks:
//
//   A. RASTER VIDEO-OUT — DETERMINISTIC render-smoke (DRS). The per-band
//      `*_raster` mono-video outputs paint the band's analyser window via
//      drawBandRaster (audio→green raster). The raster is PURELY a function of
//      the current analyser buffer — there is NO time/clock/accumulation term —
//      so the ONLY non-determinism is the live analyser DMA contents (the
//      wall-clock-sampling flake class). The `__synesthesiaVrtFreeze` seam
//      (added in synesthesia.ts; never set in production) OVERRIDES that live
//      buffer with a FIXED synthetic per-band waveform, so the rastered frame is
//      byte-stable + non-black + spatially structured by construction. We drive
//      a FIXED window, pull the module's OWN raster output (the same drawFrame
//      the cross-domain bridge + card use, via the audio engine's
//      getVideoSource) into a scratch canvas, and assert non-black + structured
//      + frame-stable. NB synesthesia is an AUDIO-domain module: its raster lives
//      in the audio engine's videoSources (a 2D-canvas paint), NOT the video
//      engine's FBO, so this reads drawFrame pixels rather than _render-smoke.ts'
//      gl.readPixels(outputTexture). installRenderSmokeHooks still pins the
//      engine clock + pauses its rAF loop so the read can't race a blit.
//
//   B. VIDEO MODE (cross-domain colour analysis) — the per-block pixel path.
//      A self-running video source (ACIDWARP) → SYNESTHESIA .a_video_in, copy A
//      in VIDEO mode, lights copy A's R/G/B/Luma VU meters + fires a channel
//      gate (the card reads frame pixels → channel levels → worklet env/gate
//      stage). The precise colour→channel mapping + the level→env/gate/meter
//      math are proven DETERMINISTICALLY at the DSP-unit layer
//      (synesthesia-dsp.test.ts: videoChannelLevels, renderSynesthesiaVideo, and
//      the new sample-and-hold meter-snapshot PCU), so here we only prove the
//      real WIRING reaches the snapshot — via expect.poll (await the lit/dark
//      state) instead of a fixed waitForTimeout, killing the three-clock
//      (headless rAF throttle / ACIDWARP decode / card blit) tight-poll flake.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { installRenderSmokeHooks } from './_render-smoke';

/** Read SYNESTHESIA's VU snapshot ({levelsA, levelsB}) via the dev engine hook. */
async function readSynLevels(
  page: Page,
  nodeId: string,
): Promise<{ levelsA: number[]; levelsB: number[] } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as
      | { levelsA: number[]; levelsB: number[] }
      | undefined;
    if (!snap) return null;
    return { levelsA: Array.from(snap.levelsA), levelsB: Array.from(snap.levelsB) };
  }, nodeId);
}

/** Pull SYNESTHESIA's OWN per-band raster output (a `*_raster` mono-video port)
 *  into a scratch canvas via the audio engine's getVideoSource → drawFrame — the
 *  SAME path the cross-domain bridge + card use to materialize the raster — then
 *  read it back as a SPARSE luma stat bundle (mean / variance / nonZeroFrac).
 *  Under __synesthesiaVrtFreeze the source buffer is a FIXED synthetic waveform,
 *  so two reads are bit-stable; floors are renderer-independent (this is a 2D
 *  putImageData paint, not a GPU shader, so there's no SwiftShader divergence —
 *  the floors are just "is it non-black + structured"). */
async function readRasterStats(
  page: Page,
  nodeId: string,
  portId: string,
): Promise<{ ok: boolean; mean: number; variance: number; nonZeroFrac: number }> {
  return page.evaluate(
    ({ nodeId, portId }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => {
            getVideoSource?: (
              n: string,
              p: string,
            ) => { drawFrame?: (c: OffscreenCanvas | HTMLCanvasElement) => void } | null;
          } | null;
        } | null;
      };
      const ae = w.__engine?.()?.getDomain?.('audio');
      const src = ae?.getVideoSource?.(nodeId, portId) ?? null;
      if (!src?.drawFrame) return { ok: false, mean: 0, variance: 0, nonZeroFrac: 0 };
      const W = 64;
      const H = 48;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const c2d = canvas.getContext('2d', { willReadFrequently: true });
      if (!c2d) return { ok: false, mean: 0, variance: 0, nonZeroFrac: 0 };
      src.drawFrame(canvas);
      const px = c2d.getImageData(0, 0, W, H).data;
      let n = 0;
      let sum = 0;
      let sumSq = 0;
      let nonZero = 0;
      for (let i = 0; i < px.length; i += 4 * 4) {
        const v = (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
        sum += v;
        sumSq += v * v;
        n++;
        if (v > 8) nonZero++;
      }
      const mean = n ? sum / n : 0;
      const variance = n ? sumSq / n - mean * mean : 0;
      return { ok: true, mean, variance, nonZeroFrac: n ? nonZero / n : 0 };
    },
    { nodeId, portId },
  );
}

test.describe('SYNESTHESIA RASTER video-out — deterministic render smoke', () => {
  test('a steady tone rasters a non-black, structured, frame-stable band output', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pin the engine clock + pause its rAF loop (so a read can't race a blit),
    // AND enable the deterministic raster seam — all BEFORE boot so the very
    // first raster paint uses the FIXED synthetic waveform, not the live
    // analyser DMA.
    await installRenderSmokeHooks(page);
    await page.addInitScript(() => {
      (globalThis as unknown as { __synesthesiaVrtFreeze?: boolean }).__synesthesiaVrtFreeze = true;
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Deterministic AUDIO source → SYNESTHESIA copy A (AUDIO mode, default). A
    // 261 Hz sine lands in band 2; we read band 2's RASTER output. (Under the
    // freeze seam the raster is the FIXED synthetic waveform regardless of which
    // band actually has energy — the tone just keeps the worklet/analyser graph
    // live and the patch realistic; the seam is what makes the frame stable.)
    const nodes: SpawnNode[] = [
      { id: 'vco', type: 'analogVco', position: { x: 40, y: 40 }, domain: 'audio', params: { tune: 0 } },
      { id: 'vca', type: 'vca', position: { x: 300, y: 40 }, domain: 'audio', params: { base: 1, cvAmount: 0 } },
      { id: 'syn', type: 'synesthesia', position: { x: 560, y: 40 }, domain: 'audio',
        params: { a_mode: 0, b_mode: 0 } },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_vco_vca', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e_vca_syn', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'syn', portId: 'a_in' }, sourceType: 'audio', targetType: 'audio' },
    ];
    await spawnPatch(page, nodes, edges);

    const synCard = page.locator('.svelte-flow__node-synesthesia').first();
    await synCard.waitFor({ state: 'visible', timeout: 10_000 });

    // The raster source is registered when the node materializes; await it (no
    // fixed sleep) so the first read isn't a pre-materialization miss.
    await expect
      .poll(async () => (await readRasterStats(page, 'syn', 'a_band2_raster')).ok, {
        timeout: 10_000,
        message: 'a_band2_raster video source materialized',
      })
      .toBe(true);

    // The frozen raster is a real painted frame: non-black + spatially
    // structured (the synthetic sine tiles green bands across the buffer). 2D
    // putImageData → renderer-independent; floors mirror assertRenderStats.
    const a = await readRasterStats(page, 'syn', 'a_band2_raster');
    expect(a.nonZeroFrac, `raster not all-black (nz=${a.nonZeroFrac.toFixed(3)})`).toBeGreaterThan(0.02);
    expect(a.variance, `raster has spatial structure (var=${a.variance.toFixed(2)})`).toBeGreaterThan(15);

    // DETERMINISM: a second read of the FROZEN raster is frame-stable — the
    // property the old waitForTimeout-then-read-once pattern lacked. The seam
    // swaps the live analyser for a fixed waveform, so the two reads are
    // bit-identical (mean + variance match to a tight epsilon).
    const b = await readRasterStats(page, 'syn', 'a_band2_raster');
    expect(Math.abs(b.mean - a.mean), `frozen raster mean stable (${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen raster variance stable').toBeLessThan(1.0);

    // Every copy-A AUDIO band exposes its own structured raster (the per-band
    // fan-out is live, not just band 2).
    for (const port of ['a_band1_raster', 'a_band3_raster', 'a_band4_raster']) {
      const s = await readRasterStats(page, 'syn', port);
      expect(s.ok, `${port} source present`).toBe(true);
      expect(s.nonZeroFrac, `${port} not all-black (nz=${s.nonZeroFrac.toFixed(3)})`).toBeGreaterThan(0.02);
      expect(s.variance, `${port} structured (var=${s.variance.toFixed(2)})`).toBeGreaterThan(15);
    }

    expect(errors.filter((e) => !e.includes('AudioContext')), `errors: ${errors.join('; ')}`).toEqual([]);
  });
});

test.describe('SYNESTHESIA VIDEO mode — cross-domain colour analysis', () => {
  test('ACIDWARP → a_video_in (copy A VIDEO) lights R/G/B/Luma meters + fires a gate', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const nodes: SpawnNode[] = [
      { id: 'acid', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video' },
      // Copy A in VIDEO mode; copy B left in AUDIO mode (default) with no input.
      { id: 'syn', type: 'synesthesia', position: { x: 420, y: 40 }, domain: 'audio',
        params: { a_mode: 1, b_mode: 0 } },
      { id: 'scp', type: 'scope', position: { x: 420, y: 420 }, domain: 'audio' },
    ];
    const edges: SpawnEdge[] = [
      // Cross-domain video → synesthesia video input (consumed card-side).
      { id: 'e_acid_syn', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: 'syn', portId: 'a_video_in' }, sourceType: 'video', targetType: 'video' },
      // Route a channel GATE into SCOPE so we can prove the gate fires.
      { id: 'e_gate_scp', from: { nodeId: 'syn', portId: 'a_band4_gate' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'gate', targetType: 'gate' },
    ];
    await spawnPatch(page, nodes, edges);

    // The card's rAF must run + read frames. Card visibility ensures the rAF
    // loop is active.
    const synCard = page.locator('.svelte-flow__node-synesthesia').first();
    await synCard.waitFor({ state: 'visible', timeout: 10_000 });

    // Copy A (VIDEO): await all four channel meters lighting off the plasma's
    // colour. expect.poll awaits the true state (no fixed waitForTimeout) — the
    // colour→channel mapping itself is proven deterministically by the DSP-unit
    // videoChannelLevels suite; here we only need the wiring to reach the
    // snapshot. Min over the 4 channels > floor ⇒ all four lit.
    await expect
      .poll(
        async () => {
          const s = await readSynLevels(page, 'syn');
          if (!s) return 0;
          return Math.min(...s.levelsA.slice(0, 4));
        },
        { timeout: 12_000, message: 'all four copy-A channel meters lit off the plasma' },
      )
      .toBeGreaterThan(0.02);

    // Copy B stays dark (AUDIO mode, no input) — sample the snapshot now that A
    // is confirmed lit. The check is a definite state, not a timed window.
    const snap = await readSynLevels(page, 'syn');
    expect(snap, 'snapshot readable').not.toBeNull();
    expect(Math.max(...snap!.levelsB.slice(0, 4)), `copy B dark (b=${snap!.levelsB.map((v) => v.toFixed(3)).join(',')})`).toBeLessThan(0.02);

    // A channel gate fired (the Luma channel of a bright plasma crosses the
    // gate's high threshold). readScopePeakOverWindow max-holds across its window,
    // robust to where the poll lands (kept — SCOPE has no deterministic step).
    const gate = await readScopePeakOverWindow(page, 'scp', 800);
    expect(gate.peak, 'a_band4_gate fired (SCOPE saw the gate)').toBeGreaterThan(0.4);

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });

  test('AUDIO regression: copy B (AUDIO) still lights the right band while copy A is VIDEO', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const nodes: SpawnNode[] = [
      { id: 'acid', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video' },
      // A in VIDEO; B in AUDIO, fed a 261 Hz tone → band 2 must light.
      { id: 'vco', type: 'analogVco', position: { x: 40, y: 360 }, domain: 'audio', params: { tune: 0 } },
      { id: 'vca', type: 'vca', position: { x: 300, y: 360 }, domain: 'audio', params: { base: 1, cvAmount: 0 } },
      { id: 'syn', type: 'synesthesia', position: { x: 560, y: 40 }, domain: 'audio',
        params: { a_mode: 1, b_mode: 0 } },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_acid_syn', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: 'syn', portId: 'a_video_in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e_vco_vca', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e_vca_syn', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'syn', portId: 'b_in' }, sourceType: 'audio', targetType: 'audio' },
    ];
    await spawnPatch(page, nodes, edges);

    const synCard = page.locator('.svelte-flow__node-synesthesia').first();
    await synCard.waitFor({ state: 'visible', timeout: 10_000 });

    // Await copy B's band 2 (index 1) lighting AND copy A (VIDEO) lighting — both
    // a definite state, via expect.poll (no fixed waitForTimeout). The band-2-
    // dominates and band-isolation maths are proven deterministically by the
    // DSP-unit band-split suite; the e2e only confirms both modes coexist live.
    await expect
      .poll(
        async () => {
          const s = await readSynLevels(page, 'syn');
          if (!s) return false;
          const b = s.levelsB.slice(0, 4);
          const a = s.levelsA.slice(0, 4);
          const bDom = b[1] === Math.max(...b) && b[1]! > 0.02; // B band2 dominant + lit
          const aLit = Math.max(...a) > 0.02; // A video independently lit
          return bDom && aLit;
        },
        { timeout: 12_000, message: 'B band2 dominant+lit AND A video lit (both modes coexist)' },
      )
      .toBe(true);

    // Pin the exact end-state assertions the poll converged on (the same intent
    // as the original strict-max + floor checks).
    const snap = await readSynLevels(page, 'syn');
    expect(snap, 'snapshot readable').not.toBeNull();
    const b = snap!.levelsB.slice(0, 4);
    const a = snap!.levelsA.slice(0, 4);
    expect(b[1], `B band2 dominates (b=${b.map((v) => v.toFixed(3)).join(',')})`).toBe(Math.max(...b));
    expect(b[1]!).toBeGreaterThan(0.02);
    expect(Math.max(...a), `A video lit (a=${a.map((v) => v.toFixed(3)).join(',')})`).toBeGreaterThan(0.02);

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });
});
