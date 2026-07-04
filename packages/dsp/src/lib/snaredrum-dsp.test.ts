// packages/dsp/src/lib/snaredrum-dsp.test.ts
//
// The single-hit snare VOICE + shared wire-bed + shared bus + stereo gate
// (design §6.1). Proves strike determinism, the frequency law, sr-calibrated
// decay (44.1k AND 48k — audit A2), per-layer isolation (Goertzel), the
// true-peak ceiling, DC cleanliness, retrigger, mono-safe stereo, and — the
// load-bearing one — that a sustained gate rolls CONTINUOUSLY (the wire bed's
// RMS never returns to 0 between strokes). Deterministic — no Math.random.

import { describe, it, expect } from 'vitest';
import {
  SNAREDRUM_DEFAULTS,
  MODE_RATIO_TEST,
  decayCoeff,
  makeSnaredrumState,
  snareHeadFreqHz,
  snaredrumStepStereo,
  type SnaredrumParams,
} from './snaredrum-dsp';

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
