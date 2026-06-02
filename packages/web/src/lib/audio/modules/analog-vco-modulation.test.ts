// packages/web/src/lib/audio/modules/analog-vco-modulation.test.ts
//
// Regression coverage for the ANALOG VCO PHASE/FREQUENCY MODULATION across the
// FULL saw→sine→square morph (the user-reported "PM/FM don't appear to work,
// at least in MORPH mode" investigation).
//
// Root cause found: the *separate* bug was PW being dead on the morph (fixed in
// the .dsp + covered in analog-vco-morph.test.ts). PM/FM were NEVER actually
// dead in the DSP — the morph shares the SAME phase accumulator `p` (which
// carries PM) and the SAME frequency `f` (which carries FM) as the four fixed
// taps. This file LOCKS THAT IN: PM and FM must bend the oscillator at EVERY
// morph position (saw / mid / square), not just one waveform.
//
// As with the morph + sync tests, node-web-audio-api can't host the Faust
// worklet, so we mirror the EXACT per-sample recurrences from
// packages/dsp/src/analog-vco.dsp:
//
//   freqHz(pitch, fm)     = 261.626 * 2^(pitch + tune/12 + fine/1200 + fmAmount*fm)
//   phasorReset(f, reset) = loop ~ _ ; loop(prev) = (1-reset)*frac(prev + f/SR)
//   p                     = frac(pRaw + pmAmount * pm)      // PM offset
//   morph(p)              = saw→sine (shape<0.5) | sine→square (shape>=0.5)
//   sqr(p)                = select2(p < pw, 1, -1)          // pw-driven (PW fix)
//
// `'` is the one-sample delay; frac(x)=x-floor(x).

import { describe, expect, it } from 'vitest';

const SR = 48000;
const C4 = 261.626;
const frac = (x: number) => x - Math.floor(x);

const sawTap = (p: number) => 2 * p - 1;
const sn = (p: number) => Math.sin(2 * Math.PI * p);
const sqr = (p: number, pw: number) => (p < pw ? 1 : -1);

// Post-fix morph (square endpoint = pw-driven sqr).
function morph(p: number, shape: number, pw = 0.5): number {
  if (shape < 0.5) {
    const lo = 2 * shape;
    return sn(p) * lo + sawTap(p) * (1 - lo);
  }
  const hi = 2 * shape - 1;
  return sqr(p, pw) * hi + sn(p) * (1 - hi);
}

interface VcoOpts {
  pitch?: number;       // V/oct
  shape?: number;       // morph position 0..1
  pw?: number;
  fmAmount?: number;    // -1..1
  pmAmount?: number;    // -1..1
  fm?: Float32Array;    // audio-rate FM input (per sample)
  pm?: Float32Array;    // audio-rate PM input (per sample)
}

/** Full per-sample mirror of the .dsp morph output (no sync). Returns the
 *  morph signal so we can assert PM/FM affect it at any `shape`. */
function renderMorph(n: number, o: VcoOpts): Float32Array {
  const { pitch = 0, shape = 0, pw = 0.5, fmAmount = 0, pmAmount = 0 } = o;
  const fm = o.fm;
  const pm = o.pm;
  const out = new Float32Array(n);
  let pRaw = 0;
  for (let i = 0; i < n; i++) {
    const fmIn = fm ? (fm[i] ?? 0) : 0;
    const f = Math.min(20000, Math.max(1, C4 * Math.pow(2, pitch + fmAmount * fmIn)));
    pRaw = frac(pRaw + f / SR);
    const pmIn = pm ? (pm[i] ?? 0) : 0;
    const p = frac(pRaw + pmAmount * pmIn);
    out[i] = morph(p, shape, pw);
  }
  return out;
}

function rms(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

/** Naive single-bin DFT magnitude of bin `hz` over the buffer. */
function binMag(buf: Float32Array, hz: number): number {
  let re = 0;
  let im = 0;
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * hz * i) / SR;
    re += buf[i]! * Math.cos(ph);
    im -= buf[i]! * Math.sin(ph);
  }
  return Math.sqrt(re * re + im * im) / n;
}

