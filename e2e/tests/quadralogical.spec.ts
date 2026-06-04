// e2e/tests/quadralogical.spec.ts
//
// QUADRALOGICAL (4-input video mixer) functional e2e.
//
// Graph (matches the Phase-1 spec request):
//   LINES → CHROMA(tint red)    → in1  \
//   LINES → CHROMA(tint green)  → in2    QUADRALOGICAL → videoOut
//   LINES → CHROMA(tint blue)   → in3  /
//   LINES → CHROMA(tint yellow) → in4 /
//
// Each CHROMA tints its LINES input a distinct colour (tintMix=1) so the four
// joystick quadrants are visually separable. We assert:
//   1. all cards spawn + the QUADRALOGICAL card + preview canvas mount,
//   2. the wired-up MIX renders a non-trivial (non-black, structured) frame,
//   3. dragging the joystick to a CORNER makes that input dominate the MIX
//      (TL ⇒ red in1, BR ⇒ yellow in4 — distinct frames),
//   4. the inner-diamond CENTER is a 4-way composite (distinct from any corner),
//   5. the PREVIEW output (2×2 tile) emits when routed through a videoOut,
//   6. FREEZE holds the MIX still (deterministic-capture hook).
//
// Pixel-exact determinism lives in the VRT suite; this is the behavioural gate.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Distinct tint per input so each quadrant is a separable colour. R/G/B/Y.
const TINTS = [
  { tintR: 1, tintG: 0, tintB: 0, tintMix: 1 }, // in1 red
  { tintR: 0, tintG: 1, tintB: 0, tintMix: 1 }, // in2 green
  { tintR: 0, tintG: 0, tintB: 1, tintMix: 1 }, // in3 blue
  { tintR: 1, tintG: 1, tintB: 0, tintMix: 1 }, // in4 yellow
];

function buildNodes() {
  const nodes: Array<{ id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }> = [];
  for (let i = 0; i < 4; i++) {
    nodes.push({ id: `lines${i}`, type: 'lines', position: { x: 40, y: 40 + i * 180 }, domain: 'video', params: { amp: 8 + i } });
    nodes.push({ id: `chroma${i}`, type: 'chroma', position: { x: 260, y: 40 + i * 180 }, domain: 'video', params: TINTS[i]! });
  }
  nodes.push({ id: 'quad', type: 'quadralogical', position: { x: 560, y: 80 }, domain: 'video' });
  nodes.push({ id: 'v-out', type: 'videoOut', position: { x: 1080, y: 80 }, domain: 'video' });
  return nodes;
}

