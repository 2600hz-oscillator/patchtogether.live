// packages/web/src/lib/ui/media/node-viz-surface-registry.ts
//
// THE NODE-LIFETIME VIZ SURFACE — a producer that is not a CALLBACK but a
// MOUNTED COMPONENT, and the adoption seam that lets any number of views show
// the one element it renders.
//
// ⚠ WHY THIS EXISTS BESIDE `node-frame-producer-registry`, WHICH ALREADY OWNS
// "the rAF body a card used to run". That registry takes a FUNCTION off a card
// and runs it on a shared ticker. It can do that because scope, synesthesia and
// timelorde all produce a NUMBER or an ImageBitmap — nothing they make needs a
// live GL context, a canvas element or a component lifecycle.
//
// WAVESCULPT does. Its producer IS a WebGL2 renderer with ~2,500 lines of
// shader/geometry state, a persistent GL context, per-node framebuffers and a
// presentation canvas it blits onto — and `installWavesculptFrameDrawer` hands
// the module's own `drawFrame` a closure over all of it. Moving that to a
// callback would mean re-writing the renderer, and the renderer is in the WebGL
// ATTEST BASIS: its bytes cannot move without a real-GPU re-attest window. So
// the producer stays the component it already is, and what moves is WHO MOUNTS
// IT — a node-keyed host instead of a card.
//
// ── WHAT THE VIEWS GET, AND WHY IT IS ADOPTION RATHER THAN A SECOND MOUNT ────
//
// A DOM element has exactly ONE parent, and that is the whole design constraint
// (the `nodeMedia` adoption seam records the same one for `<video>`). The
// alternatives were both measured and both rejected:
//
//   * TWO MOUNTS (a node-owned producer + a viewer-only surface per view) is
//     what shipped before this file and it does not survive the extraction. The
//     surface stamps `data-testid="wavesculpt-canvas"` on its own canvas, so a
//     parked producer plus a viewer puts TWO of them in the document — and
//     `wavesculpt.spec.ts` asserts `toHaveCount(1)` fifteen times, as does the
//     VRT surface roster (`expectCount: 1`). It also runs two GL contexts for
//     one node.
//   * ONE MOUNT, NO SHARING — i.e. the node host is the only place the picture
//     exists — means no view can ever show it.
//
// So: ONE surface per node, mounted off-screen by the node-keyed host, and any
// view that wants to SHOW it CLAIMS the canvas and the registry moves the
// element into that view. rAF does not care about DOM ancestry, so the render
// never pauses across a move; the GL context, the frame drawer and the DRS step
// seam all stay with the one mount that owns them.
//
// ── CLAIMS ARE PRIORITISED, NOT LAST-WINS ────────────────────────────────────
//
// `nodeMedia.adopt` is a bare transfer: the last host to adopt wins. That is
// right for a `<video>` whose losing host shows an empty box nobody is looking
// at, and it is NOT right here, because more than one view can be looking at
// one wavesculpt at the same time — a split dock, or a lane viewer beside an
// opened pane.
//
// Last-wins would decide that by mount ORDER. A priority decides it by which
// surface the player is actually looking at — an opened pane is a deliberate,
// focused gesture, so it outranks a viewer that merely happens to be on screen
// — and, because the registry keeps every standing claim rather than
// overwriting one, RELEASING the top claim hands the canvas straight back to
// the next one with no remount and no re-init. A bare transfer could not do
// that: the loser's claim would already be gone.
//
// ⚠ ONE TIER HAS NO PRODUCTION CLAIMANT TODAY. `CubeHeroPanel` and
// `WavesculptOutputBody` both claim at the pane tier; nothing in the product
// claims below it, so the ranking is exercised by this file's unit test rather
// than by two live views. The tier stays because the mechanism it protects —
// standing claims and hand-back on release — is what the no-remount guarantee
// rests on, and a second viewer is a lane tile away.
//
// PURE CORE + INJECTED OPS, the split `node-frame-producer-registry` and
// `node-media-registry` both use, so the whole decision table unit-tests in the
// web package's `environment: 'node'` vitest with no DOM at all.
//
// ⚠ LIVES UNDER `lib/ui/media/**` DELIBERATELY: `resolveWebglBasis()` sweeps
// `lib/ui/modules/**/*.svelte` by content and `lib/video/**` wholesale, so this
// file is hash-transparent to the WebGL attest. The renderer it hosts is IN the
// basis; nothing here may ever become a second place GL is created.

