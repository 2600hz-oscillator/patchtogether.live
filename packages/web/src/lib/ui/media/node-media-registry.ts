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
// TWO CONSUMER SHAPES, ONE REGISTRY (#1589). A card that DISPLAYS the element
// calls `adopt`/`release` (videovarispeed, videobox, archivist, peertube…). A
// card whose element is only a TEXTURE SOURCE — never displayed, handed to the
// engine and pumped from there — calls `ensure` and gets the element back with
// no lease at all, because it has no host to mount into and nothing to release.
// TOYBOX's four per-layer <video>s are that second shape; before #1589 it minted
// them itself and destroyed them in `onDestroy`, which is exactly the bug this
// file exists to make unrepresentable. Both shapes share ONE element per
// (nodeId, slot), one url owner, one stream owner and one graph-keyed teardown.
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
  hasDisposer: boolean;
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

/** ARCHIVIST needs all three: an archive.org item can be a video, a still
 *  image, or an audio file, and the card picks the element per item. */
export type NodeMediaKind = 'video' | 'img' | 'audio';

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

  /**
   * Get (creating on first use) the persistent element for (nodeId, slot)
   * WITHOUT adopting it into a host — it stays PARKED off-screen for its whole
   * life. For a SOURCE-ONLY consumer: the element is never displayed, it is a
   * TEXTURE SOURCE the engine pumps frames out of.
   *
   * TOYBOX is the motivating case (#1589). Its per-layer <video>s are handed to
   * the engine through `attachLayerVideo` and are never rendered by the card at
   * all — the card previously minted them with `document.createElement('video')`
   * and destroyed them in `onDestroy`. `adopt` is the wrong verb for that shape:
   * there is no host to mount into, and a lease's `release()` would be a
   * per-card teardown API for something that has no per-card state.
   *
   * ⚠ Deliberately returns the ELEMENT, not a lease. There is nothing to
   * release, so there is no method a future `onDestroy` can call — the same
   * structural guard node-recorder-registry gets from having no `dispose()`.
   * The only teardowns remain `disposeNode` / `sweep`, both keyed to the GRAPH.
   */
  ensure(nodeId: string, slot: string, opts?: {
    kind?: NodeMediaKind;
    init?: (el: E) => void;
  }): E;

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

  /**
   * Register a teardown for anything the registry does not model itself —
   * the hls.js instance PEERTUBE / TVLIBRARIAN attach to their element being
   * the motivating case. It runs on node disposal, in the same sweep that
   * revokes urls and stops streams, and NEVER on a card unmount.
   *
   * Replacing a disposer runs the previous one first: a card that re-attaches
   * hls for a new stream hands over a new disposer, and the old instance must
   * not leak. Idempotent per entry — a disposer runs at most once.
   */
  setDisposer(nodeId: string, slot: string, dispose: (() => void) | null): void;

  /** Full teardown for one node: run disposers, stop streams, revoke urls,
   *  destroy elements. Called when the node leaves the GRAPH, never when a
   *  card unmounts. */
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
  /** Has a caller's `init` been applied to `el` yet? See entryFor's LATE INIT. */
  inited: boolean;
  owner: H | null;
  url: string | null;
  /** Local filename for `url` — see NodeMediaRegistry.mediaName. */
  name: string | null;
  stream: MediaStream | null;
  /** Extra teardown (hls.js, …) — see NodeMediaRegistry.setDisposer. */
  dispose: (() => void) | null;
}

// ⚠ The separator is spelled as an ESCAPE, never as a literal NUL byte. A
// raw 0x00 anywhere in a source file makes `grep` classify the WHOLE FILE as
// binary, so every search of it returns no matches — silently, exit code 1,
// indistinguishable from "the symbol does not exist". The runtime string is
// byte-identical either way, so the escape costs nothing.
//
// This file shipped with the raw byte, and `tracked-source-is-greppable` caught
// it on the guard's first real outing. `video/engine.ts` carried the same
// idiom and cost three agents time in a single day before anyone found it —
// one was pushed toward a fallback architecture it did not need, because a
// search for a symbol that WAS there came back empty.
function key(nodeId: string, slot: string): string {
  return `${nodeId}\u0000${slot}`;
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
    if (existing) {
      // LATE INIT — ORDER MUST NOT MATTER. `setObjectUrl`/`setStream`/
      // `setDisposer` create an entry themselves when a load races the mount,
      // and that path has no `init` to run. Without this, whether the element
      // ever received its attributes depended on which call happened FIRST.
      // MEASURED (#1589): TOYBOX wrote the url before minting the element, so
      // its layer <video> came up with no `muted`/`loop`/`playsinline`, never
      // autoplayed, and the layer stayed silently black — a bug in the fix for a
      // bug about layers staying silently black. "Init runs exactly once" is
      // preserved: the flag makes it once EVER, not once per call site.
      if (init && !existing.inited) {
        existing.inited = true;
        init(existing.el);
      }
      return existing;
    }
    const el = ops.create(nodeId, slot, kind);
    if (init) init(el);
    const entry: Entry<E, H> = {
      el, kind, inited: !!init, owner: null, url: null, name: null, stream: null, dispose: null,
    };
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
    // Disposer FIRST: hls.js must detach from the element before we destroy it.
    if (e.dispose) { const d = e.dispose; e.dispose = null; try { d(); } catch { /* */ } }
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

    ensure(nodeId, slot, opts) {
      // No owner transfer: the element is created PARKED by entryFor and stays
      // there. A host that later `adopt`s the same key still wins normally.
      return entryFor(nodeId, slot, opts?.kind ?? 'video', opts?.init).el;
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

    setDisposer(nodeId, slot, dispose) {
      const k = key(nodeId, slot);
      const e = entries.get(k) ?? entryFor(nodeId, slot, 'video');
      // Hand-over: the OUTGOING instance is torn down now, so re-attaching a
      // new hls for the same node cannot leak the previous one.
      if (e.dispose && e.dispose !== dispose) {
        const prev = e.dispose;
        e.dispose = null;
        try { prev(); } catch { /* */ }
      }
      e.dispose = dispose;
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
            hasDisposer: e.dispose !== null,
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
    return document.createElement(kind === 'img' ? 'img' : kind === 'audio' ? 'audio' : 'video');
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
