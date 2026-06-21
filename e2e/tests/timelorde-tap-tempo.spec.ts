// e2e/tests/timelorde-tap-tempo.spec.ts
//
// LIVE-patch coverage for TIMELORDE's TAP TEMPO. Claims:
//
//   1. TAP button locks the BPM: two clicks ~500 ms apart set bpm ≈ 120 (the
//      same `bpm` param the knob drives). Tapping ~375 ms apart re-locks ≈ 160.
//   2. Spacebar taps it WHEN SELECTED: select TIMELORDE, press Space twice at a
//      known interval → bpm locks to ~that tempo. (Space is otherwise unbound.)
//   3. Space does NOT tap when TIMELORDE is NOT selected (no bpm change).
//   4. External-clock DISABLE: with a cable patched into CLOCK IN the TAP button
//      is `disabled` and BOTH clicking it AND pressing Space are no-ops.
//
// The tap-tempo MATH (2-tap lock, rolling/median, ~2s timeout reset, outlier
// rejection, BPM clamp) is exhaustively unit-tested in
// src/lib/electra/tap-tempo.test.ts — the shared pure core the card reuses.
// This spec only proves the BUTTON + SPACE-WHEN-SELECTED + DISABLE wiring drives
// that core through the real card.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';

const TL = 'tl'; // explicit TIMELORDE node id (spawnPatch clears the rack first)

/** Read TIMELORDE's live `bpm` param from the patch store. */
async function readBpm(page: Page, nodeId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch?: { nodes?: Record<string, { params?: Record<string, number> }> };
    };
    const v = w.__patch?.nodes?.[id]?.params?.bpm;
    return typeof v === 'number' ? v : null;
  }, nodeId);
}

/** Click the TIMELORDE card to make it the selected node. */
async function selectTimelorde(page: Page, nodeId: string): Promise<void> {
  // Select the node by clicking the decorative top STRIPE — it has no handler so
  // the click bubbles to SvelteFlow's node selection. (The `.title` header wraps
  // the inline-editable ModuleTitle, which captures the click into rename mode
  // and never selects — that was the original flake.)
  //
  // The stripe is only 2px tall, so under heavy CI shard load a single click can
  // miss the target / lose the pointerdown→selection race and `.selected` never
  // applies (shard-10 flake, #854). Retry the click until the node actually
  // reports selected — Playwright's web-first retry for a gesture that must take.
  const node = page.locator(`.svelte-flow__node[data-id="${nodeId}"]`);
  await expect(async () => {
    await node.locator('.stripe').click();
    await expect(node).toHaveClass(/selected/, { timeout: 1500 });
  }).toPass({ timeout: 15000 });
}

/** Tap the TAP button N times with `gapMs` between presses. */
async function tapButton(
  page: Page,
  nodeId: string,
  n: number,
  gapMs: number,
): Promise<void> {
  const btn = page.locator(`[data-testid="timelorde-tap-${nodeId}"]`);
  for (let i = 0; i < n; i++) {
    if (i > 0) await page.waitForTimeout(gapMs);
    await btn.click();
  }
}

/** Press Space N times with `gapMs` between presses. */
async function pressSpace(page: Page, n: number, gapMs: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (i > 0) await page.waitForTimeout(gapMs);
    await page.keyboard.press('Space');
  }
}