/**
 * A module whose per-frame producer is a MOUNTED SURFACE owned by the node.
 *
 * Typed with a `why`, the discipline `PRODUCER_SEAMS` and `FrameProducer` both
 * use: the reason a module belongs here is the only thing a reviewer of a
 * future addition needs, and a reason that lives only in a commit message is
 * not available at the point of the edit.
 */
export interface VizSurfaceProducer {
  /** The module type id. */
  readonly type: string;
  /** Why its producer cannot be a `FrameProducer` callback. */
  readonly why: string;
}

/** Every type in `list`, as a set. DERIVED — never a second literal. */
export function vizSurfaceTypes(list: readonly VizSurfaceProducer[]): ReadonlySet<string> {
  return new Set(list.map((p) => p.type));
}

/**
 * Who may claim a node's surface, and who wins when two views want it at once.
 *
 * Numbers rather than names in the comparison, so a third claimant can be
 * ranked between two existing ones without renumbering either.
 */
export const VIZ_CLAIM_PRIORITY = {
  /** The legacy `*Card.svelte` screen. */
  card: 1,
  /** A dock full-view faceplate body — an explicit, focused gesture, so it
   *  outranks a lane card that happens to also be mounted behind it. */
  dock: 2,
} as const;

/** The DOM moves the registry needs, injected so the core is pure. */
export interface VizSurfaceOps<E, H> {
  /** Move `el` into `host`. A MOVE, never a clone — the element identity is
   *  what the GL context, the frame drawer and the step seam all hang off. */
  mount(el: E, host: H): void;
  /** Move `el` back to the node host's own parking container. */
  park(el: E, park: H): void;
}

/** A view's standing claim on a node's surface. `release()` is idempotent. */
export interface VizSurfaceClaim {
  release(): void;
}

export interface VizSurfaceRow {
  readonly nodeId: string;
  /** Is the surface published (i.e. is the node host mounted)? */
  readonly published: boolean;
  /** How many views are currently claiming it. */
  readonly claims: number;
  /** Is a view showing it right now (false ⇒ parked off-screen)? */
  readonly shown: boolean;
  /** How many per-frame listeners are registered. */
  readonly listeners: number;
}

