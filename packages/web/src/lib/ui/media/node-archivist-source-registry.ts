// packages/web/src/lib/ui/media/node-archivist-source-registry.ts
//
// THE NODE-SCOPED OWNER OF THE ARCHIVIST SOURCE — the archive.org search/load
// chain, the three node-owned media elements, the engine attach, the audio wire,
// the transport and both polling loops, on GRAPH lifetime instead of card
// lifetime.
//
// Third and last of the DOM-source three (loopback, cameraInput, archivist).
// Read `./node-loopback-source-registry`'s header for the argument the three
// share; what follows is only what is different about ARCHIVIST — and here the
// difference is SIZE rather than kind. This card was the widest carry on the
// whole face-migration roster, because it is all controls: a free-text search, a
// media-type filter, two year bounds, a ↻ re-roll, four transport actions and a
// seek bar, over three media elements of different types.
//
// ── 1. THREE SLOTS, NOT ONE, AND THEY ARE INDEPENDENT ───────────────────────
//
// `video`, `audio` and `image` are separate `nodeMedia` slots so an item that
// switches TYPE does not disturb the other two. Only one is ever the live source
// at a time; which one is a function of the loaded item.
//
// ── 2. NOTHING HERE NEEDS A USER GESTURE ────────────────────────────────────
//
// Unlike its two siblings, archivist acquires over the NETWORK: `fetch` to
// archive.org's search and metadata endpoints, then a URL on an element. So the
// synchronous-reach constraint that shapes the other two controllers does not
// apply, and this one may (and does) load a saved item on its own the moment the
// node appears.
//
// ⚠ WHICH IS EXACTLY WHY THE STAKES ARE HIGHER, and the inventory record said so
// before this extraction existed: camera and loopback lose a way to START a
// source that would otherwise be running, whereas a FRESH archivist has NO item
// at all — `node.data.item` is null until a search writes one, and nothing
// searches on its own. A surface that cannot reach the search box is not a
// degraded module, it is a media source that can never be given any media.
//
// ── 3. THE QUERY IS READ FROM THE GRAPH, NEVER FROM A SURFACE ───────────────
//
// ⚠ CARRIED OVER VERBATIM AND WORTH KEEPING VERBATIM. Three mounts of
// `ArchivistBrowseControls` can write the four query keys (the card's, the dock
// body's, the lane tile's) and a rack-mate can write them over Yjs. A query
// composed from any surface's own local copy would be a fourth opinion, and
// which one ran would depend on which button was pressed. So `search` takes no
// arguments and this controller reads the graph at the moment it acts. The card
// had already repaired a WRITE-ONLY mirror here — it wrote all four keys for
// multiplayer and never read them back, so a rack-mate's typing left it
// searching a stale local copy.
//
// ── 4. TWO POLLING LOOPS, AND ONE OF THEM IS WHY THE PLAYHEAD IS NOT IN YJS ──
//
// A 33 ms gate poll (`cv_play_trigger` rising edge → togglePlay) and a 100 ms
// display refresh that pushes the playhead into the engine's extras and mirrors
// the position into the published status. The position is PUBLISHED rather than
// written to the doc precisely because it ticks ten times a second; a Y.Doc
// write at that rate is the CV-modulation write-storm shape.
//
// PURE — no DOM, no globals, no timers of its own. Every outside edge is
// injected so the whole chain unit-tests in the web package's
// `environment: 'node'` lane. The browser binding is
// `./node-archivist-source.svelte.ts`.

import type { ModuleNode } from '$lib/graph/types';
import type { ArchivistItemMeta } from '$lib/video/modules/archivist';
import type {
  ArchiveFile,
  ArchivistDoc,
  ArchivistMediaType,
  ParsedMetadata,
  QuerySpec,
  RawMetadataResponse,
  RawSearchResponse,
  SearchUrlOpts,
} from '$lib/video/modules/archivist-query';
import { clampSeek, positionFraction, randomSeek, skipBy } from '$lib/video/modules/archivist-scrub';

/** The three `nodeMedia` slots this controller owns. */
export const ARCHIVIST_SLOTS = {
  video: 'video',
  audio: 'audio',
  image: 'image',
} as const;

