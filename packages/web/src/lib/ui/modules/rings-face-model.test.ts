// packages/web/src/lib/ui/modules/rings-face-model.test.ts
//
// The PERMANENT negative controls for the RINGS faceplate.
//
// Every claim the face makes is either (a) a derived readout, which must be
// negative-controlled on the input a knob readback would be BLIND to, or (b) a
// transcription of the DSP's own arithmetic into the hero picture, which must
// be pinned to the REAL algorithm so a DSP change turns a stale picture red
// rather than leaving the faceplate drawing a bank the module no longer has.
//
// ⚠ THE ORACLE LEGS RUN `ringsMath` — the pure-math mirror in
// $lib/audio/modules/rings — and that is a deliberate, measured choice rather
// than a convenience. The mirror and the SHIPPING worklet
// (packages/dsp/src/rings.ts) are the same algorithm: measured max|delta|
// 2.980e-8 over a 1 s strummed render at the shipped defaults (float32
// quantisation), against 7.818e-3 for a damping 0.50-vs-0.51 negative control
// on the same comparison — so the comparison is capable of failing and does
// not. ⚠ NOTHING IN THE REPO ASSERTS THAT, and it is not this file's job to:
// a worklet-vs-mirror parity test needs the worklet bundled for node, which is
// real harness work. Filed in the PR body as the one debt this face leaves.

import { describe, expect, it } from 'vitest';
import { ringsMath, type RingsParams } from '$lib/audio/modules/rings';
import {
  RINGS_C4_HZ,
  RINGS_DETUNE_SEMITONES,
  RINGS_MODAL_PARTIALS,
  RINGS_POSITION_EPS,
  ringsBodyText,
  ringsCombBank,
  ringsCombMirrorCurve,
  ringsEvenTapText,
  ringsFaceParams,
  ringsKnobF0Hz,
  ringsPickupState,
  ringsSecondPartialHz,
  ringsSecondPartialText,
} from './rings-face-model';

const SR = 48000;

/** A param reader over a partial override map, defaults from the def. */
function reader(over: Partial<Record<string, number>> = {}) {
  return (id: string): number | undefined => over[id];
}
const P = (over: Partial<Record<string, number>> = {}) => ringsFaceParams(reader(over));

/** Deterministic noise burst — the exciter every oracle leg uses. */
function burst(n: number, lenSamples: number, gain = 4.0, seed = 0x12345): Float32Array {
  const out = new Float32Array(n);
  let s = seed | 0;
  for (let i = 0; i < lenSamples; i++) {
    s = (s * 16807) | 0;
    out[i] = (((s & 0x7fffffff) / 0x7fffffff) * 2 - 1) * gain;
  }
  return out;
}

const baseParams: RingsParams = {
  model: 0, note: 0, structure: 0.25, brightness: 0.5,
  damping: 0.5, position: 0.5, level: 0.8,
};

/** Hann-windowed Goertzel magnitude, in dB. Negative-controlled below. */
function goertzelDb(buf: Float32Array, freq: number, sr = SR): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0, im = 0, wsum = 0;
  const N = buf.length;
  for (let i = 0; i < N; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const v = buf[i]! * win;
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
    wsum += win;
  }
  return 20 * Math.log10(Math.max((Math.sqrt(re * re + im * im) / Math.max(wsum, 1e-30)) * 2, 1e-300));
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
function peak(a: Float32Array): number {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}

// ── THE INSTRUMENT ───────────────────────────────────────────────────────────
// CLAUDE.md: validate the instrument before believing anything it says. A
// metric blind to the dimension under test returns a clean number regardless.

describe('rings face model — THE INSTRUMENT (validated before it is believed)', () => {
  it('the Goertzel finds a bin that is there and rejects one that is not', () => {
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    // present: unit amplitude reads ~0 dB.
    expect(goertzelDb(x, 440)).toBeGreaterThan(-0.5);
    expect(goertzelDb(x, 440)).toBeLessThan(0.5);
    // absent: an empty bin must be FAR down, or every separation figure below
    // is measuring the probe's own skirt rather than the signal.
    expect(goertzelDb(x, 880)).toBeLessThan(-100);
  });
});

