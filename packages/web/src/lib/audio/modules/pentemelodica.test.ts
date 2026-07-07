// packages/web/src/lib/audio/modules/pentemelodica.test.ts
//
// Unit tests for PENTEMELODICA:
//   - module-def shape (6 inputs, 7 outputs, 60 params, stereoPairs, palette)
//   - pentemelodicaMath render mirror sanity (poly → 5 voices; a chord differs
//     from a single note; pan law).
//
// Worklet-level behavior (k-rate param plumbing, audio-rate FM through the jack)
// is covered by the e2e + per-port sweeps.

import { describe, expect, it } from 'vitest';
import { pentemelodicaDef, pentemelodicaMath, PENTE_VOICES } from './pentemelodica';

const SR = 48000;

describe('pentemelodicaDef shape', () => {
  it('declares 48 params: 5 voices × 8 + 4 shared ADSR + 4 filter', () => {
    expect(pentemelodicaDef.params.length).toBe(PENTE_VOICES * 8 + 4 + 4);
  });

  it('every voice has the 8-param OSC/mix set with the documented ranges (NO per-voice ADSR)', () => {
    const want: Array<{ suffix: string; min: number; max: number; def: number; curve: string }> = [
      { suffix: 'tune', min: -36, max: 36, def: 0, curve: 'linear' },
      { suffix: 'fine', min: -100, max: 100, def: 0, curve: 'linear' },
      { suffix: 'fm', min: -1, max: 1, def: 0, curve: 'linear' },
      { suffix: 'pm', min: -1, max: 1, def: 0, curve: 'linear' },
      { suffix: 'pw', min: 0.05, max: 0.95, def: 0.5, curve: 'linear' },
      { suffix: 'wave', min: 0, max: 1, def: 0, curve: 'linear' },
      { suffix: 'level', min: 0, max: 1, def: 0.8, curve: 'linear' },
      { suffix: 'pan', min: -1, max: 1, def: 0, curve: 'linear' },
    ];
    for (let v = 1; v <= PENTE_VOICES; v++) {
      for (const w of want) {
        const p = pentemelodicaDef.params.find((x) => x.id === `v${v}_${w.suffix}`);
        expect(p, `v${v}_${w.suffix} present`).toBeDefined();
        expect(p!.min).toBe(w.min);
        expect(p!.max).toBe(w.max);
        expect(p!.defaultValue).toBe(w.def);
        expect(p!.curve).toBe(w.curve);
      }
      // The per-voice ADSR params are GONE (collapsed to one shared ADSR).
      for (const suffix of ['attack', 'decay', 'sustain', 'release']) {
        expect(
          pentemelodicaDef.params.find((x) => x.id === `v${v}_${suffix}`),
          `v${v}_${suffix} should NOT exist (ADSR is shared)`,
        ).toBeUndefined();
      }
    }
  });

});

function defVoices() {
  return Array.from({ length: PENTE_VOICES }, () => ({
    tune: 0, fine: 0, fm: 0, pm: 0, pw: 0.5, wave: 0, level: 0.8, pan: 0,
  }));
}
function defFilter() {
  return { cutoff: 1000, resonance: 0.2, mode: 0, wetdry: 1 };
}
function bus(lanes: Array<{ voct: number; gate: boolean }>) {
  const b = new Array(PENTE_VOICES * 2).fill(0);
  for (let i = 0; i < Math.min(lanes.length, PENTE_VOICES); i++) {
    b[i * 2] = lanes[i]!.voct;
    b[i * 2 + 1] = lanes[i]!.gate ? 1 : 0;
  }
  return b;
}
function rms(a: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}

describe('pentemelodicaMath render mirror', () => {
  const N = 2048;

  it('5 gated lanes produce 5 nonzero pre-mixer taps + a stereo mix', () => {
    const voices = defVoices();
    voices.forEach((v, i) => { v.tune = i * 4; });
    const out = pentemelodicaMath.render(N, SR, {
      polyPitchGate: bus([
        { voct: 0, gate: true }, { voct: 0, gate: true }, { voct: 0, gate: true },
        { voct: 0, gate: true }, { voct: 0, gate: true },
      ]),
      voices,
      filter: defFilter(),
    });
    for (let v = 0; v < PENTE_VOICES; v++) {
      expect(rms(out.voices[v]!), `voice ${v}`).toBeGreaterThan(1e-3);
      for (let i = 0; i < N; i++) expect(Number.isFinite(out.voices[v]![i]!)).toBe(true);
    }
    expect(rms(out.outL)).toBeGreaterThan(1e-3);
    expect(rms(out.outR)).toBeGreaterThan(1e-3);
  });

  it('a chord differs from (and is louder than) a single note', () => {
    const single = pentemelodicaMath.render(N, SR, {
      polyPitchGate: bus([{ voct: 0, gate: true }]),
      voices: defVoices(),
      filter: defFilter(),
    });
    const chord = pentemelodicaMath.render(N, SR, {
      polyPitchGate: bus([
        { voct: 0, gate: true }, { voct: 4 / 12, gate: true }, { voct: 7 / 12, gate: true },
      ]),
      voices: defVoices(),
      filter: defFilter(),
    });
    expect(rms(chord.outL)).toBeGreaterThan(rms(single.outL));
  });

  it('pan: voice 0 panned hard-left puts the mix on L only', () => {
    const voices = defVoices();
    voices[0]!.pan = -1;
    const out = pentemelodicaMath.render(N, SR, {
      polyPitchGate: bus([{ voct: 0, gate: true }]),
      voices,
      filter: defFilter(),
    });
    expect(rms(out.outL)).toBeGreaterThan(1e-3);
    expect(rms(out.outR)).toBeLessThan(1e-5);
  });
});
