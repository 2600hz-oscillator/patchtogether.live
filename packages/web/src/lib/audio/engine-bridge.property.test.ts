// packages/web/src/lib/audio/engine-bridge.property.test.ts
//
// fast-check property suite for PatchEngine cross-domain bridge lifecycle.
// Pairs with engine-pending-bridges.test.ts (the targeted regression file)
// — the regression file pins specific bug shapes; this file pins the
// invariants that ANY lifecycle sequence must satisfy.
//
// The Codex audit found a class of silent-failure bugs around cross-domain
// bridges (mark-as-owned-on-defer → reconciler never retries). This file
// pins the invariants the fix introduces:
//
//   P1 (no bridge leaks): for any sequence of {addNode, removeNode,
//      addEdge, removeEdge} ops, after each step:
//      getPendingBridgeCount() + getAppliedBridgeCount() ===
//        (count of live cross-domain edges referencing video).
//
//   P2 (source-handle swap reconnects): after a video module swaps its
//      published AudioNode for a port, every bridge downstream of that
//      source is either applied OR pending (never dropped).
//
//   P3 (commutativity of node-then-edge vs edge-then-node): the final
//      bridge state is the same regardless of order.
//
//   P4 (idempotent re-add): the same edge added N times yields the same
//      bridge count as adding it once.
//
//   P5 (clean teardown): any sequence ending in removeEdge on every live
//      edge ends with pending=0 && applied=0.
//
// Each test uses a deterministic seed so a failing CI run is reproducible.

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule, getModuleDef } from './module-registry';
import type { Edge, ModuleNode } from '$lib/graph/types';

// ---- Recording-fake AudioContext (mirror engine-pending-bridges.test.ts) ----

