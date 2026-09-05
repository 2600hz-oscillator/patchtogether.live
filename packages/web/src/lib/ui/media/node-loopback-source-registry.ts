// packages/web/src/lib/ui/media/node-loopback-source-registry.ts
//
// THE NODE-SCOPED OWNER OF THE LOOPBACK VIEWPORT CAPTURE — the capture state
// machine, the engine attach and the crop pump's start/stop, on GRAPH lifetime
// instead of card lifetime.
//
// WHY THIS FILE EXISTS. `loopback` was in `DOM_SOURCE_LANE_TYPES`: the module's
// engine-visible state (the `<video>` handed to `attachExternalSource`) existed
// only because `LoopbackCard.svelte` created it, and the shell kept that card
// mounted OFF-SCREEN in `<HeadlessSourceHost>` on the default shell purely so
// the source would exist. That works, and it is the wrong shape for two
// reasons the tree already records elsewhere:
//
//   1. It makes the CARD load-bearing, so the card cannot be deleted. That is
//      the legacy-removal blocker this file clears.
//   2. It makes the card load-bearing for the WRONG QUESTION. A card is a view.
//      Whether a viewport capture is running is CONTENT — it survives a
//      collapse, a dock move, a group collapse and a shell flip, and every one
//      of those is a view event. The moment the two are tied, some view event
//      is a content event by accident.
//
// This is LEG-02's shape, fourth application: `node-video-source-registry`
// (videobox), `node-varispeed-registry`, `node-hls-source-registry` (peertube +
// tvLibrarian), and now this. Read `node-video-source-registry`'s header for
// the full argument; what follows is only what is different here.
//
// ⚠ WHAT IS DIFFERENT HERE: THE GESTURE. `getDisplayMedia` is refused outside a
// user activation, and unlike `getUserMedia` there is NO previously-granted
// state that lets a programmatic call through — a call from an effect is
// refused ALWAYS, not just on a first visit. So the acquisition cannot be
// something this controller decides to do; it can only be something a surface
// ASKS it to do, synchronously, from inside a real click handler. That is what
// `request(nodeId, 'acquire')` is: the activation propagates through the
// synchronous call chain into `deps.capture.acquire()`. Nothing on this path
// may `await` before that call.
//
//   ⚠ THE CONSEQUENCE, STATED SO IT IS NOT REDISCOVERED: this controller can
//   RESTORE a capture across a card unmount, and it can never START one on its
//   own. A reload therefore comes back to `idle` with the button offered, and
//   that is correct rather than a gap — a screen-capture grant is
//   browser-instance-local and deliberately not in the Y.Doc.
//
// ⚠ THE STATUS SEAM IS NOT REPLACED, IT IS FED. `loopback-status-registry`
// already carries the capture state and the two commands across the
// card/faceplate boundary, and `LoopbackOutputBody.svelte` is written against
// it. This controller becomes the PUBLISHER on that seam instead of the card
// (see `./node-loopback-source.svelte.ts`), so every face file is untouched and
// there is exactly one status truth. What changes is who computes it.
//
//   ⚠ ONE OBSERVABLE CONSEQUENCE, because a reader will notice the prose in
//   `LoopbackOutputBody` and think it went stale: that file renders a `null`
//   status as the real state "no card has published". After this change a
//   controller exists for every loopback node in the graph, so the state is
//   reachable only in the instant before Canvas's first sync. The rendering is
//   still correct and still wanted — it is the honest answer whenever nobody
//   has published — it simply stops being the COMMON case. That is the
//   improvement, not a contract break.
//
// PURE — no DOM, no globals, no timers of its own. Every outside edge is
// injected so the whole state machine unit-tests in the web package's
// `environment: 'node'` lane. The browser binding is `./node-loopback-source.svelte.ts`.

import type { ModuleNode } from '$lib/graph/types';
import type { CropUv } from '$lib/video/loopback-crop';
import type { LoopbackCaptureState } from '$lib/ui/viewport-acquire';

/** The `nodeMedia` slot this controller owns for a loopback node. ONE element
 *  per node, exactly as the card used. */