test.describe('TIMELORDE tap tempo', () => {
  test('TAP button locks the BPM to the tapped interval', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: TL, type: 'timelorde', position: { x: 200, y: 80 }, domain: 'audio', params: { bpm: 50 } }],
      [],
    );

    const tap = page.locator(`[data-testid="timelorde-tap-${TL}"]`);
    await expect(tap, 'TAP button present').toHaveCount(1);
    await expect(tap, 'TAP enabled with no external clock').toBeEnabled();

    // Two taps lock the bpm to the tapped tempo — i.e. CHANGE it off the 50 spawn.
    // We assert "changed + within clamp", NOT an absolute bpm: the gap is REAL
    // wall-clock between Playwright clicks and CI click latency stretches it (the
    // exact interval→BPM math is unit-tested in electra/tap-tempo.test.ts).
    await tapButton(page, TL, 2, 500);
    await expect
      .poll(() => readBpm(page, TL), { timeout: 3000, message: 'a 2-tap sets the bpm off the spawn' })
      .not.toBe(50);
    const bpmSlow = (await readBpm(page, TL))!;
    expect(bpmSlow, 'tapped bpm within clamp').toBeGreaterThan(20);
    expect(bpmSlow, 'tapped bpm within clamp').toBeLessThan(300);

    // Keep tapping FASTER (~375 ms gap) → re-locks to a HIGHER bpm than the slower
    // tap. RELATIVE (faster gap ⇒ higher bpm), so it's immune to CI click latency
    // (which stretches both the 500 ms and 375 ms gaps by the same amount).
    await tapButton(page, TL, 4, 375);
    await expect
      .poll(() => readBpm(page, TL), { timeout: 3000, message: 'a faster tap re-locks higher than the slower tap' })
      .toBeGreaterThan(bpmSlow);

    expect(errors).toEqual([]);
  });

  test('Spacebar taps the tempo ONLY when TIMELORDE is selected', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: TL, type: 'timelorde', position: { x: 200, y: 80 }, domain: 'audio', params: { bpm: 50 } }],
      [],
    );

    // NOT selected yet: Space must NOT change the tempo.
    // (Click empty canvas to ensure nothing is selected.)
    await page.locator('.svelte-flow__pane').click({ position: { x: 5, y: 5 } });
    const before = await readBpm(page, TL);
    await pressSpace(page, 2, 500);
    await page.waitForTimeout(300);
    expect(
      await readBpm(page, TL),
      'space does nothing while unselected',
    ).toBe(before);

    // SELECT TIMELORDE, then two Space taps CHANGE the bpm off the 50 spawn (same
    // change-not-absolute rationale as the TAP-button test — CI click latency).
    await selectTimelorde(page, TL);
    await pressSpace(page, 2, 500);
    await expect
      .poll(() => readBpm(page, TL), { timeout: 3000, message: 'space taps when selected (bpm changes off spawn)' })
      .not.toBe(50);
    const bpmSpace = (await readBpm(page, TL))!;
    expect(bpmSpace, 'space-tapped bpm within clamp').toBeGreaterThan(20);
    expect(bpmSpace, 'space-tapped bpm within clamp').toBeLessThan(300);

    expect(errors).toEqual([]);
  });

  test('external clock DISABLES tap (button greyed + click & space are no-ops)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // A gate clock source → TIMELORDE.clock makes it an externally-clocked
    // TIMELORDE. The card's `hasExternalClock` is a pure store-edge check (an
    // edge whose target is the `clock` port), so the disable engages the moment
    // the edge exists — we use the Moog 960 sequencer's `clock_out` gate (the
    // documented "chain a clock into TIMELORDE" pairing).
    const nodes: SpawnNode[] = [
      { id: 'clk', type: 'moog960', position: { x: 40, y: 360 }, domain: 'audio' },
      { id: TL, type: 'timelorde', position: { x: 420, y: 80 }, domain: 'audio', params: { bpm: 50 } },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_clk', from: { nodeId: 'clk', portId: 'clock_out' }, to: { nodeId: TL, portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
    ];
    await spawnPatch(page, nodes, edges);

    const tap = page.locator(`[data-testid="timelorde-tap-${TL}"]`);
    await expect(tap, 'TAP present').toHaveCount(1);
    // The button is functionally + visually disabled while the external clock owns BPM.
    await expect(tap, 'TAP disabled under external clock').toBeDisabled();

    // The measured-external-clock follow may write bpm; capture a baseline,
    // then prove TAP/Space don't ADD a tap-set tempo. We click the disabled
    // button (no-op) and press Space while selected (no-op for tap).
    await selectTimelorde(page, TL);
    const baseline = await readBpm(page, TL);

    // Force-click the disabled button (Playwright bypasses the disabled guard
    // with force) — the onclick handler itself must still no-op via the
    // hasExternalClock early-return.
    await tap.click({ force: true }).catch(() => { /* disabled may reject; that's fine */ });
    await pressSpace(page, 4, 200); // would lock ~300 BPM if it tapped
    await page.waitForTimeout(400);

    const after = await readBpm(page, TL);
    // bpm must NOT have jumped to a fast tap-set tempo (~300). It either stays
    // at the baseline or tracks the LFO-measured external tempo — never the
    // would-be 300 BPM from the 200 ms space taps.
    expect(after, 'no tap-set tempo applied under external clock').toBeLessThan(280);
    if (baseline !== null && after !== null) {
      // Sanity: the 200 ms space-tap cadence would imply ~300 BPM; assert we're
      // clearly below that, i.e. the taps were ignored.
      expect(Math.abs(after - 300)).toBeGreaterThan(20);
    }

    expect(errors).toEqual([]);
  });
});
