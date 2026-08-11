// packages/web/src/lib/ui/modules/marbles-face-model.test.ts
//
// The ORACLE for the MARBLES faceplate: every law `marbles-face-model` states
// is RE-DERIVED here from `marblesMath` — a real render of the same engine core
// the worklet runs — so a DSP change turns a stale faceplate claim RED instead
// of leaving it insisting on a behaviour the module no longer has.
//
// ⚠ AND EVERY CLAIM IS NEGATIVE-CONTROLLED IN BOTH DIRECTIONS, because marbles
// is the module in this repo where a wrong measurement most convincingly looks
// like a finding. The spec this face was built from was wrong FOUR times, each
// time from probing a random process at one seed on a coarse grid:
//
//   · it reported the T loop SATURATED across the whole top half of DÉJÀ VU.
//     It is not — both sections peak at exactly 0.5 and fall away above it. The
//     saturation was an artifact of `length 4` plus an IOI-tolerance metric on
//     a seed whose 4-slot loop happened to sit entirely on one side of the gate
//     threshold. (This file measures the per-clock GATE WORD at the shipped
//     length 8, which has neither problem.)
//   · it reported X BIAS's ends as DC constants. They are not; SPREAD's are.
//   · it reported STEPS' bottom half as a dead knob. It is the PORTAMENTO.
//   · it reported CLUSTERS as a "behavioural collapse". It is a commented stub.
//
// The instrument discipline that follows from that, applied throughout:
//   1. read the value at a FIXED LAG after a clock edge, never mid-glide;
//   2. compare the GATE WORD per clock, never an IOI with a tolerance;
//   3. measure at a SPREAD that cannot clip (0.4) whenever the question is
//      about the quantiser, since the ±1 rail manufactures false collapses;
//   4. pair every "these are identical" with a control that must DIFFER.

import { describe, expect, it } from 'vitest';
import { marblesDef, marblesMath, type MarblesParams } from '$lib/audio/modules/marbles';
import { MARBLES_SCALE_NAMES } from '$lib/audio/modules/marbles-names';
import { PRESET_SCALES } from '$lib/audio/modules/marbles-engine';
import {
  MARBLES_FACE_DEFAULTS,
  MARBLES_GLIDE_TABLE,
  MARBLES_QUANT_LEVELS,
  MARBLES_QUANT_MIN_STEPS,
  MARBLES_SCALE_BAND,
  MARBLES_STUB_MODEL,
  MARBLES_STUB_MODEL_ALIAS,
  marblesActiveDegrees,
  marblesBpm,
  marblesBpmText,
  marblesClockHz,
  marblesDcVolts,
  marblesDejaVuP,
  marblesFaceParams,
  marblesGateWidth,
  marblesGateWidthText,
  marblesGlideFraction,
  marblesLoopPlan,
  marblesLoopState,
  marblesLoopText,
  marblesModelText,
  marblesGlideText,
  marblesRandomText,
  marblesStepText,
  marblesQuantLevel,
  marblesQuantiserText,
  marblesRingCaption,
  marblesScaleLiveText,
  marblesScaleVariants,
  marblesSplitText,
  marblesXShapeText,
  type MarblesFaceParams,
} from './marbles-face-model';

const SR = 32000;

function params(over: Partial<MarblesParams> = {}): MarblesParams {
  const p: Record<string, number> = {};
  for (const d of marblesDef.params) p[d.id] = d.defaultValue;
  return { ...(p as unknown as MarblesParams), ...over };
}

function face(over: Partial<MarblesFaceParams> = {}): MarblesFaceParams {
  return marblesFaceParams((id) => (over as Record<string, number>)[id] ?? undefined);
}

/** Rising edges, counting a buffer that STARTS HIGH as an edge at 0 — the
 *  artifact that cost the spec a phantom 0.125 Hz shortfall. */
function edges(buf: Float32Array): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]! >= 0.5 ? 1 : 0;
    if (prev < 1 && c === 1) out.push(i);
    prev = c;
  }
  return out;
}

function duty(buf: Float32Array): number {
  let hi = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i]! >= 0.5) hi++;
  return hi / buf.length;
}

