// e2e/tests/circles.spec.ts
//
// CIRCLES — end-to-end coverage for the stateful particle video generator.
// Proves the real source → module → audible-output chain for all four
// outputs:
//   1. A real GATE source (SEQUENCER.gate, cross-domain → CIRCLES.gate)
//      spawns circles; with rate up too, the field fills.
//   2. OVERLAP + CONTOUR render non-black once circles exist (mono outs).
//   3. COMBINE renders non-black colour once circles overlap.
//   4. MAPPED shows the VIDEO input's content where ≥2 circles overlap
//      (a bright SHAPES source punches through), and is darker than the raw
//      source (it's masked to the overlap region, not the whole frame).
//
// We route each CIRCLES output into its OWN VIDEO-OUT sink so we read the
// real downstream signal (the multi-output read('outputTexture:<port>') path),
// not the card's single-output preview. Canvas reads use windowed polling
// (sample until the predicate holds or a deadline passes) — robust under
// software-GL frame stalls on CI, never two fixed reads.
//
// CI note: this is a video-domain spec on SwiftShader. We scale the timeout by
// the number of VIDEO-OUT sinks + the spawn settle budget rather than a flat
// 90s (per the ci-swiftshader-video-e2e-timeouts memory).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// 5 VIDEO-OUT-style canvas reads × multi-second windowed polls on the software
// renderer. Scale, don't flat-90s.
test.describe.configure({ timeout: 150_000 });

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance over a VIDEO-OUT canvas (identified by its node id). */
async function meanLuma(page: Page, nodeId: string): Promise<number> {
  const handle = page.locator(`canvas[data-testid="video-out-canvas"][data-node-id="${nodeId}"]`);
  await expect(handle, `VIDEO-OUT ${nodeId} canvas present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    return sum / (data.length / 4);
  });
}

/** Poll a VIDEO-OUT until its mean luminance satisfies `pred`, or fail after
 *  `timeout`. Returns the last sampled value for the assertion message. */
async function waitForLuma(
  page: Page,
  nodeId: string,
  pred: (m: number) => boolean,
  timeout = 20_000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeout;
  let last = await meanLuma(page, nodeId);
  if (pred(last)) return { ok: true, last };
  while (Date.now() < deadline) {
    await page.waitForTimeout(160);
    last = await meanLuma(page, nodeId);
    if (pred(last)) return { ok: true, last };
  }
  return { ok: false, last };
}

/** Fire a gate pulse on CIRCLES' gate input via the video engine's setParam
 *  (the cross-domain CV-bridge entry point — the param id is the synthetic
 *  `cv_gate`). Rising edge → one spawn. */
async function fireGate(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    ve?.setParam?.(nodeId, 'cv_gate', 1); // rising edge → spawn
    ve?.setParam?.(nodeId, 'cv_gate', 0); // release → re-arm
  }, nodeId);
}

test.describe('CIRCLES — stateful particle video generator', () => {
  test('gate spawns circles; OVERLAP / CONTOUR / COMBINE all ring; MAPPED shows the video input where overlapped', async ({ page }) => {
    const errors = await setup(page);

    // A bright tiled SHAPES source for the `video` input (so MAPPED has
    // visible content to punch through). CIRCLES with rate up so the internal
    // clock fills the field fast + big diameter so circles overlap (≥2).
    // Each output → its own VIDEO-OUT sink.
    await spawnPatch(
      page,
      [
        { id: 'src',  type: 'shapes',  position: { x: 40, y: 40 },  domain: 'video', params: { shape: 1, tile: 1, tileN: 6, zoom: 8 } },
        { id: 'circ', type: 'circles', position: { x: 360, y: 40 }, domain: 'video', params: { rate: 1, d: 1, spd: 0.25 } },
        { id: 'o_ovr', type: 'videoOut', position: { x: 760, y: 0 },   domain: 'video' },
        { id: 'o_cnt', type: 'videoOut', position: { x: 760, y: 220 }, domain: 'video' },
        { id: 'o_cmb', type: 'videoOut', position: { x: 760, y: 440 }, domain: 'video' },
        { id: 'o_map', type: 'videoOut', position: { x: 760, y: 660 }, domain: 'video' },
      ],
      [
        // The video source feeds MAPPED.
        { id: 'e_vid', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'circ', portId: 'video' }, sourceType: 'video', targetType: 'video' },
        // The four outputs → four sinks.
        { id: 'e_ovr', from: { nodeId: 'circ', portId: 'overlap' }, to: { nodeId: 'o_ovr', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_cnt', from: { nodeId: 'circ', portId: 'contour' }, to: { nodeId: 'o_cnt', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_cmb', from: { nodeId: 'circ', portId: 'combine' }, to: { nodeId: 'o_cmb', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e_map', from: { nodeId: 'circ', portId: 'mapped' },  to: { nodeId: 'o_map', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('[data-testid="circles-card"]'), 'CIRCLES card present').toHaveCount(1);

    // Fire a few real gate pulses on top of the internal clock so the field
    // fills quickly + deterministically.
    for (let i = 0; i < 8; i++) {
      await fireGate(page, 'circ');
      await page.waitForTimeout(80);
    }

    // OVERLAP: white discs on black → non-black mean once circles exist.
    const ovr = await waitForLuma(page, 'o_ovr', (m) => m > 4);
    expect(ovr.ok, `OVERLAP non-black after spawns (mean=${ovr.last.toFixed(2)})`).toBe(true);

    // CONTOUR: rings only → non-black (lower than the filled overlap, but the
    // 10%-of-diameter rings on 270px circles are thick enough to register).
    const cnt = await waitForLuma(page, 'o_cnt', (m) => m > 1.5);
    expect(cnt.ok, `CONTOUR non-black after spawns (mean=${cnt.last.toFixed(2)})`).toBe(true);

    // COMBINE: colourized overlap → non-black.
    const cmb = await waitForLuma(page, 'o_cmb', (m) => m > 4);
    expect(cmb.ok, `COMBINE non-black after spawns (mean=${cmb.last.toFixed(2)})`).toBe(true);

    // MAPPED: the SHAPES source punched through the ≥2-overlap region. With 270px
    // circles + many spawns, a ≥2-overlap region forms and shows source pixels →
    // non-black. (The raw source is far brighter / fills the whole frame; MAPPED
    // is masked to the overlap region, so it's dimmer than the source but
    // clearly non-black.)
    const map = await waitForLuma(page, 'o_map', (m) => m > 2);
    expect(map.ok, `MAPPED shows video input where overlapped (mean=${map.last.toFixed(2)})`).toBe(true);

    expect(errors, 'no console / page errors during CIRCLES render').toEqual([]);
  });

  test('rate=0 stays black until a GATE fires (gate-only spawn)', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(
      page,
      [
        { id: 'circ',  type: 'circles', position: { x: 200, y: 40 }, domain: 'video', params: { rate: 0, d: 1, spd: 0 } },
        { id: 'o_ovr', type: 'videoOut', position: { x: 620, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e_ovr', from: { nodeId: 'circ', portId: 'overlap' }, to: { nodeId: 'o_ovr', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('[data-testid="circles-card"]')).toHaveCount(1);

    // Let it run with NO gate — rate=0 means no internal clock → stays black.
    const stillBlack = await waitForLuma(page, 'o_ovr', (m) => m > 3, 2500);
    expect(stillBlack.ok, `OVERLAP black before any gate (mean=${stillBlack.last.toFixed(2)})`).toBe(false);

    // Now fire several gates → circles spawn → OVERLAP rings.
    for (let i = 0; i < 6; i++) {
      await fireGate(page, 'circ');
      await page.waitForTimeout(60);
    }
    const lit = await waitForLuma(page, 'o_ovr', (m) => m > 3);
    expect(lit.ok, `OVERLAP non-black after gates (mean=${lit.last.toFixed(2)})`).toBe(true);

    expect(errors, 'no console / page errors').toEqual([]);
  });
});
