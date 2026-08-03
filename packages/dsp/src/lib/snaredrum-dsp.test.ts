// packages/dsp/src/lib/snaredrum-dsp.test.ts
//
// The single-hit snare VOICE + shared wire-bed + shared bus + stereo gate
// (design §6.1). Proves strike determinism, the frequency law, sr-calibrated
// decay (44.1k AND 48k — audit A2), per-layer isolation (Goertzel), the
// true-peak ceiling, DC cleanliness, retrigger, mono-safe stereo, and — the
// load-bearing one — that a sustained gate rolls CONTINUOUSLY (the wire bed's
// RMS never returns to 0 between strokes). Deterministic — no Math.random.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  SNAREDRUM_DEFAULTS,
  MODE_RATIO_TEST,
  decayCoeff,
  makeSnaredrumState,
  panMidGain,
  panSideGain,
  snareHeadFreqHz,
  snaredrumStepStereo,
  type SnaredrumParams,
} from './snaredrum-dsp';
import {
  makeBiquad,
  biquadStep,
  updateHighpass,
  updateLowpass,
  type Biquad,
} from './rbj-biquad';

const P = (over: Partial<SnaredrumParams> = {}): SnaredrumParams => ({ ...SNAREDRUM_DEFAULTS, ...over });

/** Render `n` stereo samples with per-sample trigger + gate drivers. */
function renderStereo(
  n: number,
  trig: (i: number) => number,
  gate: (i: number) => number,
  p: SnaredrumParams,
  sr = 48000,
  accent = 0,
): { l: Float32Array; r: Float32Array } {
  const s = makeSnaredrumState();
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const out = new Float32Array(2);
  for (let i = 0; i < n; i++) {
    snaredrumStepStereo(trig(i), gate(i), accent, p, sr, s, out);
    l[i] = out[0]!;
    r[i] = out[1]!;
  }
  return { l, r };
}

/** A 10-sample trigger pulse at sample 0 (one clean rising edge). */
const oneStrike = (i: number) => (i < 10 ? 1 : 0);
const noGate = () => 0;

/** Continuous-frequency Goertzel magnitude over [s, e), amplitude-normalized. */
function goertzel(buf: Float32Array, sr: number, hz: number, s = 0, e = buf.length): number {
  const w = (2 * Math.PI * hz) / sr;
  const c = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s; i < e; i++) {
    const q0 = buf[i]! + c * q1 - q2;
    q2 = q1;
    q1 = q0;
  }
  return Math.sqrt(Math.max(0, q1 * q1 + q2 * q2 - c * q1 * q2)) / (e - s);
}

const peak = (b: Float32Array, s = 0, e = b.length): number => {
  let p = 0;
  for (let i = s; i < e; i++) p = Math.max(p, Math.abs(b[i]!));
  return p;
};
const rms = (b: Float32Array, s = 0, e = b.length): number => {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
};

