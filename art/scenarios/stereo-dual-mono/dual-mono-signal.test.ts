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
import { moog904aDef } from '$lib/audio/modules/moog904a';

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

// ---------------------------------------------------------------------------
// 'mono-fanout' — ONE instance, fanned. The SIGNAL proof.
// ---------------------------------------------------------------------------
//
// ⚠ WHY THIS IS 25 SPAWNS AND NOT ONE. The behaviour being fixed was a COIN
// FLIP, so a single green render proves nothing: the pre-fix graph passed a
// "> floor" check on roughly 99.7 % of spawns. The measurement is therefore a
// SPREAD ACROSS MANY SPAWNS — the same shape the original defect measurement
// took — and the assertion is that the spread COLLAPSES, not that one draw
// cleared a bar.
//
// ⚠ AND THE NEGATIVE CONTROL IS THE OLD GRAPH ITSELF, LIVE. `moog904aDef`
// re-typed as `filter` still dispatches to the 'dual-mono' branch (the ledger
// decides, not the factory), so the control builds the EXACT pre-fix topology
// out of the EXACT shipping factory and requires the scatter to come back. If
// it ever stops scattering, the entropy is gone from the DSP and the describe
// above has stopped proving anything.
//
// This is also the end-to-end assertion the `moog904a.audio` emit park gave up
// (.myrobots/2026-08-18-flake-park-coverage-lost.md): shipping factory → real
// AudioWorkletNode → the engine's wrapper → a real render → a mono down-mix.
describe("'mono-fanout' — the phase lottery is GONE (25 spawns)", () => {
  const SPAWNS = 25;
  const FANOUT_SR = 48000;
  /** 1.5 s: long enough for the ladder to bootstrap out of its ~3e-6 dither
   *  floor and SETTLE, so the tail is the limit cycle and not the ramp. */
  const FANOUT_N = Math.round(FANOUT_SR * 1.5);
  /** The e2e emit sweep's floor — the bar the park existed under. */
  const EMIT_FLOOR = 0.005;
  /**
   * ⚠ THE RESIDUAL, NAMED RATHER THAN ROUNDED AWAY. Building the ladder once
   * does NOT make the level bit-identical ACROSS spawns, and pretending it did
   * would be a false claim in a comment: the dither is still `Math.random()`
   * inside the one instance, so the limit cycle settles with a slightly
   * different amplitude each render. Measured over these 25 spawns the whole
   * cross-spawn spread is ~7e-7 — about 124 dB below the signal, ~1.4 million
   * times smaller than the 1.0143 the two-instance graph produced, and four
   * orders of magnitude below the emit floor it used to fall through.
   *
   * What IS exact is the thing the class buys: L and R are the SAME SAMPLES,
   * so the analyser's down-mix reads the true single-channel level every time.
   * That is asserted at 0 tolerance below; this constant covers only the
   * spawn-to-spawn jitter of the DSP itself, which no graph change can remove.
   */
  const LEVEL_JITTER = 1e-5;

  /** The per-port driver's operating point: self-oscillating, mid band. */
  const RINGING = {
    id: 'p', type: 'moog904a', domain: 'audio', position: { x: 0, y: 0 },
    params: { regeneration: 1, range: 2, cutoff: 800 },
  } as unknown as ModuleNode;

  /**
   * One spawn, rendered through the ENGINE SEAM with the SHIPPING worklet.
   *
   * `monoPeak` is what an `AnalyserNode` sees — every level surface in the app
   * (the faceplate `live-audio` glyph, every VU meter) is a bare analyser tap,
   * and an analyser MONO-DOWN-MIXES. That is the quantity the defect moved;
   * the per-channel peaks never moved at all.
   */
  async function spawn(def: AudioModuleDef) {
    const ctx = new OfflineAudioContext(2, FANOUT_N, FANOUT_SR);
    const handle = await materializeAudioHandle(ctx as unknown as AudioContext, def, RINGING);
    const dout = handle.outputs.get('audio')!;
    dout.node.connect(ctx.destination as unknown as AudioNode, dout.output, 0);
    const out = await ctx.startRendering();
    const L = out.getChannelData(0);
    const R = out.getChannelData(1);
    const from = Math.round(FANOUT_N * 0.75); // the settled tail
    let legPeak = 0;
    let monoPeak = 0;
    let maxChannelDiff = 0;
    for (let i = from; i < FANOUT_N; i++) {
      legPeak = Math.max(legPeak, Math.abs(L[i]!), Math.abs(R[i]!));
      monoPeak = Math.max(monoPeak, Math.abs((L[i]! + R[i]!) / 2));
      maxChannelDiff = Math.max(maxChannelDiff, Math.abs(L[i]! - R[i]!));
    }
    return { legPeak, monoPeak, maxChannelDiff };
  }

  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

  /** The pre-fix graph: the SAME factory, re-typed onto the 'dual-mono' class. */
  const asDualMono = { ...moog904aDef, type: 'filter' } as AudioModuleDef;

  it('every spawn reads the SAME level, and it is the TRUE single-channel level', async () => {
    const mono: number[] = [];
    const legs: number[] = [];
    let worstChannelDiff = 0;
    for (let k = 0; k < SPAWNS; k++) {
      const s = await spawn(moog904aDef as AudioModuleDef);
      mono.push(s.monoPeak);
      legs.push(s.legPeak);
      worstChannelDiff = Math.max(worstChannelDiff, s.maxChannelDiff);
    }

    // (1) The two channels are the SAME SIGNAL, sample for sample. This is the
    //     property the class buys, and it is bit-exact because both merger
    //     inputs are fed by ONE node — not "close", identical.
    expect(worstChannelDiff, 'L and R are not the same signal — the fan is not '
      + 'reaching both merger inputs from one instance').toBe(0);

    // (2) …so the analyser's down-mix reads the TRUE level, on EVERY spawn.
    //     DERIVED, not pinned: the mono sum must EQUAL the single-channel peak
    //     it came from. That stays honest if the ladder's own level ever moves
    //     for a real reason, where a pinned 1.0622 would just go red.
    expect(mono, 'the mono down-mix does not equal the single-channel level — '
      + 'the two channels are not the same signal').toEqual(legs);

    // (3) …and it is the SAME level spawn after spawn. The pre-fix graph spread
    //     1.0143 here (see the negative control); what is left is the DSP's own
    //     ~7e-7 jitter, which no graph change can remove — see LEVEL_JITTER.
    expect(spread(mono), 'the mono down-mix still scatters across spawns: '
      + `${Math.min(...mono).toFixed(4)} … ${Math.max(...mono).toFixed(4)}`)
      .toBeLessThan(LEVEL_JITTER);

    // (4) NON-VACUITY: it is a real, ringing signal, far above the e2e emit
    //     floor the park was taken out under. A SILENT module would satisfy
    //     (1), (2) and (3) perfectly — that is the shape this repo keeps
    //     shipping, so the floor is asserted rather than assumed.
    expect(Math.min(...mono), 'the ladder is not self-oscillating — (1)-(3) all '
      + 'pass on silence').toBeGreaterThan(EMIT_FLOOR * 100);
  }, 120_000);

  it('NEGATIVE CONTROL: the OLD graph still scatters — same factory, two instances', async () => {
    // Builds the pre-fix topology out of the shipping factory by dispatching it
    // through the 'dual-mono' branch. If this goes green the guard above is
    // measuring nothing.
    const mono: number[] = [];
    const legs: number[] = [];
    for (let k = 0; k < SPAWNS; k++) {
      const s = await spawn(asDualMono);
      mono.push(s.monoPeak);
      legs.push(s.legPeak);
    }

    // The per-channel level is STABLE either way, to the same LEVEL_JITTER the
    // fixed graph shows — that is what made this defect invisible to anything
    // that did not down-mix, and it is why "the module is loud enough" was
    // never the question.
    expect(spread(legs), 'the per-channel level was never the unstable quantity')
      .toBeLessThan(LEVEL_JITTER);

    // …and the mono down-mix scatters over most of the available range,
    // because the two rings share a frequency and have independent phase.
    expect(
      spread(mono),
      'two independently-dithered ladders no longer decorrelate. Either the DSP '
      + 'lost its Math.random() dither (in which case moog904a should move back '
      + "to 'dual-mono' and this control should be deleted), or the wrapper "
      + 'stopped building two instances — and the guard above is now vacuous.',
    ).toBeGreaterThan(0.25);
    // The defect, stated as the thing a player saw: at least one spawn painted
    // the meter at under HALF the level the module was actually emitting.
    expect(Math.min(...mono)).toBeLessThan(legs[0]! * 0.5);
  }, 120_000);
});

