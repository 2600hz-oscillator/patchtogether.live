// e2e/tests/scaler-cv-passthrough.spec.ts
//
// REAL source → SCALER → video-module-param regression for the SCALER
// dead-knob bug (PR "fix(scaler): out adopts upstream type").
//
// THE BUG: SCALER's `out` port was hard-typed `audio`. The audio→video
// cross-domain bridge picks its read path off the SOURCE cable type — an
// `audio` source is RMS-envelope-followed (CLAMPED to 1.0), a `cv`/`gate`/
// `pitch` source is read as the raw tail sample. So SCALER's scaled CV hit
// the RMS follower, SATURATED, and the AMOUNT knob had ZERO effect at a video
// destination (the owner saw amount 2/5/10 all produce an identical ~45°
// orient). It also made routing-through-SCALER hotter than direct.
//
// THE FIX: SCALER's `out` now ADOPTS its upstream input's cable type
// (PortDef.adoptsUpstreamFrom='in', resolved in buildPatchSnapshot). A CV
// source → a CV out → the bridge takes the tail-sample path → AMOUNT actually
// scales the ±CV value reaching LINES.orient.
//
// THE CHAIN (the real-source-chain standard, video flavor):
//   LFO.phase0 (cv) → SCALER.in  → SCALER.out → LINES.orient (cv param)
// We drive a small-amplitude LFO (depth 0.3 → ±0.3 cv) so the scaled value
// stays inside the bridge's continuous-param ±1 modulation range (scaleCv
// clamps the cv to ±1 before mapping — see cv-scale.ts), then read LINES'
// EFFECTIVE `orient` (engine.readParam routes to the video engine; LINES'
// handle returns the live bridge-modulated value) over a window at two AMOUNT
// settings. With LINES.orient centred (knob 0.5) the orient sweep is symmetric
// around 0.5, so its SPAN tracks the scaled-CV amplitude LINEARLY:
//   AMOUNT 1 → ±0.3 cv → orient ≈ 0.35..0.65 (span ≈ 0.3)
//   AMOUNT 3 → ±0.9 cv → orient ≈ 0.05..0.95 (span ≈ 0.9)
// The high-AMOUNT span must be MEASURABLY larger — that ~3× ratio is impossible
// under the bug (the RMS follower clamped the source to ~1.0 → orient pinned
// near a constant, span ≈ 0, IDENTICAL at every AMOUNT — the dead knob).
//
// RENDERER-TOLERANT: asserts a CV/param-level delta (LINES.orient), NOT
// pixels — so it's identical on a real GPU and on CI's SwiftShader software
// renderer (per the capability-dependent-e2e-local-vs-ci standard).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// ⚠ A PER-SAMPLE `readOrient(page, id)` HELPER STOOD HERE AND IS DELETED. It
// was one `page.evaluate` per sample — a CDP round trip that stepped the video
// engine on the same main thread it was measuring. Its body now lives inside
// `sampleOrientSpan`'s single in-page loop, unchanged in what it does; see that
// helper's header for the measurement that condemned the round trip.

/** Set SCALER's AMOUNT live (mirrors a user turning the knob). */
async function setAmount(page: Page, nodeId: string, amount: number): Promise<void> {
  await page.evaluate(
    ({ id, v }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          setParam: (
            node: { id: string; type: string; domain: string; params: Record<string, number> },
            paramId: string,
            value: number,
          ) => void;
        } | null;
        __patch: {
          nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }>;
        };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return;
      node.params.amount = v;
      eng.setParam(node, 'amount', v);
    },
    { id: nodeId, v: amount },
  );
}

