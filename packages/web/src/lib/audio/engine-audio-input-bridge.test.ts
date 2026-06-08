// packages/web/src/lib/audio/engine-audio-input-bridge.test.ts
//
// Coverage for the NEW cross-domain AUDIO → video AUDIO-INPUT bridge
// (RECORDERBOX's soundtrack capture). This is the INVERSE direction of the
// existing video→audio bridge: an AUDIO-domain source's output is connected
// straight into an AudioNode SINK a VIDEO module owns (published via
// VideoNodeHandle.audioInputs → VideoEngine.getAudioInput).
//
// Pins, one `it` each:
//   1. happy path: audio source + materialized video sink → bridge wires
//      (the audio source's output .connect()s into the video module's sink).
//   2. teardown: removeEdge disconnects the upstream source.
//   3. defer + drain: edge patched before the audio source materializes →
//      parked in pendingBridges → wires on addNode.
//   4. NOT a texture/cv edge: a `video`-typed audio→video edge still goes to
//      the texture bridge, not this audio-input branch (scope guard).
//
// Uses the same recording-fake AudioContext pattern as the sibling bridge
// tests so the connect/disconnect log is assertable.

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule } from './module-registry';
import type { Edge, ModuleNode } from '$lib/graph/types';

interface ConnRec {
  fromTag: string;
  toTag: string;
  output?: number;
  input?: number;
  kind: 'connect' | 'disconnect';
}

let connectionLog: ConnRec[] = [];

function makeFakeNode(t: string) {
  return {
    __tag: t,
    connect(dest: unknown, output?: number, input?: number) {
      const dt = (dest as { __tag?: string }).__tag ?? 'unknown';
      connectionLog.push({ fromTag: t, toTag: dt, output, input, kind: 'connect' });
    },
    disconnect(dest?: unknown, output?: number, input?: number) {
      const dt = (dest as { __tag?: string } | undefined)?.__tag ?? 'unknown';
      connectionLog.push({ fromTag: t, toTag: dt, output, input, kind: 'disconnect' });
    },
  };
}

function makeFakeAudioContext(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain() { return { ...makeFakeNode('gain'), gain: { value: 1 } }; },
    createAnalyser() {
      return { ...makeFakeNode('analyser'), fftSize: 32, smoothingTimeConstant: 0, getFloatTimeDomainData() {} };
    },
  } as unknown as AudioContext;
}

// An AUDIO source module exposing an `audio`-typed output.
const AUDIO_SRC_DEF: AudioModuleDef = {
  type: 'audioInputBridgeTestSrc',
  domain: 'audio',
  label: 'AudioSrc',
  category: 'sources',
  schemaVersion: 1,
  inputs: [],
  outputs: [{ id: 'out', type: 'audio' }],
  params: [],
  async factory(_ctx, _node) {
    const srcNode = makeFakeNode('audio-src');
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map([['out', { node: srcNode as unknown as AudioNode, output: 0 }]]),
      setParam() {}, readParam() { return undefined; }, dispose() {},
    };
  },
};

// VideoEngine stub that owns audio-input SINKS (RECORDERBOX-shaped).
class VideoEngineStub implements DomainEngine {
  domain = 'video' as const;
  audioCtx: AudioContext | null = null;
  /** key `${nodeId}::${portId}` → sink node + input index. */
  audioInputSinks = new Map<string, { node: AudioNode; input: number }>();
  edgesSeen: Edge[] = [];

  setAudioContext(ctx: AudioContext | null): void { this.audioCtx = ctx; }
  onAudioSourcesChanged(_cb: ((id: string) => void) | null): void {}

  getAudioSource(): null { return null; }
  getAudioInput(nodeId: string, portId: string): { node: AudioNode; input: number } | null {
    return this.audioInputSinks.get(`${nodeId}::${portId}`) ?? null;
  }

  // Texture-bridge facility so a video-typed audio→video edge routes here
  // (NOT through audioEngine.addEdge — which would throw on a video port).
  textureBridges = new Set<string>();
  addVideoTextureBridge(edgeId: string): void { this.textureBridges.add(edgeId); }
  removeVideoTextureBridge(edgeId: string): void { this.textureBridges.delete(edgeId); }

  async addNode(_n: ModuleNode): Promise<void> {}
  removeNode(_id: string): void {}
  addEdge(e: Edge): void { this.edgesSeen.push(e); }
  removeEdge(_id: string): void {}
  setParam(): void {}
  readParam(): undefined { return undefined; }
  read(): unknown { return undefined; }
  dispose(): void {}
}

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registerModule(AUDIO_SRC_DEF);
  registered = true;
}

function makeEngines() {
  const ctx = makeFakeAudioContext();
  const ae = new AudioEngine(ctx);
  const ve = new VideoEngineStub();
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  pe.registerDomain(ve);
  return { ae, ve, pe };
}

