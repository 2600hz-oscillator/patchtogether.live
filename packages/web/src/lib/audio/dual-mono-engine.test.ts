// packages/web/src/lib/audio/dual-mono-engine.test.ts
//
// The dual-mono WIRING, pinned against a recording AudioContext.
//
// This is the topology instrument. It proves the graph is shaped the way
// dual-mono.ts says it is — two instances, the up-mix before the split, the CV
// fan reaching BOTH instances, both halves torn down. It deliberately does NOT
// claim anything about the resulting SIGNAL: the unit lane runs in node with no
// Web Audio at all, so every "channel" here is a recorded integer, not audio.
//
// ⚠ THE SIGNAL IS OWNED BY art/scenarios/stereo-dual-mono/, which renders the
// same construction through REAL Web Audio and asserts a 1-channel source comes
// out with EQUAL, NON-ZERO L and R. A green run here with a red run there means
// the topology is right and the channel LAWS are wrong, which is exactly the
// hazard (`discrete` zero-fill) this design exists to avoid. Neither file is
// sufficient alone.
//
// The recorder itself is negative-controlled ('the recorder is not lying'
// below): a fake whose property setters silently dropped the write would make
// every channelInterpretation assertion vacuous while looking identical.

import { describe, it, expect, beforeEach } from 'vitest';
import type { AudioModuleDef } from './module-registry';
import type { ModuleNode } from '$lib/graph/types';
import { materializeAudioHandle, legInputsFor } from './dual-mono';
import { AudioEngine } from './engine';
import { registerModule } from './module-registry';

// ---------------------------------------------------------------------------
// A recording fake AudioContext (the engine-cv-scale.test.ts `connectionLog`
// pattern, extended with the channel properties this design turns on).
// ---------------------------------------------------------------------------

interface Conn { from: string; to: string; output?: number; input?: number }
let log: Conn[] = [];
let created: string[] = [];

interface FakeNode {
  __tag: string;
  channelCount: number;
  channelCountMode: string;
  channelInterpretation: string;
  connect(dst: unknown, output?: number, input?: number): void;
  disconnect(): void;
}

const tagOf = (x: unknown): string => {
  const o = x as { __tag?: string; __paramTag?: string };
  if (o.__paramTag) return `param:${o.__paramTag}`;
  return o.__tag ?? 'unknown';
};

/**
 * Every fake node is registered by tag so an assertion can recover the LIVE
 * object the wrapper mutated. Registering the object the factory RETURNS (never
 * a pre-spread copy) is load-bearing: a `{...n, gain}` spread copies properties
 * by value, so the registry would hold a node whose channelInterpretation never
 * changes — and every up-mix assertion would read 'speakers' no matter what the
 * wrapper did. That is the vacuous-instrument failure, one level down.
 */
let nodeRegistry = new Map<string, FakeNode>();

function makeNode<T extends object>(tag: string, extra: T): FakeNode & T {
  created.push(tag);
  const n = {
    __tag: tag,
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
    connect(dst: unknown, output?: number, input?: number) {
      log.push({ from: tag, to: tagOf(dst), output, input });
    },
    disconnect() { log.push({ from: tag, to: '<disconnected>' }); },
    ...extra,
  };
  nodeRegistry.set(tag, n);
  return n;
}

const makeParam = (tag: string, value = 0) => ({ __paramTag: tag, value, setValueAtTime(v: number) { this.value = v; } });

let gainSeq = 0;
function makeCtx(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain() {
      const tag = `gain${gainSeq++}`;
      return makeNode(tag, { gain: makeParam(`${tag}.gain`, 1) });
    },
    createChannelSplitter(n: number) { return makeNode(`splitter${n}`, {}); },
    createChannelMerger(n: number) { return makeNode(`merger${n}`, {}); },
    createConstantSource() {
      return makeNode('const', { offset: makeParam('const.offset', 0), start() {}, stop() {} });
    },
  } as unknown as AudioContext;
}

/** The live `.gain` value of a recorded GainNode — the normals are asserted
 *  through this, so a tag that names a non-gain node throws instead of
 *  silently reading `undefined` (which would compare unequal to 1 AND to 0 and
 *  make the assertion unfalsifiable in both directions). */
function recordedGain(tag: string): number {
  const n = recordedNode(tag) as FakeNode & { gain?: { value: number } };
  if (!n.gain) throw new Error(`recorded node '${tag}' is not a GainNode`);
  return n.gain.value;
}

