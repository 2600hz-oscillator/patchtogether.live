// packages/web/src/lib/audio/modules/cofefve.test.ts
//
// Two test layers for COFEFVE DELAY:
//   1. Module-def shape (ports / params / CV targets / category).
//   2. Real DSP behavior — instantiate the worklet processor class directly
//      and drive process() to assert delay time, feedback decay, tempo-sync
//      mapping (measured clock + bridged syncPeriod), ducking, and drive.
// Plus the WEB-layer clockSource → seconds-per-beat bridge + MIDI clock source.

import { describe, it, expect, beforeAll } from 'vitest';
import { cofefveDelayDef, readTimelordeBpm, resolveSyncPeriodS } from './cofefve';

const SR = 48000;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// The worklet entry does not `export` its processor class (a top-level export
// pollutes the bundled dist worklet). Capture the class via its
// registerProcessor side-effect, mirroring the ART harness.
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
  await import('../../../../../dsp/src/cofefve');
  g.registerProcessor = prev;
  if (!registered) throw new Error('cofefve processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a parameters record (single-element arrays = the constant-this-block
 *  AudioParam shape the worklet's kval/aval treat as constant). */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of cofefveDelayDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

const BLOCK = 128;

/** Run the processor for `seconds`, feeding `inputFn` into both L+R audio
 *  inputs and an optional `clockFn` into the clock input. Returns mono-L. */
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
    proc.process([[inL], [inR], [clk]], [[outL], [outR]], params);
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

describe('cofefveDelayDef shape', () => {
  it('is an effects-section module with id cofefve + lowercase label', () => {
    expect(cofefveDelayDef.type).toBe('cofefve');
    expect(cofefveDelayDef.label).toBe('cofefve delay');
    expect(cofefveDelayDef.domain).toBe('audio');
    // No `card:` override — resolves by convention to CofefveCard.
    expect(cofefveDelayDef.card).toBeUndefined();
  });

  it('declares stereo audio in/out + a clock trigger input', () => {
    const inIds = cofefveDelayDef.inputs.map((p) => p.id);
    expect(inIds).toContain('inL');
    expect(inIds).toContain('inR');
    const clk = cofefveDelayDef.inputs.find((p) => p.id === 'clock');
    expect(clk?.type).toBe('gate');
    expect(clk?.edge).toBe('trigger');
    expect(cofefveDelayDef.outputs.map((p) => p.id)).toEqual(['outL', 'outR']);
  });

  it('exposes per-param CV for the musical params (time/feedback/mix/drive + more)', () => {
    const cvByTarget = new Map(
      cofefveDelayDef.inputs.filter((p) => p.type === 'cv').map((p) => [p.paramTarget, p]),
    );
    for (const target of ['delayTime', 'feedback', 'wetVolume', 'driveGain', 'lfoAmount', 'driftAmount', 'pan', 'duckAmount']) {
      expect(cvByTarget.has(target)).toBe(true);
    }
  });

  it('declares all DSP params (delay/lfo/drift/feedback/duck/filter/drive/dry/wet + sync)', () => {
    const ids = new Set(cofefveDelayDef.params.map((p) => p.id));
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

  it('carries NO GPL/OSS attribution (own-code, clean-room)', () => {
    expect(cofefveDelayDef.ossAttribution).toBeUndefined();
  });
});

describe('cofefve DSP behavior', () => {
  it('delays a click by ≈ the configured time (free-running, no feedback)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const time = 0.1;
    const params = makeParams({
      delayTime: time, tempoSync: 0, feedback: 0, driveGain: 0,
      lfoAmount: 0, driftAmount: 0, dryVolume: 0, wetVolume: 1,
      lowCut: 1, highCut: 0.001, duckAmount: 0,
    });
    const { L } = runProcessor(proc, params, 0.3, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(L, 1);
    const expected = time * SR;
    expect(pk).toBeGreaterThan(expected * 0.4);
    expect(pk).toBeLessThan(expected * 1.6);
  });

  it('feedback produces a decaying train of repeats; higher feedback = louder later repeats', async () => {
    const Proc = await loadProcessor();
    const base = {
      delayTime: 0.05, tempoSync: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0, stereoOffset: 0,
    };
    const { L: low } = runProcessor(new Proc(), makeParams({ ...base, feedback: 0.3 }), 0.4, (n) => (n === 0 ? 1 : 0));
    const { L: high } = runProcessor(new Proc(), makeParams({ ...base, feedback: 0.7 }), 0.4, (n) => (n === 0 ? 1 : 0));
    const tailStart = Math.round(0.2 * SR);
    const tail = (b: Float32Array) => { let e = 0; for (let i = tailStart; i < b.length; i++) e += b[i]! * b[i]!; return e; };
    expect(tail(high)).toBeGreaterThan(tail(low));
    expect(tail(low)).toBeGreaterThan(0);
  });

  it('tempo sync = 1/4 locks delay time to one measured clock period', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const periodSamples = Math.round(0.12 * SR);
    const params = makeParams({
      tempoSync: 6, feedback: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      delayTime: 0.5,
    });
    const impulseAt = Math.round(0.55 * SR);
    const { L } = runProcessor(
      proc, params, 1.0,
      (n) => (n === impulseAt ? 1 : 0),
      (n) => (n % periodSamples === 0 ? 1 : 0),
    );
    const pk = peakIndex(L, impulseAt + 1);
    const echoDelay = pk - impulseAt;
    expect(echoDelay).toBeGreaterThan(periodSamples * 0.5);
    expect(echoDelay).toBeLessThan(periodSamples * 1.6);
    expect(echoDelay).toBeLessThan(0.5 * SR * 0.8); // not the free-running fallback
  });

  it('syncPeriod (bridged System/MIDI beat) drives the synced delay when NO clock gate is patched', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const beatS = 0.15;
    const params = makeParams({
      tempoSync: 6, syncPeriod: beatS,
      feedback: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      delayTime: 0.5,
    });
    const { L } = runProcessor(proc, params, 0.6, (n) => (n === 1 ? 1 : 0));
    const pk = peakIndex(L, 2);
    const echoDelay = pk - 1;
    const expected = beatS * SR;
    expect(echoDelay).toBeGreaterThan(expected * 0.5);
    expect(echoDelay).toBeLessThan(expected * 1.6);
    expect(echoDelay).toBeLessThan(0.5 * SR * 0.8);
  });

  it('a PATCHED clock gate OVERRIDES the bridged syncPeriod', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const periodSamples = Math.round(0.1 * SR);
    const params = makeParams({
      tempoSync: 6, syncPeriod: 0.4,
      feedback: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      delayTime: 0.5,
    });
    const impulseAt = Math.round(0.55 * SR);
    const { L } = runProcessor(
      proc, params, 1.0,
      (n) => (n === impulseAt ? 1 : 0),
      (n) => (n % periodSamples === 0 ? 1 : 0),
    );
    const pk = peakIndex(L, impulseAt + 1);
    const echoDelay = pk - impulseAt;
    expect(echoDelay).toBeGreaterThan(periodSamples * 0.5);
    expect(echoDelay).toBeLessThan(periodSamples * 1.6);
    expect(echoDelay).toBeLessThan(0.4 * SR * 0.8); // not the 400 ms bridged period
  });

  it('tempoSync = Off ignores syncPeriod and uses the free-running TIME knob', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const time = 0.1;
    const params = makeParams({
      tempoSync: 0, syncPeriod: 0.4, delayTime: time,
      feedback: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
    });
    const { L } = runProcessor(proc, params, 0.3, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(L, 1);
    const expected = time * SR;
    expect(pk).toBeGreaterThan(expected * 0.4);
    expect(pk).toBeLessThan(expected * 1.6);
  });

  it('ducking attenuates the wet while the dry input is loud', async () => {
    const Proc = await loadProcessor();
    const base = {
      delayTime: 0.05, tempoSync: 0, feedback: 0.5, driveGain: 0, lfoAmount: 0,
      driftAmount: 0, dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001,
      duckAttack: 5, duckRelease: 5,
    };
    const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.8;
    const { L: unducked } = runProcessor(new Proc(), makeParams({ ...base, duckAmount: 0 }), 0.5, tone);
    const { L: ducked } = runProcessor(new Proc(), makeParams({ ...base, duckAmount: 10 }), 0.5, tone);
    const rms = (b: Float32Array) => {
      let s = 0; const from = Math.round(0.2 * SR);
      for (let i = from; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / (b.length - from));
    };
    expect(rms(ducked)).toBeLessThan(rms(unducked) * 0.85);
  });

  it('drive saturation changes the wet signal (vs drive off)', async () => {
    const Proc = await loadProcessor();
    const base = {
      delayTime: 0.05, tempoSync: 0, feedback: 0.4, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      driveMix: 1, driveCutoff: 1, driveIterations: 4,
    };
    const tone = (n: number) => Math.sin((2 * Math.PI * 110 * n) / SR) * 0.9;
    const { L: c } = runProcessor(new Proc(), makeParams({ ...base, driveGain: 0 }), 0.5, tone);
    const { L: d } = runProcessor(new Proc(), makeParams({ ...base, driveGain: 6 }), 0.5, tone);
    let diff = 0; const from = Math.round(0.2 * SR);
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
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i]!)).toBe(true);
  });

  it('with default patch (mono in, stereoOffset 0, pan 0) outL == outR', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({}); // shipping defaults
    const { L, R } = runProcessor(proc, params, 0.3, (n) => (n < 0.06 * SR ? Math.sin((2 * Math.PI * 261.6 * n) / SR) * 0.6 : 0));
    for (let i = 0; i < L.length; i++) expect(L[i]).toBe(R[i]);
  });
});

