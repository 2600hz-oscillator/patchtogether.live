// packages/web/src/lib/audio/engine.ts
//
// Engine architecture per D18 — domain-pluggable. Phase 1 ships with one
// domain implementation: AudioEngine. The PatchEngine is the reconciler that
// dispatches PatchGraph mutations to per-domain engines.
//
// Day 6 scope: imperative API (addNode/removeNode/addEdge/removeEdge) so the
// caller can drive the engine directly. The auto-reactive flavor that watches
// the SyncedStore graph and reconciles automatically lands in Day 7.

import type { Edge, ModuleDef, ModuleNode, CvScaleHint, ParamDef } from '$lib/graph/types';
import { getModuleDef, type AudioModuleDef } from './module-registry';
import { POLY_CHANNELS, resolveConnection } from './poly';
import { attachCvScale } from './cv-scale';

/**
 * What a per-domain factory hands back: the connectable surface for one module
 * instance. Inputs map declared port IDs to (AudioNode, inputIndex). Outputs
 * map declared port IDs to (AudioNode, outputIndex). Dispose tears it all down.
 */
export interface AudioDomainNodeHandle {
  domain: 'audio';
  inputs: Map<string, { node: AudioNode; input: number; param?: AudioParam }>;
  outputs: Map<string, { node: AudioNode; output: number }>;
  /** Apply a param value (fader change) to this node. Domain-specific routing. */
  setParam(paramId: string, value: number): void;
  /**
   * Read the LIVE current value of a param (D14 motorized fader convention).
   * Returns the AudioParam.value which includes any CV modulation from
   * connected nodes — so the fader UI can visually track LFOs, envelopes, etc.
   */
  readParam(paramId: string): number | undefined;
  /**
   * Optional: arbitrary per-module data read (e.g., scope's latest waveform
   * snapshot, meter peak values). Modules that need to expose internal state
   * to their UI implement this; others omit it.
   */
  read?(key: string): unknown;
  /**
   * Optional: per-port AnalyserNode taps that surface this module's
   * audio output as a video-domain source (cross-domain handoff).
   *
   * Modules that declare a port whose `type` is `mono-video` / `video`
   * (e.g. VIZVCO's `scope` port, SCOPE's `out` port) populate this map
   * with one entry per such port. The PatchEngine reads the analyser
   * via `getVideoSource(nodeId, portId)` when materializing an
   * audio→video edge; the VideoEngine then drives a waveform-video
   * renderer per frame, sampling from the analyser. Audio modules
   * with no video output omit this map entirely.
   *
   * Two flavors of video source:
   *
   *  - "simple analyser tap" (VIZVCO/WAVVIZ): a single AnalyserNode is
   *    handed to the bridge, which drives the shared GL waveform-video
   *    renderer. The audio module has no opinion on per-frame visual
   *    treatment — the renderer just shows the raw signal as a
   *    full-canvas, full-buffer trace.
   *
   *  - "module-driven 2D draw" (SCOPE): the module wants control over
   *    every pixel — XY mode, dual-channel, scale/offset/range,
   *    timeMs window, all the on-card scope knobs should affect the
   *    video output too. Such modules pass `drawFrame` AND set
   *    `drawFrameUsesCanvas2D: true`. The bridge owns an OffscreenCanvas,
   *    invokes `drawFrame(canvas)` each video frame, then uploads the
   *    canvas pixels to a GL texture for downstream video modules.
   *    `analyser` is still required (legacy: the bridge needs SOMETHING
   *    to satisfy `getVideoSource` callers); when `drawFrame` is set the
   *    bridge ignores the analyser and lets the module read whatever
   *    sources it needs internally.
   */
  videoSources?: Map<string, {
    analyser: AnalyserNode;
    sampleRate: number;
    /** When set, the bridge calls this each frame instead of running
     *  the GL waveform-video renderer. The module owns all pixel logic
     *  (scope mode, scale/offset, dual-channel layout, etc.). The
     *  canvas is sized to the engine's video resolution. */
    drawFrame?: (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
  }>;
  dispose(): void;
}

/** Future visual modules implement this same shape with different node types. */
export type DomainNodeHandle = AudioDomainNodeHandle;

/** A factory that materializes a module instance under a given runtime context. */
export type AudioModuleFactory = (
  ctx: AudioContext,
  node: ModuleNode
) => Promise<AudioDomainNodeHandle>;

/** Generic per-domain engine interface (D18). */
export interface DomainEngine {
  domain: string;
  addNode(node: ModuleNode): Promise<void>;
  removeNode(nodeId: string): void;
  addEdge(edge: Edge): void;
  removeEdge(edgeId: string): void;
  setParam(nodeId: string, paramId: string, value: number): void;
  readParam(nodeId: string, paramId: string): number | undefined;
  /** Optional: most-recent sample at a per-port modulator-tap analyser.
   *  Only AudioEngine implements this today. Card visualizers call
   *  PatchEngine.readModulatorTap(nodeId, portId) to read CV-side
   *  modulation when the input port id differs from the AudioParam id
   *  (e.g. WAVECEL: 'morph_cv' → param 'morph'). */
  readModulatorTap?(nodeId: string, portId: string): number | undefined;
  read(nodeId: string, key: string): unknown;
  dispose(): void;
}

// ---------------- AudioEngine (the only Phase 1 implementation) ----------------

export class AudioEngine implements DomainEngine {
  domain = 'audio' as const;
  ctx: AudioContext;
  nodes = new Map<string, AudioDomainNodeHandle>();
  /** edge id → undo function that disconnects the specific connection */
  edges = new Map<string, () => void>();
  /**
   * Per-node module-type cache. Populated in addNode. Used by addEdge to
   * look up the source/target module's PortDef (and thus its `cvScale`
   * hint) without rebuilding the patch graph from the snapshot. Without
   * this, addEdge would have to walk the snapshot bus to recover the
   * type — but the engine is supposed to be UI-agnostic.
   */
  private nodeTypes = new Map<string, string>();
  /**
   * Per-node knob value cache: latest value passed via addNode(node.params)
   * or setParam. Used by addEdge to bake the user's CURRENT knob position
   * into the cv-scale WaveShaper LUT (centring the modulation sweep on the
   * actual knob, not the static ParamDef.defaultValue).
   *
   * Why not read AudioParam.value directly? Chromium's AudioWorkletNode
   * AudioParam.value getter reflects the audio-thread-rendered value at the
   * last block boundary, which can lag the most-recent setValueAtTime call
   * (the audio thread has to process the schedule event before .value
   * sees it). For the test path "spawn node with params; immediately patch
   * cable", reading .value returns the param's static defaultValue rather
   * than the just-set runtime value — making the LUT bake on the wrong
   * centre. Caching the knob on the JS side sidesteps that race.
   *
   * Map key: `${nodeId}::${paramId}`.
   */
  private knobValues = new Map<string, number>();
  private knobKey(nodeId: string, paramId: string): string {
    return `${nodeId}::${paramId}`;
  }
  /**
   * Per-modulated-param AnalyserNode taps so the UI can visualize the CURRENT
   * computed value of an AudioParam (intrinsic + connected modulators).
   *
   * Why: AudioParam.value reflects only the *intrinsic* value last set by the
   * fader. When an LFO/envelope is connected via .connect(audioParam) the
   * audio-rate sum is computed in the audio thread but never surfaced back
   * to JS. Without a tap, motorized faders look frozen even while modulation
   * is clearly audible.
   *
   * One AnalyserNode per (nodeId, paramId). Multiple inbound edges to the
   * same param all .connect() to the same analyser; Web Audio's connection
   * summing means the analyser sees the cumulative modulator signal.
   */
  paramTaps = new Map<string, AnalyserNode>();
  /** edge id → bookkeeping so removeEdge can untap. */
  private paramTapEdges = new Map<string, { tapKey: string; src: AudioNode; output: number }>();
  private paramTapBuf = new Float32Array(32);

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  private paramTapKey(nodeId: string, paramId: string): string {
    return `${nodeId}::${paramId}`;
  }

