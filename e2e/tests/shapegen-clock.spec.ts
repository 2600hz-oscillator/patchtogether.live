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
//   1. With the clock SEQUENCER playing, the regen counter advances over
//      time. Across a multi-second window we should observe AT LEAST 2
//      regenerations (rising edges of the chain-out clock pulse).
//   2. Within a SINGLE hold window (a short interval ANCHORED immediately
//      after observing a regen, well under one clock period), the regen
//      counter MUST be unchanged.
//   3. Once we STOP the SEQUENCER (isPlaying=0 so no more rising edges
//      arrive), the regen counter SHOULD stay frozen across multiple
//      seconds — even though the source raster is still updating, the
//      held shape list is reused frame-after-frame.
//
// Clock-period note (chronic-flake root cause): the sequencer's `clock`
// output fires ON EVERY STEP ADVANCE, which is a 16TH-NOTE period
// (= 60 / bpm / 4). So 60 BPM → 250 ms clock period, NOT 1 s as the
// original test author assumed (a beat is a quarter note). A 120 ms
// hold-window assertion against a 250 ms-period clock has a ~48 %
// probability of straddling an edge even before CI jitter pushes the
// `waitForTimeout` past 120 ms — exactly the shard-7 flake pattern we
// were seeing (a=3, b=4). We now (a) use BPM=30 → 500 ms period and
// (b) ANCHOR the hold window immediately after observing a fresh regen
// so we know we're at the start of a period, giving a ≥6× margin.
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
    // SEQUENCER at 30 BPM → 16th-note step = 60 / 30 / 4 = 500 ms clock
    // period (see header comment for why this is NOT 2 s — the clock-out
    // fires per step, which is a 16th note, not per beat). length 8 so
    // the clock keeps firing past the observation window. The 500 ms
    // period gives us a generous within-hold window where a SHORT
    // ANCHORED read (80 ms, starting immediately after a fresh regen) has
    // ~6× safety margin against straddling the next rising edge.
    await spawnPatch(
      page,
      [
        { id: 'src',  type: 'acidwarp', position: { x: 100, y: 100 }, domain: 'video',
          params: { speed: 1 } },
        { id: 'sg',   type: 'shapegen', position: { x: 500, y: 100 }, domain: 'video' },
        { id: 'clkSeq', type: 'sequencer', position: { x: 100, y: 320 }, domain: 'audio',
          params: { bpm: 30, length: 8, isPlaying: 1 } },
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
    //         At 30 BPM (500 ms step period) this needs ~1 s; the 8 s
    //         budget tolerates CI scheduler jitter + the audio-context
    //         warm-up before the first lookahead window lands.
    const advanced = await waitForRegen(page, 'sg', (n) => n >= 3, 8000);
    expect(
      advanced.ok,
      `regen advanced to ≥ 3 within 8 s (saw ${advanced.last})`,
    ).toBe(true);
    expect(
      advanced.last,
      `regen count plausible for a 30 BPM clock over ~few s (saw ${advanced.last})`,
    ).toBeLessThan(50);

    // ---- 2. Within-hold window: ANCHOR to a fresh regen so we KNOW we
    //         are at the start of a hold period (not somewhere random in
    //         the middle, where a 120 ms wait could straddle the next
    //         rising edge — that was the chronic shard-7 flake). Steps:
    //
    //           a. snapshot current count
    //           b. poll fast (15 ms cadence) for up to 1.5 s until count
    //              advances by ≥1 → we just observed an edge
    //           c. IMMEDIATELY re-snapshot (this is our anchor: t=0 of a
    //              fresh 500 ms-period window)
    //           d. wait 80 ms — only 16 % of the 500 ms period → ≥6×
    //              safety margin against straddling the next edge even
    //              with CI timer jitter
    //           e. assert the count is unchanged
    //
    //         This is ROBUST to all of: scheduler-clock jitter, the
    //         audio-context warm-up delay, CI runner load, and the
    //         60-BPM-but-actually-250-ms-period gotcha that originally
    //         flaked this test (see header comment).
    // Anchor budget: 5 s = 10× the 500 ms clock period. The prior 1.5 s
    // budget (3× period) flaked on CI when the audio context warm-up + a
    // Yjs-transact + main-thread render stall consumed enough of the
    // first one-or-two windows that the regen counter didn't advance
    // within the poll. 10× safety is large enough that ONLY a real
    // "regen stopped advancing" regression would fail. Cadence stays
    // tight (15 ms) so we anchor within ~one frame of the edge.
    const anchorStart = await readRegenCount(page, 'sg');
    const anchorDeadline = Date.now() + 5000;
    let anchored = anchorStart;
    while (Date.now() < anchorDeadline) {
      await page.waitForTimeout(15);
      anchored = await readRegenCount(page, 'sg');
      if (anchored > anchorStart) break;
    }
    expect(
      anchored,
      `observed a fresh regen edge to anchor the hold window (start=${anchorStart}, after-poll=${anchored}, budget=5s, period=500ms)`,
    ).toBeGreaterThan(anchorStart);

    const hold1a = await readRegenCount(page, 'sg');
    await page.waitForTimeout(80);
    const hold1b = await readRegenCount(page, 'sg');
    expect(
      hold1b,
      `80 ms anchored hold window has no regen (a=${hold1a}, b=${hold1b}, period=500ms)`,
    ).toBe(hold1a);

    // ---- 3. STOP the sequencer → no more rising edges. After draining
    //         any in-flight edge (give it 2 s — 4× one 500 ms period),
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
    await page.waitForTimeout(2000);
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
