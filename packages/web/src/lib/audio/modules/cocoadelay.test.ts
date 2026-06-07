// packages/web/src/lib/audio/modules/cocoadelay.test.ts
//
// Two test layers:
//   1. Module-def shape (ports / params / CV targets / category).
//   2. Real DSP behavior — instantiate the worklet processor class directly
//      and drive process() to assert delay time, feedback decay, tempo-sync
//      mapping, ducking envelope, and drive saturation.

import { describe, it, expect, beforeAll } from 'vitest';
import { cocoaDelayDef, readTimelordeBpm, resolveSyncPeriodS } from './cocoadelay';

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
  it('is an effects-section module with id cocoadelay', () => {
    expect(cocoaDelayDef.type).toBe('cocoadelay');
    expect(cocoaDelayDef.label).toBe('cocoa delay');
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

  it('syncPeriod (bridged System/MIDI beat) drives the synced delay when NO clock gate is patched', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const beatS = 0.15; // seconds-per-beat bridged from the WEB layer
    const params = makeParams({
      tempoSync: 6,        // quarter note (SYNC_BEATS[6] === 1 beat)
      syncPeriod: beatS,
      feedback: 0, driveGain: 0, lfoAmount: 0, driftAmount: 0,
      dryVolume: 0, wetVolume: 1, lowCut: 1, highCut: 0.001, duckAmount: 0,
      delayTime: 0.5,      // free-running fallback DIFFERENT from synced time
    });
    const impulseAt = 1; // no clock-gate warm-up needed; period comes from param
    const { L } = runProcessor(proc, params, 0.6, (n) => (n === impulseAt ? 1 : 0));
    const pk = peakIndex(L, impulseAt + 1);
    const echoDelay = pk - impulseAt;
    const expected = beatS * SR;
    // Echo lands near the bridged beat period, NOT the 0.5s free-running knob.
    expect(echoDelay).toBeGreaterThan(expected * 0.5);
    expect(echoDelay).toBeLessThan(expected * 1.6);
    expect(echoDelay).toBeLessThan(0.5 * SR * 0.8);
  });

  it('a PATCHED clock gate OVERRIDES the bridged syncPeriod', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const periodSamples = Math.round(0.1 * SR); // 100 ms measured pulse period
    const params = makeParams({
      tempoSync: 6,
      syncPeriod: 0.4,     // bridged beat (would be 400 ms) — should LOSE
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
    // Echo tracks the MEASURED 100ms pulse, not the 400ms bridged syncPeriod.
    expect(echoDelay).toBeGreaterThan(periodSamples * 0.5);
    expect(echoDelay).toBeLessThan(periodSamples * 1.6);
    expect(echoDelay).toBeLessThan(0.4 * SR * 0.8); // not the bridged period
  });

  it('tempoSync = Off ignores syncPeriod and uses the free-running TIME knob', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const time = 0.1;
    const params = makeParams({
      tempoSync: 0,        // OFF
      syncPeriod: 0.4,     // present but must be ignored
      delayTime: time,
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

describe('clockSource → seconds-per-beat resolution (WEB layer bridge)', () => {
  type Nodes = Record<string, { type?: string; params?: Record<string, unknown> } | undefined>;

  it('reads TIMELORDE bpm off the live graph; defaults to 120 with no TIMELORDE', () => {
    expect(readTimelordeBpm({})).toBe(120);
    const nodes: Nodes = { a: { type: 'timelorde', params: { bpm: 140 } } };
    expect(readTimelordeBpm(nodes)).toBe(140);
  });

  it('System source → seconds-per-beat = 60 / TIMELORDE bpm', () => {
    const nodes: Nodes = { tl: { type: 'timelorde', params: { bpm: 120 } } };
    // clockSource 0 = System. MIDI period is irrelevant for System.
    expect(resolveSyncPeriodS(0, nodes, 0.123)).toBeCloseTo(0.5, 6); // 120bpm → 0.5s
    const nodes2: Nodes = { tl: { type: 'timelorde', params: { bpm: 60 } } };
    expect(resolveSyncPeriodS(0, nodes2, null)).toBeCloseTo(1.0, 6);
  });

  it('MIDI source → uses the MIDI-clock-derived beat period (NOT TIMELORDE)', () => {
    const nodes: Nodes = { tl: { type: 'timelorde', params: { bpm: 120 } } };
    // clockSource 1 = MIDI. TIMELORDE bpm in the graph must be ignored.
    expect(resolveSyncPeriodS(1, nodes, 0.4)).toBeCloseTo(0.4, 6); // 150bpm beat
    expect(resolveSyncPeriodS(1, nodes, 0.4)).not.toBeCloseTo(0.5, 3);
  });

  it('MIDI source with no live clock → 0 (worklet falls back to free knob)', () => {
    expect(resolveSyncPeriodS(1, {}, null)).toBe(0);
    expect(resolveSyncPeriodS(1, {}, 0)).toBe(0);
  });
});

describe('MIDI clock source singleton (0xF8 @ 24 PPQN → BPM)', () => {
  it('derives ~120 BPM from clocks spaced one quarter-note / 24 apart', async () => {
    const { createMidiClockSource } = await import('../../midi/midi-clock-source');
    let t = 1000;
    const src = createMidiClockSource({
      now: () => t,
      available: () => false, // skip real navigator.requestMIDIAccess
      requestAccess: () => Promise.reject(new Error('no midi in test')),
    });
    // 120 BPM → quarter = 500 ms → per-pulse = 500/24 ms.
    const pulseMs = 500 / 24;
    for (let i = 0; i < 48; i++) {
      src.ingest(0xf8, t);
      t += pulseMs;
    }
    const bpm = src.getBpm();
    expect(bpm).not.toBeNull();
    expect(bpm!).toBeCloseTo(120, 0);
    expect(src.getBeatPeriodS()!).toBeCloseTo(0.5, 2);
    src.destroy();
  });

  it('reports null when stale (no recent 0xF8) and after a Stop', async () => {
    const { createMidiClockSource } = await import('../../midi/midi-clock-source');
    let t = 0;
    const src = createMidiClockSource({
      now: () => t,
      available: () => false,
      requestAccess: () => Promise.reject(new Error('no midi')),
    });
    const pulseMs = 500 / 24;
    for (let i = 0; i < 48; i++) { src.ingest(0xf8, t); t += pulseMs; }
    expect(src.getBpm()).not.toBeNull();
    // Advance well past the stale timeout with no new pulses.
    t += 5000;
    expect(src.getBpm()).toBeNull();
    // Fresh pulses again, then a Stop clears the tempo.
    t += pulseMs;
    for (let i = 0; i < 48; i++) { src.ingest(0xf8, t); t += pulseMs; }
    expect(src.getBpm()).not.toBeNull();
    src.ingest(0xfc, t); // MIDI Stop
    expect(src.getBpm()).toBeNull();
    src.destroy();
  });
});

// The shared core gained an optional `readRate` varispeed multiplier (used by
// CHARLOTTE'S ECHOS for its per-stage pitch-rise). It MUST be a strict no-op
// when omitted or 1.0 so plain COCOA DELAY is bit-identical to before.
describe('CocoaDelayCore.readRate no-op (COCOA DELAY unaffected)', () => {
  it('readRate omitted === readRate=1.0, sample-for-sample', async () => {
    const { CocoaDelayCore } = await import('../../../../../dsp/src/cocoadelay-core');
    type CocoaSettings = Parameters<InstanceType<typeof CocoaDelayCore>['processSample']>[0];
    const baseSettings: CocoaSettings = {
      delayTime: 0.05, tempoSync: 0, lfoAmount: 0, lfoFrequency: 2, driftAmount: 0,
      driftSpeed: 1, feedback: 0.5, stereoOffset: 0, panMode: 0, pan: 0, duckAmount: 0,
      duckAttack: 10, duckRelease: 10, filterMode: 0, lowCut: 0.9, highCut: 0.001,
      driveGain: 0, driveMix: 1, driveCutoff: 1, driveIterations: 1, dryVolume: 0, wetVolume: 1,
    };
    const omitted = new CocoaDelayCore(SR, 2.0, 0);
    const unity = new CocoaDelayCore(SR, 2.0, 0);
    const N = SR; // 1 second
    for (let n = 0; n < N; n++) {
      const v = n < SR * 0.1 ? Math.sin((2 * Math.PI * 200 * n) / SR) * 0.5 : 0;
      omitted.processSample(baseSettings, v, v, SR);
      unity.processSample({ ...baseSettings, readRate: 1.0 }, v, v, SR);
      expect(unity.outL).toBe(omitted.outL);
      expect(unity.outR).toBe(omitted.outR);
    }
  });
});
