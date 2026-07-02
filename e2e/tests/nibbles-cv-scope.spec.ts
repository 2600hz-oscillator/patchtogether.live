// e2e/tests/nibbles-cv-scope.spec.ts
//
// E2E regression for PR #163 — NIBBLES.length_cv must actually emit CV
// downstream when patched into a CV input. Patches NIBBLES.length_cv →
// SCOPE.ch1 and reads SCOPE's most-recent analyser sample as the
// "visible CV" observable: that's a real measurement of the signal
// landing in the audio graph (the SCOPE trace is exactly what the user
// SEES on the card).
//
// History: an earlier draft of this spec asserted that
// `engine.readParam(qbrt, 'cutoff')` moved across the sweep. That was
// structurally wrong — `readParam` returns the user-dialed SLIDER
// value (which never changes when a CV modulates the underlying
// AudioParam) plus the QBRT param-tap sample. The QBRT path therefore
// over-fitted to a brittle "intrinsic + tap" sum that only happens to
// work when the modulator tap is wired the way readParam expects. The
// engine bridge (the actual code under regression) is pinned bit-exact
// by engine-video-audio-bridge.test.ts in PR #414 — what's left to
// prove at e2e level is that the bridge feeds a downstream CONSUMER
// the right CV value at each NIBBLES length. SCOPE is the canonical
// consumer: its analyser samples the bridged AudioNode directly, so
// `read('ch1_last_sample')` is the live CV value at the SCOPE input,
// independent of every other knob/slider.
//
// Mechanism:
//   * NIBBLES is video-domain; publishes `length_cv` via audioSources
//     (a ConstantSourceNode whose offset is set to
//     `(length - 59.5) / 59.5`).
//   * SCOPE is audio-domain; its `ch1` input is an audio input feeding
//     a GainNode + analyser. The cross-domain video→audio audio bridge
//     (engine.ts: addCrossDomainAudioBridge) handles
//     sourceType={cv,audio,gate} → audio targets, so the cable
//     NIBBLES.length_cv → SCOPE.ch1 wires the ConstantSourceNode into
//     the SCOPE analyser path.
//   * SCOPE.ch1Range is set to 1 (CV mode) so the on-card trace
//     correctly scales ±5 V CV per PR #418's display work. The trace
//     mode is purely cosmetic for this spec — `read('ch1_last_sample')`
//     reads the raw analyser sample, not the rendered y position.
//   * Sweeping `__nibblesForceLength` from 1 → 119 sweeps the CV from
//     −0.983 → +1.0 (mapping: (length - 59.5)/59.5). After a settle the
//     SCOPE analyser's tail sample equals that CV value (a DC signal —
//     the ConstantSourceNode emits a constant offset).
//
// We assert (a) the read value tracks `lengthToCv(length)` within
// tolerance, (b) the values are monotonic across the 5-step sweep.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Mirrors the NIBBLES mapping in
// packages/web/src/lib/video/modules/nibbles.ts. If the constants there
// change, the unit test (nibbles.test.ts: "spirograph-VRT lengths")
// fails first; this is just a derived helper.
const NIBBLES_MAX_LENGTH = 119;
const NIBBLES_MID = NIBBLES_MAX_LENGTH / 2; // 59.5
function lengthToCv(length: number): number {
  return (length - NIBBLES_MID) / NIBBLES_MID;
}

/** Read SCOPE's most-recent ch1 analyser sample — the live CV value at
 *  the SCOPE input port. See packages/web/src/lib/audio/modules/scope.ts
 *  for the `read('ch1_last_sample')` implementation (added in this PR). */
async function readScopeCh1(page: Page, scopeNodeId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (
          node: { id: string; type: string; domain: string },
          key: string,
        ) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const v = eng.read(node, 'ch1_last_sample');
    return typeof v === 'number' ? v : null;
  }, scopeNodeId);
}

/** Set the deterministic length-CV hook + give the engine a few frames
 *  to propagate the new CV through the audio graph + analyser sampling. */
async function setForcedLength(page: Page, length: number): Promise<void> {
  await page.evaluate((len) => {
    (globalThis as unknown as { __nibblesForceLength?: number }).__nibblesForceLength = len;
  }, length);
  // A few rAFs + a settle so the ConstantSourceNode's new offset value
  // lands and the SCOPE analyser's 2048-sample buffer averages a stable
  // sample of the new DC CV.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await page.waitForTimeout(150);
}