export interface NodeVizSurfaceRegistry<E, H> {
  /**
   * The node host publishes the element its surface rendered, plus the parking
   * container to return it to. Called once per node, from the host's own
   * lifecycle.
   */
  publish(nodeId: string, el: E, park: H): void;
  /**
   * The node host is going away (the node left the graph). The element is
   * PARKED FIRST and then forgotten — a claimed element must be back where its
   * component expects it before that component is destroyed, or the framework
   * tears down a subtree it no longer contains.
   */
  retract(nodeId: string): void;
  /** A view asks to show this node's surface. */
  claim(nodeId: string, host: H, priority: number): VizSurfaceClaim;
  /**
   * Register a per-rendered-frame callback for this node.
   *
   * ⚠ THIS IS A CADENCE GUARANTEE, NOT A CONVENIENCE, and the reason is the
   * surface's own (`WavesculptVizSurface.svelte`, `onFrame`): the legacy card
   * polls the camera CV here to move its joystick dots, and as a standalone
   * `setInterval(30ms)` that poll was STARVED and coalesced behind the renderer
   * on a busy main thread, so a gamepad-driven dot could not reach the stick's
   * extremes. Riding the render's own frame is what fixed it. The producer left
   * the card; this is how the guarantee came with it.
   */
  onFrame(nodeId: string, fn: () => void): () => void;
  /** The node host's surface calls this once per rendered frame. */
  emitFrame(nodeId: string): void;
  /**
   * Subscribe to the WINNING claim's priority for a node — `null` when no live
   * claim stands. Delivered immediately on subscribe with the current value,
   * then on every claims change that MOVES the winner.
   *
   * ⚠ WHY THE HOST NEEDS THIS AT ALL (cube, legacy-removal S1.5): wavesculpt's
   * two views show its canvas at ONE size, so the host mounts one shape and
   * the claims only decide WHERE it shows. cube's card and hero mounted the
   * SAME renderer at DIFFERENT sizes (320×260 vs 300×210 + orbit), and the
   * renderer's bytes are attest-pinned, so it cannot grow a resize path. The
   * host therefore re-mounts the surface per WINNING CLAIMANT KIND — and this
   * is how it learns the kind without importing the dock, the shell or any
   * view: the claims already carry it as priority.
   *
   * The value is the PRIORITY NUMBER, not a kind name, for the same reason
   * `VIZ_CLAIM_PRIORITY` uses numbers: a third claimant ranks between two
   * existing ones without renaming anything here.
   */
  onWinner(nodeId: string, fn: (priority: number | null) => void): () => void;
  /** The published element for a node, if any. Never creates one. */
  peek(nodeId: string): E | null;
  /** The host currently showing a node's surface, or null when it is parked. */
  showing(nodeId: string): H | null;
  /** Inspection for tests and the e2e probe. Rows, never a population COUNT. */
  snapshot(): VizSurfaceRow[];
}

interface Claim<H> {
  host: H;
  priority: number;
  seq: number;
  live: boolean;
}

interface Entry<E, H> {
  el: E | null;
  park: H | null;
  claims: Claim<H>[];
  /** Where the element is RIGHT NOW — the parking container, a claimant's host,
   *  or null before it is published. */
  at: H | null;
  listeners: Set<() => void>;
  /** Winner-change subscribers (the host's per-claimant-kind remount). */
  winnerListeners: Set<(priority: number | null) => void>;
  /** The winner priority last delivered, so a resolve that does not move the
   *  winner notifies nobody. */
  lastWinner: number | null;
}

