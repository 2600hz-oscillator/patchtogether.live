// e2e/tests/tiler.spec.ts
//
// TILER (video multiscreen / TILE effect processor) functional e2e.
//
// Graph:
//   SHAPES (one filled shape, no internal tiling) --> TILER.in
//     --> TILER.out --> OUTPUT
//
// We drive the REAL source → module → output chain (the standard for a new
// module) and assert:
//   1. all cards spawn + the OUTPUT preview canvas mounts,
//   2. at TILE=0 (total 1, 1:1 PASSTHROUGH) the OUTPUT shows non-black content,
//   3. at TILE=5 (total 64, an 8×8 grid) the OUTPUT shows non-black content AND
//      is SPATIALLY DIFFERENT from the passthrough frame — i.e. the TILE
//      knob actually changed the rendered output (the whole point of the
//      module). The 8×8 grid replicates the single shape into many cells, so
//      the per-region brightness fingerprint differs measurably from the
//      single-shape passthrough.
//   4. the TILE CV param routes through the patch store.
//   5. no console / page errors.
//
// Pixel determinism for a baseline lives in the VRT card-chrome capture (TILER
// is EXEMPT_FROM_VRT — live preview canvas); this spec is the behavioural gate
// over the live render. Timeout scales by the per-step capture count — CI's
// SwiftShader software renderer is far slower than a real GPU (see the
// ci-swiftshader-video-e2e-timeouts memory: don't use a flat 90s), and we do
// two full SHAPES→TILER→OUTPUT spawn+settle cycles here.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

// SHAPES + TILER + videoOut are WebGL canvas cards whose first paint is slow on
// CI's SwiftShader software renderer (markedly slower at 1024×768). spawnPatch's
// generic 5s node-mount wait is enough on a real GPU but times out on a loaded
// CI shard. Grant the established WebGL-heavy headroom (matches modules.spec.ts).
const HEAVY_MOUNT_TIMEOUT = 30_000;

// Two full re-spawn + render + read cycles (passthrough vs 8×8). On CI's
// software renderer each spawn+settle is ~6-10s; budget generously.
test.setTimeout(120_000);

/** Sample the OUTPUT canvas interior and return a coarse per-region brightness
 *  FINGERPRINT (an 8×8 grid of mean-luma values) plus the non-black fraction.
 *  We sample the centre 70% so the video-out 4:3 letterbox bars can't pollute
 *  the readout. The fingerprint lets us prove the two TILE settings render
 *  DIFFERENT spatial content without pinning exact pixels. */
async function readFrame(
  page: import('@playwright/test').Page,
): Promise<{ grid: number[]; nonZeroFrac: number }> {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  await expect(canvas).toHaveCount(1);
  const out = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const x0 = Math.floor(c.width * 0.15), x1 = Math.ceil(c.width * 0.85);
    const y0 = Math.floor(c.height * 0.15), y1 = Math.ceil(c.height * 0.85);
    const w = x1 - x0, h = y1 - y0;
    const d = ctx.getImageData(x0, y0, w, h).data;
    // 8×8 region fingerprint.
    const G = 8;
    const grid = new Array<number>(G * G).fill(0);
    const counts = new Array<number>(G * G).fill(0);
    let n = 0, nonZero = 0;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4;
        const v = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
        const gx = Math.min(G - 1, Math.floor((px / w) * G));
        const gy = Math.min(G - 1, Math.floor((py / h) * G));
        const gi = gy * G + gx;
        grid[gi]! += v;
        counts[gi]!++;
        n++;
        if (v > 8) nonZero++;
      }
    }
    for (let i = 0; i < grid.length; i++) grid[i] = counts[i] ? grid[i]! / counts[i]! : 0;
    return { grid, nonZeroFrac: nonZero / n };
  });
  expect(out, 'canvas readable').not.toBeNull();
  return out!;
}

/** Mean absolute difference between two 8×8 fingerprints (0..255). */
function fingerprintDiff(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

/** Spawn SHAPES -> TILER -> OUTPUT with the given TILER tile index, let the
 *  render settle, and return the OUTPUT frame fingerprint. */
async function captureTiler(
  page: import('@playwright/test').Page,
  tileIndex: number,
): Promise<{ grid: number[]; nonZeroFrac: number }> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      // ONE large filled shape, SHAPES' own internal tiling OFF (tile=0) so the
      // only repetition in the OUTPUT is TILER's grid. Off-centre/zoomed so the
      // passthrough frame is itself spatially structured (not flat).
      { id: 'src',  type: 'shapes',   position: { x: 40,  y: 40 }, domain: 'video', params: { shape: 0, tile: 0, zoom: 0.6 } },
      { id: 'tlr',  type: 'tiler',    position: { x: 460, y: 80 }, domain: 'video', params: { tile: tileIndex } },
      { id: 'vout', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
    ],
    [
      { id: 'e_in',  from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'tlr',  portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'e_out', from: { nodeId: 'tlr', portId: 'out' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video',      targetType: 'video' },
    ],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('[data-testid="tiler-card"]'), 'TILER visible').toHaveCount(1);
  await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
  // A handful of rAFs so the SHAPES → TILER → OUTPUT chain renders.
  await page.waitForTimeout(700);
  return readFrame(page);
}

test.describe('TILER — video multiscreen / tile processor', () => {
  test('SHAPES -> TILER -> OUTPUT: the TILE knob changes the rendered output', async ({ page, errorWatch }) => {

    // TILE=0 → total 1 → 1:1 passthrough (the single shape).
    const passthrough = await captureTiler(page, 0);
    // TILE=5 → total 64 → 8×8 grid (64 copies of the shape).
    const tiled8 = await captureTiler(page, 5);

    // Both render real (non-black) content.
    expect(passthrough.nonZeroFrac, 'passthrough renders content').toBeGreaterThan(0.01);
    expect(tiled8.nonZeroFrac, '8×8 grid renders content').toBeGreaterThan(0.01);

    // The tiling MUST change the output: the 8×8 grid spreads the shape into
    // many cells, so the per-region brightness fingerprint differs clearly
    // from the single-shape passthrough. A robust, renderer-tolerant assert
    // (mean per-region luma delta), NOT an exact-pixel match.
    const diff = fingerprintDiff(passthrough.grid, tiled8.grid);
    expect(diff, 'TILE=8×8 output differs spatially from the passthrough').toBeGreaterThan(4);

  });

  test('TILE CV param routes through the patch store', async ({ page, rack }) => {
    await spawnPatch(
      page,
      [{ id: 'tlr', type: 'tiler', position: { x: 200, y: 100 }, domain: 'video' }],
      [],
      { mountTimeout: HEAVY_MOUNT_TIMEOUT },
    );
    await expect(page.locator('[data-testid="tiler-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tlr'];
        if (!n) return;
        n.params.tile = 4; // → total 16 (4×4)
      });
    });
    await page.waitForTimeout(120);

    const tile = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['tlr']?.params.tile;
    });
    expect(tile).toBe(4);
  });
});
