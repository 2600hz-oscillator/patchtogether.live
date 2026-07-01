// e2e/tests/destructor-render-smoke.spec.ts
//
// DRS for DESTRUCTOR (the mangle/glitch video processor). This is the
// param→PIXELS half of the deleted video-phase1.spec.ts, whose ONE test proved
// "an audio LFO on DESTRUCTOR.mangle moves the rendered pixels" by sleeping
// through LFO phases + diffing global canvas stats (three un-synchronized
// clocks, the canonical wall-clock flake). The two claims split cleanly:
//
//   - the LFO→param MAPPING is pure and lives in cv-bridge-map.test.ts (bound
//     to the real destructorDef — no GL, no clock);
//   - the param→PIXELS half is HERE: with the engine clock frozen + the rAF
//     loop paused (DRS), set mangle to two well-separated values DIRECTLY (no
//     LFO phase to alias), step a fixed number of frames each time, read
//     DESTRUCTOR's OWN output FBO once, and assert (a) both clear the standard
//     renderer-tolerant floors and (b) the two frames measurably DIFFER.
//
// LINES (a structured `frame.time` source — frozen, so it renders an identical
// frame every step) feeds DESTRUCTOR so mangle has real content to mangle.
// Renderer-tolerant throughout (SwiftShader on CI vs a real GPU agree on the
// FLOORS + that mangle changes the frame, never on exact pixels).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

/** Set a video node param through the engine domain's setParam — the same entry
 *  point the CV bridge uses. DESTRUCTOR's setParam mutates the live params the
 *  shader reads, so the NEXT step() renders with the new value. Synchronous +
 *  deterministic (no store round-trip, no clock). */
async function setVideoParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(({ nodeId, paramId, value }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { setParam: (n: string, p: string, v: number) => void } };
    };
    w.__engine().getDomain('video').setParam(nodeId, paramId, value);
  }, { nodeId, paramId, value });
}

async function spawnLinesDestructor(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  // shift + scanline cranked so mangle (the master CV that scales them) has a
  // large effect between 0 and 1 — maximises the renderer-tolerant frame delta.
  await spawnPatch(
    page,
    [
      { id: 'v-lines', type: 'lines',      position: { x: 40,  y: 40 }, domain: 'video' },
      { id: 'v-destr', type: 'destructor', position: { x: 360, y: 40 }, domain: 'video', params: { shift: 0.9, scanline: 0.9, posterize: 0.3, mangle: 0.7 } },
      { id: 'v-out',   type: 'videoOut',   position: { x: 700, y: 40 }, domain: 'video' },
    ],
    [
      { id: 'e-lines-destr', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-destr', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'e-destr-out',   from: { nodeId: 'v-destr', portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' }, sourceType: 'video',      targetType: 'video' },
    ],
  );
}

test.describe('DESTRUCTOR — deterministic render smoke', () => {
  test('freeze + pause + step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await spawnLinesDestructor(page);

    // DESTRUCTOR's own output FBO renders mangled LINES — non-black + structured.
    const a = await stepAndReadStats(page, { nodeId: 'v-destr', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // Determinism: a second burst (clock still frozen, mangle unchanged) is
    // frame-stable to a tight epsilon — the property the wall-clock test lacked.
    const b = await stepAndReadStats(page, { nodeId: 'v-destr', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output frame-stable (mean ${a.mean.toFixed(2)} vs ${b.mean.toFixed(2)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });

  test('mangle 0 → 1 changes the rendered frame (the param→pixels bridge claim)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await spawnLinesDestructor(page);

    // mangle = 0: shift/scanline scale to ~identity (LINES, posterized).
    await setVideoParam(page, 'v-destr', 'mangle', 0);
    const low = await stepAndReadStats(page, { nodeId: 'v-destr', steps: FIXED_STEPS });
    assertRenderStats(low, FIXED_STEPS);

    // mangle = 1: full channel-shift + scanline darkening — a visibly different
    // frame on the SAME frozen LINES content.
    await setVideoParam(page, 'v-destr', 'mangle', 1);
    const high = await stepAndReadStats(page, { nodeId: 'v-destr', steps: FIXED_STEPS });
    assertRenderStats(high, FIXED_STEPS);

    // The frames must DIFFER. Both mean (scanline darkens) and variance (channel
    // shift restructures) respond to mangle; take the larger RELATIVE delta and
    // require a tolerant floor (renderer-tolerant — SwiftShader agrees mangle
    // changes the frame, not on the exact amount). The mapping itself is proven
    // exactly in cv-bridge-map.test.ts; this only proves mangle reaches pixels.
    const meanScale = Math.max(1, low.mean, high.mean);
    const varScale = Math.max(1, low.variance, high.variance);
    const meanRel = Math.abs(high.mean - low.mean) / meanScale;
    const varRel = Math.abs(high.variance - low.variance) / varScale;
    const moved = Math.max(meanRel, varRel);
    expect(
      moved,
      `mangle 0→1 moves the frame (meanRel=${meanRel.toFixed(3)}, varRel=${varRel.toFixed(3)}; ` +
        `low mean=${low.mean.toFixed(1)} var=${low.variance.toFixed(1)}, high mean=${high.mean.toFixed(1)} var=${high.variance.toFixed(1)})`,
    ).toBeGreaterThan(0.02);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
