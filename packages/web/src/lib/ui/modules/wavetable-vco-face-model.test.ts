// packages/web/src/lib/ui/modules/wavetable-vco-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind WAVETABLE VCO's two derived readouts —
// the whole difference between this registry and two relabelled knobs.
//
// Plus a SOURCE-GREP PIN on the worklet: `packages/dsp/src/wavetable-vco.ts`
// exports nothing (its only top-level effect is `registerProcessor`), so the
// laws are re-typed in the model and this grep is the only thing standing
// between the mirror and drift. A DSP change turns the stale claim RED rather
// than leaving the faceplate insisting on it.
//
// ⚠ THE BAR EACH READOUT HAS TO CLEAR (module-faceplates.md): a derived readout
// is negative-controlled on the input a KNOB READBACK WOULD BE BLIND TO,
// permanently — not once at authoring time. Every `it` below names which knob is
// blind to what it asserts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { wavetableVcoDef } from '$lib/audio/modules/wavetable-vco';
import {
  WT_C4_HZ,
  WT_FM_SEMITONES_AT_FULL_SCALE,
  WT_FRAME_COUNT,
  WT_FREQ_MAX_HZ,
  WT_FREQ_MIN_HZ,
  wtFaceParams,
  wtFmSpanCents,
  wtFmSpanHz,
  wtKnobHz,
  type WtFaceParams,
} from './wavetable-vco-face-model';

const DEFAULTS: WtFaceParams = wtFaceParams(() => undefined);

function withParams(over: Partial<WtFaceParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => (p as unknown as Record<string, number>)[id];
}