/** Recover the LIVE fake node behind a recorded tag. */
function recordedNode(tag: string): FakeNode {
  const hit = nodeRegistry.get(tag);
  if (!hit) throw new Error(`no recorded node '${tag}' (have: ${[...nodeRegistry.keys()].join(', ')})`);
  return hit;
}

// ---------------------------------------------------------------------------
// Fake instances of the REAL module types, so the wrapper takes the real path.
// (`filter` is 'dual-mono' with a node-path CV input; `destroy` is 'dual-mono'
// with AudioParam-path CV inputs; `featurecv` is 'sum'; `vca` is 'deferred'.)
// ---------------------------------------------------------------------------

let factoryCalls = 0;
let disposals: string[] = [];

function fakeDef(
  type: string,
  inputs: { id: string; type: string; param?: boolean }[],
  outputs: { id: string; type: string }[],
  extra: Record<string, unknown> = {},
): AudioModuleDef {
  return {
    type, domain: 'audio', label: type, category: 'test',
    inputs: inputs.map((p) => ({ id: p.id, type: p.type })),
    outputs: outputs.map((p) => ({ id: p.id, type: p.type })),
    params: [],
    async factory(ctx: AudioContext) {
      const i = factoryCalls++;
      const core = makeNode(`${type}#${i}`, {});
      return {
        domain: 'audio' as const,
        inputs: new Map(inputs.map((p) => [p.id, {
          node: core as unknown as AudioNode,
          input: 0,
          ...(p.param ? { param: makeParam(`${type}#${i}.${p.id}`) as unknown as AudioParam } : {}),
        }])),
        outputs: new Map(outputs.map((p) => [p.id, { node: core as unknown as AudioNode, output: 0 }])),
        setParam(id: string, v: number) { log.push({ from: `${type}#${i}`, to: `setParam:${id}=${v}` }); },
        readParam() { return i; },
        dispose() { disposals.push(`${type}#${i}`); },
        ...extra,
      };
    },
  } as unknown as AudioModuleDef;
}

const NODE = { id: 'n1', type: 'x', domain: 'audio', position: { x: 0, y: 0 }, params: {} } as ModuleNode;

const conns = (from: string) => log.filter((c) => c.from === from && c.to !== '<disconnected>');

/** BFS the recorded graph from `start` to `goal`; returns the visited tags. */
function reaches(start: string, goal: string): string[] | null {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of conns(cur)) {
      if (c.to === goal) return [...seen];
      if (seen.has(c.to)) continue;
      seen.add(c.to);
      queue.push(c.to);
    }
  }
  return null;
}

beforeEach(() => {
  log = []; created = []; factoryCalls = 0; disposals = []; gainSeq = 0;
  nodeRegistry = new Map();
});

// ---------------------------------------------------------------------------

describe('dual-mono wrapper — the recorder is not lying (instrument check)', () => {
  it('a fake node round-trips the channel properties the design sets', () => {
    const ctx = makeCtx();
    const g = ctx.createGain() as unknown as FakeNode;
    g.channelCount = 2;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'discrete';
    // If these came back as the defaults, every up-mix assertion below would be
    // vacuous while reading exactly the same.
    expect([g.channelCount, g.channelCountMode, g.channelInterpretation])
      .toEqual([2, 'explicit', 'discrete']);
  });

  it('the connection log records output/input indices', () => {
    const ctx = makeCtx();
    const a = ctx.createGain() as unknown as FakeNode;
    const b = ctx.createGain() as unknown as FakeNode;
    a.connect(b, 3, 5);
    expect(log).toContainEqual({ from: 'gain0', to: 'gain1', output: 3, input: 5 });
  });
});

