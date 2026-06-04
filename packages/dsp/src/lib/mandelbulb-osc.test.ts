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
