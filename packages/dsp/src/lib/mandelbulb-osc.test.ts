// packages/dsp/src/lib/mandelbulb-osc.test.ts
//
// Behavioral test for the MANDELBULB-OSC worklet. The worklet entry NEVER
// top-level-exports its Processor class (that would leak into the ESM bundle +
// break ART's classic-script eval), so we capture it via a registerProcessor
// shim (the cube.test.ts pattern), install a stub MessagePort, deliver a
// {type:'setWave'} message, and drive process(): a posted slice waveform plays
// at pitch * level; an osc with no posted wave is silent.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mbSampleSlice } from './mandelbulb-slice';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../mandelbulb-osc');
  g.registerProcessor = prev;
  if (!registered) throw new Error('mandelbulb-osc processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = { tune: 0, fine: 0, level: 1, ...over };
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

function makeIO(): { inputs: Float32Array[][]; outputs: Float32Array[][] } {
  return {
    inputs: [[new Float32Array(BLOCK)]],          // pitch (0V = C4)
    outputs: [[new Float32Array(BLOCK)]],         // mono out
  };
}

describe('mandelbulb-osc worklet', () => {
  it('is silent until a slice waveform is posted', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const { inputs, outputs } = makeIO();
    p.process(inputs, outputs, makeParams());
    expect(outputs[0]![0]!.every((s) => s === 0)).toBe(true);
  });

  it('plays a posted slice waveform → nonzero output', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // A real bulb-slice waveform (the exact contract the factory posts).
    const wave = mbSampleSlice({ sliceY: 0, rx: 0.3, ry: 0.5, rz: 0.1, power: 8, iters: 20 });
    p.port.onmessage?.({ data: { type: 'setWave', wave } });
    const { inputs, outputs } = makeIO();
    // Drive a few blocks so the phase accumulates across the frame.
    let energy = 0;
    for (let b = 0; b < 8; b++) {
      outputs[0]![0]!.fill(0);
      p.process(inputs, outputs, makeParams());
      for (const s of outputs[0]![0]!) energy += Math.abs(s);
    }
    expect(energy).toBeGreaterThan(0);
  });

  it('level scales the output (level=0 → silent even with a wave posted)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const wave = mbSampleSlice({ sliceY: 0, rx: 0.3, ry: 0.5, rz: 0.1, power: 8, iters: 20 });
    p.port.onmessage?.({ data: { type: 'setWave', wave } });
    const { inputs, outputs } = makeIO();
    for (let b = 0; b < 4; b++) p.process(inputs, outputs, makeParams({ level: 0 }));
    expect(outputs[0]![0]!.every((s) => s === 0)).toBe(true);
  });

  it('output stays bounded (clamped within ±4) across pitch + level extremes', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const wave = mbSampleSlice({ sliceY: 0, rx: 0, ry: 0, rz: 0, power: 8, iters: 20 });
    p.port.onmessage?.({ data: { type: 'setWave', wave } });
    const inputs = [[new Float32Array(BLOCK).fill(2)]]; // +2V ≈ 4 octaves up
    const outputs = [[new Float32Array(BLOCK)]];
    for (let b = 0; b < 4; b++) p.process(inputs, outputs, makeParams({ level: 2 }));
    for (const s of outputs[0]![0]!) {
      expect(Number.isFinite(s)).toBe(true);
      expect(Math.abs(s)).toBeLessThanOrEqual(4);
    }
  });
});

// The setWave SWAP crossfade (anti-click for VIDEOCUBE's bold colour changes). The
// single-wave setWave contract is UNCHANGED, so MANDELBULB is behaviourally
// identical: the FIRST wave plays immediately (no fade-in), and re-posting the same
// wave is a byte-exact no-op — only a genuine SWAP ramps, over ~10 ms, click-free.
describe('mandelbulb-osc anti-click crossfade', () => {
  const constWave = (v: number) => new Float32Array(256).fill(v);
  const io = () => ({ inputs: [[new Float32Array(BLOCK)]], outputs: [[new Float32Array(BLOCK)]] });

  it('the FIRST wave plays IMMEDIATELY (no fade-in from silence — MANDELBULB identity)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    p.port.onmessage?.({ data: { type: 'setWave', wave: constWave(0.5) } });
    const { inputs, outputs } = io();
    p.process(inputs, outputs, makeParams());
    // The very first block is already at full amplitude (a fade-in would ramp 0→0.5).
    expect(outputs[0]![0]!.every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true);
  });

  it('a wave SWAP is CLICK-FREE (bounded sample-to-sample delta) and converges to the new wave', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    p.port.onmessage?.({ data: { type: 'setWave', wave: constWave(0.5) } });
    // Settle on wave1 (constant 0.5).
    let last = 0.5;
    for (let b = 0; b < 2; b++) { const { inputs, outputs } = io(); p.process(inputs, outputs, makeParams()); last = outputs[0]![0]![BLOCK - 1]!; }
    expect(Math.abs(last - 0.5)).toBeLessThan(1e-6);

    // SWAP to a very different wave: a HARD swap would step by ~1.0 in ONE sample.
    p.port.onmessage?.({ data: { type: 'setWave', wave: constWave(-0.5) } });
    const seq: number[] = [last]; // seed the boundary
    for (let b = 0; b < 8; b++) { const { inputs, outputs } = io(); p.process(inputs, outputs, makeParams()); for (const s of outputs[0]![0]!) seq.push(s); }
    let maxDelta = 0;
    for (let i = 1; i < seq.length; i++) maxDelta = Math.max(maxDelta, Math.abs(seq[i]! - seq[i - 1]!));
    // ~10 ms ramp spreads the 1.0 change over ~480 samples → per-step ≪ a click.
    expect(maxDelta, `click-free: max step ${maxDelta.toFixed(4)} ≪ 1.0`).toBeLessThan(0.02);
    // The fade completes (≈480 samples < 8 blocks) → plays wave2 exactly.
    expect(Math.abs(seq[seq.length - 1]! - (-0.5))).toBeLessThan(1e-3);
  });

  it('re-posting the SAME wave is a byte-exact NO-OP (identical output vs never re-posting)', async () => {
    const Proc = await loadProcessor();
    const wave = mbSampleSlice({ sliceY: 0.2, rx: 0.3, ry: 0.5, rz: 0.1, power: 8, iters: 20 });
    const a = new Proc(); a.port.onmessage?.({ data: { type: 'setWave', wave: Float32Array.from(wave) } });
    const b = new Proc(); b.port.onmessage?.({ data: { type: 'setWave', wave: Float32Array.from(wave) } });
    const pitch = [[new Float32Array(BLOCK).fill(0)]];
    for (let blk = 0; blk < 6; blk++) {
      if (blk === 2) b.port.onmessage?.({ data: { type: 'setWave', wave: Float32Array.from(wave) } }); // identical re-post
      const oa = [[new Float32Array(BLOCK)]];
      const ob = [[new Float32Array(BLOCK)]];
      a.process(pitch, oa, makeParams());
      b.process(pitch, ob, makeParams());
      for (let i = 0; i < BLOCK; i++) expect(ob[0]![0]![i]).toBe(oa[0]![0]![i]);
    }
  });
});
