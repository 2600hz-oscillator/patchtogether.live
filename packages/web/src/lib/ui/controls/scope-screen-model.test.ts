import { describe, it, expect } from 'vitest';
import {
  envelopeCurvePoints,
  valueToY,
  morphWaveSample,
  morphWavePoints,
  samplesToPoints,
  bipolarToY,
  peakAmplitude,
  sineWaveSamples,
  burstWaveSamples,
  triMorphWaveSample,
  triMorphWaveSamples,
  sineTriSquareMixWaveSamples,
  ENV_V_PAD,
} from './scope-screen-model';
import {
  OSC_SINE_GAIN,
  OSC_SQUARE_GAIN,
  OSC_TRI_GAIN,
  tidyOscSample,
} from '../../../../../dsp/src/lib/tidy-vco-dsp';

const W = 120;
const H = 64;

describe('envelopeCurvePoints', () => {
  it('produces the 5 ADSR anchors in the right shape', () => {
    const pts = envelopeCurvePoints({ attack: 0.1, decay: 0.2, sustain: 0.6, release: 0.3 }, W, H);
    expect(pts).toHaveLength(5);
    // start at bottom-left, end at bottom-right
    expect(pts[0]!.x).toBe(0);
    expect(pts[4]!.x).toBe(W);
    // start & end are at value 0 (same y)
    expect(pts[0]!.y).toBeCloseTo(pts[4]!.y, 6);
    // attack peak (pts[1]) is the highest point (smallest y)
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y);
    for (const p of pts) expect(p.y).toBeGreaterThanOrEqual(pts[1]!.y - 1e-9);
    // sustain plateau: pts[2] and pts[3] share the same y (held level)
    expect(pts[2]!.y).toBeCloseTo(pts[3]!.y, 6);
    // x is monotonic nondecreasing
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.x).toBeGreaterThanOrEqual(pts[i - 1]!.x);
  });
  it('longer attack pushes the peak x further right', () => {
    const shortA = envelopeCurvePoints({ attack: 0.05, decay: 0.2, sustain: 0.5, release: 0.2 }, W, H);
    const longA = envelopeCurvePoints({ attack: 0.5, decay: 0.2, sustain: 0.5, release: 0.2 }, W, H);
    expect(longA[1]!.x).toBeGreaterThan(shortA[1]!.x);
  });
  it('sustain level sets the plateau height', () => {
    const lo = envelopeCurvePoints({ attack: 0.1, decay: 0.1, sustain: 0.2, release: 0.1 }, W, H);
    const hi = envelopeCurvePoints({ attack: 0.1, decay: 0.1, sustain: 0.9, release: 0.1 }, W, H);
    // higher sustain → smaller y (higher on screen)
    expect(hi[2]!.y).toBeLessThan(lo[2]!.y);
  });
  it('degenerate box → empty', () => {
    expect(envelopeCurvePoints({ attack: 1, decay: 1, sustain: 0.5, release: 1 }, 0, H)).toEqual([]);
    expect(envelopeCurvePoints({ attack: 1, decay: 1, sustain: 0.5, release: 1 }, W, 0)).toEqual([]);
  });
  it('all-zero stages → flat baseline', () => {
    const pts = envelopeCurvePoints({ attack: 0, decay: 0, sustain: 0, release: 0 }, W, H);
    expect(pts).toHaveLength(2);
    expect(pts[0]!.y).toBeCloseTo(pts[1]!.y, 6);
  });
});

describe('valueToY', () => {
  it('maps value 1 to the top pad and 0 to the bottom pad', () => {
    const pad = ENV_V_PAD * H;
    expect(valueToY(1, H)).toBeCloseTo(pad, 6);
    expect(valueToY(0, H)).toBeCloseTo(H - pad, 6);
    expect(valueToY(0.5, H)).toBeCloseTo(H / 2, 6);
  });
});