// ── `rings-body` — NAMES THE LIVE MODEL ──────────────────────────────────────

describe('rings-body — the model name the MODEL control cannot say', () => {
  it('names each model', () => {
    expect(ringsBodyText(P({ model: 0 }))).toBe('modal');
    expect(ringsBodyText(P({ model: 1 }))).toBe('sympathetic');
  });

  it('rounds exactly as the DSP rounds it (a mid value is not a third state)', () => {
    // The worklet does `Math.round` then clamps to 0..1, so 0.4 is MODAL and
    // 0.6 is SYMPATHETIC. A readout using a bare truthiness test would call
    // 0.4 sympathetic and disagree with what is sounding.
    expect(ringsBodyText(P({ model: 0.4 }))).toBe('modal');
    expect(ringsBodyText(P({ model: 0.6 }))).toBe('sympathetic');
  });

  it('NEGATIVE CONTROL — it is invariant to every OTHER param', () => {
    // The failure this catches is a readout wired to the wrong param: it must
    // move on `model` and on nothing else.
    const base = ringsBodyText(P({ model: 0 }));
    for (const id of ['note', 'structure', 'brightness', 'damping', 'position', 'level']) {
      expect(ringsBodyText(P({ model: 0, [id]: 0.9 })), `${id} must not move it`).toBe(base);
    }
    // …and the POSITIVE half: it DOES move on the one input that owns it.
    expect(ringsBodyText(P({ model: 1 }))).not.toBe(base);
  });
});

// ── `rings-partial2-hz` — WHERE THE SECOND RESONANCE IS ──────────────────────

describe('rings-partial2-hz — a quantity that CHANGES IDENTITY with the model', () => {
  it('ORACLE (MODAL) — partial 2 lands where the shipping bank puts it', () => {
    // Pin the closed form to the REAL DSP by peak-finding partial 2 on the EVEN
    // tap (§1: EVEN is where the even-numbered harmonics live) across the whole
    // STRUCTURE travel.
    for (const structure of [0, 0.25, 0.5, 0.75, 1.0]) {
      const exciter = burst(SR * 2, 4800);
      const { even } = ringsMath.render(SR * 2, SR, 0, { ...baseParams, structure }, exciter);
      const tail = even.slice(SR / 10);
      const predicted = ringsSecondPartialHz(P({ structure }));

      // Scan a tight window around the prediction and require the true peak to
      // sit on it. ⚠ The window is tight ON PURPOSE: a WIDE scan at structure 0
      // can be won by h4, which is the instrument artifact the source spec
      // reported as a finding.
      let bestHz = 0, bestDb = -Infinity;
      for (let hz = predicted * 0.9; hz <= predicted * 1.1; hz += predicted * 0.0005) {
        const d = goertzelDb(tail, hz);
        if (d > bestDb) { bestDb = d; bestHz = hz; }
      }
      // within a quarter-tone of the prediction
      const cents = Math.abs(1200 * Math.log2(bestHz / predicted));
      expect(cents, `structure ${structure}: predicted ${predicted.toFixed(2)} Hz, found ${bestHz.toFixed(2)} Hz`)
        .toBeLessThan(25);
    }
  });

  it('ORACLE (SYMPATHETIC) — the second STRING is at structure * 19 semitones', () => {
    // Not partial 2 — a detuned second string, which is the whole reason this
    // readout is model-aware. Pinned to the DSP's own detune law.
    for (const structure of [0, 0.25, 0.5]) {
      const expected = RINGS_C4_HZ * Math.pow(2, (structure * RINGS_DETUNE_SEMITONES) / 12);
      expect(ringsSecondPartialHz(P({ model: 1, structure }))).toBeCloseTo(expected, 6);
    }
  });

  it('the two models give DIFFERENT answers at the same structure', () => {
    // If they agreed, the model-awareness would be untested decoration.
    const modal = ringsSecondPartialHz(P({ model: 0, structure: 0.25 }));
    const symp = ringsSecondPartialHz(P({ model: 1, structure: 0.25 }));
    expect(Math.abs(modal - symp)).toBeGreaterThan(100);
  });

  it('NEGATIVE CONTROL — STRUCTURE and NOTE move it; DAMPING and BRIGHTNESS must NOT', () => {
    const base = ringsSecondPartialHz(P());
    // The two inputs that genuinely place the partial.
    expect(ringsSecondPartialHz(P({ structure: 0.75 }))).not.toBeCloseTo(base, 3);
    expect(ringsSecondPartialHz(P({ note: 12 }))).toBeCloseTo(base * 2, 6);
    // ⚠ THE LEG THAT MATTERS. A readout that moved with DAMPING would be
    // measuring the ENVELOPE, not the bank — the kick-drum TAIL trap.
    expect(ringsSecondPartialHz(P({ damping: 0.9 }))).toBeCloseTo(base, 9);
    expect(ringsSecondPartialHz(P({ brightness: 0.9 }))).toBeCloseTo(base, 9);
    expect(ringsSecondPartialHz(P({ position: 0.1 }))).toBeCloseTo(base, 9);
    expect(ringsSecondPartialHz(P({ level: 0.1 }))).toBeCloseTo(base, 9);
  });

  it('prints a value and a unit, and nothing else', () => {
    // Owner directive 2026-08-11: a readout states a value, not a thesis. This
    // is a REGRESSION GUARD against the commentary this readout used to carry
    // (`588.66 Hz · partial 2`).
    expect(ringsSecondPartialText(P())).toMatch(/^[\d.]+ (Hz|kHz)$/);
    expect(ringsSecondPartialText(P({ model: 1 }))).toMatch(/^[\d.]+ (Hz|kHz)$/);
  });
});

