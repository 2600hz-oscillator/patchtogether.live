// packages/web/src/lib/audio/modules/charlottes-echos.test.ts
//
// CHARLOTTE'S ECHOS — now a 4× Cocoa Delay cascade. Tests assert:
//   • the module def is UNCHANGED (id + ports + params) so old patches load.
//   • signal passes through all 4 stages and the first full-wet echo lands
//     at ≈ the SUM of the four stage delays (≈ 4 × delay).
//   • feedback + decay behave sensibly; output stays finite at extremes.

import { describe, it, expect, beforeAll } from 'vitest';
import { charlottesEchosDef } from './charlottes-echos';

const SR = 48000;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// The worklet entry no longer `export`s its processor class (a top-level
// export pollutes the bundled dist worklet → breaks the ART classic-script
// eval). Capture the class via its registerProcessor side-effect instead,
// mirroring the ART harness. Cached after the first (module-side-effecting)
// import.
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
  await import('../../../../../dsp/src/charlottes-echos');
  g.registerProcessor = prev;
  if (!registered) throw new Error('charlottes-echos processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {
    delay: 0.4, feedback: 0.5, decay: 0.2, pitchUp: 0, mix: 0.5,
  };
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

const BLOCK = 128;

function runProcessor(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  seconds: number,
  inputFn: (n: number) => number,
): { L: Float32Array; R: Float32Array } {
  const total = Math.round(SR * seconds);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const inL = new Float32Array(len);
    const inR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = inputFn(g + i);
      inL[i] = v;
      inR[i] = v;
    }
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    proc.process([[inL], [inR]], [[outL], [outR]], params);
    L.set(outL, g);
    R.set(outR, g);
    g += len;
  }
  return { L, R };
}

function firstEchoIndex(buf: Float32Array, threshold: number, from: number): number {
  for (let i = from; i < buf.length; i++) {
    if (Math.abs(buf[i]!) > threshold) return i;
  }
  return -1;
}

describe('charlottesEchosDef shape (backward compat)', () => {
  it('keeps the stable module id', () => {
    expect(charlottesEchosDef.type).toBe('charlottesEchos');
  });
  it('keeps L/R audio ports + the delay CV input', () => {
    expect(charlottesEchosDef.inputs.map((p) => p.id)).toEqual(['L', 'R', 'delay']);
    expect(charlottesEchosDef.outputs.map((p) => p.id)).toEqual(['L', 'R']);
  });
  it('keeps the original 5 params (delay/feedback/decay/pitchUp/mix)', () => {
    expect(charlottesEchosDef.params.map((p) => p.id)).toEqual([
      'delay', 'feedback', 'decay', 'pitchUp', 'mix',
    ]);
  });
});

describe('charlottesEchos 4-stage cascade DSP', () => {
  it('first full-wet echo lands near the SUM of the 4 stage delays (≈ 4 × delay)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const delay = 0.08; // 80 ms per stage → cascade ≈ 320 ms
    // Fully wet, no feedback, no decay-drive so the impulse stays clean and
    // we can see the cascade's first emergence.
    const params = makeParams({ delay, feedback: 0, decay: 0, pitchUp: 0, mix: 1 });
    const { L } = runProcessor(proc, params, 0.8, (n) => (n === 0 ? 1 : 0));
    const idx = firstEchoIndex(L, 0.02, 1);
    expect(idx).toBeGreaterThan(0);
    const echoSec = idx / SR;
    const sum = delay * 4;
    // Hermite + read-position easing smear the onset; allow a wide window
    // but require it to be clearly past a single stage (≈ delay).
    expect(echoSec).toBeGreaterThan(delay * 1.5); // definitely multi-stage
    expect(echoSec).toBeGreaterThan(sum * 0.45);
    expect(echoSec).toBeLessThan(sum * 1.7);
  });

  it('signal energy passes through to the output (all 4 stages connected)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const tone = (n: number) => Math.sin((2 * Math.PI * 200 * n) / SR) * 0.5;
    const { L } = runProcessor(proc, makeParams({ delay: 0.05, feedback: 0.4, mix: 1 }), 0.6, tone);
    let e = 0;
    const from = Math.round(0.3 * SR);
    for (let i = from; i < L.length; i++) e += L[i]! * L[i]!;
    expect(e).toBeGreaterThan(0);
  });

  it('higher feedback => more energy in the long tail', async () => {
    const Proc = await loadProcessor();
    const tone = (n: number) => (n < SR * 0.05 ? Math.sin((2 * Math.PI * 200 * n) / SR) * 0.6 : 0);
    const low = new Proc();
    const high = new Proc();
    const { L: lo } = runProcessor(low, makeParams({ delay: 0.06, feedback: 0.2, decay: 0.1, mix: 1 }), 1.0, tone);
    const { L: hi } = runProcessor(high, makeParams({ delay: 0.06, feedback: 0.8, decay: 0.1, mix: 1 }), 1.0, tone);
    const tailStart = Math.round(0.6 * SR);
    const energy = (b: Float32Array) => {
      let e = 0;
      for (let i = tailStart; i < b.length; i++) e += b[i]! * b[i]!;
      return e;
    };
    expect(energy(hi)).toBeGreaterThan(energy(lo));
  });

  it('stays finite at extreme feedback + decay', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const tone = (n: number) => (n < SR * 0.1 ? Math.sin((2 * Math.PI * 150 * n) / SR) * 0.7 : 0);
    const { L, R } = runProcessor(proc, makeParams({ delay: 0.03, feedback: 1, decay: 0.5, pitchUp: 0.2, mix: 1 }), 1.5, tone);
    for (let i = 0; i < L.length; i++) {
      expect(Number.isFinite(L[i]!)).toBe(true);
      expect(Number.isFinite(R[i]!)).toBe(true);
    }
  });

  it('stays bounded at feedback = 1 with NO drive limiting (decay = 0)', async () => {
    // Worst case: feedback=1, decay=0 → driveGain=0 so the saturation stage
    // is bypassed; the only loss is the in-loop low-cut filter + the ±2 write
    // clamp. Assert the tail doesn't grow without bound.
    const Proc = await loadProcessor();
    const proc = new Proc();
    const tone = (n: number) => (n < SR * 0.05 ? Math.sin((2 * Math.PI * 200 * n) / SR) * 0.6 : 0);
    const { L } = runProcessor(proc, makeParams({ delay: 0.04, feedback: 1, decay: 0, pitchUp: 0, mix: 1 }), 2.0, tone);
    let maxAbs = 0;
    for (let i = 0; i < L.length; i++) {
      expect(Number.isFinite(L[i]!)).toBe(true);
      maxAbs = Math.max(maxAbs, Math.abs(L[i]!));
    }
    // Output rides the ±2 internal clamp at most; assert it never blows past it.
    expect(maxAbs).toBeLessThanOrEqual(2.0001);
  });

  it('mix = 0 is fully dry (output equals input)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const tone = (n: number) => Math.sin((2 * Math.PI * 300 * n) / SR) * 0.4;
    const { L } = runProcessor(proc, makeParams({ mix: 0 }), 0.3, tone);
    for (let i = 0; i < L.length; i++) {
      expect(L[i]!).toBeCloseTo(tone(i), 5);
    }
  });
});
