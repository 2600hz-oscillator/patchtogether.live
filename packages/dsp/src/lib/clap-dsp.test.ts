// packages/dsp/src/lib/clap-dsp.test.ts
//
// Proving tests for the CLAP core: strike determinism, the control laws
// (tone/tail/spread CV octave laws with clamps, pulse-count latch), the
// burst scheduler (PULSES onsets, SPREAD timing, held-trigger fires once),
// and the SONIC-RANGE proofs the drum-voice family review bar demands —
// every knob rendered at min/mid/max with a meaningful objective delta:
//
//   PULSES — onset COUNT (windowed-RMS re-arm detector) equals the knob.
//   SPREAD — burst duration stretches >4× min→max; onsets land on the grid.
//   TONE   — spectral centroid tracks the band center, >2.5× spread.
//   WIDTH  — center-vs-skirt contrast: ringy narrow >> broad splash.
//   TAIL   — ring duration (−60 dB) spreads >4× min→max with anchors.
//   COLOR  — spectral centroid falls white → dark (>1.4×), monotonic.
//   SNAP   — early/late energy balance flips burst-dominant ↔ room-only.
//   DRIVE  — crest factor compresses AND rms rises (soft-clip heat).
//   ACCENT — hotter hit AND disproportionately bigger room tail.
//
// Plus hygiene: bit-identical re-render, re-strike reproducibility, DC
// cleanliness, true-peak bound, silence before the first strike.

import { describe, it, expect } from 'vitest';
import {
  CLAP_DEFAULTS,
  clapColorFc,
  clapPulseCount,
  clapSpreadMs,
  clapStep,
  clapTailMs,
  clapToneHz,
  clapWidthQ,
  decayCoeff,
  makeClapState,
  type ClapParams,
} from './clap-dsp';

const SR = 48000;

const P = (over: Partial<ClapParams> = {}): ClapParams => ({
  ...CLAP_DEFAULTS,
  ...over,
});

/** Render n samples; the trigger fires high for the first 10 samples. */
function render(
  n: number,
  p: ClapParams,
  sr: number,
  opts: { accent?: number; state?: ReturnType<typeof makeClapState> } = {},
): Float32Array {
  const s = opts.state ?? makeClapState();
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    out[t] = clapStep(t < 10 ? 1 : 0, opts.accent ?? 0, p, sr, s);
  }
  return out;
}

function peakOf(b: Float32Array, s = 0, e = b.length): number {
  let p = 0;
  for (let i = s; i < e; i++) p = Math.max(p, Math.abs(b[i]!));
  return p;
}