/**
 * Sample LINES.orient N times across a window IN THE PAGE; return the span.
 *
 * ── ⚠ THIS USED TO BE A PLAYWRIGHT-SIDE LOOP, AND THAT WAS THE FAILURE ─────
 *
 * It read:
 *
 *     for (let i = 0; i < samples; i++) {
 *       const v = await readOrient(page, linesNodeId);   // one CDP round trip
 *       ...
 *       await page.waitForTimeout(intervalMs);           // and a second wait
 *     }
 *
 * 24 samples x 2 AMOUNT settings = 96 round trips, each stepping the VIDEO
 * ENGINE on the same main thread it is sampling. Measured off the CI blob
 * report of run 33990942421: 14,456 ms in 48 `Evaluate` calls (~301 ms each,
 * against ~1 ms of assertion) plus 10,752 ms in 48 nominal-50 ms sleeps that
 * actually cost ~224 ms each — 25.2 s of a 30 s budget spent on transport, for
 * a measurement whose own arithmetic is trivial.
 *
 * ⚠ AND THE BRANCH IS WHY IT TIPPED. Re-pointing this spec off `?shell=legacy`
 * serialized a cold boot that used to overlap page load, and the round trips
 * got dearer as the default shell started painting: the branch's own cost
 * re-pin measures the file at 8.4 s -> 21.3 s. Every assertion in this test had
 * already PASSED when the ceiling came down ("low-AMOUNT orient span 0.593",
 * "high-AMOUNT orient span (1.000, [0.00..1.00])") — nothing about the product
 * is implicated.
 *
 * Now the whole window runs in ONE `page.evaluate`: the same per-sample
 * `step()` + `readParam` pair, the same count, the same spacing, min/max
 * latched in the page. 96 round trips become 2. The MEASURED QUANTITY is
 * unchanged — max minus min of the effective `orient` over N samples.
 *
 * `samples` and `elapsedMs` come back for the same reason every poller in
 * `_helpers/scope-poll.ts` returns them: a span of 0 from 24 samples is a
 * finding, a span of 0 from 0 samples is a broken probe, and the assertion
 * message must be able to tell them apart.
 */
async function sampleOrientSpan(
  page: Page,
  linesNodeId: string,
  samples: number,
  intervalMs: number,
): Promise<{ span: number; min: number; max: number; values: number[]; samples: number; elapsedMs: number }> {
  return page.evaluate(
    ([id, n, gap]) =>
      new Promise<{ span: number; min: number; max: number; values: number[]; samples: number; elapsedMs: number }>(
        (resolve) => {
          const w = globalThis as unknown as {
            __engine?: () => {
              readParam: (
                node: { id: string; type: string; domain: string },
                paramId: string,
              ) => number | undefined;
              getDomain: (d: string) => { step: () => void };
            } | null;
            __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
          };
          const t0 = performance.now();
          const values: number[] = [];
          let taken = 0;
          const tick = (): void => {
            const eng = w.__engine?.();
            const node = w.__patch?.nodes?.[id as string];
            if (eng && node) {
              // Force a video tick so the cv bridge samples the LFO + writes
              // orient, independent of rAF throttling under CI load. Same call
              // the per-sample round trip made, now beside the read.
              try {
                eng.getDomain('video').step();
              } catch {
                /* video engine may not exist yet */
              }
              const v = eng.readParam(node, 'orient');
              if (typeof v === 'number') values.push(v);
            }
            taken++;
            if (taken >= (n as number)) {
              let lo = Infinity;
              let hi = -Infinity;
              for (const v of values) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
              }
              clearInterval(timer);
              resolve({
                span: values.length > 0 ? hi - lo : 0,
                min: lo,
                max: hi,
                values,
                samples: values.length,
                elapsedMs: performance.now() - t0,
              });
            }
          };
          const timer = setInterval(tick, gap as number);
          tick();
        },
      ),
    [linesNodeId, samples, intervalMs] as const,
  );
}

