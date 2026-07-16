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
import { holdParamAtSeam, HOLD_NOW_EPS_S } from './hold-param';

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
   * Optional: schedule a param write at a FUTURE audio time (automation
   * playback). Unlike `setParam` — which lands at `ctx.currentTime` — this uses
   * `setValueAtTime(value, atTime)` (hard step, `ramp=false`) or
   * `linearRampToValueAtTime(value, atTime)` (smooth, `ramp=true`) so the
   * clip-automation lane can queue sample-accurate ramps ahead of the scheduler
   * tick. A module implements this when it exposes a schedulable AudioParam;
   * when omitted the AudioEngine falls back to the param's CV-target AudioParam
   * (`inputs[paramId].param`), else an immediate `setParam`. Touches NO Y.Doc.
   */
  scheduleParam?(paramId: string, value: number, atTime: number, ramp: boolean): void;
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
   * Optional: arbitrary per-module data WRITE (the inverse of `read`). Used by
   * cards that compute a value browser-side and must push it into the running
   * node — e.g. SYNESTHESIA's VIDEO mode, where the card reads the incoming
   * video frame's pixels (only the DOM has the canvas), reduces them to R/G/B/
   * Luma channel levels, and writes them to the worklet each frame. Modules
   * that need no card→node push omit this.
   */
  write?(key: string, value: unknown): void;
  /**
   * Optional: per-port AnalyserNode taps that surface this module's
   * audio output as a video-domain source (cross-domain handoff).
   *
   * Modules that declare a port whose `type` is `mono-video` / `video`
   * (e.g. WAVVIZ's `scope` port, SCOPE's `out` port) populate this map
   * with one entry per such port. The PatchEngine reads the analyser
   * via `getVideoSource(nodeId, portId)` when materializing an
   * audio→video edge; the VideoEngine then drives a waveform-video
   * renderer per frame, sampling from the analyser. Audio modules
   * with no video output omit this map entirely.
   *
   * Two flavors of video source:
   *
   *  - "simple analyser tap" (WAVVIZ/SWOLEVCO): a single AnalyserNode is
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
  /** Optional: schedule a param write at a future audio time (see the handle's
   *  `scheduleParam`). Only AudioEngine implements this today. */
  scheduleParam?(nodeId: string, paramId: string, value: number, atTime: number, ramp: boolean): void;
  /** Optional: CANCEL-AND-HOLD a param at a seam (clip-automation param-jump
   *  policy — truncate the scheduled tail, optionally glide to a value). Only
   *  AudioEngine implements this today. */
  holdParam?(nodeId: string, paramId: string, atTime: number, toValue?: number, glideS?: number): void;
  /** Optional: DISPLAY-ONLY knob-value refresh (no DSP) so automation playback can
   *  smoothly animate the on-screen control between step boundaries. */
  setDisplayParam?(nodeId: string, paramId: string, value: number): void;
  readParam(nodeId: string, paramId: string): number | undefined;
  /** Optional: most-recent sample at a per-port modulator-tap analyser.
   *  Only AudioEngine implements this today. Card visualizers call
   *  PatchEngine.readModulatorTap(nodeId, portId) to read CV-side
   *  modulation when the input port id differs from the AudioParam id
   *  (e.g. a `rate_cv` port targeting a `rate` param). */
  readModulatorTap?(nodeId: string, portId: string): number | undefined;
  read(nodeId: string, key: string): unknown;
  /** Optional inverse of `read`: push card-computed data into a node (see the
   *  handle's `write`). Only modules that need it implement it. */
  write?(nodeId: string, key: string, value: unknown): void;
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
      // Exact type count via the engine's own `nodeTypes` map (nodeId → type),
      // which addNode populates and removeNode/eviction keep in sync. This
      // replaces the old `id.startsWith(`${type}-`)` prefix heuristic, which
      // miscounted any node whose id didn't follow the palette's
      // `${type}-...` naming convention (custom/renamed ids): such a node was
      // not counted, so a singleton could be exceeded. The map yields the
      // type exactly, so a custom-id instance is now capped correctly.
      const sameType: string[] = [];
      for (const [id, t] of this.nodeTypes) {
        if (t === node.type) sameType.push(id);
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
        // Keep `nodeTypes` in sync with the eviction so a subsequent exact
        // count doesn't see the dropped instance (removeNode does the same).
        this.nodeTypes.delete(evictId);
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
    // id starts fresh from its def defaults. Also clear any per-param
    // modulator-tap AnalyserNodes keyed by this node — without this, the
    // paramTaps Map grows monotonically over an add/remove churn (chaos
    // 24/7 reproduces this in seconds) and the orphaned AnalyserNodes
    // outlive their source AudioNodes, leaking GC pressure.
    const prefix = `${nodeId}::`;
    for (const key of this.knobValues.keys()) {
      if (key.startsWith(prefix)) this.knobValues.delete(key);
    }
    for (const key of this.paramTaps.keys()) {
      if (key.startsWith(prefix)) {
        const tap = this.paramTaps.get(key);
        if (tap) {
          try { tap.disconnect(); } catch { /* already torn down */ }
        }
        this.paramTaps.delete(key);
      }
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
  /**
   * Resolve a (node, INPUT port) → the AudioParam id that input drives, via the
   * module def's `port.paramTarget`. Returns null when the node isn't known or
   * the port declares no paramTarget (a pure AudioNode input with no param to
   * drive). Used by PatchEngine.pulseGateInput / setGateInput so a MIDI-assigned
   * NOTE on a gate input drives the SAME param a same-domain gate edge does.
   */
  resolvePortParamTarget(nodeId: string, portId: string): string | null {
    const moduleType = this.nodeTypes.get(nodeId);
    if (!moduleType) return null;
    const def = getModuleDef(moduleType) as AudioModuleDef | undefined;
    if (!def) return null;
    const port = def.inputs.find((p) => p.id === portId);
    if (!port || !port.paramTarget) return null;
    return port.paramTarget;
  }

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
        // `center: 'default'` (absolute-position params) IGNORES any stored/live
        // knob so a cabled input tracks the source directly — a stale saved base
        // can't offset it. Otherwise centre the sweep on the live knob (bias).
        const liveKnob = scaleInfo.hint.center === 'default'
          ? scaleInfo.paramDef.defaultValue
          : (this.knobValues.get(
              this.knobKey(edge.target.nodeId, scaleInfo.paramDef.id),
            ) ?? scaleInfo.paramDef.defaultValue);
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

  /**
   * Schedule a param write at a FUTURE audio time — the transient playback seam
   * the clip-automation lane drives (never touches the Y.Doc). `setParam` only
   * lands at `ctx.currentTime`, which stair-steps automation between scheduler
   * ticks; this queues `setValueAtTime` (hard step) / `linearRampToValueAtTime`
   * (smooth) at `atTime` so a ramp is sample-accurate + click-free.
   *
   * Reaches the AudioParam three ways, in order: (1) the handle's own
   * `scheduleParam` if it exposes one; (2) the param's CV-target AudioParam
   * (`inputs[paramId].param`) — the same node a CV cable would sum into; (3) a
   * best-effort immediate `setParam` when neither exists (no schedulable param).
   * Always refreshes the `knobValues` cache so the on-screen control follows the
   * automation, exactly like `setParam`.
   */
  scheduleParam(
    nodeId: string,
    paramId: string,
    value: number,
    atTime: number,
    ramp: boolean,
  ): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    if (typeof handle.scheduleParam === 'function') {
      handle.scheduleParam(paramId, value, atTime, ramp);
    } else {
      const param = handle.inputs.get(paramId)?.param;
      if (param) {
        if (ramp) param.linearRampToValueAtTime(value, atTime);
        else param.setValueAtTime(value, atTime);
      } else {
        // No schedulable AudioParam exposed → immediate best-effort set.
        handle.setParam(paramId, value);
      }
    }
    this.knobValues.set(this.knobKey(nodeId, paramId), value);
  }

  /**
   * HOLD/PIN a param at a seam — the clip-automation param-jump policy (Phase 0).
   * Two regimes, dispatched on WHEN `atTime` is (holdParamAtSeam):
   *
   *  - NEAR-NOW (`atTime <= now + eps`): cancel-and-hold — truncate the ~200 ms
   *    scheduled ramp tail (killing the ghost that keeps driving a param after an
   *    immediate stop / a hand grab) and pin the value there; then optionally
   *    move to `toValue` (hard set, or a short de-zipper glide over `glideS`).
   *    Omit `toValue` to only truncate (the touch punch-in — live manual input is
   *    the new writer). Firefox lacks `cancelAndHoldAtTime`; the util
   *    reimplements it (read-current → cancel → re-pin).
   *
   *  - FUTURE (a quantized boundary switch / a switch-INTO step anchor): NEVER
   *    cancel (a future cancel retro-deletes the outgoing clip's final in-flight
   *    ramp in the fallback, and native `cancelAndHoldAtTime(futureT)` inserts NO
   *    hold when nothing is scheduled after it — a silent no-op). Instead PIN an
   *    explicit value with a real `setValueAtTime` event at `atTime`:
   *    `toValue` when given, else the `knobValues` cached intrinsic (the
   *    future-most scheduled value — at a boundary that IS the outgoing envelope's
   *    landing value; after a stop it IS the deterministic held resting value).
   *
   * Reaches the SAME AudioParam `scheduleParam` drives — the param's CV-target
   * AudioParam (`inputs[paramId].param`). When the module exposes no schedulable
   * AudioParam (a Faust worklet driving its params off the message port) there is
   * no tail to cancel: best-effort pin via `scheduleParam` / `setParam`.
   * Refreshes `knobValues` like `scheduleParam`.
   */
  holdParam(
    nodeId: string,
    paramId: string,
    atTime: number,
    toValue?: number,
    glideS = 0,
  ): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    const key = this.knobKey(nodeId, paramId);
    const now = this.ctx.currentTime;
    // FUTURE pins need an explicit value (never a cancel): fall back to the
    // cached intrinsic when the caller didn't pass one (the switch-INTO anchor).
    const future = atTime > now + HOLD_NOW_EPS_S;
    const pinValue = toValue ?? (future ? this.knobValues.get(key) : undefined);
    const param = handle.inputs.get(paramId)?.param;
    if (param) {
      holdParamAtSeam(param, now, atTime, pinValue ?? null, glideS);
    } else if (pinValue != null) {
      // No schedulable AudioParam to cancel — best-effort pin the value.
      if (typeof handle.scheduleParam === 'function') {
        handle.scheduleParam(paramId, pinValue, atTime, glideS > 0);
      } else {
        handle.setParam(paramId, pinValue);
      }
    }
    if (pinValue != null) this.knobValues.set(key, pinValue);
  }

  /**
   * DISPLAY-ONLY param refresh — update the JS-side `knobValues` cache (what the
   * on-screen knob polls via readParam) WITHOUT touching the DSP / scheduling any
   * audio. Automation playback schedules smooth audio ramps but only writes
   * knobValues at STEP boundaries, so on a slow clip the on-screen knob looks
   * jumpy (holds a step, then snaps); the clipplayer tick calls this every tick
   * with the CURRENT interpolated envelope value so the knob follows smoothly.
   * Cheap (one Map set); the audio path is unaffected.
   */
  setDisplayParam(nodeId: string, paramId: string, value: number): void {
    if (!this.nodes.has(nodeId)) return;
    this.knobValues.set(this.knobKey(nodeId, paramId), value);
  }

  /** Read the live AudioParam value for motorized fader rendering.
   *  Returns intrinsic + sample of any connected modulators (via the
   *  per-param AnalyserNode tap), so faders visually track LFOs/envelopes.
   *
   *  Intrinsic source = the JS-side `knobValues` cache, NOT the handle's
   *  AudioParam.value. For Faust AudioWorkletNodes, AudioParam.value does
   *  not reliably reflect setValueAtTime: Faust drives its params through
   *  the worklet message port / its own param array, and never writes the
   *  computed value back to the AudioParam, so .value sits at its
   *  construction-time default (0 for VCA base, 0.005 for ADSR attack)
   *  FOREVER — even with the AudioContext running and the knob set. Reading
   *  .value therefore reports a node's params as their defaults regardless
   *  of the spawned / dragged value — the "dead knob / display + engine read
   *  0 on load" bug the slider-drag spec guards.
   *
   *  `knobValues` is the authoritative JS-side intrinsic: seeded from
   *  node.params (falling back to def defaults) in addNode and kept in lock-
   *  step by setParam — exactly the value the DSP is actually running. We
   *  fall back to the handle's readParam only when the cache has no entry
   *  (defensive; every materialized node seeds the cache for all its params),
   *  so non-Faust handles whose .value IS live keep working too. */
  readParam(nodeId: string, paramId: string): number | undefined {
    const cached = this.knobValues.get(this.knobKey(nodeId, paramId));
    const intrinsic = cached ?? this.nodes.get(nodeId)?.readParam(paramId);
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
   *  (e.g. a `rate_cv` port targeting a `rate` param). Returns undefined
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

  write(nodeId: string, key: string, value: unknown): void {
    const handle = this.nodes.get(nodeId);
    handle?.write?.(key, value);
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
   * Cross-domain bridge support (video → audio): the mirror of getOutputNode.
   * Return the AudioNode + input index (or AudioParam, when the target
   * port is a CV-into-param routing) for a given (nodeId, portId), so
   * the PatchEngine's video→audio bridge can `.connect()` the upstream
   * AudioNode (published by the video module via
   * VideoNodeHandle.audioSources) into the downstream audio module's
   * input.
   *
   * Returns null when the node isn't materialized or has no such port —
   * caller defers to a later reconcile pass.
   */
  getInputNode(
    nodeId: string,
    portId: string,
  ): { node: AudioNode; input: number; param?: AudioParam } | null {
    const handle = this.nodes.get(nodeId);
    if (!handle) return null;
    const inp = handle.inputs.get(portId);
    return inp ?? null;
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
  /** Edges that became cross-domain video → audio bridges (DOOM's audio
   *  out, etc.). Bookkept like the other two — neither domain engine
   *  sees the edge in its own `edges` map; the bridge owns the
   *  AudioNode connection lifetime. */
  private audioBridgeEdgeIds = new Set<string>();
  /** Per-edge teardown for video→audio bridges. */
  private audioBridgeTeardowns = new Map<string, () => void>();
  /** Edges that became cross-domain AUDIO → video AUDIO-INPUT bridges
   *  (RECORDERBOX's audio_l/audio_r soundtrack capture). The inverse of
   *  audioBridgeEdgeIds: an audio source connects straight into an
   *  AudioNode SINK the video module owns (via VideoNodeHandle.audioInputs).
   *  Bookkept so removeEdge can tear down symmetrically; neither domain
   *  engine sees the edge in its own `edges` map. */
  private audioInputBridgeEdgeIds = new Set<string>();
  /** Per-edge teardown for audio→video audio-input bridges. */
  private audioInputBridgeTeardowns = new Map<string, () => void>();
  /** The Edge objects for video→audio bridges, kept so we can RE-RESOLVE a
   *  bridge when its video source swaps the AudioNode published for a port
   *  (e.g. VIDEOBOX/VIDEOVARISPEED's wireAudio replaces the silent placeholder
   *  with the live MediaElementSource splitter AFTER the edge was connected).
   *  Without re-resolution the bridge stays wired to the dead placeholder and
   *  the operator hears silence. Keyed by edge id. */
  private audioBridgeEdges = new Map<string, Edge>();
  /** Edges that became SAME-DOMAIN video→video CV/gate bridges (DOOM's evt_kill
   *  → SCOREBOARD.score, etc.). Like cvBridgeEdgeIds: the edge is owned by the
   *  bridge — neither end's edges Map sees it. Bookkept so removeEdge can
   *  symmetrically tear down. */
  private sameDomainVideoCvBridgeEdgeIds = new Set<string>();
  /** Frame-independent pulse-subscription teardowns for same-domain video.gate
   *  bridges. When the source declares `subscribePulse` we install a discrete
   *  dispatch path (per-pulse setParam pair) IN ADDITION to the analyser tap,
   *  so a 10ms pulse can't be missed by 60fps polling. The teardown unsubs +
   *  cancels any pending settle frame. Keyed by edge id (symmetric with the
   *  analyser bridge bookkeeping). */
  private sameDomainPulseSubTeardowns = new Map<string, () => void>();
  /**
   * Cross-domain (and same-domain video-CV) bridges that couldn't be wired
   * at addEdge time because the source or target node wasn't materialized
   * yet, or its port handle hadn't surfaced (e.g. video module published
   * its `audioSources` entry late, after the edge was first applied).
   *
   * Without this Map, those bridges were marked in the per-kind `xxxEdgeIds`
   * set (so removeEdge knew about them) BUT the reconciler then saw the
   * edge id in `appliedEdges` and never re-tried — silent permanent failure.
   * User-visible symptom: "I patched the cable but no signal." Codex
   * audit pinpointed engine.ts:893-902 + :962-967 as the offending paths.
   *
   * The fix: any failed-to-wire cross-domain bridge gets parked here
   * (instead of marked as owned). Drained on:
   *  - addNode completion (the awaited node's id matches either endpoint)
   *  - VideoEngine.onAudioSourcesChanged (port handle surfaces post-spawn)
   *  - removeNode (evict pending bridges touching the removed node)
   *  - removeEdge (evict from both pending + applied)
   *
   * Successful retries move out of pendingBridges and into the relevant
   * per-kind tracking (cvBridgeEdgeIds + audioBridgeEdges, etc.) — i.e.
   * the SAME bookkeeping the happy path uses. Failed retries (still
   * missing the endpoint) stay parked.
   *
   * The `kind` tag tells the drainer which add-method to re-call.
   */
  private pendingBridges = new Map<
    string,
    { edge: Edge; kind: 'cv' | 'video-texture' | 'audio' | 'audio-input' | 'same-domain-video-cv'; sourceDomain?: string; targetDomain?: string }
  >();

  /**
   * Debug/observability surface: how many cross-domain bridges are currently
   * parked waiting for materialization? Useful for property tests + future
   * dev-mode HUD. Reads internal state — does not mutate.
   */
  getPendingBridgeCount(): number {
    return this.pendingBridges.size;
  }

  /**
   * Debug/observability surface: how many cross-domain bridges are currently
   * wired? Sum of all four per-kind sets. Property tests use this paired
   * with getPendingBridgeCount to assert the no-leak invariant.
   */
  getAppliedBridgeCount(): number {
    return (
      this.cvBridgeEdgeIds.size
      + this.videoTextureBridgeEdgeIds.size
      + this.audioBridgeEdgeIds.size
      + this.audioInputBridgeEdgeIds.size
      + this.sameDomainVideoCvBridgeEdgeIds.size
    );
  }

  registerDomain(engine: DomainEngine): void {
    this.domains.set(engine.domain, engine);
    // When BOTH audio + video are registered, thread the AudioContext
    // through to VideoEngine so video modules that emit audio (DOOM)
    // can create AudioNodes inside their factory. Either side can be
    // registered first — we run this on every registerDomain call and
    // either party (the new one + the existing one) gets the wiring.
    const audio = this.domains.get('audio') as AudioEngine | undefined;
    const video = this.domains.get('video') as
      | (DomainEngine & {
          setAudioContext?: (ctx: AudioContext | null) => void;
          onAudioSourcesChanged?: (cb: ((nodeId: string) => void) | null) => void;
        })
      | undefined;
    if (audio && video && typeof video.setAudioContext === 'function') {
      video.setAudioContext(audio.ctx);
    }
    // Re-resolve video→audio bridges when a video source swaps the AudioNode
    // identity on one of its audio ports (wireAudio/unwireAudio). A bridge that
    // was connected to the silent placeholder before the swap would otherwise
    // stay wired to the dead node and the operator's downstream patch is silent.
    if (video && typeof video.onAudioSourcesChanged === 'function') {
      video.onAudioSourcesChanged((nodeId) => this.reapplyAudioBridgesForSource(nodeId));
    }
  }

  /**
   * Re-resolve + re-connect every video→audio bridge whose SOURCE is `nodeId`.
   * Called when that node swaps the AudioNode published for an audio port
   * (e.g. wireAudio replaces the silent placeholder with the live splitter).
   * Tears the old connection down (it points at the stale node) and re-runs
   * addCrossDomainAudioBridge, which re-reads the now-current audioSources node
   * and re-connects. Idempotent + safe if nothing changed (re-connecting the
   * same node is harmless; the teardown then re-make is a no-op net change).
   */
  private reapplyAudioBridgesForSource(nodeId: string): void {
    for (const [edgeId, edge] of this.audioBridgeEdges) {
      if (edge.source.nodeId !== nodeId) continue;
      // Tear down the existing (possibly stale) connection, then re-resolve.
      const teardown = this.audioBridgeTeardowns.get(edgeId);
      if (teardown) {
        try { teardown(); } catch { /* */ }
        this.audioBridgeTeardowns.delete(edgeId);
      }
      this.audioBridgeEdgeIds.delete(edgeId);
      this.addCrossDomainAudioBridge(edge);
    }
    // The port-handle on `nodeId` just surfaced (or swapped). Drain ANY
    // pending cross-domain bridge that was waiting on this node — not
    // just video→audio ones. Covers cv-bridge, video-texture, and
    // same-domain-video-cv whose video source publishes lazily.
    this.drainPendingForNode(nodeId);
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
    // Drain any pending cross-domain bridges that were waiting for this
    // node's endpoint(s) to materialize. Without this, edges patched into
    // not-yet-materialized targets stayed silently dead (Codex audit fix).
    this.drainPendingForNode(node.id);
  }

  removeNode(node: ModuleNode): void {
    const engine = this.getDomain(node.domain);
    engine.removeNode(node.id);
    // Evict any pending bridges that referenced this node — they have
    // no chance of resolving until the user re-spawns + re-cables.
    for (const [edgeId, entry] of this.pendingBridges) {
      if (
        entry.edge.source.nodeId === node.id
        || entry.edge.target.nodeId === node.id
      ) {
        this.pendingBridges.delete(edgeId);
      }
    }
  }

  /**
   * Retry every pending cross-domain bridge whose source or target is
   * `nodeId`. Successful retries land in the relevant xxxBridgeEdgeIds
   * set and self-remove from pendingBridges (each addCrossDomainXxxBridge
   * happy-path calls pendingBridges.delete on success). Failed retries
   * stay parked — they re-park themselves on the next defer branch.
   *
   * Called from PatchEngine.addNode (post-await — handle is materialized,
   * port handles are surfaced) and from onAudioSourcesChanged (a video
   * module swapped its published AudioNode for a port — wireAudio
   * surfaces a new handle).
   *
   * Snapshot the entries before iterating: each retry may mutate
   * pendingBridges (either via .delete on success or via .set re-park
   * on continued failure), which makes for-of over the live Map unsafe.
   */
  private drainPendingForNode(nodeId: string): void {
    const entries: Array<{ edge: Edge; kind: 'cv' | 'video-texture' | 'audio' | 'audio-input' | 'same-domain-video-cv'; sourceDomain?: string; targetDomain?: string }> = [];
    for (const entry of this.pendingBridges.values()) {
      if (
        entry.edge.source.nodeId === nodeId
        || entry.edge.target.nodeId === nodeId
      ) {
        entries.push(entry);
      }
    }
    for (const entry of entries) {
      switch (entry.kind) {
        case 'cv':
          this.addCrossDomainCvBridge(
            entry.edge,
            entry.sourceDomain ?? 'audio',
            entry.targetDomain ?? 'video',
          );
          break;
        case 'video-texture':
          this.addCrossDomainVideoTextureBridge(entry.edge);
          break;
        case 'audio':
          this.addCrossDomainAudioBridge(entry.edge);
          break;
        case 'audio-input':
          this.addCrossDomainAudioInputBridge(entry.edge);
          break;
        case 'same-domain-video-cv':
          this.addSameDomainVideoCvBridge(entry.edge);
          break;
      }
    }
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
   * sourceType is 'cv' OR 'gate'. The targetType being 'cv' is the
   * canonical case (video modules declare CV-modulatable params as
   * type='cv' inputs); we also accept video cable targets in case someone
   * routes audio CV directly to a video stream port (the type system
   * permits it via canConnect). `gate` sources (gamepad buttons/dpad,
   * sequencer gates) bridge identically — the analyser reads the 0/1
   * value each frame and the target module's edge detector fires.
   *
   * If `targetDomain` is omitted (legacy callers), we fall back to
   * single-domain dispatch — preserves Phase-0 semantics for tests that
   * don't pass a target domain.
   */
  addEdge(edge: Edge, sourceDomain: string, targetDomain?: string): void {
    if (
      targetDomain !== undefined
      && sourceDomain === 'audio'
      && targetDomain !== 'audio'
      && (edge.sourceType === 'cv'
        || edge.sourceType === 'gate'
        // PITCH / poly-PITCH → a CV-family video param (cv/pitch/gate). The
        // video SOURCE asset-selector (PICTUREBOX / VIDEOVARISPEED
        // asset_pitch) reads a clip player's V/oct note: the source emits
        // `pitch` (or `polyPitchGate`, downcast to lane 0 by getOutputNode's
        // output-0 tap) and the target is a `pitch`-typed param. Route it
        // through the same sample-and-hold CV bridge (RAW passthrough, since
        // the asset_pitch input declares NO cvScale) so the card reads the
        // raw V/oct. SCOPED to a CV-family TARGET so a pitch source can never
        // accidentally hit the texture/stream bridge below.
        || ((edge.sourceType === 'pitch' || edge.sourceType === 'polyPitchGate')
          && (edge.targetType === 'cv' || edge.targetType === 'pitch' || edge.targetType === 'gate'))
        // AUDIO → a `modsignal` modulation input (TOYBOX's 6-input section). An
        // audio-rate source patched into a modsignal input is ENVELOPE-FOLLOWED
        // by the sample-and-hold bridge (see VideoEngine.tickCvBridges) to a
        // 0..1 modulation value — the same path cv/gate take. Scoped to the
        // `modsignal` TARGET so audio → a video STREAM port (image/video/keys)
        // still goes to the texture bridge below, and audio→cv stays rejected
        // everywhere else. canConnect permits cv/gate/audio → modsignal.
        || (edge.sourceType === 'audio' && edge.targetType === 'modsignal'))
    ) {
      // `cv` (LFO, gamepad sticks ±1) AND `gate` (gamepad buttons/dpad,
      // sequencer gates) both bridge audio → video the same way: the
      // analyser samples the ConstantSource/AudioParam value each frame.
      // A gate source carries 0/1 which still crosses a gate detector's
      // rise/fall thresholds. Without accepting `gate` here, patching a
      // gamepad D-pad (gate output) into DOOM's movement inputs fell
      // through to single-domain audio dispatch and silently no-op'd.
      //
      // Scoped to sourceDomain === 'audio': the inverse direction
      // (video CV → audio param, e.g. NIBBLES.length_cv → QBRT.cutoff_cv)
      // is handled below by addCrossDomainAudioBridge, which reads the
      // video module's audioSources map directly and .connect()s into
      // the downstream AudioParam — no AnalyserNode sample-and-hold
      // needed since both sides already live on the AudioContext graph.
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
    // Cross-domain video → audio bridge. The video module declares an
    // AudioNode tap on the named port (via VideoNodeHandle.audioSources);
    // we look it up + connect into the downstream AudioEngine input.
    //
    // Accepts `audio`, `cv`, and `gate` source types. All three live as
    // ordinary AudioNodes on the AudioContext graph (DOOM publishes
    // audio_l/audio_r oscillator gains; NIBBLES publishes length_cv +
    // pellet/death/dir_change ConstantSourceNodes), so the same
    // .connect()-into-AudioEngine-input wiring works for all of them.
    // CV/gate cables typically terminate on a CV-shaped audio input that
    // routes to an AudioParam — addCrossDomainAudioBridge handles that
    // via the `dst.param` branch.
    if (
      targetDomain !== undefined
      && sourceDomain === 'video'
      && targetDomain === 'audio'
      && (edge.sourceType === 'audio'
        || edge.sourceType === 'cv'
        || edge.sourceType === 'gate')
    ) {
      this.addCrossDomainAudioBridge(edge);
      return;
    }
    // Cross-domain audio → video AUDIO-INPUT bridge (RECORDERBOX). The
    // INVERSE of the video→audio bridge above: an AUDIO-domain source
    // (a VCO, mixer, etc.) wired into an `audio`-TYPED INPUT port on a
    // VIDEO module. RECORDERBOX is the first consumer — it captures the
    // live audio (alongside its video input) into an MP4 soundtrack, so
    // its `audio_l` / `audio_r` ports are real audio sinks, not the
    // cv/gate sample-and-hold the first branch handles.
    //
    // The video module owns a MediaStreamAudioDestinationNode (or any
    // AudioNode sink) per audio input port and publishes it via
    // VideoNodeHandle.audioInputs; we look up the audio SOURCE's output
    // (AudioEngine.getOutputNode) and .connect() it straight into that
    // sink. Both live on the shared AudioContext graph, so it's a plain
    // node→node connect — no analyser, no per-frame tick.
    //
    // Scoped to targetType==='audio' so a cv/gate audio source into a
    // video param still routes through addCrossDomainCvBridge (the first
    // branch), and audio→video TEXTURE edges still hit the texture bridge.
    if (
      targetDomain !== undefined
      && sourceDomain === 'audio'
      && targetDomain === 'video'
      && edge.targetType === 'audio'
    ) {
      this.addCrossDomainAudioInputBridge(edge);
      return;
    }
    // SAME-DOMAIN video CV/gate bridge (2026-05-29). A video module emitting
    // a CV/gate via `audioSources` (DOOM's evt_kill / evt_door / evt_gun_*,
    // NIBBLES's length_cv etc.) wired to ANOTHER video module's CV input
    // (SCOREBOARD.score, 4PLEXVID.gate1..) used to fall through to plain
    // single-domain dispatch, which puts it into the VideoEngine's edges
    // Map — only used for texture lookup. Same-domain CV/gate then never
    // reached the downstream setParam call, so SCOREBOARD never incremented
    // when patched off DOOM's KILL gate. We route it through the SAME
    // cross-domain CV bridge path used by audio→video — both endpoints live
    // on the AudioContext graph (the source via audioSources, the analyser
    // owned by the audio context), so the analyser sample-and-hold reading
    // the AudioNode each frame works regardless of whether the source's
    // declaring module is "video" or "audio".
    if (
      targetDomain !== undefined
      && sourceDomain === 'video'
      && targetDomain === 'video'
      && (edge.sourceType === 'cv' || edge.sourceType === 'gate')
    ) {
      this.addSameDomainVideoCvBridge(edge);
      return;
    }
    // SAME-DOMAIN audio VIDEO-FRAME edge (2026-06-01). An audio-domain
    // module can expose a mono-video/video OUTPUT (WAVESCULPT's video_out,
    // FOXY's scope_out/wave3d_out, …) AND consume a video INPUT card-side
    // (WAVESCULPT's wall1..wall6 / alpha_in — the card reads the source's
    // `videoSources` frame directly via getVideoSource). A cable between two
    // AUDIO modules carrying a video frame is therefore NOT an audio-graph
    // edge: the audio engine has no AudioNode for a video port and would
    // throw "no source/target port". The frame handoff is done out-of-band
    // by the consuming card walking patch.edges, so the engine simply
    // ignores this edge. This is what makes WAVESCULPT video_out → its own
    // wall{N} (recursive video feedback / "feedback madness") work without
    // the reconciler erroring — self-patching is allowed, not blocked.
    if (
      sourceDomain === 'audio'
      && (targetDomain === undefined || targetDomain === 'audio')
      && (edge.sourceType === 'mono-video'
        || edge.sourceType === 'video'
        || edge.sourceType === 'image'
        || edge.sourceType === 'keys')
    ) {
      return;
    }
    const engine = this.getDomain(sourceDomain);
    engine.addEdge(edge);
  }

  removeEdge(edge: Edge, sourceDomain: string): void {
    // Evict from pendingBridges FIRST — if the user un-cables before the
    // bridge ever got to wire, we don't want a stale entry leaking. The
    // teardown methods below all guard against missing state.
    const wasPending = this.pendingBridges.has(edge.id);
    this.pendingBridges.delete(edge.id);
    // Also clean up audioBridgeEdges if it was a deferred audio bridge —
    // we set it eagerly in addCrossDomainAudioBridge before the defer
    // check, so removeEdge must clear it even if the bridge never
    // succeeded.
    this.audioBridgeEdges.delete(edge.id);
    if (this.cvBridgeEdgeIds.has(edge.id)) {
      this.removeCrossDomainCvBridge(edge);
      return;
    }
    if (this.videoTextureBridgeEdgeIds.has(edge.id)) {
      this.removeCrossDomainVideoTextureBridge(edge);
      return;
    }
    if (this.audioBridgeEdgeIds.has(edge.id)) {
      this.removeCrossDomainAudioBridge(edge);
      return;
    }
    if (this.audioInputBridgeEdgeIds.has(edge.id)) {
      this.removeCrossDomainAudioInputBridge(edge);
      return;
    }
    if (this.sameDomainVideoCvBridgeEdgeIds.has(edge.id)) {
      this.removeSameDomainVideoCvBridge(edge);
      return;
    }
    if (wasPending) {
      // The edge was a deferred cross-domain bridge that never
      // materialized. We've already evicted it from pendingBridges +
      // audioBridgeEdges above — no domain engine ever saw the edge so
      // there's nothing further to do.
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
        sourceType?: string,
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
      // Source not yet materialized. Park in pendingBridges so a later
      // node/port-handle materialization can drive a retry. NOT marking
      // the edge as cvBridgeEdgeIds — that would let the reconciler
      // see the id as "owned" + silently never retry (the old bug).
      this.pendingBridges.set(edge.id, { edge, kind: 'cv', sourceDomain, targetDomain });
      return;
    }
    const analyser = ae.ctx.createAnalyser();
    // An AUDIO source is envelope-followed (RMS over the window) by the bridge,
    // so it needs a wider window than the 32-sample cv tail read. A cv/gate
    // source still uses the tail sample, but a wider window is harmless there.
    analyser.fftSize = edge.sourceType === 'audio' ? 1024 : 32;
    analyser.smoothingTimeConstant = 0;
    src.node.connect(analyser, src.output);
    const teardown = () => {
      try { src.node.disconnect(analyser, src.output); } catch { /* */ }
      try { analyser.disconnect(); } catch { /* */ }
    };
    ve.addCvBridge!(edge.id, analyser, edge.target.nodeId, edge.target.portId, teardown, edge.sourceType);
    this.cvBridgeEdgeIds.add(edge.id);
    // Success on retry → clear any pending entry for this edge id.
    this.pendingBridges.delete(edge.id);
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
      // Park in pendingBridges; a later addNode / port-handle change
      // drains. Do NOT mark videoTextureBridgeEdgeIds — that's the
      // happy-path "owned + wired" set; pre-fix, marking it here let
      // the reconciler silently abandon the edge (Codex audit:962-967).
      this.pendingBridges.set(edge.id, { edge, kind: 'video-texture' });
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
    this.pendingBridges.delete(edge.id);
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

  /**
   * Establish a video → audio bridge. The video module declares an
   * AudioNode on `VideoNodeHandle.audioSources` for the named source
   * port; we look it up via VideoEngine.getAudioSource, then connect
   * the AudioNode into the downstream audio module's input (looked up
   * via AudioEngine.getInputNode).
   *
   * The bridge owns the connection lifetime — neither domain engine
   * sees the edge in its own `edges` map. removeEdge fires the
   * teardown stored in audioBridgeTeardowns.
   *
   * Failure modes (mirror addCrossDomainCvBridge):
   *  - either domain engine missing: bail (the call doesn't silently
   *    drop — fall back to source-domain dispatch for legacy callers).
   *  - source video node not yet materialized or doesn't declare an
   *    audioSource for the port: defer (mark id; teardown is a no-op).
   *  - target audio input not present: defer.
   */
  private addCrossDomainAudioBridge(edge: Edge): void {
    // Remember the edge so reapplyAudioBridgesForSource can re-resolve it when
    // the source node later swaps its published AudioNode (wireAudio).
    this.audioBridgeEdges.set(edge.id, edge);
    const videoEngine = this.domains.get('video');
    const audioEngine = this.domains.get('audio');
    if (!videoEngine || !audioEngine) {
      videoEngine?.addEdge(edge);
      return;
    }
    const ve = videoEngine as DomainEngine & {
      getAudioSource?: (nodeId: string, portId: string) =>
        | { node: AudioNode; output: number } | null;
    };
    const ae = audioEngine as AudioEngine;
    if (typeof ve.getAudioSource !== 'function' || typeof ae.getInputNode !== 'function') {
      videoEngine.addEdge(edge);
      return;
    }
    const src = ve.getAudioSource(edge.source.nodeId, edge.source.portId);
    const dst = ae.getInputNode(edge.target.nodeId, edge.target.portId);
    if (!src || !dst) {
      // Defer — park in pendingBridges. A later addNode (audio sink
      // materializes) or onAudioSourcesChanged (video module wireAudio
      // surfaces its AudioNode) drains and retries. Do NOT mark
      // audioBridgeEdgeIds here — pre-fix that's exactly what stranded
      // the bridge dead-wired-to-nothing forever.
      //
      // Note: audioBridgeEdges still holds the Edge so
      // reapplyAudioBridgesForSource can re-resolve on swap; we keep it
      // in there (no change) — drainPending below will re-run addCross-
      // DomainAudioBridge which puts it right back in the map.
      this.pendingBridges.set(edge.id, { edge, kind: 'audio' });
      return;
    }
    if (dst.param) {
      // Audio cable terminating on an AudioParam (rare: an audio module
      // might expose a CV-shaped input that maps to an AudioParam). Connect
      // the source to the param; teardown disconnects.
      src.node.connect(dst.param, src.output);
      this.audioBridgeTeardowns.set(edge.id, () => {
        try { src.node.disconnect(dst.param!, src.output); } catch { /* */ }
      });
    } else {
      src.node.connect(dst.node, src.output, dst.input);
      this.audioBridgeTeardowns.set(edge.id, () => {
        try { src.node.disconnect(dst.node, src.output, dst.input); } catch { /* */ }
      });
    }
    this.audioBridgeEdgeIds.add(edge.id);
    this.pendingBridges.delete(edge.id);
  }

  private removeCrossDomainAudioBridge(edge: Edge): void {
    this.audioBridgeEdgeIds.delete(edge.id);
    this.audioBridgeEdges.delete(edge.id);
    const teardown = this.audioBridgeTeardowns.get(edge.id);
    if (teardown) {
      try { teardown(); } catch { /* */ }
      this.audioBridgeTeardowns.delete(edge.id);
    }
  }

  /**
   * Establish an AUDIO → video AUDIO-INPUT bridge (RECORDERBOX). The
   * inverse of addCrossDomainAudioBridge: an AUDIO-domain source's output
   * (looked up via AudioEngine.getOutputNode) is `.connect()`'d straight
   * into an AudioNode SINK the video module owns for the named INPUT port
   * (looked up via VideoEngine.getAudioInput). Both ends live on the shared
   * AudioContext graph, so it's a plain node→node connection — RECORDERBOX
   * feeds its L/R MediaStreamAudioDestinationNodes that become the MP4's
   * AAC soundtrack.
   *
   * The bridge owns the connection lifetime — neither domain engine sees
   * the edge in its own `edges` map. removeEdge fires the stored teardown.
   *
   * Failure modes (mirror addCrossDomainAudioBridge):
   *  - either domain engine missing: fall back to source-domain dispatch.
   *  - bridge API missing on either engine: fall back to source dispatch.
   *  - source AudioNode not yet materialized OR target video node doesn't
   *    declare an audioInput for the port: defer (park in pendingBridges).
   */
  private addCrossDomainAudioInputBridge(edge: Edge): void {
    const audioEngine = this.domains.get('audio');
    const videoEngine = this.domains.get('video');
    if (!audioEngine || !videoEngine) {
      audioEngine?.addEdge(edge);
      return;
    }
    const ae = audioEngine as AudioEngine;
    const ve = videoEngine as DomainEngine & {
      getAudioInput?: (nodeId: string, portId: string) =>
        | { node: AudioNode; input: number } | null;
    };
    if (typeof ae.getOutputNode !== 'function' || typeof ve.getAudioInput !== 'function') {
      audioEngine.addEdge(edge);
      return;
    }
    const src = ae.getOutputNode(edge.source.nodeId, edge.source.portId);
    const dst = ve.getAudioInput(edge.target.nodeId, edge.target.portId);
    if (!src || !dst) {
      // Defer — a later addNode (RECORDERBOX materializes its destination
      // node) or the audio source surfacing its output drains + retries.
      // Do NOT mark audioInputBridgeEdgeIds here (that's the applied set).
      this.pendingBridges.set(edge.id, { edge, kind: 'audio-input' });
      return;
    }
    src.node.connect(dst.node, src.output, dst.input);
    this.audioInputBridgeTeardowns.set(edge.id, () => {
      try { src.node.disconnect(dst.node, src.output, dst.input); } catch { /* */ }
    });
    this.audioInputBridgeEdgeIds.add(edge.id);
    this.pendingBridges.delete(edge.id);
  }

  private removeCrossDomainAudioInputBridge(edge: Edge): void {
    this.audioInputBridgeEdgeIds.delete(edge.id);
    const teardown = this.audioInputBridgeTeardowns.get(edge.id);
    if (teardown) {
      try { teardown(); } catch { /* */ }
      this.audioInputBridgeTeardowns.delete(edge.id);
    }
  }

  /**
   * Establish a SAME-DOMAIN video → video CV/gate bridge (DOOM.evt_kill →
   * SCOREBOARD.score, etc.). The source video module publishes the gate as
   * an AudioNode via its audioSources map; the target video module declares
   * the input as a CV port whose paramTarget routes through setParam. We
   * insert an AnalyserNode between them (audioCtx-owned) and re-use the
   * VideoEngine's own addCvBridge facility to sample one value per frame
   * into the target's setParam — the same path audio→video CV uses.
   *
   * Why this lives in the cross-domain PatchEngine rather than VideoEngine:
   * the analyser needs the AudioContext (owned by AudioEngine), and the
   * source AudioNode resolution goes through the same `getAudioSource`
   * lookup audio→video uses. Keeping the wiring here means VideoEngine
   * stays AudioContext-agnostic.
   *
   * Failure modes (mirror addCrossDomainCvBridge):
   *  - source AudioNode not yet materialized: mark id so removeEdge knows
   *    to skip the placeholder; subsequent reconciles will re-call addEdge.
   *  - VideoEngine lacks getAudioSource or addCvBridge: fall through to
   *    standard same-domain dispatch (the edge sits in VideoEngine.edges
   *    and does nothing for CV — back-compat for older tests).
   *  - No AudioContext present: skip — without an audio context there's no
   *    analyser, and the test scenarios that lack one don't exercise CV
   *    bridges anyway.
   */
  private addSameDomainVideoCvBridge(edge: Edge): void {
    const videoEngine = this.domains.get('video');
    const audioEngine = this.domains.get('audio') as AudioEngine | undefined;
    if (!videoEngine) return;
    const ve = videoEngine as DomainEngine & {
      getAudioSource?: (nodeId: string, portId: string) =>
        | { node: AudioNode; output: number } | null;
      getNodeHandle?: (nodeId: string) => unknown;
      resolveTargetParamId?: (nodeId: string, portId: string) => string;
      addCvBridge?: (
        edgeId: string,
        analyser: AnalyserNode,
        targetNodeId: string,
        targetParamId: string,
        teardown: () => void,
      ) => void;
    };
    if (
      typeof ve.getAudioSource !== 'function'
      || typeof ve.addCvBridge !== 'function'
      || !audioEngine
    ) {
      // No bridge facility available — fall back to plain video addEdge.
      videoEngine.addEdge(edge);
      return;
    }
    const src = ve.getAudioSource(edge.source.nodeId, edge.source.portId);
    if (!src) {
      // Source AudioNode not yet materialized. Park in pendingBridges; a
      // later addNode / onAudioSourcesChanged drains. Do NOT mark
      // sameDomainVideoCvBridgeEdgeIds — that's the happy-path "owned"
      // set; pre-fix, the reconciler saw it as applied + never retried.
      this.pendingBridges.set(edge.id, { edge, kind: 'same-domain-video-cv' });
      return;
    }
    const analyser = audioEngine.ctx.createAnalyser();
    analyser.fftSize = 32;
    analyser.smoothingTimeConstant = 0;
    src.node.connect(analyser, src.output);
    const teardown = () => {
      try { src.node.disconnect(analyser, src.output); } catch { /* */ }
      try { analyser.disconnect(); } catch { /* */ }
    };
    ve.addCvBridge!(edge.id, analyser, edge.target.nodeId, edge.target.portId, teardown);
    this.sameDomainVideoCvBridgeEdgeIds.add(edge.id);
    this.pendingBridges.delete(edge.id);

    // Frame-independent gate dispatch (the failure-2 fix). The analyser tap
    // above samples the CSN at the video frame rate — at 60fps that's a
    // 16ms window per sample, but a `pulseGate` excursion is 10ms wide so
    // the analyser CAN miss it (and reliably does on CI's slower scheduling
    // → e2e #6 failure). When the source declares a `subscribePulse` for
    // this port (DOOM's `evt_*` gates), we ALSO subscribe and dispatch a
    // discrete setParam(target, 1) → setParam(target, 0) pair into the
    // destination's gateEdge detector on every pulse. The analyser stays
    // wired so cv-shaped sources (no `subscribePulse`) still flow through.
    if (edge.sourceType === 'gate') {
      const srcHandle = (typeof ve.getNodeHandle === 'function'
        ? ve.getNodeHandle(edge.source.nodeId)
        : undefined) as
        | { subscribePulse?: (portId: string, cb: () => void) => () => void }
        | undefined;
      const dstHandle = (typeof ve.getNodeHandle === 'function'
        ? ve.getNodeHandle(edge.target.nodeId)
        : undefined) as
        | { setParam?: (paramId: string, value: number) => void }
        | undefined;
      if (
        srcHandle
        && typeof srcHandle.subscribePulse === 'function'
        && dstHandle
        && typeof dstHandle.setParam === 'function'
        && typeof ve.resolveTargetParamId === 'function'
      ) {
        // Resolve the destination port → paramTarget so this code path
        // matches what addCvBridge does internally (e.g. SCOREBOARD port
        // `score` → paramTarget `scoreTrig`).
        const targetParamId = ve.resolveTargetParamId(edge.target.nodeId, edge.target.portId);
        let pendingFallTimer: ReturnType<typeof setTimeout> | null = null;
        const dispatchEdge = (): void => {
          try { dstHandle.setParam!(targetParamId, 1); } catch { /* */ }
          // Schedule the fall so the gateEdge detector resets to LOW before
          // the next pulse. setTimeout(0) is sufficient — the gateEdge check
          // is purely sample-by-sample (no rate dependency), and we want the
          // fall to land AFTER any synchronous downstream readers see the 1.
          if (pendingFallTimer !== null) clearTimeout(pendingFallTimer);
          pendingFallTimer = setTimeout(() => {
            pendingFallTimer = null;
            try { dstHandle.setParam!(targetParamId, 0); } catch { /* */ }
          }, 0);
        };
        const unsub = srcHandle.subscribePulse!(edge.source.portId, dispatchEdge);
        this.sameDomainPulseSubTeardowns.set(edge.id, () => {
          try { unsub(); } catch { /* */ }
          if (pendingFallTimer !== null) {
            clearTimeout(pendingFallTimer);
            pendingFallTimer = null;
          }
        });
      }
    }
  }

  private removeSameDomainVideoCvBridge(edge: Edge): void {
    this.sameDomainVideoCvBridgeEdgeIds.delete(edge.id);
    const sub = this.sameDomainPulseSubTeardowns.get(edge.id);
    if (sub) {
      try { sub(); } catch { /* */ }
      this.sameDomainPulseSubTeardowns.delete(edge.id);
    }
    const videoEngine = this.domains.get('video');
    if (!videoEngine) return;
    const ve = videoEngine as DomainEngine & { removeCvBridge?: (id: string) => void };
    if (typeof ve.removeCvBridge === 'function') ve.removeCvBridge!(edge.id);
  }

  setParam(node: ModuleNode, paramId: string, value: number): void {
    const engine = this.getDomain(node.domain);
    engine.setParam(node.id, paramId, value);
  }

  /**
   * Schedule a param write at a future audio time (clip-automation playback).
   * Delegates to the target domain's `scheduleParam` when implemented (only
   * AudioEngine today); a no-op otherwise. Transient — never writes the Y.Doc.
   */
  scheduleParam(
    node: ModuleNode,
    paramId: string,
    value: number,
    atTime: number,
    ramp: boolean,
  ): void {
    const engine = this.getDomain(node.domain);
    engine.scheduleParam?.(node.id, paramId, value, atTime, ramp);
  }

  /**
   * CANCEL-AND-HOLD a param at a seam (clip-automation param-jump policy).
   * Truncates the scheduled ramp tail at `atTime` and optionally glides to a
   * deterministic `toValue`. Delegates to the target domain's `holdParam` (only
   * AudioEngine today); a no-op otherwise. Transient — never writes the Y.Doc.
   */
  holdParam(
    node: ModuleNode,
    paramId: string,
    atTime: number,
    toValue?: number,
    glideS?: number,
  ): void {
    const engine = this.getDomain(node.domain);
    engine.holdParam?.(node.id, paramId, atTime, toValue, glideS);
  }

  /** DISPLAY-ONLY knob-value refresh (automation visual smoothing) — delegates to
   *  the target domain's `setDisplayParam`; a no-op otherwise. No DSP, no Y.Doc. */
  setDisplayParam(node: ModuleNode, paramId: string, value: number): void {
    const engine = this.getDomain(node.domain);
    engine.setDisplayParam?.(node.id, paramId, value);
  }

  /** Gate inputs whose port declared no paramTarget — warned once each so a
   *  MIDI-assigned NOTE on an un-routable gate input emits a single dev hint
   *  (UI surfaces "this input needs a cable") rather than spamming. */
  private warnedGateInputs = new Set<string>();

  /**
   * Resolve a (node, gate INPUT port) → its target AudioParam id, across all
   * registered domain engines. Returns null when no engine knows the node, or
   * the port declares no paramTarget (a pure AudioNode gate input — a
   * ConstantSourceNode injection node is a FOLLOW-UP). The same resolution a
   * same-domain gate EDGE uses, so a MIDI-assigned NOTE drives the identical param.
   */
  private resolveGateTarget(nodeId: string, portId: string): { engine: DomainEngine; paramId: string } | null {
    for (const engine of this.domains.values()) {
      const e = engine as DomainEngine & {
        resolvePortParamTarget?: (nodeId: string, portId: string) => string | null;
        resolveTargetParamId?: (nodeId: string, portId: string) => string;
      };
      // AudioEngine: resolvePortParamTarget (null when no paramTarget / unknown).
      if (typeof e.resolvePortParamTarget === 'function') {
        const p = e.resolvePortParamTarget(nodeId, portId);
        if (p) return { engine, paramId: p };
      }
      // VideoEngine (DOOM etc.): resolveTargetParamId echoes the portId when it
      // can't resolve, so only accept a DIFFERENT, truthy id (a real mapping).
      else if (typeof e.resolveTargetParamId === 'function') {
        try {
          const p = e.resolveTargetParamId(nodeId, portId);
          if (p && p !== portId) return { engine, paramId: p };
        } catch { /* engine doesn't own this node */ }
      }
    }
    return null;
  }

  /**
   * Drive a gate/trigger INPUT port HIGH (high=true) or LOW (high=false) by
   * resolving the port's paramTarget and calling setParam(target, high?1:0) on
   * the owning engine — REUSING the exact same-domain gate-edge mechanism. A
   * MIDI NOTE-on → setGateInput(...,true); NOTE-off → setGateInput(...,false).
   * No-op (warn-once) when the port has no paramTarget. Returns true when it
   * drove a param.
   */
  setGateInput(nodeId: string, portId: string, high: boolean): boolean {
    const resolved = this.resolveGateTarget(nodeId, portId);
    if (!resolved) {
      const key = `${nodeId}:${portId}`;
      if (!this.warnedGateInputs.has(key)) {
        this.warnedGateInputs.add(key);
        // eslint-disable-next-line no-console
        console.warn(
          `[midi] gate input ${key} has no paramTarget — MIDI assign is a no-op (this input needs a cable).`,
        );
      }
      return false;
    }
    try { resolved.engine.setParam(nodeId, resolved.paramId, high ? 1 : 0); } catch { /* */ }
    return true;
  }

  /**
   * Pulse a TRIGGER input: setParam(target, 1) then setParam(target, 0) on the
   * next tick — the EXACT pulse shape the same-domain gate-edge dispatch uses so
   * a trigger detector resets to LOW before the next pulse. Used for momentary
   * NOTE → trigger when the caller wants a one-shot rather than a held gate.
   * No-op (warn-once) when the port has no paramTarget.
   */
  pulseGateInput(nodeId: string, portId: string): boolean {
    const resolved = this.resolveGateTarget(nodeId, portId);
    if (!resolved) {
      const key = `${nodeId}:${portId}`;
      if (!this.warnedGateInputs.has(key)) {
        this.warnedGateInputs.add(key);
        // eslint-disable-next-line no-console
        console.warn(
          `[midi] gate input ${key} has no paramTarget — MIDI assign is a no-op (this input needs a cable).`,
        );
      }
      return false;
    }
    try { resolved.engine.setParam(nodeId, resolved.paramId, 1); } catch { /* */ }
    setTimeout(() => {
      try { resolved.engine.setParam(nodeId, resolved.paramId, 0); } catch { /* */ }
    }, 0);
    return true;
  }

  readParam(node: ModuleNode, paramId: string): number | undefined {
    return this.getDomain(node.domain).readParam(node.id, paramId);
  }

  /** Most-recent sample at a per-port modulator-tap analyser. Returns 0
   *  when no edge is connected to that port (or the domain doesn't
   *  implement taps). Card visualizers use this to read CV signals on
   *  ports whose id differs from the AudioParam id (e.g. a `rate_cv`
   *  port targeting a `rate` AudioParam). */
  readModulatorTap(nodeId: string, portId: string, domain: string = 'audio'): number {
    const dom = this.domains.get(domain);
    return dom?.readModulatorTap?.(nodeId, portId) ?? 0;
  }

  read(node: ModuleNode, key: string): unknown {
    return this.getDomain(node.domain).read(node.id, key);
  }

  /** Push card-computed data into a node (inverse of `read`). No-ops if the
   *  domain engine / handle doesn't implement `write`. */
  write(node: ModuleNode, key: string, value: unknown): void {
    this.getDomain(node.domain).write?.(node.id, key, value);
  }

  dispose(): void {
    this.pendingBridges.clear();
    this.cvBridgeEdgeIds.clear();
    this.videoTextureBridgeEdgeIds.clear();
    this.audioBridgeEdgeIds.clear();
    this.sameDomainVideoCvBridgeEdgeIds.clear();
    for (const teardown of this.audioBridgeTeardowns.values()) {
      try { teardown(); } catch { /* */ }
    }
    this.audioBridgeTeardowns.clear();
    this.audioBridgeEdges.clear();
    this.audioInputBridgeEdgeIds.clear();
    for (const teardown of this.audioInputBridgeTeardowns.values()) {
      try { teardown(); } catch { /* */ }
    }
    this.audioInputBridgeTeardowns.clear();
    for (const teardown of this.sameDomainPulseSubTeardowns.values()) {
      try { teardown(); } catch { /* */ }
    }
    this.sameDomainPulseSubTeardowns.clear();
    for (const e of this.domains.values()) e.dispose();
    this.domains.clear();
  }
}
