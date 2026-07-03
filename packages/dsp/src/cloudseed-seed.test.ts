// packages/dsp/src/cloudseed-seed.test.ts
//
// Deterministic-render seam for CLOUDSEED (the ART-backfill unblock): a
// numeric processorOptions.seed drives the two mod-phase inits — the ONLY
// unseeded state in the voice; everything else already flows from
// Param.Seed/CrossSeed through LcgRandom — so the whole reverb renders
// byte-identically. No seed → Math.random(), the shipped per-instance
// phasing, untouched.
//
// The worklet entry never top-level-exports its Processor class, so we
// capture it via a registerProcessor shim (the mandelbulb-osc.test.ts
// pattern). cloudseed.ts has no runtime AudioWorkletProcessor fallback of
// its own, so the stub base (with a port) is installed before import.

import { describe, it, expect, beforeAll } from 'vitest';

const SR = 48000;
const BLOCK = 128;

type ProcInstance = {
  process: (
    i: Float32Array[][],
    o: Float32Array[][],
    p: Record<string, Float32Array>,
  ) => boolean;
};
type ProcCtor = new (options?: { processorOptions?: { seed?: number } }) => ProcInstance;

let capturedProc: ProcCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  // ALWAYS install our port-having stub base (not `if undefined`): the dsp
  // suite runs single-fork, so another worklet test may have already installed
  // a PORT-LESS AudioWorkletProcessor stub. cloudseed's ctor sets
  // `this.port.onmessage`, so it needs a base with a `port` — overwrite
  // unconditionally, else CI (different test order than local) crashes with
  // "Cannot set properties of undefined (setting 'onmessage')".
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage: (): void => {} };
  };
  g.registerProcessor = (_n, ctor) => {
    capturedProc = ctor;
  };
  await import('./cloudseed');
  if (!capturedProc) throw new Error('cloudseed processor did not register');
});

// MACRO_PARAMS mirror (k-rate macros the processor reads each block).
const MACROS = ['dry_out', 'early_out', 'late_out', 'input_mix', 'low_cut', 'high_cut', 'cross_seed'];

function makeParams(): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const name of MACROS) out[name] = new Float32Array([0.5]);
  // Fully wet + audible late tail so the modulated stages (where the seeded
  // phases live) dominate the capture.
  out['dry_out'] = new Float32Array([0]);
  out['late_out'] = new Float32Array([0.8]);
  return out;
}

/** Render `seconds` of impulse response through a fresh processor. */
function render(seed: number | undefined, seconds: number): Float32Array {
  const Proc = capturedProc!;
  const p =
    seed === undefined ? new Proc() : new Proc({ processorOptions: { seed } });
  const params = makeParams();
  const blocks = Math.ceil((seconds * SR) / BLOCK);
  const out = new Float32Array(blocks * BLOCK * 2);
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    // Impulse in the first block only.
    inL.fill(0);
    inR.fill(0);
    if (b === 0) {
      inL[0] = 1;
      inR[0] = 1;
    }
    p.process([[inL], [inR]], [[outL], [outR]], params);
    out.set(outL, b * BLOCK * 2);
    out.set(outR, b * BLOCK * 2 + BLOCK);
  }
  return out;
}

describe('cloudseed: seed-injectable mod phases', () => {
  it('same seed → byte-identical render (the ART determinism contract)', () => {
    const a = render(1234, 1.0);
    const b = render(1234, 1.0);
    expect(a.length).toBe(b.length);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBe(0);
    // And it actually made sound — a silent render would pass equality vacuously.
    let energy = 0;
    for (let i = 0; i < a.length; i++) energy += a[i]! * a[i]!;
    expect(energy).toBeGreaterThan(1e-6);
  });

  it('different seeds → different mod phasing in the tail', () => {
    const a = render(1234, 1.0);
    const b = render(99991, 1.0);
    let sumDiff = 0;
    for (let i = 0; i < a.length; i++) sumDiff += Math.abs(a[i]! - b[i]!);
    expect(sumDiff).toBeGreaterThan(1e-4);
  });

  it('no seed → shipped behavior: constructs fine, instances stay unique', () => {
    const a = render(undefined, 0.5);
    const b = render(undefined, 0.5);
    let sumDiff = 0;
    for (let i = 0; i < a.length; i++) sumDiff += Math.abs(a[i]! - b[i]!);
    expect(sumDiff).toBeGreaterThan(1e-6);
  });
});
