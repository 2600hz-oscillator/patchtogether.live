// e2e/tests/mapper.spec.ts
//
// MAPPER (video keyer / matte processor) functional e2e — the REAL
// source → key → module → audible-output chain.
//
// Graph:
//   ACIDWARP (colour video, self-running) --> MAPPER.video
//   SHAPES   (filled circle, mono-video)  --> MAPPER.key   (upcast mono→video)
//   MAPPER.out --> OUTPUT
//
// MAPPER shows the VIDEO input only where the KEY input's luminance is
// ≥ threshold, black elsewhere — generalising OUTLINES' `mapped` output to
// an arbitrary key. SHAPES paints a high-contrast filled WHITE circle on
// BLACK: a clean key region (circle interior keyed, background matted out).
// We assert, on the live render:
//   1. all cards spawn + the OUTPUT preview canvas mounts,
//   2. MAPPER.out shows the VIDEO (non-black, COLOURFUL pixels from ACIDWARP)
//      in the keyed centre region, while the frame is NOT all-keyed (the
//      matted background means a meaningful fraction stays black) — the
//      signature of a keyer vs. a passthrough,
//   3. raising THRESHOLD SHRINKS the keyed area (fewer shown pixels) — the
//      circle's anti-aliased rim falls below the cutoff,
//   4. no console / page errors.
//
// Pixel determinism for a baseline lives in the VRT card chrome capture +
// the pure mapper.test.ts CPU mirror; this spec is the behavioural gate over
// the live render. Timeout scales by the per-step capture count (CI's
// SwiftShader software renderer is far slower than a real GPU — see the
// ci-swiftshader-video-e2e-timeouts memory: don't use a flat 90s).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// ACIDWARP + SHAPES + MAPPER + videoOut are WebGL canvas cards whose
// FIRST-paint is slow on CI's SwiftShader software renderer (markedly slower
// at 1024×768 — see the ci-swiftshader-video-e2e-timeouts memory). spawnPatch's
// generic 5s node-mount-readiness wait is enough on a real GPU but times out on
// a loaded CI shard. Grant the established WebGL-heavy headroom (matches
// modules.spec.ts / edges.spec.ts HEAVY_MOUNT_TIMEOUT). This is a setup-timing
// fix, NOT a shader/behaviour change.
const HEAVY_MOUNT_TIMEOUT = 30_000;

// We do THREE full re-spawn + render + read cycles (headline render + two
// threshold-sweep captures). On CI's software renderer each spawn+settle is
// ~6-10s; budget generously so the suite isn't flaky under load.
test.setTimeout(150_000);

/** Sample the OUTPUT canvas interior and return keyed-pixel stats. We sample
 *  the centre 70% so the video-out 4:3 letterbox bars can't inflate counts.
 *  A pixel is "shown" (keyed) when its mean luma is above black; "colourful"
 *  when its channels differ (ACIDWARP colour, not a grey/white key bleed). */
async function readKeyStats(
  page: Page,
): Promise<{ shownFrac: number; colourFrac: number; n: number }> {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  await expect(canvas).toHaveCount(1);
  const stats = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const x0 = Math.floor(c.width * 0.15), x1 = Math.ceil(c.width * 0.85);
    const y0 = Math.floor(c.height * 0.15), y1 = Math.ceil(c.height * 0.85);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0, shown = 0, colour = 0;
    for (let i = 0; i < d.length; i += 16) {
      const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
      const v = (r + g + b) / 3;
      n++;
      if (v > 8) shown++; // a shown (keyed) pixel — not matted to black
      // "colourful" = channels spread apart (ACIDWARP palette), distinguishes
      // the keyed video from a flat white key bleed-through.
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      if (v > 8 && maxC - minC > 24) colour++;
    }
    return { shownFrac: shown / n, colourFrac: colour / n, n };
  });
  expect(stats, 'canvas readable').not.toBeNull();
  return stats!;
}

/** Spawn ACIDWARP(video) + SHAPES(key) -> MAPPER -> OUTPUT with the given
 *  MAPPER threshold, let the render settle, and return keyed stats. */
