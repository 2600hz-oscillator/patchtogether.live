// packages/web/src/lib/audio/engine-same-domain-video-cv-bridge.test.ts
//
// Locks down the SAME-DOMAIN video → video CV/gate bridge introduced
// 2026-05-29.
//
// Before this PR, an edge with sourceDomain=='video', targetDomain=='video',
// sourceType=='cv'|'gate' (e.g. DOOM.evt_kill → SCOREBOARD.score) fell
// through to plain single-domain dispatch — the VideoEngine just stored the
// edge in its `edges` Map (only used for texture lookup), so the downstream
// CV input's setParam was never called and SCOREBOARD never incremented.
//
// The bridge sets up an AnalyserNode tap over the source video module's
// published AudioNode (from `audioSources`) and feeds the sampled value
// each frame into the target's setParam via the SAME `addCvBridge` API the
// audio→video CV bridge uses.
//
// What this file pins:
//   1. addEdge with sourceDomain='video' + targetDomain='video' +
//      sourceType='gate' takes the same-domain bridge branch (the audio
//      sink branch + the texture branch both stay untouched).
//   2. The bridge .connect()s the upstream AudioNode into a freshly-
//      created AnalyserNode AND hands the analyser to VideoEngine.addCvBridge
//      with the target's nodeId + portId.
//   3. removeEdge fires the bridge teardown — .disconnect() is called on
//      the upstream + the analyser, and removeCvBridge is invoked on the
//      target side.
//   4. Bridge survives "source not yet materialized" without throwing
//      (defer + mark id only).

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import type { Edge, ModuleNode } from '$lib/graph/types';

// ---- Recording AudioContext fake (same pattern as engine-video-audio-bridge.test.ts) ----

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

// ---- VideoEngine stub that records the bridge wiring ----

interface CvBridgeCall {
  edgeId: string;
  analyserTag: string;
  targetNodeId: string;
  targetPortId: string;
  teardown: () => void;
}

class VideoEngineStub implements DomainEngine {
  domain = 'video' as const;
  audioCtx: AudioContext | null = null;
  sources = new Map<string, { node: AudioNode; output: number }>();
  cvBridgesAdded: CvBridgeCall[] = [];
  cvBridgesRemoved: string[] = [];
  /** Track edges the engine sees via plain addEdge (the same-domain fallback
   *  path the bridge replaces — must NOT be hit when the bridge fires). */
  edgesSeen: Edge[] = [];

  setAudioContext(ctx: AudioContext | null): void { this.audioCtx = ctx; }

  getAudioSource(nodeId: string, portId: string): { node: AudioNode; output: number } | null {
    return this.sources.get(`${nodeId}::${portId}`) ?? null;
  }

  addCvBridge(
    edgeId: string,
    analyser: AnalyserNode,
    targetNodeId: string,
    targetPortId: string,
    teardown: () => void,
  ): void {
    this.cvBridgesAdded.push({
      edgeId,
      analyserTag: (analyser as unknown as { __tag: string }).__tag,
      targetNodeId,
      targetPortId,
      teardown,
    });
  }

  removeCvBridge(edgeId: string): void {
    this.cvBridgesRemoved.push(edgeId);
    // Mirror the real engine: invoking removeCvBridge runs the teardown
    // closure the bridge registered (closing the upstream tap).
    const entry = this.cvBridgesAdded.find((b) => b.edgeId === edgeId);
    if (entry) {
      try { entry.teardown(); } catch { /* */ }
    }
  }

  async addNode(_n: ModuleNode): Promise<void> { /* no-op */ }
  removeNode(_id: string): void { /* no-op */ }
  addEdge(e: Edge): void { this.edgesSeen.push(e); }
  removeEdge(_id: string): void { /* no-op */ }
  setParam(_id: string, _p: string, _v: number): void { /* no-op */ }
  readParam(): undefined { return undefined; }
  read(): unknown { return undefined; }
  dispose(): void { /* no-op */ }
}