// ─────────────────────────────────────────────────────────────────────────
describe('snaredrum: strike determinism', () => {
  it('two independent states render bit-identical stereo output', () => {
    const a = renderStereo(8192, oneStrike, noGate, P());
    const b = renderStereo(8192, oneStrike, noGate, P());
    expect(a.l).toEqual(b.l);
    expect(a.r).toEqual(b.r);
  });

  it('a hit after full ring-out is identical to hit 1 (wire off → no shared bed carry)', () => {
    // With the continuous bed muted (wire=0), the per-index reseeded voice makes
    // every strike of a re-used pool slot bit-identical (phase reset + reseed).
    const p = P({ wire: 0 });
    const s = makeSnaredrumState();
    const out = new Float32Array(2);
    const hit = (warm: number): Float32Array => {
      for (let i = 0; i < warm; i++) snaredrumStepStereo(0, 0, 0, p, 48000, s, out);
      const buf = new Float32Array(4096);
      for (let i = 0; i < 4096; i++) {
        snaredrumStepStereo(i < 10 ? 1 : 0, 0, 0, p, 48000, s, out);
        buf[i] = out[0]!;
      }
      return buf;
    };
    const first = hit(0);
    const second = hit(48000); // 1 s of silence — full ring-out
    expect(second).toEqual(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snaredrum: frequency law', () => {
  it('places modes at tune·MODE_RATIO[k] (inharmonic Bessel structure)', () => {
    for (let k = 0; k < MODE_RATIO_TEST.length; k++) {
      const fc = snareHeadFreqHz(180, 0, 0, 0, 1, k); // settled (pitchEnv 0), no drop
      expect(fc).toBeCloseTo(180 * MODE_RATIO_TEST[k]!, 4);
    }
  });

  it('pitch_cv is 1 V/oct (doubles at +1 V)', () => {
    expect(snareHeadFreqHz(180, 1, 0, 0, 1, 0)).toBeCloseTo(360, 4);
    expect(snareHeadFreqHz(180, -1, 0, 0, 1, 0)).toBeCloseTo(90, 4);
  });

  it('head pitch-drop starts pitch_amt semis high and settles to base', () => {
    const settled = snareHeadFreqHz(180, 0, 0, 6, 1, 0);
    const struck = snareHeadFreqHz(180, 0, 1, 6, 1, 0);
    expect(settled).toBeCloseTo(180, 4);
    expect(struck / settled).toBeCloseTo(Math.pow(2, 6 / 12), 5); // 6 st high at the strike
  });

  it('per-hand tuneMul detunes the whole voice', () => {
    const detuned = snareHeadFreqHz(180, 0, 0, 0, Math.pow(2, 1 / 12), 0);
    expect(detuned).toBeCloseTo(180 * Math.pow(2, 1 / 12), 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snaredrum: sr-calibrated decay (audit A2)', () => {
  function decayMs(knobMs: number, field: 'head' | 'body' | 'wire', sr: number): number {
    // The env multiplier is the SAME per-sample coeff the core applies; count
    // samples to −60 dB and convert to ms (identical at both rates).
    const coeff = decayCoeff(knobMs, sr);
    let env = 1;
    let t = 0;
    while (env > 1e-3 && t < sr * 5) {
      env *= coeff;
      t++;
    }
    return (t / sr) * 1000;
  }
  it.each([44100, 48000] as const)('head/body/wire cross −60 dB at the knob time at %i Hz', (sr) => {
    for (const ms of [180, 110, 260]) {
      const measured = decayMs(ms, 'head', sr);
      expect(measured).toBeGreaterThan(ms * 0.97);
      expect(measured).toBeLessThan(ms * 1.03);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snaredrum: per-layer isolation (Goertzel)', () => {
  const sr = 48000;

  it('HEAD: inharmonic modal peaks at the Bessel ratios (not a harmonic series)', () => {
    const h = renderStereo(4800, oneStrike, noGate, P({ tone: 1, crack: 0, wire: 0, pitchAmt: 0, damping: 0.1, headDecay: 500, tune: 180 }), sr).l;
    const g = (hz: number) => goertzel(h, sr, hz, 1200, 4800); // settled window
    const m2 = g(180 * 1.593); // 286.7 Hz
    // The (1.593) inharmonic mode is a clear peak vs the off-ratio gaps around
    // it — a HARMONIC drum (tom) would have nothing there.
    expect(m2).toBeGreaterThan(g(330) * 1.5);
    expect(m2).toBeGreaterThan(g(234) * 1.3);
    expect(g(180)).toBeGreaterThan(g(234)); // the fundamental region
  });

  it('BODY: band-limited around the tune fundamental', () => {
    const b = renderStereo(4800, oneStrike, noGate, P({ tone: 0, crack: 0, wire: 0, pitchAmt: 0, tune: 180 }), sr).l;
    const g = (hz: number) => goertzel(b, sr, hz, 0, 4800);
    expect(g(180) / (g(900) + 1e-12)).toBeGreaterThan(4); // energy sits near tune
  });

  it('WIRE: energy concentrates above wire_tone', () => {
    const on = renderStereo(4800, oneStrike, noGate, P({ wire: 1, wireTone: 5000, tone: 1, crack: 0 }), sr).l;
    const off = renderStereo(4800, oneStrike, noGate, P({ wire: 0, tone: 1, crack: 0 }), sr).l;
    // The bright band (above the HP corner) is present with wires, absent without.
    expect(goertzel(on, sr, 6500)).toBeGreaterThan(goertzel(off, sr, 6500) * 20 + 1e-3);
  });

  it('CRACK: the transient is gone within its length', () => {
    const c = renderStereo(4800, oneStrike, noGate, P({ crack: 1, crackTone: 3200, tone: 1, wire: 0, headDecay: 30 }), sr).l;
    const early = goertzel(c, sr, 3200, 0, 480); // 0–10 ms (the crack burst)
    const late = goertzel(c, sr, 3200, 1440, 3840); // 30–80 ms
    expect(early / (late + 1e-9)).toBeGreaterThan(4); // the tick died away
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snaredrum: output invariants', () => {
  const sr = 48000;

  it('TRUE-PEAK: everything maxed + hot + rolling stays ≤ 1.0 on both channels', () => {
    const { l, r } = renderStereo(
      24000,
      oneStrike,
      () => 1,
      P({ wire: 1, drive: 1, hard: 1, ceiling: 1, level: 12, tone: 0.5, crack: 1, spread: 1, width: 1, humanize: 1 }),
      sr,
      1,
    );
    const pk = Math.max(peak(l), peak(r));
    expect(pk).toBeLessThanOrEqual(1.0);
    expect(pk).toBeGreaterThan(0.8); // hot, not vacuous
  });

  it('output DC ≈ 0 (the shared 20 Hz DC block)', () => {
    const { l } = renderStereo(24000, oneStrike, noGate, P({ hard: 1, drive: 0.8 }), sr);
    let mean = 0;
    for (const v of l) mean += v;
    expect(Math.abs(mean / l.length)).toBeLessThan(5e-3);
  });

  it('a second trigger re-energizes a silent voice (no one-shot latch)', () => {
    const p = P();
    const s = makeSnaredrumState();
    const out = new Float32Array(2);
    for (let i = 0; i < 24000; i++) snaredrumStepStereo(i < 10 ? 1 : 0, 0, 0, p, sr, s, out); // hit + ring out
    let pk = 0;
    for (let i = 0; i < 4800; i++) {
      snaredrumStepStereo(i < 10 ? 1 : 0, 0, 0, p, sr, s, out);
      pk = Math.max(pk, Math.abs(out[0]!));
    }
    expect(pk).toBeGreaterThan(0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snaredrum: stereo (mono-safe)', () => {
  const sr = 48000;

  it('width=0 AND spread=0 → L == R EXACTLY (mono-safe fold-down)', () => {
    const { l, r } = renderStereo(8192, oneStrike, () => 1, P({ width: 0, spread: 0 }), sr);
    expect(l).toEqual(r);
  });

  it('width>0 (or spread>0) genuinely decorrelates L and R', () => {
    const { l, r } = renderStereo(8192, oneStrike, () => 1, P({ width: 1, spread: 1 }), sr);
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff = Math.max(diff, Math.abs(l[i]! - r[i]!));
    expect(diff).toBeGreaterThan(1e-3);
  });

  it('mono fold-down (L+R)/2 preserves the centered head/body of a single hit', () => {
    // A trigger hit is centered (pan 0), so its head/body live entirely in MID;
    // only the wire side is decorrelated by width → (L+R)/2 cancels it and
    // preserves the low band vs a width=0 mono render.
    const wide = renderStereo(6000, oneStrike, noGate, P({ width: 1, tone: 0.5 }), sr);
    const mono = renderStereo(6000, oneStrike, noGate, P({ width: 0, tone: 0.5 }), sr);
    const folded = new Float32Array(6000);
    for (let i = 0; i < 6000; i++) folded[i] = 0.5 * (wide.l[i]! + wide.r[i]!);
    const ratio = goertzel(folded, sr, 180, 0, 6000) / (goertzel(mono.l, sr, 180, 0, 6000) + 1e-12);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it('stereo render is strike-deterministic', () => {
    const a = renderStereo(8192, oneStrike, () => 1, P({ width: 0.7, spread: 0.7 }), sr);
    const b = renderStereo(8192, oneStrike, () => 1, P({ width: 0.7, spread: 0.7 }), sr);
    expect(a.l).toEqual(b.l);
    expect(a.r).toEqual(b.r);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STEREO PLACEMENT — the sizzle must land on the side of the hand that struck
// it (#1293). The voices placed themselves with a NEGATED constant-power side
// term while the shared wire bed ADDED its placement term, so a left-hand
// stroke threw its sizzle RIGHT. Nothing in the suite could see it: each half
// of a stroke was internally consistent, and every existing stereo assertion
// (mono-safety, "L and R differ", side-ENERGY sensitivity) is blind to WHICH
// side the energy is on.
//
// The instrument is a BAND-SPLIT balance — the wire bed is HF sizzle (HP'd at
// `wire_tone`), the voice body/head is LF — because broadband RMS cannot
// separate the two components that disagreed. It carries a PERMANENT negative
// control: with the bed switched off (`wire=0`) the same HF metric must still
// read the hand, which is what proves it is measuring placement and not merely
// reporting whichever component happens to dominate.
describe('snaredrum: stereo PLACEMENT — the sizzle follows the hand (#1293)', () => {
  const sr = 48000;

  /** Cascaded RBJ pair = 4th-order band split. Pure measurement, not under test. */
  const cascade = (buf: Float32Array, tune: (bq: Biquad) => void): Float32Array => {
    const a = makeBiquad();
    const b = makeBiquad();
    tune(a);
    tune(b);
    const o = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) o[i] = biquadStep(b, biquadStep(a, buf[i]!));
    return o;
  };
  const hf = (buf: Float32Array) => cascade(buf, (bq) => updateHighpass(bq, 4000, sr));
  const lf = (buf: Float32Array) => cascade(buf, (bq) => updateLowpass(bq, 800, sr));

  const bandEnergy = (b: Float32Array, s: number, e: number): number => {
    let x = 0;
    for (let i = s; i < Math.min(e, b.length); i++) x += b[i]! * b[i]!;
    return x;
  };
  /** (E_L − E_R) / (E_L + E_R) ∈ [−1, 1]. POSITIVE ⇒ the energy is on the LEFT. */
  const balance = (fl: Float32Array, fr: Float32Array, s: number, e: number): number => {
    const el = bandEnergy(fl, s, e);
    const er = bandEnergy(fr, s, e);
    return (el - er) / Math.max(1e-30, el + er);
  };

  /**
   * Roll one second of hard-spread two-hand sticking and return the mean HF
   * (sizzle) and LF (voice) L/R balance of the strokes each hand fired.
   *
   * `width=0` removes the decorrelation side term, so the ONLY side content the
   * bed contributes is its placement; `crack=0` removes the HF stick transient,
   * so the HF band is the wire bed; `humanize=0`/`bounce=0`/`rollSpeed=0` give
   * clean single strokes 125 ms apart. Strokes are located from `bedPanTarget`,
   * which the engine sets to the firing hand's pan — the same quantity the
   * placement is supposed to follow.
   */
  function handBalances(wire: number) {
    const p = P({
      spread: 1,
      humanize: 0,
      bounce: 0,
      rollSpeed: 0,
      width: 0,
      drive: 0,
      ceiling: 0,
      level: -12,
      crack: 0,
      wire,
    });
    const n = Math.round(1.2 * sr);
    const st = makeSnaredrumState();
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const out = new Float32Array(2);
    const strokes: { at: number; pan: number }[] = [];
    let prev = 0;
    for (let i = 0; i < n; i++) {
      snaredrumStepStereo(0, 1, 0, p, sr, st, out);
      l[i] = out[0]!;
      r[i] = out[1]!;
      if (st.bedPanTarget !== prev) {
        strokes.push({ at: i, pan: st.bedPanTarget });
        prev = st.bedPanTarget;
      }
    }
    const hfL = hf(l);
    const hfR = hf(r);
    const lfL = lf(l);
    const lfR = lf(r);
    const win = Math.round(0.08 * sr);
    const skip = Math.round(0.02 * sr); // let the 5 ms bed-pan slew settle
    const left = { hf: [] as number[], lf: [] as number[] };
    const right = { hf: [] as number[], lf: [] as number[] };
    for (const s of strokes) {
      if (s.at < 0.2 * sr || s.pan === 0) continue; // settle; skip centred
      const acc = s.pan < 0 ? left : right;
      acc.hf.push(balance(hfL, hfR, s.at + skip, s.at + skip + win));
      acc.lf.push(balance(lfL, lfR, s.at + skip, s.at + skip + win));
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    return {
      count: { left: left.hf.length, right: right.hf.length },
      leftHandHf: mean(left.hf),
      leftHandLf: mean(left.lf),
      rightHandHf: mean(right.hf),
      rightHandLf: mean(right.lf),
    };
  }

  it('the pan helpers are ONE sign convention: pan=+1 is hard RIGHT, pan=0 is EXACTLY centred', () => {
    // L = mid + side, R = mid − side ⇒ a RIGHT pan needs a NEGATIVE side.
    expect(panSideGain(1)).toBeLessThan(0);
    expect(panSideGain(-1)).toBeGreaterThan(0);
    // Exactly 0 at centre — the mono-safe fold-down depends on it (no 1 ULP leak).
    expect(Math.abs(panSideGain(0))).toBe(0);
    expect(panMidGain(0)).toBe(Math.SQRT2);
    // Constant power: mid² + side² = 2 across the range.
    for (const pan of [-1, -0.5, -0.13, 0, 0.37, 0.5, 1]) {
      expect(panMidGain(pan) ** 2 + panSideGain(pan) ** 2).toBeCloseTo(2, 12);
    }
    // Hard pans fully null the opposite channel (mid ± side → 0).
    expect(panMidGain(1) + panSideGain(1)).toBeCloseTo(0, 12);
    expect(panMidGain(-1) - panSideGain(-1)).toBeCloseTo(0, 12);
  });

  it('NEGATIVE CONTROL: with the wire bed OFF, the HF metric already tracks the hand', () => {
    // If this leg ever passes vacuously the subject test below proves nothing —
    // it is what rules out "the HF band just reports whatever is loudest".
    const b = handBalances(0);
    expect(b.count.left).toBeGreaterThanOrEqual(3);
    expect(b.count.right).toBeGreaterThanOrEqual(3);
    expect(b.leftHandHf).toBeGreaterThan(0.5); // left hand → HF energy LEFT
    expect(b.rightHandHf).toBeLessThan(-0.5); // right hand → HF energy RIGHT
  });

  it('the wire-bed SIZZLE lands on the SAME side as the voice that struck it', () => {
    const b = handBalances(1);
    expect(b.count.left).toBeGreaterThanOrEqual(3);
    expect(b.count.right).toBeGreaterThanOrEqual(3);
    // LEFT hand: both bands positive ⇒ both on the LEFT.
    expect(b.leftHandLf).toBeGreaterThan(0.5);
    expect(b.leftHandHf).toBeGreaterThan(0.5);
    // RIGHT hand: both bands negative ⇒ both on the RIGHT.
    expect(b.rightHandLf).toBeLessThan(-0.5);
    expect(b.rightHandHf).toBeLessThan(-0.5);
    // …and stated as the property itself: sizzle and body share a side.
    expect(Math.sign(b.leftHandHf)).toBe(Math.sign(b.leftHandLf));
    expect(Math.sign(b.rightHandHf)).toBe(Math.sign(b.rightHandLf));
  });

  it('SOURCE GUARD: the pan sign is typed in exactly ONE place', () => {
    // No runtime gate can see a SECOND hand-typed cos/sin pan pair — that is
    // precisely how #1293 hid. Both √2 constants must live inside the shared
    // helpers; a new placement site must call them, not re-derive them.
    const src = readFileSync(new URL('./snaredrum-dsp.ts', import.meta.url), 'utf8');
    const helperStart = src.indexOf('export function panMidGain');
    const helperEnd = src.indexOf('\n}', src.indexOf('export function panSideGain'));
    expect(helperStart).toBeGreaterThan(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const offsets: number[] = [];
    for (let i = src.indexOf('Math.SQRT2'); i !== -1; i = src.indexOf('Math.SQRT2', i + 1)) {
      offsets.push(i);
    }
    expect(offsets.length).toBe(2); // one in panMidGain, one in panSideGain
    for (const off of offsets) {
      expect(off).toBeGreaterThan(helperStart);
      expect(off).toBeLessThan(helperEnd);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('snaredrum: drumroll continuity (the load-bearing property)', () => {
  const sr = 48000;

  it('a sustained gate rolls CONTINUOUSLY — RMS never gaps to silence', () => {
    // Hold the gate high for 1 s; the two-hand engine + shared bed must keep the
    // snare re-excited so EVERY ~20 ms window carries energy (no pulsed gaps).
    const { l, r } = renderStereo(sr, noGate, () => 1, P({ wire: 0.8 }), sr);
    const win = Math.round(0.02 * sr);
    let minRms = Infinity;
    for (let w = Math.round(0.2 * sr); w + win < sr; w += win) {
      minRms = Math.min(minRms, rms(l, w, w + win));
    }
    expect(minRms).toBeGreaterThan(0.02); // continuous, never a silent gap
    // …and it is a genuine STEREO roll (the two hands decorrelate L/R).
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff = Math.max(diff, Math.abs(l[i]! - r[i]!));
    expect(diff).toBeGreaterThan(1e-3);
  });

  it('ROLL SPEED raises the stroke density (faster roll = more strokes)', () => {
    // Count output-envelope onset peaks: a faster roll packs more of them in.
    const onsets = (b: Float32Array): number => {
      const win = 64;
      let prev = 0;
      let count = 0;
      for (let i = win; i < b.length; i += win) {
        const e = rms(b, i - win, i);
        if (e > 0.08 && e > prev * 1.3) count++;
        prev = e;
      }
      return count;
    };
    const slow = renderStereo(sr, noGate, () => 1, P({ rollSpeed: 0.1, bounce: 0, humanize: 0, wire: 0.3 }), sr).l;
    const fast = renderStereo(sr, noGate, () => 1, P({ rollSpeed: 0.9, bounce: 0, humanize: 0, wire: 0.3 }), sr).l;
    expect(onsets(fast)).toBeGreaterThan(onsets(slow) * 1.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PARAM SENSITIVITY — the real guard against a knob going DEAD.
//
// For every user-facing knob, render its MIN vs MAX (single TRIGGER for hit
// params; a held GATE for roll params) over the pure core and assert a MINIMUM
// normalized audible-feature delta (rel-RMS / a cheap hi/lo centroid proxy /
// stereo side-energy). Any future edit that lets a param stop moving the sound
// drops its delta toward 0 and FAILS CI. Thresholds sit BELOW each fixed param's
// measured post-fix delta but ABOVE noise. This is what un-deadens crack /
// crack_tone / head_decay / tone / body_decay / pitch_amt / pitch_time / spread.
// (adversarial review §5)
describe('snaredrum: param sensitivity (a dead param FAILS CI)', () => {
  const SR = 48000;

  // Render `secs` seconds: single rising trigger edge for hit params; a held
  // gate for roll params.
  function render(overrides: Partial<SnaredrumParams>, mode: 'hit' | 'roll', secs = 2) {
    const s = makeSnaredrumState();
    const p = P(overrides);
    const n = Math.floor(SR * secs);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    const out = new Float32Array(2);
    for (let i = 0; i < n; i++) {
      const trig = mode === 'hit' ? (i === 0 ? 1 : 0) : 0; // one rising edge
      const gate = mode === 'roll' ? 1 : 0; // held for the roll
      snaredrumStepStereo(trig, gate, 0, p, SR, s, out);
      L[i] = out[0]!;
      R[i] = out[1]!;
    }
    return { L, R };
  }

  // Cheap, deterministic, FFT-free features. Each is measured over the FULL
  // buffer AND over an ATTACK window (0–25 ms: transient/attack params like
  // crack, crack_tone, pitch_time) AND a DECAY-TAIL window (50–350 ms: length
  // params like body_decay) — so whatever a knob actually moves surfaces in at
  // least one view and a dead knob (delta≈0 everywhere) fails the gate.
  const rmsWin = (x: Float32Array, s: number, e: number): number => {
    let a = 0;
    const hi = Math.min(e, x.length);
    for (let i = s; i < hi; i++) a += x[i]! * x[i]!;
    return Math.sqrt(a / Math.max(1, hi - s));
  };
  const centroidWin = (x: Float32Array, s: number, e: number): number => {
    // 1-pole hi/lo energy ratio — a monotone spectral-centroid stand-in.
    let lo = 0;
    let hi = 0;
    let prev = s > 0 ? x[s - 1]! : 0;
    const end = Math.min(e, x.length);
    for (let i = s; i < end; i++) {
      const h = x[i]! - prev;
      prev = x[i]!;
      hi += h * h;
      lo += x[i]! * x[i]!;
    }
    return hi / (lo + 1e-12);
  };
  const sideEnergy = (l: Float32Array, r: Float32Array): number => {
    let s = 0;
    for (let i = 0; i < l.length; i++) {
      const d = (l[i]! - r[i]!) * 0.5;
      s += d * d;
    }
    return Math.sqrt(s / l.length);
  };
  const rel = (x: number, y: number): number => Math.abs(x - y) / (Math.max(Math.abs(x), Math.abs(y)) + 1e-9);
  const featDelta = (
    a: { L: Float32Array; R: Float32Array },
    b: { L: Float32Array; R: Float32Array },
  ): number => {
    const n = a.L.length;
    const atk = Math.floor(0.025 * SR); // 0..25 ms — attack / transient
    const t0 = Math.floor(0.05 * SR);
    const t1 = Math.floor(0.35 * SR); // 50..350 ms — decay tail
    return Math.max(
      rel(rmsWin(a.L, 0, n), rmsWin(b.L, 0, n)),
      rel(centroidWin(a.L, 0, n), centroidWin(b.L, 0, n)),
      rel(sideEnergy(a.L, a.R), sideEnergy(b.L, b.R)),
      rel(rmsWin(a.L, 0, atk), rmsWin(b.L, 0, atk)),
      rel(centroidWin(a.L, 0, atk), centroidWin(b.L, 0, atk)),
      rel(rmsWin(a.L, t0, t1), rmsWin(b.L, t0, t1)),
    );
  };

  // [id, min, max, mode, minDelta, ctx?] — the min normalized feature delta the
  // knob must clear. `ctx` is an optional patch context: two knobs (pitch_time,
  // crack_tone) only shape a sound the DEFAULT patch keeps small (a shallow pit /
  // a soft tick), so they're guarded in the context they actually operate in (a
  // deep pitch drop / a loud crack) — the guard then asserts their real audible
  // FUNCTION, not a wire-masked nudge. Thresholds sit BELOW each param's measured
  // post-fix delta and WELL ABOVE the ~0 a dead knob produces (a dead knob makes
  // min≡max → delta 0), so any param going dead trips the gate. All renders are
  // deterministic, so these are exact, flake-free numbers.
  const CASES: Array<
    [keyof SnaredrumParams, number, number, 'hit' | 'roll', number, Partial<SnaredrumParams>?]
  > = [
    ['tune', 90, 400, 'hit', 0.05],
    ['tone', 0, 1, 'hit', 0.08],
    ['damping', 0, 1, 'hit', 0.08],
    ['headDecay', 30, 600, 'hit', 0.08],
    ['bodyDecay', 20, 300, 'hit', 0.04],
    ['pitchAmt', 0, 12, 'hit', 0.05],
    ['pitchTime', 3, 80, 'hit', 0.05, { pitchAmt: 12 }], // guard the pit's settle at full depth
    ['wire', 0, 1, 'hit', 0.2],
    ['wireTone', 1500, 9000, 'hit', 0.08],
    ['wireDecay', 40, 700, 'hit', 0.2],
    ['crack', 0, 1, 'hit', 0.05],
    ['crackTone', 800, 7000, 'hit', 0.03, { crack: 1 }], // guard the tick's tone at full level
    ['damp', 0, 1, 'hit', 0.1],
    ['rollSpeed', 0, 1, 'roll', 0.1],
    ['bounce', 0, 1, 'roll', 0.08],
    ['humanize', 0, 1, 'roll', 0.025],
    ['spread', 0, 1, 'roll', 0.06], // guards the WEAK-5 wire-bed pan fix
    ['drive', 0, 1, 'hit', 0.15],
    ['ceiling', 0, 1, 'hit', 0.1],
    ['width', 0, 1, 'hit', 0.1],
    ['level', -24, 12, 'hit', 0.3],
  ];

  for (const [id, lo, hi, mode, minDelta, ctx] of CASES) {
    it(`${id} moves the sound from min→max (${mode})`, () => {
      const a = render({ ...ctx, [id]: lo } as Partial<SnaredrumParams>, mode);
      const b = render({ ...ctx, [id]: hi } as Partial<SnaredrumParams>, mode);
      // Determinism: the same overrides render byte-identically (seeded core).
      expect(render({ ...ctx, [id]: lo } as Partial<SnaredrumParams>, mode).L).toEqual(a.L);
      expect(featDelta(a, b)).toBeGreaterThan(minDelta);
    });
  }

  // `hard` is EXCLUDED from the min-delta sweep (it is a character switch that is
  // a no-op at drive=0 by design — asserting it there would encode the
  // combination-dead behavior). Guard it with drive UP instead.
  it('hard toggles the character when drive is up (0.5)', () => {
    const soft = render({ drive: 0.5, hard: 0 }, 'hit');
    const harsh = render({ drive: 0.5, hard: 1 }, 'hit');
    expect(featDelta(soft, harsh)).toBeGreaterThan(0.05);
  });
});