function rmsOf(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

function energyOf(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return x;
}

/** Hann-windowed Goertzel power at `hz` over [s, e). */
function goertzel(buf: Float32Array, sr: number, hz: number, s = 0, e = buf.length): number {
  const n = e - s;
  const omega = (2 * Math.PI * hz) / sr;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const q0 = coeff * q1 - q2 + buf[s + i]! * win;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

/** Ring duration (ms): last 10 ms window whose peak clears globalPeak/1000. */
function ringMs(buf: Float32Array, sr: number): number {
  const peak = peakOf(buf);
  const th = Math.max(peak / 1000, 1e-6);
  const w = Math.max(1, Math.round((sr * 10) / 1000));
  let lastEnd = 0;
  for (let start = 0; start < buf.length; start += w) {
    const end = Math.min(buf.length, start + w);
    if (peakOf(buf, start, end) > th) lastEnd = end;
  }
  return (lastEnd / sr) * 1000;
}

/** Time (ms) at which cumulative energy crosses 99 % of the total — a
 *  window-free duration measure (finer than ringMs's 10 ms grid). */
function t99Ms(buf: Float32Array, sr: number): number {
  const total = energyOf(buf);
  if (total <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < buf.length; i++) {
    acc += buf[i]! * buf[i]!;
    if (acc >= 0.99 * total) return (i / sr) * 1000;
  }
  return (buf.length / sr) * 1000;
}

/** Spectral centroid (Hz) as the RMS frequency ("spectral gravity") —
 *  bin-free and robust for a noise voice (the tomtom-dsp.test estimator). */
function centroidHz(buf: Float32Array, sr: number, s: number, e: number): number {
  let dd = 0;
  let xx = 0;
  for (let i = s + 1; i < e; i++) {
    const d = buf[i]! - buf[i - 1]!;
    dd += d * d;
    xx += buf[i]! * buf[i]!;
  }
  if (xx <= 0) return 0;
  return (sr / (2 * Math.PI)) * 2 * Math.asin(Math.min(1, 0.5 * Math.sqrt(dd / xx)));
}

/**
 * Burst-onset detector: 1 ms-hop windowed RMS with a re-arm state machine
 * (fire above 0.3× the max window rms, re-arm below 0.05×). The burst
 * envelope's −60 dB-per-spacing troughs make the onsets unambiguous at
 * spacings ≥ ~8 ms. Returns onset times in ms.
 */
function detectOnsets(buf: Float32Array, sr: number, uptoMs: number): number[] {
  const hop = Math.round(sr / 1000); // 1 ms
  const nWin = Math.min(Math.floor(buf.length / hop), Math.round(uptoMs));
  const rms: number[] = [];
  for (let w = 0; w < nWin; w++) rms.push(rmsOf(buf, w * hop, (w + 1) * hop));
  const maxRms = Math.max(...rms);
  const hi = 0.3 * maxRms;
  const lo = 0.05 * maxRms;
  const onsets: number[] = [];
  let armed = true;
  for (let w = 0; w < nWin; w++) {
    const v = rms[w]!;
    if (armed && v > hi) {
      onsets.push(w);
      armed = false;
    } else if (!armed && v < lo) {
      armed = true;
    }
  }
  return onsets;
}

// ─────────────────────────────────────────────────────────────────────────
// Control LAWS (pure functions)
// ─────────────────────────────────────────────────────────────────────────

describe('clap: control laws', () => {
  it('tone_cv is ±1.5 oct/V — ±1 V covers the whole 400–3000 knob range from 1 kHz', () => {
    expect(clapToneHz(1000, 0)).toBeCloseTo(1000, 6);
    expect(clapToneHz(1000, 1)).toBeCloseTo(1000 * Math.pow(2, 1.5), 4);
    expect(clapToneHz(1000, -1)).toBeCloseTo(1000 / Math.pow(2, 1.5), 4);
    // clamps: knob range + the 200/4200 Hz absolute rails
    expect(clapToneHz(9999, 0)).toBeCloseTo(3000, 6);
    expect(clapToneHz(3000, 2)).toBeCloseTo(4200, 6);
    expect(clapToneHz(400, -2)).toBeCloseTo(200, 6);
  });

  it('tail_cv is 2 oct of tail TIME per volt, clamped', () => {
    expect(clapTailMs(150, 0)).toBeCloseTo(150, 6);
    expect(clapTailMs(150, 1)).toBeCloseTo(600, 6);
    expect(clapTailMs(150, -1)).toBeCloseTo(37.5, 6);
    expect(clapTailMs(800, 2)).toBeCloseTo(1600, 6);
    expect(clapTailMs(30, -2)).toBeCloseTo(15, 6);
  });

  it('spread_cv is ±1.3 oct/V — ±1 V covers the whole 4–25 ms knob range from 10 ms', () => {
    expect(clapSpreadMs(10, 0)).toBeCloseTo(10, 6);
    expect(clapSpreadMs(10, 1)).toBeCloseTo(10 * Math.pow(2, 1.3), 4);
    expect(clapSpreadMs(10, -1)).toBeCloseTo(10 / Math.pow(2, 1.3), 4);
    expect(clapSpreadMs(25, 2)).toBeCloseTo(50, 6);
    expect(clapSpreadMs(4, -2)).toBeCloseTo(2, 6);
  });

  it('pulse count latches as an integer 2..5', () => {
    expect(clapPulseCount(3)).toBe(3);
    expect(clapPulseCount(3.4)).toBe(3);
    expect(clapPulseCount(4.6)).toBe(5);
    expect(clapPulseCount(0)).toBe(2);
    expect(clapPulseCount(99)).toBe(5);
  });

  it('width→q and color→fc maps cover their stated ranges', () => {
    expect(clapWidthQ(0)).toBeCloseTo(0.18, 6);
    expect(clapWidthQ(1)).toBeCloseTo(1.6, 6);
    expect(clapColorFc(0)).toBeCloseTo(9000, 3);
    expect(clapColorFc(1)).toBeCloseTo(700, 3);
    // log sweep: the midpoint is the geometric mean
    expect(clapColorFc(0.5)).toBeCloseTo(Math.sqrt(9000 * 700), 3);
  });

  it('decayCoeff hits −60 dB at the stated ms', () => {
    const c = decayCoeff(100, SR);
    let env = 1;
    const n = Math.round((100 / 1000) * SR);
    for (let i = 0; i < n; i++) env *= c;
    expect(env).toBeCloseTo(1e-3, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Burst scheduler (the clap's heart)
// ─────────────────────────────────────────────────────────────────────────

describe('clap: burst scheduler', () => {
  it('PULSES: onset count equals the knob (2 and 5 at 20 ms spacing)', () => {
    const base = { spread: 20, snap: 1, drive: 0, tail: 100 };
    const two = detectOnsets(render(Math.round(0.3 * SR), P({ ...base, pulses: 2 }), SR), SR, 150);
    const five = detectOnsets(render(Math.round(0.3 * SR), P({ ...base, pulses: 5 }), SR), SR, 150);
    expect(two.length).toBe(2);
    expect(five.length).toBe(5);
  });

  it('SPREAD: onsets land on the latched grid (±2 ms at 20 ms spacing)', () => {
    const buf = render(Math.round(0.3 * SR), P({ pulses: 4, spread: 20, snap: 1, drive: 0 }), SR);
    const onsets = detectOnsets(buf, SR, 150);
    expect(onsets.length).toBe(4);
    for (let k = 0; k < 4; k++) {
      expect(Math.abs(onsets[k]! - k * 20)).toBeLessThanOrEqual(2);
    }
  });

  it('SPREAD sonic range: burst duration stretches >4× min→max (t99)', () => {
    const base = { pulses: 5, snap: 1, drive: 0 };
    const tight = render(Math.round(0.5 * SR), P({ ...base, spread: 4 }), SR);
    const wide = render(Math.round(0.5 * SR), P({ ...base, spread: 25 }), SR);
    const tTight = t99Ms(tight, SR);
    const tWide = t99Ms(wide, SR);
    expect(tWide).toBeGreaterThan(4 * tTight);
    // Anchors: 5 pulses at 25 ms span 100 ms of grid; at 4 ms the whole
    // burst (incl. the 2× final discharge) is done inside ~30 ms.
    expect(tWide).toBeGreaterThan(90);
    expect(tTight).toBeLessThan(35);
  });

  it('spread_cv latches at the strike edge: +1 V stretches the rendered grid', () => {
    const base = { pulses: 3, spread: 10, snap: 1, drive: 0 };
    const flat = detectOnsets(render(Math.round(0.3 * SR), P(base), SR), SR, 150);
    const wideCv = detectOnsets(
      render(Math.round(0.3 * SR), P({ ...base, spreadCv: 1 }), SR),
      SR,
      150,
    );
    expect(flat.length).toBe(3);
    expect(wideCv.length).toBe(3);
    // 10 ms → 24.6 ms spacing: the last onset moves from ~20 ms to ~49 ms.
    expect(wideCv[2]!).toBeGreaterThan(flat[2]! * 2);
  });

  it('held-high trigger fires ONE burst (edge, not level)', () => {
    const p = P({ pulses: 3, spread: 10, tail: 60, snap: 0.5, drive: 0 });
    const s = makeClapState();
    const n = Math.round(0.5 * SR);
    const buf = new Float32Array(n);
    for (let t = 0; t < n; t++) buf[t] = clapStep(1, 0, p, SR, s);
    // Burst + tail are done by ~150 ms; a re-fire while held would put
    // fresh attack energy late in the hold.
    const early = peakOf(buf, 0, Math.round(0.1 * SR));
    const late = peakOf(buf, Math.round(0.35 * SR), n);
    expect(early).toBeGreaterThan(0.1);
    expect(late).toBeLessThan(early / 100);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SONIC RANGE — spectrum + balance knobs
// ─────────────────────────────────────────────────────────────────────────

describe('clap: sonic range proofs (spectrum + balance)', () => {
  it('TONE: centroid tracks the band center — monotonic, >2.5× min→max', () => {
    // Tail-only render (snap 0, long tail) = a sustained noise band to
    // measure; color 0 so the source is flat.
    const base = { snap: 0, tail: 400, color: 0, width: 0.3, drive: 0 };
    const w = Math.round(0.25 * SR);
    const lo = centroidHz(render(w, P({ ...base, tone: 400 }), SR), SR, 0, w);
    const mid = centroidHz(render(w, P({ ...base, tone: 1100 }), SR), SR, 0, w);
    const hi = centroidHz(render(w, P({ ...base, tone: 3000 }), SR), SR, 0, w);
    expect(mid).toBeGreaterThan(lo * 1.3);
    expect(hi).toBeGreaterThan(mid * 1.3);
    expect(hi).toBeGreaterThan(2.5 * lo);
    // The centroid lands near the dialed center (tail pole pulls it a
    // little under; ±40 % window).
    expect(lo).toBeGreaterThan(400 * 0.6);
    expect(lo).toBeLessThan(400 * 1.4);
    expect(hi).toBeGreaterThan(3000 * 0.6);
  });

  it('tone_cv sweeps the rendered spectrum (±1 V ≈ the knob rails)', () => {
    const base = { snap: 0, tail: 400, color: 0, width: 0.3, drive: 0, tone: 1000 };
    const w = Math.round(0.25 * SR);
    const down = centroidHz(render(w, P({ ...base, toneCv: -1 }), SR), SR, 0, w);
    const up = centroidHz(render(w, P({ ...base, toneCv: 1 }), SR), SR, 0, w);
    expect(up).toBeGreaterThan(2.2 * down);
  });

  it('WIDTH: center-vs-skirt contrast collapses ringy → broad (>4× ratio drop)', () => {
    const base = { tone: 1000, color: 0, snap: 1, pulses: 3, spread: 10, drive: 0 };
    const w = Math.round(0.12 * SR);
    const contrast = (buf: Float32Array): number => {
      const center = goertzel(buf, SR, 900, 0, w) + goertzel(buf, SR, 1000, 0, w) + goertzel(buf, SR, 1100, 0, w);
      const skirt =
        goertzel(buf, SR, 250, 0, w) +
        goertzel(buf, SR, 320, 0, w) +
        goertzel(buf, SR, 3200, 0, w) +
        goertzel(buf, SR, 3800, 0, w);
      return center / Math.max(skirt, 1e-12);
    };
    const narrow = contrast(render(w, P({ ...base, width: 0 }), SR));
    const broad = contrast(render(w, P({ ...base, width: 1 }), SR));
    expect(narrow).toBeGreaterThan(4 * broad);
    // Loudness compensation: both extremes stay audible + bounded.
    const pN = peakOf(render(Math.round(0.2 * SR), P({ ...base, width: 0 }), SR));
    const pB = peakOf(render(Math.round(0.2 * SR), P({ ...base, width: 1 }), SR));
    expect(pN).toBeGreaterThan(0.15);
    expect(pB).toBeGreaterThan(0.15);
    expect(pN).toBeLessThan(1);
    expect(pB).toBeLessThan(1);
  });

  it('COLOR: centroid falls white → dark (>1.4×), monotonic through mid', () => {
    const base = { snap: 0, tail: 400, tone: 1500, width: 1, drive: 0 };
    const w = Math.round(0.25 * SR);
    const white = centroidHz(render(w, P({ ...base, color: 0 }), SR), SR, 0, w);
    const mid = centroidHz(render(w, P({ ...base, color: 0.5 }), SR), SR, 0, w);
    const dark = centroidHz(render(w, P({ ...base, color: 1 }), SR), SR, 0, w);
    expect(white).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(dark);
    expect(white).toBeGreaterThan(1.4 * dark);
  });

  it('TAIL: ring duration spreads >4× min→max with anchors', () => {
    const base = { snap: 0, drive: 0 };
    const short = render(Math.round(1.5 * SR), P({ ...base, tail: 30 }), SR);
    const long = render(Math.round(1.5 * SR), P({ ...base, tail: 800 }), SR);
    const rShort = ringMs(short, SR);
    const rLong = ringMs(long, SR);
    expect(rLong).toBeGreaterThan(4 * rShort);
    expect(rLong).toBeGreaterThan(500); // a real room bloom
    expect(rShort).toBeLessThan(150); // tight and dry
  });

  it('tail_cv stretches the rendered ring (+1 V ≈ ×4 time)', () => {
    const base = { snap: 0, drive: 0, tail: 150 };
    const flat = ringMs(render(Math.round(1.5 * SR), P(base), SR), SR);
    const long = ringMs(render(Math.round(1.5 * SR), P({ ...base, tailCv: 1 }), SR), SR);
    expect(long).toBeGreaterThan(2 * flat);
  });

  it('SNAP: early/late balance flips burst-dominant ↔ room-only', () => {
    // Burst is over by ~45 ms (3 pulses @10 ms + 2× final discharge);
    // the room tail carries 100 ms+.
    const base = { pulses: 3, spread: 10, tail: 300, drive: 0 };
    const n = Math.round(0.6 * SR);
    const split = Math.round(0.06 * SR);
    const lateFrac = (buf: Float32Array): number => {
      const early = energyOf(buf, 0, split);
      const late = energyOf(buf, split, n);
      return late / Math.max(early + late, 1e-12);
    };
    const bufDry = render(n, P({ ...base, snap: 1 }), SR); // burst only
    const bufMixed = render(n, P({ ...base, snap: 0.5 }), SR);
    const bufRoom = render(n, P({ ...base, snap: 0 }), SR); // tail only
    const dry = lateFrac(bufDry);
    const mixed = lateFrac(bufMixed);
    const room = lateFrac(bufRoom);
    // An exponential T60=300 ms tail front-loads its energy, so "room
    // dominates" reads as ~0.15-0.25 late fraction — the discriminating
    // claim is the ORDERING plus the ring-out floor below.
    expect(dry).toBeLessThan(0.02); // no room at all
    expect(room).toBeGreaterThan(0.1);
    expect(mixed).toBeGreaterThan(dry);
    expect(room).toBeGreaterThan(mixed);
    // The real audible flip: past 150 ms the room voice still rings while
    // the dry burst is stone dead.
    const lateStart = Math.round(0.15 * SR);
    expect(energyOf(bufRoom, lateStart, n)).toBeGreaterThan(
      100 * Math.max(energyOf(bufDry, lateStart, n), 1e-12),
    );
  });

  it('DRIVE: crest factor compresses AND rms rises (soft-clip heat)', () => {
    const base = { pulses: 3, spread: 10, tail: 200, snap: 0.5 };
    const w = Math.round(0.25 * SR);
    const clean = render(w, P({ ...base, drive: 0 }), SR);
    const hot = render(w, P({ ...base, drive: 1 }), SR);
    const crest = (b: Float32Array) => peakOf(b) / Math.max(rmsOf(b), 1e-9);
    expect(crest(clean)).toBeGreaterThan(crest(hot) * 1.15);
    expect(rmsOf(hot)).toBeGreaterThan(rmsOf(clean) * 1.3);
    expect(peakOf(hot)).toBeLessThan(1);
  });

  it('ACCENT: hotter hit AND disproportionately bigger room tail', () => {
    const p = { pulses: 3, spread: 10, tail: 300, snap: 0.5, drive: 0 };
    const n = Math.round(0.6 * SR);
    const plain = render(n, P(p), SR, { accent: 0 });
    const hot = render(n, P(p), SR, { accent: 1 });
    expect(rmsOf(hot)).toBeGreaterThan(rmsOf(plain) * 1.2);
    // Tail excitation: the late (room) window grows MORE than the early
    // (burst) window — the accent macro pumps the room, not just the level.
    const split = Math.round(0.06 * SR);
    const earlyGain = rmsOf(hot, 0, split) / Math.max(rmsOf(plain, 0, split), 1e-9);
    const lateGain = rmsOf(hot, split, n) / Math.max(rmsOf(plain, split, n), 1e-9);
    expect(lateGain).toBeGreaterThan(earlyGain * 1.15);
  });

  it('808 ↔ 909 ↔ LinnDrum corners are measurably different voices', () => {
    // 808 canonical (shipping defaults).
    const a808 = render(Math.round(0.8 * SR), P(), SR);
    // 909-dense: 5 fast bright pulses, white noise, burst-forward.
    const a909 = render(
      Math.round(0.8 * SR),
      P({ pulses: 5, spread: 5, tone: 2200, width: 0.7, color: 0, snap: 0.85, tail: 80, drive: 0.4 }),
      SR,
    );
    // LinnDrum-era dark room clap: slow spread, dark, room-dominant.
    const linn = render(
      Math.round(0.8 * SR),
      P({ pulses: 2, spread: 22, tone: 600, width: 0.35, color: 0.9, snap: 0.25, tail: 550 }),
      SR,
    );
    const w = Math.round(0.2 * SR);
    const c808 = centroidHz(a808, SR, 0, w);
    const c909 = centroidHz(a909, SR, 0, w);
    const cLinn = centroidHz(linn, SR, 0, w);
    expect(c909).toBeGreaterThan(1.5 * c808); // brighter
    expect(c808).toBeGreaterThan(1.3 * cLinn); // darker still
    const r909 = ringMs(a909, SR);
    const rLinn = ringMs(linn, SR);
    expect(rLinn).toBeGreaterThan(3 * r909); // the room voice rings long
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Determinism + hygiene
// ─────────────────────────────────────────────────────────────────────────

describe('clap: determinism + hygiene', () => {
  it('two independent states render bit-identical output (pure core)', () => {
    const a = render(4096, P(), SR);
    const b = render(4096, P(), SR);
    expect(a).toEqual(b);
  });

  it('re-striking the same state after ring-out reproduces the hit (≈1e-5)', () => {
    const p = P();
    const s = makeClapState();
    const hit = (warm: number) => {
      for (let t = 0; t < warm; t++) clapStep(0, 0, p, SR, s);
      const buf = new Float32Array(4096);
      for (let t = 0; t < 4096; t++) buf[t] = clapStep(t < 10 ? 1 : 0, 0, p, SR, s);
      return buf;
    };
    const first = hit(0);
    const second = hit(2 * SR); // 2 s ring-out past every envelope
    for (let i = 0; i < 4096; i++) {
      // Noise/filter/envelope state resets EXACTLY at the strike; only the
      // DC block + oversampler legitimately carry a tiny residue.
      expect(second[i]!).toBeCloseTo(first[i]!, 5);
    }
  });

  it('default hit: audible, true-peak bounded, DC-clean, silent before the strike', () => {
    const s = makeClapState();
    for (let t = 0; t < Math.round(0.1 * SR); t++) {
      expect(Math.abs(clapStep(0, 0, CLAP_DEFAULTS, SR, s))).toBeLessThan(1e-6);
    }
    const buf = render(SR, P(), SR);
    const peak = peakOf(buf);
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(1); // the chain ends in tanh
    let sum = 0;
    for (const v of buf) sum += v;
    expect(Math.abs(sum / buf.length)).toBeLessThan(0.01);
    expect(buf.every(Number.isFinite)).toBe(true);
  });

  it('every knob extreme stays finite + bounded (rail sweep)', () => {
    const rails: Array<Partial<ClapParams>> = [
      { pulses: 2, spread: 4, tone: 400, width: 0, tail: 30, color: 0, snap: 0, drive: 0, level: -24 },
      { pulses: 5, spread: 25, tone: 3000, width: 1, tail: 800, color: 1, snap: 1, drive: 1, level: 12 },
      { toneCv: 2, tailCv: 2, spreadCv: 2 },
      { toneCv: -2, tailCv: -2, spreadCv: -2 },
    ];
    for (const over of rails) {
      const buf = render(Math.round(0.5 * SR), P(over), SR);
      expect(buf.every(Number.isFinite)).toBe(true);
      expect(peakOf(buf)).toBeLessThan(1);
      expect(peakOf(buf)).toBeGreaterThan(0.02); // never dead at a rail
    }
  });
});