function makeFakeNode(t: string): {
  __tag: string;
  connect: (dest: unknown, output?: number, input?: number) => void;
  disconnect: (...args: unknown[]) => void;
} {
  return {
    __tag: t,
    connect() { /* */ },
    disconnect() { /* */ },
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

// Audio source with a CV output — used as a cross-domain CV bridge source.
const PROP_AUDIO_CV_SRC: AudioModuleDef = {
  type: 'propTestAudioCvSrc',
  domain: 'audio',
  label: 'PropAudioCvSrc',
  category: 'sources',
  schemaVersion: 1,
  inputs: [],
  outputs: [{ id: 'out', type: 'cv' }],
  params: [],
  async factory(_ctx, node) {
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map([
        ['out', { node: makeFakeNode(`prop-cv-${node.id}`) as unknown as AudioNode, output: 0 }],
      ]),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

// Audio sink — receives video → audio bridge.
const PROP_AUDIO_SINK: AudioModuleDef = {
  type: 'propTestAudioSink',
  domain: 'audio',
  label: 'PropAudioSink',
  category: 'output',
  schemaVersion: 1,
  inputs: [{ id: 'in', type: 'audio' }],
  outputs: [],
  params: [],
  async factory(_ctx, node) {
    return {
      domain: 'audio' as const,
      inputs: new Map([
        ['in', { node: makeFakeNode(`prop-sink-${node.id}`) as unknown as AudioNode, input: 0 }],
      ]),
      outputs: new Map(),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  if (!getModuleDef('propTestAudioCvSrc')) registerModule(PROP_AUDIO_CV_SRC);
  if (!getModuleDef('propTestAudioSink')) registerModule(PROP_AUDIO_SINK);
  registered = true;
}

// ---- VideoEngine stub: per-property-run fresh instance ----

class VideoStub implements DomainEngine {
  domain = 'video' as const;
  sources = new Map<string, { node: AudioNode; output: number }>();
  cvBridges = new Set<string>();
  videoTextureBridges = new Set<string>();
  audioCtx: AudioContext | null = null;
  /** Mirror of nodes the VideoEngine "has" — addNode tracks here. */
  nodes = new Set<string>();
  private audioSourcesChangedCb: ((nodeId: string) => void) | null = null;

  setAudioContext(ctx: AudioContext | null): void { this.audioCtx = ctx; }
  onAudioSourcesChanged(cb: ((nodeId: string) => void) | null): void { this.audioSourcesChangedCb = cb; }
  notifyAudioSourceChanged(nodeId: string): void { this.audioSourcesChangedCb?.(nodeId); }

  getAudioSource(nodeId: string, portId: string): { node: AudioNode; output: number } | null {
    return this.sources.get(`${nodeId}::${portId}`) ?? null;
  }

  getNodeHandle(_nodeId: string): unknown { return null; }
  resolveTargetParamId(_nodeId: string, portId: string): string { return portId; }

  addCvBridge(edgeId: string, _a: AnalyserNode, _tnid: string, _tpid: string, _teardown: () => void): void {
    this.cvBridges.add(edgeId);
  }
  removeCvBridge(edgeId: string): void { this.cvBridges.delete(edgeId); }

  addVideoTextureBridge(edgeId: string, ..._rest: unknown[]): void { this.videoTextureBridges.add(edgeId); }
  removeVideoTextureBridge(edgeId: string): void { this.videoTextureBridges.delete(edgeId); }

  async addNode(n: ModuleNode): Promise<void> {
    this.nodes.add(n.id);
    // When a video module "addNode"s, it might publish audioSources at
    // that point. For the property tests we DON'T auto-publish — tests
    // explicitly call sources.set + notifyAudioSourceChanged to drive
    // the handle-surface drain.
  }
  removeNode(id: string): void {
    this.nodes.delete(id);
    // Clean up any sources keyed by this node.
    for (const k of [...this.sources.keys()]) {
      if (k.startsWith(`${id}::`)) this.sources.delete(k);
    }
  }
  addEdge(_e: Edge): void { /* video-side plain edges don't count for cross-domain invariants */ }
  removeEdge(_id: string): void { /* */ }
  setParam(_id: string, _p: string, _v: number): void { /* */ }
  readParam(): undefined { return undefined; }
  read(): unknown { return undefined; }
  dispose(): void { /* */ }
}

// ---- Test pool: 5 nodes, 5 edge templates ----
//
// Nodes: 2 audio CV sources, 2 video modules (with pre-registered
// audioSources for some ports), 1 audio sink.
//
// Edges: span all 4 cross-domain kinds + a same-domain control.

type NodeSpec =
  | { id: string; kind: 'audio-cv-src' }
  | { id: string; kind: 'audio-sink' }
  | { id: string; kind: 'video'; declaresAudioSource?: { portId: string } };

const NODE_POOL: NodeSpec[] = [
  { id: 'a-cv-1', kind: 'audio-cv-src' },
  { id: 'a-cv-2', kind: 'audio-cv-src' },
  { id: 'a-snk', kind: 'audio-sink' },
  { id: 'v-1', kind: 'video', declaresAudioSource: { portId: 'audio_l' } },
  { id: 'v-2', kind: 'video', declaresAudioSource: { portId: 'evt_kill' } },
];

interface EdgeTemplate {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: string;
  targetType: string;
  sourceDomain: string;
  targetDomain: string;
}

const EDGE_TEMPLATES: EdgeTemplate[] = [
  // 1: audio cv → video cv (addCrossDomainCvBridge)
  {
    id: 'e-cv-bridge-1',
    source: { nodeId: 'a-cv-1', portId: 'out' },
    target: { nodeId: 'v-1', portId: 'forward' },
    sourceType: 'cv',
    targetType: 'cv',
    sourceDomain: 'audio',
    targetDomain: 'video',
  },
  // 2: audio cv → video cv (different source)
  {
    id: 'e-cv-bridge-2',
    source: { nodeId: 'a-cv-2', portId: 'out' },
    target: { nodeId: 'v-2', portId: 'left' },
    sourceType: 'cv',
    targetType: 'cv',
    sourceDomain: 'audio',
    targetDomain: 'video',
  },
  // 3: video audio → audio audio (addCrossDomainAudioBridge)
  {
    id: 'e-aud-bridge-1',
    source: { nodeId: 'v-1', portId: 'audio_l' },
    target: { nodeId: 'a-snk', portId: 'in' },
    sourceType: 'audio',
    targetType: 'audio',
    sourceDomain: 'video',
    targetDomain: 'audio',
  },
  // 4: video gate → video cv (addSameDomainVideoCvBridge)
  {
    id: 'e-sd-bridge-1',
    source: { nodeId: 'v-2', portId: 'evt_kill' },
    target: { nodeId: 'v-1', portId: 'spawn' },
    sourceType: 'gate',
    targetType: 'cv',
    sourceDomain: 'video',
    targetDomain: 'video',
  },
  // 5: another video → audio audio (different source port)
  {
    id: 'e-aud-bridge-2',
    source: { nodeId: 'v-1', portId: 'audio_l' },
    target: { nodeId: 'a-snk', portId: 'in' },
    sourceType: 'audio',
    targetType: 'audio',
    sourceDomain: 'video',
    targetDomain: 'audio',
  },
];

// ---- Lifecycle harness ----
//
// Track parallel state mirroring the engine's notion of "live" so the
// invariant check can compare. We track:
//   - liveNodes (set of node ids that addNode'd but didn't removeNode)
//   - liveEdges (set of edge ids that addEdge'd but didn't removeEdge)
//
// "Live cross-domain edges" = edges currently in liveEdges that are
// cross-domain bridges (one of the 4 kinds). Same-domain non-bridge
// edges don't count toward the bridge invariant.

interface World {
  pe: PatchEngine;
  ve: VideoStub;
  liveNodes: Set<string>;
  liveEdges: Set<string>;
  /** Tracks whether a video source has been "published" via sources.set
   *  + notifyAudioSourceChanged. Used by addNode on video kinds to
   *  optionally publish its audioSource. */
  publishedSources: Set<string>; // "nodeId::portId"
}

async function makeWorld(): Promise<World> {
  ensureRegistered();
  const ctx = makeFakeAudioContext();
  const ae = new AudioEngine(ctx);
  const ve = new VideoStub();
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  pe.registerDomain(ve);
  return {
    pe,
    ve,
    liveNodes: new Set(),
    liveEdges: new Set(),
    publishedSources: new Set(),
  };
}

function specToModuleNode(spec: NodeSpec): ModuleNode {
  if (spec.kind === 'audio-cv-src') {
    return {
      id: spec.id,
      type: 'propTestAudioCvSrc',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    };
  }
  if (spec.kind === 'audio-sink') {
    return {
      id: spec.id,
      type: 'propTestAudioSink',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    };
  }
  // video — the VideoStub has no factory needs, just track the id
  return {
    id: spec.id,
    type: 'propTestVideoStub',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
  };
}

async function applyAddNode(world: World, spec: NodeSpec, publishSource: boolean): Promise<void> {
  const node = specToModuleNode(spec);
  await world.pe.addNode(node);
  world.liveNodes.add(spec.id);
  // For video specs that declare an audio-source port, optionally publish
  // it so cross-domain audio bridges sourced from this node can wire.
  // `publishSource=false` simulates the wireAudio-late case the bug
  // describes.
  if (spec.kind === 'video' && spec.declaresAudioSource && publishSource) {
    const key = `${spec.id}::${spec.declaresAudioSource.portId}`;
    world.ve.sources.set(key, {
      node: makeFakeNode(`pub-${spec.id}-${spec.declaresAudioSource.portId}`) as unknown as AudioNode,
      output: 0,
    });
    world.publishedSources.add(key);
    world.ve.notifyAudioSourceChanged(spec.id);
  }
}

function applyRemoveNode(world: World, spec: NodeSpec): void {
  const node = specToModuleNode(spec);
  world.pe.removeNode(node);
  world.liveNodes.delete(spec.id);
  // Drop any liveEdges referencing this node — the engine evicts pending,
  // and the harness must invalidate live tracking too. Note: the engine
  // does NOT auto-remove edges on removeNode (the reconciler does that);
  // for property tests we mirror the bookkeeping so the invariant math
  // stays consistent.
  for (const eid of [...world.liveEdges]) {
    const tpl = EDGE_TEMPLATES.find((e) => e.id === eid);
    if (!tpl) continue;
    if (tpl.source.nodeId === spec.id || tpl.target.nodeId === spec.id) {
      // Have to actively remove the edge too — the engine has dropped
      // pending entries for it (drainPending eviction), so leaving it
      // in liveEdges would skew the invariant. Real code: reconciler
      // sees both removed in the same pass and tears the edge first.
      world.pe.removeEdge(specToEdge(tpl), tpl.sourceDomain);
      world.liveEdges.delete(eid);
    }
  }
  // Drop published sources for this node.
  for (const k of [...world.publishedSources]) {
    if (k.startsWith(`${spec.id}::`)) world.publishedSources.delete(k);
  }
}

function specToEdge(tpl: EdgeTemplate): Edge {
  return {
    id: tpl.id,
    source: tpl.source,
    target: tpl.target,
    sourceType: tpl.sourceType,
    targetType: tpl.targetType,
  };
}

function applyAddEdge(world: World, tpl: EdgeTemplate): void {
  world.pe.addEdge(specToEdge(tpl), tpl.sourceDomain, tpl.targetDomain);
  world.liveEdges.add(tpl.id);
}

function applyRemoveEdge(world: World, tpl: EdgeTemplate): void {
  world.pe.removeEdge(specToEdge(tpl), tpl.sourceDomain);
  world.liveEdges.delete(tpl.id);
}

// Count of live edges that are cross-domain bridges (i.e. ALL EDGE_TEMPLATES
// here, since every template was chosen to be one of the 4 bridge kinds).
function liveBridgeEdgeCount(world: World): number {
  return world.liveEdges.size;
}

// ---- Operation type used by fast-check sequences ----

type Op =
  | { kind: 'addNode'; idx: number; publish: boolean }
  | { kind: 'removeNode'; idx: number }
  | { kind: 'addEdge'; idx: number }
  | { kind: 'removeEdge'; idx: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('addNode' as const),
    idx: fc.integer({ min: 0, max: NODE_POOL.length - 1 }),
    publish: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('removeNode' as const),
    idx: fc.integer({ min: 0, max: NODE_POOL.length - 1 }),
  }),
  fc.record({
    kind: fc.constant('addEdge' as const),
    idx: fc.integer({ min: 0, max: EDGE_TEMPLATES.length - 1 }),
  }),
  fc.record({
    kind: fc.constant('removeEdge' as const),
    idx: fc.integer({ min: 0, max: EDGE_TEMPLATES.length - 1 }),
  }),
);

async function applyOp(world: World, op: Op): Promise<void> {
  if (op.kind === 'addNode') {
    const spec = NODE_POOL[op.idx]!;
    if (!world.liveNodes.has(spec.id)) {
      await applyAddNode(world, spec, op.publish);
    }
  } else if (op.kind === 'removeNode') {
    const spec = NODE_POOL[op.idx]!;
    if (world.liveNodes.has(spec.id)) applyRemoveNode(world, spec);
  } else if (op.kind === 'addEdge') {
    const tpl = EDGE_TEMPLATES[op.idx]!;
    if (!world.liveEdges.has(tpl.id)) applyAddEdge(world, tpl);
  } else if (op.kind === 'removeEdge') {
    const tpl = EDGE_TEMPLATES[op.idx]!;
    if (world.liveEdges.has(tpl.id)) applyRemoveEdge(world, tpl);
  }
}

// ---- Properties ----

describe('PatchEngine cross-domain bridge properties (fast-check)', () => {
  beforeEach(() => {
    ensureRegistered();
  });

  it('P1 (no bridge leaks): for any op sequence, pending+applied === live cross-domain edges, after every step', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { maxLength: 30 }),
        async (ops) => {
          const world = await makeWorld();
          try {
            for (const op of ops) {
              await applyOp(world, op);
              const pending = world.pe.getPendingBridgeCount();
              const applied = world.pe.getAppliedBridgeCount();
              const live = liveBridgeEdgeCount(world);
              // Each live cross-domain edge is either applied or pending.
              // Sum must equal live count — no leak (extra), no drop (less).
              if (pending + applied !== live) {
                return false;
              }
            }
            return true;
          } finally {
            world.pe.dispose();
          }
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });

  it('P2 (source-handle swap reconnects downstream): bridges remain in {applied, pending} after notifyAudioSourceChanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { maxLength: 30 }),
        async (ops) => {
          const world = await makeWorld();
          try {
            for (const op of ops) {
              await applyOp(world, op);
            }
            // Now simulate a handle swap on every video node that's live.
            const videoLive = NODE_POOL.filter(
              (n) => n.kind === 'video' && world.liveNodes.has(n.id),
            );
            for (const v of videoLive) {
              if (v.kind !== 'video') continue;
              // Publish (or republish) its audio source if it declares one.
              if (v.declaresAudioSource) {
                const key = `${v.id}::${v.declaresAudioSource.portId}`;
                world.ve.sources.set(key, {
                  node: makeFakeNode(`swap-${v.id}`) as unknown as AudioNode,
                  output: 0,
                });
                world.ve.notifyAudioSourceChanged(v.id);
              } else {
                world.ve.notifyAudioSourceChanged(v.id);
              }
            }
            // After the swap dust settles, the invariant must still hold.
            const pending = world.pe.getPendingBridgeCount();
            const applied = world.pe.getAppliedBridgeCount();
            const live = liveBridgeEdgeCount(world);
            return pending + applied === live;
          } finally {
            world.pe.dispose();
          }
        },
      ),
      { numRuns: 50, seed: 43 },
    );
  });

  it('P3 (commutativity of node-then-edge vs edge-then-node): final state matches regardless of order', async () => {
    // For each cross-domain edge template, build both orders + compare
    // (applied + pending) sets. We pick the edges that pair both endpoint
    // node kinds we register (audio cv src / audio sink / video stub).
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: EDGE_TEMPLATES.length - 1 }),
        async (edgeIdx) => {
          const tpl = EDGE_TEMPLATES[edgeIdx]!;
          // Lookup specs for both endpoints in NODE_POOL — skip if either
          // isn't in the pool (none of our 5 templates reference unknown
          // nodes, but defensively).
          const srcSpec = NODE_POOL.find((n) => n.id === tpl.source.nodeId);
          const tgtSpec = NODE_POOL.find((n) => n.id === tpl.target.nodeId);
          if (!srcSpec || !tgtSpec) return true;

          // Order A: add nodes first, then edge.
          const wA = await makeWorld();
          try {
            await applyAddNode(wA, srcSpec, true);
            if (srcSpec.id !== tgtSpec.id) await applyAddNode(wA, tgtSpec, true);
            applyAddEdge(wA, tpl);
            const a = wA.pe.getAppliedBridgeCount();
            const ap = wA.pe.getPendingBridgeCount();

            // Order B: add edge first, then nodes.
            const wB = await makeWorld();
            try {
              applyAddEdge(wB, tpl);
              await applyAddNode(wB, srcSpec, true);
              if (srcSpec.id !== tgtSpec.id) await applyAddNode(wB, tgtSpec, true);
              const b = wB.pe.getAppliedBridgeCount();
              const bp = wB.pe.getPendingBridgeCount();

              // Both orders must end up with same applied+pending split.
              // Either both succeed (applied=1, pending=0) or both end
              // pending=1 (e.g. the video source didn't publish — but
              // we passed publish=true, so should always succeed for
              // these specs).
              return a === b && ap === bp;
            } finally {
              wB.pe.dispose();
            }
          } finally {
            wA.pe.dispose();
          }
        },
      ),
      { numRuns: 50, seed: 44 },
    );
  });

  it('P4 (idempotent re-add): same edge added N times → same bridge count as adding once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: EDGE_TEMPLATES.length - 1 }),
        fc.integer({ min: 1, max: 10 }),
        async (edgeIdx, repeatCount) => {
          const tpl = EDGE_TEMPLATES[edgeIdx]!;
          const world = await makeWorld();
          try {
            // Spawn both endpoints + publish source.
            const srcSpec = NODE_POOL.find((n) => n.id === tpl.source.nodeId);
            const tgtSpec = NODE_POOL.find((n) => n.id === tpl.target.nodeId);
            if (!srcSpec || !tgtSpec) return true;
            await applyAddNode(world, srcSpec, true);
            if (srcSpec.id !== tgtSpec.id) await applyAddNode(world, tgtSpec, true);

            // Add the edge N times — same id.
            for (let i = 0; i < repeatCount; i++) {
              world.pe.addEdge(specToEdge(tpl), tpl.sourceDomain, tpl.targetDomain);
            }
            const applied = world.pe.getAppliedBridgeCount();
            const pending = world.pe.getPendingBridgeCount();

            // Exactly one bridge regardless of repeat count.
            return applied + pending === 1;
          } finally {
            world.pe.dispose();
          }
        },
      ),
      { numRuns: 200, seed: 45 },
    );
  });

  it('P5 (clean teardown): any op sequence ending with removeEdge on every live edge yields pending=0 + applied=0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { maxLength: 30 }),
        async (ops) => {
          const world = await makeWorld();
          try {
            for (const op of ops) {
              await applyOp(world, op);
            }
            // Tear down every edge that's currently live (snapshot before
            // removal — applyRemoveEdge mutates liveEdges).
            for (const eid of [...world.liveEdges]) {
              const tpl = EDGE_TEMPLATES.find((e) => e.id === eid);
              if (tpl) applyRemoveEdge(world, tpl);
            }
            const pending = world.pe.getPendingBridgeCount();
            const applied = world.pe.getAppliedBridgeCount();
            return pending === 0 && applied === 0;
          } finally {
            world.pe.dispose();
          }
        },
      ),
      { numRuns: 200, seed: 46 },
    );
  });
});