describe('dual-mono wrapper — TWO instances behind an up-mix + split', () => {
  const def = fakeDef('filter',
    [{ id: 'audio', type: 'audio' }, { id: 'cutoff', type: 'cv' }, { id: 'res', type: 'cv' }],
    [{ id: 'audio', type: 'audio' }]);

  it('calls the factory exactly TWICE', async () => {
    await materializeAudioHandle(makeCtx(), def, NODE);
    expect(factoryCalls).toBe(2);
  });

  it('⚠ the up-mix stage is 2ch / EXPLICIT / SPEAKERS — the mono-patch guard', async () => {
    await materializeAudioHandle(makeCtx(), def, NODE);
    // The stage feeding the splitter. Found structurally (whatever connects to
    // the splitter), never by index, so a reordering cannot silently pass.
    const feeder = log.find((c) => c.to === 'splitter2')!;
    expect(feeder, 'nothing feeds the ChannelSplitter').toBeDefined();
    const up = recordedNode(feeder.from);
    expect(up.channelCount, 'up-mix channelCount').toBe(2);
    expect(up.channelCountMode, 'up-mix channelCountMode').toBe('explicit');
    // THE ONE THAT MATTERS. 'discrete' here ZERO-FILLS channel 1 and turns every
    // existing mono patch left-only (plan §1b / #1343). The signal proof is in
    // art/scenarios/stereo-dual-mono/.
    expect(up.channelInterpretation, 'up-mix channelInterpretation').toBe('speakers');
  });

  it('splitter ch0 → instance A, ch1 → instance B (never both to one)', async () => {
    await materializeAudioHandle(makeCtx(), def, NODE);
    const out = conns('splitter2');
    expect(out).toHaveLength(2);
    expect(out.map((c) => ({ to: c.to, ch: c.output }))).toEqual([
      { to: 'filter#0', ch: 0 },
      { to: 'filter#1', ch: 1 },
    ]);
  });

  it('the audio input the ENGINE sees reaches the splitter through the up-mix', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    const entry = handle.inputs.get('audio')!;
    const start = (entry.node as unknown as FakeNode).__tag;
    // Walk the graph rather than counting hops: a hop count is a restatement of
    // the implementation and breaks on any refactor, which tells you nothing.
    const path = reaches(start, 'splitter2');
    expect(path, `${start} does not reach the splitter`).not.toBeNull();
    expect(path, 'the default (mono) input must pass through the up-mix').toContain('gain1');
    expect(entry.param, 'the audio input must not be an AudioParam').toBeUndefined();
  });

  it('both instances are merged back into ONE stereo output port', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    expect(handle.outputs.size).toBe(1);
    const merger = (handle.outputs.get('audio')!.node as unknown as FakeNode).__tag;
    expect(merger).toBe('merger2');
    expect(conns('filter#0')).toContainEqual({ from: 'filter#0', to: 'merger2', output: 0, input: 0 });
    expect(conns('filter#1')).toContainEqual({ from: 'filter#1', to: 'merger2', output: 0, input: 1 });
  });

  it('a node-path CV input fans to BOTH instances (one LFO, both channels)', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    const fan = (handle.inputs.get('res')!.node as unknown as FakeNode).__tag;
    expect(conns(fan).map((c) => c.to).sort()).toEqual(['filter#0', 'filter#1']);
    expect(handle.inputs.get('res')!.param).toBeUndefined();
  });
});

describe('dual-mono wrapper — an AudioParam CV input reaches BOTH params', () => {
  // destroy's decimate/bits/wet resolve to Faust AudioParams. The engine
  // connects the (CV-scaled) source straight to `din.param`, so handing it
  // instance A's param would leave the RIGHT channel unmodulated — the knob
  // value on one side, a sweep on the other. A ConstantSourceNode re-emits the
  // CV as a signal we can fan.
  const def = fakeDef('destroy',
    [{ id: 'audio', type: 'audio' }, { id: 'decimate', type: 'cv', param: true }],
    [{ id: 'audio', type: 'audio' }]);

  it('exposes a param that is NOT either instance\'s own param', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    const p = handle.inputs.get('decimate')!.param as unknown as { __paramTag: string };
    expect(p).toBeDefined();
    expect(p.__paramTag).toBe('const.offset');
  });

  it('the fan reaches instance A AND instance B', async () => {
    await materializeAudioHandle(makeCtx(), def, NODE);
    expect(conns('const').map((c) => c.to).sort())
      .toEqual(['param:destroy#0.decimate', 'param:destroy#1.decimate']);
  });
});