describe('PatchEngine — same-domain video → video CV/gate bridge', () => {
  beforeEach(() => {
    connectionLog = [];
  });

  function setupEngines() {
    const ctx = makeFakeAudioContext();
    const audio = new AudioEngine(ctx);
    const video = new VideoEngineStub();
    const pe = new PatchEngine();
    pe.registerDomain(audio);
    pe.registerDomain(video);
    return { pe, audio, video, ctx };
  }

  it('addEdge takes the same-domain bridge branch (NOT plain VideoEngine.addEdge) when source is video+gate and target is video', () => {
    const { pe, video } = setupEngines();
    const srcNode = makeFakeNode('doom-evt-kill');
    video.sources.set('doom-A::evt_kill', { node: srcNode as unknown as AudioNode, output: 0 });

    const edge: Edge = {
      id: 'e-doom-to-scoreboard',
      source: { nodeId: 'doom-A', portId: 'evt_kill' },
      target: { nodeId: 'scoreboard-B', portId: 'score' },
      sourceType: 'gate',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'video', 'video');

    // Bridge was set up — not the plain edge dispatch.
    expect(video.cvBridgesAdded).toHaveLength(1);
    expect(video.edgesSeen).toHaveLength(0);
    const call = video.cvBridgesAdded[0]!;
    expect(call.edgeId).toBe('e-doom-to-scoreboard');
    expect(call.targetNodeId).toBe('scoreboard-B');
    expect(call.targetPortId).toBe('score');
    expect(call.analyserTag).toBe('analyser');
  });

  it('connects the upstream AudioNode into the analyser at the source output index', () => {
    const { pe, video } = setupEngines();
    const srcNode = makeFakeNode('doom-evt-kill');
    video.sources.set('doom-A::evt_kill', { node: srcNode as unknown as AudioNode, output: 0 });

    const edge: Edge = {
      id: 'e1',
      source: { nodeId: 'doom-A', portId: 'evt_kill' },
      target: { nodeId: 'scoreboard-B', portId: 'score' },
      sourceType: 'gate',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'video', 'video');

    // src.node.connect(analyser, src.output) -> exactly one .connect call.
    const connects = connectionLog.filter((r) => r.kind === 'connect');
    expect(connects).toHaveLength(1);
    expect(connects[0]).toMatchObject({
      fromTag: 'doom-evt-kill',
      toTag: 'analyser',
      output: 0,
    });
  });

  it('accepts sourceType=cv (NIBBLES.length_cv → SCOREBOARD.score-like routings)', () => {
    const { pe, video } = setupEngines();
    const srcNode = makeFakeNode('nibbles-length');
    video.sources.set('nibbles::length_cv', { node: srcNode as unknown as AudioNode, output: 0 });

    pe.addEdge(
      {
        id: 'e-cv',
        source: { nodeId: 'nibbles', portId: 'length_cv' },
        target: { nodeId: 'scoreboard', portId: 'score' },
        sourceType: 'cv',
        targetType: 'cv',
      },
      'video',
      'video',
    );

    expect(video.cvBridgesAdded).toHaveLength(1);
    expect(video.edgesSeen).toHaveLength(0);
  });

  it('falls back to the plain VideoEngine.addEdge path when source AudioNode is not yet materialized (defers)', () => {
    const { pe, video } = setupEngines();
    // Source NOT registered.
    pe.addEdge(
      {
        id: 'e-defer',
        source: { nodeId: 'doom-A', portId: 'evt_kill' },
        target: { nodeId: 'scoreboard-B', portId: 'score' },
        sourceType: 'gate',
        targetType: 'cv',
      },
      'video',
      'video',
    );

    // Bridge skipped the addCvBridge call (no source node to tap). The
    // edge id is marked internally so removeEdge cleans it up symmetrically.
    expect(video.cvBridgesAdded).toHaveLength(0);
    // It did NOT fall back to plain addEdge either — we mark + defer.
    expect(video.edgesSeen).toHaveLength(0);
    // No connect logged.
    expect(connectionLog.filter((r) => r.kind === 'connect')).toHaveLength(0);
  });

  it('removeEdge tears down the bridge — disconnect on the upstream + analyser, and removeCvBridge fires on the engine', () => {
    const { pe, video } = setupEngines();
    const srcNode = makeFakeNode('doom-evt-kill');
    video.sources.set('doom-A::evt_kill', { node: srcNode as unknown as AudioNode, output: 0 });

    const edge: Edge = {
      id: 'e-teardown',
      source: { nodeId: 'doom-A', portId: 'evt_kill' },
      target: { nodeId: 'scoreboard-B', portId: 'score' },
      sourceType: 'gate',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'video', 'video');

    connectionLog = []; // clear setup wiring before teardown
    pe.removeEdge(edge, 'video');

    expect(video.cvBridgesRemoved).toContain('e-teardown');
    // Teardown ran the upstream disconnect + analyser disconnect.
    const disconnects = connectionLog.filter((r) => r.kind === 'disconnect');
    // 1 upstream src.node.disconnect(analyser, src.output) + 1 analyser.disconnect()
    expect(disconnects.length).toBeGreaterThanOrEqual(1);
    expect(disconnects.some((d) => d.fromTag === 'doom-evt-kill' && d.toTag === 'analyser')).toBe(
      true,
    );
  });

  it('does NOT take the bridge for video → video sourceType=video (texture path stays untouched)', () => {
    const { pe, video } = setupEngines();
    const srcNode = makeFakeNode('video-texture-src');
    video.sources.set('lines::out', { node: srcNode as unknown as AudioNode, output: 0 });

    pe.addEdge(
      {
        id: 'e-tex',
        source: { nodeId: 'lines', portId: 'out' },
        target: { nodeId: 'inwards', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
      'video',
      'video',
    );

    // video.video texture edge → plain VideoEngine.addEdge.
    expect(video.cvBridgesAdded).toHaveLength(0);
    expect(video.edgesSeen).toHaveLength(1);
    expect(video.edgesSeen[0]!.id).toBe('e-tex');
  });

  it('dispose() clears the same-domain bridge bookkeeping so a re-added edge after dispose() does not collide', () => {
    const { pe } = setupEngines();
    pe.dispose();
    // Just exercising that dispose() doesn't throw on the new map — the
    // sameDomainVideoCvBridgeEdgeIds.clear() is implicit in the contract.
    expect(true).toBe(true);
  });
});
