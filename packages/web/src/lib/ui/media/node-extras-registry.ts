// packages/web/src/lib/ui/media/node-extras-registry.ts
//
// THE EXTRAS-CHANNEL PRODUCER SEAM — the node-lifetime owner of everything a
// card used to push through `engine.read(id, 'extras')`.
//
// ── THE BUG, MEASURED (#1720, the #1583 family) ──────────────────────────────
// Under the faceplate shell an UN-MIGRATED module renders a uniform tile in its
// lane; its real card exists only while the dock full-view is open. For PAINTER,
// TEXTMARQUEE and PICTUREBOX the card was the ONLY writer of the node's picture,
// so a saved rack rendered each module's BUILT-IN PLACEHOLDER on load, before the
// user touched anything. Not a collapse bug — the DEFAULT state.
//
// Measured on the default `/rack` (nothing expanded, nothing clicked, no
// collapse), reading each node's own output FBO texture with the persisted
// content already in `node.data`:
//
//   module       card NEVER mounted            card mounted in the dock
//   painter      meanRGB (255,255,255)         (255,0,0)      ← the saved drawing
//   textmarquee  (2,2,2)  nonBlack 446/49152   (158,34,0) nonBlack 36992/49152
//   picturebox   (5,15,20)                     (0,0,254)      ← the loaded image
//
// i.e. a blank white page instead of your painting, the literal word
// "textmarquee" instead of your text, and the idle field instead of your image.
// Severity is render-dark, not data loss: all three persist their content, and
// expanding the card repaired the picture — which is exactly why it survived.
// It looks fine whenever you are looking at it.
//
// A SECOND, independent defect on the same channel: PICTUREBOX's ASSET GATE /
// ASSET PITCH cv inputs were polled by a 33 ms interval that lived on the CARD,
// so with no card the two jacks were patched, visibly connected, and inert —
// and the displayed slot LATCHED at its last selection rather than going dark.
// A fix that only restores the texture does not fix that; the poll is a pump and
// it belongs to the node too.
//
// ── WHY A REGISTRY AND NOT `CARD_PRODUCER_LANE_TYPES` ────────────────────────
// The sibling fix for the OTHER producer seam (#1587: wavesculpt / timelorde /
// synesthesia) keeps the real card alive off-screen in <HeadlessSourceHost>.
// That is right for THOSE modules, because their picture comes from a rAF loop
// that only exists on the card — there is nothing else that could draw it.
//
// It is the wrong answer here, on both cost and mechanism:
//
//   COST — every member of that set gains a PERMANENT off-screen mount on every
//   rack that contains one. The extras channel reaches 13 cards; widening the
//   seam regex would enrol 8 of them, including DOOM (a WASM game) and TOYBOX.
//   Even limited to these three it means a 1024x768 interactive paint canvas, a
//   contenteditable editor plus its preview rAF blit, and a 33 ms interval,
//   mounted forever, per node, in racks nobody has opened.
//
//   MECHANISM — and this is the half that decides it. These three cards are NOT
//   live producers. Each PUSHES ONCE, from persisted graph state, and the node
//   keeps what it was handed:
//     * PainterCard replays the Y.Doc op log `node.data.ops` onto a canvas and
//       binds that canvas ONCE (`setPaintCanvas`);
//     * TextmarqueeCard rasterizes `node.data.richText` and pushes the canvas
//       whenever the MODEL changes — the CRAWL is animated ENGINE-side from
//       `frame.time` (textmarquee.ts `computeDrawOffset`), so its rAF loop is a
//       card-local PREVIEW blit, not a producer. (#1720's filing called this
//       card "a genuine live producer and the one real CARD_PRODUCER_LANE_TYPES
//       candidate of the three". That is not what the code does — TextmarqueeCard
//       `pump()` reads `ve.blitOutputToDrawingBuffer(id)` into its own little
//       preview canvas and writes nothing to the engine.)
//     * PictureboxCard decodes `node.data.imageBytes` / `node.data.assets` and
//       uploads them.
// Every one of those is a pure function of the NODE'S PERSISTED DATA. A thing
// that can be recomputed from graph state does not need a card kept alive to
// remember it — it needs an owner whose lifetime IS the graph. That owner costs
// one detached canvas per painter/textmarquee node and one decode per change,
// which is what the card already paid on mount, and nothing at all per frame.
//
// This is the same reasoning #1742 used to DECLINE a registry (a MIDI setter is
// a pure function of `(live node, param def)`, so it resolved at dispatch time
// and had no lifetime to key) — applied in the other direction. Here there IS a
// resource with a lifetime (an uploaded texture the engine holds), and the
// lifetime is the node's.
//
// ── THE RULE THIS FILE ENCODES ───────────────────────────────────────────────
// The ENGINE-VISIBLE state of a rack must not depend on which UI renders a
// module — the same rule $lib/ui/workflow/dom-source-modules encodes for the
// SOURCE-attachment seam and $lib/ui/media/node-media-registry encodes for the
// media-element seam. Cards ADOPT and READ; they do not CREATE and DESTROY.
//
// STRUCTURAL GUARD: there is NO teardown method a card can call. `sweep` and
// `disposeNode` are the only teardowns and both are keyed to the GRAPH, swept
// from Canvas against the live node set — so `tsc` refuses the wrong call
// before any test runs. That is the same guard node-recorder-registry and
// node-media-registry get, and it is why neither has a `dispose()` a card can
// reach.
//
// ONE WRITER PER CHANNEL. TEXTMARQUEE's and PICTUREBOX's card-side push paths
// were DELETED, not duplicated: this registry is now their only writer, so the
// two cannot disagree. PAINTER is the exception and it is a LEASE, not a second
// writer: its card canvas is the LIVE drawing surface (an in-progress stroke is
// visible on the output before the op commits), so while the card is mounted it
// `claim`s the binding and pushes its own canvas. Both surfaces replay the SAME
// deterministic op log, so the lease changes WHICH canvas is bound and never
// WHAT is on it.
//
// HASH TRANSPARENCY — this lives under `lib/ui/media/**`, deliberately. Both
// `lib/video/**` (whole-dir) and any card that creates a WebGL context are
// hashed for the WebGL attest; these three cards create no GL context and no
// file under `lib/video/**` is touched by this fix, so it costs no GPU
// re-attest. Do not move this file, and do not reach into `lib/video/**` to
// implement a producer — import the pure helpers instead (painter-draw,
// textmarquee-layout, picturebox-encode are all already pure).
//
// TESTABILITY: the web package's vitest runs in `environment: 'node'` (no
// jsdom), so every DOM operation is an INJECTED `ops` object — the same seam
// `createNodeMediaRegistry` uses. `nodeExtras` (bottom of file) is the real-DOM
// singleton Canvas drives; `createNodeExtrasRegistry` is the pure core the unit
// tests drive with fakes.

