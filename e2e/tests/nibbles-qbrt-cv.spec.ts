// e2e/tests/nibbles-qbrt-cv.spec.ts
//
// E2E regression for the PR #163 bug — NIBBLES.length_cv must actually
// emit CV downstream when patched into a CV input. Asserts that QBRT's
// cutoff value MOVES as `__nibblesForceLength` sweeps from 1 → 119,
// proving that the published length_cv ConstantSourceNode is reaching
// QBRT's cutoff AudioParam via the cross-domain CV bridge.
//
// WITHOUT PR #163's fix this test FAILS — the length_cv emit silence
// (the bug) means the modulator-tap sample stays at 0, so QBRT's
// readParam returns the same intrinsic cutoff at every length. That's
// the CORRECT outcome: the regression coverage proves the fix works.
//
// We do NOT `test.skip()` this on red. If #163 hasn't landed when this
// PR's CI runs, the spec fails — that's the proof we wrote it correctly.
//
// Mechanism: PatchEngine.readParam(node, 'cutoff') returns
// `intrinsic + modulator-tap-sample`. The intrinsic stays at 1000 Hz
// (the QBRT knob default); the tap sample is what the CV input is
// currently injecting. So a sweep of length_cv from -0.98 → +1.0 must
// show a non-zero, monotonically-changing modulator contribution
// (mapped through QBRT's log CV scaling — ±1 CV = ±5 octaves around
// the knob, so the FOLDED value reaches ~32 Hz at CV -1 and ~32 kHz
// at CV +1 in terms of the cutoff freq the filter actually uses).
//
// We don't assert against absolute Hz values (the CV-scaling is QBRT's
// concern); we assert (a) the readParam value MOVES significantly from
// length=1 to length=119, and (b) the sweep is monotonic across the
// 5-step sequence pinned by the composite VRT.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read QBRT's effective cutoff via the engine's readParam — this includes
 *  the modulator-tap sample, so a working length_cv → cutoff_cv chain
 *  manifests as a value that DIFFERS from the intrinsic knob. */
async function readEffectiveCutoff(page: Page, qbrtNodeId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        readParam: (
          node: { id: string; type: string; domain: string },
          paramId: string,
        ) => number | undefined;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const v = eng.readParam(node, 'cutoff');
    return typeof v === 'number' ? v : null;
  }, qbrtNodeId);
}

/** Set the deterministic length-CV hook + give the engine a few frames
 *  to propagate the new CV through the modulator analyser tap. */
async function setForcedLength(page: Page, length: number): Promise<void> {
  await page.evaluate((len) => {
    (globalThis as unknown as { __nibblesForceLength?: number }).__nibblesForceLength = len;
  }, length);
  // A few rAFs + a settle so the constant-source ramp lands + the QBRT
  // param tap (fftSize=32) averages a stable sample of the new CV.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await page.waitForTimeout(150);
}

