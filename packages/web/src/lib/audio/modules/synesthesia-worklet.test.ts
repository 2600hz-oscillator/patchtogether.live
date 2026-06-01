// packages/web/src/lib/audio/modules/synesthesia-worklet.test.ts
//
// Worklet-wrapper smoke test for packages/dsp/src/synesthesia.ts. The
// synesthesia-dsp.test.ts file proves the pure DSP maths; THIS file proves the
// AudioWorkletProcessor wiring — copy A/B independence and the per-band output
// channel layout — by capturing the class through the registerProcessor shim
// (the resofilter.test.ts pattern) and driving process() directly.

import { describe, it, expect, beforeAll } from 'vitest';

const SR = 48000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Processor: any;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = SR;
  // Capture the processor class the worklet registers on import.
  g.registerProcessor = (_name: string, ctor: unknown) => {
    Processor = ctor;
  };
  await import('../../../../../dsp/src/synesthesia');
});

const QUANTUM = 128;

function mkOutputs(): Float32Array[][] {
  // 8 outputs × 4 channels × 128 samples.
  return Array.from({ length: 8 }, () =>
    Array.from({ length: 4 }, () => new Float32Array(QUANTUM)),
  );
}

/** Run a sine into copy A's input for `blocks` quanta; copy B gets no input.
 *  Returns summed |x| energy per (output, band). */
function run(freqA: number, blocks: number): { out: number[][] } {
  const proc = new Processor();
  const energy: number[][] = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
  let phase = 0;
  for (let blk = 0; blk < blocks; blk++) {
    const inA = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) {
      inA[i] = 0.8 * Math.sin((2 * Math.PI * freqA * (phase + i)) / SR);
    }
    phase += QUANTUM;
    const inputs: Float32Array[][] = [[inA], []]; // input 0 = copy A; input 1 = none
    const outputs = mkOutputs();
    proc.process(inputs, outputs, {});
    for (let o = 0; o < 8; o++) {
      for (let b = 0; b < 4; b++) {
        let s = 0;
        const ch = outputs[o]![b]!;
        for (let i = 0; i < ch.length; i++) s += Math.abs(ch[i]!);
        energy[o]![b]! += s;
      }
    }
  }
  return { out: energy };
}

describe('synesthesia worklet — copy independence + band routing', () => {
  it('processes without throwing and isolates copy A from copy B', () => {
    // ~0.4 s of a 261 Hz tone into copy A only.
    const { out } = run(261, 150);
    const audioA = out[0]!; // worklet output 0 = copy A band audio (4ch)
    const audioB = out[1]!; // worklet output 1 = copy B band audio (4ch)

    // Copy A carries signal; copy B (no input 1) is exactly silent.
    expect(audioA.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(audioB.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('routes a 261 Hz tone to band 2 of copy A (channel index = band)', () => {
    const { out } = run(261, 150);
    const audioA = out[0]!;
    // band 2 (index 1) dominates the copy-A audio output.
    const max = Math.max(...audioA);
    expect(audioA[1]).toBe(max);
    expect(audioA[1]!).toBeGreaterThan(1.1 * Math.max(audioA[0]!, audioA[2]!, audioA[3]!));
  });

  it('drives copy A envelope/gate outputs, leaves copy B outputs silent', () => {
    const { out } = run(261, 150);
    // Outputs: 2=slowA 3=slowB 4=fastA 5=fastB 6=gateA 7=gateB.
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(out[2]!)).toBeGreaterThan(0); // env_slow A
    expect(sum(out[4]!)).toBeGreaterThan(0); // env_fast A
    expect(sum(out[6]!)).toBeGreaterThan(0); // gate A (band 2 crosses threshold)
    expect(sum(out[3]!)).toBe(0); // env_slow B
    expect(sum(out[5]!)).toBe(0); // env_fast B
    expect(sum(out[7]!)).toBe(0); // gate B
  });
});