/** The X value read at a FIXED LAG after each clock edge — never mid-glide. */
function clocked(x: Float32Array, clk: Float32Array, lag = 200): number[] {
  const out: number[] = [];
  for (const e of edges(clk)) if (e + lag < x.length) out.push(x[e + lag]!);
  return out;
}

/** Which of t1/t2 fired on each clock, as a 2-bit word. The honest observable
 *  for "does the T pattern repeat" — an IOI comparison needs a tolerance and
 *  aliases against short loops. */
function gateWords(r: { t1: Float32Array; t2: Float32Array; clk: Float32Array }): number[] {
  const ce = edges(r.clk);
  const slotOf = (i: number): number => {
    let k = 0;
    for (let j = 0; j < ce.length; j++) if (ce[j]! <= i) k = j;
    return k;
  };
  const w = ce.map(() => 0);
  for (const i of edges(r.t1)) w[slotOf(i)]! |= 1;
  for (const i of edges(r.t2)) w[slotOf(i)]! |= 2;
  return w;
}

function repeatRate(v: readonly (number | string)[], period: number): number {
  let m = 0;
  let c = 0;
  for (let i = period; i < v.length; i++) {
    c++;
    if (v[i] === v[i - period]) m++;
  }
  return c ? m / c : NaN;
}

const bitEqual = (a: Float32Array, b: Float32Array): boolean => a.every((v, i) => v === b[i]);

// ───────────────────────────────────────────────────────────────────────────

describe('marbles face model — the CLOCK', () => {
  it('ORACLE: f = 2 Hz · 2^(RATE/12), across the whole fader', () => {
    for (const rate of [-60, -24, -12, 0, 12, 24, 36, 60]) {
      const seconds = rate <= -24 ? 40 : 8;
      const r = marblesMath.render(Math.round(SR * seconds), SR, params({ rate }));
      const e = edges(r.clk);
      expect(e.length, `rate ${rate}: the clock must actually run`).toBeGreaterThan(1);
      let sum = 0;
      for (let i = 1; i < e.length; i++) sum += e[i]! - e[i - 1]!;
      const hz = SR / (sum / (e.length - 1));
      // RELATIVE, not absolute: the IOI is an integer number of samples, so at
      // RATE +60 (750 samples per period) one sample of rounding is 1.3e-3 Hz
      // — an absolute tolerance would be a different assertion at every rate.
      expect(
        Math.abs(hz / marblesClockHz(rate) - 1),
        `rate ${rate} st: ${hz} Hz vs the declared ${marblesClockHz(rate)} Hz (relative)`,
      ).toBeLessThan(1e-4);
    }
  });

  it('the BPM readout is what a clock needs and the param value is not', () => {
    expect(marblesBpm(0)).toBeCloseTo(120, 6);
    expect(marblesBpm(-60)).toBeCloseTo(3.75, 6);
    expect(marblesBpm(60)).toBeCloseTo(3840, 6);
    expect(marblesBpmText(face())).toBe('120.0 BPM');
    expect(marblesStepText(face())).toBe('500 ms');
    // The bottom of the fader is ONE PULSE EVERY 16 SECONDS.
    expect(marblesBpmText(face({ rate: -60 }))).toBe('3.8 BPM');
    expect(marblesStepText(face({ rate: -60 }))).toBe('16.0 s');
  });

  it('NEGATIVE CONTROL: the BPM readout is JITTER-invariant, and the DSP agrees', () => {
    // A readout of the LAST interval would move with jitter. The mean rate does
    // not (a zero-mean displacement), so the derivation must not either.
    const texts = new Set<string>();
    const means: number[] = [];
    for (const j of [0, 0.25, 0.5, 0.75, 1]) {
      texts.add(marblesBpmText(face({ t_jitter: j })));
      const r = marblesMath.render(SR * 30, SR, params({ rate: 0, t_jitter: j }));
      const e = edges(r.clk);
      let sum = 0;
      for (let i = 1; i < e.length; i++) sum += e[i]! - e[i - 1]!;
      means.push(sum / (e.length - 1));
    }
    expect([...texts], 'the readout must print ONE string across the jitter range').toHaveLength(1);
    for (const m of means) {
      expect(SR / m, 'the measured MEAN rate is jitter-invariant too').toBeCloseTo(2, 1);
    }
    // …and the control is not vacuous: jitter DOES move the spread.
    const flat = marblesMath.render(SR * 30, SR, params({ rate: 0, t_jitter: 0 }));
    const wild = marblesMath.render(SR * 30, SR, params({ rate: 0, t_jitter: 1 }));
    const sd = (r: { clk: Float32Array }): number => {
      const e = edges(r.clk);
      const io: number[] = [];
      for (let i = 1; i < e.length; i++) io.push(e[i]! - e[i - 1]!);
      const mu = io.reduce((s, v) => s + v, 0) / io.length;
      return Math.sqrt(io.reduce((s, v) => s + (v - mu) ** 2, 0) / io.length);
    };
    expect(sd(flat), 'jitter 0 is metronomic').toBeLessThan(1);
    expect(sd(wild), 'jitter 1 is not — so the invariance above is a real control').toBeGreaterThan(
      500,
    );
  });
});