  private getOrCreateParamTap(nodeId: string, paramId: string): AnalyserNode {
    const key = this.paramTapKey(nodeId, paramId);
    let tap = this.paramTaps.get(key);
    if (!tap) {
      tap = this.ctx.createAnalyser();
      tap.fftSize = 32;
      tap.smoothingTimeConstant = 0;
      this.paramTaps.set(key, tap);
    }
    return tap;
  }

  async addNode(node: ModuleNode): Promise<void> {
    if (this.nodes.has(node.id)) {
      // Idempotent: a second call for the same node id is a no-op. Protects
      // against reconcile races and double-spawn buttons.
      return;
    }
    const def = getModuleDef(node.type);
    if (!def) throw new Error(`AudioEngine.addNode: no def for ${String(node.type)}`);
    if (def.domain !== 'audio') {
      throw new Error(
        `AudioEngine.addNode: ${String(node.type)} has domain '${def.domain}', not 'audio'`
      );
    }
    // Third-layer singleton enforcement (defensive — outlives palette + spawn
    // guards in the multiplayer race where two clients spawn concurrently).
    // Tie-break: lexicographic-smaller-id wins. Loser's node id sorts later,
    // we drop it and the reconciler retries no-op next tick.
    const ad = def as AudioModuleDef;
    if (ad.maxInstances !== undefined) {
      const sameType: string[] = [];
      for (const [id, h] of this.nodes) {
        if (h.domain === 'audio') {
          // The engine doesn't track type directly; cross-reference by node id.
          // Naming convention from spawnFromPalette is `${type}-...` and saved
          // patches retain that, but we should look at the live patch instead
          // for correctness — but that creates a graph-store dep here. Use
          // the engine's node-id prefix heuristic, which matches the spawn
          // convention 100%; if a custom id is assigned, the palette + spawn
          // guards still cover it and this is a defensive last line.
          if (id.startsWith(`${node.type}-`)) sameType.push(id);
        }
      }
      if (sameType.length >= ad.maxInstances) {
        // Lex-tiebreak: if our id sorts LATER than every existing id, drop
        // ourselves. If we'd win (sort first), kick the existing latest one.
        const sortedExisting = [...sameType].sort();
        if (node.id >= sortedExisting[sortedExisting.length - 1]!) {
          // We're the loser. Skip add; the loser's UI sees no instance.
          return;
        }
        // We win: evict the lex-largest existing instance to make room.
        const evictId = sortedExisting[sortedExisting.length - 1]!;
        const evictHandle = this.nodes.get(evictId);
        if (evictHandle) {
          evictHandle.dispose();
          this.nodes.delete(evictId);
        }
      }
    }
    const handle = await (def.factory as AudioModuleFactory)(this.ctx, node);
    // Re-check after the await: another reconcile may have raced and added it.
    if (this.nodes.has(node.id)) {
      handle.dispose();
      return;
    }
    this.nodes.set(node.id, handle);
    this.nodeTypes.set(node.id, String(node.type));
    // Seed the knob cache with the patch-graph values + the def's defaults
    // for any unseeded params. addEdge will read these to bake the LUT.
    const moduleDef = def as AudioModuleDef;
    for (const paramDef of moduleDef.params) {
      const v = (node.params ?? {})[paramDef.id] ?? paramDef.defaultValue;
      this.knobValues.set(this.knobKey(node.id, paramDef.id), v);
    }
  }

