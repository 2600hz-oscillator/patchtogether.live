// art/scenarios/stereo-dual-mono/dual-mono-signal.test.ts
//
// THE SIGNAL PROOF for dual-mono (plan §0b, PR-3b). Real Web Audio, real
// channel laws, real up-mix/down-mix — not a recorded property.
//
// ── WHY THIS LIVES IN THE ART LANE AND NOT THE UNIT LANE ─────────────────────
// packages/web's vitest runs `environment: 'node'` with a HAND-ROLLED fake
// AudioContext. A fake cannot model `channelInterpretation`, which is the
// entire subject here: the bug being guarded against is a CHANNEL CONVERSION
// LAW, invisible to any instrument that only records which method was called.
// The ART lane already hosts node-web-audio-api, so it is the only place in the
// repo where these assertions can mean anything.
//
// ⚠ This is NOT a baseline scenario. It pins no `.f32`, computes no
// fingerprint, and asserts PROPERTIES (equal / unequal / non-zero), so it needs
// no re-pin when a DSP changes. It lives here purely for the Web Audio runtime.
//
// ── THE HAZARD ───────────────────────────────────────────────────────────────
// `ChannelSplitter` is spec'd `channelInterpretation: 'discrete'`, whose up-mix
// ZERO-FILLS the channels a mono source does not supply. Feed a 1-channel
// signal straight into it and instance B gets digital silence: signal-on-L,
// silence-on-R, and EVERY EXISTING MONO PATCH GOES LEFT-ONLY. This repo has
// already shipped and fixed that exact bug twice (resofilter, then five modules
// in #1343). Doing it in the engine would re-introduce it for every module at
// once.
//
// The `mono patch` describe below is the guard. The `NEGATIVE CONTROL` describe
// is its permanent companion: it builds the SAME graph with `discrete` and
// requires the right channel to be silent. If the negative control ever passes
// with 'speakers', or the guard ever passes with 'discrete', the runtime has
// stopped modelling the law and every assertion in this file is worthless.

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  materializeAudioHandle, legInputsFor, resolveDualMonoInput,
} from '$lib/audio/dual-mono';
import { legChannelOfEdge, type StereoDef } from '$lib/graph/stereo-autowire';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleNode } from '$lib/graph/types';

import { delayDef } from '$lib/audio/modules/delay';
import { scalerDef } from '$lib/audio/modules/scaler';
import { moog907aDef } from '$lib/audio/modules/moog907a';
import { moog914Def } from '$lib/audio/modules/moog914';

const SR = 48000;
const N = 4096;
/** Read well past the first render quantum so nothing is measured mid-fade. */
const PROBE = 3000;

const NODE = {
  id: 'p', type: 'x', domain: 'audio', position: { x: 0, y: 0 }, params: {},
} as unknown as ModuleNode;

type Ctx = OfflineAudioContext;

/** A 1- or 2-channel constant source. Constant, so a single sample is the answer. */
function constSource(ctx: Ctx, chans: number[]): AudioBufferSourceNode {
  const buf = ctx.createBuffer(chans.length, N, SR);
  chans.forEach((v, i) => buf.getChannelData(i).fill(v));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src as unknown as AudioBufferSourceNode;
}

/**
 * A synthetic module that is MONO the way the seven wrapped modules are mono:
 * its "DSP" reads one channel and emits one channel. Modelled with a GainNode
 * pinned to `channelCount: 1, explicit` — the same collapse a Faust mono
 * worklet or an `outputChannelCount: [1]` AudioWorkletNode performs, expressed
 * in nodes the offline runtime can render.
 *
 * `type: 'filter'` is deliberate: `materializeAudioHandle` dispatches on the
 * LEDGER, so this exercises the real 'dual-mono' branch rather than a test-only
 * one. What is under test is the wrapper's channel plumbing, not filter's DSP.
 */
function monoModuleDef(gain: number, type = 'filter'): AudioModuleDef {
  return {
    type, domain: 'audio', label: type, category: 'test',
    inputs: [{ id: 'audio', type: 'audio' }, { id: 'res', type: 'cv' }],
    outputs: [{ id: 'audio', type: 'audio' }],
    params: [],
    async factory(ctx: AudioContext) {
      const g = (ctx as unknown as Ctx).createGain();
      g.channelCount = 1;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers';
      g.gain.value = gain;
      return {
        domain: 'audio' as const,
        inputs: new Map([
          ['audio', { node: g as unknown as AudioNode, input: 0 }],
          ['res', { node: g as unknown as AudioNode, input: 0, param: g.gain as unknown as AudioParam }],
        ]),
        outputs: new Map([['audio', { node: g as unknown as AudioNode, output: 0 }]]),
        setParam(_id: string, v: number) { g.gain.value = v; },
        readParam() { return g.gain.value; },
        dispose() { g.disconnect(); },
      };
    },
  } as unknown as AudioModuleDef;
}