describe('marbles face model — DÉJÀ VU is ONE law with a maximum in the MIDDLE', () => {
  it('p = (2·dv − 1)²: 1 at both ends, 0 at the lock', () => {
    expect(marblesDejaVuP(0)).toBeCloseTo(1, 12);
    expect(marblesDejaVuP(0.25)).toBeCloseTo(0.25, 12);
    expect(marblesDejaVuP(0.5)).toBeCloseTo(0, 12);
    expect(marblesDejaVuP(0.75)).toBeCloseTo(0.25, 12);
    expect(marblesDejaVuP(1)).toBeCloseTo(1, 12);
  });

  it('ORACLE: BOTH sections peak at 0.5 and fall away above it (the spec said T saturates)', () => {
    const tRepeat: number[] = [];
    const xRepeat: number[] = [];
    for (const dv of [0, 0.25, 0.5, 0.75, 1]) {
      const t = marblesMath.render(SR * 12, SR, params({ rate: 36, deja_vu: dv, length: 8 }));
      tRepeat.push(repeatRate(gateWords(t), 8));
      const x = marblesMath.render(SR * 12, SR, params({ rate: 36, x_deja_vu: dv, x_length: 8 }));
      xRepeat.push(repeatRate(clocked(x.x1, x.clk, 100), 8));
    }
    const [t0, tQ, tHalf, tHi, tTop] = tRepeat as [number, number, number, number, number];
    const [x0, xQ, xHalf, xHi, xTop] = xRepeat as [number, number, number, number, number];

    // the lock is real, on BOTH sections
    expect(tHalf, `T at the lock (${tRepeat.map((v) => v.toFixed(3)).join(' ')})`).toBeGreaterThan(0.95);
    expect(xHalf, `X at the lock (${xRepeat.map((v) => v.toFixed(3)).join(' ')})`).toBeGreaterThan(0.95);
    // …and it is a PEAK, not a plateau: the top of the knob repeats LESS.
    expect(tTop, 'T at 1.0 must repeat LESS than at the lock').toBeLessThan(tHalf - 0.2);
    expect(xTop, 'X at 1.0 must repeat LESS than at the lock').toBeLessThan(xHalf - 0.2);
    expect(tHi, 'T at 0.75 too').toBeLessThan(tHalf - 0.2);
    expect(xHi, 'X at 0.75 too').toBeLessThan(xHalf - 0.2);
    // and it rises INTO the lock from below, so the shape is a peak either side
    expect(tQ).toBeLessThan(tHalf);
    expect(xQ).toBeLessThan(xHalf);
    expect(t0).toBeLessThan(tHalf);
    expect(x0).toBeLessThan(xHalf);
  });

  it('ORACLE: LENGTH is BIT-EXACTLY inert at deja_vu 0 — and live above it', () => {
    const at = (dv: number, len: number) =>
      marblesMath.render(SR * 6, SR, params({ rate: 24, t_bias: 0.7, deja_vu: dv, length: len }));
    const ref0 = at(0, 1);
    for (const len of [2, 3, 4, 5, 8, 16]) {
      expect(
        bitEqual(at(0, len).t1, ref0.t1),
        `deja_vu 0, length ${len}: LENGTH cannot be observable when every step re-rolls`,
      ).toBe(true);
    }
    // NEGATIVE CONTROL — the same comparison must FAIL once the loop exists.
    const refLock = at(1, 1);
    const differing = [2, 3, 4, 5, 8, 16].filter((len) => !bitEqual(at(1, len).t1, refLock.t1));
    expect(differing.length, 'under the lock, LENGTH must change the pattern').toBeGreaterThan(4);
  });

  it('the readout refuses to print a length it cannot honour, and is non-monotone', () => {
    expect(marblesLoopText(0, 8)).toBe('free');
    expect(marblesLoopText(0, 8)).not.toMatch(/8/);
    expect(marblesLoopText(0.5, 8)).toBe('8 steps');
    // The RANDOM value carries the non-monotone shape, as a bare percentage —
    // 100 % at both ends of the knob and 0 % in the middle.
    expect(marblesRandomText(0)).toBe('100 %');
    expect(marblesRandomText(0.25)).toBe('25 %');
    expect(marblesRandomText(0.5)).toBe('0 %');
    expect(marblesRandomText(0.75)).toBe('25 %');
    expect(marblesRandomText(1)).toBe('100 %');
    // NEGATIVE CONTROL: the top of the knob must not read as MORE locked than
    // the middle — the exact error a derivation that scaled with the knob makes.
    expect(marblesLoopState(1, 8).mode).not.toBe('locked');
    expect(marblesLoopState(0.5, 8).mode).toBe('locked');
    expect(marblesLoopState(1, 8).p).toBeGreaterThan(marblesLoopState(0.5, 8).p);
    expect(marblesLoopState(0, 8).lengthLive).toBe(false);
    expect(marblesLoopState(0.001, 8).lengthLive).toBe(true);
  });
});

