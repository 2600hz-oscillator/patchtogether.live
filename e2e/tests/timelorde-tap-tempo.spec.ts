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
// ⚠ THE MODULE'S OWN MATH, IMPORTED RATHER THAN RESTATED. `clampBpm` and
// `median` are the exact functions `TapTempo` runs, and `TAP_HISTORY` is the
// ring depth the eviction argument below depends on. Re-implementing any of the
// three here would let this spec agree with a stale copy of the product while
// the product changed underneath it.
import {
  TAP_HISTORY,
  clampBpm,
  median,
} from '../../packages/web/src/lib/electra/tap-tempo';

const TL = 'tl'; // explicit TIMELORDE node id (spawnPatch clears the rack first)

/** The two tap tempi this spec contrasts, as PAGE-SIDE gaps in ms.
 *  A clean 2x (100 vs 200 BPM) so the "faster locks higher" ordering has 300 ms
 *  of headroom instead of the 125 ms that made it flake, and both land well
 *  inside the module's 10-300 clamp. */
const SLOW_GAP_MS = 600;
const FAST_GAP_MS = 300;

/**
 * How closely the locked BPM must match the one DERIVED from the measured
 * interval, as a fraction of the expected value.
 *
 * ⚠ IT IS RELATIVE, AND IT IS NOT ZERO, because the stamps this spec collects
 * are a PROXY for the ones the module used. `tapInPage` records
 * `performance.now()` immediately before `btn.click()`; `tap()` records its own
 * `performance.now()` INSIDE the synchronous handler. The gap between them is
 * the click-dispatch cost — sub-millisecond, but never zero, and it grows on a
 * starved main thread.
 *
 * MEASURED ON CI (#2056, the run that caught this): the module locked
 * 99.40357852883088 BPM where this spec's stamps implied 99.34268258357663 —
 * a 604.0 ms proxy interval against a 603.63 ms real one, i.e. **0.37 ms of
 * dispatch** showing up as **0.061 BPM**. The first version of this leg asked
 * for agreement within 0.05 BPM and was therefore asserting that the dispatch
 * cost is zero.
 *
 * ⚠ AND THE FIRST VERSION ASKED FOR THAT BY ACCIDENT, which is the part worth
 * remembering: it used `toBeCloseTo(expected, 1)` meaning to allow 1 BPM.
 * Jest/Playwright precision is `0.5 x 10^-n`, so `1` is ±0.05 — twenty times
 * tighter than intended, in an assertion whose own message printed "units:
 * BPM". A units error inside the units annotation.
 *
 * 1 % is ~16x the measured proxy error at these tempi and ~50x smaller than the
 * smallest defect worth catching (the negative control halves the BPM), so it
 * discriminates the thing under test without asserting anything about the
 * runner.
 */
const BPM_MATCH_TOLERANCE = 0.01;

/** Assert a locked BPM matches the one implied by the interval ACTUALLY tapped,
 *  printing both sides, the delta and the allowance — so a future drift is
 *  legible from the failure line alone rather than needing a re-run. */
function expectBpmMatchesInterval(
  actualBpm: number,
  intervalMs: number,
  label: string,
  detail = '',
): void {
  const expected = clampBpm(60000 / intervalMs);
  const allowed = expected * BPM_MATCH_TOLERANCE;
  const delta = Math.abs(actualBpm - expected);
  expect(
    delta,
    `${label}: locked ${actualBpm.toFixed(4)} BPM, interval ${intervalMs.toFixed(2)} ms implies `
      + `${expected.toFixed(4)} BPM — delta ${delta.toFixed(4)} BPM, allowed `
      + `${allowed.toFixed(4)} (${(BPM_MATCH_TOLERANCE * 100).toFixed(0)}% of expected). `
      + `Units: BPM either side; the allowance covers click-dispatch cost, not runner speed.${detail}`,
  ).toBeLessThan(allowed);
}

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

/**
 * Tap the TAP button N times, `gapMs` apart, DRIVEN FROM INSIDE THE PAGE, and
 * return the real `performance.now()` stamp of each tap.
 *
 * ⚠ WHY IN-PAGE, AND WHY IT RETURNS THE STAMPS (#1847 flake, root-caused).
 * `tap()` timestamps with `performance.now()` AT HANDLER INVOCATION, so the
 * interval this module measures is the wall-clock between two `onclick`s in the
 * page. The previous driver produced that interval from the PLAYWRIGHT side —
 * `waitForTimeout(gap)` then `locator.click()` — so every tap carried one CDP
 * round trip of latency INTO the quantity under test, and on a loaded shard that
 * latency is variable rather than constant. Driving the whole sequence in one
 * `evaluate` removes the round trips from between the taps: the spacing is the
 * page's own timer against the same clock the handler reads.
 *
 * ⚠ AND THE STAMPS ARE THE POINT, not a diagnostic. Returning them lets the
 * assertions be DERIVED from the interval that actually happened instead of the
 * one that was intended — which is what makes this leg immune to timing drift
 * rather than merely less exposed to it. A slow runner then changes the input,
 * not the verdict.
 */