/** Render `def` through the ENGINE SEAM with the given input channels. */
async function renderThroughSeam(
  def: AudioModuleDef,
  inputChannels: number[],
  opts: { inputPort?: string; outputPort?: string; cv?: number } = {},
): Promise<{ L: number; R: number; channels: number }> {
  const ctx = new OfflineAudioContext(2, N, SR);
  const handle = await materializeAudioHandle(ctx as unknown as AudioContext, def, NODE);
  const inPort = opts.inputPort ?? 'audio';
  const outPort = opts.outputPort ?? 'audio';
  const din = handle.inputs.get(inPort)!;
  const dout = handle.outputs.get(outPort)!;

  const src = constSource(ctx, inputChannels);
  (src as unknown as AudioNode).connect(din.node, 0, din.input);
  src.start(0);

  if (opts.cv !== undefined) {
    // Exactly what AudioEngine.addEdge does for a CV → AudioParam input.
    const cvPort = handle.inputs.get('res')!;
    const cv = ctx.createConstantSource();
    cv.offset.value = opts.cv;
    cv.connect(cvPort.param!);
    cv.start(0);
  }

  dout.node.connect(ctx.destination as unknown as AudioNode, dout.output, 0);
  const out = await ctx.startRendering();
  return {
    L: out.getChannelData(0)[PROBE]!,
    R: out.getChannelData(1)[PROBE]!,
    channels: out.numberOfChannels,
  };
}

// ---------------------------------------------------------------------------

describe('dual-mono — ⚠ A MONO PATCH MUST STILL WORK', () => {
  it('a 1-CHANNEL source comes out with EQUAL, NON-ZERO L and R', async () => {
    const { L, R } = await renderThroughSeam(monoModuleDef(0.5), [0.8]);
    // NON-ZERO first: "both silent" would satisfy equality and is the failure
    // mode of a graph that never connected.
    expect(Math.abs(L), 'left is silent — the graph never connected').toBeGreaterThan(0.01);
    expect(Math.abs(R), 'RIGHT IS SILENT — this is the discrete zero-fill bug; every '
      + 'existing mono patch just became left-only').toBeGreaterThan(0.01);
    expect(R).toBeCloseTo(L, 6);
    expect(L).toBeCloseTo(0.4, 6); // 0.8 × 0.5, unchanged by the round trip
  });

  it('the mono round trip does not change the LEVEL (no 0.5× or 2× drift)', async () => {
    // A 'speakers' up-mix duplicates rather than halving; a merger writes one
    // channel each rather than summing. Either mistake would move the level.
    const { L, R } = await renderThroughSeam(monoModuleDef(1), [0.25]);
    expect(L).toBeCloseTo(0.25, 6);
    expect(R).toBeCloseTo(0.25, 6);
  });
});

describe('dual-mono — NEGATIVE CONTROL: the guard CAN fail', () => {
  // The permanent leg. This builds the wrapper's own topology by hand with the
  // one property changed, and requires the bug to appear. If this ever goes
  // green, node-web-audio-api has stopped modelling channelInterpretation and
  // the describe above proves nothing.
  const rig = async (interpretation: 'speakers' | 'discrete') => {
    const ctx = new OfflineAudioContext(2, N, SR);
    const upmix = ctx.createGain();
    upmix.channelCount = 2;
    upmix.channelCountMode = 'explicit';
    upmix.channelInterpretation = interpretation;
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const a = ctx.createGain();
    const b = ctx.createGain();
    const src = constSource(ctx, [0.8]);
    (src as unknown as AudioNode).connect(upmix as unknown as AudioNode);
    upmix.connect(splitter);
    splitter.connect(a, 0);
    splitter.connect(b, 1);
    a.connect(merger, 0, 0);
    b.connect(merger, 0, 1);
    merger.connect(ctx.destination);
    src.start(0);
    const out = await ctx.startRendering();
    return { L: out.getChannelData(0)[PROBE]!, R: out.getChannelData(1)[PROBE]! };
  };

  it("'discrete' ZERO-FILLS channel 1 — the bug, reproduced on demand", async () => {
    const { L, R } = await rig('discrete');
    expect(L).toBeCloseTo(0.8, 6);
    expect(R, 'the runtime no longer models discrete zero-fill; every assertion in '
      + 'this file is now vacuous').toBe(0);
  });

  it("'speakers' duplicates — the same rig, one property changed", async () => {
    const { L, R } = await rig('speakers');
    expect(L).toBeCloseTo(0.8, 6);
    expect(R).toBeCloseTo(0.8, 6);
  });
});

