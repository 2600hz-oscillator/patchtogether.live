// art/scenarios/analog-logic-maths/algebra.test.ts
//
// ART for ANALOGLOGICMATHS. node-web-audio-api can't host AudioWorkletNodes,
// so we instantiate the processor class directly (shim base class + globals
// for sampleRate / registerProcessor / AudioWorkletProcessor) and drive
// process() block-by-block. We assert:
//
//   1. Each of the 5 algebraic outputs (MIN/MAX/DIFF/SUM/PRODUCT) emits the
//      expected value for known DC input pairs, with the attenuverter
//      applied before the math.
//   2. Soft-clip on SUM / PRODUCT keeps the output strictly in (-1, +1)
//      for unity-and-above inputs, while staying near-linear for small ones.
//   3. PRODUCT of two sines at f1 and f2 produces the ring-modulation
//      identity: spectral energy at |f1 - f2| AND f1 + f2 (sum + diff
//      sidebands), with the carrier f1 / modulator f2 themselves
//      suppressed by the multiply.
//
// Reading FFT magnitudes from a goertzel-style narrowband filter rather
// than a full FFT (simpler, no dep, and the bins of interest are fixed).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';

const SAMPLE_RATE = 48000;
const BLOCK = 128;

interface ProcessorCtor {
  new (): {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      params: Record<string, Float32Array>,
    ): boolean;
  };
}

let AlmProcessor: ProcessorCtor;

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  g.sampleRate = SAMPLE_RATE;
  let registered: ProcessorCtor | null = null;
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => {
    registered = ctor;
  };
  g.AudioWorkletProcessor = class {
    port = { postMessage: () => {}, onmessage: null };
  };
  const jsPath = new URL(
    '../../../packages/dsp/dist/analog-logic-maths.js',
    import.meta.url,
  );
  const src = await readFile(jsPath, 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(src).call(g);
  if (!registered) throw new Error('analog-logic-maths processor did not register');
  AlmProcessor = registered;
});

interface RenderOpts {
  /** Frame-by-frame value generators for inputs and params. */
  a: (i: number) => number;
  b: (i: number) => number;
  attA?: number;
  attB?: number;
  durationS: number;
}

interface RenderResult {
  min: Float32Array;
  max: Float32Array;
  diff: Float32Array;
  sum: Float32Array;
  product: Float32Array;
}

function renderProcessor(opts: RenderOpts): RenderResult {
  const proc = new AlmProcessor();
  const N = Math.round(SAMPLE_RATE * opts.durationS);
  const minOut = new Float32Array(N);
  const maxOut = new Float32Array(N);
  const diffOut = new Float32Array(N);
  const sumOut = new Float32Array(N);
  const prodOut = new Float32Array(N);

  const inA = new Float32Array(BLOCK);
  const inB = new Float32Array(BLOCK);
  const oMin = new Float32Array(BLOCK);
  const oMax = new Float32Array(BLOCK);
  const oDiff = new Float32Array(BLOCK);
  const oSum = new Float32Array(BLOCK);
  const oProd = new Float32Array(BLOCK);

  const attA = new Float32Array([opts.attA ?? 1]);
  const attB = new Float32Array([opts.attB ?? 1]);

  for (let frame = 0; frame < N; frame += BLOCK) {
    const blockN = Math.min(BLOCK, N - frame);
    for (let i = 0; i < BLOCK; i++) {
      inA[i] = i < blockN ? opts.a(frame + i) : 0;
      inB[i] = i < blockN ? opts.b(frame + i) : 0;
    }
    proc.process(
      [[inA], [inB]],
      [[oMin], [oMax], [oDiff], [oSum], [oProd]],
      { attA, attB },
    );
    for (let i = 0; i < blockN; i++) {
      minOut[frame + i] = oMin[i] ?? 0;
      maxOut[frame + i] = oMax[i] ?? 0;
      diffOut[frame + i] = oDiff[i] ?? 0;
      sumOut[frame + i] = oSum[i] ?? 0;
      prodOut[frame + i] = oProd[i] ?? 0;
    }
  }
  return { min: minOut, max: maxOut, diff: diffOut, sum: sumOut, product: prodOut };
}