export const LOOPBACK_SOURCE_SLOT = 'main';

/** The engine-attach retry, verbatim from the card's `onMount` (~5s). The
 *  engine's `addNode` is async, so the first attach can land before the
 *  engine-side node exists; the poll stops on the first attach the engine
 *  confirms with `hasVideoElement`. */
export const RETRY_INTERVAL_MS = 100;
export const RETRY_ATTEMPTS = 50;

/** The two things a surface can ask of a loopback node. Deliberately the same
 *  two ids `loopback-status-registry` already publishes, so the seam's
 *  vocabulary does not fork. */
export type LoopbackSourceCommand = 'acquire' | 'stop';

export interface LoopbackSourceStatus {
  /** The capture state machine. ONE declaration, in `$lib/ui/viewport-acquire`
   *  — see that type's header for why it is not re-declared per surface. */
  readonly state: LoopbackCaptureState;
  /** Recovery text for the surfaces. Null whenever there is nothing wrong. */
  readonly errorMsg: string | null;
  /** Does this browser have the Screen Capture API at all? */
  readonly supported: boolean;
  /** Has the engine confirmed it is holding this node's element? Published so a
   *  test (and a future surface) can tell "no capture yet" from "the attach
   *  never landed" — the card could not distinguish those at all. */
  readonly attached: boolean;
}

export const NO_LOOPBACK_SOURCE: LoopbackSourceStatus = {
  state: 'idle',
  errorMsg: null,
  supported: false,
  attached: false,
};

export interface LoopbackRequestResult {
  /** Was there a controller to receive this? */
  readonly delivered: boolean;
  /** Set when the handler threw. `delivered` is still true — "nobody was
   *  listening" and "the owner failed" need different fixes. */
  readonly error: unknown;
}

/** The narrow slice of `VideoEngine` this controller needs. */
export interface LoopbackSourceEngine {
  /** `attachExternalSource(nodeId, 'video', el)`. */
  attach(nodeId: string, el: unknown | null): void;
  /** `read(nodeId, 'hasVideoElement') === true`. */
  hasElement(nodeId: string): boolean;
  /** The private per-viewer `_crop*` channel. LOCAL, never synced — each
   *  collaborator's viewport differs. */
  setCrop(nodeId: string, crop: CropUv): void;
}

/** The `nodeMedia` slice. `ensure`, never `adopt`: the element must exist with
 *  NO host, because the whole point is that no surface need be mounted. A card
 *  or a faceplate that wants to SHOW it adopts the same key later and wins
 *  normally. */
export interface LoopbackSourceMedia<E> {
  ensure(nodeId: string, slot: string): E;
  setStream(nodeId: string, slot: string, stream: MediaStream | null): void;
  stream(nodeId: string, slot: string): MediaStream | null;
}

export interface LoopbackElementOps<E> {
  setStream(el: E, stream: MediaStream | null): void;
  play(el: E): void;
}

/** The acquisition edge. Injected whole rather than as a `getDisplayMedia`
 *  function, because the SUPPORT probe and the constraint set are part of the
 *  same decision and splitting them is how a browser check drifts from the call
 *  it is meant to guard. */
export interface LoopbackCaptureOps {
  supported(): boolean;
  /** MUST call `getDisplayMedia` synchronously — see the gesture note in the
   *  header. Returns the card's own result shape. */
  acquire(): Promise<{
    stream: MediaStream | null;
    error: { name: string; message: string } | null;
  }>;
  /** Subscribe to the user ending the share from the browser's own share bar.
   *  Returns the unsubscribe. */
  onEnded(stream: MediaStream, fn: () => void): () => void;
}

/** The NODE-keyed crop pump (`./loopback-crop-pump`). Injected so the core can
 *  assert start/stop ORDERING without a rAF. */
export interface LoopbackPumpOps {
  start(nodeId: string, deps: { cropEnabled(): boolean; push(crop: CropUv): void }): void;
  stop(nodeId: string): void;
}

/** The graph read. `cropEnabled` is read FRESH per frame by the pump, from the
 *  store rather than from a controller field — a captured value would freeze at
 *  whatever it was when the capture started, which is the stuck-value shape the
 *  pump was extracted to remove in the first place. */
