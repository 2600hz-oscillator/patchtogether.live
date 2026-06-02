// packages/web/src/lib/audio/modules/moog-cp3.test.ts
//
// Two test layers for the MOOG CP3 console mixer:
//   1. Module-def shape — pins the CP3's I/O surface (in1..in4 + ext4 inputs;
//      the (+)/(−) outputs, the 1→3 MULTIPLE outs, the ±reference outs; the
//      literal param array) so a refactor that silently drops a port fails
//      loudly (the per-module-per-port regression-net class of bug).
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process(): a signal on in1 sums to the (+) bus, the (−)
//      bus is its phase-inverse, the MULTIPLE passes in1 through 1→3, the 4th
//      input is attenuated, and the ±reference outs are the constant rails.

import { describe, it, expect, beforeAll } from 'vitest';
import { moogCp3Def } from './moog-cp3';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moogCp3Def: module def shape', () => {
  it('declares type=moogCp3, label="Moog CP3 Mixer", category=utilities, schemaVersion=1', () => {
    expect(moogCp3Def.type).toBe('moogCp3');
    expect(moogCp3Def.label).toBe('Moog CP3 Mixer');
    expect(moogCp3Def.category).toBe('utilities');
    expect(moogCp3Def.schemaVersion).toBe(1);
  });

  it('exposes the five inputs: in1..in4 + ext4', () => {
    const ids = moogCp3Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['in1', 'in2', 'in3', 'in4', 'ext4']);
  });

  it('in1..in4 are audio cables; ext4 is a cv cable (signal being mixed)', () => {
    for (const id of ['in1', 'in2', 'in3', 'in4']) {
      expect(moogCp3Def.inputs.find((p) => p.id === id)!.type).toBe('audio');
    }
    const ext4 = moogCp3Def.inputs.find((p) => p.id === 'ext4')!;
    expect(ext4.type).toBe('cv');
    // ext4 is the signal being attenuated, not a knob modulator → no cvScale.
    expect(ext4.cvScale).toBeUndefined();
    expect(ext4.paramTarget).toBeUndefined();
  });

  it('exposes the (+)/(−) outputs, the 1→3 MULTIPLE, and the ±ref outs', () => {
    const ids = moogCp3Def.outputs.map((p) => p.id);
    expect(ids).toEqual([
      'out_positive', 'out_negative',
      'multiple_one', 'multiple_two', 'multiple_three',
      'plus_twelve', 'minus_six',
    ]);
  });

  it('(+)/(−)/MULTIPLE outs are audio; ±ref outs are cv', () => {
    for (const id of ['out_positive', 'out_negative', 'multiple_one', 'multiple_two', 'multiple_three']) {
      expect(moogCp3Def.outputs.find((p) => p.id === id)!.type).toBe('audio');
    }
    for (const id of ['plus_twelve', 'minus_six']) {
      expect(moogCp3Def.outputs.find((p) => p.id === id)!.type).toBe('cv');
    }
  });

  it('exposes 5 params (ch1..ch4 + attenuator4), all linear 0..1 default 1', () => {
    const ids = moogCp3Def.params.map((p) => p.id);
    expect(ids).toEqual(['ch1', 'ch2', 'ch3', 'ch4', 'attenuator4']);
    for (const p of moogCp3Def.params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(1);
      expect(p.curve).toBe('linear');
    }
  });
});

// ───────────────────── Layer 2: real worklet DSP ─────────────────────
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/moog-cp3');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog-cp3 processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a params map (a-rate single-value buffers) from defaults + overrides. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moogCp3Def.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Seven mono outputs, one block each. */
function makeOutputs(): Float32Array[][] {
  return Array.from({ length: 7 }, () => [new Float32Array(BLOCK)]);
}