/** Energy-weighted spectral spread (Hz) around a carrier, sampled on the FM
 *  sideband grid carrier ± k·modHz. Wider spread = richer (more FM-modulated)
 *  spectrum. This is robust where any single sideband bin is non-monotonic
 *  (exponential FM migrates energy out to higher-order sidebands with depth). */
function spectralSpread(buf: Float32Array, carrierHz: number, modHz: number): number {
  let num = 0;
  let den = 0;
  for (let k = -12; k <= 12; k++) {
    const hz = carrierHz + k * modHz;
    if (hz <= 0) continue;
    const m = binMag(buf, hz);
    num += m * k * k;
    den += m;
  }
  return Math.sqrt(num / den) * modHz;
}

const SHAPES: Array<[string, number]> = [
  ['saw', 0],
  ['mid (sine)', 0.5],
  ['square', 1],
];

describe('analogVco PM bends phase at EVERY morph position', () => {
  it('a PM signal reshapes the morph output at saw, mid, AND square', () => {
    const n = SR / 10; // 0.1 s
    // 30 Hz PM modulator.
    const pm = new Float32Array(n);
    for (let i = 0; i < n; i++) pm[i] = Math.sin((2 * Math.PI * 30 * i) / SR);
    for (const [name, shape] of SHAPES) {
      const dry = renderMorph(n, { shape, pmAmount: 0, pm });
      const wet = renderMorph(n, { shape, pmAmount: 0.5, pm });
      expect(rms(dry, wet), `PM dead on morph at ${name}`).toBeGreaterThan(0.05);
    }
  });

  it('PM depth scales the modulation amount (more depth = bigger change)', () => {
    const n = SR / 10;
    const pm = new Float32Array(n);
    for (let i = 0; i < n; i++) pm[i] = Math.sin((2 * Math.PI * 30 * i) / SR);
    for (const [, shape] of SHAPES) {
      const dry = renderMorph(n, { shape, pmAmount: 0, pm });
      const light = rms(dry, renderMorph(n, { shape, pmAmount: 0.1, pm }));
      const heavy = rms(dry, renderMorph(n, { shape, pmAmount: 0.5, pm }));
      expect(heavy).toBeGreaterThan(light);
    }
  });

  it('PM at depth 0 is a no-op at every shape (no modulation when knob is off)', () => {
    const n = 4096;
    const pm = new Float32Array(n);
    for (let i = 0; i < n; i++) pm[i] = Math.sin((2 * Math.PI * 50 * i) / SR);
    for (const [, shape] of SHAPES) {
      const a = renderMorph(n, { shape, pmAmount: 0, pm });
      const b = renderMorph(n, { shape, pmAmount: 0 }); // no pm wired
      expect(rms(a, b)).toBe(0);
    }
  });

  it('negative PM depth inverts the phase offset (bipolar)', () => {
    const n = 4096;
    const pm = new Float32Array(n);
    for (let i = 0; i < n; i++) pm[i] = Math.sin((2 * Math.PI * 40 * i) / SR);
    // At a pure sine morph, +pmAmount and -pmAmount push phase opposite ways;
    // the two wet outputs differ from each other (sign matters).
    const pos = renderMorph(n, { shape: 0.5, pmAmount: 0.3, pm });
    const neg = renderMorph(n, { shape: 0.5, pmAmount: -0.3, pm });
    expect(rms(pos, neg)).toBeGreaterThan(0.01);
  });
});