/** Single-frequency power via Goertzel (avoids pulling a full FFT dep).
 *  Returns the magnitude (not power) of the bin at `freqHz` for the
 *  given signal. Bins are continuous-frequency, not snapped. */
function goertzelMag(signal: Float32Array, freqHz: number, sr: number): number {
  const N = signal.length;
  const k = (freqHz * N) / sr;
  const omega = (2 * Math.PI * k) / N;
  const cosw = Math.cos(omega);
  const coeff = 2 * cosw;
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + (signal[i] ?? 0);
    q2 = q1;
    q1 = q0;
  }
  const sinw = Math.sin(omega);
  const real = q1 - q2 * cosw;
  const imag = q2 * sinw;
  return Math.sqrt(real * real + imag * imag) / N;
}

describe('ALM ART: DC algebra at attA=attB=+1', () => {
  it('min(1, 0) = 0', () => {
    const r = renderProcessor({
      a: () => 1,
      b: () => 0,
      durationS: 0.05,
    });
    expect(r.min[r.min.length - 1]).toBeCloseTo(0, 5);
  });

  it('max(0.5, 0.3) = 0.5', () => {
    const r = renderProcessor({
      a: () => 0.5,
      b: () => 0.3,
      durationS: 0.05,
    });
    expect(r.max[r.max.length - 1]).toBeCloseTo(0.5, 5);
  });

  it('diff(1, 0.5) = 0.5', () => {
    const r = renderProcessor({
      a: () => 1,
      b: () => 0.5,
      durationS: 0.05,
    });
    expect(r.diff[r.diff.length - 1]).toBeCloseTo(0.5, 5);
  });

  it('product(0.5, 0.5) ≈ tanh(0.25) (small-signal nearly linear)', () => {
    const r = renderProcessor({
      a: () => 0.5,
      b: () => 0.5,
      durationS: 0.05,
    });
    expect(r.product[r.product.length - 1]).toBeCloseTo(Math.tanh(0.25), 4);
  });

  it('sum(0.3, 0.4) ≈ tanh(0.7)', () => {
    const r = renderProcessor({
      a: () => 0.3,
      b: () => 0.4,
      durationS: 0.05,
    });
    expect(r.sum[r.sum.length - 1]).toBeCloseTo(Math.tanh(0.7), 4);
  });
});

describe('ALM ART: attenuverter applies before the math', () => {
  it('attA=-1 inverts A → DIFF(0.5, 0.5) becomes -1', () => {
    // a' = -0.5, b' = 0.5 → diff = -1
    const r = renderProcessor({
      a: () => 0.5,
      b: () => 0.5,
      attA: -1,
      attB: 1,
      durationS: 0.05,
    });
    expect(r.diff[r.diff.length - 1]).toBeCloseTo(-1, 4);
  });

  it('attB=0 mutes B → SUM(0.1, anything) ≈ tanh(0.1)', () => {
    const r = renderProcessor({
      a: () => 0.1,
      b: () => 0.99,
      attA: 1,
      attB: 0,
      durationS: 0.05,
    });
    expect(r.sum[r.sum.length - 1]).toBeCloseTo(Math.tanh(0.1), 4);
  });

  it('attA=0.5 halves A → MAX(0.6, 0.4) becomes max(0.3, 0.4) = 0.4', () => {
    const r = renderProcessor({
      a: () => 0.6,
      b: () => 0.4,
      attA: 0.5,
      attB: 1,
      durationS: 0.05,
    });
    expect(r.max[r.max.length - 1]).toBeCloseTo(0.4, 5);
  });
});

describe('ALM ART: soft-clip keeps SUM + PRODUCT bounded', () => {
  it('SUM(1, 1) stays under 1 (tanh(2) ≈ 0.964)', () => {
    const r = renderProcessor({
      a: () => 1,
      b: () => 1,
      durationS: 0.05,
    });
    expect(r.sum[r.sum.length - 1]).toBeLessThan(1);
    expect(r.sum[r.sum.length - 1]).toBeGreaterThan(0.9);
  });

  it('PRODUCT(2, 2) stays under 1 (tanh(4) ≈ 0.999)', () => {
    const r = renderProcessor({
      a: () => 2,
      b: () => 2,
      durationS: 0.05,
    });
    expect(r.product[r.product.length - 1]).toBeLessThan(1);
    expect(r.product[r.product.length - 1]).toBeGreaterThan(0.99);
  });

  it('SUM peak never exceeds 1.0 across a wild input sweep', () => {
    // Combine two ramping sines that drive |a+b| past 2.0 repeatedly.
    const r = renderProcessor({
      a: (i) => 1.5 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE),
      b: (i) => 1.5 * Math.sin((2 * Math.PI * 330 * i) / SAMPLE_RATE),
      durationS: 0.1,
    });
    let peak = 0;
    for (let i = 0; i < r.sum.length; i++) {
      const v = Math.abs(r.sum[i] ?? 0);
      if (v > peak) peak = v;
    }
    expect(peak).toBeLessThan(1);
  });
});