describe('marbles face model — the T section', () => {
  it('ORACLE: CLUSTERS is bit-identical to COIN, and DRUMS is the control', () => {
    for (const t_bias of [0.3, 0.5, 0.7]) {
      const coin = marblesMath.render(SR * 8, SR, params({ rate: 24, t_bias, t_model: MARBLES_STUB_MODEL_ALIAS }));
      const stub = marblesMath.render(SR * 8, SR, params({ rate: 24, t_bias, t_model: MARBLES_STUB_MODEL }));
      const drums = marblesMath.render(SR * 8, SR, params({ rate: 24, t_bias, t_model: 2 }));
      expect(bitEqual(stub.t1, coin.t1), `bias ${t_bias}: CLUSTERS t1 ≡ COIN t1`).toBe(true);
      expect(bitEqual(stub.t2, coin.t2), `bias ${t_bias}: CLUSTERS t2 ≡ COIN t2`).toBe(true);
      expect(bitEqual(drums.t1, coin.t1), `bias ${t_bias}: DRUMS must DIFFER (control)`).toBe(false);
    }
    expect(marblesModelText(face({ t_model: MARBLES_STUB_MODEL }))).toBe('CLUSTERS → COIN');
    expect(marblesModelText(face({ t_model: MARBLES_STUB_MODEL_ALIAS }))).toBe('COIN');
    expect(marblesModelText(face({ t_model: 2 }))).toBe('DRUMS');
  });

  it('ORACLE: the complementary coin shares every clock — P(t1) = 1 − BIAS', () => {
    for (const b of [0.25, 0.5, 0.75]) {
      const r = marblesMath.render(SR * 16, SR, params({ rate: 24, t_bias: b }));
      const clk = edges(r.clk).length;
      const n1 = edges(r.t1).length;
      const n2 = edges(r.t2).length;
      expect((n1 + n2) / clk, `bias ${b}: exactly one of t1/t2 per clock`).toBeCloseTo(1, 1);
      expect(n1 / (n1 + n2), `bias ${b}: t1 share vs the declared 1 − BIAS`).toBeCloseTo(1 - b, 1);
    }
    expect(marblesSplitText(face({ t_bias: 0.25 }))).toBe('75 / 25');
    // NEGATIVE CONTROL: INDEP is NOT complementary — both can fire on one clock.
    const indep = marblesMath.render(SR * 16, SR, params({ rate: 24, t_model: 3, deja_vu: 1 }));
    const ic = edges(indep.clk).length;
    expect(
      (edges(indep.t1).length + edges(indep.t2).length) / ic,
      'INDEP must break the one-per-clock property the readout claims for COIN',
    ).toBeGreaterThan(1.05);
    expect(marblesSplitText(face({ t_model: 3, t_bias: 0.25 }))).toBe('75 / 25');
    // …and the three models with NO closed form print a blank rather than a
    // plausible number.
    expect(marblesSplitText(face({ t_model: 2 }))).toBe('—');
    expect(marblesSplitText(face({ t_model: 4 }))).toBe('—');
    expect(marblesSplitText(face({ t_model: 5 }))).toBe('—');
  });

  it('ORACLE: gate width is 5 % + 90 %·PW, and `clk` stays 50 % throughout', () => {
    for (const pw of [0, 0.25, 0.5, 0.75, 1]) {
      // t_bias 0 routes essentially every gate to t1, so its duty IS the width.
      const r = marblesMath.render(SR * 16, SR, params({ rate: 24, t_bias: 0, pw_mean: pw }));
      expect(duty(r.t1), `pw ${pw}: measured t1 duty vs 0.05 + 0.9·PW`).toBeCloseTo(
        marblesGateWidth(pw),
        1,
      );
      expect(duty(r.clk), `pw ${pw}: clk is a 50 % square regardless`).toBeCloseTo(0.5, 3);
    }
    expect(marblesGateWidthText(face())).toBe('50 %');
    expect(marblesGateWidthText(face({ pw_mean: 0 }))).toBe('5 %');
    // NEGATIVE CONTROL: the width is a FRACTION, so it must not move with RATE.
    const slow = marblesMath.render(SR * 16, SR, params({ rate: 12, t_bias: 0, pw_mean: 0.75 }));
    const fast = marblesMath.render(SR * 16, SR, params({ rate: 36, t_bias: 0, pw_mean: 0.75 }));
    expect(duty(slow.t1)).toBeCloseTo(duty(fast.t1), 1);
  });
});