describe('dual-mono wrapper — the handle contract', () => {
  const def = fakeDef('moog905', [{ id: 'audio', type: 'audio' }], [{ id: 'audio', type: 'audio' }]);

  it('setParam fans to both instances', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    handle.setParam('cutoff', 0.4);
    expect(log.filter((c) => c.to === 'setParam:cutoff=0.4').map((c) => c.from).sort())
      .toEqual(['moog905#0', 'moog905#1']);
  });

  it('dispose tears down BOTH instances and the scaffolding', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    handle.dispose();
    expect(disposals.sort()).toEqual(['moog905#0', 'moog905#1']);
    // every interposed node disconnected
    const disconnected = new Set(log.filter((c) => c.to === '<disconnected>').map((c) => c.from));
    for (const tag of ['gain0', 'gain1', 'splitter2', 'merger2']) {
      expect(disconnected, `${tag} leaked`).toContain(tag);
    }
  });

  it('REFUSES to duplicate a handle with read/write/videoSources', async () => {
    // SCOPE.readPolicy. read() is single-instance and has no defined answer for
    // two, so this is a hard failure rather than a silent left-channel meter.
    const withRead = fakeDef('reverb', [{ id: 'audio', type: 'audio' }],
      [{ id: 'audio', type: 'audio' }], { read: () => 1 });
    await expect(materializeAudioHandle(makeCtx(), withRead, NODE)).rejects.toThrow(/read\/write\/videoSources/);
    // and it disposes what it built rather than leaking two instances
    expect(disposals).toHaveLength(2);
  });
});

describe("'mono-fanout' class — ONE instance, output FANNED to BOTH channels", () => {
  // moog904a. The topology half of the fix; the SIGNAL half (the phase spread
  // collapsing) is measured in art/scenarios/stereo-dual-mono, which is the only
  // lane with real Web Audio and a real worklet.
  const def = fakeDef('moog904a',
    [{ id: 'audio', type: 'audio' }, { id: 'cutoff_cv', type: 'cv' }],
    [{ id: 'audio', type: 'audio' }]);

  it('calls the factory exactly ONCE — the whole point of the class', async () => {
    // TWO instances is the defect: each seeds its self-oscillation from its own
    // Math.random() dither, so the two channels are different signals and every
    // analyser tap in the app reads a random fraction of the true level.
    await materializeAudioHandle(makeCtx(), def, NODE);
    expect(factoryCalls).toBe(1);
  });

  it('the ONE instance feeds BOTH merger inputs (Δφ = 0 by construction)', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    const merger = (handle.outputs.get('audio')!.node as unknown as FakeNode).__tag;
    expect(merger).toBe('merger2');
    // Both merger inputs are fed BY THE SAME NODE — that identity is the fix.
    expect(conns('moog904a#0').filter((c) => c.to === merger).map((c) => c.input).sort())
      .toEqual([0, 1]);
  });

  it('the engine-facing input reaches the instance through a 1ch SPEAKERS down-mix', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    const entry = handle.inputs.get('audio')!;
    const start = (entry.node as unknown as FakeNode).__tag;
    // Walk the graph rather than counting hops (the buildDualMono precedent).
    const path = reaches(start, 'moog904a#0');
    expect(path, `${start} does not reach the instance`).not.toBeNull();
    // The stage that actually feeds the instance must be the DOWN-MIX. Found
    // structurally, so a reordering cannot silently pass.
    const feeder = log.find((c) => c.to === 'moog904a#0')!;
    expect(feeder, 'nothing feeds the instance').toBeDefined();
    const down = recordedNode(feeder.from);
    expect([down.channelCount, down.channelCountMode, down.channelInterpretation],
      'the stage feeding the DSP is not the (L+R)/2 down-mix — a stereo→mono '
      + 'patch would arrive summed, 6 dB hot').toEqual([1, 'explicit', 'speakers']);
  });

  it('builds NO splitter — one instance means nothing to split TO', async () => {
    await materializeAudioHandle(makeCtx(), def, NODE);
    expect(created.filter((t) => t.startsWith('splitter'))).toEqual([]);
  });

  it('⚠ KEEPS the leg inputs — so two cables AVERAGE instead of summing', async () => {
    // SCOPE.monoFanoutLegs. One instance has no side to protect, but Web Audio
    // sums two connections to one input, so without legs a stereo→mono patch
    // would feed the DSP L+R rather than (L+R)/2.
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    const legs = legInputsFor(handle, 'audio');
    expect(legs, 'a mono-fanout handle exposes no leg inputs — a stereo source\'s '
      + 'two cables would land on one node and SUM').toBeTruthy();
    expect(legs!.counts()).toEqual({ left: 0, right: 0 });
    // …and both legs really do reach the instance.
    for (const side of ['left', 'right'] as const) {
      const tag = (legs![side].node as unknown as FakeNode).__tag;
      expect(reaches(tag, 'moog904a#0'), `the ${side} leg does not reach the DSP`)
        .not.toBeNull();
    }
  });

  it('a NON-audio input goes straight to the instance (nothing to fan)', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    expect((handle.inputs.get('cutoff_cv')!.node as unknown as FakeNode).__tag)
      .toBe('moog904a#0');
  });

  it('dispose tears down the instance AND the scaffolding', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    handle.dispose();
    expect(disposals).toEqual(['moog904a#0']);
    const disconnected = new Set(log.filter((c) => c.to === '<disconnected>').map((c) => c.from));
    for (const tag of ['gain0', 'gain1', 'gain2', 'gain3', 'gain4', 'gain5', 'gain6', 'gain7']) {
      expect(disconnected, `${tag} leaked`).toContain(tag);
    }
    expect(disconnected, 'the merger leaked').toContain('merger2');
  });
});

