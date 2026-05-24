// packages/web/src/lib/audio/engine-video-audio-bridge.test.ts
//
// Round-trip for the video→audio cross-domain bridge introduced in
// PR-A of the DOOM module pipeline. The bridge mirrors the existing
// audio→video texture bridge: a video module (DOOM, in the consumer
// PR) publishes one AudioNode per declared audio-typed output port
// via VideoNodeHandle.audioSources; PatchEngine.addEdge looks the
// AudioNode up via VideoEngine.getAudioSource and connects it into
// the downstream audio module's input via AudioEngine.getInputNode.
//
// What this file pins:
//   1. registerDomain wires the AudioContext into a video engine that
//      implements setAudioContext (so video modules see ctx.audioCtx
//      in their factory).
//   2. addEdge with sourceDomain='video' + targetDomain='audio' +
//      sourceType='audio' takes the bridge branch (it doesn't fall
//      through to a domain-engine dispatch).
//   3. The bridge actually .connect()s the upstream AudioNode (the
//      video module's published source) into the downstream input
//      (the audio sink's input AudioNode), at the right input index.
//   4. removeEdge fires the bridge teardown — .disconnect() is called
//      with matching args.
//   5. Bridge survives "source not yet materialized" without throwing
//      (defer + mark id only).
//
// The real GL behavior of DOOM and the real Web Audio plumbing land
// in the e2e suite — here we mirror engine-cv-scale.test.ts's pattern
// of a recording fake AudioContext + a no-op recording VideoEngine.

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule } from './module-registry';
import type { Edge, ModuleNode } from '$lib/graph/types';

// ---- Recorded-connection AudioContext fake (mirror engine-cv-scale.test.ts) ----

interface ConnRec {
  fromTag: string;
  toTag: string;
  output?: number;
  input?: number;
  kind: 'connect' | 'disconnect';
}

let connectionLog: ConnRec[] = [];

function makeFakeNode(t: string): {
  __tag: string;
  connect: (dest: unknown, output?: number, input?: number) => void;
  disconnect: (...args: unknown[]) => void;
} {
  return {
    __tag: t,
    connect(dest, output, input) {
      const dt =
        (dest as { __tag?: string }).__tag
        ?? 'audioparam:' + ((dest as { __paramTag?: string }).__paramTag ?? 'unknown');
      connectionLog.push({ fromTag: t, toTag: dt, output, input, kind: 'connect' });
    },
    disconnect(dest, output, input) {
      const dt =
        (dest as { __tag?: string } | undefined)?.__tag
        ?? 'audioparam:' + ((dest as { __paramTag?: string } | undefined)?.__paramTag ?? 'unknown');
      connectionLog.push({
        fromTag: t,
        toTag: dt,
        output: output as number | undefined,
        input: input as number | undefined,
        kind: 'disconnect',
      });
    },
  };
}

function makeFakeParam(paramTag: string, defaultValue = 0): {
  __paramTag: string;
  value: number;
  setValueAtTime: (v: number, _t: number) => void;
} {
  return {
    __paramTag: paramTag,
    value: defaultValue,
    setValueAtTime(v: number) { this.value = v; },
  };
}

function makeFakeAudioContext(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain() { return { ...makeFakeNode('gain'), gain: makeFakeParam('gain.gain', 1) }; },
    createWaveShaper() {
      const ws = makeFakeNode('waveshaper');
      let curve: Float32Array | null = null;
      return {
        ...ws,
        get curve() { return curve; },
        set curve(c) { curve = c; },
        oversample: 'none' as const,
      };
    },
    createAnalyser() {
      return {
        ...makeFakeNode('analyser'),
        fftSize: 32,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData() { /* */ },
      };
    },
    createConstantSource() {
      return {
        ...makeFakeNode('const'),
        offset: makeFakeParam('const.offset', 0),
        start() { /* */ },
        stop() { /* */ },
      };
    },
    createOscillator() {
      return {
        ...makeFakeNode('osc'),
        frequency: makeFakeParam('osc.frequency', 440),
        start() { /* */ },
        stop() { /* */ },
      };
    },
    createChannelMerger() { return makeFakeNode('merger'); },
    createChannelSplitter() { return makeFakeNode('splitter'); },
  } as unknown as AudioContext;
}

// ---- A minimal audio sink def that publishes a single audio input. ----