describe('marbles face model — the X quantiser', () => {
  it('ORACLE: the level ladder predicts the degrees-per-octave of all six scales', () => {
    // 0.2 output units = 1 V = one octave, and SPREAD 0.4 cannot reach the rail,
    // so a false "collapse" cannot be manufactured by clipping.
    for (const [steps, level] of [
      [0.55, 1],
      [0.62, 2],
      [0.72, 3],
      [0.79, 4],
      [0.86, 5],
      [0.93, 6],
      [0.99, 7],
    ] as const) {
      expect(marblesQuantLevel(steps), `steps ${steps} → level`).toBe(level);
      for (let sc = 0; sc < PRESET_SCALES.length; sc++) {
        const r = marblesMath.render(SR * 24, SR, params({ rate: 36, spread: 0.4, steps, scale: sc }));
        const inOctave = new Set(
          clocked(r.x1, r.clk).filter((v) => v >= 0 && v < 0.2).map((v) => v.toFixed(6)),
        ).size;
        expect(
          inOctave,
          `steps ${steps} (level ${level}), ${MARBLES_SCALE_NAMES[sc]}: measured degrees in [0,1) V`,
        ).toBe(marblesActiveDegrees(sc, steps).length);
      }
    }
  });

  it('ORACLE: the quantiser does NOTHING below 0.536, and the module ships at 0.50', () => {
    const shipped = marblesDef.params.find((p) => p.id === 'steps')!.defaultValue;
    expect(shipped).toBeLessThan(MARBLES_QUANT_MIN_STEPS);
    expect(marblesQuantLevel(shipped)).toBe(0);
    for (const steps of [0, 0.25, 0.5, 0.53]) {
      const r = marblesMath.render(SR * 12, SR, params({ rate: 36, spread: 0.4, steps }));
      const v = clocked(r.x1, r.clk);
      expect(
        new Set(v.map((q) => q.toFixed(9))).size,
        `steps ${steps}: every clocked value distinct — nothing is being snapped`,
      ).toBe(v.length);
    }
    // NEGATIVE CONTROL — one notch over the threshold and it snaps hard.
    const on = marblesMath.render(SR * 12, SR, params({ rate: 36, spread: 0.4, steps: 0.54 }));
    const vOn = clocked(on.x1, on.clk);
    expect(new Set(vOn.map((q) => q.toFixed(9))).size).toBeLessThan(vOn.length / 3);
    expect(marblesQuantLevel(0.54)).toBe(1);
  });

  it('ORACLE: SCALE is invariant below the threshold and six-way inside the band', () => {
    const fingerprint = (steps: number, sc: number): string => {
      const r = marblesMath.render(SR * 12, SR, params({ rate: 36, spread: 0.4, steps, scale: sc }));
      return clocked(r.x1, r.clk).map((v) => v.toFixed(6)).join(',');
    };
    const distinctAt = (steps: number): number =>
      new Set(PRESET_SCALES.map((_, sc) => fingerprint(steps, sc))).size;

    // below the threshold: the six scales are BIT-IDENTICAL, and the readout
    // says so instead of naming one.
    expect(distinctAt(0.5), 'the shipped default — SCALE cannot matter here').toBe(1);
    expect(marblesScaleLiveText(face())).toBe('1 of 6');

    // inside the band: all six differ, and the model predicts it
    for (const steps of [0.62, 0.75, 0.88]) {
      expect(distinctAt(steps), `steps ${steps}: all six scales distinguishable`).toBe(6);
      expect(marblesScaleVariants(steps)).toBe(6);
      expect(marblesScaleLiveText(face({ steps }))).toBe('6 of 6');
    }
    // outside it, the model predicts the COLLAPSE and its size
    for (const steps of [0.55, 0.93]) {
      expect(distinctAt(steps), `steps ${steps}: the collapse the model predicts`).toBe(
        marblesScaleVariants(steps),
      );
      expect(marblesScaleVariants(steps)).toBe(3);
    }
    expect(distinctAt(0.99)).toBe(1);
    expect(marblesScaleVariants(0.99)).toBe(1);
    expect(marblesScaleLiveText(face({ steps: 0.99 }))).toBe('1 of 6');

    // The declared band is exactly quantiser levels 2..5. Probed 1e-6 INSIDE
    // each endpoint: both endpoints sit on a `Math.round` tie (…·7 = 1.5 and
    // 5.5), where binary floating point decides the direction, so asserting AT
    // the boundary would be testing the FPU rather than the model.
    expect(marblesQuantLevel(MARBLES_SCALE_BAND[0] - 1e-6)).toBe(1);
    expect(marblesQuantLevel(MARBLES_SCALE_BAND[0] + 1e-6)).toBe(2);
    expect(marblesQuantLevel(MARBLES_SCALE_BAND[1] - 1e-6)).toBe(5);
    expect(marblesQuantLevel(MARBLES_SCALE_BAND[1] + 1e-6)).toBe(6);
  });

  it('NEGATIVE CONTROL: the scale-live readout does NOT move with SCALE', () => {
    for (const steps of [0.5, 0.62, 0.99]) {
      const texts = new Set(
        MARBLES_SCALE_NAMES.map((_, sc) => marblesScaleLiveText(face({ steps, scale: sc }))),
      );
      expect([...texts], `steps ${steps}: one answer for every scale`).toHaveLength(1);
    }
    // …and it is not a constant either: it must move with STEPS. (0.5 and 0.99
    // both read `1 of 6` and that is CORRECT — the quantiser is off at one and
    // collapsed to the root at the other — so the third probe is level 1, where
    // three of the six survive.)
    expect(new Set([0.5, 0.55, 0.62].map((s) => marblesScaleLiveText(face({ steps: s })))).size).toBe(3);
  });

  it('ORACLE: STEPS below 0.5 is a PORTAMENTO, and the glide is a FRACTION of the step', () => {
    const measure = (rate: number, steps: number): number => {
      const period = Math.round(SR / marblesClockHz(rate));
      const r = marblesMath.render(SR * 20, SR, params({ rate, spread: 0.6, steps }));
      const e = edges(r.clk);
      const fr: number[] = [];
      for (const k of [12, 17, 22, 27]) {
        const at = e[k];
        if (at === undefined || at + period >= r.x1.length) continue;
        const target = r.x1[at + period - 60]!;
        const span = Math.abs(target - r.x1[at]!);
        if (span < 5e-3) continue;
        let settle = period - 60;
        for (let i = 0; i < period - 60; i++) {
          if (Math.abs(r.x1[at + i]! - target) <= 0.02 * span) {
            settle = i;
            break;
          }
        }
        fr.push(settle / period);
      }
      return fr.reduce((s, v) => s + v, 0) / fr.length;
    };

    for (const [steps, declared] of MARBLES_GLIDE_TABLE) {
      if (steps >= 0.49) continue; // the table's tail is 0 and has no span to measure
      expect(measure(24, steps), `steps ${steps}: the declared glide fraction`).toBeCloseTo(
        declared,
        1,
      );
    }
    // RATE-INVARIANT — the whole reason the table is a fraction and not a time.
    for (const steps of [0.1, 0.3, 0.45]) {
      expect(measure(12, steps), `steps ${steps}: same fraction at a 4× slower clock`).toBeCloseTo(
        measure(36, steps),
        1,
      );
    }
    // NEGATIVE CONTROL — above 0.5 there is no glide at all: the value is held
    // for the whole step, so a period holds exactly ONE distinct sample.
    const hard = marblesMath.render(SR * 12, SR, params({ rate: 24, spread: 0.6, steps: 0.6 }));
    const e = edges(hard.clk);
    const period = Math.round(SR / marblesClockHz(24));
    const seg = Array.from(hard.x1.slice(e[12]!, e[12]! + period - 60));
    expect(new Set(seg.map((v) => v.toFixed(9))).size, 'no glide above the step threshold').toBe(1);
    expect(marblesGlideFraction(0.6)).toBe(0);
    expect(marblesGlideFraction(0)).toBeGreaterThan(0.8);
  });

  it('the quantiser readout names the regime the module actually ships in', () => {
    // THE SHIPPED DEFAULT: the glide has already reached zero and the quantiser
    // has not woken. Two adjacent bare values state the gap with no sentence.
    expect(marblesQuantiserText(face())).toBe('off');
    expect(marblesGlideText(face())).toBe('0 %');
    expect(marblesGlideText(face({ steps: 0 }))).toMatch(/^9\d %$/);
    expect(marblesQuantiserText(face({ steps: 0 }))).toBe('off');
    expect(marblesQuantiserText(face({ steps: 0.79 }))).toBe('7 of 12');
    expect(marblesQuantiserText(face({ steps: 0.79, scale: 3 }))).toBe('4 of 7');
    expect(marblesQuantiserText(face({ steps: 1 }))).toBe('1 of 12');
  });
});

