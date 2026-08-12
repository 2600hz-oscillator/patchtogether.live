// packages/web/src/lib/ui/media/node-media-registry.ts
//
// NODE-OWNED MEDIA LIFETIME — the registry that makes a DOM-source video
// module's <video>/<img>, its object URL and its MediaStream outlive the CARD
// that displays them.
//
// THE BUG THIS EXISTS FOR (owner P0, measured 2026-08-12): "videovarispeed
// stops playing if its card is collapsed." Expand/collapse MOVES a DOM-source
// module's real card between two different component trees —
// <HeadlessSourceHost> (parked off-screen while the lane shows a shell tile)
// and <DockFullView> (the expanded tray) — because Canvas excludes full-view
// nodes from the headless host. Those are different MOUNTS, so the transition
// is an unmount + a mount, and every DOM-source card's `onDestroy` tore its
// source down: `attachExternalSource(id, kind, null)`, `URL.revokeObjectURL`,
// `track.stop()`.
//
// MEASURED, so the mechanism is not in doubt: across a collapse the engine's
// per-node draw counter kept advancing (130 -> 619, `evaluated=Y skipped=n`
// the whole way — pull evaluation never skipped the node and is NOT the
// fault), while the count of <video> elements holding a src went 1 -> 0 in the
// first sample after the click. RENDERING was healthy; PLAYBACK was destroyed.
//
// THE RULE THIS FILE ENCODES: a module's media belongs to its NODE (graph
// lifetime), never to whichever view happens to be rendering it. Cards ADOPT
// and RELEASE; they do not CREATE and DESTROY. This is the DOM-element analog
// of $lib/video/video-keepalive-registry, which already keeps the AUDIO side
// alive across exactly the same churn ("created AT MOST ONCE per element and
// lives until dispose") — the element itself was simply never given the same
// treatment.
//
// WHY DOUBLE-MOUNT IS UNREPRESENTABLE HERE, not merely unlikely. Canvas.svelte
// documents the hazard the old design had to dodge: "a second mount would run
// two media elements for one node and the first to unmount would detach the
// survivor's source." Two properties kill it outright:
//   1. There is EXACTLY ONE element per (nodeId, slot). `adopt` cannot mint a
//      second — it always returns the one entry, so two simultaneous hosts
//      cannot own two elements.
//   2. Adoption is a TRANSFER and release is OWNER-CHECKED. `adopt` always
//      succeeds and steals ownership; `release` compares the caller's host
//      against the current owner and NO-OPS when they differ. So a stale
//      mount's teardown can never detach the live one, and mount/unmount
//      ORDER stops mattering — which is the only way to be safe, since Svelte
//      gives no cross-tree ordering guarantee.
//
// WHY OFF-SCREEN PARKING AND NOT `display:none` — verbatim the constraint
// HeadlessSourceHost and the workflow camera manager already document: "an
// off-screen video element is the same scenario as a canvas card scrolled out
// of view — decode + rVFC keep running, where a non-rendered one could freeze
// the engine's texture." Parked elements keep real dimensions at left:-9999px.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`, NOT `lib/video/**`. That
// directory is hashed WHOLESALE for the WebGL attest, so a change there costs
// a GPU re-attest window. Keeping the fix here is deliberate and is a
// constraint on any future edit: do not move this file.
//
// TESTABILITY: the web package's vitest runs in `environment: 'node'` (no
// jsdom), so the registry takes its DOM operations as an INJECTED `ops` object
// — the same shape of seam `createKeepAliveRegistry` uses for its `create`
// factory. `nodeMedia` (bottom of file) is the real-DOM singleton the cards
// use; `createNodeMediaRegistry` is the pure core the unit tests drive with
// fakes.

/** What a media entry currently holds, for teardown + the e2e probe. */
export interface NodeMediaSnapshot {
  nodeId: string;
  slot: string;
  /** Is the element currently adopted by a host (vs parked off-screen)? */
  adopted: boolean;
  hasUrl: boolean;
  /** Local filename that came with the url, or null. */
  name: string | null;
  hasStream: boolean;
}

/**
 * The DOM operations the registry needs, injected so the core unit-tests under
 * `environment: 'node'`. `E` is the element type, `H` the host container type.
 */
export interface NodeMediaOps<E, H> {
  /** Mint the persistent element for a (nodeId, slot). Called AT MOST ONCE per
   *  key for the life of the node. */
  create(nodeId: string, slot: string, kind: NodeMediaKind): E;
  /** Move `el` into `host` (a DOM move — never a clone; the element identity
   *  is what the engine holds via attachExternalSource). */
  mount(el: E, host: H): void;
  /** Move `el` back to the off-screen parking container. */
  park(el: E): void;
  /** Remove `el` from the document entirely (node deletion only). */
  destroy(el: E): void;
  revokeUrl(url: string): void;
  stopStream(stream: MediaStream): void;
}

export type NodeMediaKind = 'video' | 'img';

