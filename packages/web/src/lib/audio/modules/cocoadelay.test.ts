// packages/web/src/lib/audio/modules/cocoadelay.test.ts
//
// Two test layers:
//   1. Module-def shape (ports / params / CV targets / category).
//   2. Real DSP behavior — instantiate the worklet processor class directly
//      and drive process() to assert delay time, feedback decay, tempo-sync
//      mapping, ducking envelope, and drive saturation.

import { describe, it, expect, beforeAll } from 'vitest';
import { cocoaDelayDef } from './cocoadelay';

const SR = 48000;

// The worklet reads the bare global `sampleRate` in its constructor and uses
// global AudioWorkletProcessor / registerProcessor. Provide them before import.
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// The worklet entry no longer `export`s its processor class (a top-level
// export pollutes the bundled dist worklet → breaks the ART classic-script
// eval). Capture the class via its registerProcessor side-effect, mirroring
// the ART harness. The dynamic import runs AFTER globals are set so the
// module's side-effecting registerProcessor() + the class's sampleRate
// reference resolve cleanly. Cached after the first import.
type ProcCtor = new () => {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — the worktree may not have the
  // workspace package symlinked under node_modules.
  await import('../../../../../dsp/src/cocoadelay');
  g.registerProcessor = prev;
  if (!registered) throw new Error('cocoadelay processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a parameters record. a-rate params get a single-element array (the
 *  worklet's aval() treats length-1 as constant), k-rate likewise. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of cocoaDelayDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

const BLOCK = 128;

/** Run the processor for `seconds`, feeding `inputFn(globalSampleIndex)` into
 *  both L+R audio inputs and an optional `clockFn` into the clock input.
 *  Returns the full mono-L output Float32Array. */
function runProcessor(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  seconds: number,
  inputFn: (n: number) => number,
  clockFn?: (n: number) => number,
): { L: Float32Array; R: Float32Array } {
  const total = Math.round(SR * seconds);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const inL = new Float32Array(len);
    const inR = new Float32Array(len);
    const clk = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = inputFn(g + i);
      inL[i] = v;
      inR[i] = v;
      if (clockFn) clk[i] = clockFn(g + i);
    }
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    const inputs: Float32Array[][] = [[inL], [inR], [clk]];
    const outputs: Float32Array[][] = [[outL], [outR]];
    proc.process(inputs, outputs, params);
    L.set(outL, g);
    R.set(outR, g);
    g += len;
  }
  return { L, R };
}

function peakIndex(buf: Float32Array, from = 0): number {
  let bi = from;
  let bv = -Infinity;
  for (let i = from; i < buf.length; i++) {
    const a = Math.abs(buf[i]!);
    if (a > bv) { bv = a; bi = i; }
  }
  return bi;
}

