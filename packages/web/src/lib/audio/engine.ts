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
import { getModuleDef } from './module-registry';

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

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
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
    if (din.param) {
      // CV → AudioParam routing
      sout.node.connect(din.param, sout.output);
      this.edges.set(edge.id, () => sout.node.disconnect(din.param!, sout.output));
    } else {
      sout.node.connect(din.node, sout.output, din.input);
      this.edges.set(edge.id, () => sout.node.disconnect(din.node, sout.output, din.input));
    }
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

  /** Read the live AudioParam value for motorized fader rendering. */
  readParam(nodeId: string, paramId: string): number | undefined {
    return this.nodes.get(nodeId)?.readParam(paramId);
  }

  /** Read arbitrary per-module data (e.g., scope buffer). */
  read(nodeId: string, key: string): unknown {
    const handle = this.nodes.get(nodeId);
    return handle?.read ? handle.read(key) : undefined;
  }

  dispose(): void {
    for (const undo of this.edges.values()) undo();
    this.edges.clear();
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
