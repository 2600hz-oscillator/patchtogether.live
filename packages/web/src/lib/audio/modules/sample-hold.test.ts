// packages/web/src/lib/audio/modules/sample-hold.test.ts
//
// Two test layers for SAMPLE & HOLD:
//   1. Module-def shape — cv_in/gate_in inputs, cv_out/cv_quant outputs, the
//      scale param (range/default), the re-exported scale names.
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class) and drive process():
//        * gateConnected=1: a rising edge on gate_in latches cv_in; the value
//          holds until the next edge; cv_quant snaps to the scale.
//        * gateConnected=0: cv_out tracks cv_in continuously (pure quantizer);
//          cv_quant continuously quantizes the live input.

import { describe, it, expect, beforeAll } from 'vitest';
import { sampleHoldDef, SAMPLE_HOLD_SCALE_NAMES, SAMPLE_HOLD_MAX_SCALE } from './sample-hold';
import { SAMPLE_HOLD_SCALES } from '../../../../../dsp/src/lib/sample-hold-dsp';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ── Layer 1: module-def shape ──
describe('sampleHold / module def', () => {
  it('declares cv_in + gate_in inputs', () => {
    const ids = sampleHoldDef.inputs.map((p) => p.id);
    expect(ids).toEqual(['cv_in', 'gate_in']);
    expect(sampleHoldDef.inputs.find((p) => p.id === 'cv_in')!.type).toBe('cv');
    expect(sampleHoldDef.inputs.find((p) => p.id === 'gate_in')!.type).toBe('gate');
  });

  it('declares cv_out + cv_quant outputs (both cv)', () => {
    const ids = sampleHoldDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['cv_out', 'cv_quant']);
    for (const p of sampleHoldDef.outputs) expect(p.type).toBe('cv');
  });

  it('has a discrete SCALE param spanning the scale table, default = Major', () => {
    const scale = sampleHoldDef.params.find((p) => p.id === 'scale')!;
    expect(scale.curve).toBe('discrete');
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(SAMPLE_HOLD_MAX_SCALE);
    // default 1 = Major (index 1 in the table; index 0 = Chromatic).
    expect(SAMPLE_HOLD_SCALE_NAMES[scale.defaultValue]).toBe('Major');
  });

  it('re-exports the scale names in table order', () => {
    expect(SAMPLE_HOLD_SCALE_NAMES).toEqual(SAMPLE_HOLD_SCALES.map((s) => s.name));
  });

  it('is registered in the utility category as type sampleHold', () => {
    expect(sampleHoldDef.type).toBe('sampleHold');
    expect(sampleHoldDef.category).toBe('utility');
    expect(sampleHoldDef.label).toBe('sample & hold');
  });
});

// ── Layer 2: real worklet processor behavior ──
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new (opts?: { processorOptions?: unknown }) => ProcInstance;

let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/sample-hold');
  g.registerProcessor = prev;
  if (!registered) throw new Error('sample-hold processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function params(scale: number, gateConnected: number): Record<string, Float32Array> {
  return {
    scale: new Float32Array([scale]),
    gateConnected: new Float32Array([gateConnected]),
  };
}

function block(values?: number[]): Float32Array {
  const b = new Float32Array(BLOCK);
  if (values) for (let i = 0; i < BLOCK; i++) b[i] = values[i] ?? values[values.length - 1]!;
  return b;
}

/** Run one process() block; returns the two output channels. */
function run(
  proc: ProcInstance,
  cvIn: Float32Array,
  gateIn: Float32Array,
  p: Record<string, Float32Array>,
): { cvOut: Float32Array; quant: Float32Array } {
  const cvOut = new Float32Array(BLOCK);
  const quant = new Float32Array(BLOCK);
  proc.process([[cvIn], [gateIn]], [[cvOut], [quant]], p);
  return { cvOut, quant };
}

describe('sampleHold / worklet — sample & hold (gate connected)', () => {
  const major = SAMPLE_HOLD_SCALES.findIndex((s) => s.id === 'major');

  it('latches cv_in on a rising edge and HOLDS it through the block', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const p = params(major, 1);

    // cv constant 0.7; gate low for first half, rises at the midpoint.
    const cv = block([0.7]);
    const gate = new Float32Array(BLOCK);
    for (let i = BLOCK / 2; i < BLOCK; i++) gate[i] = 1;

    const { cvOut } = run(proc, cv, gate, p);
    // Before the edge: held value is the initial 0 (no latch yet).
    expect(cvOut[0]).toBeCloseTo(0, 6);
    // After the edge (and onward): latched 0.7.
    expect(cvOut[BLOCK - 1]).toBeCloseTo(0.7, 6);
  });

  it('HOLDS the latched value across a later cv change with no new edge', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const p = params(major, 1);

    // Block 1: rising edge with cv=0.5 → latch 0.5 (gate stays high).
    const g1 = block([1]);
    run(proc, block([0.5]), g1, p);
    // Block 2: cv changes to 0.9 but gate stays HIGH (no new rising edge).
    const { cvOut } = run(proc, block([0.9]), block([1]), p);
    expect(cvOut[BLOCK - 1]).toBeCloseTo(0.5, 6); // STILL 0.5
  });

  it('cv_quant snaps the held value to the selected scale', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const p = params(major, 1);
    // Latch 0.04 V (just under C#) — major scale → quant should be 0 (C).
    const g = block([1]);
    const { quant } = run(proc, block([0.04]), g, p);
    expect(quant[BLOCK - 1]).toBeCloseTo(0, 5);
  });
});

describe('sampleHold / worklet — pure quantizer (gate unpatched)', () => {
  const chromatic = SAMPLE_HOLD_SCALES.findIndex((s) => s.id === 'chromatic');

  it('passes cv_in through continuously (cv_out tracks the live input)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const p = params(chromatic, 0); // gate NOT connected
    // A ramp on cv_in; gate is irrelevant (ignored).
    const cv = block();
    for (let i = 0; i < BLOCK; i++) cv[i] = i / BLOCK; // 0..~1
    const { cvOut } = run(proc, cv, block([0]), p);
    expect(cvOut[0]).toBeCloseTo(cv[0]!, 6);
    expect(cvOut[BLOCK - 1]).toBeCloseTo(cv[BLOCK - 1]!, 6);
  });

  it('continuously quantizes the live input to the scale grid', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const p = params(chromatic, 0);
    // cv = 0.05 V ≈ 0.6 semitone → chromatic nearest is 1 semitone = 1/12 V.
    const { quant } = run(proc, block([0.05]), block([0]), p);
    expect(quant[BLOCK - 1]).toBeCloseTo(1 / 12, 5);
  });
});
