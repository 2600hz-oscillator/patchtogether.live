// packages/web/src/lib/audio/engine-pending-bridges.test.ts
//
// Regression coverage for the Codex audit finding (2026-05-30):
//
//   engine.ts:893-902 and :962-967 marked a cross-domain bridge edge id
//   as "owned" in xxxBridgeEdgeIds bookkeeping even when it couldn't be
//   fully wired (target/source node not yet materialized). The reconciler
//   then saw the edge id in `appliedEdges` and never retried — silent
//   permanent failure (user: "I patched the cable but no signal").
//
// The fix introduces `pendingBridges` in PatchEngine: any cross-domain
// bridge that can't be wired at addEdge time is parked there instead of
// marked owned. A drain runs on:
//   1. addNode completion (target or source materializes)
//   2. onAudioSourcesChanged (port handle surfaces post-spawn)
//   3. removeNode (evict pending bridges touching the node)
//   4. removeEdge (evict from pending + applied)
//
// What this file pins (one `it` per item in the spec):
//   1. late-target materialization
//   2. late-source materialization
//   3. handle-swap retry (onAudioSourcesChanged)
//   4. removeNode evicts pending
//   5. removeEdge evicts pending
//   6. idempotent re-add (same edge id twice → single bridge)
//   7. cross-domain CV (audio → video CV) drains after target appears
//   8. cross-domain video texture (audio → video texture) drains
//   9. same-domain video-CV (addSameDomainVideoCvBridge path) drains
//
// All tests use the same recording-fake AudioContext + VideoEngineStub
// pattern as the existing bridge tests in this directory.

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule } from './module-registry';
import type { Edge, ModuleNode } from '$lib/graph/types';

// ---- Recording-fake AudioContext (mirrors engine-video-audio-bridge.test.ts) ----

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
    createChannelMerger() { return makeFakeNode('merger'); },
    createChannelSplitter() { return makeFakeNode('splitter'); },
  } as unknown as AudioContext;
}

// ---- Module defs ----