  removeNode(nodeId: string): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    // Caller (PatchEngine / reconciler) is expected to call removeEdge for
    // every edge touching this node before removeNode. handle.dispose()
    // disconnects all of this node's Web Audio connections defensively.
    handle.dispose();
    this.nodes.delete(nodeId);
    this.nodeTypes.delete(nodeId);
    // Drop any cached knob values for this node so a re-spawn at the same
    // id starts fresh from its def defaults.
    const prefix = `${nodeId}::`;
    for (const key of this.knobValues.keys()) {
      if (key.startsWith(prefix)) this.knobValues.delete(key);
    }
  }

  /**
   * Look up the CV-scaling hint for a (target node, target port) pair.
   * Returns null if the destination port doesn't declare cvScale (legacy
   * behavior: passthrough sum-into-AudioParam) or if either lookup fails.
   *
   * Also returns the destination param's def so the scaler can read
   * min/max/defaultValue. The two come together because the scaling math
   * needs both pieces.
   */
  private getCvScaleForTarget(
    targetNodeId: string,
    targetPortId: string,
  ): { hint: CvScaleHint; paramDef: ParamDef } | null {
    const moduleType = this.nodeTypes.get(targetNodeId);
    if (!moduleType) return null;
    const def = getModuleDef(moduleType) as AudioModuleDef | undefined;
    if (!def) return null;
    const port = def.inputs.find((p) => p.id === targetPortId);
    if (!port || !port.cvScale || !port.paramTarget) return null;
    const paramDef = def.params.find((p) => p.id === port.paramTarget);
    if (!paramDef) return null;
    return { hint: port.cvScale, paramDef };
  }

