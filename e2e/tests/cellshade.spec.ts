// e2e/tests/cellshade.spec.ts
//
// CELLSHADE (cel-shader video processor) functional e2e — the REAL
// source → module → audible-output chain.
//
// Graph:
//   ACIDWARP (colour video, self-running) --> CELLSHADE.in --> CELLSHADE.out --> OUTPUT
//
// CELLSHADE (rebuilt engine) smooths, bands the LUMINANCE into a few flat
// tonal steps (hue rides through), and inks the Sobel edges as black lines.
// ACIDWARP is a self-running COLOURFUL source with high-contrast moving
// structure — a clean probe for both the banding (colourful output, since
// chroma is preserved) AND the edge-ink (some black-line pixels).
// We assert, on the live render:
//   1. all cards spawn + the OUTPUT preview canvas mounts,
//   2. CELLSHADE.out shows BANDED COLOUR (colourful pixels) PLUS some
//      BLACK INK pixels (the inked Sobel edges) — the cel signature vs. a
//      passthrough,
//   3. a LOW band count still renders colourful (chroma-preserving),
//   4. low and high THRESHOLD gates both yield a sane cel frame,
//   5. CV params route through the patch store (all six knobs),
//   6. no console / page errors.
//
// Pixel determinism for a baseline lives in the VRT card chrome capture +
// the pure cellshade.test.ts CPU mirror; this spec is the behavioural gate
// over the live render. Timeout scales by the per-step capture count (CI's
// SwiftShader software renderer is far slower than a real GPU — see the
// ci-swiftshader-video-e2e-timeouts memory: don't use a flat 90s).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// ACIDWARP + CELLSHADE + videoOut are WebGL canvas cards whose FIRST-paint is
// slow on CI's SwiftShader software renderer (markedly slower at 1024×768 —
// see the ci-swiftshader-video-e2e-timeouts memory). spawnPatch's generic 5s
// node-mount-readiness wait is enough on a real GPU but times out on a loaded
// CI shard. Grant the established WebGL-heavy headroom (matches
// modules.spec.ts / edges.spec.ts / mapper.spec.ts HEAVY_MOUNT_TIMEOUT). This
// is a setup-timing fix, NOT a shader/behaviour change.
const HEAVY_MOUNT_TIMEOUT = 30_000;

// We do FOUR full re-spawn + render + read cycles (headline render + a BITS
// hi/lo pair + a THRESHOLD hi/lo pair, reusing the headline for one arm). On
// CI's software renderer each spawn+settle is ~6-10s; budget generously so the
// suite isn't flaky under load.
test.setTimeout(180_000);

interface CellStats {
  /** fraction of sampled pixels that are colourful (channels spread apart). */
  colourFrac: number;
  /** fraction of sampled pixels that are near-black (the inked edges). */
  inkFrac: number;
  /** count of DISTINCT quantized colours seen (coarse 5-bit bucket per ch). */
  distinctColours: number;
  n: number;
}

/** Sample the OUTPUT canvas interior and return cel-shade stats. We sample
 *  the centre 70% so the video-out 4:3 letterbox bars can't inflate counts. */
async function readCellStats(page: Page): Promise<CellStats> {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  await expect(canvas).toHaveCount(1);
  const stats = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const x0 = Math.floor(c.width * 0.15), x1 = Math.ceil(c.width * 0.85);
    const y0 = Math.floor(c.height * 0.15), y1 = Math.ceil(c.height * 0.85);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0, colour = 0, ink = 0;
    const buckets = new Set<number>();
    for (let i = 0; i < d.length; i += 16) {
      const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
      const v = (r + g + b) / 3;
      n++;
      // near-black = an inked edge pixel (or a true-black region).
      if (v < 12) ink++;
      // colourful = channels spread apart (a posterized colour, not grey/black).
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      if (v > 12 && maxC - minC > 20) colour++;
      // coarse colour bucket (5 bits/channel) to COUNT distinct colours.
      if (v > 12) {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        buckets.add(key);
      }
    }
    return { colourFrac: colour / n, inkFrac: ink / n, distinctColours: buckets.size, n };
  });
  expect(stats, 'canvas readable').not.toBeNull();
  return stats!;
}

/** Spawn ACIDWARP -> CELLSHADE -> OUTPUT with the given CELLSHADE params, let
 *  the render settle, and return cel-shade stats. */