describe("'sum' class — one instance, audio input DOWN-MIXED", () => {
  const def = fakeDef('featurecv', [{ id: 'in', type: 'audio' }],
    [{ id: 'loud', type: 'cv' }]);

  it('calls the factory ONCE (an FFT is not doubled for nothing)', async () => {
    await materializeAudioHandle(makeCtx(), def, NODE);
    expect(factoryCalls).toBe(1);
  });

  it('interposes a 1ch / EXPLICIT / SPEAKERS down-mix on the audio input', async () => {
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    const down = handle.inputs.get('in')!.node as unknown as FakeNode;
    expect(down.__tag).not.toBe('featurecv#0');
    expect([down.channelCount, down.channelCountMode, down.channelInterpretation])
      .toEqual([1, 'explicit', 'speakers']);
    // …and it actually reaches the module.
    expect(conns(down.__tag).map((c) => c.to)).toEqual(['featurecv#0']);
  });

  it('leaves NON-audio inputs untouched', async () => {
    const d2 = fakeDef('moog961',
      [{ id: 'audio_in', type: 'audio' }, { id: 's_in', type: 'gate' }],
      [{ id: 's_out_a', type: 'gate' }]);
    const handle = await materializeAudioHandle(makeCtx(), d2, NODE);
    expect((handle.inputs.get('s_in')!.node as unknown as FakeNode).__tag).toBe('moog961#0');
  });
});