  addEdge(edge: Edge): void {
    if (this.edges.has(edge.id)) return; // idempotent
    const src = this.nodes.get(edge.source.nodeId);
    const dst = this.nodes.get(edge.target.nodeId);
    if (!src) throw new Error(`AudioEngine.addEdge: no source node ${edge.source.nodeId}`);
    if (!dst) throw new Error(`AudioEngine.addEdge: no target node ${edge.target.nodeId}`);
    const sout = src.outputs.get(edge.source.portId);
    const din = dst.inputs.get(edge.target.portId);
    if (!sout) throw new Error(
      `AudioEngine.addEdge: no source port ${edge.source.portId} on ${edge.source.nodeId}`
    );
    if (!din) throw new Error(
      `AudioEngine.addEdge: no target port ${edge.target.portId} on ${edge.target.nodeId}`
    );

    // Stage-1 polyphony: when either side speaks `polyPitchGate` and the other
    // doesn't, we need an interposed splitter (poly→mono) or merger (mono→poly)
    // to pick the right channel(s). The pure planning function lives in poly.ts;
    // here we just apply its plan.
    const plan = resolveConnection(edge.sourceType, edge.targetType);
    if (plan.needSplitter || plan.needMerger) {
      const undo = this.applyPolyPlan(edge, sout, din, plan);
      this.edges.set(edge.id, undo);
      return;
    }

    if (din.param) {
      // CV → AudioParam routing.
      //
      // If the destination port declares a `cvScale` hint AND the cable
      // type is `cv` (not audio/pitch/gate which sometimes also land on
      // AudioParams via Web Audio's lenient typing), interpose a scaling
      // chain so a -1..+1 CV signal sweeps the param's full natural range.
      // See packages/web/src/lib/audio/cv-scale.ts and
      // .myrobots/plans/cv-range-standard.md.
      //
      // For passthrough / no-hint cases, the legacy direct-connect behavior
      // is preserved (Web Audio sums sout.node's signal into din.param at
      // audio rate without modification).
      const scaleInfo = edge.sourceType === 'cv' || edge.targetType === 'cv'
        ? this.getCvScaleForTarget(edge.target.nodeId, edge.target.portId)
        : null;
      let scaleTeardown: (() => void) | null = null;
      let connectSource: AudioNode = sout.node;
      let connectOutput: number = sout.output;
      if (scaleInfo && scaleInfo.hint.mode !== 'passthrough') {
        // Bake the LIVE knob value into the LUT, not the ParamDef.defaultValue.
        // The user may have moved the knob away from the default before patching
        // the cable; a curve baked at the def's default would centre the sweep
        // on the wrong position.
        //
        // We use our own JS-side `knobValues` cache (seeded in addNode and kept
        // in sync by setParam) rather than reading `din.param.value` directly.
        // For Faust AudioWorkletNode params, AudioParam.value reflects the
        // audio-thread-rendered value at the last block boundary, which lags
        // the most-recent setValueAtTime call until the audio thread processes
        // the schedule event. In the "spawn node with params; immediately
        // patch cable" path (e.g. cv-range-uniformity e2e), reading .value at
        // addEdge time returns the static defaultValue rather than the just-
        // set runtime value — making the LUT bake on the wrong centre. The
        // JS-side cache sidesteps that race. Hot-rebuild on subsequent knob
        // changes is left to a follow-up; cf. attachCvScale notes.
        const liveKnob = this.knobValues.get(
          this.knobKey(edge.target.nodeId, scaleInfo.paramDef.id),
        ) ?? scaleInfo.paramDef.defaultValue;
        const chain = attachCvScale(this.ctx, scaleInfo.paramDef, scaleInfo.hint, liveKnob);
        // source → scaler input; scaler output → param + tap.
        sout.node.connect(chain.input, sout.output);
        // The scaler is a single WaveShaperNode whose output we use for
        // both the param AND the tap analyser. Web Audio is happy to
        // connect one output to multiple destinations.
        connectSource = chain.output;
        connectOutput = 0;
        scaleTeardown = () => {
          try { sout.node.disconnect(chain.input, sout.output); } catch { /* */ }
          chain.teardown();
        };
      }
      connectSource.connect(din.param, connectOutput);
      // Also tee the (scaled or raw) source through a per-param AnalyserNode
      // so readParam can report intrinsic + modulator sample for motorized
      // fader rendering. The tap sees the SAME signal that's being summed
      // into the param — so the motorized fader visualizes actual modulation.
      const tap = this.getOrCreateParamTap(edge.target.nodeId, edge.target.portId);
      connectSource.connect(tap, connectOutput);
      const tapKey = this.paramTapKey(edge.target.nodeId, edge.target.portId);
      this.paramTapEdges.set(edge.id, { tapKey, src: connectSource, output: connectOutput });
      this.edges.set(edge.id, () => {
        try { connectSource.disconnect(din.param!, connectOutput); } catch { /* */ }
        const bk = this.paramTapEdges.get(edge.id);
        if (bk) {
          const t = this.paramTaps.get(bk.tapKey);
          if (t) {
            try { bk.src.disconnect(t, bk.output); } catch { /* may have been torn down */ }
          }
          this.paramTapEdges.delete(edge.id);
        }
        if (scaleTeardown) scaleTeardown();
      });
    } else {
      sout.node.connect(din.node, sout.output, din.input);
      this.edges.set(edge.id, () => sout.node.disconnect(din.node, sout.output, din.input));
    }
  }

