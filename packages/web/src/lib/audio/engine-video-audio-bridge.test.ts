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

  it('wires video→audio sourceType=cv edges into an AudioParam (NIBBLES.length_cv → QBRT.cutoff_cv)', async () => {
    // Regression: NIBBLES.length_cv (sourceType=cv, sourceDomain=video)
    // patched to QBRT.cutoff_cv (sourceType=cv, sourceDomain=audio) used
    // to fall into addCrossDomainCvBridge, which looks up the source on
    // the AUDIO engine (it's not there — the source is the video
    // module's ConstantSourceNode) and silently deferred forever. The
    // slider never moved. Fix: cv/gate edges sourced from video and
    // targeting audio go through addCrossDomainAudioBridge, which reads
    // VideoEngine.getAudioSource and .connect()s into the downstream
    // AudioParam exposed by getInputNode.
    const ctx = makeFakeAudioContext();
    const ae = new AudioEngine(ctx);
    const ve = new VideoEngineStub();
    const pe = new PatchEngine();
    pe.registerDomain(ae);
    pe.registerDomain(ve);

    // Register a CV-input sink so the audio engine knows about a port
    // whose input handle exposes `param` (mirrors resofilter's cutoff_cv).
    const CV_SINK_DEF: AudioModuleDef = {
      type: 'videoAudioBridgeTestCvSink',
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
    registerModule(CV_SINK_DEF);

    const constFake = makeFakeNode('nibbles-length-cv');
    ve.sources.set('v-nibbles::length_cv', {
      node: constFake as unknown as AudioNode,
      output: 0,
    });

    const sinkNode: ModuleNode = {
      id: 'a-qbrt',
      type: 'videoAudioBridgeTestCvSink',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    };
    await ae.addNode(sinkNode);

    const edge: Edge = {
      id: 'e-cv-bridge',
      source: { nodeId: 'v-nibbles', portId: 'length_cv' },
      target: { nodeId: 'a-qbrt',    portId: 'cutoff_cv' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'video', 'audio');

    // The bridge should have connected NIBBLES's ConstantSource directly
    // into QBRT's `cutoff` AudioParam (NOT the worklet input). The fake
    // node's connect() records the destination as "audioparam:<paramTag>"
    // when given an AudioParam.
    const myConns = connectionLog.filter((c) =>
      c.fromTag === 'nibbles-length-cv' && c.kind === 'connect',
    );
    expect(myConns).toEqual([
      {
        fromTag: 'nibbles-length-cv',
        toTag: 'audioparam:cv-sink.cutoff',
        output: 0,
        input: undefined,
        kind: 'connect',
      },
    ]);

    pe.removeEdge(edge, 'video');
    const myDisc = connectionLog.filter((c) =>
      c.fromTag === 'nibbles-length-cv' && c.kind === 'disconnect',
    );
    expect(myDisc.length).toBe(1);
    expect(myDisc[0]!.toTag).toBe('audioparam:cv-sink.cutoff');

    pe.dispose();
  });

  // ── SAME-DOMAIN audio video-frame edge (WAVESCULPT video_out → wall self-loop) ──
  it('no-ops a same-domain audio video-frame edge (WAVESCULPT video_out → its own wall) without throwing', async () => {
    // Regression for the WAVESCULPT video-walls self-feedback path. An
    // audio-domain module can expose a mono-video OUTPUT and consume a
    // video INPUT card-side (the card reads the source's videoSources frame
    // directly). A cable between two audio modules carrying a video frame is
    // NOT an audio-graph edge — the audio engine has no AudioNode for a
    // video port and would throw "no source/target port". PatchEngine.addEdge
    // must recognise the video cable type + no-op so self-patching
    // (video_out → own wall) is ALLOWED, producing recursive video feedback.
    const WALL_SELF_DEF: AudioModuleDef = {
      type: 'videoWallSelfTestModule',
      domain: 'audio',
      label: 'WallSelf',
      category: 'sources',
      // A video INPUT + a mono-video OUTPUT — neither is wired on the audio
      // graph. The engine must skip the edge BEFORE looking up audio ports.
      inputs: [{ id: 'wall1', type: 'video' }],
      outputs: [{ id: 'video_out', type: 'mono-video' }],
      params: [],
      async factory(_ctx, _node) {
        return {
          domain: 'audio' as const,
          inputs: new Map(),
          outputs: new Map(),
          setParam(_id, _v) { /* */ },
          readParam(_id) { return undefined; },
          dispose() { /* */ },
        };
      },
    };
    registerModule(WALL_SELF_DEF);

    const ctx = makeFakeAudioContext();
    const ae = new AudioEngine(ctx);
    const pe = new PatchEngine();
    pe.registerDomain(ae);

    const node: ModuleNode = {
      id: 'ws', type: 'videoWallSelfTestModule', domain: 'audio',
      position: { x: 0, y: 0 }, params: {},
    };
    await ae.addNode(node);

    // The self-loop: video_out → its own wall1. mono-video upcasts to video.
    const edge: Edge = {
      id: 'e_self',
      source: { nodeId: 'ws', portId: 'video_out' },
      target: { nodeId: 'ws', portId: 'wall1' },
      sourceType: 'mono-video',
      targetType: 'video',
    };
    // MUST NOT throw (pre-fix: AudioEngine.addEdge threw "no source port
    // video_out on ws" because video_out isn't in the audio outputs map).
    expect(() => pe.addEdge(edge, 'audio', 'audio')).not.toThrow();
    // No audio connections were issued for a video-frame edge.
    expect(connectionLog.filter((c) => c.kind === 'connect')).toEqual([]);
    // removeEdge is symmetric + also doesn't throw.
    expect(() => pe.removeEdge(edge, 'audio')).not.toThrow();

    pe.dispose();
  });
});