/** Five inputs (in1..in4, ext4), each filled with a constant value. */
function makeInputs(v: { in1?: number; in2?: number; in3?: number; in4?: number; ext4?: number } = {}): Float32Array[][] {
  return [
    [new Float32Array(BLOCK).fill(v.in1 ?? 0)],
    [new Float32Array(BLOCK).fill(v.in2 ?? 0)],
    [new Float32Array(BLOCK).fill(v.in3 ?? 0)],
    [new Float32Array(BLOCK).fill(v.in4 ?? 0)],
    [new Float32Array(BLOCK).fill(v.ext4 ?? 0)],
  ];
}

/** Run the processor for N blocks so the param smoothers settle. */
function settle(proc: ProcInstance, inputs: Float32Array[][], params: Record<string, Float32Array>, blocks = 80): Float32Array[][] {
  let outputs = makeOutputs();
  for (let b = 0; b < blocks; b++) {
    outputs = makeOutputs();
    proc.process(inputs, outputs, params);
  }
  return outputs;
}

describe('moog-cp3 worklet DSP', () => {
  it('sums four DC channels onto the (+) bus at default unity (×2) gains', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    // Default ch knobs = 1 → ×2 gain each. (0.1 + 0.2 + 0.05 + 0.15) × 2 = 1.0
    const outputs = settle(proc, makeInputs({ in1: 0.1, in2: 0.2, in3: 0.05, in4: 0.15 }), makeParams());
    expect(outputs[0][0][BLOCK - 1]).toBeCloseTo(1.0, 3);
  });

  it('the (−) output is the exact phase-inverse of the (+) output', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const outputs = settle(proc, makeInputs({ in1: 0.3, in2: -0.1, in3: 0.2 }), makeParams());
    const pos = outputs[0][0][BLOCK - 1];
    const neg = outputs[1][0][BLOCK - 1];
    expect(neg).toBeCloseTo(-pos, 6);
  });

  it('the MULTIPLE fans in1 out to all three multiple outs unaltered', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const outputs = settle(proc, makeInputs({ in1: 0.37, in2: 0.9 }), makeParams());
    expect(outputs[2][0][BLOCK - 1]).toBeCloseTo(0.37, 6); // mult1
    expect(outputs[3][0][BLOCK - 1]).toBeCloseTo(0.37, 6); // mult2
    expect(outputs[4][0][BLOCK - 1]).toBeCloseTo(0.37, 6); // mult3
  });

  it('the 4th input sums in4 + ext4, scaled by the attenuator', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    // Only ch4 open (knob 0.5 → unity gain). in4=0.4, ext4=0.6, attenuator 0.5
    // → ch4 bus = (0.4 + 0.6) × 0.5 = 0.5.
    const params = makeParams({ ch1: 0, ch2: 0, ch3: 0, ch4: 0.5, attenuator4: 0.5 });
    const outputs = settle(proc, makeInputs({ in4: 0.4, ext4: 0.6 }), params);
    expect(outputs[0][0][BLOCK - 1]).toBeCloseTo(0.5, 3);
  });

  it('attenuator at unity (1.0) passes a direct external patch through unaltered', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ ch1: 0, ch2: 0, ch3: 0, ch4: 0.5, attenuator4: 1 });
    const outputs = settle(proc, makeInputs({ ext4: 0.42 }), params);
    expect(outputs[0][0][BLOCK - 1]).toBeCloseTo(0.42, 3);
  });

  it('emits the constant ±reference rails on plus_twelve / minus_six', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const outputs = settle(proc, makeInputs(), makeParams(), 4);
    expect(outputs[5][0][BLOCK - 1]).toBeCloseTo(2.4, 6);  // +12V → +2.4
    expect(outputs[6][0][BLOCK - 1]).toBeCloseTo(-1.2, 6); // −6V → −1.2
  });

  it('produces no NaN / Inf samples', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ attenuator4: 0.7 });
    for (let b = 0; b < 16; b++) {
      const outputs = makeOutputs();
      proc.process(makeInputs({ in1: 0.5, in2: -0.5, in3: 0.25, in4: 0.1, ext4: -0.2 }), outputs, params);
      for (const ch of outputs) {
        for (const v of ch[0]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
