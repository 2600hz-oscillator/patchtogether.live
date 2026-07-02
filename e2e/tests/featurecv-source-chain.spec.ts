// e2e/tests/featurecv-source-chain.spec.ts
//
// FEATURECV real-source-chain coverage. The per-module-per-port output-emit
// sweep exempts featurecv (a pure analyser — its CV/onset outputs are silent
// until `in` is driven, which the generic sweep doesn't wire). This spec closes
// that gap by driving a REAL audio source through featurecv and asserting the
// feature CVs (a) reflect the SIGNAL CONTENT and (b) actually MOVE a downstream
// parameter — the standard for an audio→CV modulation module.
//
//   Test 1 (feature responds to content): NOISE → featurecv → SCOPE. White
//     noise (very high zero-crossing rate) vs BROWN noise (heavily low-freq,
//     low ZCR) drive two featurecv copies; their BRIGHT CVs land on scope ch1
//     vs ch2. The white-driven BRIGHT (bipolar, near +1) must sit well ABOVE
//     the brown-driven BRIGHT (near −1) — proving the extractor reads timbre,
//     not just "a signal is present".
//
//   Test 2 (the task's example: source → featurecv.bright → filter.cutoff →
//     audible change): identical white-noise material feeds two LOWPASS
//     filters; each filter's CUTOFF is driven by a featurecv.BRIGHT fed by
//     white (bright high → cutoff swept UP) vs brown (bright low → cutoff swept
//     DOWN). The high-cutoff filter passes far more of the broadband noise, so
//     its output RMS at the scope must clearly exceed the low-cutoff one — the
//     featurecv CV demonstrably moves the filter's cutoff parameter.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/rack');
});

function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s / Math.max(1, a.length);
}

test('featurecv BRIGHT tracks spectral content (white > brown) through a real chain', async ({
  page,
}) => {
  await spawnPatch(
    page,
    [
      { id: 'nz', type: 'noise', params: { level: 0.8 } },
      { id: 'fcW', type: 'featurecv', params: {} }, // white → bright HIGH
      { id: 'fcB', type: 'featurecv', params: {} }, // brown → bright LOW
      { id: 'scp', type: 'scope', params: { timeMs: 50 } },
    ],
    [
      { id: 'a1', from: { nodeId: 'nz', portId: 'white' }, to: { nodeId: 'fcW', portId: 'in' } },
      { id: 'a2', from: { nodeId: 'nz', portId: 'brown' }, to: { nodeId: 'fcB', portId: 'in' } },
      { id: 'a3', from: { nodeId: 'fcW', portId: 'bright' }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'a4', from: { nodeId: 'fcB', portId: 'bright' }, to: { nodeId: 'scp', portId: 'ch2' } },
    ],
  );

  // Let the analysis window fill + the CV smoothing settle.
  await runFor(page, 900);

  // The BRIGHT CV is a (near-)DC level — compare its MEAN over a few reads.
  let mW = -Infinity;
  let mB = Infinity;
  for (let i = 0; i < 5; i++) {
    const snap = await readScopeSnapshot(page, 'scp');
    expect(snap, 'scope snapshot should be available').not.toBeNull();
    if (snap) {
      mW = Math.max(mW, mean(snap.ch1));
      mB = Math.min(mB, mean(snap.ch2));
    }
    await runFor(page, 80);
  }

  // White noise is far BRIGHTER than brown → its bipolar BRIGHT CV is clearly
  // higher. A generous margin keeps it robust while still proving the feature
  // discriminates timbre (not merely "signal present").
  expect(mW, `white BRIGHT (${mW.toFixed(3)}) should exceed brown BRIGHT (${mB.toFixed(3)})`)
    .toBeGreaterThan(mB + 0.3);
  // White noise saturates ZCR → its BRIGHT CV is strongly positive (bipolar).
  expect(mW).toBeGreaterThan(0.2);
});

test('featurecv.bright modulates filter.cutoff → audible RMS change', async ({ page }) => {
  await spawnPatch(
    page,
    [
      { id: 'nz', type: 'noise', params: { level: 0.8 } },
      // White-driven featurecv → BRIGHT high → cutoff up; brown-driven → low.
      { id: 'fcHi', type: 'featurecv', params: {} },
      { id: 'fcLo', type: 'featurecv', params: {} },
      // Identical broadband material into both LP filters (default mode 0 = LP).
      { id: 'fHi', type: 'filter', params: { cutoff: 1000, resonance: 0.1, mode: 0 } },
      { id: 'fLo', type: 'filter', params: { cutoff: 1000, resonance: 0.1, mode: 0 } },
      { id: 'scp', type: 'scope', params: { timeMs: 30 } },
    ],
    [
      // Same white-noise audio into both filters' signal inputs.
      { id: 'e1', from: { nodeId: 'nz', portId: 'white' }, to: { nodeId: 'fHi', portId: 'audio' } },
      { id: 'e2', from: { nodeId: 'nz', portId: 'white' }, to: { nodeId: 'fLo', portId: 'audio' } },
      // featurecv drive sources: white (bright high) vs brown (bright low).
      { id: 'e3', from: { nodeId: 'nz', portId: 'white' }, to: { nodeId: 'fcHi', portId: 'in' } },
      { id: 'e4', from: { nodeId: 'nz', portId: 'brown' }, to: { nodeId: 'fcLo', portId: 'in' } },
      // featurecv.bright → filter.cutoff (the modulation under test).
      { id: 'e5', from: { nodeId: 'fcHi', portId: 'bright' }, to: { nodeId: 'fHi', portId: 'cutoff' } },
      { id: 'e6', from: { nodeId: 'fcLo', portId: 'bright' }, to: { nodeId: 'fLo', portId: 'cutoff' } },
      // Both filter outputs → scope (ch1 = high cutoff, ch2 = low cutoff).
      { id: 'e7', from: { nodeId: 'fHi', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e8', from: { nodeId: 'fLo', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch2' } },
    ],
  );

  await runFor(page, 900);

  // Max-hold the per-channel RMS over a short window (steady noise → steady).
  let rmsHi = 0;
  let rmsLo = 0;
  for (let i = 0; i < 6; i++) {
    const snap = await readScopeSnapshot(page, 'scp');
    expect(snap).not.toBeNull();
    if (snap) {
      rmsHi = Math.max(rmsHi, summarize(snap.ch1).rms);
      rmsLo = Math.max(rmsLo, summarize(snap.ch2).rms);
    }
    await runFor(page, 70);
  }

  // The high-cutoff (white-bright-driven) filter passes far more of the
  // broadband noise than the low-cutoff (brown-bright-driven) one → higher RMS.
  // Proves featurecv.bright actually moved the filter's cutoff parameter.
  expect(rmsHi, `high-cutoff RMS (${rmsHi.toFixed(4)}) should be alive`).toBeGreaterThan(0.01);
  expect(
    rmsHi,
    `high-cutoff RMS (${rmsHi.toFixed(4)}) should clearly exceed low-cutoff RMS (${rmsLo.toFixed(4)})`,
  ).toBeGreaterThan(rmsLo * 1.5);
});