  /** Apply a poly-cable connection plan: insert a splitter or merger between
   *  source and destination so the chosen channels route correctly. Returns
   *  the undo function the engine stores in `edges`. */
  private applyPolyPlan(
    edge: Edge,
    sout: { node: AudioNode; output: number },
    din: { node: AudioNode; input: number; param?: AudioParam },
    plan: ReturnType<typeof resolveConnection>,
  ): () => void {
    const ctx = this.ctx;
    const teardowns: Array<() => void> = [];

    if (plan.needSplitter) {
      // poly source → mono sink. Tee the source through a 10-channel splitter
      // and connect the requested channel(s) to the destination.
      const splitter = ctx.createChannelSplitter(POLY_CHANNELS);
      sout.node.connect(splitter, sout.output);
      teardowns.push(() => {
        try { sout.node.disconnect(splitter, sout.output); } catch { /* */ }
      });

      if (din.param) {
        for (const ch of plan.splitChannels) {
          splitter.connect(din.param, ch);
        }
        // Tap to per-param analyser so motorized faders still work.
        const tap = this.getOrCreateParamTap(edge.target.nodeId, edge.target.portId);
        for (const ch of plan.splitChannels) {
          splitter.connect(tap, ch);
        }
        const tapKey = this.paramTapKey(edge.target.nodeId, edge.target.portId);
        this.paramTapEdges.set(edge.id, { tapKey, src: splitter, output: plan.splitChannels[0] ?? 0 });
        teardowns.push(() => {
          try {
            for (const ch of plan.splitChannels) {
              splitter.disconnect(din.param!, ch);
            }
          } catch { /* */ }
          const bk = this.paramTapEdges.get(edge.id);
          if (bk) {
            const t = this.paramTaps.get(bk.tapKey);
            if (t) {
              try {
                for (const ch of plan.splitChannels) {
                  splitter.disconnect(t, ch);
                }
              } catch { /* */ }
            }
            this.paramTapEdges.delete(edge.id);
          }
        });
      } else if (plan.needGateSum && plan.splitChannels.length > 1) {
        // OR-of-gates: connect every gate channel to the same destination
        // input. Web Audio sums them — each gate is 0/1 so sum ∈ [0, 5];
        // downstream gate consumers threshold ≥ 0.5 ⇒ effectively OR.
        for (const ch of plan.splitChannels) {
          splitter.connect(din.node, ch, din.input);
        }
        teardowns.push(() => {
          for (const ch of plan.splitChannels) {
            try { splitter.disconnect(din.node, ch, din.input); } catch { /* */ }
          }
        });
      } else {
        // Single channel pull (lane 0 pitch / cv / audio).
        const ch = plan.splitChannels[0] ?? 0;
        splitter.connect(din.node, ch, din.input);
        teardowns.push(() => {
          try { splitter.disconnect(din.node, ch, din.input); } catch { /* */ }
        });
      }

      teardowns.push(() => { try { splitter.disconnect(); } catch { /* */ } });
    } else if (plan.needMerger) {
      // mono source → poly sink. Insert a 10-channel merger between source and
      // destination, driving only the requested input(s).
      const merger = ctx.createChannelMerger(POLY_CHANNELS);
      for (const inp of plan.mergeInputs) {
        sout.node.connect(merger, sout.output, inp);
      }
      teardowns.push(() => {
        for (const inp of plan.mergeInputs) {
          try { sout.node.disconnect(merger, sout.output, inp); } catch { /* */ }
        }
      });

      if (din.param) {
        // Highly unusual (poly input as AudioParam) — engine never declares one
        // today, but be defensive: connect merger to param at output 0.
        merger.connect(din.param, 0);
        teardowns.push(() => { try { merger.disconnect(din.param!, 0); } catch { /* */ } });
      } else {
        merger.connect(din.node, 0, din.input);
        teardowns.push(() => { try { merger.disconnect(din.node, 0, din.input); } catch { /* */ } });
      }

      teardowns.push(() => { try { merger.disconnect(); } catch { /* */ } });
    }

    // Run teardowns in reverse (LIFO) so we disconnect leaves before roots.
    return () => {
      for (let i = teardowns.length - 1; i >= 0; i--) {
        try { teardowns[i]!(); } catch { /* */ }
      }
    };
  }

  removeEdge(edgeId: string): void {
    const undo = this.edges.get(edgeId);
    if (undo) {
      undo();
      this.edges.delete(edgeId);
    }
  }