describe('ALM ART: PRODUCT of two sines = ring modulation', () => {
  it('produces sum + diff sidebands and suppresses the carriers', () => {
    // Two pure tones; PRODUCT = sin(2πf1 t) × sin(2πf2 t)
    //   = 0.5 × [cos(2π(f1 - f2) t) - cos(2π(f1 + f2) t)]
    // So spectral energy lives at |f1 - f2| and (f1 + f2), NOT at f1 or f2.
    // At small input amplitudes tanh ≈ identity so the identity holds
    // tightly.
    const f1 = 440;
    const f2 = 110;
    const amp = 0.4; // Keeps product peak around 0.16 — tanh nearly transparent.
    const r = renderProcessor({
      a: (i) => amp * Math.sin((2 * Math.PI * f1 * i) / SAMPLE_RATE),
      b: (i) => amp * Math.sin((2 * Math.PI * f2 * i) / SAMPLE_RATE),
      durationS: 0.25,
    });
    // Skip first block to avoid edge effects.
    const tail = r.product.subarray(BLOCK);
    const sumSideband = goertzelMag(tail, f1 + f2, SAMPLE_RATE);
    const diffSideband = goertzelMag(tail, Math.abs(f1 - f2), SAMPLE_RATE);
    const carrierA = goertzelMag(tail, f1, SAMPLE_RATE);
    const carrierB = goertzelMag(tail, f2, SAMPLE_RATE);

    // Sidebands carry real energy.
    expect(sumSideband).toBeGreaterThan(0.02);
    expect(diffSideband).toBeGreaterThan(0.02);
    // Carriers themselves are suppressed (orders of magnitude below the
    // sidebands). A pure-multiply ring mod nulls them; tanh's odd-harmonic
    // distortion can leak a tiny amount back. Allow some slop.
    expect(carrierA).toBeLessThan(sumSideband * 0.5);
    expect(carrierB).toBeLessThan(diffSideband * 0.5);
  });
});

describe('ALM ART: MIN / MAX shape sine pairs predictably', () => {
  it('MAX of two equal-amplitude sines at the same freq tracks the larger phase', () => {
    // Two sines at 100 Hz, in-phase. MAX(a, a) = a. Verify the peak of
    // MAX matches the input peak (within float epsilon).
    const r = renderProcessor({
      a: (i) => 0.5 * Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE),
      b: (i) => 0.5 * Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE),
      durationS: 0.05,
    });
    let peak = 0;
    for (let i = BLOCK; i < r.max.length; i++) {
      const v = r.max[i] ?? 0;
      if (v > peak) peak = v;
    }
    expect(peak).toBeCloseTo(0.5, 3);
  });

  it('MIN of a sine with its negation collapses to -|a| (full-wave negated)', () => {
    // MIN(sin, -sin) = -|sin|. Peak NEGATIVE excursion is -|amp|.
    const amp = 0.5;
    const r = renderProcessor({
      a: (i) => amp * Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE),
      b: (i) => -amp * Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE),
      durationS: 0.05,
    });
    let trough = 0;
    for (let i = BLOCK; i < r.min.length; i++) {
      const v = r.min[i] ?? 0;
      if (v < trough) trough = v;
    }
    expect(trough).toBeCloseTo(-amp, 3);
    // And MIN(sin, -sin) is never positive.
    let maxOfMin = -Infinity;
    for (let i = BLOCK; i < r.min.length; i++) {
      const v = r.min[i] ?? 0;
      if (v > maxOfMin) maxOfMin = v;
    }
    expect(maxOfMin).toBeLessThanOrEqual(0.001);
  });
});