describe('marbles face model — the X shape: BOTH ends of SPREAD are degenerate', () => {
  it('ORACLE: SPREAD ≤ 0.01 is a DC constant at exactly 10·BIAS − 5 volts', () => {
    for (const spread of [0, 0.01]) {
      for (const bias of [0, 0.25, 0.5, 0.75, 1]) {
        const r = marblesMath.render(SR * 12, SR, params({ rate: 24, spread, x_bias: bias }));
        // skip the pre-first-clock sample: the render starts at 0 before any
        // voltage has been generated.
        const v = clocked(r.x1, r.clk).slice(1);
        const host = marblesDcVolts(bias) / 5;
        expect(
          new Set(v.map((q) => q.toFixed(6))).size,
          `spread ${spread}, bias ${bias}: one value only`,
        ).toBe(1);
        expect(v[0]!, `spread ${spread}, bias ${bias}: the DC level`).toBeCloseTo(host, 5);
      }
    }
    expect(marblesXShapeText(face({ spread: 0 }))).toBe('DC 0.00 V');
    expect(marblesXShapeText(face({ spread: 0, x_bias: 0 }))).toBe('DC -5.00 V');
  });

  it('ORACLE: SPREAD ≥ 0.99 is a two-level COIN FLIP at the rails', () => {
    for (const spread of [0.99, 1]) {
      const r = marblesMath.render(SR * 12, SR, params({ rate: 24, spread }));
      const v = clocked(r.x1, r.clk).slice(1);
      const uniq = [...new Set(v.map((q) => q.toFixed(5)))];
      expect(uniq.length, `spread ${spread}: exactly two output values`).toBe(2);
      expect(Math.min(...uniq.map(Number))).toBeCloseTo(-1, 3);
      expect(Math.max(...uniq.map(Number))).toBeCloseTo(1, 3);
    }
    expect(marblesXShapeText(face({ spread: 1 }))).toBe('2-level ±5 V');
  });

  it('NEGATIVE CONTROL: X BIAS alone does NOT produce a DC constant (the spec said it did)', () => {
    for (const bias of [0, 1]) {
      const r = marblesMath.render(SR * 12, SR, params({ rate: 24, x_bias: bias }));
      const v = clocked(r.x1, r.clk).slice(1);
      expect(
        new Set(v.map((q) => q.toFixed(9))).size,
        `x_bias ${bias} at the shipped SPREAD 0.5: a skew, not a constant`,
      ).toBeGreaterThan(10);
    }
    expect(marblesXShapeText(face({ x_bias: 0 }))).toBe('random ±5 V');
    expect(marblesXShapeText(face({ x_bias: 1 }))).toBe('random ±5 V');
  });
});