import type { ModuleNode } from '$lib/graph/types';

/** The 2D-canvas surface a producer draws into. Structural, not `HTMLCanvasElement`,
 *  so the node-env unit tests can hand in a fake. */
export interface ExtrasSurface {
  width: number;
  height: number;
  getContext(id: '2d'): unknown;
}

/** The engine seam a producer needs. Structural for the same reason. */
export interface ExtrasEngine {
  /** `PatchEngine.read(node, key)` — resolves the domain from `node.domain`. */
  read(node: ModuleNode, key: string): unknown;
  /** `PatchEngine.readParam(node, paramId)` — the raw (bridge-written) level. */
  readParam(node: ModuleNode, paramId: string): number | undefined;
}

/** What a producer is handed on every run. */
export interface ProduceCtx {
  readonly node: ModuleNode;
  /**
   * Per-NODE scratch the producer owns for the node's whole lifetime, shared
   * with its `pump`. Its use is not decoration: a producer must be able to tell
   * "this node has never had content" from "this node's content was removed",
   * because the CLEAR call is only correct in the second case.
   *
   * Measured: PICTUREBOX's `setImage(null)` uploads null into the ACTIVE SLOT,
   * so calling it unconditionally on a node that only ever had SLOT assets
   * wiped the slot the gate had just selected — the asset-select round trip
   * failed on its first leg. The card avoided this by accident (its
   * last-applied cache started at `null`, so the `null === null` early-return
   * skipped the clear); here it is explicit.
   */
  readonly state: Record<string, unknown>;
  /** The module handle's `extras` object (never null — the registry defers the
   *  run until the engine has materialized the node). */
  readonly extras: unknown;
  /** The node-lifetime drawing surface, minted on first use and reused for the
   *  life of the NODE. Producers that push no canvas never call it. */
  surface(): ExtrasSurface;
  /** A scratch 2D context for text measurement (shared, never drawn into). */
  measure(): unknown;
}

