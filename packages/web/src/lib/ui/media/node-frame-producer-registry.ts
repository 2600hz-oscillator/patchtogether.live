// packages/web/src/lib/ui/media/node-frame-producer-registry.ts
//
// THE PER-FRAME PRODUCER SEAM — the node-lifetime owner of the rAF loops that
// push a module's own engine-visible state, taken off the cards that ran them.
//
// ── WHAT THIS REPLACES, AND WHY IT IS NOT THE EXTRAS REGISTRY ────────────────
// `./node-extras-registry` (#1720) owns producers that push ONCE from persisted
// `node.data`: a replayed op log, a rasterized text model, a decoded image. Its
// header argues — correctly, at the time — that WAVESCULPT, TIMELORDE and
// SYNESTHESIA are the OTHER shape and belong in `CARD_PRODUCER_LANE_TYPES`,
// because "their picture comes from a rAF loop that only exists on the card —
// there is nothing else that could draw it".
//
// ⚠ THAT LAST CLAUSE IS THE PART THAT WAS NEVER TRUE OF THE MECHANISM, only of
// the tree. A rAF loop reading the engine and writing back to the engine has no
// card-shaped dependency in it at all; it lived on a card because that is where
// it was written. This registry is the "something else that could drive it", and
// it is the same answer the extras seam reached — an owner whose lifetime IS the
// graph — applied to a LIVE producer rather than a one-shot one.
//
// The COST argument in that header still stands and is why this is a registry
// rather than a widening of `CARD_PRODUCER_LANE_TYPES`: a member of that set
// buys a PERMANENT off-screen mount of the whole card — every control, every
// PatchPanel, an entire single-node <SvelteFlow> — on every rack that contains
// one. What a producer actually needs is its loop.
//
// ── ONE TICKER, MANY NODES (the meter-frame argument, without the gate) ──────
// Every card here ran its own `requestAnimationFrame` (SYNESTHESIA, TIMELORDE)
// or its own `onMeterFrame` subscription (SCOPE). The shared ticker collapses
// them to ONE rAF callback that visits each live producer node once per frame —
// the same coalescing `$lib/ui/meter-frame` performs for card repaints, and for
// the same measured reason (~60 independent rAF callbacks starve the audio
// render thread; see that file's header).
//
// ⚠ AND DELIBERATELY WITHOUT ITS INTERSECTIONOBSERVER GATE. `onMeterFrame`
// skips a subscriber whose ELEMENT is off-screen, which is exactly right for a
// repaint and exactly wrong here: these pushes are what the module's own
// `drawFrame` renders `video_out` from, so gating them on a surface being
// visible would make a scrolled-away tile stop feeding a downstream chain — the
// #1587 failure re-introduced through the back door. A producer runs while its
// NODE exists. Visibility is a VIEW fact.
//
// ── STRUCTURAL GUARD ────────────────────────────────────────────────────────
// There is NO teardown a card can call. `sweep` and `disposeNode` are the only
// teardowns and both are keyed to the GRAPH, swept from Canvas against the live
// node set — the same guard `node-media-registry` and `node-extras-registry`
// get, so `tsc` refuses the wrong call before any test runs.
//
// ── TESTABILITY ─────────────────────────────────────────────────────────────
// The web package's vitest runs in `environment: 'node'`, so every DOM edge is
// an INJECTED op (`NodeFrameProducerOps`) and every engine edge is a structural
// interface. This file is the PURE core; `./node-frame-producers.ts` is the
// real-DOM singleton Canvas drives, and `./frame-producers.ts` holds the
// per-module producers.
//
// HASH TRANSPARENCY — this lives under `lib/ui/media/**` for the reason
// `node-extras-registry` records: `lib/video/**` is hashed WHOLESALE for the
// WebGL attest and any `.svelte` under `lib/ui/modules` that creates a WebGL
// context is enrolled by name. Nothing here does either, so this seam costs no
// GPU re-attest. Import the pure helpers; never reach into `lib/video/**`.

import type { ModuleNode } from '$lib/graph/types';

