// e2e/tests/onetonine.spec.ts
//
// ONE TO NINE real-source-chain coverage: a known LIVE video source →
// onetonine.in → videoOut. Asserts (renderer-tolerant, so it holds on CI's
// SwiftShader software renderer):
//   1. the MONITOR (the on-card preview canvas, the canonical surface) is
//      NON-BLANK + structured when the input is driven;
//   2. two REPRESENTATIVE outputs — out1 (top-left) and out9 (bottom-right) —
//      are each non-blank AND spatially DIFFERENT from each other (each is a
//      distinct ninth of the source).
//
// Source chain mirrors the MAPPY / QUADRALOGICAL e2e: LINES (an animated
// generative source, no file/codec needed) → CHROMA (tint) → onetonine.in.
// Reading canvases avoids any dependence on a hardware encoder or a real
// camera — there is neither here.
//
// CAPABILITY NOTE: this is a PURE-GL chain (no getUserMedia, no H.264). The
// only renderer-sensitivity is shader/pixel precision, so assertions use
// count-of-non-black / mean-channel / structural-CHANGE deltas with generous
// thresholds rather than exact pixels. LEAN by design — exactly TWO heavy
// videoOut reads (out1, out9), not nine, to stay inside the CI SwiftShader
// budget (see repo memory ci-swiftshader-video-e2e-timeouts).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

type Page = import('@playwright/test').Page;

type Node = { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> };
type Edge = { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType: string; targetType: string };

/** Coarse, renderer-tolerant stats over a canvas (by locator). */
async function readCanvasStats(page: Page, selector: string) {
  const canvas = page.locator(selector);
  await expect(canvas, `${selector} present`).toHaveCount(1);
  return canvasStats(canvas);
}

type Locator = import('@playwright/test').Locator;

async function canvasStats(canvas: Locator) {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    // A spatial signature (samples weighted by position) so two structurally
    // different crops read as different even at a similar mean brightness.
    let sig = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const v = (r + g + b) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
      sig += (r + g * 2 + b * 3) * ((i % 1009) + 1);
    }
    const mean = sum / n;
    return { mean, variance: sumSq / n - mean * mean, nonZeroFrac: nonZero / n, sig };
  });
}

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

test.describe('ONE TO NINE — 3×3 screen splitter', () => {
  // Pure-GL multi-stage chain; on CI's SwiftShader software renderer spawning
  // LINES→CHROMA + the 9 crops + monitor + canvas reads can exceed the 30s
  // default (the established video-domain budget).
  test.describe.configure({ timeout: 120_000 });

  test('source → onetonine: monitor is structured, and out1 (top-left) ≠ out9 (bottom-right)', async ({ page }) => {
    const errors = await setup(page);

    // Use a LARGE LINES amp so the generative pattern has strong spatial
    // structure that visibly differs between the top-left and bottom-right
    // ninths. TWO videoOut sinks (4plexvid-e2e pattern) — one fed from out1,
    // one from out9 — read independently by data-node-id so we compare the two
    // ninths in a single patch (no re-wire / timing race).
    const nodes: Node[] = [
      { id: 'lines1', type: 'lines', position: { x: 40, y: 60 }, domain: 'video', params: { amp: 24 } },
      // tintMix < 1 so the LINES spatial structure SURVIVES (a full tint
      // flattens the frame to a uniform colour and every ninth becomes
      // identical). A partial red tint keeps a separable colour AND structure.
      { id: 'chroma1', type: 'chroma', position: { x: 260, y: 60 }, domain: 'video', params: { tintR: 1, tintG: 0, tintB: 0, tintMix: 0.5 } },
      { id: 'otn', type: 'onetonine', position: { x: 520, y: 60 }, domain: 'video' },
      { id: 'o1', type: 'videoOut', position: { x: 860, y: 20 }, domain: 'video' },
      { id: 'o9', type: 'videoOut', position: { x: 860, y: 280 }, domain: 'video' },
    ];
    const edges: Edge[] = [
      { id: 'l1', from: { nodeId: 'lines1', portId: 'out' }, to: { nodeId: 'chroma1', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'mi', from: { nodeId: 'chroma1', portId: 'out' }, to: { nodeId: 'otn', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e1', from: { nodeId: 'otn', portId: 'out1' }, to: { nodeId: 'o1', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e9', from: { nodeId: 'otn', portId: 'out9' }, to: { nodeId: 'o9', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);

    await expect(page.locator('[data-testid="onetonine-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="onetonine-canvas"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(2);
    await page.waitForTimeout(800);

    // 1) The MONITOR (the on-card preview = input + grid + numbers) is non-blank
    //    + structured. The amber grid + white digits alone guarantee structure
    //    even if a renderer dims the source.
    const monitor = await readCanvasStats(page, 'canvas[data-testid="onetonine-canvas"]');
    expect(monitor, 'monitor readable').not.toBeNull();
    expect(monitor!.nonZeroFrac, 'monitor NOT all-black (input + grid + numbers)').toBeGreaterThan(0.1);
    expect(monitor!.variance, 'monitor has spatial structure (grid/numbers + live LINES)').toBeGreaterThan(15);

    // 2) out1 (top-left ninth) and out9 (bottom-right ninth), each on its own
    //    videoOut sink — both non-blank AND spatially DIFFERENT from each other.
    const out1 = await canvasStats(page.locator('canvas[data-testid="video-out-canvas"][data-node-id="o1"]'));
    const out9 = await canvasStats(page.locator('canvas[data-testid="video-out-canvas"][data-node-id="o9"]'));
    expect(out1, 'out1 readable').not.toBeNull();
    expect(out9, 'out9 readable').not.toBeNull();
    expect(out1!.nonZeroFrac, 'out1 (top-left crop) is non-blank').toBeGreaterThan(0.05);
    expect(out9!.nonZeroFrac, 'out9 (bottom-right crop) is non-blank').toBeGreaterThan(0.05);

    // The two crops are demonstrably DIFFERENT regions of the source.
    expect(
      out9!.sig,
      `out1 vs out9 are different ninths (sig1=${out1!.sig} sig9=${out9!.sig})`,
    ).not.toBe(out1!.sig);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
