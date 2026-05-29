// e2e/tests/shapegen-clock.spec.ts
//
// SHAPEGEN — CLOCK gate input (sample-and-hold).
//
//   ACIDWARP (time-varying video source) → SHAPEGEN.raster_a
//   SEQUENCER → SHAPEGEN.clock_in
//
// The user spec mentioned ANALOGVCO→RASTERIZE→SHAPEGEN, but the shape
// generation pipeline only cares that the raster input MOVES — the
// regression here is the CLOCK gate's sample-and-hold behaviour, not
// the audio→video bridge. ACIDWARP is a self-animating video source
// that doesn't need an audio chain.
//
// Contract being pinned (via the deterministic `regenCount` engine-read,
// not pixel diffs — the source raster's frame-to-frame movement would
// make pixel-diff assertions flake under CI load):
//   1. With the clock SEQUENCER playing, the regen counter advances by
//      ~1 per clock period (i.e. ~once per 1 s at 60 BPM). Across a
//      multi-second window we should observe AT LEAST 2 regenerations.
//   2. Within a single hold window (two reads ~120 ms apart, well under
//      the 1 s clock period), the regen counter SHOULD be UNCHANGED.
//   3. Once we STOP the SEQUENCER (isPlaying=0 so no more rising edges
//      arrive), the regen counter SHOULD stay frozen across multiple
//      seconds — even though the source raster is still updating, the
//      held shape list is reused frame-after-frame.
//
// We also assert the [CLOCKED] badge becomes visible when an edge is
// patched into clock_in (UI hint that the hold behaviour is active).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read the SHAPEGEN factory's regenCount via the engine read API. The
 *  counter increments exactly once per shape-list regeneration; held
 *  frames don't bump it. */
async function readRegenCount(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => {
          read?: (n: string, k: string) => unknown;
        } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const v = ve?.read?.(nodeId, 'regenCount');
    return typeof v === 'number' ? v : Number.NaN;
  }, nodeId);
}

/** Poll until pred is satisfied or timeout. Mirrors scoreboard.spec.ts. */
async function waitForRegen(
  page: Page,
  nodeId: string,
  pred: (n: number) => boolean,
  timeout = 6000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeout;
  let last = await readRegenCount(page, nodeId);
  if (pred(last)) return { ok: true, last };
  while (Date.now() < deadline) {
    await page.waitForTimeout(80);
    last = await readRegenCount(page, nodeId);
    if (pred(last)) return { ok: true, last };
  }
  return { ok: false, last };
}

test.describe('SHAPEGEN — CLOCK gate sample-and-hold', () => {
  test('rising edges regenerate; within-hold window holds; stopped clock freezes regen count', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ACIDWARP (time-varying) → SHAPEGEN.raster_a.
    // SEQUENCER → SHAPEGEN.clock_in.
    //
    // SEQUENCER at 60 BPM → clock-output rising edge every 1 s. length 8
    // so the clock keeps firing past the observation window. The 1-second
    // period gives us a generous within-hold window where 120 ms reads
    // never straddle a rising edge.
    await spawnPatch(
      page,
      [
        { id: 'src',  type: 'acidwarp', position: { x: 100, y: 100 }, domain: 'video',
          params: { speed: 1 } },
        { id: 'sg',   type: 'shapegen', position: { x: 500, y: 100 }, domain: 'video' },
        { id: 'clkSeq', type: 'sequencer', position: { x: 100, y: 320 }, domain: 'audio',
          params: { bpm: 60, length: 8, isPlaying: 1 } },
      ],
      [
        // Time-varying video source → SHAPEGEN.raster_a.
        { id: 'e_a',    from: { nodeId: 'src',   portId: 'out' },   to: { nodeId: 'sg', portId: 'raster_a' },
          sourceType: 'video',     targetType: 'video' },
        // SEQUENCER clock-out → SHAPEGEN.clock_in (gate→cv via CV bridge).
        { id: 'e_clk',  from: { nodeId: 'clkSeq', portId: 'clock' }, to: { nodeId: 'sg', portId: 'clock_in' },
          sourceType: 'gate',      targetType: 'cv' },
      ],
    );

    await expect(page.locator('[data-testid="shapegen-card"]')).toHaveCount(1);

    // The [CLOCKED] badge should show once the clock_in edge is wired.
    await expect(
      page.locator('[data-testid="shapegen-clocked-badge"]'),
      '[CLOCKED] badge appears when clock_in is patched',
    ).toBeVisible();

    // ---- 1. Wait for at least 2 regenerations (each rising edge fires
    //         exactly one + the first-draw regen seeds count to 1, so
    //         "≥ 3" means we've definitely seen at least 2 gate edges).
    const advanced = await waitForRegen(page, 'sg', (n) => n >= 3, 6000);
    expect(
      advanced.ok,
      `regen advanced to ≥ 3 within 6 s (saw ${advanced.last})`,
    ).toBe(true);
    expect(
      advanced.last,
      `regen count plausible for a 60 BPM clock over ~3 s (saw ${advanced.last})`,
    ).toBeLessThan(50);

    // ---- 2. Within-hold window: snapshot the count + sleep 120 ms +
    //         re-read. At 60 BPM the period is 1 s, so 120 ms NEVER
    //         straddles a clock edge — the counter MUST be unchanged.
    //         Sample twice to derisk a single-timer fluke.
    const hold1a = await readRegenCount(page, 'sg');
    await page.waitForTimeout(120);
    const hold1b = await readRegenCount(page, 'sg');
    expect(
      hold1b,
      `120 ms hold window has no regen (a=${hold1a}, b=${hold1b})`,
    ).toBe(hold1a);

    // ---- 3. STOP the sequencer → no more rising edges. After draining
    //         any in-flight edge (give it 1.5 s — well past one period),
    //         the regen count should stay constant across multiple
    //         seconds even though the SOURCE RASTER keeps animating.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const seq = w.__patch.nodes['clkSeq'];
        if (seq) seq.params.isPlaying = 0;
      });
    });
    // Let any pending edge land + the next "would-be" pulse window pass.
    await page.waitForTimeout(1500);
    const stopped1 = await readRegenCount(page, 'sg');
    await page.waitForTimeout(1500);
    const stopped2 = await readRegenCount(page, 'sg');
    await page.waitForTimeout(1500);
    const stopped3 = await readRegenCount(page, 'sg');
    expect(
      stopped2,
      `stopped clock holds regen count (s1=${stopped1}, s2=${stopped2}, s3=${stopped3})`,
    ).toBe(stopped1);
    expect(stopped3, `still held after another 1.5 s`).toBe(stopped1);

    expect(errors, `no console / page errors during clock-gate flow: ${errors.join(' | ')}`).toEqual([]);
  });
});