test.describe('NIBBLES.length_cv → SCOPE.ch1: regression for PR #163', () => {
  test('SCOPE ch1 sample tracks lengthToCv(length) at the sweep extremes', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'nib', type: 'nibbles', position: { x: 80, y: 80 }, domain: 'video' },
        // SCOPE.ch1Range=1 (CV display mode, per PR #418) so the on-card
        // trace renders the ±5 V range correctly. Pure display setting —
        // the analyser readback is independent of it.
        {
          id: 'sc',
          type: 'scope',
          position: { x: 560, y: 80 },
          domain: 'audio',
          params: { ch1Range: 1 },
        },
      ],
      [
        // length_cv (video, type=cv) → ch1 (audio, type=audio). The
        // video→audio audio bridge (engine.ts: addCrossDomainAudioBridge)
        // handles sourceType=cv → targetType=audio.
        {
          id: 'e_len_ch1',
          from: { nodeId: 'nib', portId: 'length_cv' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'cv',
          targetType: 'audio',
        },
      ],
    );

    // Settle so the engine has bound the cross-domain bridge + the
    // SCOPE analyser is sampling.
    await page.waitForTimeout(400);

    // Baseline at length=1 (CV ≈ -0.983).
    await setForcedLength(page, 1);
    const ch1AtMin = await readScopeCh1(page, 'sc');
    expect(ch1AtMin, 'engine.read(scope, ch1_last_sample) returns a number at length=1').not.toBeNull();
    // Tolerance 0.05 — the ConstantSourceNode emits a clean DC offset, but
    // the analyser tail sample can carry a tiny attack ramp residue
    // depending on settle timing.
    expect(
      ch1AtMin,
      `ch1 sample at length=1 should be ≈ ${lengthToCv(1).toFixed(3)} (got ${ch1AtMin})`,
    ).toBeGreaterThan(lengthToCv(1) - 0.05);
    expect(ch1AtMin).toBeLessThan(lengthToCv(1) + 0.05);

    // Max length (119 → CV = +1.0).
    await setForcedLength(page, 119);
    const ch1AtMax = await readScopeCh1(page, 'sc');
    expect(ch1AtMax, 'engine.read(scope, ch1_last_sample) returns a number at length=119').not.toBeNull();
    expect(
      ch1AtMax,
      `ch1 sample at length=119 should be ≈ ${lengthToCv(119).toFixed(3)} (got ${ch1AtMax})`,
    ).toBeGreaterThan(lengthToCv(119) - 0.05);
    expect(ch1AtMax).toBeLessThan(lengthToCv(119) + 0.05);

    // Sanity: positive CV (length=119) sample > negative CV (length=1).
    expect(
      ch1AtMax,
      'ch1 sample at length=119 must exceed ch1 sample at length=1',
    ).toBeGreaterThan(ch1AtMin!);

    // The span across the sweep extremes — proves the CV actually moves
    // (vs. NIBBLES emitting silence, the PR #163 bug).
    const delta = ch1AtMax! - ch1AtMin!;
    expect(
      delta,
      `ch1 sample delta from length=1 → length=119 must exceed 1.5; got ${delta.toFixed(3)}. ` +
        `A near-zero delta here means NIBBLES.length_cv is emitting silence ` +
        `(the PR #163 bug). The full sweep span is ≈ 1.983.`,
    ).toBeGreaterThan(1.5);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      `console/page errors during sweep: ${errors.join('; ')}`,
    ).toEqual([]);
  });

  test('ch1 sample is monotonic across the 5-step CV sweep used by composite VRT', async ({ page }) => {
    // Same 5 lengths the composite VRT pins. Mirrors the spec values in
    // vrt-composite-scenes.ts; if you change them there, change them here.
    const SWEEP_LENGTHS = [1, 30, 60, 89, 119];

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'nib', type: 'nibbles', position: { x: 80, y: 80 }, domain: 'video' },
        {
          id: 'sc',
          type: 'scope',
          position: { x: 560, y: 80 },
          domain: 'audio',
          params: { ch1Range: 1 },
        },
      ],
      [
        {
          id: 'e_len_ch1',
          from: { nodeId: 'nib', portId: 'length_cv' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'cv',
          targetType: 'audio',
        },
      ],
    );

    await page.waitForTimeout(400);

    const samples: number[] = [];
    for (const length of SWEEP_LENGTHS) {
      await setForcedLength(page, length);
      const ch1 = await readScopeCh1(page, 'sc');
      expect(ch1, `ch1 sample readable at length=${length}`).not.toBeNull();
      samples.push(ch1!);
    }

    // Each sample should be within ±0.05 of its expected CV.
    for (let i = 0; i < SWEEP_LENGTHS.length; i++) {
      const expected = lengthToCv(SWEEP_LENGTHS[i]!);
      expect(
        samples[i]!,
        `ch1 sample at length=${SWEEP_LENGTHS[i]} (${samples[i]}) should be ≈ ${expected.toFixed(3)}`,
      ).toBeGreaterThan(expected - 0.05);
      expect(samples[i]!).toBeLessThan(expected + 0.05);
    }

    // Monotonic-increase: each subsequent sample > the previous. The CV
    // mapping is (length - 59.5)/59.5, which is monotonic in length.
    for (let i = 1; i < samples.length; i++) {
      expect(
        samples[i],
        `ch1 sample at length=${SWEEP_LENGTHS[i]} (${samples[i]}) must exceed ` +
          `ch1 sample at length=${SWEEP_LENGTHS[i - 1]} (${samples[i - 1]})`,
      ).toBeGreaterThan(samples[i - 1]!);
    }

    // Total span across the 5 samples — proves the sweep traverses the
    // expected CV range (≈ 1.983).
    const span = samples[samples.length - 1]! - samples[0]!;
    expect(
      span,
      `total ch1 sample span across 5-step CV sweep (${span.toFixed(3)}) must exceed 1.5`,
    ).toBeGreaterThan(1.5);
  });
});