/** The `cv_play_trigger` gate poll, and the display/playhead refresh. Both
 *  verbatim from the card. */
export const GATE_INTERVAL_MS = 33;
export const DISPLAY_INTERVAL_MS = 100;
/** The audio-wire retry, verbatim from the card (~5s). */
export const AUDIO_WIRE_DELAY_MS = 100;
export const AUDIO_WIRE_ATTEMPTS = 50;
/**
 * Max wait for a media element to reach HAVE_METADATA before the item counts as
 * un-playable. archive.org's CDN can be slow, but 12s is well past a normal
 * first-byte → metadata for any decodable file; a hang past this means the
 * derivative is not HTML5-playable on this engine.
 *
 * ⚠ ITS ABSENCE WAS THE ORIGINAL BUG: with no error/timeout handler the card
 * span at "Loading" / 0:00 forever on a derivative that could not decode.
 */
export const META_TIMEOUT_MS = 12_000;

export type ArchivistSourceCommand =
  | { kind: 'search' }
  | { kind: 'next' }
  | { kind: 'togglePlay' }
  | { kind: 'skip'; deltaS: number }
  | { kind: 'seek'; positionS: number }
  | { kind: 'jumpRandom' };

export interface ArchivistSourceStatus {
  readonly loading: boolean;
  /** WHICH item is being fetched — prose a surface paints while it waits. */
  readonly statusMsg: string | null;
  /** The recovery instruction for a failure, or null. */
  readonly errorMsg: string | null;
  /** How many docs the last search page holds. Zero means ↻ next cannot promise
   *  a re-roll and must run a fresh search instead. */
  readonly docCount: number;
  /** The scrubber's live position. The ONE field that ticks, which is why it is
   *  published rather than written to the doc ten times a second. */
  readonly positionSec: number;
  /** Has the engine confirmed it holds a source for this node? */
  readonly attached: boolean;
}

export const NO_ARCHIVIST_SOURCE: ArchivistSourceStatus = {
  loading: false,
  statusMsg: null,
  errorMsg: null,
  docCount: 0,
  positionSec: 0,
  attached: false,
};

export interface ArchivistRequestResult {
  readonly delivered: boolean;
  readonly error: unknown;
}

/** The engine handle's archivist extras, narrowed to what the controller uses. */
export interface ArchivistExtras {
  wireAudio(): void;
  unwireAudio(): void;
  isAudioWired(): boolean;
  setPlayhead(frac: number): void;
  setPlaying(on: boolean): void;
  fireLoaded(): void;
  fireEnded(): void;
}

export interface ArchivistSourceEngine {
  /** `attachExternalSource(nodeId, kind, el)`. */
  attach(nodeId: string, kind: 'video' | 'image', el: unknown | null): void;
  hasSource(nodeId: string): boolean;
  extras(nodeId: string): ArchivistExtras | null;
  readParam(node: ModuleNode, paramId: string): number | undefined;
}

export interface ArchivistSourceMedia<E> {
  ensure(nodeId: string, slot: string): E;
}

/** Element operations, split by the two families the card treats differently.
 *  IMAGES decode; MEDIA reach metadata. */
export interface ArchivistElementOps<E> {
  setCrossOrigin(el: E, value: string | null): void;
  setSrc(el: E, url: string): void;
  /** Resolve TRUE when an `<img>` has decoded, FALSE on error. */
  awaitImageLoad(el: E): Promise<boolean>;
  /** Resolve TRUE at HAVE_METADATA, FALSE on error or timeout. */
  awaitMetadata(el: E, timeoutMs: number): Promise<boolean>;
  duration(el: E): number;
  currentTime(el: E): number;
  seek(el: E, to: number): void;
  paused(el: E): boolean;
  ended(el: E): boolean;
  play(el: E): void;
  pause(el: E): void;
  /** Subscribe to the element's `ended` event; returns the unsubscribe. */
  onEnded(el: E, fn: () => void): () => void;
}

/**
 * The archive.org edge.
 *
 * ⚠ TYPED AGAINST `archivist-query`'s OWN TYPES rather than structural
 * stand-ins. That module is already pure (no DOM, no fetch — it only builds URLs
 * and parses payloads) and is unit-tested on its own, so importing its types
 * here costs the node lane nothing and buys the thing a stand-in cannot: a
 * rename or a shape change in the parser reddens at the seam instead of being
 * absorbed by a hand-written mirror that drifts.
 */