/** What a PUMP is handed on every tick. */
export interface PumpCtx {
  readonly node: ModuleNode;
  readonly extras: unknown;
  readonly engine: ExtrasEngine;
  /** Per-node scratch, the SAME object `produce` gets (edge state lives here). */
  readonly state: Record<string, unknown>;
}

/**
 * A node-lifetime producer for ONE module type's extras channel.
 *
 * `why` is REQUIRED BY THE TYPE, so a producer cannot be added without the one
 * thing a reviewer of a future addition actually needs — and a `why` that lives
 * only in a commit message is not available at the point of the edit.
 */
export interface ExtrasProducer {
  /** The module type id. */
  readonly type: string;
  /** Why this module's extras push belongs to the NODE rather than the card. */
  readonly why: string;
  /**
   * A stable digest of everything in `node.data` this producer reads. The
   * producer re-runs when it changes — or when the engine hands back a NEW
   * extras object (a re-materialized node), which is tracked by identity and
   * is NOT part of this signature.
   */
  signature(node: ModuleNode): string;
  /** Push the node's persisted data into its extras. May be async (decode). */
  produce(ctx: ProduceCtx): void | Promise<void>;
  /**
   * Optional live consumer of the node's CV INPUTS — a poll that must outlive
   * the card because the ports are dead without it. Runs on ONE shared ticker
   * for every pumped node, never one timer per node.
   */
  pump?(ctx: PumpCtx): void;
}

/** A card's claim on a node's extras binding. `release()` is idempotent AND
 *  owner-checked: it does nothing once another holder has claimed. */
export interface ExtrasLease {
  release(): void;
}

/** Inspection row for the unit tests + the e2e probe. Never a population COUNT
 *  anything asserts on — callers assert PROPERTIES of these rows. */
export interface NodeExtrasSnapshotRow {
  nodeId: string;
  type: string;
  /** Is a CARD currently holding the binding (so the registry stands down)? */
  claimed: boolean;
  /** Has this node's producer pushed successfully at least once? */
  produced: boolean;
  /** The signature of the last successful push, or null. */
  signature: string | null;
  /** Does this node have a live surface? */
  hasSurface: boolean;
}

/** DOM operations, injected so the core unit-tests under `environment: 'node'`. */
export interface NodeExtrasOps {
  /** Mint the node-lifetime surface. Called AT MOST ONCE per node. */
  createSurface(nodeId: string, type: string): ExtrasSurface;
  /** A shared scratch 2D context used only for text measurement. */
  measureContext(): unknown;
  /** Start the shared pump ticker; returns its stopper. */
  startTicker(tick: () => void, intervalMs: number): () => void;
  /** Schedule a readiness retry (the engine has not materialized a node yet). */
  scheduleRetry(fn: () => void, delayMs: number): () => void;
}

export interface NodeExtrasRegistry {
  /**
   * Reconcile against the live graph: for every node whose type has a producer,
   * push its persisted data into the engine when the data (or the engine
   * handle) has changed and no card holds the binding. Idempotent — Canvas
   * calls it from a `$effect` on the graph snapshot, so it runs on every graph
   * change and must be cheap when nothing moved.
   */
  sync(nodes: readonly ModuleNode[], engine: ExtrasEngine | null): void;