// ── `rings-even-tap-state` — THE READOUT WITH NO KNOB TO READ ────────────────

describe('rings-even-tap-state — one output is DEAD at two dial positions', () => {
  it('ORACLE — at POSITION 0.25 and 0.75 the EVEN tap is at digital zero', () => {
    // The claim the readout makes, verified against the real algorithm rather
    // than against the cosine identity it was derived from.
    for (const position of [0.25, 0.75]) {
      const exciter = burst(SR, 4800);
      const { odd, even } = ringsMath.render(SR, SR, 0, { ...baseParams, position }, exciter);
      expect(peak(even), `position ${position}: EVEN must be silent`).toBeLessThan(1e-12);
      // …and the ODD tap is UNAFFECTED, which is what makes this a stereo
      // hazard rather than a mute.
      expect(peak(odd), `position ${position}: ODD must be unaffected`).toBeGreaterThan(0.01);
      expect(ringsEvenTapText(P({ position }))).toBe('silent');
    }
  });

  it('ORACLE — just off the quarter-marks the EVEN tap is back', () => {
    const exciter = burst(SR, 4800);
    const { even } = ringsMath.render(SR, SR, 0, { ...baseParams, position: 0.3 }, exciter);
    expect(peak(even)).toBeGreaterThan(0.01);
    expect(ringsEvenTapText(P({ position: 0.3 }))).toBe('live');
  });

  it('ORACLE — POSITION p and 1-p are the SAME filter bank', () => {
    // §4-A. The face draws this as a mirror-symmetric travel curve; here it is
    // pinned to the DSP. Exact zeros at the pairs whose float32 param values
    // ARE exact complements.
    const exciter = burst(SR, 4800);
    for (const p of [0.25, 0.3, 0.5]) {
      const a = ringsMath.render(SR, SR, 0, { ...baseParams, position: p }, exciter);
      const b = ringsMath.render(SR, SR, 0, { ...baseParams, position: 1 - p }, exciter);
      expect(maxAbsDiff(a.odd, b.odd), `odd at ${p} vs ${1 - p}`).toBeLessThan(1e-6);
      expect(maxAbsDiff(a.even, b.even), `even at ${p} vs ${1 - p}`).toBeLessThan(1e-6);
    }
    // NEGATIVE CONTROL of that comparison: two positions that are NOT mirror
    // partners must differ, or `maxAbsDiff` is not measuring anything.
    const x = ringsMath.render(SR, SR, 0, { ...baseParams, position: 0.3 }, exciter);
    const y = ringsMath.render(SR, SR, 0, { ...baseParams, position: 0.4 }, exciter);
    expect(maxAbsDiff(x.odd, y.odd)).toBeGreaterThan(1e-3);
  });

  it('NEGATIVE CONTROL — a `paramId: position` readout could not tell these apart', () => {
    // This is the whole argument for the readout existing, expressed as a test:
    // the knob prints two DIFFERENT numbers for two IDENTICAL settings, and the
    // SAME kind of number for a setting where an output is dead.
    expect(ringsEvenTapText(P({ position: 0.3 }))).toBe(ringsEvenTapText(P({ position: 0.7 })));
    expect(ringsEvenTapText(P({ position: 0.25 }))).not.toBe(ringsEvenTapText(P({ position: 0.3 })));
  });

  it('NEGATIVE CONTROL — invariant to every param except POSITION', () => {
    const base = ringsEvenTapText(P({ position: 0.25 }));
    for (const id of ['model', 'note', 'structure', 'brightness', 'damping', 'level']) {
      expect(ringsEvenTapText(P({ position: 0.25, [id]: 0.9 })), `${id}`).toBe(base);
    }
    expect(ringsEvenTapText(P({ position: 0.5 }))).not.toBe(base);
  });

  it('the node tolerance is a real window, and it is not the whole dial', () => {
    // A tolerance wide enough to swallow the dial would make the readout print
    // `silent` everywhere and still pass every leg above.
    expect(ringsPickupState(P({ position: 0.25 + RINGS_POSITION_EPS / 2 }))).toBe('node');
    expect(ringsPickupState(P({ position: 0.25 + RINGS_POSITION_EPS * 2 }))).toBe('mirrored');
    expect(ringsPickupState(P({ position: 0.5 }))).toBe('full-comb');
  });
});

