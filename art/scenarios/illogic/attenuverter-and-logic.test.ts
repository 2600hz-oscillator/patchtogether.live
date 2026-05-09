// art/scenarios/illogic/attenuverter-and-logic.test.ts
//
// ART for ILLOGIC. Drives the actual `illogicDef.factory(ctx, node)` under
// node-web-audio-api's OfflineAudioContext (no Faust DSP — ILLOGIC is
// pure GainNodes + WaveShaperNodes), then asserts:
//
//   1. Attenuverter math: in1 × att1_amount equals the rendered att1.
//   2. Sum: post-attenuverter sum of all 4 channels matches expectation.
//   3. Logic: AND/OR truth-table samples match driving the gates with
//      static high/low constants.
//
// We don't render full square-wave gate trains — the static-input test
// already exercises every truth-table cell at sample-rate granularity,
// and audio-rate boolean composition is the same operation on every sample.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { illogicDef } from '../../../packages/web/src/lib/audio/modules/illogic';

const SAMPLE_RATE = 48000;
const DURATION_S = 0.05; // 2400 samples — plenty for a steady-state sample.
const STEADY_STATE_AT = 1000; // sample index well after WaveShaper convergence.

interface Probe { att1: number; att2: number; att3: number; att4: number; sum: number; diff: number; and: number; nand: number; or: number; not: number; }

