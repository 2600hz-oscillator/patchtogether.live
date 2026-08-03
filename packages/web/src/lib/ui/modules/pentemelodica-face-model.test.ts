// packages/web/src/lib/ui/modules/pentemelodica-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind PENTEMELODICA's derived readouts.
//
// Each is perturbed on the input a knob readback is BLIND to, AND pinned in the
// direction it must NOT follow. Plus a SOURCE-ANCHORED check that
// `penteModeGainAtCutoff` still mirrors `modeMorph`'s segment arithmetic, so
// the closed form cannot rot silently against the DSP it claims to model.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { faceReadoutValueFor, faceReadoutValueIds } from '$lib/ui/workflow/face-readout-values';
import {
  penteDecayToSustainMs,
  penteModeGainAtCutoff,
  pentePeakLinear,
  penteReleaseTailMs,
  pentemelodicaFaceParams,
  type PenteFaceParams,
} from './pentemelodica-face-model';

const DEFAULTS: PenteFaceParams = pentemelodicaFaceParams(() => undefined);

function withParams(over: Partial<PenteFaceParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => {
    const mv = /^v([1-5])_(level|pan)$/.exec(id);
    if (mv) {
      const i = Number(mv[1]) - 1;
      return mv[2] === 'level' ? p.levels[i] : p.pans[i];
    }
    return (p as unknown as Record<string, number>)[id];
  };
}

function readout(id: string, over: Partial<PenteFaceParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

describe('pentemelodica face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS.mode).toBe(0);
    expect(DEFAULTS.resonance).toBe(0.2);
    expect(DEFAULTS.sustain).toBe(1);
    expect(DEFAULTS.release).toBe(0.005);
    expect(DEFAULTS.levels).toEqual([0.8, 0.8, 0.8, 0.8, 0.8]);
    expect(DEFAULTS.pans).toEqual([0, 0, 0, 0, 0]);
  });

  it('prints the face’s own figures', () => {
    expect(readout('pentemelodica-mode-gain')).toBe('-4.1 dB');
    expect(readout('pentemelodica-peak-dbfs')).toBe('+4.6 dBFS');
    expect(readout('pentemelodica-release-tail')).toBe('58 ms');
    expect(readout('pentemelodica-decay-to-sustain')).toBe('0 ms');
  });

  it('every registered pentemelodica readout is TOTAL', () => {
    const ids = faceReadoutValueIds().filter((k) => k.startsWith('pentemelodica-'));
    expect(ids.length).toBe(4);
    for (const id of ids) {
      const fn = faceReadoutValueFor(id)!;
      expect(fn(() => undefined), `${id} on a fresh node`).not.toBe('');
      for (const bad of [Number.NaN, Infinity, -Infinity, -5, 1e9]) {
        expect(typeof fn(() => bad), `${id} at ${bad}`).toBe('string');
        expect(fn(() => bad), `${id} at ${bad}`).not.toBe('');
      }
    }
  });
});

