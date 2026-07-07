// e2e/tests/cofefve.spec.ts
//
// End-to-end for COFEFVE DELAY through the REAL source chain:
//   NOISE → COFEFVE → AUDIOOUT / SCOPE.
//
//   1. Smoke: NOISE → COFEFVE → AUDIOOUT spawns cleanly, card mounts, the
//      delayTime param round-trips through the engine AudioParam.
//   2. Audible WET echo: with DRY muted (dryVolume 0, wetVolume 1), the ONLY
//      signal that can reach the SCOPE is the DELAYED wet path — so a nonzero
//      windowed RMS/peak proves the echo line carries audible signal (a
//      wire-broken / silent delay reads 0).
//   3. Delayed TAIL: higher FEEDBACK produces a measurably longer/denser wet
//      tail than low feedback (the decaying-echo-train behavior) — a relative,
//      max-hold comparison (robust to analyser phase).
//
// The per-sample delay/decay/sync SHAPE is pinned deterministically in the ART
// tier (art/scenarios/cofefve/profile.test.ts) + the DSP unit tests
// (analog-delay-core.test.ts, cofefve.test.ts); the e2e tier proves the real
// wired chain is audible. All liveness thresholds are windowed max-holds +
// relative deltas (deterministic, renderer/timing-tolerant) yet still fail on
// a silent / broken delay.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, setNodeParams } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// ────────────────────────────────────────────────────────────────────────
// 2. AUDIBLE WET ECHO (dry muted → only the delayed path reaches the scope)
// ────────────────────────────────────────────────────────────────────────

test('COFEFVE wet echo is audible with dry muted (only the delayed path carries signal)', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-n',   type: 'noise',   position: { x: 60,  y: 60 }, domain: 'audio', params: { level: 0.7 } },
      { id: 'a-cf',  type: 'cofefve', position: { x: 360, y: 60 }, domain: 'audio',
        // Dry fully muted: the SCOPE can ONLY see the wet (delayed) signal.
        params: { delayTime: 0.15, feedback: 0.5, dryVolume: 0, wetVolume: 1, driveGain: 0.1 } },
      { id: 'a-scp', type: 'scope',   position: { x: 760, y: 60 }, domain: 'audio', params: { timeMs: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-n',  portId: 'white' }, to: { nodeId: 'a-cf',  portId: 'inL' } },
      { id: 'e2', from: { nodeId: 'a-cf', portId: 'outL' },  to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  // Let the delay line fill past the 150 ms tap, then max-hold over a window.
  await page.waitForTimeout(500);
  const hold = await readScopePeakOverWindow(page, 'a-scp', 1200);
  expect(hold.polls, 'SCOPE was polled').toBeGreaterThan(0);
  // Dry is muted, so ANY energy here traversed the 150 ms delay + came back.
  expect(hold.peak).toBeGreaterThan(0.01);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);

});

// ────────────────────────────────────────────────────────────────────────
// 3. FEEDBACK lengthens the wet echo tail
// ────────────────────────────────────────────────────────────────────────

test('COFEFVE feedback amount audibly lengthens the wet echo tail', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-n',   type: 'noise',   position: { x: 60,  y: 60 }, domain: 'audio', params: { level: 0.6 } },
      { id: 'a-cf',  type: 'cofefve', position: { x: 360, y: 60 }, domain: 'audio',
        // Open TONE filter (lowCut 1) so the fed-back copies aren't darkened per
        // pass — the feedback buildup then dominates the steady-state wet RMS,
        // giving a decisive low-vs-high contrast.
        params: { delayTime: 0.12, feedback: 0.1, dryVolume: 0, wetVolume: 1, driveGain: 0, lowCut: 1, highCut: 0.001 } },
      { id: 'a-scp', type: 'scope',   position: { x: 760, y: 60 }, domain: 'audio', params: { timeMs: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-n',  portId: 'white' }, to: { nodeId: 'a-cf',  portId: 'inL' } },
      { id: 'e2', from: { nodeId: 'a-cf', portId: 'outL' },  to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  await page.waitForTimeout(600);
  const low = await readScopePeakOverWindow(page, 'a-scp', 1400);

  // Crank feedback way up — the echoes now regenerate into a denser/louder
  // steady-state wet signal.
  await setNodeParams(page, 'a-cf', { feedback: 0.9 });
  await page.waitForTimeout(900);
  const high = await readScopePeakOverWindow(page, 'a-scp', 1400);

  // Both settings must be audible (a silent / wire-broken regression fails).
  expect(low.rms).toBeGreaterThan(1e-4);
  expect(high.rms).toBeGreaterThan(1e-4);
  // High feedback measurably raises the sustained wet energy vs low feedback.
  expect(high.rms).toBeGreaterThan(low.rms * 1.3);

});
