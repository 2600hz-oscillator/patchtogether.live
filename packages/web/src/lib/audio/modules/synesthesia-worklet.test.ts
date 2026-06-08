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
const NUM_OUT = 10; // 0/1 audio, 2/3 slow, 4/5 fast, 6/7 gate, 8/9 trig (A/B)

function mkOutputs(): Float32Array[][] {
  // 10 outputs × 4 channels × 128 samples.
  return Array.from({ length: NUM_OUT }, () =>
    Array.from({ length: 4 }, () => new Float32Array(QUANTUM)),
  );
}

/** Run a sine into copy A's input for `blocks` quanta; copy B gets no input.
 *  Returns summed |x| energy per (output, band). */
function run(freqA: number, blocks: number): { out: number[][] } {
  const proc = new Processor();
  const energy: number[][] = Array.from({ length: NUM_OUT }, () => [0, 0, 0, 0]);
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
    for (let o = 0; o < NUM_OUT; o++) {
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

  it('drives copy A envelope/gate/trig outputs, leaves copy B outputs silent', () => {
    const { out } = run(261, 150);
    // Outputs: 2=slowA 3=slowB 4=fastA 5=fastB 6=gateA 7=gateB 8=trigA 9=trigB.
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(out[2]!)).toBeGreaterThan(0); // env_slow A
    expect(sum(out[4]!)).toBeGreaterThan(0); // env_fast A
    expect(sum(out[6]!)).toBeGreaterThan(0); // gate A (band 2 crosses threshold)
    // trig A: the tone's leading edge fires a band-2 beat trigger (output 8).
    expect(sum(out[8]!)).toBeGreaterThan(0); // trig A fired at the onset
    expect(out[8]![1]!).toBeGreaterThan(0); // specifically band 2 (index 1)
    expect(sum(out[3]!)).toBe(0); // env_slow B
    expect(sum(out[5]!)).toBe(0); // env_fast B
    expect(sum(out[7]!)).toBe(0); // gate B
    expect(sum(out[9]!)).toBe(0); // trig B (no input)
  });
});

// ───────────────────────── VIDEO mode ─────────────────────────

/** Drive both copies for `blocks` quanta with the given mode params + post a
 *  video-levels message into each copy first. Returns summed |x| per (out,band). */
function runVideo(opts: {
  blocks: number;
  aMode: number;
  bMode: number;
  aLevels?: number[];
  bLevels?: number[];
}): { out: number[][]; snapshots: Array<{ levelsA: Float32Array; levelsB: Float32Array }> } {
  const snapshots: Array<{ levelsA: Float32Array; levelsB: Float32Array }> = [];
  const proc = new Processor();
  // Capture the snapshot the worklet posts via this.port.postMessage.
  proc.port = {
    postMessage: (m: { type?: string; levelsA?: Float32Array; levelsB?: Float32Array }) => {
      if (m?.type === 'snapshot') snapshots.push({ levelsA: m.levelsA!, levelsB: m.levelsB! });
    },
  };
  // The card posts video levels; the worklet latches them in onVideoMessage.
  if (opts.aLevels) proc.onVideoMessage({ type: 'video', copy: 'a', levels: opts.aLevels });
  if (opts.bLevels) proc.onVideoMessage({ type: 'video', copy: 'b', levels: opts.bLevels });

  const energy: number[][] = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
  const params = {
    a_mode: new Float32Array([opts.aMode]),
    b_mode: new Float32Array([opts.bMode]),
  };
  for (let blk = 0; blk < opts.blocks; blk++) {
    const inputs: Float32Array[][] = [[], []]; // no audio input — video drives it
    const outputs = mkOutputs();
    proc.process(inputs, outputs, params);
    for (let o = 0; o < 8; o++) {
      for (let b = 0; b < 4; b++) {
        const ch = outputs[o]![b]!;
        let s = 0;
        for (let i = 0; i < ch.length; i++) s += Math.abs(ch[i]!);
        energy[o]![b]! += s;
      }
    }
  }
  return { out: energy, snapshots };
}

describe('synesthesia worklet — VIDEO mode (R/G/B/Luma channels)', () => {
  it('latches posted video levels (clamped 0..1) into the target copy', () => {
    const proc = new Processor();
    proc.onVideoMessage({ type: 'video', copy: 'a', levels: [2, -1, 0.5, 0.25] });
    // a.videoLevels is private; prove the clamp via observable output in VIDEO
    // mode: an over-range R (2) is clamped to 1, a negative G (-1) to 0.
    const outputs = mkOutputs();
    proc.process([[], []], outputs, { a_mode: new Float32Array([1]), b_mode: new Float32Array([0]) });
    const audioA0 = Math.max(...outputs[0]![0]!); // R channel band-audio
    const audioA1 = Math.max(...outputs[0]![1]!); // G channel band-audio
    expect(audioA0).toBeCloseTo(1, 5); // clamped to 1 (unity gain default)
    expect(audioA1).toBe(0); // clamped to 0
  });

  it('solid RED frame in VIDEO mode lights channel 0 + fires its gate', () => {
    // Copy A → VIDEO mode, fed a solid red frame: R=1, G=B=0, luma=0.299.
    const { out, snapshots } = runVideo({
      blocks: 120, aMode: 1, bMode: 0, aLevels: [1, 0, 0, 0.299],
    });
    const audioA = out[0]!; // band-audio (channel-level CV) for copy A
    const gateA = out[6]!;
    // Channel 0 (R) carries the most band-audio energy; G/B are silent.
    expect(audioA[0]).toBe(Math.max(...audioA));
    expect(audioA[1]).toBe(0);
    expect(audioA[2]).toBe(0);
    // R gate fired; G/B gates stayed closed.
    expect(gateA[0]!).toBeGreaterThan(0);
    expect(gateA[1]!).toBe(0);
    expect(gateA[2]!).toBe(0);
    // VU snapshot for copy A reflects the R channel being lit.
    const last = snapshots[snapshots.length - 1]!;
    expect(last.levelsA[0]!).toBeGreaterThan(0.4);
    expect(last.levelsA[1]!).toBeCloseTo(0, 3);
  });

  it('switching A to VIDEO does NOT affect B (B stays AUDIO + silent w/o input)', () => {
    const { out } = runVideo({ blocks: 60, aMode: 1, bMode: 0, aLevels: [1, 1, 1, 1] });
    // Copy A (video, white) emits on all channels.
    expect(out[0]!.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // Copy B is in AUDIO mode with no input → exactly silent across all outs.
    for (const o of [1, 3, 5, 7]) {
      expect(out[o]!.reduce((a, b) => a + b, 0)).toBe(0);
    }
  });

  it('AUDIO mode (mode=0) ignores any posted video levels (no regression)', () => {
    // Post video levels but keep copy A in AUDIO mode + give no audio input.
    const { out } = runVideo({ blocks: 60, aMode: 0, bMode: 0, aLevels: [1, 1, 1, 1] });
    // No audio input + audio mode → outputs stay silent (video levels ignored).
    for (const o of [0, 2, 4, 6]) {
      expect(out[o]!.reduce((a, b) => a + b, 0)).toBe(0);
    }
  });

  it('white frame (all channels = 1) lights all four VU meters in copy B', () => {
    const { snapshots } = runVideo({ blocks: 200, aMode: 0, bMode: 1, bLevels: [1, 1, 1, 1] });
    const last = snapshots[snapshots.length - 1]!;
    for (let c = 0; c < 4; c++) expect(last.levelsB[c]!).toBeGreaterThan(0.4);
  });
});