  /**
   * A CARD takes over the binding for `nodeId`. Used ONLY where the card's
   * surface is genuinely live and must win while mounted (PAINTER's in-progress
   * stroke). ALWAYS succeeds and TRANSFERS the claim, so mount/unmount ORDER
   * across two component trees cannot strand it — the same reasoning
   * node-media-registry's `adopt` documents.
   */
  claim(nodeId: string, holder: object): ExtrasLease;

  /** Dispose every node NOT in `liveIds`. The graph is the authority. */
  sweep(liveIds: Iterable<string>): void;

  /** Full teardown for ONE node. Called when the node leaves the GRAPH, never
   *  when a card unmounts. */
  disposeNode(nodeId: string): void;

  /** Inspection for tests + the e2e probe. */
  snapshot(): NodeExtrasSnapshotRow[];
}

/** How often the shared CV pump ticker fires. Mirrors the interval the card
 *  used to run (PictureboxCard's asset-gate poll), so gate timing is unchanged
 *  by the move — this is a PRODUCT-side rate, not a test budget. */
export const PUMP_INTERVAL_MS = 33;

/** How long the readiness retry waits between attempts while the engine has not
 *  yet materialized a node, and how many attempts it makes. Both mirror the
 *  per-card retry loops this replaces (50 attempts x 100 ms), so a patch LOAD —
 *  where the node's data arrives before the reconciler has built the engine
 *  node — behaves exactly as it did. */
export const RETRY_DELAY_MS = 100;
export const RETRY_ATTEMPTS = 50;

/**
 * A stable identity for a module handle's `extras`, used to notice that a node
 * was RE-MATERIALIZED (patch load, undo/redo, engine rebuild) — which must
 * re-push even though `node.data` did not change.
 *
 * ⚠ NOT the object's own identity, and that distinction is load-bearing.
 * `read(id, 'extras')` is not required to return the same object twice, and
 * PICTUREBOX does not: `picturebox.ts` builds a FRESH extras literal on every
 * read. An object-identity comparison therefore reads "new handle" every single
 * sync, and the producer re-decodes every base64 asset on every graph change —
 * caught by the "only for the node that moved" unit test below, which is the
 * whole reason that test compares the run LIST and not just a count.
 *
 * The METHODS are stable: they are the factory's own closures, so a fresh
 * literal wrapping them fingerprints identically and a genuinely new handle
 * does not. Cheap — these objects have a handful of keys.
 */
function handleFingerprint(extras: unknown): unknown[] {
  if (!extras || typeof extras !== 'object') return [extras];
  const fns = Object.values(extras as Record<string, unknown>).filter(
    (v) => typeof v === 'function',
  );
  // A methodless extras object has nothing stable to fingerprint, so fall back
  // to OBJECT IDENTITY — correct for a stable handle, and merely conservative
  // (an extra push) for one that is rebuilt per read. Never "always equal",
  // which would suppress a real re-materialization.
  return fns.length > 0 ? fns : [extras];
}

function sameHandle(a: unknown[] | null, b: unknown[]): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Entry {
  type: string;
  producer: ExtrasProducer;
  surface: ExtrasSurface | null;
  /** Fingerprint of the extras handle the last successful push went to — see
   *  `handleFingerprint`. Null until the first successful push. */
  lastExtras: unknown[] | null;
  lastSignature: string | null;
  claimedBy: object | null;
  /** Per-node producer + pump scratch, for the node's whole lifetime. */
  scratch: Record<string, unknown>;
  /** In-flight async produce, so a burst of graph changes cannot interleave two
   *  decodes of the same node and land them out of order. */
  producing: boolean;
  /** The signature that arrived while a produce was in flight, if any. */
  pending: string | null;
}