test('AMOUNT scales the CV reaching LINES.orient — high AMOUNT moves orient more than low (dead-knob regression)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      // Real CV source: an LFO at 4Hz, SMALL depth (0.3) → ±0.3 cv on phase0,
      // so AMOUNT 1..3 stays inside the bridge's ±1 modulation range and the
      // orient span tracks AMOUNT linearly (no scaleCv clamp masking the ratio).
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 80 }, params: { rate: 4.0, shape: 0, depth: 0.3 } },
      // SCALER under test.
      { id: 'sc', type: 'scaler', position: { x: 380, y: 80 }, params: { amount: 1 } },
      // LINES — video module with a cv-typed `orient` param (0..1). Knob 0.5
      // (centre) so the modulation sweeps symmetrically and isn't floor-clamped.
      { id: 'ln', type: 'lines', position: { x: 680, y: 80 }, domain: 'video', params: { orient: 0.5 } },
    ],
    [
      // LFO.phase0 (cv) → SCALER.in. SCALER.out adopts cv from this upstream.
      { id: 'e_lfo_sc', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'sc', portId: 'in' }, sourceType: 'cv', targetType: 'audio' },
      // SCALER.out → LINES.orient. We DELIBERATELY store sourceType:'audio'
      // here (what a naive connect-path would write): the snapshot's
      // adoptsUpstreamFrom resolution must rewrite it to 'cv' so the bridge
      // takes the tail-sample path. If the fix regresses, this stays 'audio',
      // the RMS clamp fires, and the two AMOUNT spans collapse together.
      { id: 'e_sc_ln', from: { nodeId: 'sc', portId: 'out' }, to: { nodeId: 'ln', portId: 'orient' }, sourceType: 'audio', targetType: 'cv' },
    ],
    // LINES first-paints on SwiftShader; give it head-room.
    { mountTimeout: 15000 },
  );

  // Settle so the cross-domain CV bridge binds + the LFO analyser fills.
  await page.waitForTimeout(600);

  // LOW AMOUNT (×1): ±0.3 cv → orient ≈ 0.35..0.65 → SMALL span (~0.3).
  await setAmount(page, 'sc', 1);
  await page.waitForTimeout(300);
  const low = await sampleOrientSpan(page, 'ln', 24, 50);

  // HIGH AMOUNT (×3): ±0.9 cv → orient ≈ 0.05..0.95 → LARGE span (~0.9).
  await setAmount(page, 'sc', 3);
  await page.waitForTimeout(300);
  const high = await sampleOrientSpan(page, 'ln', 24, 50);

  // We got real readings at both settings.
  expect(low.values.length, 'sampled orient at low AMOUNT').toBeGreaterThan(8);
  expect(high.values.length, 'sampled orient at high AMOUNT').toBeGreaterThan(8);

  // Sanity: the LOW-AMOUNT sweep already moves orient (the CV is actually
  // reaching LINES — not silent), but stays well under the full range.
  expect(
    low.span,
    `low-AMOUNT orient span ${low.span.toFixed(3)} should be a small, real sweep ` +
      `(~0.3) — CV reaches LINES but isn't yet boosted`,
  ).toBeGreaterThan(0.1);

  // THE REGRESSION ASSERTION: tripling AMOUNT measurably widens the orient
  // sweep. Under the bug the RMS follower pinned orient near a constant → BOTH
  // spans ≈ 0 and IDENTICAL, so high - low ≈ 0. The expected delta is ~0.6
  // (0.9 - 0.3); assert a robust ≥0.3 margin.
  expect(
    high.span - low.span,
    `high-AMOUNT orient span (${high.span.toFixed(3)}, [${high.min.toFixed(2)}..${high.max.toFixed(2)}]) ` +
      `must exceed low-AMOUNT span (${low.span.toFixed(3)}, [${low.min.toFixed(2)}..${low.max.toFixed(2)}]) ` +
      `by ≥0.3. A near-zero difference means SCALER's out is STILL audio-typed ` +
      `and the video bridge's RMS follower is clamping the scaled CV (the dead-knob bug).`,
  ).toBeGreaterThan(0.3);

  // And the high-AMOUNT sweep traverses most of the 0..1 range.
  expect(
    high.span,
    `high-AMOUNT orient span ${high.span.toFixed(3)} should sweep most of the 0..1 range`,
  ).toBeGreaterThan(0.6);

  expect(
    errors.filter((e) => !e.includes('AudioContext')),
    `page errors: ${errors.join('; ')}`,
  ).toEqual([]);
});