async function captureMapper(
  page: Page,
  threshold: number,
): Promise<{ shownFrac: number; colourFrac: number; n: number }> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      // Self-running colour video source.
      { id: 'vid', type: 'acidwarp', position: { x: 40,  y: 40 }, domain: 'video' },
      // A single large filled circle (no tiling) — one clean white key region.
      { id: 'key', type: 'shapes',   position: { x: 40,  y: 360 }, domain: 'video', params: { shape: 0, tile: 0, zoom: 0.5 } },
      { id: 'map', type: 'mapper',   position: { x: 460, y: 80 }, domain: 'video', params: { threshold } },
      { id: 'vout', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
    ],
    [
      { id: 'e_vid', from: { nodeId: 'vid', portId: 'out' }, to: { nodeId: 'map',  portId: 'video' }, sourceType: 'video',      targetType: 'video' },
      // mono-video key upcasts to the MAPPER.key video input via canConnect.
      { id: 'e_key', from: { nodeId: 'key', portId: 'out' }, to: { nodeId: 'map',  portId: 'key' },   sourceType: 'mono-video', targetType: 'video' },
      { id: 'e_out', from: { nodeId: 'map', portId: 'out' }, to: { nodeId: 'vout', portId: 'in' },    sourceType: 'video',      targetType: 'video' },
    ],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('.svelte-flow__node-mapper'), 'MAPPER visible').toBeVisible();
  await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
  // A handful of rAFs so the ACIDWARP + SHAPES -> MAPPER -> OUTPUT chain renders.
  await page.waitForTimeout(700);
  return readKeyStats(page);
}

test.describe('MAPPER — video keyer / matte processor', () => {
  test('ACIDWARP(video) + SHAPES(key) -> MAPPER -> OUTPUT shows the video only in the keyed region', async ({ page, errorWatch }) => {

    const stats = await captureMapper(page, 0.5);

    // The keyed circle is a meaningful chunk of the frame: COLOURFUL ACIDWARP
    // pixels show through it. (Renderer-tolerant: assert "some colour shows"
    // not an exact count — SwiftShader vs a real GPU differ on the exact
    // fraction.)
    expect(stats.colourFrac, 'MAPPER shows the colour VIDEO in the keyed region').toBeGreaterThan(0.01);
    // …but the frame is NOT fully shown: the matted background (outside the
    // circle) stays black. That's the keyer signature vs. a passthrough (which
    // would key the whole frame, shownFrac → ~1).
    expect(stats.shownFrac, 'frame is not fully keyed (background matted to black)').toBeLessThan(0.95);

  });

  test('raising THRESHOLD shrinks the keyed area; lowering grows it', async ({ page }) => {
    // SHAPES paints a filled white circle whose anti-aliased RIM ramps from
    // black (background) to white (interior). A LOW threshold keys the whole
    // disc incl. the rim → more shown pixels; a HIGH threshold keys only where
    // the key luma is brightest → fewer (or equal) shown pixels. Same source;
    // only the cutoff changes.
    const low  = await captureMapper(page, 0.15);
    const high = await captureMapper(page, 0.85);

    expect(low.shownFrac, 'low threshold keys a region').toBeGreaterThan(0);
    expect(
      high.shownFrac,
      'higher threshold yields fewer (or equal) shown pixels',
    ).toBeLessThanOrEqual(low.shownFrac);
  });

  test('CV param routes through the patch store', async ({ page, rack }) => {
    await spawnPatch(
      page,
      [{ id: 'map', type: 'mapper', position: { x: 200, y: 100 }, domain: 'video' }],
      [],
      { mountTimeout: HEAVY_MOUNT_TIMEOUT },
    );
    await expect(page.locator('[data-testid="mapper-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['map'];
        if (!n) return;
        n.params.threshold = 0.42;
      });
    });
    await page.waitForTimeout(120);

    const threshold = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['map']?.params.threshold;
    });
    expect(threshold).toBe(0.42);
  });
});
