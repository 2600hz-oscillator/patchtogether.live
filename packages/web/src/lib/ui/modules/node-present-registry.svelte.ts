// node-present-registry.svelte.ts
//
// NODE-OWNED PRESENTATION LIFETIME — the registry that makes "Present on a
// second display" outlive the CARD that started it.
//
// THE BUG THIS EXISTS FOR (owner P0, dev, measured 2026-08-12): "backdraft on
// dev when card is not expanded and its been sent to a projector, the output
// stops." Under the faceplate shell an un-migrated video module has NO real
// card in the lane — the card exists only while its dock FULL-VIEW is open, and
// the "Present on …" menu lives on that card. So the user's sequence is
// expand -> present -> COLLAPSE, and the collapse UNMOUNTS the card. videoOut
// never showed the bug for one reason only: it is a NON_SHELL_LANE_TYPE, so its
// card sits in the lane forever and is never swapped.
//
// THREE card-owned things died with that unmount, and each on its own is fatal:
//   1. THE POPUP        — `onDestroy -> present.dispose()` called window.close().
//   2. THE RENDER LEASE — attachRenderLease's $effect cleanup released the hard
//      pull-eval root, so the engine stopped drawing the node.
//   3. THE BLIT SOURCE  — startPresent held the CARD's <canvas> and drew from it
//      every frame. The unmount detaches that element; a detached canvas keeps
//      its last bitmap, so the projector would have FROZEN on its final frame
//      even with 1 and 2 fixed.
//
// MEASURED, so the order is not a guess (present-survives-card-collapse.spec.ts,
// against a real /present popup):
//   * as shipped        -> `popup.isClosed()` is TRUE the moment the card
//                          collapses. Mechanism 1 fires first and is decisive.
//   * dispose() removed -> the popup survives and `pullStats().leased` is `[]`.
//                          Mechanism 2 fires too, so a dispose-only fix ships a
//                          projector that is open and dead.
// Mechanism 3 needs no separate run: the card is gone from the DOM (the spec
// asserts that), and the loop's source was an element of that card.
//
// THE RULE THIS FILE ENCODES is the one $lib/ui/media/node-media-registry
// already encodes for <video>/<img>: a resource whose LIFETIME is the node's
// belongs to the NODE, never to whichever view happens to be rendering it.
// Cards ADOPT and RELEASE; they do not CREATE and DESTROY. Teardown is keyed to
// GRAPH lifetime — `sweep(liveNodeIds)` from Canvas, reconciled against the live
// node set, so a node deleted by ANY route (menu, Backspace, undo, a peer's CRDT
// delete, Clear, a patch load) closes its projector with no delete site having
// to remember.
//
// WHY THE SOURCE IS THE ENGINE AND NOT A CANVAS. Every presenting card's draw
// is byte-for-byte the same three lines — `blitOutputToDrawingBuffer(id)`, read
// `engine.canvas`, letterbox-`drawImage` — so the popup does not need the card's
// canvas at all; it needs the node's OUTPUT. The registry passes a `prepare`
// (render THIS node into the shared drawing buffer) plus a `source` GETTER (not
// a captured element, so an engine resolution change is followed). That deletes
// mechanism 3 rather than working around it, removes one full-frame readback per
// present, and incidentally fixes a resolution bug: videoOut used to project its
// CARD-sized canvas upscaled to the projector, and now projects engine-native.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`, NOT `lib/video/**`. That
// directory is hashed WHOLESALE for the WebGL attest, so a change there costs a
// GPU re-attest window. Keeping the fix here is deliberate and is a constraint
// on any future edit: do not move this file.
//
// TESTABILITY: the `start` seam (defaulting to the real startPresent) and an
// injected engine mean the whole registry drives under vitest's node
// environment with no window.open, no DOM and no GL. `nodePresent` at the
// bottom is the real singleton the cards use through createPresent.

import { startPresent, type PresentSession, type StartPresentArgs } from './present-window';
import type { ScreenRect } from './use-fullscreen.svelte';

/** The slice of VideoEngine a projector needs: render one node into the shared
 *  drawing buffer, read that buffer, and pin the node as a pull root. */
export interface PresentEngine {
  readonly canvas: (CanvasImageSource & { readonly width: number; readonly height: number }) | null;
  blitOutputToDrawingBuffer(nodeId: string): void;
  acquireRenderLease(nodeId: string): () => void;
}

export interface OpenPresentArgs {
  /** The live video engine. Resolved by the CARD at click time and stored on
   *  the entry, because the engine is a page singleton that outlives every
   *  card — unlike the card's own context handle. */
  engine: PresentEngine;
  /** Working-area rect of the target display (the card's fullscreen controller
   *  resolves it); null falls back to a default-sized popup. */
  rect: ScreenRect | null;
}