describe('dual-mono — a STEREO signal survives a mono module', () => {
  it('2 distinct channels in, 2 distinct channels out', async () => {
    const { L, R } = await renderThroughSeam(monoModuleDef(0.5), [0.8, -0.4]);
    expect(L).toBeCloseTo(0.4, 6);
    expect(R).toBeCloseTo(-0.2, 6);
    expect(L).not.toBeCloseTo(R, 3);
  });

  it('WITHOUT the wrapper the same module collapses — the effect is real', async () => {
    // The instrument is negative-controlled against the CODE too: 'delay' is
    // classified 'native-stereo', so the seam passes the factory through
    // untouched, and this synthetic mono DSP then loses the right channel.
    // (Same factory, same signal, different ledger class.)
    const { L, R } = await renderThroughSeam(monoModuleDef(0.5, 'delay'), [0.8, -0.4]);
    expect(L).toBeCloseTo(R, 6);
    // A mono collapse is the speakers DOWN-mix, (0.8 + -0.4) / 2 × 0.5.
    expect(L).toBeCloseTo(0.1, 6);
  });

  it('one CV source modulates BOTH channels, not just the left', async () => {
    // The AudioParam fan-out. Without it the right channel would sit at the
    // knob value while the left swept — a half-modulated filter.
    const { L, R } = await renderThroughSeam(monoModuleDef(0, 'filter'), [0.8, -0.4], { cv: 0.5 });
    expect(L).toBeCloseTo(0.4, 6);
    expect(R, 'the CV never reached instance B').toBeCloseTo(-0.2, 6);
  });
});