describe('pentemelodica face model — NEGATIVE CONTROLS', () => {
  // (a) THE MODE-1 TAP IS NOT A NOTCH, and RESONANCE is what says how deep it
  //     goes. A MODE-only readout is invariant to exactly this.
  it('at MODE 1 the response is set by RESONANCE, not by MODE', () => {
    const g = (r: number): number => penteModeGainAtCutoff(1, r);
    expect(g(0)).toBeCloseTo(0.5, 6);
    expect(g(0.2)).toBeCloseTo(0.375, 6);
    expect(g(0.5)).toBeCloseTo(0, 9); // the TRUE null — k = 1
    expect(g(0.8)).toBeCloseTo(1.5, 6);
    expect(g(0.99)).toBeCloseTo(49, 6); // +33.8 dB of resonant BOOST on the bus
    // …and the printed readout moves with it, over a MODE that never budges.
    const seen = new Set([0, 0.2, 0.8, 0.99].map((resonance) =>
      readout('pentemelodica-mode-gain', { mode: 1, resonance }),
    ));
    expect(seen.size, 'a MODE readout would print one string for all four').toBe(4);
  });

  it('the three MODE landmarks below the fourth tap are pure 1/k', () => {
    for (const m of [0, 1 / 3, 2 / 3]) {
      expect(penteModeGainAtCutoff(m, 0.2)).toBeCloseTo(1 / 1.6, 6);
    }
  });

  // (b) PEAK is a function of LEVEL **and** PAN. A level readback is
  //     pan-invariant, so spreading the pans is the leg it cannot see.
  it('spreading the PANS lowers the per-channel peak with every LEVEL held', () => {
    expect(pentePeakLinear(DEFAULTS.levels, DEFAULTS.pans)).toBeCloseTo(1.6971, 4);
    expect(pentePeakLinear(DEFAULTS.levels, [-0.8, -0.4, 0, 0.4, 0.8])).toBeCloseTo(1.5342, 4);
    expect(readout('pentemelodica-peak-dbfs', { pans: [-0.8, -0.4, 0, 0.4, 0.8] })).toBe(
      '+3.7 dBFS',
    );
  });

  it('one voice peaks at −9.4 dBFS and five at +4.6 — a CONSTANT 0.6, never 1/√N', () => {
    expect(pentePeakLinear([0.8, 0, 0, 0, 0], [0, 0, 0, 0, 0])).toBeCloseTo(0.3394, 4);
    expect(20 * Math.log10(pentePeakLinear([0.8, 0, 0, 0, 0], [0, 0, 0, 0, 0]))).toBeCloseTo(
      -9.39,
      2,
    );
  });

  // (c) THE RELEASE TAIL. The RELEASE knob is SUSTAIN-invariant; the tail is not.
  it('SUSTAIN moves the release tail while the RELEASE knob sits still', () => {
    expect(penteReleaseTailMs(0.005, 1)).toBeCloseTo(57.56, 2);
    expect(penteReleaseTailMs(0.005, 0.1)).toBeCloseTo(46.05, 2);
    expect(penteReleaseTailMs(0.005, 0)).toBe(0);
    expect(readout('pentemelodica-release-tail', { sustain: 0.1 })).toBe('46 ms');
    // …and the honest headline: the shipped 5 ms release rings for 11.5× that.
    expect(penteReleaseTailMs(0.005, 1) / (0.005 * 1000)).toBeCloseTo(11.51, 2);
  });

  // (d) THE DECAY THAT NEVER RUNS.
  it('at the shipped SUSTAIN of 1 the decay branch exits on its FIRST tick', () => {
    expect(penteDecayToSustainMs(0.1, 1)).toBe(0);
    expect(penteDecayToSustainMs(5, 1)).toBe(0);
    expect(penteDecayToSustainMs(0.1, 0.7)).toBeCloseTo(800.64, 2);
    expect(readout('pentemelodica-decay-to-sustain', { sustain: 0.7 })).toBe('801 ms');
  });
});

describe('pentemelodica face model — the DSP-source pin', () => {
  // The closed form above is derived FROM `modeMorph`'s segment arithmetic and
  // from `notch = x - taps.bp` (which is NOT the true SVF notch — see the model
  // header). If either changes, the derivation is silently wrong about the
  // module rather than loudly wrong here.
  it('the mode morph still segments 3-ways and still taps `x - bp`', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/pentemelodica-dsp.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('const seg = Math.min(2, Math.floor(m3));');
    expect(src).toContain('const notch = x - taps.bp;');
    expect(src).toContain('return taps.hp * (1 - t) + notch * t;');
  });

  it('the envelope’s two exit thresholds still match the model’s mirrors', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/pentemelodica-dsp.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('Math.abs(this.value - susTarget) < 1e-4');
    expect(src).toContain('this.value < 1e-5');
  });
});