export interface ArchivistIo {
  searchUrl(spec: QuerySpec, opts: SearchUrlOpts): string;
  /** The one genuinely injected edge — a real `fetch` in the browser, a fake in
   *  the tests. Typed `unknown` because the two parsers below narrow it. */
  fetchJson(url: string): Promise<unknown>;
  metadataUrl(identifier: string): string;
  parseSearch(json: RawSearchResponse): ArchivistDoc[];
  parseMetadata(json: RawMetadataResponse, identifier: string): ParsedMetadata;
  pickRandomDoc(docs: ArchivistDoc[]): ArchivistDoc | null;
  pickBestFile(
    files: ArchiveFile[],
    type: Exclude<ArchivistMediaType, 'any'>,
  ): ArchiveFile | null;
  fileUrl(meta: ParsedMetadata, name: string): string;
  concreteTypeFromMediatype(m: string): Exclude<ArchivistMediaType, 'any'> | null;
  hasCleanOutput(t: Exclude<ArchivistMediaType, 'any'>): boolean;
}

/** The graph read/write. */
export interface ArchivistSourceDoc {
  /** The four query keys, read at the moment a search runs — see header note 3. */
  query(nodeId: string): {
    term: string;
    mediatype: ArchivistMediaType;
    yearFrom: number | null;
    yearTo: number | null;
  };
  item(nodeId: string): ArchivistItemMeta | null;
  isPlaying(nodeId: string): boolean;
  writeItem(nodeId: string, meta: ArchivistItemMeta | null): void;
  writePlaying(nodeId: string, on: boolean): void;
  /** Reassign the WHOLE item object — an in-place nested mutation does not
   *  re-trigger a node re-render, which left the duration readout and the seek
   *  `max` pinned at 0 after metadata landed. */
  writeDuration(nodeId: string, identifier: string, durationSec: number): void;
}

export interface ArchivistSourceClock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ArchivistSourceDeps<E> {
  engine: ArchivistSourceEngine | null;
  media: ArchivistSourceMedia<E>;
  el: ArchivistElementOps<E>;
  io: ArchivistIo;
  doc: ArchivistSourceDoc;
  clock: ArchivistSourceClock;
  onStatus?(nodeId: string, status: ArchivistSourceStatus): void;
}

export interface NodeArchivistSourceRegistry<E> {
  sync(nodes: readonly ModuleNode[], engine: ArchivistSourceEngine | null): void;
  view(nodeId: string): ArchivistSourceStatus;
  request(nodeId: string, cmd: ArchivistSourceCommand): ArchivistRequestResult;
  has(nodeId: string): boolean;
  disposeNode(nodeId: string): void;
  sweep(liveIds: Iterable<string>): void;
  snapshot(): Array<{ nodeId: string } & ArchivistSourceStatus>;
}

/**
 * The types whose archivist-style source this registry owns.
 *
 * ⚠ ANCHORED IN BOTH DIRECTIONS by `dom-source-modules.test.ts`. With archivist
 * out, `DOM_SOURCE_LANE_TYPES` is EMPTY — see that file for what the set's
 * emptiness now asserts and what it stops being able to assert.
 */
export const NODE_ARCHIVIST_SOURCE_TYPES: ReadonlySet<string> = new Set<string>(['archivist']);

interface Controller<E> {
  node: ModuleNode;
  video: E;
  audio: E;
  image: E;
  status: ArchivistSourceStatus;
  lastDocs: ArchivistDoc[];
  gate: unknown | null;
  display: unknown | null;
  audioWire: unknown | null;
  offEnded: Array<() => void>;
  lastGateValue: number;
  /** Guards the sync-time "a peer loaded an item" reaction against re-attaching
   *  the item this controller loaded itself. */
  attachedIdentifier: string | null;
  disposed: boolean;
  dispose(): void;
}