// =========================================================================
// Class-wide regression sweep: EVERY video module's cv/gate output port
// =========================================================================
//
// PR #414 surfaced a bug class: ANY video module's CV/gate output was
// silently dropped before reaching an audio-domain target. Adding a single
// "NIBBLES.length_cv → QBRT.cutoff_cv" smoke isn't enough — DOOM's six gate
// outputs, and any FUTURE video module's CV/gate output, must survive the
// same dispatcher path.
//
// This sweep is generated from the actual video module registry: it imports
// every entry, filters to `cv` + `gate` outputs, and asserts that
// PatchEngine.addEdge takes the video→audio audio-bridge branch for that
// (port, type) pair — i.e. it CONNECTS the published AudioNode to the
// downstream AudioParam, and DISCONNECTS on removeEdge.
//
// What this catches that a hand-rolled per-pair test does not: someone adds
// a new video module with a `gate` output and forgets to publish it in
// `audioSources`, OR re-introduces a dispatcher mis-classification that
// drops cv but keeps gate (or vice versa). Either way this sweep fails
// loudly with a per-port `it.each` row.

import { listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import: registers every video module def with the registry so
// listVideoModuleDefs() returns more than just `[]` at sweep time. Mirrors
// what Canvas does at app boot — without it the sweep is silently vacuous.
import '$lib/video/modules';

interface VideoCvGatePort {
  moduleType: string;
  portId: string;
  portType: 'cv' | 'gate';
}

function enumerateVideoCvGateOutputs(): VideoCvGatePort[] {
  const out: VideoCvGatePort[] = [];
  for (const def of listVideoModuleDefs()) {
    for (const port of def.outputs) {
      // PortDef.type is CableType = StandardCableType | (string & {})
      // — the `string & {}` brand defeats string-literal narrowing, so cast
      // after the runtime guard.
      if (port.type === 'cv' || port.type === 'gate') {
        out.push({
          moduleType: def.type,
          portId: port.id,
          portType: port.type as 'cv' | 'gate',
        });
      }
    }
  }
  return out;
}

describe('PatchEngine — class-wide video.cv/gate → audio bridge sweep', () => {
  const ports = enumerateVideoCvGateOutputs();

  it('the registry enumeration found at least the known NIBBLES + DOOM ports', () => {
    // Lock the floor — if NIBBLES.length_cv or DOOM.evt_kill drop off the
    // registry the sweep would silently emit zero cases. This guard fails
    // loudly if the floor erodes.
    const ids = new Set(ports.map((p) => `${p.moduleType}.${p.portId}`));
    expect(ids.has('nibbles.length_cv')).toBe(true);
    expect(ids.has('nibbles.pellet')).toBe(true);
    expect(ids.has('doom.evt_kill')).toBe(true);
    expect(ids.has('doom.evt_door')).toBe(true);
    expect(ids.has('doom.evt_gun_p1')).toBe(true);
    // feat/doom-per-type-death-gates floor: per-monster + per-player
    // gates must enumerate. A few samples for the floor-guard — the full
    // per-port .each row sweep below covers every gate individually.
    expect(ids.has('doom.evt_kill_imp')).toBe(true);
    expect(ids.has('doom.evt_kill_demon')).toBe(true);
    expect(ids.has('doom.evt_kill_caco')).toBe(true);
    expect(ids.has('doom.evt_kill_baron')).toBe(true);
    expect(ids.has('doom.evt_p1_dies')).toBe(true);
    expect(ids.has('doom.evt_p4_dies')).toBe(true);
  });

  // Per-port sweep. Each row builds the smallest possible fixture: the
  // VideoEngineStub publishes one AudioNode at (videoNodeId::portId), the
  // engine bridges into a CV-shaped AudioParam sink, and we assert connect/
  // disconnect bookends the edge. The CV-input sink's `param` handle works
  // for BOTH cv and gate sourceTypes — the bridge accepts either.
  it.each(ports)(
    'video($moduleType).$portId ($portType) → audio.cv survives the dispatcher (connect on addEdge, disconnect on removeEdge)',
    async ({ moduleType, portId, portType }) => {
      // Each row registers its own unique sink type to keep module-registry
      // idempotency happy across the .each rows.
      const sinkType = `videoAudioBridgeSweep_${moduleType}_${portId}_sink`;
      const SINK_DEF: AudioModuleDef = {
        type: sinkType,
        domain: 'audio',
        label: 'SweepSink',
        category: 'output',
        inputs: [{ id: 'cv_in', type: 'cv' }],
        outputs: [],
        params: [],
        async factory(_ctx, _node) {
          const sinkNode = makeFakeNode(`${sinkType}-node`);
          const inParam = makeFakeParam(`${sinkType}.in`, 0);
          return {
            domain: 'audio' as const,
            inputs: new Map([
              ['cv_in', {
                node: sinkNode as unknown as AudioNode,
                input: 0,
                param: inParam as unknown as AudioParam,
              }],
            ]),
            outputs: new Map(),
            setParam(_id, _v) { /* */ },
            readParam(_id) { return undefined; },
            dispose() { /* */ },
          };
        },
      };
      registerModule(SINK_DEF);

      const ctx = makeFakeAudioContext();
      const ae = new AudioEngine(ctx);
      const ve = new VideoEngineStub();
      const pe = new PatchEngine();
      pe.registerDomain(ae);
      pe.registerDomain(ve);

      const srcTag = `${moduleType}-${portId}-src`;
      const srcFake = makeFakeNode(srcTag);
      const videoNodeId = `v-${moduleType}`;
      ve.sources.set(`${videoNodeId}::${portId}`, {
        node: srcFake as unknown as AudioNode,
        output: 0,
      });

      const sinkNodeId = `a-sink-${moduleType}-${portId}`;
      await ae.addNode({
        id: sinkNodeId,
        type: sinkType,
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: {},
      });

      const edge: Edge = {
        id: `e-sweep-${moduleType}-${portId}`,
        source: { nodeId: videoNodeId, portId },
        target: { nodeId: sinkNodeId, portId: 'cv_in' },
        sourceType: portType,
        targetType: 'cv',
      };

      pe.addEdge(edge, 'video', 'audio');

      // Bridge must have .connect()ed the upstream source to the
      // downstream AudioParam. The fake's connect() records the AudioParam
      // destination as "audioparam:<paramTag>".
      const conns = connectionLog.filter((c) => c.fromTag === srcTag && c.kind === 'connect');
      expect(
        conns.length,
        `${moduleType}.${portId}: dispatcher should have invoked audio-bridge .connect()`,
      ).toBe(1);
      expect(conns[0]!.toTag).toBe(`audioparam:${sinkType}.in`);
      expect(conns[0]!.output).toBe(0);

      // removeEdge must disconnect symmetrically.
      pe.removeEdge(edge, 'video');
      const disc = connectionLog.filter((c) => c.fromTag === srcTag && c.kind === 'disconnect');
      expect(
        disc.length,
        `${moduleType}.${portId}: dispatcher should have invoked audio-bridge .disconnect()`,
      ).toBe(1);
      expect(disc[0]!.toTag).toBe(`audioparam:${sinkType}.in`);

      pe.dispose();
    },
  );
});

// =========================================================================
// Class-wide regression sweep: EVERY video module's AUDIO output port
// =========================================================================
//
// Sibling sweep to the cv/gate one above. PR #421's coverage stopped at
// cv+gate because the original #414 bug only manifested on those types,
// but `audio`-typed outputs (DOOM.audio_l / DOOM.audio_r, VIDEOBOX,
// VIDEOVARISPEED, etc.) ride the SAME `addCrossDomainAudioBridge` path
// and are equally vulnerable to a future dispatcher mis-classification.
//
// This sweep enumerates every video module's `audio` output, publishes a
// fake source AudioNode at (videoNodeId::portId), then asserts addEdge
// .connect()s it to the downstream audio sink's AudioNode input (not
// AudioParam — `audio` sources terminate on a node input). removeEdge
// must disconnect symmetrically.
//
// What this catches that the cv/gate sweep does not:
//   - a regression that re-mis-routes `audio` source-type edges (e.g.
//     scoping the bridge to cv|gate only) — DOOM's A-L/A-R would go
//     silent the moment the sweep regresses.
//   - a new video module with an `audio` output that forgets to publish
//     it in audioSources — the floor-guard fails the build.

interface VideoAudioPort {
  moduleType: string;
  portId: string;
}

function enumerateVideoAudioOutputs(): VideoAudioPort[] {
  const out: VideoAudioPort[] = [];
  for (const def of listVideoModuleDefs()) {
    for (const port of def.outputs) {
      if (port.type === 'audio') {
        out.push({ moduleType: def.type, portId: port.id });
      }
    }
  }
  return out;
}

describe('PatchEngine — class-wide video.audio → audio bridge sweep', () => {
  const ports = enumerateVideoAudioOutputs();

  it('the registry enumeration found at least DOOM.audio_l / DOOM.audio_r', () => {
    // Floor-guard: pin the DOOM stereo pair so the sweep can't silently go
    // vacuous if the registry import drops DOOM. The user-reported A-L/A-R
    // audio regression motivated this guard — pre-this-PR the cv/gate sweep
    // covered DOOM's event gates but NOT its primary audio outs.
    const ids = new Set(ports.map((p) => `${p.moduleType}.${p.portId}`));
    expect(ids.has('doom.audio_l')).toBe(true);
    expect(ids.has('doom.audio_r')).toBe(true);
  });

  it.each(ports)(
    'video($moduleType).$portId (audio) → audio.audio survives the dispatcher (connect on addEdge, disconnect on removeEdge)',
    async ({ moduleType, portId }) => {
      // Each row registers its own unique audio-input sink so the
      // module-registry stays idempotent across .each rows.
      const sinkType = `videoAudioBridgeAudioSweep_${moduleType}_${portId}_sink`;
      const SINK_DEF: AudioModuleDef = {
        type: sinkType,
        domain: 'audio',
        label: 'AudioSweepSink',
        category: 'output',
        inputs: [{ id: 'audio_in', type: 'audio' }],
        outputs: [],
        params: [],
        async factory(_ctx, _node) {
          const sinkNode = makeFakeNode(`${sinkType}-node`);
          return {
            domain: 'audio' as const,
            inputs: new Map([
              ['audio_in', {
                node: sinkNode as unknown as AudioNode,
                input: 0,
                // NO `param` here — `audio` sources route into the AudioNode
                // input, not an AudioParam (that's the cv/gate path above).
              }],
            ]),
            outputs: new Map(),
            setParam(_id, _v) { /* */ },
            readParam(_id) { return undefined; },
            dispose() { /* */ },
          };
        },
      };
      registerModule(SINK_DEF);

      const ctx = makeFakeAudioContext();
      const ae = new AudioEngine(ctx);
      const ve = new VideoEngineStub();
      const pe = new PatchEngine();
      pe.registerDomain(ae);
      pe.registerDomain(ve);

      const srcTag = `${moduleType}-${portId}-audsrc`;
      const srcFake = makeFakeNode(srcTag);
      const videoNodeId = `v-${moduleType}`;
      ve.sources.set(`${videoNodeId}::${portId}`, {
        node: srcFake as unknown as AudioNode,
        output: 0,
      });

      const sinkNodeId = `a-aud-sink-${moduleType}-${portId}`;
      await ae.addNode({
        id: sinkNodeId,
        type: sinkType,
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: {},
      });

      const edge: Edge = {
        id: `e-aud-sweep-${moduleType}-${portId}`,
        source: { nodeId: videoNodeId, portId },
        target: { nodeId: sinkNodeId, portId: 'audio_in' },
        sourceType: 'audio',
        targetType: 'audio',
      };

      pe.addEdge(edge, 'video', 'audio');

      // The bridge must have .connect()ed the upstream audio source into
      // the downstream sink's AudioNode input (NOT an AudioParam). The
      // fake's connect() records the AudioNode destination as the sink's
      // __tag, so we assert the tag matches.
      const conns = connectionLog.filter((c) => c.fromTag === srcTag && c.kind === 'connect');
      expect(
        conns.length,
        `${moduleType}.${portId}: dispatcher should have invoked audio-bridge .connect()`,
      ).toBe(1);
      expect(conns[0]!.toTag).toBe(`${sinkType}-node`);
      expect(conns[0]!.output).toBe(0);
      expect(conns[0]!.input).toBe(0);

      // removeEdge must disconnect symmetrically.
      pe.removeEdge(edge, 'video');
      const disc = connectionLog.filter((c) => c.fromTag === srcTag && c.kind === 'disconnect');
      expect(
        disc.length,
        `${moduleType}.${portId}: dispatcher should have invoked audio-bridge .disconnect()`,
      ).toBe(1);
      expect(disc[0]!.toTag).toBe(`${sinkType}-node`);

      pe.dispose();
    },
  );
});
