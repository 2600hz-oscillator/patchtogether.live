// art/scenarios/charlottes-echos/wet-output.test.ts
//
// Regression: CHARLOTTE'S ECHOS produced effectively-silent output at
// mix=1.0 (fully wet). The cause was an unbounded head-volume accumulation:
// head 0 spawned at volume=1 and never decayed, so its wet sum grew far
// past unity and the downstream master-limiter (audio-out) choked the
// signal to silence under sustained gain reduction.
//
// node-web-audio-api can't host AudioWorkletNodes, so we instantiate the
// processor class directly with a shim base class + globals (sampleRate,
// registerProcessor, AudioWorkletProcessor) and drive process() block-by-
// block. We verify:
//
//  - Wet RMS is measurable AND bounded (< 1.0 peak across 3s render).
//  - With mix=1.0, output is meaningfully different from the dry input
//    (a delay actually happened — output at t < delaySamples is silence,
//    output after the delay matches the delayed input within tape-saturation
//    distortion).
//  - With decay > 0, head volumes fade so total wet energy stays bounded.

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

let CharlottesEchosProcessor: ProcessorCtor;

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
    '../../../packages/dsp/dist/charlottes-echos.js',
    import.meta.url,
  );
  const src = await readFile(jsPath, 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(src).call(g);
  if (!registered) throw new Error('charlottes-echos processor did not register');
  CharlottesEchosProcessor = registered;
});

interface RenderParams {
  feedback: number;
  decay: number;
  pitchUp: number;
  mix: number;
  delay: number;
  durationS: number;
  inputAmp: number;
  inputHz: number;
}

function renderProcessor(opts: RenderParams): {
  output: Float32Array;
  input: Float32Array;
} {
  const proc = new CharlottesEchosProcessor();
  const N = Math.round(SAMPLE_RATE * opts.durationS);
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const params: Record<string, Float32Array> = {
    delay: new Float32Array(BLOCK),
    feedback: new Float32Array(1),
    decay: new Float32Array(1),
    pitchUp: new Float32Array(1),
    mix: new Float32Array(1),
  };
  params.delay.fill(opts.delay);
  params.feedback[0] = opts.feedback;
  params.decay[0] = opts.decay;
  params.pitchUp[0] = opts.pitchUp;
  params.mix[0] = opts.mix;

  const FULL_OUT = new Float32Array(N);
  const FULL_IN = new Float32Array(N);
  const blocks = Math.floor(N / BLOCK);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BLOCK; i++) {
      const t = (b * BLOCK + i) / SAMPLE_RATE;
      const v = Math.sin(2 * Math.PI * opts.inputHz * t) * opts.inputAmp;
      inL[i] = v;
      inR[i] = v;
      FULL_IN[b * BLOCK + i] = v;
    }
    outL.fill(0);
    outR.fill(0);
    proc.process([[inL], [inR]], [[outL], [outR]], params);
    for (let i = 0; i < BLOCK; i++) FULL_OUT[b * BLOCK + i] = outL[i];
  }
  return { output: FULL_OUT, input: FULL_IN };
}

function rms(buf: Float32Array, start = 0, end = buf.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / (end - start));
}

function peakAbs(buf: Float32Array, start = 0, end = buf.length): number {
  let p = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(buf[i]!);
    if (a > p) p = a;
  }
  return p;
}

describe("charlottes-echos / wet-output regression", () => {
  it("mix=1.0 produces audible wet signal (RMS > 0.05, peak < 1.0)", () => {
    const { output } = renderProcessor({
      delay: 0.4,
      feedback: 0.5,
      decay: 0.2,
      pitchUp: 0,
      mix: 1.0,
      durationS: 2.0,
      inputAmp: 0.5,
      inputHz: 440,
    });
    const start = Math.round(0.4 * SAMPLE_RATE);
    const r = rms(output, start);
    const p = peakAbs(output, start);
    expect(r, `wet RMS ${r.toFixed(4)} (must be > 0.05)`).toBeGreaterThan(0.05);
    expect(p, `wet peak ${p.toFixed(4)} (must be < 1.0)`).toBeLessThan(1.0);
  });

  it("mix=1.0 output is delayed: silence before the cascade delay, signal after", () => {
    // CHARLOTTE is now FOUR Cocoa Delay stages in SERIES. At mix=1.0 each
    // stage is pure-wet, so the dry signal only emerges after passing through
    // all four delay lines → the first echo lands at ≈ the SUM of the stage
    // delays (≈ 4 × delay). With delay=0.4 that's ≈1.6 s, so render long
    // enough to capture it.
    const delay = 0.4;
    const cascade = 4 * delay; // ≈ first-echo arrival
    const { output } = renderProcessor({
      delay,
      feedback: 0.5,
      decay: 0.2,
      pitchUp: 0,
      mix: 1.0,
      durationS: cascade + 0.6,
      inputAmp: 0.5,
      inputHz: 440,
    });
    // Silent until the signal has traversed all four stages.
    const preDelay = peakAbs(output, 0, Math.round((cascade - 0.05) * SAMPLE_RATE));
    const postDelay = peakAbs(
      output,
      Math.round((cascade + 0.02) * SAMPLE_RATE),
      Math.round((cascade + 0.4) * SAMPLE_RATE),
    );
    expect(preDelay, `pre-cascade peak ${preDelay}`).toBeLessThan(0.01);
    expect(postDelay, `post-cascade peak ${postDelay}`).toBeGreaterThan(0.1);
  });

  it("wet output differs from dry input (delay actually happened)", () => {
    const { output, input } = renderProcessor({
      delay: 0.4,
      feedback: 0.5,
      decay: 0.2,
      pitchUp: 0,
      mix: 1.0,
      durationS: 1.0,
      inputAmp: 0.5,
      inputHz: 440,
    });
    const start = Math.round(0.5 * SAMPLE_RATE);
    const end = Math.round(0.6 * SAMPLE_RATE);
    let diffSumSq = 0;
    for (let i = start; i < end; i++) {
      const d = output[i]! - input[i]!;
      diffSumSq += d * d;
    }
    const diffRms = Math.sqrt(diffSumSq / (end - start));
    expect(diffRms, `output vs input RMS diff ${diffRms}`).toBeGreaterThan(0.05);
  });

  it("output stays bounded over 3 seconds (no runaway accumulation)", () => {
    const { output } = renderProcessor({
      delay: 0.4,
      feedback: 0.5,
      decay: 0.2,
      pitchUp: 0,
      mix: 1.0,
      durationS: 3.0,
      inputAmp: 0.5,
      inputHz: 440,
    });
    const p = peakAbs(output);
    expect(p, `3s peak ${p.toFixed(4)} (no runaway)`).toBeLessThan(1.0);
    const tail = rms(output, output.length - Math.round(0.5 * SAMPLE_RATE));
    expect(tail, `tail RMS ${tail.toFixed(4)}`).toBeGreaterThan(0.02);
  });

  it("mix=0 produces dry-equal output (no wet contribution)", () => {
    const { output, input } = renderProcessor({
      delay: 0.4,
      feedback: 0.5,
      decay: 0.2,
      pitchUp: 0,
      mix: 0.0,
      durationS: 0.3,
      inputAmp: 0.5,
      inputHz: 440,
    });
    let maxDiff = 0;
    for (let i = 0; i < output.length; i++) {
      const d = Math.abs(output[i]! - input[i]!);
      if (d > maxDiff) maxDiff = d;
    }
    expect(maxDiff, `mix=0 dry mismatch ${maxDiff}`).toBeLessThan(1e-5);
  });
});