export function createNodeVizSurfaceRegistry<E, H>(
  ops: VizSurfaceOps<E, H>,
): NodeVizSurfaceRegistry<E, H> {
  const entries = new Map<string, Entry<E, H>>();
  let seq = 0;

  function entryFor(nodeId: string): Entry<E, H> {
    let e = entries.get(nodeId);
    if (!e) {
      e = {
        el: null,
        park: null,
        claims: [],
        at: null,
        listeners: new Set(),
        winnerListeners: new Set(),
        lastWinner: null,
      };
      entries.set(nodeId, e);
    }
    return e;
  }

  /** The winning claim: highest priority, and among equals the most RECENT.
   *  Ties broken by recency so two same-priority views behave like the
   *  last-wins transfer they replace. */
  function winner(e: Entry<E, H>): Claim<H> | null {
    let best: Claim<H> | null = null;
    for (const c of e.claims) {
      if (!c.live) continue;
      if (best === null || c.priority > best.priority || (c.priority === best.priority && c.seq > best.seq)) {
        best = c;
      }
    }
    return best;
  }

  /** Put the element where the current claim set says it belongs. IDEMPOTENT:
   *  a resolve that changes nothing performs no DOM move, which is what keeps a
   *  re-render from re-parenting a live canvas every tick. */
  function resolve(nodeId: string): void {
    const e = entries.get(nodeId);
    if (!e || !e.el || !e.park) return;
    const target = winner(e)?.host ?? e.park;
    if (e.at === target) return;
    if (target === e.park) ops.park(e.el, e.park);
    else ops.mount(e.el, target);
    e.at = target;
  }

  /** Tell the winner subscribers, but only when the winner actually MOVED —
   *  claims churn that keeps the same winner must not remount anything. */
  function notifyWinner(nodeId: string): void {
    const e = entries.get(nodeId);
    if (!e || e.winnerListeners.size === 0) return;
    const w = winner(e)?.priority ?? null;
    if (w === e.lastWinner) return;
    e.lastWinner = w;
    // Copied before iterating — a listener may unsubscribe mid-delivery.
    for (const fn of [...e.winnerListeners]) {
      try {
        fn(w);
      } catch {
        /* a host's remount decision must never stop the claims machinery */
      }
    }
  }

  /** Drop an entry once nothing is left to remember about it. */
  function prune(nodeId: string): void {
    const e = entries.get(nodeId);
    if (!e) return;
    if (
      e.el === null &&
      e.claims.length === 0 &&
      e.listeners.size === 0 &&
      e.winnerListeners.size === 0
    ) {
      entries.delete(nodeId);
    }
  }

  return {
    publish(nodeId, el, park) {
      const e = entryFor(nodeId);
      e.el = el;
      e.park = park;
      // The element starts life inside `park` (the host rendered it there), so
      // seed `at` with that rather than null: a node nobody claims must not pay
      // a pointless re-parent on its first frame.
      e.at = park;
      resolve(nodeId);
    },

    retract(nodeId) {
      const e = entries.get(nodeId);
      if (!e) return;
      // ⚠ PARK BEFORE FORGETTING. The element belongs to the surface component
      // the host is about to destroy, and a framework removes a component's DOM
      // from where it PUT it. Handing it back first is the same discipline
      // `GroupCard`'s portal uses on teardown.
      if (e.el && e.park && e.at !== e.park) {
        ops.park(e.el, e.park);
        e.at = e.park;
      }
      e.el = null;
      e.park = null;
      e.at = null;
      prune(nodeId);
    },

    claim(nodeId, host, priority) {
      const e = entryFor(nodeId);
      const c: Claim<H> = { host, priority, seq: seq++, live: true };
      e.claims.push(c);
      resolve(nodeId);
      notifyWinner(nodeId);
      return {
        release() {
          if (!c.live) return;
          c.live = false;
          const idx = e.claims.indexOf(c);
          if (idx >= 0) e.claims.splice(idx, 1);
          resolve(nodeId);
          notifyWinner(nodeId);
          prune(nodeId);
        },
      };
    },

    onFrame(nodeId, fn) {
      const e = entryFor(nodeId);
      e.listeners.add(fn);
      return () => {
        e.listeners.delete(fn);
        prune(nodeId);
      };
    },

    onWinner(nodeId, fn) {
      const e = entryFor(nodeId);
      e.winnerListeners.add(fn);
      // Deliver the CURRENT winner immediately, so a host that subscribes
      // after a view has already claimed does not mount the wrong shape and
      // wait for churn to correct it. Seeding `lastWinner` alongside keeps the
      // next claims-change from re-delivering a value every subscriber has
      // already seen.
      e.lastWinner = winner(e)?.priority ?? null;
      try {
        fn(e.lastWinner);
      } catch {
        /* same contract as delivery */
      }
      return () => {
        e.winnerListeners.delete(fn);
        prune(nodeId);
      };
    },

    emitFrame(nodeId) {
      const e = entries.get(nodeId);
      if (!e || e.listeners.size === 0) return;
      // Copied before iterating: a listener that unsubscribes itself mid-frame
      // must not skip the next one.
      for (const fn of [...e.listeners]) {
        try {
          fn();
        } catch {
          /* one view's poll must never stop the render it rides */
        }
      }
    },

    peek(nodeId) {
      return entries.get(nodeId)?.el ?? null;
    },

    showing(nodeId) {
      const e = entries.get(nodeId);
      if (!e || !e.el) return null;
      return e.at !== null && e.at !== e.park ? e.at : null;
    },

    snapshot() {
      return [...entries.entries()].map(([nodeId, e]) => ({
        nodeId,
        published: e.el !== null,
        claims: e.claims.length,
        shown: e.el !== null && e.at !== null && e.at !== e.park,
        listeners: e.listeners.size,
      }));
    },
  };
}