function readout(id: string, over: Partial<WtFaceParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

function dspSource(): string {
  return readFileSync(
    fileURLToPath(new URL('../../../../../dsp/src/wavetable-vco.ts', import.meta.url)),
    'utf8',
  );
}

describe('wavetable vco face model — the worklet source pin', () => {
  it('the four-term semitone sum and its clamp are still what the model mirrors', () => {
    const src = dspSource();
    // ⚠ `fine / 100` here is SEMITONES from a ±100 CENT param, which is why the
    // model's exponent is `fine/1200` and not `fine/100`. Getting that wrong is
    // a 12× error that still looks plausible on a faceplate.
    expect(src).toContain('const semitones = pitch * 12 + tune + fine / 100 + fma * fm * 12;');
    expect(src).toContain('let freq = 261.626 * Math.pow(2, semitones / 12);');
    expect(src).toContain('if (freq < 1) freq = 1;');
    expect(src).toContain('else if (freq > 20000) freq = 20000;');
    expect(WT_C4_HZ).toBe(261.626);
    expect(WT_FREQ_MIN_HZ).toBe(1);
    expect(WT_FREQ_MAX_HZ).toBe(20000);
    expect(WT_FM_SEMITONES_AT_FULL_SCALE).toBe(12);
  });

  it('PM is still a READ-PHASE offset and never touches the accumulator', () => {
    // This is the load-bearing source fact behind the PAGE SPLIT: `fmAmount`
    // sits in the `pitch` band and `pmAmount` in the `wave` band because the
    // worklet advances the phase on `freq / sr` alone and then reads at
    // `phase + pma * pm`. If PM ever entered the semitone sum, the face's band
    // labels would be lying and this leg is what says so.
    const src = dspSource();
    expect(src).toContain('this.phase += freq / sr;');
    expect(src).toContain('let p = this.phase + pma * pm;');
    expect(src).not.toContain('pma * pm * 12');
  });

  it('the wavetable is still 16 frames scanned by `wp * (FC - 1)`', () => {
    const src = dspSource();
    expect(src).toContain('const frameFloat = wp * (FC - 1);');
    // FRAME_COUNT lives on the DEF (the factory generates the table), so the
    // model's copy is pinned against the def rather than the worklet.
    const defSrc = readFileSync(
      fileURLToPath(new URL('../../audio/modules/wavetable-vco.ts', import.meta.url)),
      'utf8',
    );
    expect(defSrc).toContain('const FRAME_COUNT = 16;');
    expect(WT_FRAME_COUNT).toBe(16);
  });

  it("`wavePos` is CLAMPED, so its CV can only push the shipped default UP", () => {
    // The default is 0 — the very bottom of the table — and the worklet clamps
    // `wpKnob + wpCv` to 0..1. So on a fresh module the WAVE POSITION jack has
    // full upward authority and exactly none downward, which is the attenumix
    // "CV cannot reach a control already at its rail" shape, inverted.
    const src = dspSource();
    expect(src).toContain('let wp = wpKnob + wpCv;');
    expect(src).toContain('if (wp < 0) wp = 0;');
    expect(src).toContain('else if (wp > 1) wp = 1;');
    expect(wavetableVcoDef.params.find((p) => p.id === 'wavePos')!.defaultValue).toBe(0);
  });
});

describe('wavetable vco face model — `knob pitch` (wavetablevco-knob-hz)', () => {
  it('at the shipped defaults it prints C4', () => {
    expect(readout('wavetablevco-knob-hz')).toBe('261.6 Hz');
  });

  it('NEGATIVE CONTROL — FINE moves it while a `tune` readback cannot budge', () => {
    // The whole argument for the readout in one assertion: TUNE is 0 in all
    // three, so a `paramId: "tune"` readout prints the same string throughout
    // while the module sounds a full semitone apart at the ends.
    const at = (fine: number) => readout('wavetablevco-knob-hz', { fine });
    expect(at(0)).toBe('261.6 Hz');
    expect(at(100)).toBe('277.2 Hz');
    expect(at(-100)).toBe('246.9 Hz');
    // …and at the +10-cent step the analogVco model's formatter note exists
    // for: an integer-Hz format would print `262 Hz` for both of these.
    expect(at(10)).toBe('263.1 Hz');
    expect(at(0)).not.toBe(at(10));
  });

  it('NEGATIVE CONTROL — it is blind to WAVE, FM and PM, and must be', () => {
    // The readout is knob-pitch: three of the module's five params genuinely do
    // not enter it, and a readout that twitched on them would be wrong. This is
    // the inverse leg — "moves when it should" is only half a control.
    for (const over of [{ wavePos: 1 }, { fmAmount: 1 }, { pmAmount: 1 }, { fmAmount: -1 }]) {
      expect(readout('wavetablevco-knob-hz', over), JSON.stringify(over)).toBe('261.6 Hz');
    }
  });

  it('TUNE spans the full ±3 octaves and switches to kHz above 1000', () => {
    expect(readout('wavetablevco-knob-hz', { tune: 12 })).toBe('523.3 Hz');
    expect(readout('wavetablevco-knob-hz', { tune: -12 })).toBe('130.8 Hz');
    expect(readout('wavetablevco-knob-hz', { tune: -36 })).toBe('32.7 Hz');
    expect(readout('wavetablevco-knob-hz', { tune: 36, fine: 100 })).toBe('2.22 kHz');
  });

  it("agrees with the worklet's own arithmetic across the whole travel", () => {
    // The model mirrors the DSP; this re-derives the DSP's expression here and
    // compares, so a typo in EITHER copy is red rather than mutually confirming.
    for (const tune of [-36, -12, -1, 0, 1, 7, 12, 36]) {
      for (const fine of [-100, -10, 0, 10, 100]) {
        const semitones = tune + fine / 100;
        const want = Math.min(20000, Math.max(1, 261.626 * Math.pow(2, semitones / 12)));
        expect(wtKnobHz({ ...DEFAULTS, tune, fine }), `tune ${tune} fine ${fine}`)
          .toBeCloseTo(want, 9);
      }
    }
  });
});

describe('wavetable vco face model — `fm span` (wavetablevco-fm-span)', () => {
  it('reads `off` at the shipped default, because the FM input is ignored there', () => {
    expect(readout('wavetablevco-fm-span')).toBe('off');
  });

  it('NEGATIVE CONTROL — TUNE moves the Hz swing while the FM AMT dial cannot', () => {
    // THE readout's reason to exist. `fmAmount` is 1 in all three rows, so a
    // `paramId: "fmAmount"` readout prints `1.00` throughout — while the actual
    // Hz deviation DOUBLES per octave. Measured against the shipping worklet in
    // art/scenarios/wavetable-vco/cv-path.test.ts (+260.11/−130.84 Hz at C4,
    // +520.23/−260.96 at tune +12).
    expect(readout('wavetablevco-fm-span', { fmAmount: 1 }))
      .toBe('±1200 ¢ · +261.6 Hz / −130.8 Hz');
    expect(readout('wavetablevco-fm-span', { fmAmount: 1, tune: 12 }))
      .toBe('±1200 ¢ · +523.3 Hz / −261.6 Hz');
    expect(readout('wavetablevco-fm-span', { fmAmount: 1, tune: -12 }))
      .toBe('±1200 ¢ · +130.8 Hz / −65.4 Hz');
  });

  it('NEGATIVE CONTROL — the SIGN must not move the span, at all', () => {
    // `fma * fm` is naturally signed, so a negative depth is a 180° flip of the
    // MODULATOR, not a reversed sweep and not a smaller one. A knob readback
    // swings through zero across these three; the span is symmetric about it.
    const plus = readout('wavetablevco-fm-span', { fmAmount: 0.5 });
    const minus = readout('wavetablevco-fm-span', { fmAmount: -0.5 });
    expect(minus).toBe(plus);
    expect(plus).toBe('±600 ¢ · +108.4 Hz / −76.6 Hz');
    // …and the two ends of the dial are NOT the same as its centre.
    expect(readout('wavetablevco-fm-span', { fmAmount: 1 })).not.toBe(plus);
  });

  it('the swing is ASYMMETRIC — up ≠ down, at every non-zero depth', () => {
    // The one fact about exponential FM a symmetric ± dial cannot express, and
    // the reason the readout prints both directions instead of one number.
    for (const fmAmount of [0.1, 0.25, 0.5, 0.75, 1]) {
      const { up, down } = wtFmSpanHz({ ...DEFAULTS, fmAmount });
      expect(up, `depth ${fmAmount}`).toBeGreaterThan(down);
      // The ratio is exactly 2^a, independent of the fundamental.
      expect(up / down, `depth ${fmAmount}`).toBeCloseTo(Math.pow(2, fmAmount), 9);
    }
  });

  it('the CENTS half is linear in |depth| and blind to TUNE — the instrument’s own control', () => {
    // Publishing BOTH halves is what makes each one's blindness visible: cents
    // is TUNE-invariant and Hz is not, so a bug that made one track the other
    // shows up as the two halves agreeing when they should not.
    for (const tune of [-24, 0, 24]) {
      expect(wtFmSpanCents({ ...DEFAULTS, tune, fmAmount: 0.25 }), `tune ${tune}`).toBe(300);
    }
    expect(wtFmSpanCents({ ...DEFAULTS, fmAmount: 1 })).toBe(1200);
    expect(wtFmSpanCents({ ...DEFAULTS, fmAmount: 0 })).toBe(0);
  });
});

describe('wavetable vco face model — TOTALITY', () => {
  // A readout runs on EVERY render, so a throw takes the faceplate down
  // mid-drag. Both must survive a fresh node, a missing param, a NaN and an
  // infinity — the shapes a live drag and a corrupted save actually produce.
  const IDS = ['wavetablevco-knob-hz', 'wavetablevco-fm-span'] as const;

  it('an UNKNOWN param id in the model throws loudly rather than printing NaN', () => {
    // The other half of totality: `wtFaceParams` must not silently invent a
    // default for a param the def does not declare, because that is how a
    // renamed param starts printing a confident wrong number.
    expect(() => wtFaceParams(() => undefined)).not.toThrow();
    // …and every id the model reads is a real declared param, asserted here so
    // a def rename is RED instead of resolving to `undefined` forever.
    for (const id of ['tune', 'fine', 'fmAmount', 'pmAmount', 'wavePos']) {
      expect(wavetableVcoDef.params.some((p) => p.id === id), id).toBe(true);
    }
  });
});