/** A card's claim on a node's element. `release()` is idempotent AND
 *  owner-checked: it does nothing once another host has adopted the element. */
export interface NodeMediaLease<E> {
  readonly el: E;
  release(): void;
}

export interface NodeMediaRegistry<E, H> {
  /**
   * Adopt (nodeId, slot)'s persistent element into `host`, creating it on
   * first use. ALWAYS succeeds and TRANSFERS ownership away from any previous
   * host — see the header for why that, rather than refusing, is what makes
   * double-mount safe.
   *
   * `init` runs exactly once, at creation, so a card can stamp attributes
   * (playsinline / muted / crossorigin / data-testid) without re-applying them
   * on every remount.
   */
  adopt(nodeId: string, slot: string, host: H, opts?: {
    kind?: NodeMediaKind;
    init?: (el: E) => void;
  }): NodeMediaLease<E>;

  /** The element for (nodeId, slot) if it exists — never creates one. */
  peek(nodeId: string, slot: string): E | null;

  /**
   * Give the registry ownership of an object URL for (nodeId, slot). The
   * PREVIOUS url for that key is revoked. Passing null revokes and clears.
   * A card must never revoke an object URL itself — that is the specific
   * teardown that made the loaded file unrecoverable on collapse.
   */
  setObjectUrl(nodeId: string, slot: string, url: string | null, name?: string | null): void;
  objectUrl(nodeId: string, slot: string): string | null;

  /**
   * The local FILENAME that came with the bytes, stored beside the url.
   *
   * It lives here for the same reason the url does: a card's `localFileName` /
   * `slotNames` were card-local `$state`, so a remount came up believing the
   * node had no local file — which re-showed the "re-link your file" prompt
   * and let the transport pause a video that was in fact still playing. Cards
   * REHYDRATE their reactive copy from this at adoption time.
   */
  mediaName(nodeId: string, slot: string): string | null;

  /**
   * Give the registry ownership of a MediaStream for (nodeId, slot). The
   * PREVIOUS stream's tracks are stopped. Passing null stops and clears.
   * A card must never stop tracks itself — that is what made loopback and
   * cameraInput UNRECOVERABLE (they need a fresh user gesture).
   */
  setStream(nodeId: string, slot: string, stream: MediaStream | null): void;
  stream(nodeId: string, slot: string): MediaStream | null;

  /** Full teardown for one node: stop streams, revoke urls, destroy elements.
   *  Called when the node leaves the GRAPH, never when a card unmounts. */
  disposeNode(nodeId: string): void;

  /** Dispose every node NOT present in `liveIds`. The graph is the authority
   *  on which nodes exist, so the registry is reconciled against it rather
   *  than relying on every delete path remembering to call disposeNode. */
  sweep(liveIds: Iterable<string>): void;

  /** Inspection for tests + the e2e probe. Never a population COUNT that
   *  anything asserts on — callers assert PROPERTIES of these rows. */
  snapshot(): NodeMediaSnapshot[];
}

interface Entry<E, H> {
  el: E;
  kind: NodeMediaKind;
  owner: H | null;
  url: string | null;
  /** Local filename for `url` — see NodeMediaRegistry.mediaName. */
  name: string | null;
  stream: MediaStream | null;
}

function key(nodeId: string, slot: string): string {
  return `${nodeId} ${slot}`;
}