/** The 2D-canvas scratch a producer composites into. Structural, not
 *  `HTMLCanvasElement`/`OffscreenCanvas`, so the node-env unit tests can hand in
 *  a fake — the same seam `ExtrasSurface` uses. */
export interface FrameSurface {
  width: number;
  height: number;
  getContext(id: '2d', opts?: unknown): unknown;
}

/**
 * The engine seam a per-frame producer needs.
 *
 * ⚠ `write` IS ON THE INTERFACE AND `read`/`readParam` ARE TOO, which is what
 * separates this from `ExtrasEngine`. An extras producer is a pure function of
 * `node.data` and only ever pushes; these read the engine's own live state —
 * the CV taps, an analyser snapshot, an upstream module's frame — and push a
 * derivation of it back. That round trip is the reason the loop has to run at
 * frame rate rather than on a data change.
 */
export interface FrameProducerEngine {
  /** `PatchEngine.read(node, key)`. */
  read(node: ModuleNode, key: string): unknown;
  /** `PatchEngine.readParam(node, paramId)` — the knob PLUS the engine's own
   *  per-port CV tap (the COMBINED value). */
  readParam(node: ModuleNode, paramId: string): number | undefined;
  /** `PatchEngine.write(node, key, value)`. */
  write(node: ModuleNode, key: string, value: unknown): void;
  /**
   * Render a VIDEO-domain node's output into the video engine's shared drawing
   * buffer and hand that buffer back as something drawable, or null.
   *
   * Structural on purpose: the real implementation is
   * `VideoEngine.blitOutputToDrawingBuffer(id)` followed by `videoEngine.canvas`,
   * two calls that are only ever useful together and that no producer should
   * have to sequence correctly on its own.
   */
  blitVideoNode(nodeId: string): unknown | null;
  /**
   * An AUDIO-domain module's mono-video source for `(nodeId, portId)` — the
   * `drawFrame(canvas)` seam. Null when the port is not a video source.
   */
  videoSource(nodeId: string, portId: string): { drawFrame?: (c: unknown) => void } | null;
}

/** The GRAPH reads a producer needs. Injected so the core stays free of the
 *  SyncedStore proxy (and so a test can wire an edge without a Y.Doc). */
export interface FrameGraph {
  /** The `(nodeId, portId)` currently patched INTO `(targetNodeId, targetPortId)`,
   *  or null. */
  findSource(
    targetNodeId: string,
    targetPortId: string,
  ): { nodeId: string; portId: string } | null;
  /** A live node by id — the SOURCE node, whose `domain` decides which of the
   *  two video paths above applies. */
  node(nodeId: string): ModuleNode | undefined;
}

/** Host-environment facts a producer needs and cannot compute. */
export interface FrameEnv {
  /**
   * `prefers-reduced-motion: reduce` — the VRT capture sets it, and TIMELORDE's
   * producer paints ONE deterministic frame under it instead of animating.
   * A FUNCTION, not a boolean: the media query can flip inside a session and a
   * captured value would pin whichever arm happened to be true at boot.
   */
  prefersReducedMotion(): boolean;
  /** `createImageBitmap`, or null where the runtime has none. */
  createImageBitmap: ((src: unknown) => Promise<unknown>) | null;
  /** Load an image asset by URL, resolving only once it is DECODED (not merely
   *  loaded — see `TimelordeCard`'s note on the difference and what it cost the
   *  VRT lane). Resolves null when the runtime cannot load images. */
  loadImage(url: string): Promise<FrameImage | null>;
}

/** A decoded image asset. Structural so the node-env tests can fake one. */
export interface FrameImage {
  readonly width: number;
  readonly height: number;
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
}

/** What a producer is handed on every frame. */
export interface FrameCtx {
  readonly node: ModuleNode;
  readonly engine: FrameProducerEngine;
  readonly graph: FrameGraph;
  readonly env: FrameEnv;
  /**
   * Per-NODE scratch the producer owns for the node's whole lifetime.
   *
   * ⚠ IT IS THE ONLY PLACE PER-NODE STATE MAY LIVE. A `let` in the producer
   * module would be shared by every node of that type, which is the bug the
   * card version could not have (one component instance per node) and the one
   * this shape is most likely to introduce.
   */
  readonly state: Record<string, unknown>;
  /** The node-lifetime compositing surface at `w × h`, minted on first use and
   *  RESIZED in place if a later call asks for a different size. Null where the
   *  runtime has no canvas at all. */
  surface(w: number, h: number): FrameSurface | null;
}