describe('clockSource → seconds-per-beat resolution (WEB layer bridge)', () => {
  type Nodes = Record<string, { type?: string; params?: Record<string, unknown> } | undefined>;

  it('reads TIMELORDE bpm off the live graph; defaults to 120 with no TIMELORDE', () => {
    expect(readTimelordeBpm({})).toBe(120);
    const nodes: Nodes = { a: { type: 'timelorde', params: { bpm: 140 } } };
    expect(readTimelordeBpm(nodes)).toBe(140);
  });

  it('System source → seconds-per-beat = 60 / TIMELORDE bpm', () => {
    const nodes: Nodes = { tl: { type: 'timelorde', params: { bpm: 120 } } };
    expect(resolveSyncPeriodS(0, nodes, 0.123)).toBeCloseTo(0.5, 6);
    const nodes2: Nodes = { tl: { type: 'timelorde', params: { bpm: 60 } } };
    expect(resolveSyncPeriodS(0, nodes2, null)).toBeCloseTo(1.0, 6);
  });

  it('MIDI source → uses the MIDI-clock-derived beat period (NOT TIMELORDE)', () => {
    const nodes: Nodes = { tl: { type: 'timelorde', params: { bpm: 120 } } };
    expect(resolveSyncPeriodS(1, nodes, 0.4)).toBeCloseTo(0.4, 6);
    expect(resolveSyncPeriodS(1, nodes, 0.4)).not.toBeCloseTo(0.5, 3);
  });

  it('MIDI source with no live clock → 0 (worklet falls back to free knob)', () => {
    expect(resolveSyncPeriodS(1, {}, null)).toBe(0);
    expect(resolveSyncPeriodS(1, {}, 0)).toBe(0);
  });
});