  setParam(nodeId: string, paramId: string, value: number): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    handle.setParam(paramId, value);
    // Keep the LUT-bake knob cache in sync so a future addEdge centres the
    // sweep on the user's CURRENT knob position. (LUT hot-rebuild for
    // already-attached cables is a follow-up; cf. attachCvScale notes.)
    this.knobValues.set(this.knobKey(nodeId, paramId), value);
  }

  /** Read the live AudioParam value for motorized fader rendering.
   *  Returns intrinsic + sample of any connected modulators (via the
   *  per-param AnalyserNode tap), so faders visually track LFOs/envelopes. */
  readParam(nodeId: string, paramId: string): number | undefined {
    const intrinsic = this.nodes.get(nodeId)?.readParam(paramId);
    if (intrinsic === undefined) return undefined;
    const tap = this.paramTaps.get(this.paramTapKey(nodeId, paramId));
    if (!tap) return intrinsic;
    // Read 32 most-recent samples from the analyser. Use the tail sample as
    // "current" — close enough at 60fps poll; fftSize=32 keeps perf cheap.
    tap.getFloatTimeDomainData(this.paramTapBuf);
    return intrinsic + this.paramTapBuf[this.paramTapBuf.length - 1];
  }

  /** Read the most-recent sample from a modulator tap by CV-input portId,
   *  not paramId. Used by PatchEngine.readParam to fold in modulator
   *  samples for modules whose CV port id differs from the AudioParam id
   *  (e.g. WAVECEL: port 'morph_cv' → param 'morph'). Returns undefined
   *  when no edge is connected to that port. */
  readModulatorTap(nodeId: string, portId: string): number | undefined {
    const tap = this.paramTaps.get(this.paramTapKey(nodeId, portId));
    if (!tap) return undefined;
    tap.getFloatTimeDomainData(this.paramTapBuf);
    return this.paramTapBuf[this.paramTapBuf.length - 1];
  }

  /** Read arbitrary per-module data (e.g., scope buffer). */
  read(nodeId: string, key: string): unknown {
    const handle = this.nodes.get(nodeId);
    return handle?.read ? handle.read(key) : undefined;
  }

  /**
   * Cross-domain bridge support: return the AudioNode + output index for a
   * given (nodeId, portId) so callers (the cross-domain CV bridge created by
   * PatchEngine for cv → video edges) can `.connect()` the source's output
   * into an AnalyserNode for frame-rate sample-and-hold readout.
   *
   * Returns null if the node isn't materialized (the reconciler usually
   * adds the node before the edge, but a race is possible). Callers must
   * handle null gracefully — the bridge can be re-attached on a later
   * reconcile pass.
   */
  getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null {
    const handle = this.nodes.get(nodeId);
    if (!handle) return null;
    const out = handle.outputs.get(portId);
    return out ?? null;
  }

  /**
   * Cross-domain bridge support (audio → video texture). Modules that
   * carry a `mono-video`/`video` output port populate
   * AudioDomainNodeHandle.videoSources with an analyser-tap per such
   * port; this method exposes that to the PatchEngine. Returns null if
   * the node isn't materialized OR doesn't declare a video source for
   * the given port — the caller defers to a later reconcile pass.
   */
  getVideoSource(
    nodeId: string,
    portId: string,
  ): {
    analyser: AnalyserNode;
    sampleRate: number;
    drawFrame?: (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
  } | null {
    const handle = this.nodes.get(nodeId);
    if (!handle) return null;
    const src = handle.videoSources?.get(portId);
    return src ?? null;
  }

  dispose(): void {
    for (const undo of this.edges.values()) undo();
    this.edges.clear();
    for (const tap of this.paramTaps.values()) {
      try { tap.disconnect(); } catch { /* may have been torn down */ }
    }
    this.paramTaps.clear();
    this.paramTapEdges.clear();
    for (const handle of this.nodes.values()) handle.dispose();
    this.nodes.clear();
    this.nodeTypes.clear();
    this.knobValues.clear();
  }
}

// ---------------- PatchEngine: dispatcher across domains ----------------

export class PatchEngine {
  private domains = new Map<string, DomainEngine>();
  /** Track edges that became cross-domain CV bridges so removeEdge can
   *  tear them down. The set is keyed by edge id. Edge ids in this set
   *  are NOT routed to either domain engine on addEdge — they're owned
   *  exclusively by the bridge. */
  private cvBridgeEdgeIds = new Set<string>();
  /** Edges that became cross-domain audio → video texture bridges.
   *  Bookkept like cvBridgeEdgeIds so removeEdge can route to the
   *  video engine's removeVideoTextureBridge. */
  private videoTextureBridgeEdgeIds = new Set<string>();

  registerDomain(engine: DomainEngine): void {
    this.domains.set(engine.domain, engine);
  }

  getDomain<T extends DomainEngine>(domain: string): T {
    const e = this.domains.get(domain);
    if (!e) throw new Error(`PatchEngine: no engine registered for domain '${domain}'`);
    return e as T;
  }

  /** Existence check — does NOT throw. Used by addEdge to decide if a
   *  cross-domain bridge is even possible (i.e. both engines exist). */
  hasDomain(domain: string): boolean {
    return this.domains.has(domain);
  }

  async addNode(node: ModuleNode): Promise<void> {
    const engine = this.getDomain(node.domain);
    await engine.addNode(node);
  }

  removeNode(node: ModuleNode): void {
    const engine = this.getDomain(node.domain);
    engine.removeNode(node.id);
  }