const AUDIO_SINK_DEF: AudioModuleDef = {
  type: 'videoAudioBridgeTestSink',
  domain: 'audio',
  label: 'Sink',
  category: 'output',
  schemaVersion: 1,
  inputs: [{ id: 'in', type: 'audio' }],
  outputs: [],
  params: [],
  async factory(_ctx, _node) {
    const sinkNode = makeFakeNode('sink');
    return {
      domain: 'audio' as const,
      inputs: new Map([
        ['in', { node: sinkNode as unknown as AudioNode, input: 0 }],
      ]),
      outputs: new Map(),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

// ---- A "video-domain" recording engine that holds a registry of stub
// audio sources keyed by (nodeId, portId). Mirrors the recording video
// engine in param-chain.test.ts but adds the setAudioContext +
// getAudioSource methods the bridge code talks to. ----

class VideoEngineStub implements DomainEngine {
  domain = 'video' as const;
  audioCtx: AudioContext | null = null;
  /** (nodeId|portId) → fake AudioNode + output index. Tests populate. */
  sources = new Map<string, { node: AudioNode; output: number }>();

  setAudioContext(ctx: AudioContext | null): void {
    this.audioCtx = ctx;
  }

  getAudioSource(nodeId: string, portId: string): { node: AudioNode; output: number } | null {
    return this.sources.get(`${nodeId}::${portId}`) ?? null;
  }

  async addNode(_n: ModuleNode): Promise<void> { /* no-op */ }
  removeNode(_id: string): void { /* no-op */ }
  addEdge(_e: Edge): void { /* no-op */ }
  removeEdge(_id: string): void { /* no-op */ }
  setParam(_id: string, _p: string, _v: number): void { /* no-op */ }
  readParam(): undefined { return undefined; }
  read(): unknown { return undefined; }
  dispose(): void { /* no-op */ }
}

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registerModule(AUDIO_SINK_DEF);
  registered = true;
}

describe('PatchEngine — video → audio cross-domain bridge', () => {
  beforeEach(() => {
    connectionLog = [];
    ensureRegistered();
  });

  it('registerDomain threads the AudioContext into the VideoEngine', () => {
    const ctx = makeFakeAudioContext();
    const ae = new AudioEngine(ctx);
    const ve = new VideoEngineStub();

    const pe = new PatchEngine();
    // Register video FIRST — we want to prove the wiring fires regardless
    // of which side comes first (Canvas.svelte's boot order is
    // audio-first in production but we don't want the bridge to depend
    // on that).
    pe.registerDomain(ve);
    expect(ve.audioCtx).toBeNull();

    pe.registerDomain(ae);
    expect(ve.audioCtx).toBe(ctx);

    pe.dispose();
  });

  it('addEdge wires the video module audio source into the audio sink input', async () => {
    const ctx = makeFakeAudioContext();
    const ae = new AudioEngine(ctx);
    const ve = new VideoEngineStub();

    const pe = new PatchEngine();
    pe.registerDomain(ae);
    pe.registerDomain(ve);

    // The video module publishes a fake OscillatorNode-shaped source
    // on (nodeId='v-doom', portId='audio_l').
    const oscFake = makeFakeNode('doom-osc-l');
    ve.sources.set('v-doom::audio_l', {
      node: oscFake as unknown as AudioNode,
      output: 0,
    });

    // The audio sink is a real AudioEngine node — addNode goes through
    // the registered AudioModuleDef factory.
    const sinkNode: ModuleNode = {
      id: 'a-sink',
      type: 'videoAudioBridgeTestSink',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    };
    await ae.addNode(sinkNode);

    const edge: Edge = {
      id: 'e1',
      source: { nodeId: 'v-doom', portId: 'audio_l' },
      target: { nodeId: 'a-sink', portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    pe.addEdge(edge, 'video', 'audio');

    // The bridge should have connected the published source AudioNode
    // into the sink's input AudioNode. We assert via the fake's
    // connectionLog, filtering for the upstream side ("doom-osc-l").
    const myConns = connectionLog.filter((c) => c.fromTag === 'doom-osc-l' && c.kind === 'connect');
    expect(myConns).toEqual([
      { fromTag: 'doom-osc-l', toTag: 'sink', output: 0, input: 0, kind: 'connect' },
    ]);

    // removeEdge must fire the matching disconnect.
    pe.removeEdge(edge, 'video');
    const myDisc = connectionLog.filter((c) => c.fromTag === 'doom-osc-l' && c.kind === 'disconnect');
    expect(myDisc).toEqual([
      { fromTag: 'doom-osc-l', toTag: 'sink', output: 0, input: 0, kind: 'disconnect' },
    ]);

    pe.dispose();
  });

  it('addEdge defers when the video source is not yet materialized', async () => {
    const ctx = makeFakeAudioContext();
    const ae = new AudioEngine(ctx);
    const ve = new VideoEngineStub();
    const pe = new PatchEngine();
    pe.registerDomain(ae);
    pe.registerDomain(ve);

    const sinkNode: ModuleNode = {
      id: 'a-sink',
      type: 'videoAudioBridgeTestSink',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    };
    await ae.addNode(sinkNode);

    // ve.sources is empty — bridge can't resolve the source. Should
    // mark the id (so removeEdge symmetric cleanup works) but NOT
    // throw, and NOT issue any connect() calls.
    const edge: Edge = {
      id: 'e1',
      source: { nodeId: 'v-doom', portId: 'audio_l' },
      target: { nodeId: 'a-sink', portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    expect(() => pe.addEdge(edge, 'video', 'audio')).not.toThrow();
    expect(connectionLog.filter((c) => c.kind === 'connect')).toEqual([]);

    // removeEdge clears the placeholder cleanly.
    expect(() => pe.removeEdge(edge, 'video')).not.toThrow();

    pe.dispose();
  });

  it('falls back to source-domain dispatch when sourceType is not audio', () => {
    // The bridge is opt-in by source type. A video→audio edge with
    // sourceType='cv' (hypothetical: DOOM publishes a CV port someday)
    // doesn't take the audio bridge — it falls back to source-domain
    // dispatch. We just prove the bridge isn't engaged (no audioBridge
    // teardown registered) by asserting the connectionLog stays empty.
    const ctx = makeFakeAudioContext();
    const ae = new AudioEngine(ctx);
    const ve = new VideoEngineStub();
    const pe = new PatchEngine();
    pe.registerDomain(ae);
    pe.registerDomain(ve);

    const oscFake = makeFakeNode('doom-cv-source');
    ve.sources.set('v-doom::cv_out', {
      node: oscFake as unknown as AudioNode,
      output: 0,
    });

    const edge: Edge = {
      id: 'e1',
      source: { nodeId: 'v-doom', portId: 'cv_out' },
      target: { nodeId: 'something', portId: 'in' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    // No throw — the bridge branch is bypassed, fallthrough calls
    // VideoEngineStub.addEdge which is a no-op.
    expect(() => pe.addEdge(edge, 'video', 'audio')).not.toThrow();
    expect(connectionLog.filter((c) => c.fromTag === 'doom-cv-source')).toEqual([]);

    pe.dispose();
  });
});