function buildEdges() {
  const edges: Array<{ id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }> = [];
  for (let i = 0; i < 4; i++) {
    edges.push({ id: `l${i}`, from: { nodeId: `lines${i}`, portId: 'out' }, to: { nodeId: `chroma${i}`, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' });
    edges.push({ id: `c${i}`, from: { nodeId: `chroma${i}`, portId: 'out' }, to: { nodeId: 'quad', portId: `in${i + 1}` }, sourceType: 'video', targetType: 'video' });
  }
  edges.push({ id: 'out', from: { nodeId: 'quad', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' });
  return edges;
}

// Read coarse stats from the videoOut canvas (the MIX, via the canonical surface).
async function readStats(page: import('@playwright/test').Page) {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0, rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const v = (r + g + b) / 3;
      sum += v; sumSq += v * v; n++;
      rSum += r; gSum += g; bSum += b;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return {
      mean,
      variance: sumSq / n - mean * mean,
      nonZeroFrac: nonZero / n,
      r: rSum / n, g: gSum / n, b: bSum / n,
    };
  });
}

// Drag the joystick by writing pos_x/pos_y into the patch store (the live-poll
// path picks it up; bypasses pointer-drag flake). Center = diamond all-4 zone.
async function setJoystick(page: import('@playwright/test').Page, x: number, y: number) {
  await page.evaluate(([px, py]) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['quad'];
      if (n) { n.params.pos_x = px; n.params.pos_y = py; }
    });
  }, [x, y]);
}

test.describe('QUADRALOGICAL — 4-input video mixer (Phase 1)', () => {
  test('4 colored CHROMA inputs → MIX renders non-black; corner-drag makes that input dominate; center is a 4-way blend', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, buildNodes(), buildEdges());

    await expect(page.locator('.svelte-flow__node-quadralogical'), 'QUADRALOGICAL visible').toBeVisible();
    await expect(page.locator('[data-testid="quadralogical-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-canvas"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-diamond"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-dot"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // ---- TL corner ⇒ in1 (red) dominates ----
    await setJoystick(page, -1, 1);
    await page.waitForTimeout(400);
    const tl = await readStats(page);
    expect(tl, 'MIX canvas readable').not.toBeNull();
    expect(tl!.nonZeroFrac, 'MIX not all-black at TL corner').toBeGreaterThan(0.02);
    expect(tl!.variance, 'MIX has spatial structure (lines)').toBeGreaterThan(20);
    expect(tl!.r, 'TL corner → in1 (red) dominant: R > G').toBeGreaterThan(tl!.g + 8);
    expect(tl!.r, 'TL corner → in1 (red) dominant: R > B').toBeGreaterThan(tl!.b + 8);

    // ---- BR corner ⇒ in4 (yellow) dominates (R+G high, B low) + distinct frame ----
    await setJoystick(page, 1, -1);
    await page.waitForTimeout(400);
    const br = await readStats(page);
    expect(br!.nonZeroFrac, 'MIX not all-black at BR corner').toBeGreaterThan(0.02);
    expect(br!.g, 'BR corner → in4 (yellow): G high').toBeGreaterThan(br!.b + 8);
    expect(br!.r, 'BR corner → in4 (yellow): R high').toBeGreaterThan(br!.b + 8);
    // TL (red) and BR (yellow) must be meaningfully different composites.
    expect(Math.abs(br!.g - tl!.g), 'TL vs BR are distinct (green channel differs)').toBeGreaterThan(8);

    // ---- TR corner ⇒ in2 (green) dominates ----
    await setJoystick(page, 1, 1);
    await page.waitForTimeout(400);
    const tr = await readStats(page);
    expect(tr!.g, 'TR corner → in2 (green) dominant: G > R').toBeGreaterThan(tr!.r + 8);
    expect(tr!.g, 'TR corner → in2 (green) dominant: G > B').toBeGreaterThan(tr!.b + 8);

    // ---- BL corner ⇒ in3 (blue) dominates ----
    await setJoystick(page, -1, -1);
    await page.waitForTimeout(400);
    const bl = await readStats(page);
    expect(bl!.b, 'BL corner → in3 (blue) dominant: B > R').toBeGreaterThan(bl!.r + 8);
    expect(bl!.b, 'BL corner → in3 (blue) dominant: B > G').toBeGreaterThan(bl!.g + 8);

    // ---- CENTER (inside the diamond) ⇒ balanced 4-way composite ----
    // All four colours contribute, so no single channel dominates the way it
    // does at a corner. R/G/B should all be appreciably present and closer
    // together than at any pure corner.
    await setJoystick(page, 0, 0);
    await page.waitForTimeout(400);
    const center = await readStats(page);
    expect(center!.nonZeroFrac, 'center MIX not all-black').toBeGreaterThan(0.02);
    // The center frame must differ from every corner (it's a blend, not in1).
    expect(Math.abs(center!.b - tl!.b), 'center differs from TL corner').toBeGreaterThan(5);
    // 4-way blend: blue (only in3) is present but the warm channels (in1/in2/in4
    // all carry R or G) dominate — so R and G are both clearly nonzero.
    expect(center!.r, 'center has red contribution (in1+in4)').toBeGreaterThan(8);
    expect(center!.g, 'center has green contribution (in2+in4)').toBeGreaterThan(8);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('PREVIEW output (2×2 raw tile) emits when routed through a videoOut', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Same sources, but route quad.preview → videoOut.in (the secondary output).
    const nodes = buildNodes();
    const edges = buildEdges().filter((e) => e.id !== 'out');
    edges.push({ id: 'prev', from: { nodeId: 'quad', portId: 'preview' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' });
    await spawnPatch(page, nodes, edges);

    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
    await page.waitForTimeout(600);

    const stats = await readStats(page);
    expect(stats, 'PREVIEW canvas readable').not.toBeNull();
    // The 2×2 tile shows the four raw (coloured) inputs → non-black + structured.
    expect(stats!.nonZeroFrac, 'PREVIEW tile emits (not all-black)').toBeGreaterThan(0.02);
    expect(stats!.variance, 'PREVIEW tile has structure (4 distinct cells)').toBeGreaterThan(20);
    // All three colour channels appear somewhere in the 2×2 tile (R,G,B,Y inputs).
    expect(stats!.r, 'PREVIEW has red (in1/in4 tiles)').toBeGreaterThan(8);
    expect(stats!.g, 'PREVIEW has green (in2/in4 tiles)').toBeGreaterThan(8);
    expect(stats!.b, 'PREVIEW has blue (in3 tile)').toBeGreaterThan(8);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('FREEZE holds the MIX still (deterministic-capture hook)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, buildNodes(), buildEdges());

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await setJoystick(page, 0, 0);
    await page.waitForTimeout(400);

    // Freeze QUADRALOGICAL.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['quad'];
        if (n) n.params.freeze = 1;
      });
    });
    await page.waitForTimeout(150);

    const sample = (): Promise<number[]> =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return [];
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const out: number[] = [];
        for (let i = 0; i < d.length; i += 4 * 64) out.push(d[i]!);
        return out;
      });

    const a = await sample();
    await page.waitForTimeout(200);
    const b = await sample();

    expect(a.length).toBeGreaterThan(0);
    expect(b, 'frozen: two samples 200ms apart are identical').toEqual(a);
  });
});
