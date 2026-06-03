// packages/dsp/src/lib/trigger-convert-dsp.test.ts
//
// Pure timing tests for the MOOG 961 INTERFACE conversion logic. Proves the
// two behaviours the spec calls out for explicit coverage:
//   • the audio→trigger SENSITIVITY threshold (rectified crossing fires a
//     single rising-edge pulse on v_out1 + v_out2), and
//   • the column-B FIXED-WIDTH one-shot (switchOnTime seconds, sample-accurate,
//     retriggerable), plus the column-A width-matched passthrough and the
//     s_in → V-out format passthrough.

import { describe, it, expect } from 'vitest';
import {
  TriggerConvertState,
  GATE_THRESHOLD,
  SWITCH_ON_TIME_DEFAULT,
  SWITCH_ON_TIME_MIN,
} from './trigger-convert-dsp';

const SR = 48000;

/** Count how many consecutive samples sOutB is high starting at the first high
 *  sample, driving a single rising edge on v_in_b then holding it low. */
function measurePulseWidth(switchOnTimeSec: number, sr = SR): number {
  const st = new TriggerConvertState(sr);
  // One rising edge on v_in_b, then low for plenty of samples to let the pulse
  // finish (cap iterations well beyond the max possible pulse).
  const cap = Math.round(switchOnTimeSec * sr) + 10;
  let width = 0;
  // sample 0: rising edge (v_in_b high)
  let out = st.step(0, 0, 0, 1, 0.5, switchOnTimeSec);
  if (out.sOutB > 0) width++;
  // subsequent samples: v_in_b low — pulse should keep running to completion
  for (let i = 1; i < cap; i++) {
    out = st.step(0, 0, 0, 0, 0.5, switchOnTimeSec);
    if (out.sOutB > 0) width++;
    else break;
  }
  return width;
}