describe('marbles face model — the hero picture', () => {
  it('the plan is a pure function of the params — no clock, no analyser', () => {
    const p = face({ deja_vu: 0.5, length: 6, x_deja_vu: 0.75, x_length: 3, steps: 0.79, scale: 2 });
    const a = marblesLoopPlan(p);
    const b = marblesLoopPlan(p);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.t.slots).toBe(6);
    expect(a.x.slots).toBe(3);
    expect(a.t.state.mode).toBe('locked');
    expect(a.x.state.mode).toBe('shuffling');
    expect(a.degrees.length).toBe(marblesActiveDegrees(2, 0.79).length);
    expect(a.allDegrees.length).toBe(12);
    expect(a.scaleName).toBe('Pentatonic');
  });

  it('a section with no loop draws ONE slot, not eight', () => {
    // The picture must not draw an 8-slot ring for a control that is bit-exactly
    // inert — the same requirement the text readout carries.
    const plan = marblesLoopPlan(face());
    expect(plan.t.slots).toBe(1);
    expect(plan.x.slots).toBe(1);
    expect(plan.degrees, 'and no degree ticks, because the quantiser is off').toEqual([]);
  });

  it('NEGATIVE CONTROL: the two ring axes can NEVER render the same caption', () => {
    // Which is what makes the panel's `text` operability probe non-vacuous: a
    // dead mode button could otherwise pass by leaving the row unchanged.
    for (const rate of [-60, -12, 0, 24, 60]) {
      for (let slot = 0; slot < 16; slot++) {
        const p = face({ rate });
        expect(
          marblesRingCaption(slot, p, 'step'),
          `rate ${rate}, slot ${slot}: the two labellings must differ`,
        ).not.toBe(marblesRingCaption(slot, p, 'time'));
      }
    }
    expect(marblesRingCaption(0, face(), 'step')).toBe('1');
    expect(marblesRingCaption(2, face(), 'time')).toBe('1.00 s');
  });
});