async function captureCell(
  page: Page,
  params: { threshold?: number; thickness?: number; bits?: number },
): Promise<CellStats> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      // Self-running colour video source with high-contrast structure.
      { id: 'vid',  type: 'acidwarp',  position: { x: 40,  y: 40 }, domain: 'video' },
      { id: 'cel',  type: 'cellshade', position: { x: 460, y: 80 }, domain: 'video', params },
      { id: 'vout', type: 'videoOut',  position: { x: 900, y: 80 }, domain: 'video' },
    ],
    [
      { id: 'e_in',  from: { nodeId: 'vid', portId: 'out' }, to: { nodeId: 'cel',  portId: 'in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e_out', from: { nodeId: 'cel', portId: 'out' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('.svelte-flow__node-cellshade'), 'CELLSHADE visible').toBeVisible();
  await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
  // A handful of rAFs so the ACIDWARP -> CELLSHADE -> OUTPUT chain renders.
  await page.waitForTimeout(800);
  return readCellStats(page);
}

test.describe('CELLSHADE — cel-shader video processor', () => {
  test('ACIDWARP -> CELLSHADE -> OUTPUT shows banded colour + edge ink', async ({ page, errorWatch }) => {

    // 4 bands (idx 2) default + a thicker ink so the edges read clearly.
    const stats = await captureCell(page, { threshold: 0.18, thickness: 3, bits: 2 });

    // Colourful banded pixels show through (renderer-tolerant: assert
    // "some colour" not an exact count — SwiftShader vs a real GPU differ).
    expect(stats.colourFrac, 'CELLSHADE renders banded colour').toBeGreaterThan(0.01);
    // Some black-ink edge pixels exist (the inked Sobel contours over a
    // high-contrast moving source). Not all-black, not edge-free.
    expect(stats.inkFrac, 'CELLSHADE inks some edges (black lines)').toBeGreaterThan(0.001);
    expect(stats.inkFrac, 'frame is not all-black ink').toBeLessThan(0.9);

  });

  // NOTE on BANDS/THRESHOLD MONOTONICITY: the EXACT "fewer BANDS → fewer
  // distinct tones" and "higher THRESHOLD → fewer/equal inked pixels"
  // relations are proven pixel-deterministically by the pure CPU mirror in
  // packages/web/src/lib/video/modules/cellshade.test.ts (the 5-point
  // dynamism proofs). We do NOT re-assert that monotonicity across two LIVE renders
  // here: each captureCell re-spawns and samples an INDEPENDENT frame of the
  // self-running, animated ACIDWARP source, so the only-the-param-changed
  // premise doesn't hold — the moving frame content confounds the comparison,
  // and on CI's SwiftShader software renderer it flips the inequality (a real
  // pre-#695-era flake, not a regression). Instead this spec asserts the
  // renderer-tolerant invariants the live chain CAN guarantee frame-to-frame:
  // a LOW-bit render is still colourful, and BOTH a low- and a high-threshold
  // render produce a sane (non-all-black, non-blank) cel frame.

  test('BANDS sweep: a 2-band live render is still colourful (chroma-preserving)', async ({ page }) => {
    // idx 0 = 2 luminance bands: the coarsest step still shows colour
    // through — hue is never quantized, so even the boldest banding keeps the
    // source's chroma (the F-CS1/F-CS2 fix). Exact band counts are the CPU
    // mirror's job (see note above).
    const lowBands = await captureCell(page, { threshold: 0.95, thickness: 1, bits: 0 });
    expect(lowBands.distinctColours, 'low-band render has colours').toBeGreaterThan(0);
    expect(lowBands.colourFrac, 'low-band render is colourful, not crushed').toBeGreaterThan(0.01);
  });

  test('THRESHOLD sweep: low and high gates both yield a sane cel frame', async ({ page }) => {
    // Same source + bits + thickness; only the edge gate changes. The exact
    // "higher threshold → fewer ink" ordering is the CPU mirror's job (see note
    // above — cross-frame on a moving source it's not deterministic). Here we
    // assert each render is a valid cel frame: a LOW threshold inks SOME edges,
    // and a HIGH threshold doesn't flood the frame to all-black.
    const lowThresh  = await captureCell(page, { threshold: 0.08, thickness: 2, bits: 3 });
    const highThresh = await captureCell(page, { threshold: 0.9,  thickness: 2, bits: 3 });


    expect(lowThresh.inkFrac, 'low threshold inks some edges').toBeGreaterThan(0);
    expect(highThresh.inkFrac, 'high threshold is not all-black ink').toBeLessThan(0.9);
    expect(highThresh.colourFrac, 'high-threshold frame still shows colour').toBeGreaterThan(0.01);
  });

  test('CV params route through the patch store (incl. discrete BANDS)', async ({ page, rack }) => {
    await spawnPatch(
      page,
      [{ id: 'cel', type: 'cellshade', position: { x: 200, y: 100 }, domain: 'video' }],
      [],
      { mountTimeout: HEAVY_MOUNT_TIMEOUT },
    );
    await expect(page.locator('[data-testid="cellshade-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['cel'];
        if (!n) return;
        n.params.threshold = 0.42;
        n.params.thickness = 5;
        n.params.bits = 3; // 6-band step index
        n.params.softness = 0.6;
        n.params.smooth = 0.8;
        n.params.ink = 0.4;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['cel'];
      return {
        th: n?.params.threshold, wk: n?.params.thickness, bits: n?.params.bits,
        soft: n?.params.softness, smo: n?.params.smooth, ink: n?.params.ink,
      };
    });
    expect(params.th).toBe(0.42);
    expect(params.wk).toBe(5);
    expect(params.bits).toBe(3);
    expect(params.soft).toBe(0.6);
    expect(params.smo).toBe(0.8);
    expect(params.ink).toBe(0.4);

    // The card's BANDS readout reflects the 6-band step (data-testid kept on
    // the readout). Renderer-agnostic DOM assertion (no canvas read needed).
    await expect(page.locator('[data-testid="cellshade-bits-readout"]'))
      .toContainText('6 BANDS');
  });
});