/**
 * A node-lifetime per-frame producer for ONE module type.
 *
 * `why` is REQUIRED BY THE TYPE, so a producer cannot be added without the one
 * thing a reviewer of a future addition actually needs — the same discipline
 * `ExtrasProducer.why` and `ProducerSeam.why` enforce.
 */
export interface FrameProducer {
  /** The module type id. */
  readonly type: string;
  /** Why this module's per-frame push belongs to the NODE rather than a card. */
  readonly why: string;
  /**
   * Push this node's engine state for this frame.
   *
   * MUST NOT THROW — the registry catches and records, because one producer
   * throwing must not stop the shared ticker for every other node. A thrown
   * error is a defect and shows up in `snapshot()`; it is not a control flow.
   */
  frame(ctx: FrameCtx): void;
  /** Release anything the producer minted into `state`. The registry always
   *  drops the scratch and the surface itself. */
  dispose?(state: Record<string, unknown>): void;
}

/** Inspection row for the unit tests and the e2e probe.
 *
 *  ⚠ `frames` IS THE LIVENESS PROBE, and it exists because of a measured
 *  failure in the sibling seam: the archivist extraction shipped a re-attach
 *  loop where EVERY assertion about search, item, graph and element `src` was
 *  green while the media made no progress at all. The only thing that could see
 *  it was a leg measuring PROGRESS. A monotonically advancing counter per node
 *  is the cheap version of that, and it is asserted alongside — never instead
 *  of — a picture that moves. */
export interface NodeFrameProducerRow {
  nodeId: string;
  type: string;
  /** Frames this node's producer has completed since it entered the graph. */
  frames: number;
  /** The last error message the producer threw, or null. */
  lastError: string | null;
  /** Does this node hold a compositing surface? */
  hasSurface: boolean;
}

/** DOM/host operations, injected so the core unit-tests under `environment:
 *  'node'`. */
export interface NodeFrameProducerOps {
  /** Mint a compositing surface. Called at most once per node; the registry
   *  resizes it in place afterwards. Null where there is no canvas. */
  createSurface(nodeId: string, type: string, w: number, h: number): FrameSurface | null;
  /**
   * Start the ONE shared frame ticker; returns its stopper. Called when the
   * first producer node appears and stopped when the last one leaves, so a rack
   * with no producers costs nothing at all.
   */
  startTicker(tick: () => void): () => void;
  /** The host facts producers read. */
  env: FrameEnv;
}

export interface NodeFrameProducerRegistry {
  /**
   * Reconcile against the live graph. Idempotent — Canvas calls it from a
   * `$effect` on the graph snapshot, so it runs on every graph change and must
   * be cheap when nothing moved.
   *
   * The ENGINE is passed rather than imported for the reason `nodeExtras` and
   * `nodeVideoSource` record: this file must stay hash-transparent to the WebGL
   * attest, so it reaches the engine only through the structural seam above.
   */
  sync(nodes: readonly ModuleNode[], engine: FrameProducerEngine | null): void;
  /** Dispose every node NOT in `liveIds`. The graph is the authority. */
  sweep(liveIds: Iterable<string>): void;
  /** Full teardown for ONE node. Called when the node leaves the GRAPH, never
   *  when a card unmounts. */
  disposeNode(nodeId: string): void;
  /** Is this node currently owned by the registry? */
  has(nodeId: string): boolean;
  /** Inspection for the unit tests and the e2e probe. */
  snapshot(): NodeFrameProducerRow[];
  /** Run ONE frame for every live node, synchronously. The ticker calls this;
   *  tests call it directly instead of faking rAF. */
  tick(): void;
}