/** Build a registry over injected ops. See the header for the invariants. */
export function createNodeExtrasRegistry(
  producers: readonly ExtrasProducer[],
  ops: NodeExtrasOps,
): NodeExtrasRegistry {
  const byType = new Map<string, ExtrasProducer>();
  for (const p of producers) byType.set(p.type, p);

  const entries = new Map<string, Entry>();
  /**
   * Claims made for a node the registry has not created an entry for yet.
   *
   * NOT a nicety: `claim` is called from a card's `onMount`, and nothing orders
   * that against the graph effect that creates the entry. Dropping an early
   * claim would leave `claimedBy` null when the entry is finally created, so the
   * registry would push its own replay canvas OVER the live card canvas — which
   * for PAINTER is an in-progress stroke vanishing from the output. Held here
   * until `entryFor` can adopt it.
   */
  const pendingClaims = new Map<string, object>();
  /** The nodes the last `sync` saw, so the pump ticker has something to walk. */
  let liveNodes: readonly ModuleNode[] = [];
  let liveEngine: ExtrasEngine | null = null;

  let stopTicker: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryAttempt = 0;

  function entryFor(node: ModuleNode, producer: ExtrasProducer): Entry {
    const existing = entries.get(node.id);
    if (existing) return existing;
    const created: Entry = {
      type: node.type,
      producer,
      surface: null,
      lastExtras: null,
      lastSignature: null,
      claimedBy: pendingClaims.get(node.id) ?? null,
      scratch: {},
      producing: false,
      pending: null,
    };
    pendingClaims.delete(node.id);
    entries.set(node.id, created);
    return created;
  }

  function ctxFor(node: ModuleNode, entry: Entry, extras: unknown): ProduceCtx {
    return {
      node,
      extras,
      state: entry.scratch,
      surface() {
        if (!entry.surface) entry.surface = ops.createSurface(node.id, entry.type);
        return entry.surface;
      },
      measure: () => ops.measureContext(),
    };
  }

  /** Read the module handle's extras, or null when the engine has not
   *  materialized this node yet. Never throws. */
  function extrasOf(engine: ExtrasEngine, node: ModuleNode): unknown {
    try {
      return engine.read(node, 'extras') ?? null;
    } catch {
      return null;
    }
  }

  function runProduce(node: ModuleNode, entry: Entry, extras: unknown, sig: string): void {
    if (entry.producing) {
      entry.pending = sig;
      return;
    }
    entry.producing = true;
    let result: void | Promise<void>;
    try {
      result = entry.producer.produce(ctxFor(node, entry, extras));
    } catch {
      entry.producing = false;
      return;
    }
    const settle = () => {
      entry.producing = false;
      entry.lastExtras = handleFingerprint(extras);
      entry.lastSignature = sig;
      const queued = entry.pending;
      entry.pending = null;
      if (queued !== null && queued !== sig) {
        // Data moved while the decode was in flight — run again for the latest.
        const latest = liveNodes.find((n) => n.id === node.id);
        if (latest && liveEngine) {
          const e = extrasOf(liveEngine, latest);
          if (e) runProduce(latest, entry, e, queued);
        }
      }
    };
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).then(settle, settle);
    } else {
      settle();
    }
  }

  /** One reconciliation pass. Returns true when SOME node's engine handle was
   *  not ready, so the caller can schedule a bounded retry. */
  function pass(): boolean {
    const engine = liveEngine;
    if (!engine) return false;
    let anyUnready = false;
    for (const node of liveNodes) {
      const producer = byType.get(node.type);
      if (!producer) continue;
      const entry = entryFor(node, producer);
      const extras = extrasOf(engine, node);
      if (!extras) {
        // The reconciler has not built this engine node yet (the patch-LOAD
        // race the per-card retry loops existed for). Ask for a retry.
        anyUnready = true;
        continue;
      }
      if (entry.claimedBy) {
        // A card holds the binding and is pushing its own live surface. Forget
        // our handle so a release re-pushes against the CURRENT node.
        entry.lastExtras = null;
        continue;
      }
      const sig = producer.signature(node);
      if (sameHandle(entry.lastExtras, handleFingerprint(extras)) && sig === entry.lastSignature) {
        continue;
      }
      runProduce(node, entry, extras, sig);
    }
    return anyUnready;
  }

  function scheduleRetryIfNeeded(unready: boolean): void {
    if (!unready) {
      retryAttempt = 0;
      cancelRetry?.();
      cancelRetry = null;
      return;
    }
    if (cancelRetry) return; // one retry in flight is enough
    if (retryAttempt >= RETRY_ATTEMPTS) return;
    retryAttempt += 1;
    cancelRetry = ops.scheduleRetry(() => {
      cancelRetry = null;
      scheduleRetryIfNeeded(pass());
    }, RETRY_DELAY_MS);
  }

  function tick(): void {
    const engine = liveEngine;
    if (!engine) return;
    for (const node of liveNodes) {
      const entry = entries.get(node.id);
      const pumpFn = entry?.producer.pump;
      if (!entry || !pumpFn) continue;
      const extras = extrasOf(engine, node);
      if (!extras) continue;
      try {
        pumpFn({ node, extras, engine, state: entry.scratch });
      } catch {
        /* a pump must never take the ticker down */
      }
    }
  }

  function reconcileTicker(): void {
    const wanted = liveNodes.some((n) => byType.get(n.type)?.pump);
    if (wanted && !stopTicker) stopTicker = ops.startTicker(tick, PUMP_INTERVAL_MS);
    else if (!wanted && stopTicker) {
      stopTicker();
      stopTicker = null;
    }
  }

  return {
    sync(nodes, engine) {
      liveNodes = nodes;
      // A NEW engine invalidates every recorded handle identity: the old
      // `extras` objects belong to a disposed graph and comparing against them
      // would suppress the re-push a fresh engine needs.
      if (engine !== liveEngine) {
        for (const entry of entries.values()) entry.lastExtras = null;
        liveEngine = engine;
        retryAttempt = 0;
      }
      reconcileTicker();
      scheduleRetryIfNeeded(pass());
    },

    claim(nodeId, holder) {
      const entry = entries.get(nodeId);
      if (entry) {
        entry.claimedBy = holder;
        // The card is about to push its own surface; forget ours so a release
        // re-pushes rather than short-circuiting on a stale signature.
        entry.lastExtras = null;
        entry.lastSignature = null;
      } else {
        // The card mounted before the graph effect created the entry. Hold the
        // claim so `entryFor` adopts it — see pendingClaims.
        pendingClaims.set(nodeId, holder);
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          if (pendingClaims.get(nodeId) === holder) pendingClaims.delete(nodeId);
          const e = entries.get(nodeId);
          // OWNER-CHECKED: a stale card's teardown must never revoke the claim
          // of the card that took over from it.
          if (!e || e.claimedBy !== holder) return;
          e.claimedBy = null;
          // Re-push immediately so the node keeps a picture across the unmount.
          scheduleRetryIfNeeded(pass());
        },
      };
    },

    sweep(liveIds) {
      const live = new Set(liveIds);
      for (const id of [...entries.keys()]) if (!live.has(id)) entries.delete(id);
      for (const id of [...pendingClaims.keys()]) if (!live.has(id)) pendingClaims.delete(id);
      liveNodes = liveNodes.filter((n) => live.has(n.id));
      reconcileTicker();
    },

    disposeNode(nodeId) {
      entries.delete(nodeId);
      pendingClaims.delete(nodeId);
      liveNodes = liveNodes.filter((n) => n.id !== nodeId);
      reconcileTicker();
    },

    snapshot() {
      return [...entries.entries()].map(([nodeId, e]) => ({
        nodeId,
        type: e.type,
        claimed: e.claimedBy !== null,
        produced: e.lastSignature !== null,
        signature: e.lastSignature,
        hasSurface: e.surface !== null,
      }));
    },
  };
}
