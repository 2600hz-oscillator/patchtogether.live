// packages/web/src/lib/audio/modules/riotgirls.test.ts
//
// Pure-function unit tests for RIOTGIRLS:
//   - equal-power pan law (-1 -> hard L, 0 -> -3dB center, +1 -> hard R)
//   - setParam dispatcher (`v2_decay = 0.3` -> voices[1].setParam('decay', 0.3))
//   - voice-4 chain dispatch (vN_attack/decay/sustain/release -> v4 ADSR)

import { describe, it, expect } from 'vitest';
import { equalPowerPan, dispatchParam, type SetParamSink } from './riotgirls';

describe('equalPowerPan: -3 dB equal-power law', () => {
  it('pan = -1 -> (1, 0) hard left', () => {
    const { l, r } = equalPowerPan(-1);
    expect(l).toBeCloseTo(1, 3);
    expect(r).toBeCloseTo(0, 3);
  });

  it('pan = 0 -> (sqrt(2)/2, sqrt(2)/2) -3 dB center', () => {
    const { l, r } = equalPowerPan(0);
    expect(l).toBeCloseTo(0.7071, 3);
    expect(r).toBeCloseTo(0.7071, 3);
  });

  it('pan = +1 -> (0, 1) hard right', () => {
    const { l, r } = equalPowerPan(1);
    expect(l).toBeCloseTo(0, 3);
    expect(r).toBeCloseTo(1, 3);
  });

  it('clamps out-of-range pan values', () => {
    expect(equalPowerPan(-2).l).toBeCloseTo(1, 3);
    expect(equalPowerPan(2).r).toBeCloseTo(1, 3);
  });

  it('preserves L^2 + R^2 = 1 (constant power) across the pan range', () => {
    for (let p = -1; p <= 1; p += 0.1) {
      const { l, r } = equalPowerPan(p);
      const power = l * l + r * r;
      expect(power, `pan=${p} -> power ${power}`).toBeCloseTo(1, 3);
    }
  });
});

interface MockVoice {
  calls: Array<{ id: string; v: number }>;
  setParam: (id: string, v: number) => void;
}

function mockVoice(): MockVoice {
  const calls: Array<{ id: string; v: number }> = [];
  return {
    calls,
    setParam: (id, v) => { calls.push({ id, v }); },
  };
}

function buildSink(): {
  sink: SetParamSink;
  v: MockVoice[];
  bc: MockVoice;
  rv: MockVoice;
  flt: MockVoice;
  owned: Array<{ id: string; v: number }>;
} {
  const v = [mockVoice(), mockVoice(), mockVoice(), mockVoice()];
  const bc = mockVoice();
  const rv = mockVoice();
  const flt = mockVoice();
  const owned: Array<{ id: string; v: number }> = [];
  const sink: SetParamSink = {
    voices: v,
    bc,
    rv,
    flt,
    ownKnob: (id, val) => { owned.push({ id, v: val }); },
  };
  return { sink, v, bc, rv, flt, owned };
}

describe('dispatchParam: v1..v3 (DRUMMERGIRL) routing', () => {
  it('routes v2_decay = 0.3 -> voices[1].setParam("decay", 0.3)', () => {
    const { sink, v } = buildSink();
    dispatchParam(sink, 'v2_decay', 0.3);
    expect(v[1]!.calls).toEqual([{ id: 'decay', v: 0.3 }]);
    expect(v[0]!.calls).toEqual([]);
    expect(v[2]!.calls).toEqual([]);
  });

  it('routes each DRUMMERGIRL knob through its voice handle', () => {
    const { sink, v } = buildSink();
    dispatchParam(sink, 'v1_pitch',  12);
    dispatchParam(sink, 'v1_tone',   0.5);
    dispatchParam(sink, 'v1_shape',  0.7);
    dispatchParam(sink, 'v1_volume', 1.5);
    dispatchParam(sink, 'v1_decay',  0.2);
    expect(v[0]!.calls).toEqual([
      { id: 'pitch',  v: 12 },
      { id: 'tone',   v: 0.5 },
      { id: 'shape',  v: 0.7 },
      { id: 'volume', v: 1.5 },
      { id: 'decay',  v: 0.2 },
    ]);
  });

  it('per-voice pan/sendA/sendB go to ownKnob, NOT the voice handle', () => {
    const { sink, v, owned } = buildSink();
    dispatchParam(sink, 'v3_pan',   -0.5);
    dispatchParam(sink, 'v3_sendA',  0.4);
    dispatchParam(sink, 'v3_sendB',  0.6);
    expect(v[2]!.calls).toEqual([]);
    expect(owned).toEqual([
      { id: 'v3_pan',   v: -0.5 },
      { id: 'v3_sendA', v: 0.4 },
      { id: 'v3_sendB', v: 0.6 },
    ]);
  });
});

