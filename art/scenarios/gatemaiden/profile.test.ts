// art/scenarios/gatemaiden/profile.test.ts
//
// AUDIO PROFILE for GATEMAIDEN (backfill batch 1 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: gate UTILITY — the user-facing gate↔trigger converter. The
// driver exercises BOTH conversion directions in one deterministic input:
//   • two 5 ms TRIGGER pulses (t = 0.1 s, 0.35 s)  → widened to the 50 ms
//     minimum gate (trigger→gate), each also re-emitting a shaped trig;
//   • one 350 ms HELD GATE (t = 0.6..0.95 s)       → passed through
//     duration-matched on GATE, one trig on its rising edge (gate→trigger).
// Both outputs carry independent information (owner decision §6b.2) and
// both are captured: `gate` (held-square) + `trig` (5 ms triangles).
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/gatemaiden-dsp.ts
// GateMaidenState) — the EXACT per-sample code the worklet runs
// (../gatemaiden.ts holds one GateMaidenState and mirrors step() 1:1; no
// mirror, no drift). Params are the worklet's shipping defaults
// (gateLen = GATE_LEN_DEFAULT 50 ms, trigShape = 0 triangle). No RNG.
//
// The .sha pins BOTH the worklet entry and the -dsp lib (combinedSourceSha
// discipline) so a change in either forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import {
  GATE_LEN_DEFAULT,
  GateMaidenState,
  TRIGGER_PULSE_S,
} from '../../../packages/dsp/src/lib/gatemaiden-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';

const SR = SAMPLE_RATE;
const DURATION_S = 1.2;

// Driver schedule (seconds) — two short triggers, then one long gate.
const TRIG_1_S = 0.1;
const TRIG_2_S = 0.35;
const GATE_ON_S = 0.6;
const GATE_OFF_S = 0.95;

function driverInput(): Float32Array {
  const buf = new Float32Array(Math.round(SR * DURATION_S));
  const at = (s: number) => Math.round(s * SR);
  const pulseN = Math.max(1, Math.round(TRIGGER_PULSE_S * SR));
  buf.fill(1, at(TRIG_1_S), at(TRIG_1_S) + pulseN);
  buf.fill(1, at(TRIG_2_S), at(TRIG_2_S) + pulseN);
  buf.fill(1, at(GATE_ON_S), at(GATE_OFF_S));
  return buf;
}

function renderProfile(): Record<string, Float32Array> {
  const input = driverInput();
  const st = new GateMaidenState(SR);
  return captureOutputs({ durationS: DURATION_S, outputs: ['gate', 'trig'] }, (i) => {
    const out = st.step(input[i]!, GATE_LEN_DEFAULT, 0);
    return { gate: out.gate, trig: out.trig };
  });
}

describe('ART gatemaiden / audio profile (triggers→gates + gate→trigger, default 50 ms)', () => {
  it('widens triggers to the min gate, passes the long gate through, trigs each rise', () => {
    const { gate, trig } = renderProfile() as { gate: Float32Array; trig: Float32Array };
    const at = (s: number) => Math.round(s * SR);
    expect(gate.length).toBe(Math.round(SR * DURATION_S));
    expect(gate.every(Number.isFinite)).toBe(true);
    expect(trig.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    // Trigger→gate widening: high across the FULL 50 ms window after each
    // 5 ms pulse, low again after it.
    for (const t of [TRIG_1_S, TRIG_2_S]) {
      expect(gate[at(t) + Math.round(0.04 * SR)]).toBe(1); // 40 ms in — widened
      expect(gate[at(t) + Math.round(0.06 * SR)]).toBe(0); // 60 ms in — closed
    }
    // Gate passthrough: high for the input's own 350 ms (> the 50 ms min),
    // low right after the falling edge.
    expect(gate[at(0.8)]).toBe(1);
    expect(gate[at(GATE_OFF_S) + 2]).toBe(0);
    // One triangle trig per rising edge (3 total): peak ~1 mid-pulse.
    for (const t of [TRIG_1_S, TRIG_2_S, GATE_ON_S]) {
      const mid = at(t) + Math.round((TRIGGER_PULSE_S / 2) * SR);
      expect(trig[mid]!).toBeGreaterThan(0.9);
      expect(trig[at(t) + Math.round(0.01 * SR)]).toBe(0); // over by +10 ms
    }
    // Deterministic re-render is bit-identical.
    const again = renderProfile();
    let diff = 0;
    for (let i = 0; i < gate.length; i++) {
      diff = Math.max(diff, Math.abs(again.gate![i]! - gate[i]!), Math.abs(again.trig![i]! - trig[i]!));
    }
    expect(diff).toBe(0);
  });

  it('pins the gate + trig profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('gatemaiden.ts', 'lib/gatemaiden-dsp.ts');
    await pinAll('gatemaiden', srcSha, renderProfile());
  });
});