async function renderIllogic(opts: {
  in1?: number;
  in2?: number;
  in3?: number;
  in4?: number;
  att1Amount?: number;
  att2Amount?: number;
  att3Amount?: number;
  att4Amount?: number;
}): Promise<Probe> {
  // 10 channels (one per ILLOGIC output). Render into a multi-channel
  // ChannelMergerNode → destination so we can read each output's tail
  // sample independently.
  const ctx = new OfflineAudioContext({
    numberOfChannels: 10,
    length: Math.round(SAMPLE_RATE * DURATION_S),
    sampleRate: SAMPLE_RATE,
  });

  // Build the module via its real factory.
  const node = {
    id: 'illogic-1',
    type: 'illogic',
    domain: 'audio' as const,
    position: { x: 0, y: 0 },
    params: {
      att1_amount: opts.att1Amount ?? 1,
      att2_amount: opts.att2Amount ?? 1,
      att3_amount: opts.att3Amount ?? 1,
      att4_amount: opts.att4Amount ?? 1,
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await illogicDef.factory(ctx as any, node);

  // Drive each input with a ConstantSource at the requested DC level.
  function drive(value: number | undefined, target: { node: AudioNode; input: number } | undefined) {
    if (value === undefined || !target) return;
    const cs = ctx.createConstantSource();
    cs.offset.value = value;
    cs.start(0);
    cs.connect(target.node, 0, target.input);
  }
  drive(opts.in1, handle.inputs.get('in1'));
  drive(opts.in2, handle.inputs.get('in2'));
  drive(opts.in3, handle.inputs.get('in3'));
  drive(opts.in4, handle.inputs.get('in4'));

  // Each output → its own merger channel → destination.
  const merger = ctx.createChannelMerger(10);
  const outputOrder = ['att1', 'att2', 'att3', 'att4', 'sum', 'diff', 'and', 'nand', 'or', 'not'] as const;
  outputOrder.forEach((id, idx) => {
    const out = handle.outputs.get(id);
    if (out) out.node.connect(merger, out.output, idx);
  });
  merger.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  // Sample at STEADY_STATE_AT to skip any WaveShaper / Gain ramp-up.
  return {
    att1: rendered.getChannelData(0)[STEADY_STATE_AT],
    att2: rendered.getChannelData(1)[STEADY_STATE_AT],
    att3: rendered.getChannelData(2)[STEADY_STATE_AT],
    att4: rendered.getChannelData(3)[STEADY_STATE_AT],
    sum:  rendered.getChannelData(4)[STEADY_STATE_AT],
    diff: rendered.getChannelData(5)[STEADY_STATE_AT],
    and:  rendered.getChannelData(6)[STEADY_STATE_AT],
    nand: rendered.getChannelData(7)[STEADY_STATE_AT],
    or:   rendered.getChannelData(8)[STEADY_STATE_AT],
    not:  rendered.getChannelData(9)[STEADY_STATE_AT],
  };
}

describe('ILLOGIC ART: attenuverter math', () => {
  it('att1=+0.5 with in1=1.0 produces att1 output ≈ 0.5', async () => {
    const p = await renderIllogic({ in1: 1.0, att1Amount: 0.5 });
    expect(p.att1).toBeCloseTo(0.5, 4);
  });

  it('att1=0 mutes in1 (att1 output ≈ 0)', async () => {
    const p = await renderIllogic({ in1: 1.0, att1Amount: 0 });
    expect(p.att1).toBeCloseTo(0, 4);
  });

  it('att1=-1 inverts in1 (att1 output ≈ -input)', async () => {
    const p = await renderIllogic({ in1: 0.7, att1Amount: -1 });
    expect(p.att1).toBeCloseTo(-0.7, 4);
  });
});

describe('ILLOGIC ART: math sums', () => {
  it('sum = att1 + att2 + att3 + att4 (post-attenuverter)', async () => {
    const p = await renderIllogic({
      in1: 0.3, att1Amount: 1.0,    // → +0.3
      in2: 0.4, att2Amount: 0.5,    // → +0.2
      in3: 1.0, att3Amount: -1.0,   // → -1.0
      in4: 0.2, att4Amount: 1.0,    // → +0.2
    });
    // Expected: 0.3 + 0.2 - 1.0 + 0.2 = -0.3
    expect(p.sum).toBeCloseTo(-0.3, 3);
  });

  it('diff = (att1 + att2) - (att3 + att4)', async () => {
    const p = await renderIllogic({
      in1: 0.4, att1Amount: 1.0,
      in2: 0.6, att2Amount: 1.0,
      in3: 0.3, att3Amount: 1.0,
      in4: 0.2, att4Amount: 1.0,
    });
    // Expected: (0.4 + 0.6) - (0.3 + 0.2) = 0.5
    expect(p.diff).toBeCloseTo(0.5, 3);
  });
});

describe('ILLOGIC ART: logic truth tables', () => {
  // Use 1.0 for "high" (well above 0.5 threshold) and 0.0 for "low".
  const HI = 1.0, LO = 0.0;

  it('AND(0,0)=0, AND(0,1)=0, AND(1,0)=0, AND(1,1)=1', async () => {
    const cases: Array<[number, number, 0 | 1]> = [
      [LO, LO, 0],
      [LO, HI, 0],
      [HI, LO, 0],
      [HI, HI, 1],
    ];
    for (const [a, b, expected] of cases) {
      const p = await renderIllogic({ in1: a, in2: b });
      expect(Math.round(p.and), `AND(${a}, ${b})`).toBe(expected);
    }
  });

  it('OR(0,0)=0, OR(0,1)=1, OR(1,0)=1, OR(1,1)=1', async () => {
    const cases: Array<[number, number, 0 | 1]> = [
      [LO, LO, 0],
      [LO, HI, 1],
      [HI, LO, 1],
      [HI, HI, 1],
    ];
    for (const [a, b, expected] of cases) {
      const p = await renderIllogic({ in1: a, in2: b });
      expect(Math.round(p.or), `OR(${a}, ${b})`).toBe(expected);
    }
  });

  it('NAND is the boolean inverse of AND', async () => {
    for (const [a, b] of [[LO, LO], [LO, HI], [HI, LO], [HI, HI]] as Array<[number, number]>) {
      const p = await renderIllogic({ in1: a, in2: b });
      expect(Math.round(p.and) + Math.round(p.nand), `AND+NAND should be 1 for (${a},${b})`).toBe(1);
    }
  });

  it('NOT(in1 high)=0, NOT(in1 low)=1', async () => {
    const high = await renderIllogic({ in1: HI });
    const low  = await renderIllogic({ in1: LO });
    expect(Math.round(high.not)).toBe(0);
    expect(Math.round(low.not)).toBe(1);
  });

  it('threshold sits at 0.5 (below = low, at/above = high)', async () => {
    const justBelow = await renderIllogic({ in1: 0.49, in2: 0.51 });
    expect(Math.round(justBelow.and)).toBe(0);   // both must be high; in1 isn't
    expect(Math.round(justBelow.or)).toBe(1);    // either can be high; in2 is
    expect(Math.round(justBelow.not)).toBe(1);   // in1 < 0.5 → NOT high
  });
});