describe('analogVco FM bends frequency at EVERY morph position', () => {
  it('an FM signal stretches/compresses cycles at saw, mid, AND square', () => {
    const n = SR / 5; // 0.2 s
    const fm = new Float32Array(n);
    for (let i = 0; i < n; i++) fm[i] = Math.sin((2 * Math.PI * 5 * i) / SR); // 5 Hz vibrato
    for (const [name, shape] of SHAPES) {
      const dry = renderMorph(n, { shape, fmAmount: 0, fm });
      const wet = renderMorph(n, { shape, fmAmount: 0.3, fm });
      expect(rms(dry, wet), `FM dead on morph at ${name}`).toBeGreaterThan(0.05);
    }
  });

  it('FM widens the spectrum (sidebands appear around the carrier)', () => {
    // Carrier ~261.6 Hz; a 40 Hz FM modulator at depth should put energy in
    // sideband bins (carrier ± 40 Hz) that the dry sine does NOT have.
    const n = SR; // 1 s for fine bin resolution
    const modHz = 40;
    const fm = new Float32Array(n);
    for (let i = 0; i < n; i++) fm[i] = Math.sin((2 * Math.PI * modHz * i) / SR);
    const carrierHz = C4;
    const dry = renderMorph(n, { shape: 0.5, fmAmount: 0, fm }); // pure sine carrier
    const wet = renderMorph(n, { shape: 0.5, fmAmount: 0.2, fm });
    const lowerSB = carrierHz - modHz;
    const upperSB = carrierHz + modHz;
    // Dry sine has ~zero energy at the sideband frequencies; FM creates it.
    expect(binMag(wet, lowerSB)).toBeGreaterThan(binMag(dry, lowerSB) * 5 + 1e-4);
    expect(binMag(wet, upperSB)).toBeGreaterThan(binMag(dry, upperSB) * 5 + 1e-4);
  });

  it('deeper FM = richer spectrum (carrier drains into a wider sideband fan)', () => {
    // Two textbook FM signatures, both monotonic with depth:
    //   (a) the carrier bin DRAINS as energy moves into sidebands, and
    //   (b) the spectral SPREAD widens (energy reaches higher-order sidebands).
    // Exponential FM migrates energy out to higher-order sidebands with depth,
    // so any single sideband bin is non-monotonic — these aggregate measures
    // are the robust "richer spectrum" assertion.
    const n = SR;
    const modHz = 40;
    const fm = new Float32Array(n);
    for (let i = 0; i < n; i++) fm[i] = Math.sin((2 * Math.PI * modHz * i) / SR);
    const buf = (depth: number) => renderMorph(n, { shape: 0.5, fmAmount: depth, fm });
    const dry = buf(0);
    const light = buf(0.1);
    const heavy = buf(0.3);
    // (a) carrier drains monotonically.
    expect(binMag(heavy, C4)).toBeLessThan(binMag(light, C4));
    expect(binMag(light, C4)).toBeLessThan(binMag(dry, C4));
    // (b) spread widens monotonically.
    expect(spectralSpread(heavy, C4, modHz)).toBeGreaterThan(spectralSpread(light, C4, modHz));
    expect(spectralSpread(light, C4, modHz)).toBeGreaterThan(spectralSpread(dry, C4, modHz));
  });

  it('FM at depth 0 is a no-op at every shape', () => {
    const n = 4096;
    const fm = new Float32Array(n);
    for (let i = 0; i < n; i++) fm[i] = Math.sin((2 * Math.PI * 30 * i) / SR);
    for (const [, shape] of SHAPES) {
      const a = renderMorph(n, { shape, fmAmount: 0, fm });
      const b = renderMorph(n, { shape });
      expect(rms(a, b)).toBe(0);
    }
  });
});

describe('analogVco modulation: bounded + finite', () => {
  it('PM + FM together stay bounded and finite at every shape', () => {
    const n = SR / 10;
    const fm = new Float32Array(n);
    const pm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      fm[i] = Math.sin((2 * Math.PI * 7 * i) / SR);
      pm[i] = Math.sin((2 * Math.PI * 33 * i) / SR);
    }
    for (const [, shape] of SHAPES) {
      for (const pw of [0.05, 0.5, 0.95]) {
        const buf = renderMorph(n, { shape, pw, fmAmount: 0.5, pmAmount: 1, fm, pm });
        const bad = buf.findIndex((v) => !Number.isFinite(v));
        expect(bad, `non-finite at shape=${shape} pw=${pw} idx=${bad}`).toBe(-1);
        for (const v of buf) {
          expect(v).toBeGreaterThanOrEqual(-1.0000001);
          expect(v).toBeLessThanOrEqual(1.0000001);
        }
      }
    }
  });
});