describe('morphWaveSample — the drawn wave IS the played wave', () => {
  // ⚠ THE DISPLAY MUST NOT LIE (CLAUDE.md: a card silently disagreeing with
  // its def is invisible to every def-reading gate). These assertions are the
  // guard: the screen's sample function must be the DSP core's own
  // `tidyOscSample` at dt = 0, not a lookalike re-typed in the UI layer.

  it('is EXACTLY the DSP morph function at dt = 0 (no second implementation)', () => {
    for (const shape of [0, 0.17, 0.5, 0.83, 1]) {
      for (const pw of [0.5, 0.25, 0.05]) {
        for (let i = 0; i <= 40; i++) {
          const ph = i / 40;
          expect(morphWaveSample(ph, shape, pw)).toBe(
            tidyOscSample(Math.min(ph, 1 - 1e-9), 0, shape, pw),
          );
        }
      }
    }
  });

  it('morph 0 = SINE', () => {
    expect(morphWaveSample(0, 0)).toBeCloseTo(0, 6);
    expect(morphWaveSample(0.25, 0)).toBeCloseTo(OSC_SINE_GAIN, 6);
    expect(morphWaveSample(0.5, 0)).toBeCloseTo(0, 6);
    expect(morphWaveSample(0.75, 0)).toBeCloseTo(-OSC_SINE_GAIN, 6);
    expect(morphWaveSample(1, 0)).toBeCloseTo(0, 6); // clamped, not wrapped
  });

  it('morph 0.5 = TRIANGLE', () => {
    expect(morphWaveSample(0, 0.5)).toBeCloseTo(0, 6);
    expect(morphWaveSample(0.125, 0.5)).toBeCloseTo(0.5 * OSC_TRI_GAIN, 6);
    expect(morphWaveSample(0.25, 0.5)).toBeCloseTo(OSC_TRI_GAIN, 6);
    expect(morphWaveSample(0.5, 0.5)).toBeCloseTo(0, 6);
    expect(morphWaveSample(0.75, 0.5)).toBeCloseTo(-OSC_TRI_GAIN, 6);
  });

  it('morph 1 = SQUARE (duty pw)', () => {
    expect(morphWaveSample(0.1, 1)).toBeCloseTo(OSC_SQUARE_GAIN, 6);
    expect(morphWaveSample(0.4, 1)).toBeCloseTo(OSC_SQUARE_GAIN, 6);
    expect(morphWaveSample(0.6, 1)).toBeCloseTo(-OSC_SQUARE_GAIN, 6);
    expect(morphWaveSample(0.9, 1)).toBeCloseTo(-OSC_SQUARE_GAIN, 6);
  });

  it('the halves are genuine crossfades, monotone in the knob', () => {
    // At phase 0.125 the sine (0.577·gain) sits under the triangle (0.5·1),
    // and the triangle sits over the square there — so a mid-position lands
    // strictly between its two anchors either way.
    // (The three anchors do NOT stack in a fixed order at every phase — at
    // ⅛ cycle the sine sits at 0.577, the triangle at 0.500 and the square
    // back at 0.577 — so the invariant is BETWEEN-NESS, not a direction. A
    // directional assertion here would be a wrong-instrument bug of its own.)
    for (const ph of [0.06, 0.125, 0.3, 0.62, 0.88]) {
      const sine = morphWaveSample(ph, 0);
      const tri = morphWaveSample(ph, 0.5);
      const sq = morphWaveSample(ph, 1);
      const lower = morphWaveSample(ph, 0.25);
      const upper = morphWaveSample(ph, 0.75);
      expect(lower).toBeCloseTo(0.5 * sine + 0.5 * tri, 9);
      expect(upper).toBeCloseTo(0.5 * tri + 0.5 * sq, 9);
      expect(lower).toBeGreaterThanOrEqual(Math.min(sine, tri) - 1e-12);
      expect(lower).toBeLessThanOrEqual(Math.max(sine, tri) + 1e-12);
      expect(upper).toBeGreaterThanOrEqual(Math.min(tri, sq) - 1e-12);
      expect(upper).toBeLessThanOrEqual(Math.max(tri, sq) + 1e-12);
    }
  });

  it('respects custom pulse width on the SQUARE leg only', () => {
    expect(morphWaveSample(0.2, 1, 0.25)).toBeGreaterThan(0);
    expect(morphWaveSample(0.3, 1, 0.25)).toBeLessThan(0);
    // …and PW is inert at the sine / triangle anchors (no pulse leg in the mix).
    expect(morphWaveSample(0.3, 0, 0.25)).toBe(morphWaveSample(0.3, 0, 0.5));
    expect(morphWaveSample(0.3, 0.5, 0.25)).toBe(morphWaveSample(0.3, 0.5, 0.5));
  });
});