describe('marbles face model — the instrument itself', () => {
  it('ANCHOR: the model’s default fallback IS the def’s, entry for entry', () => {
    // The model deliberately does NOT import the def — `marbles.ts` carries a
    // `?url` worklet import that Node cannot resolve, and the e2e has to be
    // able to load the model. The cost of that is a COPY of the defaults, and
    // this is the anchor that keeps the copy honest: a def default change with
    // no matching edit here would leave every readout's last-resort fallback
    // silently wrong, and nothing else in the repo would notice.
    const fromDef = Object.fromEntries(marblesDef.params.map((p) => [p.id, p.defaultValue]));
    expect(MARBLES_FACE_DEFAULTS).toEqual(fromDef);
  });

  it('the render is DETERMINISTIC, and a real perturbation is visible', () => {
    // Everything above compares renders. If the renderer were not bit-stable
    // every "identical" assertion in this file would be measuring nothing.
    const a = marblesMath.render(SR * 4, SR, params({ rate: 24 }));
    const b = marblesMath.render(SR * 4, SR, params({ rate: 24 }));
    expect(bitEqual(a.t1, b.t1) && bitEqual(a.x1, b.x1) && bitEqual(a.clk, b.clk)).toBe(true);
    const c = marblesMath.render(SR * 4, SR, params({ rate: 24, t_bias: 0.7 }));
    expect(bitEqual(a.t1, c.t1), 'a real parameter change must move the stream').toBe(false);
  });

  it('every quantiser level is reachable from the STEPS range', () => {
    const seen = new Set<number>();
    for (let s = 0; s <= 1.0001; s += 0.005) seen.add(marblesQuantLevel(s));
    for (let l = 0; l <= MARBLES_QUANT_LEVELS; l++) {
      expect(seen.has(l), `quantiser level ${l} must be reachable from the dial`).toBe(true);
    }
  });
});