describe("'mono-fanout' — the LEVEL is honest, and the legs are why", () => {
  // The trap this describe exists for: a mono-fanout module has ONE instance,
  // so "it has no side to place a cable on, drop the legs" reads as an obvious
  // simplification. It is wrong, and the failure is a LEVEL, not a width —
  // which is exactly the kind that gets waved through. Web Audio SUMS two
  // connections into one input, and a stereo→mono patch is written as TWO
  // CABLES (planAudioCommit), so a bare down-mix receives L+R where every other
  // mono path in the app applies (L+R)/2. Into a tanh ladder that is up to 6 dB
  // of extra drive.
  //
  // The synthetic DSP is typed 'moog904a' so `materializeAudioHandle` takes the
  // REAL mono-fanout branch — the ledger dispatches, not the factory.
  const fanoutDef = (gain: number) => monoModuleDef(gain, 'moog904a');

  const stereoSrcDef = {
    type: 'clouds', domain: 'audio', inputs: [],
    outputs: [{ id: 'out_l', type: 'audio' }, { id: 'out_r', type: 'audio' }],
  } as unknown as StereoDef;

  async function renderFanoutLegs(
    legValues: Record<string, number>,
    placement: 'on' | 'off' = 'on',
  ) {
    const ctx = new OfflineAudioContext(2, N, SR);
    const handle = await materializeAudioHandle(
      ctx as unknown as AudioContext, fanoutDef(0.5), NODE,
    );
    const legs = legInputsFor(handle, 'audio');
    expect(legs, 'the mono-fanout handle exposes no leg inputs').toBeTruthy();
    for (const [portId, value] of Object.entries(legValues)) {
      const side = placement === 'off' ? null : legChannelOfEdge(
        { id: 'e', source: { nodeId: 's', portId }, target: { nodeId: 'd', portId: 'audio' } } as never,
        (nodeId) => (nodeId === 's' ? stereoSrcDef : undefined),
      );
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

  it('⚠ a MONO patch does not move — still equal and NON-ZERO', async () => {
    // Non-negotiable, and the reason the front-end is not just a bare down-mix:
    // `upmix` duplicates the single channel and the down-mix averages the
    // duplicate back to itself, so a mono cable comes out untouched.
    const { L, R } = await renderThroughSeam(fanoutDef(0.5), [0.8]);
    expect(Math.abs(L), 'left is silent').toBeGreaterThan(0.01);
    expect(Math.abs(R), 'RIGHT IS SILENT — the fan is not reaching merger input 1')
      .toBeGreaterThan(0.01);
    expect(L).toBeCloseTo(0.4, 6); // 0.8 × 0.5, unchanged by the round trip
    expect(R).toBe(L); // the SAME node feeds both merger inputs — bit-exact
  });

  it('a 2-channel stream on ONE cable is AVERAGED, and comes out on both', async () => {
    const { L, R } = await renderThroughSeam(fanoutDef(0.5), [0.8, -0.4]);
    // (0.8 + −0.4) / 2 × 0.5. The image is deliberately collapsed (owner
    // ruling); what must NOT happen is the LEVEL moving.
    expect(L).toBeCloseTo(0.1, 6);
    expect(R).toBe(L);
  });

  it('TWO CABLES from a stereo pair average to the SAME value as one 2ch cable', async () => {
    const { L, R } = await renderFanoutLegs({ out_l: 0.8, out_r: -0.4 });
    expect(L, 'the two legs SUMMED instead of averaging — the DSP is being driven '
      + 'twice as hard as the identical signal on one 2-channel cable')
      .toBeCloseTo(0.1, 6);
    expect(R).toBe(L);
  });

  it('NEGATIVE CONTROL: with placement OFF the same patch runs 2× HOT', async () => {
    // Both cables land on the mono bus and Web Audio sums them: (0.8 + −0.4)
    // × 0.5 = 0.2, double the 0.1 above. This is the exact defect that dropping
    // the legs would ship, reproduced on demand. If it ever stops showing the
    // doubling, the test above proves nothing.
    const { L } = await renderFanoutLegs({ out_l: 0.8, out_r: -0.4 }, 'off');
    expect(L).toBeCloseTo(0.2, 6);
  });

  it('a LONE leg still reaches BOTH channels (the merger zero-fill trap)', async () => {
    const lone = await renderFanoutLegs({ out_l: 0.8 });
    expect(Math.abs(lone.L), 'a lone left leg is silent').toBeGreaterThan(0.01);
    expect(lone.R).toBe(lone.L);
    const loneR = await renderFanoutLegs({ out_r: 0.8 });
    expect(Math.abs(loneR.L), 'a lone RIGHT leg is silent on the left').toBeGreaterThan(0.01);
    expect(loneR.R).toBe(loneR.L);
  });
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