  /**
   * Add an edge. Dispatch by source node's domain.
   *
   * Cross-domain bridges: when `targetDomain` differs from `sourceDomain`
   * and the source carries cv (the only audio→video signal allowed), we
   * set up a frame-rate sample-and-hold bridge: the audio source's
   * output is teed through an AnalyserNode owned by the video engine,
   * which reads one sample per video frame and writes it into the
   * target module's param. The bridge is owned exclusively by the
   * cross-domain layer — neither domain engine sees the edge in its
   * own `edges` map.
   *
   * Detection rule: cross-domain (sourceDomain != targetDomain) AND
   * sourceType is 'cv'. The targetType being 'cv' is the canonical case
   * (video modules declare CV-modulatable params as type='cv' inputs);
   * we also accept video cable targets in case someone routes audio CV
   * directly to a video stream port (the type system permits it via
   * canConnect).
   *
   * If `targetDomain` is omitted (legacy callers), we fall back to
   * single-domain dispatch — preserves Phase-0 semantics for tests that
   * don't pass a target domain.
   */
  addEdge(edge: Edge, sourceDomain: string, targetDomain?: string): void {
    if (
      targetDomain !== undefined
      && sourceDomain !== targetDomain
      && edge.sourceType === 'cv'
    ) {
      this.addCrossDomainCvBridge(edge, sourceDomain, targetDomain);
      return;
    }
    // Cross-domain audio → video texture bridge. The audio source
    // module exposes an AnalyserNode (videoSources map); we register
    // a synthetic video source node in the VideoEngine that owns a
    // waveform-video renderer pulling samples from the analyser each
    // frame, plus an "edge" so the target video module sees a normal
    // input texture during draw().
    if (
      targetDomain !== undefined
      && sourceDomain === 'audio'
      && targetDomain === 'video'
      && (edge.sourceType === 'mono-video'
        || edge.sourceType === 'video'
        || edge.sourceType === 'image'
        || edge.sourceType === 'keys')
    ) {
      this.addCrossDomainVideoTextureBridge(edge);
      return;
    }
    const engine = this.getDomain(sourceDomain);
    engine.addEdge(edge);
  }

  removeEdge(edge: Edge, sourceDomain: string): void {
    if (this.cvBridgeEdgeIds.has(edge.id)) {
      this.removeCrossDomainCvBridge(edge);
      return;
    }
    if (this.videoTextureBridgeEdgeIds.has(edge.id)) {
      this.removeCrossDomainVideoTextureBridge(edge);
      return;
    }
    const engine = this.getDomain(sourceDomain);
    engine.removeEdge(edge.id);
  }

  /**
   * Establish a cv (audio domain) → video param bridge. The audio source
   * is `.connect()`'d into a fresh AnalyserNode; the VideoEngine owns the
   * analyser and ticks it once per frame. We bookkeep the edge id so
   * removeEdge can tear it down symmetrically.
   *
   * Failure modes:
   *  - source AudioNode not yet materialized: defer (return without
   *    registering — the next reconcile pass will retry).
   *  - target video node not present: same — defer.
   *  - audio engine not the actual `AudioEngine` class (no
   *    getOutputNode): bail and just route to the source domain (legacy).
   */
  private addCrossDomainCvBridge(edge: Edge, sourceDomain: string, targetDomain: string): void {
    const audioEngine = this.domains.get(sourceDomain);
    const videoEngine = this.domains.get(targetDomain);
    if (!audioEngine || !videoEngine) return;
    const ae = audioEngine as AudioEngine;
    const ve = videoEngine as DomainEngine & {
      addCvBridge?: (
        edgeId: string,
        analyser: AnalyserNode,
        targetNodeId: string,
        targetParamId: string,
        teardown: () => void,
      ) => void;
      gl?: WebGL2RenderingContext;
    };
    if (typeof ae.getOutputNode !== 'function' || typeof ve.addCvBridge !== 'function') {
      // Engines don't support the bridge API. Fall back to source-domain
      // dispatch so the call doesn't silently no-op.
      audioEngine.addEdge(edge);
      return;
    }
    const src = ae.getOutputNode(edge.source.nodeId, edge.source.portId);
    if (!src) {
      // Source not yet materialized. Defer — caller (reconciler) will
      // see the edge in its appliedEdges map but the bridge isn't
      // active. Subsequent reconciles re-call addEdge with the same id;
      // we use the cvBridgeEdgeIds set to be idempotent above. For now,
      // mark it as "owed" and the next reconcile-pass after the source
      // materializes will succeed. We achieve that by NOT marking it as
      // applied here — but the reconciler doesn't re-attempt until the
      // edge changes... so instead, we record it in cvBridgeEdgeIds as
      // a sentinel so removeEdge knows to clean up if needed.
      this.cvBridgeEdgeIds.add(edge.id);
      return;
    }
    const analyser = ae.ctx.createAnalyser();
    analyser.fftSize = 32;
    analyser.smoothingTimeConstant = 0;
    src.node.connect(analyser, src.output);
    const teardown = () => {
      try { src.node.disconnect(analyser, src.output); } catch { /* */ }
      try { analyser.disconnect(); } catch { /* */ }
    };
    ve.addCvBridge!(edge.id, analyser, edge.target.nodeId, edge.target.portId, teardown);
    this.cvBridgeEdgeIds.add(edge.id);
  }