export interface LoopbackSourceDoc {
  cropEnabled(nodeId: string): boolean;
}

export interface LoopbackSourceClock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LoopbackSourceDeps<E> {
  engine: LoopbackSourceEngine | null;
  media: LoopbackSourceMedia<E>;
  el: LoopbackElementOps<E>;
  capture: LoopbackCaptureOps;
  pump: LoopbackPumpOps;
  doc: LoopbackSourceDoc;
  clock: LoopbackSourceClock;
  /** PUSH, never poll. Called on every status change. */
  onStatus?(nodeId: string, status: LoopbackSourceStatus): void;
}

export interface NodeLoopbackSourceRegistry<E> {
  sync(nodes: readonly ModuleNode[], engine: LoopbackSourceEngine | null): void;
  view(nodeId: string): LoopbackSourceStatus;
  request(nodeId: string, cmd: LoopbackSourceCommand): LoopbackRequestResult;
  has(nodeId: string): boolean;
  disposeNode(nodeId: string): void;
  sweep(liveIds: Iterable<string>): void;
  snapshot(): Array<{ nodeId: string } & LoopbackSourceStatus>;
}

/**
 * The types whose loopback-style source this registry owns.
 *
 * ⚠ ANCHORED IN BOTH DIRECTIONS by `dom-source-modules.test.ts`: a type here
 * must be ABSENT from `DOM_SOURCE_LANE_TYPES` and present in exactly one
 * node-owner set. That is what makes the conversion atomic — a commit that adds
 * the controller without removing the card's `attachExternalSource` reddens on
 * the disjointness leg, and one that removes the attach without adding a
 * controller reddens on the derivation leg. Neither half can land alone.
 */
export const NODE_LOOPBACK_SOURCE_TYPES: ReadonlySet<string> = new Set<string>(['loopback']);

interface Controller<E> {
  node: ModuleNode;
  el: E;
  status: LoopbackSourceStatus;
  /** The engine-attach retry handle, cleared once the engine confirms. */
  retry: unknown | null;
  /** Unsubscribe for the share-bar `ended` listener of the LIVE stream. */
  offEnded: (() => void) | null;
  disposed: boolean;
  dispose(): void;
}