describe('cocoaDelayDef shape', () => {
  it('is a Ports-section effect with id cocoadelay', () => {
    expect(cocoaDelayDef.type).toBe('cocoadelay');
    expect(cocoaDelayDef.label).toBe('COCOA DELAY');
    expect(cocoaDelayDef.domain).toBe('audio');
  });

  it('declares stereo audio in/out + a clock gate input', () => {
    const inIds = cocoaDelayDef.inputs.map((p) => p.id);
    expect(inIds).toContain('inL');
    expect(inIds).toContain('inR');
    const clk = cocoaDelayDef.inputs.find((p) => p.id === 'clock');
    expect(clk?.type).toBe('gate');
    const outIds = cocoaDelayDef.outputs.map((p) => p.id);
    expect(outIds).toEqual(['outL', 'outR']);
  });

  it('exposes per-param CV for the musical params (time/feedback/mix/drive + more)', () => {
    const cvByTarget = new Map(
      cocoaDelayDef.inputs.filter((p) => p.type === 'cv').map((p) => [p.paramTarget, p]),
    );
    for (const target of ['delayTime', 'feedback', 'wetVolume', 'driveGain', 'lfoAmount', 'driftAmount', 'pan', 'duckAmount']) {
      expect(cvByTarget.has(target)).toBe(true);
    }
  });

  it('declares all source DSP params (delay/lfo/drift/feedback/duck/filter/drive/dry/wet + sync)', () => {
    const ids = new Set(cocoaDelayDef.params.map((p) => p.id));
    for (const id of [
      'delayTime', 'tempoSync', 'clockSource',
      'lfoAmount', 'lfoFrequency', 'driftAmount', 'driftSpeed',
      'feedback', 'stereoOffset', 'pan', 'panMode',
      'duckAmount', 'duckAttack', 'duckRelease',
      'filterMode', 'lowCut', 'highCut',
      'driveGain', 'driveMix', 'driveCutoff', 'driveIterations',
      'dryVolume', 'wetVolume',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('carries the GPL-3.0 Cocoa Delay attribution', () => {
    expect(cocoaDelayDef.ossAttribution?.author).toMatch(/Cocoa Delay/i);
  });
});

describe('cocoaDelay DSP behavior', () => {
  it('delays a click by ≈ the configured time (free-running, no feedback)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const time = 0.1; // 100 ms
    const params = makeParams({
      delayTime: time,
      tempoSync: 0,
      feedback: 0,
      driveGain: 0, // disable saturation so the impulse stays clean
      lfoAmount: 0,
      driftAmount: 0,
      dryVolume: 0, // wet-only so we measure the echo, not the dry click
      wetVolume: 1,
      lowCut: 1,    // wide-open filters
      highCut: 0.001,
      duckAmount: 0,
    });
    // A single-sample impulse at t=0.
    const { L } = runProcessor(proc, params, 0.3, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(L, 1);
    const expected = time * SR;
    // Hermite interp + the ~10ms read-position easing smear the peak; allow
    // a generous window. The key assertion is "there is a delayed echo near
    // the configured time", not sample-exactness.
    expect(pk).toBeGreaterThan(expected * 0.4);
    expect(pk).toBeLessThan(expected * 1.6);
  });

  it('feedback produces a decaying train of repeats; higher feedback = louder later repeats', async () => {
    const Proc = await loadProcessor();
    const time = 0.05;
    const base = {
      delayTime: time, tempoSync: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      stereoOffset: 0,
    };
    const procLow = new Proc();
    const procHigh = new Proc();
    const { L: low } = runProcessor(procLow, makeParams({ ...base, feedback: 0.3 }), 0.4, (n) => (n === 0 ? 1 : 0));
    const { L: high } = runProcessor(procHigh, makeParams({ ...base, feedback: 0.7 }), 0.4, (n) => (n === 0 ? 1 : 0));
    // Energy in the tail well past the first repeat (after 0.2s ≈ 4 repeats).
    const tailStart = Math.round(0.2 * SR);
    const tailEnergy = (b: Float32Array) => {
      let e = 0;
      for (let i = tailStart; i < b.length; i++) e += b[i]! * b[i]!;
      return e;
    };
    const eLow = tailEnergy(low);
    const eHigh = tailEnergy(high);
    expect(eHigh).toBeGreaterThan(eLow);
    expect(eLow).toBeGreaterThan(0); // there IS a decaying tail
  });

  it('tempo sync = 1/4 locks delay time to one measured clock period', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const periodSamples = Math.round(0.12 * SR); // 120 ms between pulses
    const params = makeParams({
      tempoSync: 6, // quarter note (SYNC_BEATS[6] === 1 beat = 1 period)
      feedback: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      delayTime: 0.5, // free-running fallback DIFFERENT from synced time
    });
    // Emit clock pulses (1-sample wide) every periodSamples for the first
    // 0.5s, then send a single impulse and measure the echo delay.
    const impulseAt = Math.round(0.55 * SR);
    const { L } = runProcessor(
      proc, params, 1.0,
      (n) => (n === impulseAt ? 1 : 0),
      (n) => (n % periodSamples === 0 ? 1 : 0),
    );
    const pk = peakIndex(L, impulseAt + 1);
    const echoDelay = pk - impulseAt;
    // Should be ≈ one clock period, NOT the 0.5s free-running fallback.
    expect(echoDelay).toBeGreaterThan(periodSamples * 0.5);
    expect(echoDelay).toBeLessThan(periodSamples * 1.6);
    expect(echoDelay).toBeLessThan(0.5 * SR * 0.8); // definitely not the fallback
  });

  it('ducking attenuates the wet while the dry input is loud', async () => {
    const Proc = await loadProcessor();
    const time = 0.05;
    const base = {
      delayTime: time, tempoSync: 0, feedback: 0.5, driveGain: 0, lfoAmount: 0,
      driftAmount: 0, dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001,
      duckAttack: 80, duckRelease: 2,
    };
    // Continuous loud tone so the duck follower stays high.
    const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.8;
    const noDuck = new Proc();
    const duck = new Proc();
    const { L: unducked } = runProcessor(noDuck, makeParams({ ...base, duckAmount: 0 }), 0.5, tone);
    const { L: ducked } = runProcessor(duck, makeParams({ ...base, duckAmount: 10 }), 0.5, tone);
    const rms = (b: Float32Array) => {
      let s = 0;
      const from = Math.round(0.2 * SR);
      for (let i = from; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / (b.length - from));
    };
    // Wet (dry=0) energy must drop substantially with heavy ducking.
    expect(rms(ducked)).toBeLessThan(rms(unducked) * 0.7);
  });

  it('drive saturation changes the wet signal (vs drive off)', async () => {
    const Proc = await loadProcessor();
    const time = 0.05;
    const base = {
      delayTime: time, tempoSync: 0, feedback: 0.4, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      driveMix: 1, driveCutoff: 1, driveIterations: 4,
    };
    const tone = (n: number) => Math.sin((2 * Math.PI * 110 * n) / SR) * 0.9;
    const clean = new Proc();
    const driven = new Proc();
    const { L: c } = runProcessor(clean, makeParams({ ...base, driveGain: 0 }), 0.5, tone);
    const { L: d } = runProcessor(driven, makeParams({ ...base, driveGain: 6 }), 0.5, tone);
    // The two outputs must differ (saturation is doing something).
    let diff = 0;
    const from = Math.round(0.2 * SR);
    for (let i = from; i < c.length; i++) diff += Math.abs(c[i]! - d[i]!);
    expect(diff).toBeGreaterThan(0);
  });

  it('produces finite, non-exploding output at high feedback', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({
      delayTime: 0.03, tempoSync: 0, feedback: 0.95, driveGain: 0.1,
      dryVolume: 1, wetVolume: 0.6, lowCut: 0.75, highCut: 0.001,
    });
    const tone = (n: number) => (n < SR * 0.1 ? Math.sin((2 * Math.PI * 200 * n) / SR) * 0.5 : 0);
    const { L } = runProcessor(proc, params, 1.0, tone);
    for (let i = 0; i < L.length; i++) {
      expect(Number.isFinite(L[i]!)).toBe(true);
    }
  });
});
