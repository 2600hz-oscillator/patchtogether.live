// packages/web/src/lib/audio/wavecel-spread-parity.test.ts
//
// THE SPREAD MATH EXISTS TWICE AND NOTHING JOINED THE TWO COPIES.
//
//   packages/dsp/src/lib/wavetable-osc.ts   — what the WORKLET plays
//   packages/web/src/lib/audio/wavecel-math.ts — what the CARD draws
//                                                (WavecelCard.svelte imports
//                                                 spreadTaps to highlight the
//                                                 active frames + tap fan)
//
// `wavetable-osc.test.ts` tests the first. `wavecel-math.test.ts` tests the
// second. Both were green while the two copies said the same WRONG thing, and
// both would have stayed green had one been fixed and the other not — the card
// would then have drawn a tap fan the oscillator was not playing. That is the
// same class as the card-vs-def divergence in CLAUDE.md: two sides of one
// contract, each with its own gate, and no gate across the seam.
//
// This is that gate. It sweeps the whole SPREAD travel at several centre
// frames — including the table EDGES, where the frame-index clamp bites and
// where the shipped stereo defect actually lived — and requires the two
// implementations to agree tap for tap and sample for sample.

import { describe, it, expect } from 'vitest';
import {
  spreadTaps as cardTaps,
  spreadMix as cardMix,
} from './wavecel-math';
import {
  spreadTaps as dspTaps,
  spreadMix as dspMix,
} from '../../../../dsp/src/lib/wavetable-osc';

/** 8 frames of 256 samples; frame k is the (k+1)th harmonic. */
const FRAMES: Float32Array[] = Array.from({ length: 8 }, (_, k) => {
  const f = new Float32Array(256);
  for (let i = 0; i < 256; i++) f[i] = Math.sin((2 * Math.PI * (k + 1) * i) / 256);
  return f;
});

/** The card's `spreadMix` takes a fetch callback; the DSP's reads the frames
 *  directly. Reproduce the DSP's `sampleFrame` here so the callback the card
 *  gets is the same function the worklet applies. */
function fetchAt(frameFloat: number, s1: number, s2: number, sFrac: number): number {
  const FC = FRAMES.length;
  const f1 = Math.max(0, Math.min(FC - 1, Math.floor(frameFloat)));
  const f2 = Math.max(0, Math.min(FC - 1, f1 + 1));
  const frameFrac = frameFloat - Math.floor(frameFloat);
  const a = FRAMES[f1]!;
  const b = FRAMES[f2]!;
  const va = a[s1]! + (a[s2]! - a[s1]!) * sFrac;
  const vb = b[s1]! + (b[s2]! - b[s1]!) * sFrac;
  return va + (vb - va) * frameFrac;
}

const SPREADS = [1, 1.0001, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5];
// 0 and 7 are the table EDGES — where the clamp aliased the old ±0.5 taps onto
// one another and killed the stereo at the def-default morph.
const CENTRES = [0, 0.5, 1, 3.5, 6, 7];

describe('SPREAD math parity · the worklet and the card must agree', () => {
  it('spreadTaps agrees exactly, over the whole travel and at the table edges', () => {
    for (const spread of SPREADS) {
      for (const centre of CENTRES) {
        const a = dspTaps(spread, centre);
        const b = cardTaps(spread, centre);
        expect(
          b,
          `spread ${spread} @ centre ${centre}: the card would draw a different ` +
          'tap fan from the one the worklet plays',
        ).toEqual(a);
      }
    }
  });

  it('spreadMix agrees to floating-point exactness', () => {
    for (const spread of SPREADS) {
      for (const centre of CENTRES) {
        for (const [s1, s2, sFrac] of [[0, 1, 0], [37, 38, 0.5], [255, 0, 0.75]] as const) {
          const a = dspMix(FRAMES, centre, spread, s1, s2, sFrac);
          const b = cardMix(spread, centre, (ff) => fetchAt(ff, s1, s2, sFrac));
          expect(b.l, `L @ spread ${spread}, centre ${centre}`).toBeCloseTo(a.l, 12);
          expect(b.r, `R @ spread ${spread}, centre ${centre}`).toBeCloseTo(a.r, 12);
        }
      }
    }
  });

  it('NEGATIVE CONTROL · the comparison is not vacuous (it distinguishes tap banks)', () => {
    // If `toEqual` were being handed empty arrays, or the mix were always
    // {0,0}, every leg above would pass. Two DIFFERENT spreads must disagree,
    // and the mix must be non-trivial.
    expect(dspTaps(1, 3.5)).not.toEqual(dspTaps(3, 3.5));
    expect(dspTaps(3, 3.5).length).toBeGreaterThan(1);
    const m = dspMix(FRAMES, 3.5, 3, 37, 38, 0.5);
    expect(m.l).not.toBe(0);
    expect(m.l).not.toBe(m.r);
  });

  it('both copies keep SPREAD 1 exactly mono and exactly unity', () => {
    // The one point every ART/VRT baseline and every saved rack sits on.
    for (const centre of CENTRES) {
      for (const [s1, s2, sFrac] of [[0, 1, 0], [37, 38, 0.5]] as const) {
        const ref = fetchAt(centre, s1, s2, sFrac);
        const a = dspMix(FRAMES, centre, 1, s1, s2, sFrac);
        const b = cardMix(1, centre, (ff) => fetchAt(ff, s1, s2, sFrac));
        expect(a.l).toBe(ref);
        expect(a.r).toBe(ref);
        expect(b.l).toBe(ref);
        expect(b.r).toBe(ref);
      }
    }
  });
});