  private removeCrossDomainCvBridge(edge: Edge): void {
    this.cvBridgeEdgeIds.delete(edge.id);
    for (const eng of this.domains.values()) {
      const ve = eng as DomainEngine & { removeCvBridge?: (id: string) => void };
      if (typeof ve.removeCvBridge === 'function') {
        ve.removeCvBridge!(edge.id);
      }
    }
  }

  /**
   * Establish an audio → video texture bridge. The audio source
   * declares an AnalyserNode tap on the named port (via
   * AudioDomainNodeHandle.videoSources); the VideoEngine registers a
   * synthetic source node + an edge that delivers the waveform-video
   * texture to the target video module's input port.
   *
   * Failure modes (mirror addCrossDomainCvBridge):
   *  - audio source not yet materialized: defer (mark id, no-op).
   *  - video engine not present / lacks bridge API: fall back to
   *    audio-domain dispatch so the call doesn't silently drop.
   */
  private addCrossDomainVideoTextureBridge(edge: Edge): void {
    const audioEngine = this.domains.get('audio');
    const videoEngine = this.domains.get('video');
    if (!audioEngine || !videoEngine) {
      audioEngine?.addEdge(edge);
      return;
    }
    const ae = audioEngine as AudioEngine;
    const ve = videoEngine as DomainEngine & {
      addVideoTextureBridge?: (
        edgeId: string,
        sourceNodeId: string,
        sourcePortId: string,
        analyser: AnalyserNode,
        sampleRate: number,
        targetEdge: Edge,
        drawFrame?: (canvas: OffscreenCanvas | HTMLCanvasElement) => void,
      ) => void;
    };
    if (typeof ae.getVideoSource !== 'function' || typeof ve.addVideoTextureBridge !== 'function') {
      audioEngine.addEdge(edge);
      return;
    }
    const src = ae.getVideoSource(edge.source.nodeId, edge.source.portId);
    if (!src) {
      // Source not materialized yet (or doesn't declare a video port).
      // Mark the edge id so a later removeEdge knows we own it; the
      // reconciler will not retry until edges change.
      this.videoTextureBridgeEdgeIds.add(edge.id);
      return;
    }
    ve.addVideoTextureBridge!(
      edge.id,
      edge.source.nodeId,
      edge.source.portId,
      src.analyser,
      src.sampleRate,
      edge,
      src.drawFrame,
    );
    this.videoTextureBridgeEdgeIds.add(edge.id);
  }

  private removeCrossDomainVideoTextureBridge(edge: Edge): void {
    this.videoTextureBridgeEdgeIds.delete(edge.id);
    const ve = this.domains.get('video') as
      | (DomainEngine & { removeVideoTextureBridge?: (id: string) => void })
      | undefined;
    if (ve && typeof ve.removeVideoTextureBridge === 'function') {
      ve.removeVideoTextureBridge!(edge.id);
    }
  }

  setParam(node: ModuleNode, paramId: string, value: number): void {
    const engine = this.getDomain(node.domain);
    engine.setParam(node.id, paramId, value);
  }

  readParam(node: ModuleNode, paramId: string): number | undefined {
    return this.getDomain(node.domain).readParam(node.id, paramId);
  }

  /** Most-recent sample at a per-port modulator-tap analyser. Returns 0
   *  when no edge is connected to that port (or the domain doesn't
   *  implement taps). Card visualizers use this to read CV signals on
   *  ports whose id differs from the AudioParam id (e.g. WAVECEL's
   *  `morph_cv` port targets the `morph` AudioParam). */
  readModulatorTap(nodeId: string, portId: string, domain: string = 'audio'): number {
    const dom = this.domains.get(domain);
    return dom?.readModulatorTap?.(nodeId, portId) ?? 0;
  }

  read(node: ModuleNode, key: string): unknown {
    return this.getDomain(node.domain).read(node.id, key);
  }

  dispose(): void {
    this.cvBridgeEdgeIds.clear();
    this.videoTextureBridgeEdgeIds.clear();
    for (const e of this.domains.values()) e.dispose();
    this.domains.clear();
  }
}