describe('morphWavePoints', () => {
  it('normalizes every morph position to FULL screen height (a shape display)', () => {
    // The morph is RMS-calibrated, so a raw square would draw at 58 % height
    // and read as "quieter" rather than "different". Each cycle is scaled to
    // unit peak: sine, triangle and square all touch the same pads.
    const pad = 0.1 * H;
    for (const morph of [0, 0.5, 1]) {
      const pts = morphWavePoints(morph, W, H, 128);
      const ys = pts.map((q) => q.y);
      expect(Math.min(...ys), `morph ${morph} reaches the top pad`).toBeCloseTo(pad, 4);
      expect(Math.max(...ys), `morph ${morph} reaches the bottom pad`).toBeCloseTo(H - pad, 4);
    }
  });
  it('spans the full width and stays within the padded box', () => {
    const pts = morphWavePoints(0, W, H, 64);
    expect(pts).toHaveLength(64);
    expect(pts[0]!.x).toBe(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(W, 6);
    const pad = 0.1 * H;
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(pad - 1e-9);
      expect(p.y).toBeLessThanOrEqual(H - pad + 1e-9);
    }
  });
  it('degenerate → empty', () => {
    expect(morphWavePoints(0, 0, H)).toEqual([]);
    expect(morphWavePoints(0, W, H, 1)).toEqual([]);
  });
});

describe('bipolarToY', () => {
  it('maps +1 to top pad, -1 to bottom pad, 0 to center', () => {
    const pad = 0.1 * H;
    expect(bipolarToY(1, H)).toBeCloseTo(pad, 6);
    expect(bipolarToY(-1, H)).toBeCloseTo(H - pad, 6);
    expect(bipolarToY(0, H)).toBeCloseTo(H / 2, 6);
  });
  it('clamps out-of-range samples', () => {
    expect(bipolarToY(5, H)).toBeCloseTo(bipolarToY(1, H), 6);
    expect(bipolarToY(-5, H)).toBeCloseTo(bipolarToY(-1, H), 6);
  });
});

describe('samplesToPoints', () => {
  it('decimates a buffer across the width', () => {
    const buf = new Float32Array(2048);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * i) / 64);
    const pts = samplesToPoints(buf, W, H, 200);
    expect(pts.length).toBeLessThanOrEqual(200);
    expect(pts.length).toBeGreaterThan(2);
    expect(pts[0]!.x).toBe(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(W, 6);
  });
  it('empty / degenerate → empty', () => {
    expect(samplesToPoints(new Float32Array(0), W, H)).toEqual([]);
    expect(samplesToPoints(new Float32Array(10), 0, H)).toEqual([]);
  });
});

describe('peakAmplitude', () => {
  it('is 0 for silence and the max abs otherwise', () => {
    expect(peakAmplitude(new Float32Array(64))).toBe(0);
    expect(peakAmplitude([0.1, -0.7, 0.3])).toBeCloseTo(0.7, 6);
  });
});

