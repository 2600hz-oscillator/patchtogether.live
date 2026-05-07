// packages/web/src/lib/audio/engine.ts
//
// Engine architecture per D18 — domain-pluggable. Phase 1 ships with one
// domain implementation: AudioEngine. The PatchEngine is the reconciler that
// dispatches PatchGraph mutations to per-domain engines.
//
// Day 6 scope: imperative API (addNode/removeNode/addEdge/removeEdge) so the
// caller can drive the engine directly. The auto-reactive flavor that watches
// the SyncedStore graph and reconciles automatically lands in Day 7.

import type { Edge, ModuleDef, ModuleNode } from '$lib/graph/types';
import { getModuleDef, type AudioModuleDef } from './module-registry';
import { POLY_CHANNELS, resolveConnection } from './poly';

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
  }

  removeNode(nodeId: string): void {
    const handle = this.nodes.get(nodeId);
    if (!handle) return;
    // Caller (PatchEngine / reconciler) is expected to call removeEdge for
    // every edge touching this node before removeNode. handle.dispose()
    // disconnects all of this node's Web Audio connections defensively.
    handle.dispose();
    this.nodes.delete(nodeId);
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
      sout.node.connect(din.param, sout.output);
      // Also tee the source through a per-param AnalyserNode so readParam can
      // report intrinsic + modulator sample for motorized fader rendering.
      const tap = this.getOrCreateParamTap(edge.target.nodeId, edge.target.portId);
      sout.node.connect(tap, sout.output);
      const tapKey = this.paramTapKey(edge.target.nodeId, edge.target.portId);
      this.paramTapEdges.set(edge.id, { tapKey, src: sout.node, output: sout.output });
      this.edges.set(edge.id, () => {
        sout.node.disconnect(din.param!, sout.output);
        const bk = this.paramTapEdges.get(edge.id);
        if (bk) {
          const t = this.paramTaps.get(bk.tapKey);
          if (t) {
            try { bk.src.disconnect(t, bk.output); } catch { /* may have been torn down */ }
          }
          this.paramTapEdges.delete(edge.id);
        }
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

  /** Read arbitrary per-module data (e.g., scope buffer). */
  read(nodeId: string, key: string): unknown {
    const handle = this.nodes.get(nodeId);
    return handle?.read ? handle.read(key) : undefined;
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
  }
}

// ---------------- PatchEngine: dispatcher across domains ----------------

export class PatchEngine {
  private domains = new Map<string, DomainEngine>();

  registerDomain(engine: DomainEngine): void {
    this.domains.set(engine.domain, engine);
  }

  getDomain<T extends DomainEngine>(domain: string): T {
    const e = this.domains.get(domain);
    if (!e) throw new Error(`PatchEngine: no engine registered for domain '${domain}'`);
    return e as T;
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
   * Add an edge. We dispatch by source node's domain. Cross-domain edges
   * (e.g., audio CV → video param) are a future concern; for Phase 1 every
   * edge is audio↔audio.
   */
  addEdge(edge: Edge, sourceDomain: string): void {
    const engine = this.getDomain(sourceDomain);
    engine.addEdge(edge);
  }

  removeEdge(edge: Edge, sourceDomain: string): void {
    const engine = this.getDomain(sourceDomain);
    engine.removeEdge(edge.id);
  }

  setParam(node: ModuleNode, paramId: string, value: number): void {
    const engine = this.getDomain(node.domain);
    engine.setParam(node.id, paramId, value);
  }

  readParam(node: ModuleNode, paramId: string): number | undefined {
    return this.getDomain(node.domain).readParam(node.id, paramId);
  }

  read(node: ModuleNode, key: string): unknown {
    return this.getDomain(node.domain).read(node.id, key);
  }

  dispose(): void {
    for (const e of this.domains.values()) e.dispose();
    this.domains.clear();
  }
}