/**
 * The module TYPES this seam owns — DERIVED from the producer list, never typed
 * twice.
 *
 * ⚠ IT IS ALSO THE OTHER HALF OF AN ATOMICITY GATE. `dom-source-modules.test.ts`
 * asserts that a type in `CARD_PRODUCER_LANE_TYPES` is NOT in any node-owner
 * set, so a module cannot leave the card seam without an owner taking it and
 * cannot be owned twice. Exporting the derivation rather than a literal is what
 * makes that check read the tree instead of a list.
 */
export function frameProducerTypes(producers: readonly FrameProducer[]): ReadonlySet<string> {
  return new Set(producers.map((p) => p.type));
}

interface Entry {
  type: string;
  producer: FrameProducer;
  node: ModuleNode;
  state: Record<string, unknown>;
  surface: FrameSurface | null;
  frames: number;
  lastError: string | null;
}

/** Build a registry over injected ops. See the header for the invariants. */
export function createNodeFrameProducerRegistry(
  producers: readonly FrameProducer[],
  ops: NodeFrameProducerOps,
  graph: FrameGraph,
): NodeFrameProducerRegistry {
  const byType = new Map<string, FrameProducer>();
  for (const p of producers) {
    if (byType.has(p.type)) {
      throw new Error(`[node-frame-producer] two producers claim type "${p.type}"`);
    }
    byType.set(p.type, p);
  }

  const entries = new Map<string, Entry>();
  let engine: FrameProducerEngine | null = null;
  let stopTicker: (() => void) | null = null;

  function ensureTicker(): void {
    if (stopTicker || entries.size === 0) return;
    stopTicker = ops.startTicker(() => registry.tick());
  }

  function maybeStopTicker(): void {
    if (!stopTicker || entries.size > 0) return;
    stopTicker();
    stopTicker = null;
  }

  function makeCtx(entry: Entry): FrameCtx {
    return {
      node: entry.node,
      engine: engine!,
      graph,
      env: ops.env,
      state: entry.state,
      surface(w, h) {
        if (!entry.surface) {
          entry.surface = ops.createSurface(entry.node.id, entry.type, w, h);
        }
        const s = entry.surface;
        if (s && (s.width !== w || s.height !== h)) {
          s.width = w;
          s.height = h;
        }
        return s;
      },
    };
  }

  const registry: NodeFrameProducerRegistry = {
    sync(nodes, nextEngine) {
      engine = nextEngine;
      for (const node of nodes) {
        const producer = byType.get(node.type);
        if (!producer) continue;
        const existing = entries.get(node.id);
        if (existing) {
          // ⚠ RE-SEAT THE NODE EVERY SYNC. The snapshot hands out a NEW object
          // per graph change and the producers read `node.params` imperatively
          // inside the frame; holding the first one would freeze every producer
          // at the params the node had when it appeared. (The identity-stale
          // proxy class — see `yjs-proxy-stable-identity-defeats-derived`.)
          existing.node = node;
          continue;
        }
        entries.set(node.id, {
          type: node.type,
          producer,
          node,
          state: {},
          surface: null,
          frames: 0,
          lastError: null,
        });
      }
      ensureTicker();
    },

    tick() {
      if (!engine) return;
      for (const entry of entries.values()) {
        try {
          entry.producer.frame(makeCtx(entry));
          entry.frames++;
          entry.lastError = null;
        } catch (err) {
          // One producer must never stop the ticker for the others.
          entry.lastError = err instanceof Error ? err.message : String(err);
        }
      }
    },

    sweep(liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
      for (const id of [...entries.keys()]) {
        if (!live.has(id)) registry.disposeNode(id);
      }
    },

    disposeNode(nodeId) {
      const entry = entries.get(nodeId);
      if (!entry) return;
      entries.delete(nodeId);
      try {
        entry.producer.dispose?.(entry.state);
      } catch {
        /* a failed teardown must not strand the sweep */
      }
      entry.surface = null;
      maybeStopTicker();
    },

    has(nodeId) {
      return entries.has(nodeId);
    },

    snapshot() {
      return [...entries.values()].map((e) => ({
        nodeId: e.node.id,
        type: e.type,
        frames: e.frames,
        lastError: e.lastError,
        hasSurface: e.surface !== null,
      }));
    },
  };

  return registry;
}