async function tapInPage(
  page: Page,
  nodeId: string,
  n: number,
  gapMs: number,
): Promise<number[]> {
  return page.evaluate(
    async ({ id, count, gap }) => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="timelorde-tap-${id}"]`,
      );
      if (!btn) throw new Error(`TAP button for ${id} not found in page`);
      const stamps: number[] = [];
      for (let i = 0; i < count; i++) {
        if (i > 0) await new Promise((r) => { setTimeout(r, gap); });
        // Stamped immediately before the synchronous handler runs, so this
        // tracks the handler's own `performance.now()` to well under a ms.
        stamps.push(performance.now());
        btn.click();
      }
      return stamps;
    },
    { id: nodeId, count: n, gap: gapMs },
  );
}

/** The inter-tap intervals implied by a stamp list. */
function intervalsOf(stamps: readonly number[]): number[] {
  return stamps.slice(1).map((t, i) => t - stamps[i]!);
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

    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: TL, type: 'timelorde', position: { x: 200, y: 80 }, domain: 'audio', params: { bpm: 50 } }],
      [],
    );

    const tap = page.locator(`[data-testid="timelorde-tap-${TL}"]`);
    await expect(tap, 'TAP button present').toHaveCount(1);
    await expect(tap, 'TAP enabled with no external clock').toBeEnabled();

    // ── 1. A 2-TAP LOCKS THE BPM TO THE INTERVAL THAT WAS ACTUALLY TAPPED ──
    //
    // ⚠ ASSERTED AGAINST THE MEASURED INTERVAL, NOT THE REQUESTED ONE, and that
    // is the whole repair. The old version asserted only "changed off 50, inside
    // the clamp" because it could not know what interval had really been tapped
    // — the Playwright-side gap carried CDP latency into it. With the taps
    // driven in-page the real interval comes back, and with two taps the module's
    // math is exactly `clampBpm(60000 / interval)` (one interval, so the median
    // is that interval). So this now proves the claim in the test's NAME —
    // "locks the BPM to the tapped interval" — instead of proving it moved.
    const slowStamps = await tapInPage(page, TL, 2, SLOW_GAP_MS);
    const slowInterval = intervalsOf(slowStamps)[0]!;
    await expect
      .poll(() => readBpm(page, TL), { timeout: 3000, message: 'a 2-tap sets the bpm off the spawn' })
      .not.toBe(50);
    const bpmSlow = (await readBpm(page, TL))!;
    expectBpmMatchesInterval(bpmSlow, slowInterval, '2-tap lock');

    // ── 2. TAPPING FASTER RE-LOCKS HIGHER ─────────────────────────────────
    //
    // ⚠ `TAP_HISTORY` TAPS, AND THE COUNT IS THE MECHANISM RATHER THAN A ROUND
    // NUMBER. The module keeps a ring of the last `TAP_HISTORY` stamps, so
    // tapping exactly that many times EVICTS the slow phase completely and the
    // median is over fast intervals alone. The old version tapped 4 of a
    // 5-deep ring, so the slow tap could still sit in the buffer — and whether
    // it did depended on whether the ~2 s reset had fired, i.e. on how long the
    // PRECEDING ASSERTIONS took. The subject of the comparison changed with
    // runner speed, which is a property no amount of tolerance fixes.
    //
    // ⚠ AND THE CONTRAST IS WIDER ON PURPOSE. 500 vs 375 ms left 125 ms between
    // the two phases, so ~125 ms of jitter on either side could invert the
    // claim. 600 vs 300 is a clean 2x (100 vs 200 BPM, both well inside the
    // 10-300 clamp), so the ordering survives far more drift than a loaded
    // shard produces — and the derived assertion below does not depend on it.
    const fastStamps = await tapInPage(page, TL, TAP_HISTORY, FAST_GAP_MS);
    const fastMedian = median(intervalsOf(fastStamps));
    await expect
      .poll(() => readBpm(page, TL), { timeout: 3000, message: 'a faster tap re-locks the bpm' })
      .not.toBe(bpmSlow);
    const bpmFast = (await readBpm(page, TL))!;
    expectBpmMatchesInterval(
      bpmFast,
      fastMedian,
      'fast re-lock (median of the ring)',
      ` Intervals: [${intervalsOf(fastStamps).map((v) => v.toFixed(1)).join(', ')}] ms.`,
    );

    // The relative claim, kept because it is the one a PLAYER cares about —
    // now a consequence of two derived facts rather than the only assertion.
    expect(
      bpmFast,
      `faster taps must lock HIGHER: ${fastMedian.toFixed(1)} ms median vs `
        + `${slowInterval.toFixed(1)} ms single interval`,
    ).toBeGreaterThan(bpmSlow);

    expect(errors).toEqual([]);
  });

  test('Spacebar taps the tempo ONLY when TIMELORDE is selected', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/rack?shell=legacy&seed=none');
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

    await page.goto('/rack?shell=legacy&seed=none');
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
