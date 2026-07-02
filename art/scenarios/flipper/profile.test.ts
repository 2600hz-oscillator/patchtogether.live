// art/scenarios/flipper/profile.test.ts
//
// AUDIO PROFILE for FLIPPER (backfill batch 1 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: gate UTILITY (alternating flip-flop router). Driver: the
// canonical 240 BPM trigger train (clockTrain — DETERMINISM.md tempo, epoch
// pinned to sample 0), 1.0 s → four 5 ms pulses at 0 / 0.25 / 0.5 / 0.75 s.
// The first gate after reset fires FLIP, so the train alternates
// flip-flop-flip-flop — both outputs carry genuinely different pulse
// positions and BOTH are captured (owner decision §6b.2: distinct taps).
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/flipper-dsp.ts
// FlipperState) — the EXACT per-sample code the worklet runs
// (../flipper.ts imports FlipperState; no mirror, no drift). Deterministic
// by construction: no RNG, no time, threshold + routing state only.
//
// The .sha pins BOTH the worklet entry and the -dsp lib (combinedSourceSha
// discipline) so a change in either forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { FlipperState } from '../../../packages/dsp/src/lib/flipper-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { clockTrain, CLOCK_BPM, TRIGGER_PULSE_S } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

function renderProfile(): Record<string, Float32Array> {
  // 240 BPM trigger train on input 1 (input 2 unpatched → 0), pulses at
  // 0 / 0.25 / 0.5 / 0.75 s. Matches the worklet: in2 = 0 when no cable.
  const trig = clockTrain(DURATION_S);
  const st = new FlipperState();
  return captureOutputs({ durationS: DURATION_S, outputs: ['flip', 'flop'] }, (i) => {
    const [flip, flop] = st.step(trig[i]!, 0);
    return { flip, flop };
  });
}

/** Sample index of pulse k of the 240 BPM train (period 0.25 s). */
const pulseStart = (k: number) => Math.round(k * (60 / CLOCK_BPM) * SR);
const pulseLen = Math.max(1, Math.round(TRIGGER_PULSE_S * SR));

describe('ART flipper / audio profile (240 BPM trigger train alternates flip/flop)', () => {
  it('routes pulses 1&3 to FLIP and pulses 2&4 to FLOP, deterministically', () => {
    const { flip, flop } = renderProfile() as { flip: Float32Array; flop: Float32Array };
    expect(flip.length).toBe(Math.round(SR * DURATION_S));
    expect(flip.every(Number.isFinite)).toBe(true);
    expect(flop.every(Number.isFinite)).toBe(true);
    // Pulse k lands on FLIP for even k, FLOP for odd k — and NEVER both.
    for (let k = 0; k < 4; k++) {
      const s = pulseStart(k);
      const onFlip = k % 2 === 0;
      for (let i = s; i < s + pulseLen; i++) {
        expect(flip[i]).toBe(onFlip ? 1 : 0);
        expect(flop[i]).toBe(onFlip ? 0 : 1);
      }
      // Both silent right after the pulse ends.
      expect(flip[s + pulseLen + 1]).toBe(0);
      expect(flop[s + pulseLen + 1]).toBe(0);
    }
    // Deterministic re-render is bit-identical.
    const again = renderProfile();
    let diff = 0;
    for (let i = 0; i < flip.length; i++) {
      diff = Math.max(diff, Math.abs(again.flip![i]! - flip[i]!), Math.abs(again.flop![i]! - flop[i]!));
    }
    expect(diff).toBe(0);
  });

  it('pins the flip + flop profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('flipper.ts', 'lib/flipper-dsp.ts');
    await pinAll('flipper', srcSha, renderProfile());
  });
});