describe('TriggerConvertState — audio→trigger sensitivity threshold', () => {
  it('fires v_out1 AND v_out2 on a rising rectified crossing of the threshold', () => {
    const st = new TriggerConvertState(SR);
    const sens = 0.5;
    // Below threshold → nothing.
    let o = st.step(0.4, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT);
    expect(o.vOut1).toBe(0);
    expect(o.vOut2).toBe(0);
    // Cross above threshold → both V outs fire (single-sample edge tick).
    o = st.step(0.6, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT);
    expect(o.vOut1).toBe(1);
    expect(o.vOut2).toBe(1);
  });

  it('does not re-fire while held above threshold (rising-edge only)', () => {
    const st = new TriggerConvertState(SR);
    const sens = 0.5;
    expect(st.step(0.6, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(1);
    // Still high → no new edge.
    expect(st.step(0.7, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(0);
    expect(st.step(0.9, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(0);
    // Drop below, then cross again → new edge.
    expect(st.step(0.1, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(0);
    expect(st.step(0.8, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(1);
  });

  it('rectifies — a negative excursion past -threshold also fires', () => {
    const st = new TriggerConvertState(SR);
    const sens = 0.5;
    expect(st.step(-0.4, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(0);
    expect(st.step(-0.7, 0, 0, 0, sens, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(1);
  });

  it('a higher sensitivity setting requires a louder signal to fire', () => {
    const loud = new TriggerConvertState(SR);
    // sensitivity 0.9: a 0.6 signal is BELOW threshold → no fire.
    expect(loud.step(0.6, 0, 0, 0, 0.9, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(0);
    const sensitive = new TriggerConvertState(SR);
    // sensitivity 0.3: the same 0.6 signal is ABOVE threshold → fires.
    expect(sensitive.step(0.6, 0, 0, 0, 0.3, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(1);
  });
});

describe('TriggerConvertState — s_in format passthrough to V outs', () => {
  it('mirrors s_in onto v_out1 AND v_out2 for its whole high duration', () => {
    const st = new TriggerConvertState(SR);
    // s_in held high for 3 samples → both V outs high all 3.
    for (let i = 0; i < 3; i++) {
      const o = st.step(0, 1, 0, 0, 0.5, SWITCH_ON_TIME_DEFAULT);
      expect(o.vOut1).toBe(1);
      expect(o.vOut2).toBe(1);
    }
    // s_in low → V outs low (no audio driving them).
    const o = st.step(0, 0, 0, 0, 0.5, SWITCH_ON_TIME_DEFAULT);
    expect(o.vOut1).toBe(0);
    expect(o.vOut2).toBe(0);
  });
});

describe('TriggerConvertState — column A width-matched passthrough', () => {
  it('passes v_in_a → s_out_a with the INPUT gate width', () => {
    const st = new TriggerConvertState(SR);
    // Hold v_in_a high 4 samples → s_out_a high 4 samples.
    let highCount = 0;
    for (let i = 0; i < 4; i++) {
      if (st.step(0, 0, 1, 0, 0.5, SWITCH_ON_TIME_DEFAULT).sOutA > 0) highCount++;
    }
    expect(highCount).toBe(4);
    // Low → s_out_a low.
    expect(st.step(0, 0, 0, 0, 0.5, SWITCH_ON_TIME_DEFAULT).sOutA).toBe(0);
  });

  it('treats a sub-threshold v_in_a as low', () => {
    const st = new TriggerConvertState(SR);
    const below = GATE_THRESHOLD - 0.01;
    expect(st.step(0, 0, below, 0, 0.5, SWITCH_ON_TIME_DEFAULT).sOutA).toBe(0);
  });
});

describe('TriggerConvertState — column B fixed-width one-shot (switchOnTime)', () => {
  it('emits a pulse of ~switchOnTime seconds on each v_in_b rising edge', () => {
    // 0.2s default at 48k = 9600 samples.
    const expected = Math.round(SWITCH_ON_TIME_DEFAULT * SR);
    expect(measurePulseWidth(SWITCH_ON_TIME_DEFAULT)).toBe(expected);
  });

  it('the pulse width scales with switchOnTime (0.1s vs 0.5s)', () => {
    expect(measurePulseWidth(0.1)).toBe(Math.round(0.1 * SR));
    expect(measurePulseWidth(0.5)).toBe(Math.round(0.5 * SR));
  });

  it('the pulse is FIXED width — it does NOT depend on the input gate width', () => {
    // Hold v_in_b high far longer than the pulse; sOutB still ends after the
    // fixed pulse width (one-shot, not a passthrough).
    const st = new TriggerConvertState(SR);
    const sw = SWITCH_ON_TIME_MIN; // shortest pulse
    const pulse = st.pulseSamples(sw);
    let width = 0;
    // Hold v_in_b high for 3× the pulse length.
    for (let i = 0; i < pulse * 3; i++) {
      if (st.step(0, 0, 0, 1, 0.5, sw).sOutB > 0) width++;
    }
    expect(width).toBe(pulse);
  });

  it('retriggers — a new rising edge restarts the full pulse', () => {
    const st = new TriggerConvertState(SR);
    const sw = 0.05;
    const pulse = st.pulseSamples(sw);
    // Fire once, run halfway through the pulse.
    st.step(0, 0, 0, 1, 0.5, sw); // rising edge
    const half = Math.floor(pulse / 2);
    for (let i = 1; i < half; i++) st.step(0, 0, 0, 0, 0.5, sw);
    // Drop low for one sample, then a fresh rising edge mid-pulse.
    st.step(0, 0, 0, 0, 0.5, sw);
    st.step(0, 0, 0, 1, 0.5, sw); // retrigger (counts as sample 1 of new pulse)
    // From here the pulse should run pulse-1 MORE high samples (we already
    // consumed sample 1 on the retrigger), then go low.
    let remaining = 0;
    for (let i = 0; i < pulse + 5; i++) {
      if (st.step(0, 0, 0, 0, 0.5, sw).sOutB > 0) remaining++;
      else break;
    }
    expect(remaining).toBe(pulse - 1);
  });

  it('pulseSamples clamps to the param range + floors at 1 sample', () => {
    const st = new TriggerConvertState(SR);
    // Below min clamps to min.
    expect(st.pulseSamples(0)).toBe(Math.round(SWITCH_ON_TIME_MIN * SR));
    // Above max clamps to max.
    expect(st.pulseSamples(99)).toBe(Math.round(4 * SR));
    // A tiny SR can't produce a 0-length pulse.
    const tiny = new TriggerConvertState(1);
    expect(tiny.pulseSamples(SWITCH_ON_TIME_MIN)).toBeGreaterThanOrEqual(1);
  });
});

describe('TriggerConvertState — independence + reset', () => {
  it('all four circuits operate independently in one step()', () => {
    const st = new TriggerConvertState(SR);
    // audio rising (fires V), s_in low, v_in_a high (s_out_a), v_in_b rising
    // (starts s_out_b pulse) — all in one sample.
    const o = st.step(0.9, 0, 1, 1, 0.5, SWITCH_ON_TIME_DEFAULT);
    expect(o.vOut1).toBe(1); // from audio edge
    expect(o.vOut2).toBe(1);
    expect(o.sOutA).toBe(1); // from v_in_a passthrough
    expect(o.sOutB).toBe(1); // from v_in_b one-shot start
  });

  it('reset() clears edge state + an in-flight column-B pulse', () => {
    const st = new TriggerConvertState(SR);
    st.step(0, 0, 0, 1, 0.5, SWITCH_ON_TIME_DEFAULT); // start a long pulse
    st.reset();
    // After reset the pulse is gone (low without a fresh edge).
    expect(st.step(0, 0, 0, 0, 0.5, SWITCH_ON_TIME_DEFAULT).sOutB).toBe(0);
    // And a fresh audio edge fires again (audioWasHigh cleared).
    expect(st.step(0.9, 0, 0, 0, 0.5, SWITCH_ON_TIME_DEFAULT).vOut1).toBe(1);
  });
});