describe('LEG PLACEMENT — a TWO-PORT stereo source survives a mono module', () => {
  // The case the PR-3 commit planner actually writes: `out_l` and `out_r` are
  // two SEPARATE cables into the module's single audio input. Web Audio sums
  // two connections to one input, so without leg placement the stereo image
  // dies at the first mono module — the exact failure dual-mono exists to
  // prevent, and the one the chaining case (a 2-channel stream on one cable)
  // does not cover, because real patches START here.
  //
  // Wired through `legInputsFor` + `resolveDualMonoInput` + `legChannelOfEdge`
  // — the SAME three functions AudioEngine.addEdge calls, not a re-derivation.
  // (That addEdge calls them at all is pinned in dual-mono-engine.test.ts.)
  const stereoSrcDef = {
    type: 'clouds', domain: 'audio', inputs: [],
    outputs: [{ id: 'out_l', type: 'audio' }, { id: 'out_r', type: 'audio' }],
  } as unknown as StereoDef;

  const sideOf = (portId: string, placement: 'on' | 'off') => {
    if (placement === 'off') return null; // the negative control
    return legChannelOfEdge(
      { id: 'e', source: { nodeId: 's', portId }, target: { nodeId: 'd', portId: 'audio' } } as never,
      (nodeId) => (nodeId === 's' ? stereoSrcDef : undefined),
    );
  };

  /** Patch `legs` (portId → constant value) into a wrapped module. */
  async function renderLegs(
    legValues: Record<string, number>,
    placement: 'on' | 'off' = 'on',
  ) {
    const ctx = new OfflineAudioContext(2, N, SR);
    const handle = await materializeAudioHandle(
      ctx as unknown as AudioContext, monoModuleDef(0.5), NODE,
    );
    const legs = legInputsFor(handle, 'audio');
    expect(legs, 'the wrapped handle exposes no leg inputs').toBeTruthy();
    for (const [portId, value] of Object.entries(legValues)) {
      const side = sideOf(portId, placement);
      const target = resolveDualMonoInput(legs!, side);
      const src = constSource(ctx, [value]);
      (src as unknown as AudioNode).connect(target.node, 0, target.input);
      src.start(0);
      if (side) legs!.noteLeg(side, +1);
    }
    const dout = handle.outputs.get('audio')!;
    dout.node.connect(ctx.destination as unknown as AudioNode, dout.output, 0);
    const out = await ctx.startRendering();
    return { L: out.getChannelData(0)[PROBE]!, R: out.getChannelData(1)[PROBE]! };
  }

  it('out_l and out_r come out DISTINCT at the far end', async () => {
    const { L, R } = await renderLegs({ out_l: 0.8, out_r: -0.4 });
    expect(L).toBeCloseTo(0.4, 6);
    expect(R).toBeCloseTo(-0.2, 6);
    expect(Math.sign(L), 'the two legs were summed — stereo destroyed at the first '
      + 'mono module, which is the whole thing dual-mono exists to prevent')
      .not.toBe(Math.sign(R));
  });

  it('NEGATIVE CONTROL: with placement OFF the same patch SUMS', async () => {
    // Both cables land on the mono bus, exactly as they did before this fix.
    // If this ever stops showing the sum, the test above proves nothing.
    const { L, R } = await renderLegs({ out_l: 0.8, out_r: -0.4 }, 'off');
    expect(L).toBeCloseTo(R, 6);
    // (0.8 + −0.4) × 0.5, duplicated to both channels by the up-mix.
    expect(L).toBeCloseTo(0.2, 6);
  });

  it('a LONE leg still reaches BOTH channels (the merger zero-fill trap)', async () => {
    // A ChannelMerger renders an unconnected input as silence — the same
    // left-only failure as a discrete up-mix, wearing a different node. The
    // mono normal is open until the opposite leg genuinely arrives.
    const lone = await renderLegs({ out_l: 0.8 });
    expect(Math.abs(lone.R), 'RIGHT IS SILENT for a lone left leg — the merger '
      + 'zero-fill trap').toBeGreaterThan(0.01);
    expect(lone.R).toBeCloseTo(lone.L, 6);

    // …and symmetrically for a lone RIGHT leg.
    const loneR = await renderLegs({ out_r: 0.8 });
    expect(Math.abs(loneR.L), 'LEFT IS SILENT for a lone right leg').toBeGreaterThan(0.01);
    expect(loneR.L).toBeCloseTo(loneR.R, 6);
  });

  it('⚠ the MONO patch is unaffected — still equal and NON-ZERO', async () => {
    // Non-negotiable. The leg machinery must not have reintroduced the
    // zero-fill on a different node; a mono cable is unpaired, so it takes the
    // mono bus and the up-mix, untouched.
    const { L, R } = await renderThroughSeam(monoModuleDef(0.5), [0.8]);
    expect(Math.abs(L)).toBeGreaterThan(0.01);
    expect(Math.abs(R)).toBeGreaterThan(0.01);
    expect(R).toBeCloseTo(L, 6);
  });

  it('CHAINING still works — a 2-channel stream on ONE cable stays distinct', async () => {
    // A dual-mono module's output port is unpaired, so the next module sees a
    // single unsided cable carrying 2 channels. That must take the mono bus and
    // pass through the up-mix WITHOUT being down-mixed by a merger input.
    const { L, R } = await renderThroughSeam(monoModuleDef(0.5), [0.8, -0.4]);
    expect(L).toBeCloseTo(0.4, 6);
    expect(R).toBeCloseTo(-0.2, 6);
  });
});

describe("'sum' class — a stereo signal is DOWN-MIXED, not read as left-only", () => {
  const analyzerDef = (): AudioModuleDef => ({
    ...monoModuleDef(1, 'featurecv'),
    inputs: [{ id: 'in', type: 'audio' }],
    outputs: [{ id: 'out', type: 'audio' }],
    async factory(ctx: AudioContext) {
      const g = (ctx as unknown as Ctx).createGain();
      g.channelCount = 1;
      g.channelCountMode = 'explicit';
      return {
        domain: 'audio' as const,
        inputs: new Map([['in', { node: g as unknown as AudioNode, input: 0 }]]),
        outputs: new Map([['out', { node: g as unknown as AudioNode, output: 0 }]]),
        setParam() {}, readParam() { return 0; }, dispose() { g.disconnect(); },
      };
    },
  } as unknown as AudioModuleDef);

  it('reads (L+R)/2, not L', async () => {
    const { L } = await renderThroughSeam(analyzerDef(), [0.8, -0.4],
      { inputPort: 'in', outputPort: 'out' });
    expect(L, 'an analyzer reading only the left channel is the silent-meter bug')
      .toBeCloseTo(0.2, 6);
  });

  it('is a NO-OP for a 1-channel source (no mono patch moves)', async () => {
    const { L } = await renderThroughSeam(analyzerDef(), [0.8],
      { inputPort: 'in', outputPort: 'out' });
    expect(L).toBeCloseTo(0.8, 6);
  });
});