export function createNodeLoopbackSourceRegistry<E>(
  deps: LoopbackSourceDeps<E>,
): NodeLoopbackSourceRegistry<E> {
  const controllers = new Map<string, Controller<E>>();

  function publish(c: Controller<E>, next: Partial<LoopbackSourceStatus>): void {
    const merged: LoopbackSourceStatus = { ...c.status, ...next };
    if (
      merged.state === c.status.state &&
      merged.errorMsg === c.status.errorMsg &&
      merged.supported === c.status.supported &&
      merged.attached === c.status.attached
    ) {
      return;
    }
    c.status = merged;
    deps.onStatus?.(c.node.id, merged);
  }

  /**
   * Start the crop pump for a node.
   *
   * ⚠ IDEMPOTENT BY THE POOL'S CONTRACT (`loopback-crop-pump.start` is a no-op
   * while running), which is what lets `sync` call it unconditionally for a
   * capturing node without stacking a second loop.
   */
  function startPump(nodeId: string): void {
    deps.pump.start(nodeId, {
      cropEnabled: () => deps.doc.cropEnabled(nodeId),
      push: (crop) => deps.engine?.setCrop(nodeId, crop),
    });
  }

  /** The engine-attach retry. Verbatim in shape from the card's `onMount`: hand
   *  the (possibly empty) element over immediately and keep offering it until
   *  the engine says it is holding it, or we give up after ~5s. */
  function startAttachRetry(c: Controller<E>): void {
    if (c.retry !== null) return;
    let attempts = 0;
    c.retry = deps.clock.setInterval(() => {
      attempts++;
      const eng = deps.engine;
      if (eng) {
        try {
          eng.attach(c.node.id, c.el);
          if (eng.hasElement(c.node.id)) {
            stopAttachRetry(c);
            publish(c, { attached: true });
            return;
          }
        } catch {
          /* engine not ready — keep offering */
        }
      }
      if (attempts > RETRY_ATTEMPTS) stopAttachRetry(c);
    }, RETRY_INTERVAL_MS);
  }

  function stopAttachRetry(c: Controller<E>): void {
    if (c.retry === null) return;
    deps.clock.clearInterval(c.retry);
    c.retry = null;
  }

  /**
   * An EXPLICIT stop — the user pressed stop, or the share bar ended the track.
   *
   * ⚠ THIS IS A CONTENT EVENT AND IT IS NEVER CALLED FROM `dispose`. That line
   * is the whole reason this file exists: the card's `onDestroy` used to stop
   * the tracks, and `getDisplayMedia` cannot be restarted without a fresh user
   * gesture — so a collapse did not pause the capture, it ENDED it and the user
   * had to re-pick the tab. A controller dies when the NODE leaves the graph,
   * at which point stopping really is right; that is `dispose`.
   */
  function stopCapture(c: Controller<E>): void {
    const nodeId = c.node.id;
    c.offEnded?.();
    c.offEnded = null;
    deps.media.setStream(nodeId, LOOPBACK_SOURCE_SLOT, null);
    deps.el.setStream(c.el, null);
    try {
      deps.engine?.attach(nodeId, null);
    } catch {
      /* engine gone */
    }
    deps.pump.stop(nodeId);
    publish(c, { attached: false });
  }

  /**
   * Acquire a viewport capture.
   *
   * ⚠ NOTHING AWAITS BEFORE `deps.capture.acquire()`. The user activation that
   * makes `getDisplayMedia` legal is consumed by the first `await` on the path,
   * so the support probe, the state publish and the previous-stream teardown
   * are all synchronous and the acquire is the first suspension point. Moving
   * any `await` above it is a silent break: the picker simply never opens, and
   * every state assertion stays green because the refusal looks exactly like
   * the user dismissing the dialog.
   */
  async function acquire(c: Controller<E>): Promise<void> {
    const nodeId = c.node.id;
    if (!deps.capture.supported()) {
      publish(c, {
        state: 'unsupported',
        errorMsg: 'This browser does not support tab/screen capture (getDisplayMedia).',
        supported: false,
      });
      return;
    }
    publish(c, { state: 'requesting', errorMsg: null });
    stopCapture(c);

    const result = await deps.capture.acquire();
    if (c.disposed) {
      // The node left the graph while the picker was open. Whatever came back
      // belongs to nobody — stop it rather than leaking a live capture.
      result.stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!result.stream) {
      const e = result.error;
      if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
        // The user dismissed the picker or denied. A NORMAL outcome, not an
        // error — back to idle with the button still offered.
        publish(c, { state: 'idle', errorMsg: null });
      } else {
        publish(c, {
          state: 'error',
          errorMsg: e ? `${e.name}: ${e.message}` : 'Capture failed.',
        });
      }
      return;
    }

    const stream = result.stream;
    // The registry owns it from here: it stops the PREVIOUS stream (a re-share
    // legitimately replaces it) and never stops this one on a view teardown.
    deps.media.setStream(nodeId, LOOPBACK_SOURCE_SLOT, stream);
    startPump(nodeId);
    deps.el.setStream(c.el, stream);
    deps.el.play(c.el);

    // Announce the element to the engine module (the WebGL2 sampler reads it
    // directly). The retry may still be running; attach now regardless, because
    // the element is only interesting to the engine once it has a stream.
    try {
      deps.engine?.attach(nodeId, c.el);
    } catch {
      /* the retry keeps offering */
    }

    c.offEnded = deps.capture.onEnded(stream, () => {
      if (c.disposed) return;
      if (c.status.state !== 'capturing') return;
      stopCapture(c);
      publish(c, { state: 'ended', errorMsg: null });
    });

    publish(c, {
      state: 'capturing',
      errorMsg: null,
      attached: deps.engine?.hasElement(nodeId) ?? false,
    });
  }

  function createController(node: ModuleNode): Controller<E> {
    const el = deps.media.ensure(node.id, LOOPBACK_SOURCE_SLOT);
    const supported = deps.capture.supported();
    const c: Controller<E> = {
      node,
      el,
      status: {
        state: supported ? 'idle' : 'unsupported',
        errorMsg: supported
          ? null
          : 'This browser does not support tab/screen capture (getDisplayMedia).',
        supported,
        attached: false,
      },
      retry: null,
      offEnded: null,
      disposed: false,
      dispose(): void {
        c.disposed = true;
        stopAttachRetry(c);
        c.offEnded?.();
        c.offEnded = null;
        // The NODE is leaving the graph — here, and ONLY here, stopping the
        // capture is right. `nodeMedia.disposeNode` stops the tracks; the pump
        // is node-keyed and swept by the same Canvas effect, but stop it
        // explicitly so a controller's death never depends on sweep ordering.
        deps.pump.stop(c.node.id);
      },
    };
    // Publish the INITIAL status through the sink so a surface that mounts
    // before anything happens still gets a value rather than reading a default.
    deps.onStatus?.(node.id, c.status);
    if (supported) startAttachRetry(c);

    // REHYDRATE: a controller can be created for a node whose capture is
    // already live — the graph momentarily dropped the node (a sync race, an
    // undo/redo round-trip) while `nodeMedia` kept the stream. Coming back to
    // 'idle' there would tell the user the capture stopped when it did not.
    const existing = deps.media.stream(node.id, LOOPBACK_SOURCE_SLOT);
    if (existing) {
      deps.el.setStream(el, existing);
      startPump(node.id);
      c.offEnded = deps.capture.onEnded(existing, () => {
        if (c.disposed) return;
        if (c.status.state !== 'capturing') return;
        stopCapture(c);
        publish(c, { state: 'ended', errorMsg: null });
      });
      publish(c, { state: 'capturing', errorMsg: null });
    }
    return c;
  }

  return {
    sync(nodes, engine) {
      deps.engine = engine;
      const live = new Set<string>();
      for (const n of nodes) {
        if (!NODE_LOOPBACK_SOURCE_TYPES.has(n.type)) continue;
        live.add(n.id);
        const existing = controllers.get(n.id);
        if (existing) {
          // Keep the node reference fresh — `doc.cropEnabled` reads the store
          // by id, but a future dep might read the snapshot.
          existing.node = n;
          // A capturing node's pump must be running. `start` is idempotent
          // while running, so this is a CORRECTION rather than a second loop:
          // it re-arms a pump the sweep or an engine restart dropped.
          if (existing.status.state === 'capturing') startPump(n.id);
          continue;
        }
        controllers.set(n.id, createController(n));
      }
      for (const [id, c] of [...controllers]) {
        if (!live.has(id)) {
          c.dispose();
          controllers.delete(id);
        }
      }
    },

    view(nodeId) {
      return controllers.get(nodeId)?.status ?? NO_LOOPBACK_SOURCE;
    },

    request(nodeId, cmd) {
      const c = controllers.get(nodeId);
      if (!c) return { delivered: false, error: null };
      try {
        switch (cmd) {
          case 'acquire':
            // NOT awaited — see the gesture note on `acquire`. The caller is a
            // click handler and must not be made async.
            void acquire(c);
            break;
          case 'stop':
            stopCapture(c);
            publish(c, { state: 'idle', errorMsg: null });
            break;
        }
      } catch (error) {
        return { delivered: true, error };
      }
      return { delivered: true, error: null };
    },

    has(nodeId) {
      return controllers.has(nodeId);
    },

    disposeNode(nodeId) {
      const c = controllers.get(nodeId);
      if (!c) return;
      c.dispose();
      controllers.delete(nodeId);
    },

    sweep(liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
      for (const [id, c] of [...controllers]) {
        if (!live.has(id)) {
          c.dispose();
          controllers.delete(id);
        }
      }
    },

    snapshot() {
      const out: Array<{ nodeId: string } & LoopbackSourceStatus> = [];
      for (const [nodeId, c] of controllers) out.push({ nodeId, ...c.status });
      return out;
    },
  };
}