export function createNodeArchivistSourceRegistry<E>(
  deps: ArchivistSourceDeps<E>,
): NodeArchivistSourceRegistry<E> {
  const controllers = new Map<string, Controller<E>>();

  function publish(c: Controller<E>, next: Partial<ArchivistSourceStatus>): void {
    const merged: ArchivistSourceStatus = { ...c.status, ...next };
    const same =
      merged.loading === c.status.loading &&
      merged.statusMsg === c.status.statusMsg &&
      merged.errorMsg === c.status.errorMsg &&
      merged.docCount === c.status.docCount &&
      merged.positionSec === c.status.positionSec &&
      merged.attached === c.status.attached;
    if (same) return;
    c.status = merged;
    deps.onStatus?.(c.node.id, merged);
  }

  function extras(c: Controller<E>): ArchivistExtras | null {
    return deps.engine?.extras(c.node.id) ?? null;
  }

  /** The element carrying the loaded item, or null for an image / no item. */
  function activeMediaEl(c: Controller<E>): E | null {
    const t = deps.doc.item(c.node.id)?.type;
    if (t === 'audio') return c.audio;
    if (t === 'video') return c.video;
    return null;
  }

  function durationOf(c: Controller<E>): number {
    return deps.doc.item(c.node.id)?.duration ?? 0;
  }

  function ensureAudioWired(c: Controller<E>, attempt = 0): void {
    if (c.audioWire !== null) {
      deps.clock.clearTimeout(c.audioWire);
      c.audioWire = null;
    }
    const e = extras(c);
    e?.wireAudio();
    if (e?.isAudioWired()) return;
    if (attempt >= AUDIO_WIRE_ATTEMPTS) return;
    c.audioWire = deps.clock.setTimeout(
      () => ensureAudioWired(c, attempt + 1),
      AUDIO_WIRE_DELAY_MS,
    );
  }

  /**
   * Point the right element at the item's URL and wire it into the engine.
   *
   * Returns TRUE when the element actually loaded. FALSE lets the caller SKIP a
   * failed derivative and advance to the next random match — which is what puts
   * the user on a playable item instead of leaving them at "Loading".
   *
   * ⚠ THE THREE crossOrigin DECISIONS ARE NOT INTERCHANGEABLE and each is
   * carried over verbatim:
   *   image — 'anonymous', so the texture is untainted and can be sampled;
   *   audio — 'anonymous', so a MediaElementSource is untainted;
   *   video — NONE, because archive.org video lacks CORS and setting
   *           crossorigin BLOCKS PLAYBACK ENTIRELY. Play-only, never textured.
   */
  async function attachMedia(c: Controller<E>, meta: ArchivistItemMeta): Promise<boolean> {
    const nodeId = c.node.id;
    // ⚠ CLAIM THE IDENTIFIER BEFORE THE FIRST AWAIT, NOT AFTER THE LAST ONE.
    //
    // This is a re-entrancy guard, and the bug it fixes is worth writing down
    // because every gate except one was blind to it. `loadItem` writes the item
    // to the Y.Doc BEFORE calling this; that write moves `snapshot.nodes`, which
    // re-runs Canvas's sync effect, which sees `item.identifier !==
    // attachedIdentifier` and calls `attachMedia` AGAIN — concurrently, on the
    // same element. Each call sets `src`, and setting `src` RESTARTS the
    // resource-selection algorithm, cancelling the load the previous call was
    // awaiting. `writeDuration` then writes the doc again, so the churn is
    // self-sustaining.
    //
    // MEASURED before the fix: `readyState 0, networkState 2 (LOADING),
    // buffered 0, duration NaN` — for as long as the element was observed, while
    // `paused` was false and the face reported the item loaded. Every assertion
    // about the item, the search, the graph and the transport stayed GREEN; the
    // only thing that could see it was a leg that measured MEDIA PROGRESS
    // (`face-archivist.spec.ts`'s SCREEN OFF leg, `0.000 s over 361 samples`).
    // Claiming here makes the re-entrant call a no-op instead of a restart.
    if (c.attachedIdentifier === meta.identifier) {
      // Already attached (or attaching) — a re-entrant call from the graph tick
      // the load's own doc write caused. Doing nothing is the whole fix.
      return true;
    }
    c.attachedIdentifier = meta.identifier;
    extras(c)?.unwireAudio();

    if (meta.type === 'image') {
      deps.el.setCrossOrigin(c.image, 'anonymous');
      deps.el.setSrc(c.image, meta.fileUrl);
      const ok = await deps.el.awaitImageLoad(c.image);
      if (c.disposed) return false;
      if (!ok) { c.attachedIdentifier = null; return false; }
      // Attach AFTER load so the factory's one-shot texImage2D sees a decoded img.
      try { deps.engine?.attach(nodeId, 'image', c.image); } catch { /* not ready */ }
      return true;
    }

    const el = meta.type === 'audio' ? c.audio : c.video;
    deps.el.setCrossOrigin(el, meta.type === 'audio' ? 'anonymous' : null);
    deps.el.setSrc(el, meta.fileUrl);
    const ok = await deps.el.awaitMetadata(el, META_TIMEOUT_MS);
    if (c.disposed) return false;
    // Release the claim on failure so the caller's next candidate can attach.
    if (!ok) { c.attachedIdentifier = null; return false; }
    deps.doc.writeDuration(nodeId, meta.identifier, deps.el.duration(el));
    // The factory's audio path takes any media element; the 'video' kind means
    // "attach for playback, not texturing".
    try { deps.engine?.attach(nodeId, 'video', el); } catch { /* not ready */ }
    // A video item's audio track is tainted too (no CORS), so wiring it is
    // best-effort — it tolerates failure rather than refusing the item.
    ensureAudioWired(c);
    return true;
  }

  async function loadItem(c: Controller<E>, doc: ArchivistDoc): Promise<boolean> {
    const nodeId = c.node.id;
    publish(c, { loading: true, statusMsg: `Loading "${doc.title}"…`, errorMsg: null });
    try {
      const raw = (await deps.io.fetchJson(deps.io.metadataUrl(doc.identifier))) as RawMetadataResponse;
      const meta = deps.io.parseMetadata(raw, doc.identifier);
      if (c.disposed) return false;
      if (meta.restricted) return false;

      const wanted = deps.doc.query(nodeId).mediatype;
      const concrete =
        wanted === 'any'
          ? deps.io.concreteTypeFromMediatype(doc.mediatype)
          : wanted;
      if (!concrete) return false;

      const file = deps.io.pickBestFile(meta.files, concrete);
      if (!file) return false;

      const itemMeta: ArchivistItemMeta = {
        identifier: doc.identifier,
        title: meta.title || doc.title,
        type: concrete,
        fileUrl: deps.io.fileUrl(meta, file.name),
        duration: 0,
        cleanOutput: deps.io.hasCleanOutput(concrete),
      };
      deps.doc.writeItem(nodeId, itemMeta);
      const ok = await attachMedia(c, itemMeta);
      if (c.disposed) return false;
      if (!ok) {
        // The picked derivative would not decode. Clear it and let the caller
        // advance rather than hanging at "Loading".
        deps.doc.writeItem(nodeId, null);
        c.attachedIdentifier = null;
        try { deps.engine?.attach(nodeId, 'video', null); } catch { /* */ }
        publish(c, { statusMsg: `Couldn't play "${doc.title}" — skipping…` });
        return false;
      }
      publish(c, { statusMsg: null });
      extras(c)?.fireLoaded();
      return true;
    } catch (e) {
      publish(c, { errorMsg: `Load failed: ${(e as Error)?.message ?? 'unknown error'}` });
      return false;
    } finally {
      if (!c.disposed) publish(c, { loading: false });
    }
  }

  /** Try several random docs, so a page with some unplayable derivatives still
   *  lands the user on something. Bounded by BOTH an attempt cap and the number
   *  of distinct docs, so it can never spin. */
  async function loadRandomFromDocs(c: Controller<E>): Promise<void> {
    const tried = new Set<string>();
    const maxAttempts = Math.min(8, c.lastDocs.length);
    for (let a = 0; a < maxAttempts && tried.size < c.lastDocs.length; a++) {
      if (c.disposed) return;
      const doc = deps.io.pickRandomDoc(c.lastDocs);
      if (!doc || tried.has(doc.identifier)) continue;
      tried.add(doc.identifier);
      if (await loadItem(c, doc)) return;
    }
    if (c.disposed) return;
    publish(c, {
      statusMsg: null,
      errorMsg: 'Could not find a playable item in the results — try another term or “↻ next”.',
    });
  }

  async function runSearch(c: Controller<E>): Promise<void> {
    publish(c, { errorMsg: null, loading: true, statusMsg: 'Searching archive.org…' });
    try {
      const url = deps.io.searchUrl(deps.doc.query(c.node.id), { rows: 50, random: true });
      c.lastDocs = deps.io.parseSearch((await deps.io.fetchJson(url)) as RawSearchResponse);
      if (c.disposed) return;
      publish(c, { docCount: c.lastDocs.length });
      if (c.lastDocs.length === 0) {
        publish(c, { statusMsg: null, errorMsg: 'No results — try another term or media type.' });
        return;
      }
      await loadRandomFromDocs(c);
    } catch (e) {
      if (c.disposed) return;
      publish(c, {
        statusMsg: null,
        errorMsg: `Search failed: ${(e as Error)?.message ?? 'unknown error'}`,
      });
    } finally {
      if (!c.disposed) publish(c, { loading: false });
    }
  }

  async function nextRandom(c: Controller<E>): Promise<void> {
    if (c.lastDocs.length === 0) { await runSearch(c); return; }
    await loadRandomFromDocs(c);
  }

  function togglePlay(c: Controller<E>): void {
    const el = activeMediaEl(c);
    const next = !deps.doc.isPlaying(c.node.id);
    deps.doc.writePlaying(c.node.id, next);
    if (!el) return;
    if (next) deps.el.play(el);
    else deps.el.pause(el);
  }

  /** Absolute seek. Clamped HERE rather than at a surface: the clamp is a
   *  property of the LOADED ITEM's duration, which only this owner is guaranteed
   *  to have — a surface can be mounted before metadata lands. */
  function seekTo(c: Controller<E>, positionS: number): void {
    const dur = durationOf(c);
    const target = clampSeek(positionS, dur);
    const el = activeMediaEl(c);
    if (el) deps.el.seek(el, target);
    publish(c, { positionSec: target });
    extras(c)?.setPlayhead(positionFraction(target, dur));
  }

  function skip(c: Controller<E>, deltaS: number): void {
    const el = activeMediaEl(c);
    if (!el) return;
    const target = skipBy(deps.el.currentTime(el), deltaS, durationOf(c));
    deps.el.seek(el, target);
    publish(c, { positionSec: target });
  }

  function jumpRandom(c: Controller<E>): void {
    const el = activeMediaEl(c);
    if (!el) return;
    const target = randomSeek(durationOf(c));
    deps.el.seek(el, target);
    publish(c, { positionSec: target });
  }

  function refreshDisplay(c: Controller<E>): void {
    const el = activeMediaEl(c);
    const e = extras(c);
    if (!el) { e?.setPlaying(false); return; }
    const now = deps.el.currentTime(el);
    publish(c, {
      positionSec: now,
      attached: deps.engine?.hasSource(c.node.id) ?? c.status.attached,
    });
    e?.setPlayhead(positionFraction(now, durationOf(c) || deps.el.duration(el)));
    e?.setPlaying(!deps.el.paused(el) && !deps.el.ended(el));
  }

  function onEnded(c: Controller<E>): void {
    deps.doc.writePlaying(c.node.id, false);
    extras(c)?.fireEnded();
  }

  /** Bring the element's play state in line with the SHARED `isPlaying` flag —
   *  the thing that makes a rack-mate's transport press land here. */
  function applyPlaying(c: Controller<E>): void {
    const el = activeMediaEl(c);
    if (!el) return;
    const want = deps.doc.isPlaying(c.node.id);
    if (want && deps.el.paused(el)) deps.el.play(el);
    else if (!want && !deps.el.paused(el)) deps.el.pause(el);
  }

  function createController(node: ModuleNode): Controller<E> {
    const c: Controller<E> = {
      node,
      video: deps.media.ensure(node.id, ARCHIVIST_SLOTS.video),
      audio: deps.media.ensure(node.id, ARCHIVIST_SLOTS.audio),
      image: deps.media.ensure(node.id, ARCHIVIST_SLOTS.image),
      status: { ...NO_ARCHIVIST_SOURCE },
      lastDocs: [],
      gate: null,
      display: null,
      audioWire: null,
      offEnded: [],
      lastGateValue: 0,
      attachedIdentifier: null,
      disposed: false,
      dispose(): void {
        c.disposed = true;
        if (c.gate !== null) { deps.clock.clearInterval(c.gate); c.gate = null; }
        if (c.display !== null) { deps.clock.clearInterval(c.display); c.display = null; }
        if (c.audioWire !== null) { deps.clock.clearTimeout(c.audioWire); c.audioWire = null; }
        for (const off of c.offEnded) off();
        c.offEnded = [];
        // NOTE what is deliberately ABSENT even HERE: no detach, no unwireAudio.
        // `nodeMedia.disposeNode` retires the three elements when the node
        // leaves the graph, and the engine node goes with it. Detaching first
        // would only race that.
      },
    };

    // `ended` fires on the VIDEO and the AUDIO element alike.
    for (const el of [c.video, c.audio]) {
      c.offEnded.push(deps.el.onEnded(el, () => { if (!c.disposed) onEnded(c); }));
    }

    // ── THE GATE POLL (cv_play_trigger rising edge → togglePlay) ────────────
    c.gate = deps.clock.setInterval(() => {
      if (c.disposed) return;
      const v = deps.engine?.readParam(c.node, 'cv_play_trigger');
      if (typeof v !== 'number') return;
      if (c.lastGateValue < 0.5 && v >= 0.5) togglePlay(c);
      c.lastGateValue = v;
    }, GATE_INTERVAL_MS);

    // ── THE DISPLAY / PLAYHEAD REFRESH ─────────────────────────────────────
    c.display = deps.clock.setInterval(() => {
      if (!c.disposed) refreshDisplay(c);
    }, DISPLAY_INTERVAL_MS);

    deps.onStatus?.(node.id, c.status);

    // ⚠ RE-ATTACH A SAVED ITEM. This is the line that makes a LOADED RACK come
    // back playable, and on the card it ran in `onMount` — so it happened when a
    // card mounted rather than when the node appeared, and on the default shell
    // it only happened at all because the headless host mounted one.
    const saved = deps.doc.item(node.id);
    if (saved) void attachMedia(c, saved);

    return c;
  }

  return {
    sync(nodes, engine) {
      deps.engine = engine;
      const live = new Set<string>();
      for (const n of nodes) {
        if (!NODE_ARCHIVIST_SOURCE_TYPES.has(n.type)) continue;
        live.add(n.id);
        const existing = controllers.get(n.id);
        if (!existing) {
          controllers.set(n.id, createController(n));
          continue;
        }
        existing.node = n;

        // ⚠ A PEER'S LOAD LANDS HERE, and it is the same shape as the camera's
        // external device pick: `node.data.item` is in Yjs, so a rack-mate
        // searching writes an item into a document this controller is holding
        // elements for. Attaching on a CHANGE of identifier is what turns that
        // write into a playing item; without it the rack-mate's tune would sit
        // in the doc and the local engine would keep the old source.
        const item = deps.doc.item(n.id);
        const wantId = item?.identifier ?? null;
        if (wantId !== existing.attachedIdentifier) {
          if (item) void attachMedia(existing, item);
          else existing.attachedIdentifier = null;
        }

        // ...and the shared transport flag, for the same reason.
        applyPlaying(existing);
      }
      for (const [id, c] of [...controllers]) {
        if (!live.has(id)) {
          c.dispose();
          controllers.delete(id);
        }
      }
    },

    view(nodeId) {
      return controllers.get(nodeId)?.status ?? NO_ARCHIVIST_SOURCE;
    },

    request(nodeId, cmd) {
      const c = controllers.get(nodeId);
      if (!c) return { delivered: false, error: null };
      try {
        switch (cmd.kind) {
          case 'search': void runSearch(c); break;
          case 'next': void nextRandom(c); break;
          case 'togglePlay': togglePlay(c); break;
          case 'skip': skip(c, cmd.deltaS); break;
          case 'seek': seekTo(c, cmd.positionS); break;
          case 'jumpRandom': jumpRandom(c); break;
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
      const out: Array<{ nodeId: string } & ArchivistSourceStatus> = [];
      for (const [nodeId, c] of controllers) out.push({ nodeId, ...c.status });
      return out;
    },
  };
}
