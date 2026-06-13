// packages/dsp/src/lib/gatemaiden-dsp.test.ts
//
// Behaviour spec for the GATEMAIDEN converter core: gate→trigger (one trigger
// per gate START) and trigger→gate (a short trigger widened to a usable gate).

import { describe, it, expect } from 'vitest';
import {
  GateMaidenState,
  GATE_LEN_DEFAULT,
  TRIGGER_PULSE_S,
} from './gatemaiden-dsp';

const SR = 48000;
const TRIG_SAMPLES = Math.round(TRIGGER_PULSE_S * SR); // 240
const GATE_SAMPLES = Math.round(GATE_LEN_DEFAULT * SR); // 2400

function run(
  st: GateMaidenState,
  inputs: number[],
  gateLenSec = GATE_LEN_DEFAULT,
  trigShape = 0,
): { gate: number; trig: number }[] {
  return inputs.map((x) => st.step(x, gateLenSec, trigShape));
}

/** Count rising 0→>0 transitions on the trig stream (= distinct trigger pulses). */
function countTrigPulses(outs: { trig: number }[]): number {
  let count = 0;
  let prev = 0;
  for (const o of outs) {
    if (o.trig > 0 && prev <= 0) count++;
    prev = o.trig;
  }
  return count;
}

describe('GateMaidenState — gate↔trigger conversion', () => {
  it('GATE in → exactly ONE trigger on the gate START (gate→trigger)', () => {
    const st = new GateMaidenState(SR);
    // A long held gate: high for 1000 samples, then low.
    const outs = run(st, [...Array(1000).fill(1), ...Array(1000).fill(0)]);
    expect(countTrigPulses(outs)).toBe(1); // one trigger at the rising edge only
  });

  it('GATE in → gate output is duration-matched (no tail when input outlives min width)', () => {
    const st = new GateMaidenState(SR);
    const D = GATE_SAMPLES + 600; // longer than the min width
    const outs = run(st, [...Array(D).fill(1), ...Array(1000).fill(0)]);
    const gateHigh = outs.filter((o) => o.gate === 1).length;
    expect(gateHigh).toBe(D); // passthrough — falls exactly when the input falls
  });

  it('TRIGGER in (1 sample) → gate widened to the minimum Len (trigger→gate)', () => {
    const st = new GateMaidenState(SR);
    const outs = run(st, [1, ...Array(GATE_SAMPLES + 1000).fill(0)]);
    const gateHigh = outs.filter((o) => o.gate === 1).length;
    expect(gateHigh).toBe(GATE_SAMPLES); // a 1-sample strike opens a full Len gate
    expect(countTrigPulses(outs)).toBe(1); // trig still fires once (passthrough)
  });

  it('triangle trigger reaches ~1 at mid-pulse + crosses GATE_HI exactly once', () => {
    const st = new GateMaidenState(SR);
    const trigs = run(st, [1, ...Array(500).fill(0)], GATE_LEN_DEFAULT, 0).map((o) => o.trig);
    const peak = Math.max(...trigs);
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThanOrEqual(1);
    let crossings = 0;
    let prev = 0;
    for (const t of trigs) {
      if (prev < 0.5 && t >= 0.5) crossings++;
      prev = t;
    }
    expect(crossings).toBe(1); // a downstream edge detector sees ONE rise
  });

  it('square trigger is a flat-top pulse of TRIGGER_PULSE_S width', () => {
    const st = new GateMaidenState(SR);
    const trigs = run(st, [1, ...Array(500).fill(0)], GATE_LEN_DEFAULT, 1).map((o) => o.trig);
    expect(Math.max(...trigs)).toBe(1);
    expect(trigs.filter((t) => t > 0).length).toBe(TRIG_SAMPLES);
  });

  it('a HELD-HIGH input never re-triggers (single rise, like real hardware)', () => {
    const st = new GateMaidenState(SR);
    // 50000 samples high — way longer than the trig pulse. Must be ONE trigger.
    const outs = run(st, Array(50000).fill(1));
    expect(countTrigPulses(outs)).toBe(1);
  });

  it('reset() re-arms so the next high is a fresh trigger', () => {
    const st = new GateMaidenState(SR);
    st.step(1, GATE_LEN_DEFAULT, 0); // first rising edge
    st.reset();
    const o = st.step(1, GATE_LEN_DEFAULT, 0); // input still high, but reset → fresh rise
    expect(o.trig).toBeGreaterThan(0);
  });
});