describe('sineWaveSamples — the static generic-wave glyph trace', () => {
  it('is one full bipolar cycle: 0 at the ends, ±1 at the quarter points', () => {
    const buf = sineWaveSamples(129, 1); // odd count → exact quarter indices
    expect(buf.length).toBe(129);
    expect(buf[0]).toBeCloseTo(0, 6);
    expect(buf[128]).toBeCloseTo(0, 6);
    expect(buf[32]).toBeCloseTo(1, 6); // t = 0.25
    expect(buf[96]).toBeCloseTo(-1, 6); // t = 0.75
    expect(peakAmplitude(buf)).toBeCloseTo(1, 6);
  });

  it('honours the cycle count and never exceeds ±1', () => {
    const buf = sineWaveSamples(257, 2);
    expect(buf[64]).toBeCloseTo(0, 5); // end of cycle 1 at t = 0.25 → sin(π)
    for (const v of buf) expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('clamps a degenerate sample count to a drawable buffer', () => {
    expect(sineWaveSamples(1).length).toBe(2);
  });
});

describe('burstWaveSamples — the decaying-burst (scope-at-rest) glyph trace', () => {
  it('starts at 0, rings, and decays toward silence (never a steady oscillator)', () => {
    const buf = burstWaveSamples(256, 3, 5);
    expect(buf.length).toBe(256);
    expect(buf[0]).toBeCloseTo(0, 6);
    // The trace PEAKS early (first quarter of the buffer)…
    const peak = peakAmplitude(buf);
    const firstQuarterPeak = peakAmplitude(Array.from(buf.slice(0, 64)));
    expect(firstQuarterPeak).toBeCloseTo(peak, 6);
    expect(peak).toBeGreaterThan(0.5);
    // …and the tail is DECAYED to near-zero (e^-decay), unlike a saw/sine cycle.
    const tailPeak = peakAmplitude(Array.from(buf.slice(224)));
    expect(tailPeak).toBeLessThan(0.05);
    expect(tailPeak).toBeLessThan(peak / 10);
  });

  it('is bipolar (rings both ways) and bounded by ±1', () => {
    const buf = burstWaveSamples();
    let min = 0;
    let max = 0;
    for (const v of buf) {
      if (v < min) min = v;
      if (v > max) max = v;
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(max).toBeGreaterThan(0.1);
    expect(min).toBeLessThan(-0.1);
  });

  it('clamps a degenerate sample count to a drawable buffer', () => {
    expect(burstWaveSamples(0).length).toBe(2);
  });
});

describe('triMorphWaveSample / triMorphWaveSamples — the lfo shape law (0=sine, 1=saw, 2=square)', () => {
  it('shape 0 is a sine: quarter-phase anchors', () => {
    expect(triMorphWaveSample(0, 0)).toBeCloseTo(0, 9);
    expect(triMorphWaveSample(0.25, 0)).toBeCloseTo(1, 9);
    expect(triMorphWaveSample(0.5, 0)).toBeCloseTo(0, 9);
    expect(triMorphWaveSample(0.75, 0)).toBeCloseTo(-1, 9);
  });

  it('shape 1 is a rising saw: −1 at phase 0 up to +1 at phase 1', () => {
    expect(triMorphWaveSample(0, 1)).toBeCloseTo(-1, 9);
    expect(triMorphWaveSample(0.5, 1)).toBeCloseTo(0, 9);
    expect(triMorphWaveSample(1, 1)).toBeCloseTo(1, 9);
  });

  it('shape 2 is a square: +1 first half, −1 second half', () => {
    expect(triMorphWaveSample(0.25, 2)).toBe(1);
    expect(triMorphWaveSample(0.75, 2)).toBe(-1);
  });

  it('crossfades linearly between adjacent anchors (0.5 = halfway sine↔saw)', () => {
    const ph = 0.25;
    const sine = triMorphWaveSample(ph, 0);
    const saw = triMorphWaveSample(ph, 1);
    expect(triMorphWaveSample(ph, 0.5)).toBeCloseTo((sine + saw) / 2, 9);
    const square = triMorphWaveSample(ph, 2);
    expect(triMorphWaveSample(ph, 1.5)).toBeCloseTo((saw + square) / 2, 9);
  });

  it('clamps shape outside 0..2 and scales by amp (the depth swing)', () => {
    expect(triMorphWaveSample(0.25, -1)).toBeCloseTo(triMorphWaveSample(0.25, 0), 9);
    expect(triMorphWaveSample(0.25, 5)).toBe(triMorphWaveSample(0.25, 2));
    expect(triMorphWaveSample(0.25, 0, 0.5)).toBeCloseTo(0.5, 9);
    expect(triMorphWaveSample(0.25, 2, 0)).toBe(0);
  });

  it('triMorphWaveSamples draws one clean cycle (no wrap snap at the endpoint)', () => {
    const saw = triMorphWaveSamples(1, 1, 65);
    expect(saw[0]).toBeCloseTo(-1, 9);
    expect(saw[64]).toBeCloseTo(1, 9); // endpoint keeps the ramp — no reset to −1
    for (let i = 1; i < saw.length; i++) expect(saw[i]!).toBeGreaterThan(saw[i - 1]!);
    const sine = triMorphWaveSamples(0, 1, 129);
    expect(sine[0]).toBeCloseTo(0, 9);
    expect(sine[128]).toBeCloseTo(0, 9);
  });

  it('clamps a degenerate sample count to a drawable buffer', () => {
    expect(triMorphWaveSamples(0, 1, 0).length).toBe(2);
  });
});

describe('sineTriSquareMixWaveSamples — the tidyVco DUAL-glyph core waveform', () => {
  it('defaults (shape1 0, mix 0) draw a full-scale SINE, edge to edge', () => {
    const sine = sineTriSquareMixWaveSamples(0, 0, 0.5, 0, 65);
    expect(sine.length).toBe(65);
    expect(sine[0]).toBeCloseTo(0, 6);
    expect(sine[16]).toBeCloseTo(1, 2); // quarter cycle → the normalized peak
    expect(sine[32]).toBeCloseTo(0, 2);
    expect(sine[48]).toBeCloseTo(-1, 2);
    expect(peakAmplitude(sine)).toBeCloseTo(1, 6); // normalized to full scale
  });

  it('shape1 0.5 draws a TRIANGLE and 1 draws a SQUARE — the real shapes', () => {
    const tri = sineTriSquareMixWaveSamples(0.5, 0.5, 0.5, 0, 65);
    // straight ramps: the first quarter rises linearly to the peak
    expect(tri[8]).toBeCloseTo(0.5, 3);
    expect(tri[16]).toBeCloseTo(1, 3);
    expect(tri[32]).toBeCloseTo(0, 3);
    expect(tri[48]).toBeCloseTo(-1, 3);

    const square = sineTriSquareMixWaveSamples(1, 1, 0.5, 0, 128);
    expect(square[10]).toBeCloseTo(1, 6);
    expect(square[100]).toBeCloseTo(-1, 6);
    // …and the three are all distinct traces.
    const sine = sineTriSquareMixWaveSamples(0, 0, 0.5, 0, 65);
    expect(Array.from(tri)).not.toEqual(Array.from(sine));
    expect(Array.from(square)).not.toEqual(Array.from(sineTriSquareMixWaveSamples(0.5, 0.5, 0.5, 0, 128)));
  });

  it('a shape1 sweep moves the trace continuously across BOTH halves', () => {
    const at = (s1: number) => sineTriSquareMixWaveSamples(s1, s1, 0.5, 0, 128);
    let prev = at(0);
    for (let i = 1; i <= 20; i++) {
      const cur = at(i / 20);
      let maxStep = 0;
      for (let k = 0; k < cur.length; k++) maxStep = Math.max(maxStep, Math.abs(cur[k]! - prev[k]!));
      expect(maxStep, `no jump between ${(i - 1) / 20} and ${i / 20}`).toBeLessThan(0.35);
      expect(Array.from(cur)).not.toEqual(Array.from(prev)); // and never dead
      prev = cur;
    }
  });

  it('a pw sweep CHANGES the square leg (duty moves the falling edge)', () => {
    const wide = sineTriSquareMixWaveSamples(1, 1, 0.5, 0, 128);
    const thin = sineTriSquareMixWaveSamples(1, 1, 0.1, 0, 128);
    expect(Array.from(thin)).not.toEqual(Array.from(wide));
    // Phase ~0.3: inside the 0.5 duty (high) but past the 0.1 duty (low).
    expect(wide[38]!).toBeGreaterThan(0);
    expect(thin[38]!).toBeLessThan(0);
    // …and pw is irrelevant while both oscs sit at the sine anchor.
    expect(Array.from(sineTriSquareMixWaveSamples(0, 0, 0.1, 0))).toEqual(
      Array.from(sineTriSquareMixWaveSamples(0, 0, 0.5, 0)),
    );
  });

  it('mix crossfades to OSC2 equal-power: 1 = pure shape2, 0.5 blends both', () => {
    // mix 1 → OSC2 only: shape2's wave regardless of shape1's setting.
    const osc2Only = sineTriSquareMixWaveSamples(0, 1, 0.5, 1);
    const osc2OnlyB = sineTriSquareMixWaveSamples(0.7, 1, 0.5, 1);
    for (let i = 0; i < osc2Only.length; i++) expect(osc2Only[i]!).toBeCloseTo(osc2OnlyB[i]!, 6);
    expect(osc2Only[10]).toBeCloseTo(1, 6); // a square, normalized to full scale
    // mix 0.5 of two IDENTICAL sines: the correlated equal-power sum is the
    // same SHAPE, and normalization puts it back on the single-osc trace.
    const blended = sineTriSquareMixWaveSamples(0, 0, 0.5, 0.5, 65);
    const sine = sineTriSquareMixWaveSamples(0, 0, 0.5, 0, 65);
    for (let i = 0; i < sine.length; i++) expect(blended[i]!).toBeCloseTo(sine[i]!, 6);
    // A sine↔square blend differs from both legs and stays bounded.
    const hybrid = sineTriSquareMixWaveSamples(0, 1, 0.5, 0.5);
    expect(Array.from(hybrid)).not.toEqual(Array.from(sineTriSquareMixWaveSamples(0, 1, 0.5, 0)));
    expect(peakAmplitude(hybrid)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('is deterministic and clamps a degenerate sample count', () => {
    expect(Array.from(sineTriSquareMixWaveSamples(0.3, 0.8, 0.25, 0.4))).toEqual(
      Array.from(sineTriSquareMixWaveSamples(0.3, 0.8, 0.25, 0.4)),
    );
    expect(sineTriSquareMixWaveSamples(0, 0, 0.5, 0, 0).length).toBe(2);
  });
});