/** Build a registry over injected DOM ops. See the header for the invariants. */
export function createNodeMediaRegistry<E, H>(
  ops: NodeMediaOps<E, H>,
): NodeMediaRegistry<E, H> {
  const entries = new Map<string, Entry<E, H>>();
  /** nodeId -> its slot keys, so disposeNode/sweep need no key parsing. */
  const byNode = new Map<string, Set<string>>();

  function entryFor(
    nodeId: string,
    slot: string,
    kind: NodeMediaKind,
    init?: (el: E) => void,
  ): Entry<E, H> {
    const k = key(nodeId, slot);
    const existing = entries.get(k);
    if (existing) return existing;
    const el = ops.create(nodeId, slot, kind);
    if (init) init(el);
    const entry: Entry<E, H> = { el, kind, owner: null, url: null, name: null, stream: null };
    entries.set(k, entry);
    let slots = byNode.get(nodeId);
    if (!slots) { slots = new Set(); byNode.set(nodeId, slots); }
    slots.add(k);
    // A freshly created element starts PARKED, so it is in the document (and
    // therefore decoding) even before any card adopts it.
    ops.park(el);
    return entry;
  }

  function disposeKey(k: string): void {
    const e = entries.get(k);
    if (!e) return;
    if (e.stream) { try { ops.stopStream(e.stream); } catch { /* */ } }
    if (e.url) { try { ops.revokeUrl(e.url); } catch { /* */ } }
    try { ops.destroy(e.el); } catch { /* */ }
    entries.delete(k);
  }

  return {
    adopt(nodeId, slot, host, opts) {
      const entry = entryFor(nodeId, slot, opts?.kind ?? 'video', opts?.init);
      // TRANSFER: the newest host always wins, so mount/unmount ORDER between
      // two component trees cannot strand the element.
      entry.owner = host;
      ops.mount(entry.el, host);
      let released = false;
      return {
        el: entry.el,
        release(): void {
          if (released) return;
          released = true;
          // OWNER CHECK: if someone else has since adopted, this teardown is
          // from a stale mount and must do nothing. This is the property that
          // makes "the first to unmount detaches the survivor" impossible.
          if (entry.owner !== host) return;
          entry.owner = null;
          try { ops.park(entry.el); } catch { /* */ }
        },
      };
    },

    peek(nodeId, slot) {
      return entries.get(key(nodeId, slot))?.el ?? null;
    },

    setObjectUrl(nodeId, slot, url, name) {
      const k = key(nodeId, slot);
      const e = entries.get(k);
      if (!e) {
        // No element yet (a load racing the mount). Park the url on a
        // lazily-created entry so it is still owned + revoked correctly.
        if (url === null) return;
        const created = entryFor(nodeId, slot, 'video');
        created.url = url;
        created.name = name ?? null;
        return;
      }
      if (e.url && e.url !== url) { try { ops.revokeUrl(e.url); } catch { /* */ } }
      e.url = url;
      // A null url clears the name too; omitting `name` on a set keeps it.
      if (url === null) e.name = null;
      else if (name !== undefined) e.name = name;
    },
    objectUrl(nodeId, slot) {
      return entries.get(key(nodeId, slot))?.url ?? null;
    },
    mediaName(nodeId, slot) {
      return entries.get(key(nodeId, slot))?.name ?? null;
    },

    setStream(nodeId, slot, stream) {
      const k = key(nodeId, slot);
      const e = entries.get(k);
      if (!e) {
        if (stream === null) return;
        const created = entryFor(nodeId, slot, 'video');
        created.stream = stream;
        return;
      }
      if (e.stream && e.stream !== stream) {
        try { ops.stopStream(e.stream); } catch { /* */ }
      }
      e.stream = stream;
    },
    stream(nodeId, slot) {
      return entries.get(key(nodeId, slot))?.stream ?? null;
    },

    disposeNode(nodeId) {
      const slots = byNode.get(nodeId);
      if (!slots) return;
      for (const k of slots) disposeKey(k);
      byNode.delete(nodeId);
    },

    sweep(liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
      for (const nodeId of [...byNode.keys()]) {
        if (!live.has(nodeId)) {
          const slots = byNode.get(nodeId)!;
          for (const k of slots) disposeKey(k);
          byNode.delete(nodeId);
        }
      }
    },

    snapshot() {
      const out: NodeMediaSnapshot[] = [];
      for (const [nodeId, slots] of byNode) {
        for (const k of slots) {
          const e = entries.get(k);
          if (!e) continue;
          out.push({
            nodeId,
            slot: k.slice(nodeId.length + 1),
            adopted: e.owner !== null,
            hasUrl: e.url !== null,
            name: e.name,
            hasStream: e.stream !== null,
          });
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// The real-DOM singleton the cards use.
// ---------------------------------------------------------------------------

const PARKING_ID = 'pt-node-media-parking';

/** The off-screen parking container. Real dimensions, NEVER display:none —
 *  a non-rendered <video> can freeze the engine's texture upload (see header). */
function parkingHost(): HTMLElement {
  let host = document.getElementById(PARKING_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = PARKING_ID;
    host.setAttribute('data-testid', 'node-media-parking');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;left:-9999px;top:0;width:320px;height:240px;' +
      'overflow:hidden;pointer-events:none;z-index:-1;';
    document.body.appendChild(host);
  }
  return host;
}

/** Real-DOM ops. Split out so the singleton is a thin binding of the pure core. */
export const browserNodeMediaOps: NodeMediaOps<HTMLElement, HTMLElement> = {
  create(_nodeId, _slot, kind) {
    return document.createElement(kind === 'img' ? 'img' : 'video');
  },
  mount(el, host) {
    if (el.parentNode !== host) host.appendChild(el);
  },
  park(el) {
    const host = parkingHost();
    if (el.parentNode !== host) host.appendChild(el);
  },
  destroy(el) {
    el.remove();
  },
  revokeUrl(url) {
    URL.revokeObjectURL(url);
  },
  stopStream(stream) {
    for (const t of stream.getTracks()) t.stop();
  },
};

/**
 * The process-wide node-media registry. Cards call
 * `nodeMedia.adopt(id, slot, hostDiv, { init })` on mount and `release()` on
 * unmount; they must NOT revoke urls or stop tracks themselves.
 *
 * SSR-safe: the ops only touch `document` when first used, and a card only
 * calls in from an effect/onMount (client-only).
 */
export const nodeMedia: NodeMediaRegistry<HTMLElement, HTMLElement> =
  createNodeMediaRegistry(browserNodeMediaOps);