describe('dispatchParam: v4 (Wavetable + ADSR + VCA) routing', () => {
  it('v4_attack/decay/sustain/release -> voice4Handle.setParam', () => {
    const { sink, v } = buildSink();
    dispatchParam(sink, 'v4_attack',  1.5);
    dispatchParam(sink, 'v4_decay',   2.5);
    dispatchParam(sink, 'v4_sustain', 0.4);
    dispatchParam(sink, 'v4_release', 5.0);
    expect(v[3]!.calls).toEqual([
      { id: 'attack',  v: 1.5 },
      { id: 'decay',   v: 2.5 },
      { id: 'sustain', v: 0.4 },
      { id: 'release', v: 5.0 },
    ]);
  });

  it('v4_tune/wavePos/fmAmount/volume -> voice4Handle.setParam (WT/VCA legs)', () => {
    const { sink, v } = buildSink();
    dispatchParam(sink, 'v4_tune',     12);
    dispatchParam(sink, 'v4_wavePos',  0.8);
    dispatchParam(sink, 'v4_fmAmount', 0.5);
    dispatchParam(sink, 'v4_volume',   1.2);
    expect(v[3]!.calls).toEqual([
      { id: 'tune',     v: 12 },
      { id: 'wavePos',  v: 0.8 },
      { id: 'fmAmount', v: 0.5 },
      { id: 'volume',   v: 1.2 },
    ]);
  });

  it('voice 4 envelope max ranges allow the long-tail values from the plan', () => {
    const { sink, v } = buildSink();
    dispatchParam(sink, 'v4_attack',  2.0);
    dispatchParam(sink, 'v4_decay',   4.0);
    dispatchParam(sink, 'v4_release', 8.0);
    expect(v[3]!.calls.map((c) => c.v)).toEqual([2.0, 4.0, 8.0]);
  });
});

describe('dispatchParam: FX routing', () => {
  it('bc_<param> -> bc.setParam', () => {
    const { sink, bc } = buildSink();
    dispatchParam(sink, 'bc_decimate', 8);
    dispatchParam(sink, 'bc_bits',     4);
    dispatchParam(sink, 'bc_wet',      0.5);
    expect(bc.calls).toEqual([
      { id: 'decimate', v: 8 },
      { id: 'bits',     v: 4 },
      { id: 'wet',      v: 0.5 },
    ]);
  });

  it('rv_<param> -> rv.setParam', () => {
    const { sink, rv } = buildSink();
    dispatchParam(sink, 'rv_size', 0.7);
    dispatchParam(sink, 'rv_damp', 0.4);
    dispatchParam(sink, 'rv_mix',  0.6);
    expect(rv.calls).toEqual([
      { id: 'size', v: 0.7 },
      { id: 'damp', v: 0.4 },
      { id: 'mix',  v: 0.6 },
    ]);
  });

  it('flt_<param> -> flt.setParam (master QBRT filter)', () => {
    const { sink, flt } = buildSink();
    dispatchParam(sink, 'flt_cutoff',    8000);
    dispatchParam(sink, 'flt_resonance', 0.8);
    dispatchParam(sink, 'flt_mode',      1);
    dispatchParam(sink, 'flt_pingDecay', 0.25);
    expect(flt.calls).toEqual([
      { id: 'cutoff',    v: 8000 },
      { id: 'resonance', v: 0.8 },
      { id: 'mode',      v: 1 },
      { id: 'pingDecay', v: 0.25 },
    ]);
  });

  it('returnA / returnB -> ownKnob (master return amounts)', () => {
    const { sink, owned } = buildSink();
    dispatchParam(sink, 'returnA', 0.3);
    dispatchParam(sink, 'returnB', 0.6);
    expect(owned).toEqual([
      { id: 'returnA', v: 0.3 },
      { id: 'returnB', v: 0.6 },
    ]);
  });
});