export interface NodePresentRegistry {
  /** Open (or replace) the popup for (nodeId, screenId). Returns false when the
   *  popup was blocked or no engine is reachable. */
  present(nodeId: string, screenId: string, args: OpenPresentArgs): boolean;
  /** Open a popup on EACH given display in one call (one user gesture). Skips
   *  displays already lit for this node. Returns how many NEW popups opened. */
  presentAll(
    nodeId: string,
    screenIds: string[],
    args: { engine: PresentEngine; rectFor: (screenId: string) => ScreenRect | null },
  ): number;
  /** Close popups for a node: one display, or all of them with no screenId. */
  stop(nodeId: string, screenId?: string): void;
  isPresenting(nodeId: string): boolean;
  presentingCount(nodeId: string): number;
  /** Every node with at least one live popup — the e2e probe + the reactive
   *  read that lets a REMOUNTED card show "Stop presenting". */
  presentingNodeIds(): string[];
  /** Every (node, display) pair currently lit. The persistence side needs the
   *  screen dimension too, which `presentingNodeIds` flattens away. */
  presentingPairs(): { nodeId: string; screenId: string }[];
  /**
   * GRAPH-LIFETIME teardown. Closes every projector whose node is no longer in
   * the patch. This is the ONLY route by which a present session dies without
   * the user asking — card unmount emphatically is not one.
   */
  sweep(liveNodeIds: Iterable<string>): void;
  /** Close everything (page teardown / tests). */
  disposeAll(): void;
}

interface NodeEntry {
  sessions: Map<string, PresentSession>;
  engine: PresentEngine;
  releaseLease: (() => void) | null;
}

export interface CreateNodePresentRegistryArgs {
  /** Test seam — defaults to the real startPresent. */
  start?: (args: StartPresentArgs) => PresentSession | null;
  /** Test seam for the closed-popup poll. Defaults to setInterval/clearInterval. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function createNodePresentRegistry(
  args: CreateNodePresentRegistryArgs = {},
): NodePresentRegistry {
  const start = args.start ?? startPresent;
  const setIv = args.setInterval
    ?? ((fn: () => void, ms: number) => (typeof setInterval === 'function' ? setInterval(fn, ms) : null));
  const clearIv = args.clearInterval
    ?? ((h: unknown) => { if (h != null && typeof clearInterval === 'function') clearInterval(h as ReturnType<typeof setInterval>); });

  const nodes = new Map<string, NodeEntry>();
  // Bumped on every membership change. Read by the public getters so a Svelte
  // card's `present.isPresenting` re-derives — including on a card that mounted
  // AFTER the projector was opened, which is exactly the collapse/re-expand
  // round trip this registry exists to survive.
  let version = $state(0);
  let poll: unknown = null;

  /** Prune sessions whose popup the user closed via the OS window button, and
   *  drop the lease of any node left with none. */
  function reconcile(): void {
    let changed = false;
    for (const [nodeId, entry] of nodes) {
      for (const [screenId, session] of entry.sessions) {
        if (session.closed) {
          entry.sessions.delete(screenId);
          changed = true;
        }
      }
      if (entry.sessions.size === 0) {
        entry.releaseLease?.();
        entry.releaseLease = null;
        nodes.delete(nodeId);
        changed = true;
      }
    }
    if (nodes.size === 0 && poll != null) {
      clearIv(poll);
      poll = null;
    }
    if (changed) version++;
  }

  function ensurePoll(): void {
    if (poll == null) poll = setIv(reconcile, 600);
  }

  function entryFor(nodeId: string, engine: PresentEngine): NodeEntry {
    let entry = nodes.get(nodeId);
    if (!entry) {
      entry = { sessions: new Map(), engine, releaseLease: null };
      nodes.set(nodeId, entry);
    }
    // A later open re-pins the engine reference (a re-boot swaps the instance).
    entry.engine = engine;
    return entry;
  }