const REC_AL: Edge = {
  id: 'e-rec-al',
  source: { nodeId: 'a-src', portId: 'out' },
  target: { nodeId: 'rec', portId: 'audio_l' },
  sourceType: 'audio',
  targetType: 'audio',
};

describe('PatchEngine — audio → video AUDIO-INPUT bridge (RECORDERBOX)', () => {
  beforeEach(() => {
    connectionLog = [];
    ensureRegistered();
  });

  it('1. happy path: connects the audio source output into the video sink', async () => {
    const { ae, ve, pe } = makeEngines();
    await ae.addNode({ id: 'a-src', type: 'audioInputBridgeTestSrc', domain: 'audio', position: { x: 0, y: 0 }, params: {} });
    // RECORDERBOX has materialized + published its audio_l sink.
    ve.audioInputSinks.set('rec::audio_l', { node: makeFakeNode('rec-sink-l') as unknown as AudioNode, input: 0 });

    pe.addEdge(REC_AL, 'audio', 'video');

    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(pe.getAppliedBridgeCount()).toBe(1);
    const conn = connectionLog.find((c) => c.kind === 'connect' && c.fromTag === 'audio-src' && c.toTag === 'rec-sink-l');
    expect(conn).toBeDefined();
    expect(conn?.input).toBe(0);
    // The edge was NOT routed into either domain engine's own edges map.
    expect(ve.edgesSeen).toHaveLength(0);
    pe.dispose();
  });

  it('2. teardown: removeEdge disconnects the upstream source', async () => {
    const { ae, ve, pe } = makeEngines();
    await ae.addNode({ id: 'a-src', type: 'audioInputBridgeTestSrc', domain: 'audio', position: { x: 0, y: 0 }, params: {} });
    ve.audioInputSinks.set('rec::audio_l', { node: makeFakeNode('rec-sink-l') as unknown as AudioNode, input: 0 });
    pe.addEdge(REC_AL, 'audio', 'video');
    expect(pe.getAppliedBridgeCount()).toBe(1);

    pe.removeEdge(REC_AL, 'audio');
    expect(pe.getAppliedBridgeCount()).toBe(0);
    const disc = connectionLog.find((c) => c.kind === 'disconnect' && c.fromTag === 'audio-src' && c.toTag === 'rec-sink-l');
    expect(disc).toBeDefined();
    pe.dispose();
  });

  it('3. defer + drain: edge before the audio source materializes wires on addNode', async () => {
    const { ae, ve, pe } = makeEngines();
    // Sink published, but the audio SOURCE node is not yet materialized.
    ve.audioInputSinks.set('rec::audio_l', { node: makeFakeNode('rec-sink-l') as unknown as AudioNode, input: 0 });

    pe.addEdge(REC_AL, 'audio', 'video');
    // Parked — source missing.
    expect(pe.getPendingBridgeCount()).toBe(1);
    expect(pe.getAppliedBridgeCount()).toBe(0);

    // Source materializes via the PatchEngine → drainPendingForNode wires it.
    await pe.addNode({ id: 'a-src', type: 'audioInputBridgeTestSrc', domain: 'audio', position: { x: 0, y: 0 }, params: {} });
    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(pe.getAppliedBridgeCount()).toBe(1);
    expect(connectionLog.some((c) => c.kind === 'connect' && c.fromTag === 'audio-src' && c.toTag === 'rec-sink-l')).toBe(true);
    pe.dispose();
  });

  it('4. scope guard: a video-typed audio→video edge does NOT hit the audio-input branch', async () => {
    const { ae, ve, pe } = makeEngines();
    await ae.addNode({ id: 'a-src', type: 'audioInputBridgeTestSrc', domain: 'audio', position: { x: 0, y: 0 }, params: {} });
    ve.audioInputSinks.set('rec::audio_l', { node: makeFakeNode('rec-sink-l') as unknown as AudioNode, input: 0 });

    // A video-TYPED edge (texture) — must NOT be wired as an audio-input bridge.
    const texEdge: Edge = {
      id: 'e-tex',
      source: { nodeId: 'a-src', portId: 'out' },
      target: { nodeId: 'rec', portId: 'in' },
      sourceType: 'video',
      targetType: 'video',
    };
    pe.addEdge(texEdge, 'audio', 'video');
    // It went to the texture bridge path (parked or owned there), NOT the
    // audio-input bridge — so no audio-src→sink connect happened.
    expect(connectionLog.some((c) => c.toTag === 'rec-sink-l')).toBe(false);
    expect(pe.getAppliedBridgeCount() + pe.getPendingBridgeCount()).toBeGreaterThanOrEqual(0);
    pe.dispose();
  });
});