// ── THE HERO PICTURE ─────────────────────────────────────────────────────────

describe('rings comb picture — pinned to the bank the DSP actually builds', () => {
  it('index 0 is the fundamental and it lands in the ODD tap', () => {
    // `RingsModal.process` accumulates partial i into ODD when i is EVEN. Get
    // this backwards and the picture's two colours are swapped — which no
    // pixel gate could see, because both colours are always present.
    const bank = ringsCombBank(P());
    expect(bank[0]!.index).toBe(0);
    expect(bank[0]!.tap).toBe('odd');
    expect(bank[1]!.tap).toBe('even');
    expect(bank).toHaveLength(RINGS_MODAL_PARTIALS);
  });

  it('ORACLE — the drawn tap assignment matches the SPECTRUM of the real taps', () => {
    // The strongest leg in the file: it checks the PICTURE's odd/even colouring
    // against where the energy measurably is, rather than against the source
    // line it was transcribed from.
    const exciter = burst(SR * 2, 4800);
    const { odd, even } = ringsMath.render(SR * 2, SR, 0, { ...baseParams, structure: 0 }, exciter);
    const tail = odd.slice(SR / 10);
    const tailEven = even.slice(SR / 10);
    const f0 = ringsKnobF0Hz(P());
    for (let h = 1; h <= 6; h++) {
      const inOdd = goertzelDb(tail, f0 * h);
      const inEven = goertzelDb(tailEven, f0 * h);
      const drawnTap = ringsCombBank(P({ structure: 0 }))[h - 1]!.tap;
      const louder = inOdd > inEven ? 'odd' : 'even';
      expect(louder, `h${h}: drawn as ${drawnTap} but the energy is in ${louder}`).toBe(drawnTap);
      // …and the separation is categorical, not marginal.
      expect(Math.abs(inOdd - inEven), `h${h} separation`).toBeGreaterThan(60);
    }
  });

  it('the pickup weight is the DSP cosine, and 0.25 nulls every EVEN-tap partial', () => {
    const bank = ringsCombBank(P({ position: 0.25 }));
    for (const b of bank) {
      if (b.tap === 'even') expect(Math.abs(b.weight), `partial ${b.index}`).toBeLessThan(1e-9);
    }
    // and at the default every |weight| is 1 — the comb is at a MAXIMUM there.
    for (const b of ringsCombBank(P({ position: 0.5 }))) {
      expect(Math.abs(b.weight)).toBeCloseTo(1, 9);
    }
  });

  it('the travel curve is MIRROR-SYMMETRIC about 0.5 — the picture\'s whole point', () => {
    const curve = ringsCombMirrorCurve(P(), 101);
    for (let i = 0; i < curve.length; i++) {
      const mirrored = curve[curve.length - 1 - i]!;
      expect(curve[i]!, `sample ${i}`).toBeCloseTo(mirrored, 9);
    }
    // NEGATIVE CONTROL: the curve is not CONSTANT (a flat line is trivially
    // symmetric and would pass the leg above while showing nothing).
    expect(Math.max(...curve) - Math.min(...curve)).toBeGreaterThan(0.2);
  });

  it('STRUCTURE stretches the drawn partials off the harmonic grid', () => {
    const harmonic = ringsCombBank(P({ structure: 0 }));
    const stretched = ringsCombBank(P({ structure: 1 }));
    const f0 = ringsKnobF0Hz(P());
    // at structure 0 partial n sits on the integer grid…
    for (let i = 0; i < 6; i++) expect(harmonic[i]!.hz).toBeCloseTo(f0 * (i + 1), 6);
    // …and at structure 1 it does not.
    expect(stretched[2]!.hz).toBeGreaterThan(harmonic[2]!.hz * 1.5);
  });

  it('heights are normalised and finite at both ends of every control', () => {
    // TOTALITY: the panel calls this on every render, so a NaN from an extreme
    // dial position would take the faceplate down mid-drag.
    for (const over of [
      {}, { damping: 0 }, { damping: 1 }, { brightness: 0 }, { brightness: 1 },
      { structure: 0 }, { structure: 1 }, { position: 0 }, { position: 1 },
      { note: -60 }, { note: 60 },
    ]) {
      const bank = ringsCombBank(P(over));
      for (const b of bank) {
        expect(Number.isFinite(b.height), `${JSON.stringify(over)} partial ${b.index}`).toBe(true);
        expect(b.height).toBeGreaterThanOrEqual(0);
        expect(b.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a partial above the Nyquist guard is inactive and drawn at zero', () => {
    // NOTE +60 st is a five-octave transpose; the top of the bank leaves the
    // band. The DSP skips those partials (`numModes`), so the picture must too.
    const bank = ringsCombBank(P({ note: 60 }));
    expect(bank.some((b) => !b.active)).toBe(true);
    for (const b of bank) if (!b.active) expect(b.height).toBe(0);
  });
});

// ── THE MODULE IS SILENT AT SPAWN ────────────────────────────────────────────

describe('rings — the fact the whole faceplate is built around', () => {
  it('ORACLE — nothing patched, nothing struck: BIT-ZERO on both taps', () => {
    // This is why the face carries an audition at rank 6, why the card grew a
    // STRUM button, and why the `scope` glyph baselines. If a future change
    // gives rings an internal exciter, this goes red and the face's argument
    // needs revisiting — which is exactly what it is here to do.
    for (const model of [0, 1]) {
      const { odd, even } = ringsMath.render(SR, SR, 0, { ...baseParams, model }, null, -1);
      expect(peak(odd), `model ${model} odd`).toBe(0);
      expect(peak(even), `model ${model} even`).toBe(0);
    }
  });

  it('ORACLE — a STRUM alone makes it sound, with nothing patched', () => {
    // The positive half: the audition seam has something real to trigger.
    for (const model of [0, 1]) {
      const { odd } = ringsMath.render(SR, SR, 0, { ...baseParams, model }, null, 1000);
      expect(peak(odd), `model ${model}`).toBeGreaterThan(0.01);
    }
  });
});