  /** Open (or replace) one display's popup. Returns true if a popup opened. */
  function openOne(nodeId: string, screenId: string, engine: PresentEngine, rect: ScreenRect | null): boolean {
    const entry = entryFor(nodeId, engine);
    const existing = entry.sessions.get(screenId);
    if (existing) {
      existing.stop();
      entry.sessions.delete(screenId);
    }
    const session = start({
      // THE SOURCE IS THE ENGINE, NOT A CARD ELEMENT. `prepare` renders THIS
      // node's output into the shared drawing buffer immediately before the
      // read, which is what makes N simultaneous projectors on N different
      // nodes independent (the same reason each card's draw() does it).
      prepare: () => {
        try {
          entry.engine.blitOutputToDrawingBuffer(nodeId);
        } catch {
          /* an engine hiccup must never kill the blit loop */
        }
      },
      source: () => entry.engine.canvas,
      rect,
    });
    if (!session) {
      // Popup blocked. Do not leave an empty entry (and its lease) behind.
      if (entry.sessions.size === 0) {
        entry.releaseLease?.();
        entry.releaseLease = null;
        nodes.delete(nodeId);
      }
      return false;
    }
    entry.sessions.set(screenId, session);
    // THE HARD RENDER LEASE MOVES HERE TOO. Held by the SESSION, not the card:
    // pull evaluation vetoes an off-screen or unmounted card as an observer, and
    // a projector is precisely a surface that outlives the card's viewport rect.
    // Refcounted engine-side, so the card's own presenting-mode lease
    // (use-render-lease, still correct for fullscreen / full-frame) stacks
    // harmlessly on top.
    if (!entry.releaseLease) {
      try {
        entry.releaseLease = engine.acquireRenderLease(nodeId);
      } catch {
        entry.releaseLease = null;
      }
    }
    return true;
  }

  function stop(nodeId: string, screenId?: string): void {
    const entry = nodes.get(nodeId);
    if (!entry) return;
    if (screenId === undefined) {
      for (const s of entry.sessions.values()) s.stop();
      entry.sessions.clear();
    } else {
      const s = entry.sessions.get(screenId);
      if (!s) return;
      s.stop();
      entry.sessions.delete(screenId);
    }
    if (entry.sessions.size === 0) {
      entry.releaseLease?.();
      entry.releaseLease = null;
      nodes.delete(nodeId);
    }
    version++;
    if (nodes.size === 0 && poll != null) {
      clearIv(poll);
      poll = null;
    }
  }

  return {
    present(nodeId, screenId, openArgs) {
      const ok = openOne(nodeId, screenId, openArgs.engine, openArgs.rect);
      if (ok) {
        version++;
        ensurePoll();
      }
      return ok;
    },
    presentAll(nodeId, screenIds, openArgs) {
      let opened = 0;
      for (const screenId of screenIds) {
        if (nodes.get(nodeId)?.sessions.has(screenId)) continue; // already lit
        if (openOne(nodeId, screenId, openArgs.engine, openArgs.rectFor(screenId))) opened++;
      }
      if (opened > 0) {
        version++;
        ensurePoll();
      }
      return opened;
    },
    stop,
    isPresenting(nodeId) {
      void version;
      return (nodes.get(nodeId)?.sessions.size ?? 0) > 0;
    },
    presentingCount(nodeId) {
      void version;
      return nodes.get(nodeId)?.sessions.size ?? 0;
    },
    presentingNodeIds() {
      void version;
      return [...nodes.keys()].sort();
    },
    presentingPairs() {
      void version;
      const pairs: { nodeId: string; screenId: string }[] = [];
      for (const [nodeId, entry] of nodes) {
        for (const screenId of entry.sessions.keys()) pairs.push({ nodeId, screenId });
      }
      return pairs.sort(
        (a, b) => a.nodeId.localeCompare(b.nodeId) || a.screenId.localeCompare(b.screenId),
      );
    },
    sweep(liveNodeIds) {
      const live = new Set(liveNodeIds);
      for (const nodeId of [...nodes.keys()]) {
        if (!live.has(nodeId)) stop(nodeId);
      }
    },
    disposeAll() {
      for (const nodeId of [...nodes.keys()]) stop(nodeId);
    },
  };
}

/** The real singleton every card reaches through `createPresent`. */
export const nodePresent: NodePresentRegistry = createNodePresentRegistry();

// A popup is a CHILD window, so it survives its opener navigating away and
// would be left frozen with nothing driving it. `pagehide` covers reload,
// navigation and close — `beforeunload` does not fire reliably on mobile/bfcache
// paths. (Card unmount, deliberately, is NOT one of these hooks.)
//
// ⚠ `typeof window !== 'undefined'` IS NOT A SUFFICIENT GUARD IN THIS REPO, and
// a single-file test run cannot tell you so. The web package's vitest runs under
// `environment: 'node'`, where several suites install a PARTIAL `window` stub on
// globalThis; import order then decides whether this module sees the real DOM,
// no window at all, or an object with no addEventListener. Running
// node-present-registry.test.ts / use-present.test.ts alone was green three
// times over; the FULL unit sweep failed four files at IMPORT with
// "window.addEventListener is not a function". Probe the CAPABILITY, not the
// object — and never let a module-scope side effect throw during import.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  try {
    window.addEventListener('pagehide', () => nodePresent.disposeAll());
  } catch {
    /* an exotic realm without event targets — the projector simply outlives the page */
  }
}