test.describe('NIBBLES.length_cv → QBRT.cutoff_cv: regression for PR #163', () => {
  test('cutoff value MOVES significantly when length_cv sweeps from min to max', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'nib', type: 'nibbles', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'qb', type: 'qbrt', position: { x: 560, y: 80 }, domain: 'audio' },
      ],
      [
        {
          id: 'e_len_cut',
          from: { nodeId: 'nib', portId: 'length_cv' },
          to: { nodeId: 'qb', portId: 'cutoff' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );

    // Settle so the engine has bound the cross-domain CV bridge + the
    // QBRT param tap is live.
    await page.waitForTimeout(400);

    // Baseline at length=1 (CV ≈ -0.983 — the MIN of the sweep).
    await setForcedLength(page, 1);
    const cutoffAtMin = await readEffectiveCutoff(page, 'qb');
    expect(cutoffAtMin, 'engine.readParam(qbrt, cutoff) returns a number at length=1').not.toBeNull();

    // Max length (119 → CV = +1.0). After PR #163 lands, the cutoff
    // value here is the intrinsic knob (1000 Hz) PLUS the CV-driven
    // displacement, which on QBRT's log CV scaling = +5 octaves
    // ≈ 32 kHz of equivalent center-freq displacement.
    await setForcedLength(page, 119);
    const cutoffAtMax = await readEffectiveCutoff(page, 'qb');
    expect(cutoffAtMax, 'engine.readParam(qbrt, cutoff) returns a number at length=119').not.toBeNull();

    // The delta has to be SIGNIFICANT — well beyond rounding error.
    // QBRT's intrinsic cutoff range is 20..20000 Hz; the modulator tap
    // contributes a value on top of the intrinsic, but in practice the
    // raw CV sample at the param tap is what we read here (NOT the
    // post-log-scaling cutoff). At length=1, CV ≈ -0.983; at length=119,
    // CV = +1.0; so the delta in the modulator-tap sample alone is ≈ 2.0.
    // We require a delta > 0.5 — comfortably above noise, well below the
    // ~2.0 the working chain emits.
    const delta = Math.abs(cutoffAtMax! - cutoffAtMin!);
    expect(
      delta,
      `cutoff delta from CV min (length=1) to CV max (length=119) must exceed 0.5; ` +
        `got cutoffAtMin=${cutoffAtMin}, cutoffAtMax=${cutoffAtMax}, delta=${delta}. ` +
        `A near-zero delta here means NIBBLES.length_cv is emitting silence ` +
        `(the PR #163 bug). If #163 has merged, the chain is live + the delta ` +
        `is the modulator sample.`,
    ).toBeGreaterThan(0.5);

    // Sanity sign check: positive CV must raise the readParam value above
    // the negative-CV reading (the QBRT cutoff input is `paramTarget=cutoff`
    // with log scaling, and our readParam folds the raw tap sample in, so
    // a more-positive CV = a higher reading).
    expect(
      cutoffAtMax,
      'cutoff at CV max (length=119) must be higher than at CV min (length=1)',
    ).toBeGreaterThan(cutoffAtMin!);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      `console/page errors during sweep: ${errors.join('; ')}`,
    ).toEqual([]);
  });

  test('cutoff is monotonic across the 5-step CV sweep used by composite VRT', async ({ page }) => {
    // Same 5 lengths the composite VRT pins. Mirrors the spec values in
    // vrt-composite-scenes.ts; if you change them there, change them here.
    const SWEEP_LENGTHS = [1, 30, 60, 89, 119];

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'nib', type: 'nibbles', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'qb', type: 'qbrt', position: { x: 560, y: 80 }, domain: 'audio' },
      ],
      [
        {
          id: 'e_len_cut',
          from: { nodeId: 'nib', portId: 'length_cv' },
          to: { nodeId: 'qb', portId: 'cutoff' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );

    await page.waitForTimeout(400);

    const samples: number[] = [];
    for (const length of SWEEP_LENGTHS) {
      await setForcedLength(page, length);
      const cutoff = await readEffectiveCutoff(page, 'qb');
      expect(cutoff, `cutoff readable at length=${length}`).not.toBeNull();
      samples.push(cutoff!);
    }

    // Monotonic-increase: each subsequent sample > the previous. The CV
    // mapping is (length - 59.5)/59.5, which is monotonic in length, and
    // QBRT's cutoff input is a positive-going CV (more CV → higher
    // cutoff), so the readParam folded sum must increase step by step.
    for (let i = 1; i < samples.length; i++) {
      expect(
        samples[i],
        `cutoff at length=${SWEEP_LENGTHS[i]} (${samples[i]}) must exceed ` +
          `cutoff at length=${SWEEP_LENGTHS[i - 1]} (${samples[i - 1]})`,
      ).toBeGreaterThan(samples[i - 1]!);
    }

    // Spread sanity — span across the 5 samples > 1.0 in the raw tap
    // (ditto reasoning as the binary sweep test above).
    const span = samples[samples.length - 1]! - samples[0]!;
    expect(
      span,
      `total cutoff span across 5-step CV sweep (${span}) must exceed 1.0`,
    ).toBeGreaterThan(1.0);
  });
});