describe("'native-stereo' — the claim is MEASURED, not read off the source", () => {
  // Each of these is UNTOUCHED by this PR on the claim that its audio path is
  // built from per-channel native nodes. That claim is falsifiable and this is
  // where it gets falsified: feed a genuinely different L and R through the
  // REAL shipped factory and require both to come out, still different. If a
  // future edit drops a mono worklet into one of these paths, this goes red and
  // the module moves to 'dual-mono'.
  const cases: [AudioModuleDef, string, string][] = [
    [delayDef as AudioModuleDef, 'audio', 'audio'],
    [scalerDef as AudioModuleDef, 'in', 'out'],
    [moog907aDef as AudioModuleDef, 'audio', 'audio'],
    [moog914Def as AudioModuleDef, 'audio', 'audio'],
  ];

  for (const [def, inPort, outPort] of cases) {
    it(`${def.type} passes L and R through independently`, async () => {
      const ctx = new OfflineAudioContext(2, N, SR);
      const handle = await materializeAudioHandle(ctx as unknown as AudioContext, def, NODE);
      const din = handle.inputs.get(inPort)!;
      const dout = handle.outputs.get(outPort)!;
      const src = constSource(ctx, [0.7, -0.35]);
      (src as unknown as AudioNode).connect(din.node, 0, din.input);
      src.start(0);
      dout.node.connect(ctx.destination as unknown as AudioNode, dout.output, 0);
      const out = await ctx.startRendering();
      const L = out.getChannelData(0)[PROBE]!;
      const R = out.getChannelData(1)[PROBE]!;
      expect(Math.abs(L), `${def.type}: left is silent`).toBeGreaterThan(1e-4);
      expect(Math.abs(R), `${def.type}: RIGHT IS SILENT — this module is NOT `
        + "channel-transparent and must not be classified 'native-stereo'").toBeGreaterThan(1e-4);
      // Opposite signs in, opposite signs out: the channels did not get summed.
      expect(Math.sign(L), `${def.type}: L and R were mixed together`).not.toBe(Math.sign(R));
    });
  }
});

describe('dual-mono — the COST, measured', () => {
  it('adds exactly 7 shared gains + 1 fan per extra input', async () => {
    // Deterministic, unlike a timing — and the number is the whole point of
    // pinning it: leg placement took the shared scaffolding from 2 gains to 7,
    // and a silent creep here is how "2× CPU, accepted" becomes 3×.
    //   mono bus, up-mix, legL, legR, normalLR, normalRL, stereoSum  = 7
    //   + 1 fan per non-audio input (`res`)                          = 1
    //   + 2 instances × 1 gain each (the synthetic DSP)              = 2
    // Non-gain nodes are unchanged: 1 splitter + 1 leg merger + 1 output
    // merger per audio output.
    const ctx = new OfflineAudioContext(2, N, SR);
    let made = 0;
    const real = ctx.createGain.bind(ctx);
    (ctx as unknown as { createGain: () => GainNode }).createGain = () => { made++; return real(); };
    await materializeAudioHandle(ctx as unknown as AudioContext, monoModuleDef(1), NODE);
    expect(made).toBe(10);
  });

  it('reports the render-time cost of running a DSP twice', async () => {
    // NOT an assertion — a timing gate would be a different threshold on every
    // machine. This is a REPORT, printed so the PR can quote a real number.
    const bank = (ctx: Ctx, stages: number) => {
      const head = ctx.createGain();
      let cur: AudioNode = head as unknown as AudioNode;
      for (let i = 0; i < stages; i++) {
        const bq = ctx.createBiquadFilter();
        bq.frequency.value = 200 + i * 130;
        bq.Q.value = 4;
        cur.connect(bq as unknown as AudioNode);
        cur = bq as unknown as AudioNode;
      }
      return { head, tail: cur };
    };
    const run = async (instances: number) => {
      const ctx = new OfflineAudioContext(2, SR * 4, SR);
      const src = constSource(ctx, [0.3]);
      for (let k = 0; k < instances; k++) {
        const { head, tail } = bank(ctx, 8);
        (src as unknown as AudioNode).connect(head as unknown as AudioNode);
        tail.connect(ctx.destination as unknown as AudioNode);
      }
      src.start(0);
      const t0 = performance.now();
      await ctx.startRendering();
      return performance.now() - t0;
    };
    await run(1); // warm
    const one = await run(1);
    const two = await run(2);
    // eslint-disable-next-line no-console
    console.log(`[dual-mono cost] 8-biquad DSP, 4 s @ ${SR} Hz — `
      + `1 instance ${one.toFixed(1)} ms, 2 instances ${two.toFixed(1)} ms, `
      + `ratio ${(two / one).toFixed(2)}×`);
    expect(two).toBeGreaterThan(0);
  });
});