describe('LEG PLACEMENT — two cables into one mono port must NOT sum', () => {
  // Driven through the REAL AudioEngine.addEdge, not by calling the placement
  // helper directly: the thing that can regress is the engine FORGETTING to
  // consult it, and a test that calls the helper itself is structurally unable
  // to see that. (The SIGNAL is proved in art/scenarios/stereo-dual-mono.)
  const wrapped = fakeDef('filter', [{ id: 'audio', type: 'audio' }],
    [{ id: 'audio', type: 'audio' }]);
  /** A stereo source: two audio outputs whose ids form a derived L/R pair. */
  const stereoSrc = fakeDef('clouds', [], [{ id: 'out_l', type: 'audio' }, { id: 'out_r', type: 'audio' }]);
  /** A mono source: one unpaired audio output. */
  const monoSrc = fakeDef('vco', [], [{ id: 'audio', type: 'audio' }]);

  const edge = (id: string, fromPort: string) => ({
    id, source: { nodeId: 'src', portId: fromPort }, target: { nodeId: 'dst', portId: 'audio' },
    sourceType: 'audio', targetType: 'audio',
  }) as unknown as Parameters<AudioEngine['addEdge']>[0];

  async function rig(srcDef: AudioModuleDef) {
    registerModule(srcDef as never);
    registerModule(wrapped as never);
    const eng = new AudioEngine(makeCtx());
    await eng.addNode({ ...NODE, id: 'src', type: srcDef.type } as never);
    await eng.addNode({ ...NODE, id: 'dst', type: 'filter' } as never);
    return eng;
  }

  it('out_l and out_r land on DIFFERENT nodes (the whole point)', async () => {
    const eng = await rig(stereoSrc);
    eng.addEdge(edge('e1', 'out_l'));
    eng.addEdge(edge('e2', 'out_r'));
    const targets = conns('clouds#0').map((c) => c.to);
    expect(targets).toHaveLength(2);
    expect(targets[0], 'both legs landed on the same node — Web Audio would SUM them '
      + 'and the stereo image dies at the first mono module').not.toBe(targets[1]);
  });

  it('a MONO source lands on the mono bus — byte-identical to before', async () => {
    const eng = await rig(monoSrc);
    eng.addEdge(edge('e1', 'audio'));
    const to = conns('vco#0')[0]!.to;
    const handle = eng.nodes.get('dst')!;
    expect(to).toBe((handle.inputs.get('audio')!.node as unknown as FakeNode).__tag);
  });

  it('the mono NORMAL closes only once the opposite leg exists', async () => {
    // A merger has the same zero-fill hazard as a discrete up-mix: an
    // unconnected input renders as silence. The normal is OPEN by default so a
    // LONE leg still reaches both channels; it closes when the sibling lands.
    const eng = await rig(stereoSrc);
    const legs = legInputsFor(eng.nodes.get('dst'), 'audio')!;
    expect(legs, 'the wrapped handle exposes no leg inputs').toBeTruthy();
    expect(legs.counts()).toEqual({ left: 0, right: 0 });

    eng.addEdge(edge('e1', 'out_l'));
    expect(legs.counts()).toEqual({ left: 1, right: 0 });
    expect(recordedGain('gain4'), 'L→R normal must stay OPEN for a lone left leg')
      .toBe(1);

    eng.addEdge(edge('e2', 'out_r'));
    expect(legs.counts()).toEqual({ left: 1, right: 1 });
    expect(recordedGain('gain4'), 'L→R normal must CLOSE once R exists').toBe(0);
    expect(recordedGain('gain5'), 'R→L normal must CLOSE once L exists').toBe(0);
  });

  it('removing a leg RE-OPENS the normal (no one-way latch)', async () => {
    const eng = await rig(stereoSrc);
    const legs = legInputsFor(eng.nodes.get('dst'), 'audio')!;
    eng.addEdge(edge('e1', 'out_l'));
    eng.addEdge(edge('e2', 'out_r'));
    eng.removeEdge('e2');
    expect(legs.counts()).toEqual({ left: 1, right: 0 });
    expect(recordedGain('gain4'),
      'unpatching R left the module playing silence on the right').toBe(1);
  });

  it('an UNWRAPPED target is untouched by any of this', async () => {
    registerModule(monoSrc as never);
    const plain = fakeDef('vca', [{ id: 'audio', type: 'audio' }], [{ id: 'audio', type: 'audio' }]);
    registerModule(plain as never);
    const eng = new AudioEngine(makeCtx());
    await eng.addNode({ ...NODE, id: 'src', type: 'vco' } as never);
    await eng.addNode({ ...NODE, id: 'dst', type: 'vca' } as never);
    expect(legInputsFor(eng.nodes.get('dst'), 'audio')).toBeNull();
    eng.addEdge(edge('e1', 'audio'));
    // Straight onto the factory's own node — no interposed scaffolding at all.
    const inner = (eng.nodes.get('dst')!.inputs.get('audio')!.node as unknown as FakeNode).__tag;
    expect(inner).toMatch(/^vca#/);
    expect(conns('vco#0')[0]!.to).toBe(inner);
  });
});

describe("'native-stereo' / 'deferred' — byte-identical to before this PR", () => {
  it('vca (deferred) gets the factory handle, untouched', async () => {
    const def = fakeDef('vca', [{ id: 'audio', type: 'audio' }],
      [{ id: 'audio', type: 'audio' }, { id: 'audio_inv', type: 'audio' }]);
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    expect(factoryCalls).toBe(1);
    expect((handle.inputs.get('audio')!.node as unknown as FakeNode).__tag).toBe('vca#0');
    expect(created.filter((t) => t.startsWith('gain'))).toEqual([]);
  });

  it('delay (native-stereo) gets the factory handle, untouched', async () => {
    const def = fakeDef('delay', [{ id: 'audio', type: 'audio' }], [{ id: 'audio', type: 'audio' }]);
    const handle = await materializeAudioHandle(makeCtx(), def, NODE);
    expect(factoryCalls).toBe(1);
    expect((handle.inputs.get('audio')!.node as unknown as FakeNode).__tag).toBe('delay#0');
  });

  it('an UNCLASSIFIED module (2 audio inputs) is passed straight through', async () => {
    const def = fakeDef('mixer',
      [{ id: 'in1', type: 'audio' }, { id: 'in2', type: 'audio' }], [{ id: 'out', type: 'audio' }]);
    await materializeAudioHandle(makeCtx(), def, NODE);
    expect(factoryCalls).toBe(1);
  });
});
