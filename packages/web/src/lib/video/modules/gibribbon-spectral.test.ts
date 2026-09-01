// packages/web/src/lib/video/modules/gibribbon-spectral.test.ts
//
// The pure spectral front-end under test: musical band ranges are total and
// ordered, the fold maps energy to the RIGHT band identity (band identity IS
// event identity), and the onset detector is relative to its own baseline
// (quiet and loud tracks beat alike) with negative controls.

import { describe, it, expect } from 'vitest';
import {
  GIB_BAND_EDGES_HZ,
  GIB_FFT_SIZE,
  gibBandBinRanges,
  gibFoldBands,
  gibSpectralFlux,
  newOnsetState,
  pushFluxIsOnset,
} from './gibribbon-spectral';

const SR = 48000;

/** A synthetic byte spectrum with energy centred at `hz`. */
function spectrumAt(hz: number, level = 220, widthBins = 3): Uint8Array {
  const bins = new Uint8Array(GIB_FFT_SIZE / 2);
  const centre = Math.round(hz / (SR / GIB_FFT_SIZE));
  for (let i = Math.max(0, centre - widthBins); i <= centre + widthBins && i < bins.length; i++) {
    bins[i] = level;
  }
  return bins;
}

describe('gibribbon spectral — band ranges', () => {
  it('the four musical bands are total, ordered and non-empty at common rates', () => {
    for (const sr of [44100, 48000, 96000]) {
      const ranges = gibBandBinRanges(sr);
      expect(ranges).toHaveLength(4);
      for (const [lo, hi] of ranges) {
        expect(hi).toBeGreaterThan(lo);
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThanOrEqual(GIB_FFT_SIZE / 2);
      }
      // Bands ascend (bass bins below low-mid bins, and so on).
      for (let b = 1; b < 4; b++) expect(ranges[b]![0]).toBeGreaterThanOrEqual(ranges[b - 1]![0]);
    }
  });

  it('the edges are the musical split the #698 refactor settled on', () => {
    expect(GIB_BAND_EDGES_HZ.map((e) => [e.lo, e.hi])).toEqual([
      [20, 200], [200, 1000], [1000, 4000], [4000, 16000],
    ]);
  });
});

describe('gibribbon spectral — the fold maps energy to the RIGHT band', () => {
  const ranges = gibBandBinRanges(SR);
  // Spike width grows with frequency: real high-frequency transients (snare
  // crack, hats) are BROADBAND, and the wide high bands average narrow
  // energy down — which is fine by design, because the extractor measures
  // each band against its OWN baseline (dilution cancels out).
  const cases: Array<[number, number, number]> = [
    [60, 0, 3],      // kick fundamental → bass → LOOP
    [500, 1, 8],     // snare body → low-mid → JUMP
    [2500, 2, 30],   // snare crack / melodic → high-mid → IMP
    [9000, 3, 160],  // hats → treble → ZOMBIE
  ];
  for (const [hz, band, width] of cases) {
    it(`${hz} Hz lands in band ${band} and only meaningfully there`, () => {
      const bands = gibFoldBands(spectrumAt(hz, 220, width), ranges);
      const top = bands.indexOf(Math.max(...bands));
      expect(top).toBe(band);
      expect(bands[band]!).toBeGreaterThan(0.05);
      for (let b = 0; b < 4; b++) {
        if (b !== band) expect(bands[b]!).toBeLessThan(bands[band]! * 0.5);
      }
    });
  }

  it('silence folds to zeros; the fold has NO gain parameter by design', () => {
    const bands = gibFoldBands(new Uint8Array(GIB_FFT_SIZE / 2), ranges);
    expect(bands).toEqual([0, 0, 0, 0]);
    // The design claim, pinned: normalization belongs to the adaptive
    // extractor, so the fold's signature must never grow a gain.
    expect(gibFoldBands.length).toBe(2);
  });
});

describe('gibribbon spectral — flux + onset', () => {
  it('flux counts ARRIVING energy only', () => {
    expect(gibSpectralFlux([0, 0, 0, 0], [0.5, 0, 0, 0])).toBeCloseTo(0.5);
    expect(gibSpectralFlux([0.5, 0, 0, 0], [0, 0, 0, 0])).toBe(0);
    expect(gibSpectralFlux([0.2, 0.4, 0, 0], [0.4, 0.1, 0, 0])).toBeCloseTo(0.2);
  });

  it('an onset is RELATIVE to its own baseline — quiet and loud tracks beat alike', () => {
    for (const scale of [1, 0.1]) {
      const st = newOnsetState();
      // A steady simmer of small flux…
      for (let i = 0; i < 40; i++) pushFluxIsOnset(st, 0.05 * scale);
      // …then a transient triple the baseline: an onset at BOTH scales…
      expect(pushFluxIsOnset(st, 0.2 * scale), `transient at ×${scale}`).toBe(true);
    }
    // …except below the absolute floor, where silence never beats.
    const st = newOnsetState();
    for (let i = 0; i < 40; i++) pushFluxIsOnset(st, 0.0001);
    expect(pushFluxIsOnset(st, 0.005), 'sub-floor flux is not an onset').toBe(false);
  });

  it('NEGATIVE CONTROL: steady flux is never an onset (no baseline to beat)', () => {
    const st = newOnsetState();
    let onsets = 0;
    for (let i = 0; i < 100; i++) if (pushFluxIsOnset(st, 0.3)) onsets += 1;
    // The very first pushes (empty baseline) may register; a STEADY stream
    // must settle to zero onsets.
    expect(onsets).toBeLessThanOrEqual(1);
  });

  it('is deterministic: same flux stream → same verdict stream', () => {
    const run = () => {
      const st = newOnsetState();
      const out: boolean[] = [];
      for (let i = 0; i < 200; i++) out.push(pushFluxIsOnset(st, (i * 37) % 11 === 0 ? 0.4 : 0.03));
      return out.join(',');
    };
    expect(run()).toBe(run());
  });
});