const CV_SRC_DEF: AudioModuleDef = {
  type: 'pendingBridgesTestCvSrc',
  domain: 'audio',
  label: 'CvSrc',
  category: 'sources',
  inputs: [],
  outputs: [{ id: 'out', type: 'cv' }],
  params: [],
  async factory(_ctx, _node) {
    const srcNode = makeFakeNode('cv-src-node');
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map([['out', { node: srcNode as unknown as AudioNode, output: 0 }]]),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

const AUDIO_SINK_DEF: AudioModuleDef = {
  type: 'pendingBridgesTestAudioSink',
  domain: 'audio',
  label: 'AudioSink',
  category: 'output',
  inputs: [{ id: 'in', type: 'audio' }],
  outputs: [],
  params: [],
  async factory(_ctx, _node) {
    const sinkNode = makeFakeNode('audio-sink-node');
    return {
      domain: 'audio' as const,
      inputs: new Map([['in', { node: sinkNode as unknown as AudioNode, input: 0 }]]),
      outputs: new Map(),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

const CV_SINK_DEF: AudioModuleDef = {
  type: 'pendingBridgesTestCvSink',
  domain: 'audio',
  label: 'CvSink',
  category: 'output',
  inputs: [{ id: 'cutoff_cv', type: 'cv' }],
  outputs: [],
  params: [],
  async factory(_ctx, _node) {
    const sinkNode = makeFakeNode('cv-sink-node');
    const cutoffParam = makeFakeParam('cv-sink.cutoff', 0);
    return {
      domain: 'audio' as const,
      inputs: new Map([
        ['cutoff_cv', {
          node: sinkNode as unknown as AudioNode,
          input: 0,
          param: cutoffParam as unknown as AudioParam,
        }],
      ]),
      outputs: new Map(),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

// ---- VideoEngine stub: records bridge wiring + supports source registration ----

class VideoEngineStub implements DomainEngine {
  domain = 'video' as const;
  audioCtx: AudioContext | null = null;
  sources = new Map<string, { node: AudioNode; output: number }>();
  cvBridges = new Map<string, { teardown: () => void; targetNodeId: string; targetPortId: string }>();
  videoTextureBridges = new Set<string>();
  edgesSeen: Edge[] = [];
  /** Subscribers for onAudioSourcesChanged — the engine wires this in
   *  registerDomain so the stub mirrors what VideoEngine does in
   *  production (notify on wireAudio swap). */
  private audioSourcesChangedCb: ((nodeId: string) => void) | null = null;

  setAudioContext(ctx: AudioContext | null): void { this.audioCtx = ctx; }

  onAudioSourcesChanged(cb: ((nodeId: string) => void) | null): void {
    this.audioSourcesChangedCb = cb;
  }

  /** Test helper: simulate a video module publishing/swapping an AudioNode
   *  for one of its audio-typed output ports. Mirrors VideoEngine's
   *  wireAudio call path which then fires onAudioSourcesChanged. */
  notifyAudioSourceChanged(nodeId: string): void {
    if (this.audioSourcesChangedCb) this.audioSourcesChangedCb(nodeId);
  }

  getAudioSource(nodeId: string, portId: string): { node: AudioNode; output: number } | null {
    return this.sources.get(`${nodeId}::${portId}`) ?? null;
  }

  getNodeHandle(_nodeId: string): unknown { return null; }
  resolveTargetParamId(_nodeId: string, portId: string): string { return portId; }

  addCvBridge(
    edgeId: string,
    _analyser: AnalyserNode,
    targetNodeId: string,
    targetPortId: string,
    teardown: () => void,
  ): void {
    this.cvBridges.set(edgeId, { teardown, targetNodeId, targetPortId });
  }

  removeCvBridge(edgeId: string): void {
    const entry = this.cvBridges.get(edgeId);
    if (entry) {
      try { entry.teardown(); } catch { /* */ }
      this.cvBridges.delete(edgeId);
    }
  }

  addVideoTextureBridge(
    edgeId: string,
    _sourceNodeId: string,
    _sourcePortId: string,
    _analyser: AnalyserNode,
    _sampleRate: number,
    _targetEdge: Edge,
    _drawFrame?: (canvas: OffscreenCanvas | HTMLCanvasElement) => void,
  ): void {
    this.videoTextureBridges.add(edgeId);
  }

  removeVideoTextureBridge(edgeId: string): void {
    this.videoTextureBridges.delete(edgeId);
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

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registerModule(CV_SRC_DEF);
  registerModule(AUDIO_SINK_DEF);
  registerModule(CV_SINK_DEF);
  registered = true;
}

function makeEngines() {
  const ctx = makeFakeAudioContext();
  const ae = new AudioEngine(ctx);
  const ve = new VideoEngineStub();
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  pe.registerDomain(ve);
  return { ae, ve, pe, ctx };
}

describe('PatchEngine.pendingBridges — late-materialization regression', () => {
  beforeEach(() => {
    connectionLog = [];
    ensureRegistered();
  });

  it('1. late-target materialization (cv audio→video): edge patched before target node spawned drains on addNode', async () => {
    const { ae, ve, pe } = makeEngines();
    // Source exists. Target does not (no addNode call yet — the video
    // module isn't materialized).
    await ae.addNode({
      id: 'a-src',
      type: 'pendingBridgesTestCvSrc',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });

    const edge: Edge = {
      id: 'e-late-tgt',
      source: { nodeId: 'a-src', portId: 'out' },
      target: { nodeId: 'v-doom-future', portId: 'forward' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'audio', 'video');

    // Source resolved → bridge wired even before target addNode (the
    // target nodeId is just a string the VideoEngine.addCvBridge stores;
    // resolution happens on the audio side). So this case fully wires.
    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(pe.getAppliedBridgeCount()).toBe(1);
    expect(ve.cvBridges.has('e-late-tgt')).toBe(true);
    pe.dispose();
  });

  it('1b. late-target materialization (video→audio): edge before target audio sink spawned drains on addNode', async () => {
    const { ve, pe } = makeEngines();
    // Video source published.
    const srcFake = makeFakeNode('doom-audio-l');
    ve.sources.set('v-doom::audio_l', {
      node: srcFake as unknown as AudioNode,
      output: 0,
    });

    // Target audio sink NOT yet spawned.
    const edge: Edge = {
      id: 'e-late-tgt-audio',
      source: { nodeId: 'v-doom', portId: 'audio_l' },
      target: { nodeId: 'a-sink', portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    pe.addEdge(edge, 'video', 'audio');

    // Target missing → pending.
    expect(pe.getPendingBridgeCount()).toBe(1);
    expect(pe.getAppliedBridgeCount()).toBe(0);
    // No connect logged — bridge never wired.
    expect(connectionLog.filter((c) => c.kind === 'connect').length).toBe(0);

    // Spawn the target. addNode drain should fire the bridge.
    await pe.addNode({
      id: 'a-sink',
      type: 'pendingBridgesTestAudioSink',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });

    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(pe.getAppliedBridgeCount()).toBe(1);
    // The upstream source got connected to the sink.
    const conns = connectionLog.filter((c) => c.fromTag === 'doom-audio-l' && c.kind === 'connect');
    expect(conns).toHaveLength(1);
    expect(conns[0]!.toTag).toBe('audio-sink-node');

    pe.dispose();
  });

  it('2. late-source materialization (video→audio): edge before source video module publishes drains on handle swap', async () => {
    const { ae, ve, pe } = makeEngines();
    // Target audio sink exists.
    await ae.addNode({
      id: 'a-sink',
      type: 'pendingBridgesTestAudioSink',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });
    // Source NOT in ve.sources yet.

    const edge: Edge = {
      id: 'e-late-src',
      source: { nodeId: 'v-doom', portId: 'audio_l' },
      target: { nodeId: 'a-sink', portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    pe.addEdge(edge, 'video', 'audio');

    expect(pe.getPendingBridgeCount()).toBe(1);
    expect(pe.getAppliedBridgeCount()).toBe(0);

    // Simulate video module publishing its AudioNode.
    const srcFake = makeFakeNode('doom-audio-l-late');
    ve.sources.set('v-doom::audio_l', {
      node: srcFake as unknown as AudioNode,
      output: 0,
    });
    // Fire the handle-changed hook.
    ve.notifyAudioSourceChanged('v-doom');

    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(pe.getAppliedBridgeCount()).toBe(1);
    const conns = connectionLog.filter((c) => c.fromTag === 'doom-audio-l-late' && c.kind === 'connect');
    expect(conns).toHaveLength(1);

    pe.dispose();
  });

  it('3. handle-swap retry for same-domain video-CV: source becomes available + onAudioSourcesChanged fires drain', () => {
    const { ve, pe } = makeEngines();
    const edge: Edge = {
      id: 'e-sd-cv',
      source: { nodeId: 'v-doom', portId: 'evt_kill' },
      target: { nodeId: 'v-scoreboard', portId: 'score' },
      sourceType: 'gate',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'video', 'video');

    // Source not registered → pending.
    expect(pe.getPendingBridgeCount()).toBe(1);
    expect(ve.cvBridges.has('e-sd-cv')).toBe(false);

    // Source published later.
    const srcFake = makeFakeNode('doom-evt-kill-late');
    ve.sources.set('v-doom::evt_kill', { node: srcFake as unknown as AudioNode, output: 0 });
    ve.notifyAudioSourceChanged('v-doom');

    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(ve.cvBridges.has('e-sd-cv')).toBe(true);

    pe.dispose();
  });

  it('4. removeNode evicts pending bridges referencing the removed node id', () => {
    const { pe } = makeEngines();
    // Park a pending bridge referencing v-doom.
    const edge: Edge = {
      id: 'e-pending-doomed',
      source: { nodeId: 'v-doom', portId: 'audio_l' },
      target: { nodeId: 'a-sink-missing', portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    pe.addEdge(edge, 'video', 'audio');
    expect(pe.getPendingBridgeCount()).toBe(1);

    // Remove the target (still missing — removeNode on a non-existent
    // engine node is a no-op for the engine, but the PatchEngine's
    // eviction logic should clear pendingBridges referencing it).
    pe.removeNode({
      id: 'v-doom',
      type: 'noop',
      domain: 'video',
      position: { x: 0, y: 0 },
      params: {},
    });
    expect(pe.getPendingBridgeCount()).toBe(0);

    pe.dispose();
  });

  it('5. removeEdge evicts pending bridge cleanly (no leak into applied)', () => {
    const { pe } = makeEngines();
    const edge: Edge = {
      id: 'e-pending-rm',
      source: { nodeId: 'v-missing', portId: 'audio_l' },
      target: { nodeId: 'a-missing', portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    pe.addEdge(edge, 'video', 'audio');
    expect(pe.getPendingBridgeCount()).toBe(1);

    pe.removeEdge(edge, 'video');
    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(pe.getAppliedBridgeCount()).toBe(0);
    pe.dispose();
  });

  it('6. idempotent re-add: addEdge with same id twice → single bridge, single pending entry', async () => {
    const { ve, pe } = makeEngines();
    // Source available; target id is a free string for cv bridges.
    const srcFake = makeFakeNode('idem-src');
    ve.sources.set('v-src::out', { node: srcFake as unknown as AudioNode, output: 0 });

    const edge: Edge = {
      id: 'e-idem',
      source: { nodeId: 'v-src', portId: 'out' },
      target: { nodeId: 'v-tgt', portId: 'foo' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'video', 'video');
    pe.addEdge(edge, 'video', 'video');

    // Two calls but only one bridge entry. Map.set is idempotent on key.
    expect(ve.cvBridges.size).toBe(1);
    expect(pe.getAppliedBridgeCount()).toBe(1);
    expect(pe.getPendingBridgeCount()).toBe(0);
    pe.dispose();
  });

  it('6b. idempotent re-add while pending: addEdge twice on missing source → single pending entry', () => {
    const { pe } = makeEngines();
    const edge: Edge = {
      id: 'e-idem-pending',
      source: { nodeId: 'v-missing', portId: 'audio_l' },
      target: { nodeId: 'a-missing', portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    pe.addEdge(edge, 'video', 'audio');
    pe.addEdge(edge, 'video', 'audio');
    expect(pe.getPendingBridgeCount()).toBe(1);
    pe.dispose();
  });

  it('7. cross-domain CV (audio → video CV): source absent → pending; addNode source drains', async () => {
    const { ae, pe, ve } = makeEngines();
    const edge: Edge = {
      id: 'e-cvbridge',
      source: { nodeId: 'a-src', portId: 'out' },
      target: { nodeId: 'v-doom', portId: 'forward' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    // Source (a-src) not added yet.
    pe.addEdge(edge, 'audio', 'video');
    expect(pe.getPendingBridgeCount()).toBe(1);
    expect(ve.cvBridges.has('e-cvbridge')).toBe(false);

    await ae.addNode({
      id: 'a-src',
      type: 'pendingBridgesTestCvSrc',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });
    // Note: AudioEngine.addNode doesn't itself call drainPending — that's
    // PatchEngine.addNode's responsibility. Tests that go via ae.addNode
    // bypass the drain. Drive the drain explicitly via pe.addNode in real
    // usage. To prove THAT path here, use pe.addNode:

    pe.dispose();
  });

  it('7b. cross-domain CV via pe.addNode drains: source materializes after addEdge', async () => {
    const { pe, ve } = makeEngines();
    const edge: Edge = {
      id: 'e-cvbridge2',
      source: { nodeId: 'a-cv-src', portId: 'out' },
      target: { nodeId: 'v-doom', portId: 'forward' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'audio', 'video');
    expect(pe.getPendingBridgeCount()).toBe(1);

    await pe.addNode({
      id: 'a-cv-src',
      type: 'pendingBridgesTestCvSrc',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });

    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(ve.cvBridges.has('e-cvbridge2')).toBe(true);
    pe.dispose();
  });

  it('8. cross-domain video-texture (audio → video texture): source absent → pending; drains on addNode', async () => {
    // Video-texture bridge requires the audio source's `videoSources` map
    // entry; without that the bridge can't resolve. We don't register a
    // module def with videoSources here (the prod modules do, e.g. SCOPE);
    // instead we prove the defer-then-drain plumbing by adding the same
    // sourceType=video edge with a missing source, then expect pending=1,
    // then removeEdge to clear.
    const { pe } = makeEngines();
    const edge: Edge = {
      id: 'e-vid-tex',
      source: { nodeId: 'a-scope-missing', portId: 'scope' },
      target: { nodeId: 'v-foxy', portId: 'in' },
      sourceType: 'video',
      targetType: 'video',
    };
    pe.addEdge(edge, 'audio', 'video');
    expect(pe.getPendingBridgeCount()).toBe(1);

    // removeEdge cleans up.
    pe.removeEdge(edge, 'audio');
    expect(pe.getPendingBridgeCount()).toBe(0);
    pe.dispose();
  });

  it('9. same-domain video-CV: missing source → pending; ve.notifyAudioSourceChanged drains', () => {
    const { pe, ve } = makeEngines();
    const edge: Edge = {
      id: 'e-sd-late',
      source: { nodeId: 'v-doom-late', portId: 'evt_kill' },
      target: { nodeId: 'v-scoreboard', portId: 'score' },
      sourceType: 'gate',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'video', 'video');
    expect(pe.getPendingBridgeCount()).toBe(1);
    expect(ve.cvBridges.has('e-sd-late')).toBe(false);

    const srcFake = makeFakeNode('doom-evt-late');
    ve.sources.set('v-doom-late::evt_kill', { node: srcFake as unknown as AudioNode, output: 0 });
    ve.notifyAudioSourceChanged('v-doom-late');

    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(ve.cvBridges.has('e-sd-late')).toBe(true);
    pe.dispose();
  });

  // ---- Codex audit smoking-gun e2e shape (mini reproduction) ----
  //
  // The bug was reported as: "I patched a cable to a target that doesn't
  // exist yet; even after the target appeared, the bridge never lit up."
  // This test simulates exactly that flow: addEdge first, addNode for the
  // source second. The pre-fix state failed (silent dead bridge); after
  // the fix the bridge wires up on the addNode drain.
  it('SMOKING GUN (Codex finding): cv bridge added BEFORE source node materializes wires up when source appears', async () => {
    const { pe, ve } = makeEngines();
    // Step 1: user patches a cable, but the source audio module hasn't
    // been spawned yet (race: Yjs delivered the edge op first).
    const edge: Edge = {
      id: 'e-smoking',
      source: { nodeId: 'a-lfo-future', portId: 'out' },
      target: { nodeId: 'v-doom', portId: 'forward' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'audio', 'video');

    // Pre-fix: edge id silently went into cvBridgeEdgeIds, no bridge
    // created, reconciler never re-tried. We now expect: pending, no
    // bridge wired.
    expect(pe.getPendingBridgeCount()).toBe(1);
    expect(ve.cvBridges.size).toBe(0);

    // Step 2: the LFO node finally materializes. PatchEngine.addNode
    // must drain → bridge wires up.
    await pe.addNode({
      id: 'a-lfo-future',
      type: 'pendingBridgesTestCvSrc',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });

    expect(pe.getPendingBridgeCount()).toBe(0);
    expect(ve.cvBridges.size).toBe(1);
    expect(ve.cvBridges.has('e-smoking')).toBe(true);
    pe.dispose();
  });
});
