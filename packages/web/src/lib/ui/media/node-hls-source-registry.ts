// packages/web/src/lib/ui/media/node-hls-source-registry.ts
//
// NODE-OWNED HLS TUNER (LEG-02 P3, #1511) — the controller that makes PEERTUBE's
// and TV LIBRARIAN's stream exist, tune and keep playing because the NODE
// exists, not because a card is mounted.
//
// ── WHY ONE REGISTRY FOR TWO MODULES, WHEN P2 ARGUED FOR A SIBLING ──────────
//
// `./node-varispeed-registry` (P2) says, correctly: "Generalising on a
// population of two is how the wrong abstraction gets locked in." That argument
// was about VIDEOBOX vs VIDEOVARISPEED, which are two different TRANSPORT
// MODELS — a wall clock corrected against a sync triple, against seven virtual
// playheads advanced by speed x dt. Those do not rhyme, and forcing them
// together would have invented a shape neither has.
//
// PEERTUBE and TV LIBRARIAN are the opposite case, and the evidence is in the
// tree rather than in a prediction. They are ONE model — pick a candidate from a
// CATALOGUE, resolve it to an .m3u8, hand it to hls.js, wire the audio tap,
// advance on a trigger — and they are one model because peertube was WRITTEN by
// cloning tv-librarian: its own header says "CRITICAL AUDIO TRAP (bit
// tv-librarian)". The two cards' `attachStream`, `ensureAudioWired`,
// `markUnavailable`, `teardownHls` and trigger loops are line-for-line the same
// function with different identifiers.
//
// ⚠ AND THAT DUPLICATION HAS ALREADY COST A REAL BUG, which is the actual
// argument for unifying rather than a preference for fewer files. The `muted =
// false` step that un-gates a MediaElementSource existed in VIDEOBOX; TV
// LIBRARIAN shipped without it and its tuned stream's audio outputs carried
// silence until #785 (2026-06-14) copied it across. PEERTUBE was written the
// next day WITH the fix — i.e. correctness travelled by hand-copy, one module at
// a time, and the module that was written first is the one that shipped broken.
// A third clone of the same 200 lines is how that happens again. One
// implementation plus two PROFILES is how it cannot.
//
// The profiles below carry exactly what genuinely differs — where the catalogue
// comes from, how a candidate resolves to a URL, which CV params exist, and what
// shape the selection takes in `node.data`. Everything else is shared because it
// IS shared.
//
// ── THE FOUR LANE STATES, MEASURED OFF THE PURE DECISION ────────────────────
//
// `needsHeadlessSourceMount`'s `laneOmitsNode` arm returns
// `CARD_PRODUCER_LANE_TYPES.has(type)`, which is FALSE for both of these — they
// are DOM_SOURCE, not producers. So, run over
// `$lib/ui/workflow/dom-source-modules` for `peertube` and `tvLibrarian` (the
// answers are IDENTICAL for both):
//
//     lane placeholder (ordinary rack)  HOST     -> the off-screen card runs it
//     dock full view open               no host  -> the DOCK mounts the card
//     inside a COLLAPSED GROUP          NO CARD  -> everything below is DEAD
//     canvas-hidden / pinned            NO CARD  -> everything below is DEAD
//
// ⚠ AND THE COLLAPSED-GROUP ARM WAS NEVER SURFACE-SPECIFIC. Canvas's
// `flowNodes` derivation drops a collapsed group's children before the lane
// decision runs at all, so those two rows were dark whichever renderer the lane
// was using — measured on the pure decision, not inferred.
//
// ── THE THREE LIVE DEFECTS THIS FIXES ───────────────────────────────────────
//
// ⚠ 1. WITH NO CARD ANYWHERE, THE MODULE IS ENTIRELY DEAD — not degraded, dead,
// with every jack still visibly patched. Both cards owned ALL of this in their
// own component lifetime:
//
//   * `attachExternalSource(id,'video',el)` behind an `onMount` 100 ms poll. No
//     card, no attach: the engine node exists and its texture source is null, so
//     `video` is BLACK.
//   * the 33 ms CV poll. peertube's `play_trigger`/`next_trigger` and
//     tvLibrarian's `next`/`random` do nothing at all.
//   * the `$effect` that turns a PERSISTED selection into a playing stream. A
//     saved rack whose peertube had a video chosen, or whose tvLibrarian was
//     tuned to a channel, comes back on NOTHING — and a peer's tune never lands
//     either, so multiplayer is one-way.
//   * `ensureAudioWired()`. Without it `audio_l`/`audio_r` stay on the silent
//     ConstantSource placeholders AND the element stays `muted`, which is the
//     stronger failure: the mute gates the tap at the SOURCE.
//   * the catalogue fetch. Even a trigger that DID fire would have nothing to
//     advance to.
//   * peertube's 100 ms display loop, i.e. its `playhead` CV output and its
//     `playing` gate output.
//
// ⚠ 2. EVERY CARD REMOUNT RE-BUFFERED A STREAM THAT WAS ALREADY PLAYING, AND
// THIS ONE HITS AN ORDINARY RACK. `lastAttachedUrl` (tvLibrarian) and
// `lastAttached` (peertube) were plain component-scope `let`s with no
// persistence path. Expanding the dock full view moves the card from the
// headless host into the tray — an unmount plus a mount — so the guard
// re-initialised to null, the selection `$effect` re-ran, and `attachStream()`
// called `teardownHls()` on the LIVE demuxer and rebuilt it. Observable at the
// jacks, not just in the picture: tvLibrarian's `stream_online` gate drops to 0
// and only returns when the new manifest produces a frame, and peertube re-runs
// its per-instance details fetch. The node-owned `lastAttachedKey` below cannot
// be reset by a view appearing.
//
// ⚠ 3. A MID-FLIGHT AUDIO WIRE WAS ABANDONED AND THE ELEMENT STAYED MUTED
// FOREVER. `ensureAudioWired` retries every 100 ms up to 50 times, and both
// cards cleared that timer in `onDestroy`. The element is created `muted = true`
// so the programmatic `play()` is allowed; the un-mute happens only on the
// attempt that finds `isAudioWired()`. Unmount the card inside that ~5 s window
// — which a collapse, a dock open or a lane swap does — and the retry dies with
// the un-mute never performed, on an element the NODE keeps playing. The stream
// plays, the picture is fine, and both audio outputs carry silence with nothing
// left running to fix it. On the controller the retry outlives every surface.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// ⚠ PEERTUBE'S "no audio, red CI (#786)" IS NOT A LIVE DEFECT AND WAS NOT FIXED
// HERE. It is recorded in `e2e/tests/_face-fixtures.ts` and in older notes, and
// it is false in both halves: `git log -S'muted = false'` on `PeerTubeCard.svelte`
// returns exactly ONE commit, #786 itself, so the module was BORN with the
// un-mute the tv-librarian bug taught. Its audio is guarded on CI by
// `peertube.spec.ts`, which drives the real hls.js path over a mocked AVC/AAC
// fixture and asserts `peak > 0.01` at an AUDIO OUT terminal plus `muted ===
// false` on the element.
//
// ⚠ AND IT IS STRUCTURALLY NOT ARCHIVIST'S PROBLEM. archivist is video-only
// because archive.org media is CORS-TAINTED, so its element can decode and still
// poison a texture. That cannot happen on the hls.js path: `attachMedia()` points
// the element at a `blob:` MediaSource URL, which is SAME-ORIGIN by construction
// — the bytes reach it through hls.js's own fetches into MSE buffers, never as a
// cross-origin media resource. Cross-origin failures therefore surface as a
// FATAL hls error (-> `unavailable` -> auto-skip), never as a silently tainted or
// silently muted element. The one archivist-shaped path is the progressive-mp4
// fallback, and `crossOrigin = 'anonymous'` makes a missing ACAO fail the LOAD
// rather than taint it.
//
// ── OWNERSHIP ───────────────────────────────────────────────────────────────
//
// One controller per node, created by `sync(nodes, engine)` from Canvas's graph
// effect and disposed by the same `sweep(liveIds)` row that already retires
// `nodeMedia`, `nodeExtras`, `nodeVideoSource` and `nodeVarispeed`. It owns the
// element (`ensure`d PARKED, so it exists and decodes before any card mounts),
// the engine attach and its retry, the hls.js instance through `./node-hls`, the
// audio wire + un-mute retry, the load timeout, the unavailable auto-skip, the
// CV poll, the catalogue, the selection->stream application and (for peertube)
// the playhead loop.
//
// The CARD keeps only what a view owns: which host div the element is adopted
// into, the picker UI, and the gestures a mounted surface must originate. It
// creates nothing and disposes nothing.
//
// ⚠ THE EDGE DETECTOR IS MOVED VERBATIM, NOT "CORRECTED", for the reason P2
// states: CLAUDE.md's `createEdgeCounter` rule is about RE-SCANNING AN
// ANALYSERNODE BUFFER, where a 2048-sample ring overlaps the scheduler tick and
// one edge counts twice. This reads a SYNTHETIC CV PARAM the engine has already
// edge-shaped — one scalar per poll, no buffer — so the hazard does not apply and
// swapping mechanisms would be a behaviour change wearing a compliance costume.
//
// HASH TRANSPARENCY: `lib/ui/**`, NOT `lib/video/**`. That directory is hashed
// WHOLESALE for the WebGL attest, so a controller placed there would cost a
// real-GPU re-attest window for a pure lifetime move with no rendered pixel
// changed. Everything here reaches the engine through its EXISTING public
// surface — `attachExternalSource`, `read('extras')`, `read('hasVideoElement')`,
// `readParam` — and the query/dataset helpers are IMPORTED from
// `$lib/video/modules/**` and left untouched: reading a basis file costs nothing,
// editing one costs a GPU window. Do not move this file and do not "simplify" it
// by adding an engine-side hook.
//
// TESTABILITY: the web package's vitest runs in `environment: 'node'` (no jsdom),
// so every outside edge is INJECTED — the clock, the element ops, the hls.js
// player, the engine, the node.data reads/writes and the media registry.
// `nodeHlsSource` (./node-hls-source.svelte.ts) is the real binding;
// `createNodeHlsSourceRegistry` is the pure core the unit tests drive with fakes.

import type { ModuleNode } from '$lib/graph/types';
import {
  buildSearchUrl,
  parseSearchResponse,
  videoDetailsUrl,
  resolveStream as resolvePeerTubeStream,
  formatDuration,
  type RawSearchResponse,
  type RawVideoDetails,
  type PeerTubeVideo,
} from '$lib/video/modules/peertube-query';
import {
  countryChannelsUrl,
  parseChannels,
  filterChannels,
  nextChannel,
  randomChannel,
  languageLabel,
  type Channel,
} from '$lib/video/modules/tv-librarian-data';
import type { VideoSourceRequestResult } from './node-video-source-registry';

/** The media slot both tuners use.
 *
 *  ⚠ The CARD must adopt exactly the key the controller ensured. Both cards have
 *  always written `'main'`; a controller that ensured anything else would mint a
 *  SECOND, empty element and leave the card adopting the original. ONE spelling,
 *  exported, so the two cannot drift. */
export const HLS_SOURCE_SLOT = 'main';

/** How often the synthetic trigger params are polled for a rising edge. ~30 Hz,
 *  the rate both cards used. */
export const GATE_INTERVAL_MS = 33;

/** How often the playhead / transport mirror is refreshed. 10 Hz, the rate
 *  PeerTubeCard's display loop used. */
export const PLAYHEAD_INTERVAL_MS = 100;

/** Retry cadence + ceiling for the two things that race the engine's async
 *  `addNode`: the element ATTACH and the audio WIRE. Both are idempotent, so a
 *  retry is free; both give up quietly after the ceiling. Same numbers both
 *  cards used (100 ms x 50 = ~5 s). */
export const RETRY_INTERVAL_MS = 100;
export const RETRY_ATTEMPTS = 50;

/** How long an `unavailable` stream waits before the tuner skips onward. Both
 *  cards used 1800 ms, and the reason is unchanged: never HANG on a dead or
 *  CORS-misconfigured stream, but do not thrash a whole catalogue in a second
 *  either. */
export const UNAVAILABLE_SKIP_MS = 1_800;

/** The rising-edge threshold. Matches both cards' 0.5 crossing — see
 *  `$lib/audio/gate-trigger` for why 0.5 is the canonical gate level. */
const GATE_RISING_EDGE = 0.5;

// ---------------------------------------------------------------------------
// Published shape
// ---------------------------------------------------------------------------

export type HlsStreamState = 'idle' | 'loading' | 'playing' | 'unavailable';

/** ONE row of a tuner's catalogue, in the shape a SURFACE renders. The module's
 *  own row object rides along in `item` for the few fields only its card knows
 *  what to do with. */
export interface HlsCandidate {
  /** Stable identity. peertube: `host::uuid`; tvLibrarian: the channel nanoid. */
  readonly key: string;
  readonly label: string;
  /** The dim second line — channel/host/duration, or the language tag. */
  readonly sublabel: string;
  readonly thumbnailUrl: string | null;
  /** A short marker the surface may badge (tvLibrarian: `geo`). */
  readonly badge: string | null;
  /** The module's own row object (`PeerTubeVideo` / `Channel`). */
  readonly item: unknown;
}

/** What a SURFACE renders. Everything here is browser-LOCAL playback state: the
 *  SELECTION is synced through `node.data` and belongs to the rack, but whether
 *  THIS browser has reached the stream is not a fact about the rack. */
export interface HlsSourceStatus {
  readonly streamState: HlsStreamState;
  /** The persisted selection's key, or null when nothing is chosen. */
  readonly selectionKey: string | null;
  /** Its display name, from the catalogue or from `node.data`. */
  readonly selectionLabel: string | null;
  readonly catalogue: readonly HlsCandidate[];
  /** What the catalogue was fetched FOR — a search term, a country code. */
  readonly catalogueKey: string | null;
  readonly loadingCatalogue: boolean;
  readonly loadingStream: boolean;
  /** A failure to show the user, or null. */
  readonly error: string | null;
  /** A transient progress line ("Searching the fediverse..."), or null. */
  readonly statusMsg: string | null;
  /** Has the engine confirmed the element is attached? */
  readonly attached: boolean;
  /** Has the element's audio reached the cross-domain bridge? */
  readonly audioWired: boolean;
  readonly isPlaying: boolean;
  /** 0..1 position, for the modules that publish a playhead. */
  readonly playheadFrac: number;
}

/** The status a surface sees for a node with NO controller — a REAL state ("not
 *  in the graph, or the graph effect has not run yet"), not a missing value. */
export const NO_HLS_SOURCE: HlsSourceStatus = {
  streamState: 'idle',
  selectionKey: null,
  selectionLabel: null,
  catalogue: [],
  catalogueKey: null,
  loadingCatalogue: false,
  loadingStream: false,
  error: null,
  statusMsg: null,
  attached: false,
  audioWired: false,
  isPlaying: false,
  playheadFrac: 0,
};

/** The gestures a surface may invoke. Each is a USER ACTION that cannot
 *  originate anywhere else. `next` / `random` are here as WELL as on the CV
 *  poll because the same intent arrives from a button and from a cable. */
export type HlsSourceCommand =
  /** Re-fetch the catalogue for a key the surface just typed or picked. */
  | { kind: 'catalogue'; key: string }
  /** Tune to a catalogue row. */
  | { kind: 'select'; candidateKey: string }
  /** Advance / shuffle within the catalogue. */
  | { kind: 'next' }
  | { kind: 'random' }
  /** Transport (peertube only — tvLibrarian is a live tuner with no pause). */
  | { kind: 'togglePlay' }
  /** Clear the error after the surface has shown it. */
  | { kind: 'clearError' };

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** The engine surface this controller uses. Every method maps 1:1 onto an
 *  EXISTING public call, so nothing here implies an engine-side change. */
export interface HlsSourceEngine {
  /** `videoEngine().attachExternalSource(nodeId, 'video', el)`. */
  attach(nodeId: string, el: unknown | null): void;
  /** `videoEngine().read(nodeId, 'hasVideoElement') === true`. */
  hasElement(nodeId: string): boolean;
  /** `videoEngine().read(nodeId, 'extras')` — null until the node materializes. */
  extras(nodeId: string): HlsTunerExtras | null;
  /** `engine.readParam(node, paramId)` — the synthetic per-port CV tap. */
  readParam(node: ModuleNode, paramId: string): number | undefined;
}

/**
 * The union of both modules' handle extras. Structural, so the real objects
 * satisfy it without this file importing either def, and every module-specific
 * member is OPTIONAL — the controller calls them with `?.`, so a module that
 * does not publish a playhead simply never gets one. That is the whole of the
 * per-module branching for the extras channel.
 */
export interface HlsTunerExtras {
  wireAudio(): void;
  unwireAudio(): void;
  isAudioWired(): boolean;
  /** peertube: the `playing` gate output. */
  setPlaying?(on: boolean): void;
  /** peertube: the `playhead` CV output, 0..1. */
  setPlayhead?(frac01: number): void;
  /** peertube: the `loaded` trigger output. */
  fireLoaded?(): void;
  /** peertube: the `ended` trigger output. */
  fireEnded?(): void;
  /** tvLibrarian: the `stream_online` gate output. */
  setStreamOnline?(on: boolean): void;
  /** tvLibrarian: the `channel_changed` trigger output. */
  pulseChannelChanged?(): void;
}

/** Element operations. Injected because the core runs in `environment: 'node'`
 *  where there is no `HTMLVideoElement`. */
export interface HlsElementOps<E> {
  setSrc(el: E, url: string): void;
  clearSrc(el: E): void;
  setMuted(el: E, muted: boolean): void;
  play(el: E): void;
  pause(el: E): void;
  paused(el: E): boolean;
  /** `currentTime / duration`, clamped to 0..1; 0 when the duration is not a
   *  finite positive number (a LIVE stream, or metadata not in yet). */
  positionFrac(el: E): number;
  ended(el: E): boolean;
  /** Is the element ready enough that `playing` has effectively happened?
   *  (`readyState >= HAVE_CURRENT_DATA`.) */
  hasCurrentData(el: E): boolean;
  /** `el.canPlayType('application/vnd.apple.mpegurl')` — Safari native HLS. */
  canPlayNativeHls(el: E): boolean;
  /** Subscribe; returns an unsubscribe. */
  on(el: E, event: 'play' | 'pause' | 'ended' | 'playing' | 'loadeddata', fn: () => void): () => void;
}

/** The hls.js seam, node-keyed through `./node-hls` in the real binding. */
export interface HlsPlayerOps<E> {
  /** `Hls.isSupported()`. */
  supported(): boolean;
  /** Build an instance for `nodeId`, point it at `url` and attach it to `el`.
   *  The implementation destroys any PREVIOUS instance for that node. */
  create(
    nodeId: string,
    el: E,
    url: string,
    handlers: { onManifestParsed(): void; onFatalError(): void },
  ): void;
  /** Destroy + forget the node's instance. Idempotent. */
  destroy(nodeId: string): void;
}

/** The node.data reads/writes, as a seam so the core unit-tests with no Y.Doc. */
export interface HlsTunerDoc {
  /** The node's persisted `data`, or null when the node is gone. */
  read(nodeId: string): Readonly<Record<string, unknown>> | null;
  /** Merge a patch into the node's `data` in ONE transaction. */
  write(nodeId: string, patch: Record<string, unknown>): void;
}

/** The element registry operations the controller needs. */
export interface HlsTunerMedia<E> {
  /** Create-or-get the node's PARKED element. THIS is what makes the source
   *  exist with no card anywhere.
   *
   *  ⚠ `testId` is passed rather than set through `HlsElementOps` because the
   *  registry runs `init` EXACTLY ONCE EVER per `(node, slot)` — a card that
   *  later adopts the same key gets the element as-is. So the attribute the
   *  module's own e2e locates the element by has to be applied by whoever
   *  creates it, and the controller is now that. */
  ensure(nodeId: string, slot: string, opts: { testId: string; init(el: E): void }): E;
  /** Register teardown that belongs to the NODE (the hls.js instance). */
  setDisposer(nodeId: string, slot: string, dispose: (() => void) | null): void;
}

/** Timers + clock + randomness, injected so the unit tests drive them. */
export interface HlsSourceClock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Only used by the `random` command; injected so a test is deterministic. */
  random(): number;
}

/** Everything a PROFILE needs from the outside world. */
export interface HlsTunerIo {
  /** A CORS-open JSON GET. Rejects on a non-2xx. */
  fetchJson(url: string): Promise<unknown>;
}

export interface HlsSourceDeps<E> {
  engine: HlsSourceEngine | null;
  doc: HlsTunerDoc;
  media: HlsTunerMedia<E>;
  el: HlsElementOps<E>;
  player: HlsPlayerOps<E>;
  clock: HlsSourceClock;
  io: HlsTunerIo;
  /**
   * Called whenever a node's published status changes.
   *
   * ⚠ PUSH, NOT POLL, verbatim P1's reasoning: the surface needs `error` and
   * `statusMsg` — states that exist for a moment and then matter for as long as
   * the user is looking at them. A poll that samples between two changes shows
   * neither. The real binding writes a `$state` record; the core tests bind an
   * array and assert the TRANSITIONS.
   */
  onStatus?(nodeId: string, status: HlsSourceStatus): void;
}

// ---------------------------------------------------------------------------
// The per-module profile
// ---------------------------------------------------------------------------

export type ResolvedHlsStream = { readonly url: string; readonly kind: 'hls' | 'mp4' };

/** A trigger cable, as the pair the poll needs. */
export interface HlsTrigger {
  /** The synthetic CV param the engine's bridge writes the gate level into. */
  readonly paramId: string;
  /** What a RISING edge does. */
  readonly command: 'next' | 'random' | 'togglePlay';
  /** Why this cable exists — required, so `tsc` refuses one added blind. */
  readonly why: string;
}

/**
 * Everything that genuinely differs between the two tuners. Deliberately DATA
 * plus small pure adapters: a profile may fetch (through the injected `io`) and
 * may shape `node.data`, and may do nothing else. Anything a profile would need
 * a timer, an element or the engine for belongs in the shared controller.
 */
export interface HlsTunerProfile {
  /** The module type id this profile is for. */
  readonly type: string;
  /** `data-testid` the surface's specs locate the element by. */
  readonly elementTestId: string;
  /** Hard timeout for "a stream that never produced a frame is unavailable". */
  readonly loadTimeoutMs: number;
  /** Does this module publish a playhead / transport mirror? */
  readonly publishesPlayhead: boolean;
  readonly triggers: readonly HlsTrigger[];
  /** The persisted selection's key, from `node.data`. */
  selectionKey(data: Readonly<Record<string, unknown>>): string | null;
  /** The catalogue key (search term / country code), from `node.data`. */
  catalogueKey(data: Readonly<Record<string, unknown>>): string | null;
  /**
   * Does a CHANGE to `catalogueKey` fetch the catalogue on its own?
   *
   * ⚠ THE ANSWER DIFFERS AND THE REASON IS THE INPUT DEVICE, not taste.
   * tvLibrarian's key is a COUNTRY CODE — it moves once per deliberate pick (or
   * a peer's), so auto-loading is exactly the `$effect` the card had. peertube's
   * key is a SEARCH TERM the user types one character at a time, and every
   * keystroke is persisted so rack-mates see the query; auto-loading would fire
   * a Sepia Search per character. So peertube says false, the card debounces and
   * issues an explicit `catalogue` command, and `advance()` still falls back to
   * fetching on demand — which is what keeps a `next_trigger` on a
   * freshly-loaded rack doing something.
   */
  readonly autoLoadCatalogue: boolean;
  /** Fetch the candidate list for a catalogue key. */
  fetchCatalogue(io: HlsTunerIo, key: string, data: Readonly<Record<string, unknown>>): Promise<HlsCandidate[]>;
  /** Resolve a candidate to a playable stream, or null when unplayable. */
  resolveStream(io: HlsTunerIo, c: HlsCandidate): Promise<ResolvedHlsStream | null>;
  /** The `node.data` patch that PERSISTS a selection (or clears it). */
  selectionPatch(c: HlsCandidate | null): Record<string, unknown>;
  /**
   * Rebuild the selected candidate from `node.data` ALONE.
   *
   * ⚠ THIS IS WHAT MAKES A SAVED RACK TUNE ITSELF. The catalogue is a network
   * fetch that may never have run in this browser; the selection is persisted in
   * full precisely so a reload does not have to search first.
   */
  candidateFromData(data: Readonly<Record<string, unknown>>): HlsCandidate | null;
  /** Advance within the catalogue. Separate per profile so tvLibrarian keeps
   *  using its own tested helpers rather than a re-derivation of them. */
  advance(
    catalogue: readonly HlsCandidate[],
    currentKey: string | null,
    mode: 'next' | 'random',
    rng: () => number,
  ): HlsCandidate | null;
}

/** The generic wrap-around advance, used by any profile without its own
 *  published semantics. Exported so the unit test drives the SAME function the
 *  controller does rather than a copy of it. */
export function advanceByKey(
  catalogue: readonly HlsCandidate[],
  currentKey: string | null,
  mode: 'next' | 'random',
  rng: () => number,
): HlsCandidate | null {
  if (catalogue.length === 0) return null;
  if (mode === 'next') {
    if (!currentKey) return catalogue[0]!;
    const idx = catalogue.findIndex((c) => c.key === currentKey);
    if (idx < 0) return catalogue[0]!;
    return catalogue[(idx + 1) % catalogue.length]!;
  }
  if (catalogue.length === 1) return catalogue[0]!;
  // Pick among the OTHERS so "random" reliably changes the stream.
  const pool = currentKey ? catalogue.filter((c) => c.key !== currentKey) : catalogue;
  const list = pool.length > 0 ? pool : catalogue;
  const i = Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)));
  return list[i]!;
}

// ── PEERTUBE ────────────────────────────────────────────────────────────────

/** `host::uuid` — the pair is the identity; a uuid alone is not unique across
 *  the fediverse. Kept as one function so the read and the write agree. */
function peertubeKey(host: string, uuid: string): string {
  return `${host}::${uuid}`;
}

function peertubeCandidate(v: PeerTubeVideo): HlsCandidate {
  return {
    key: peertubeKey(v.host, v.uuid),
    label: v.name,
    sublabel: `${v.channel ? `${v.channel} · ` : ''}${v.host}${v.isLive ? ' · LIVE' : ''} · ${formatDuration(v.duration)}`,
    thumbnailUrl: v.thumbnailUrl || null,
    badge: v.isLive ? 'live' : null,
    item: v,
  };
}

export const PEERTUBE_PROFILE: HlsTunerProfile = {
  type: 'peertube',
  elementTestId: 'peertube-video',
  // 14 s, the card's own number: long enough for a slow federated instance to
  // produce a first frame, short enough that a dead one skips while the user is
  // still watching.
  loadTimeoutMs: 14_000,
  publishesPlayhead: true,
  autoLoadCatalogue: false,
  triggers: [
    {
      paramId: 'cv_play_trigger',
      command: 'togglePlay',
      why: 'the `play_trigger` gate input toggles transport on a rising edge — a clock or a manual gate starts and stops the video without touching the card.',
    },
    {
      paramId: 'cv_next_trigger',
      command: 'next',
      why: 'the `next_trigger` gate input advances to the next search result, which is how peertube is played as an instrument rather than browsed.',
    },
  ],
  selectionKey(data) {
    const host = typeof data.selectedHost === 'string' ? data.selectedHost : null;
    const uuid = typeof data.uuid === 'string' ? data.uuid : null;
    return host && uuid ? peertubeKey(host, uuid) : null;
  },
  catalogueKey(data) {
    const term = typeof data.searchTerm === 'string' ? data.searchTerm.trim() : '';
    return term.length > 0 ? term : null;
  },
  async fetchCatalogue(io, key) {
    const raw = (await io.fetchJson(buildSearchUrl(key, { count: 24 }))) as RawSearchResponse;
    return parseSearchResponse(raw).map(peertubeCandidate);
  },
  async resolveStream(io, c) {
    const v = c.item as PeerTubeVideo;
    const raw = (await io.fetchJson(videoDetailsUrl(v.host, v.uuid))) as RawVideoDetails;
    const stream = resolvePeerTubeStream(raw);
    if (!stream) return null;
    return { url: stream.url, kind: stream.kind === 'mp4' ? 'mp4' : 'hls' };
  },
  selectionPatch(c) {
    const v = (c?.item ?? null) as PeerTubeVideo | null;
    return { selectedHost: v?.host ?? null, uuid: v?.uuid ?? null, name: v?.name ?? null };
  },
  candidateFromData(data) {
    const host = typeof data.selectedHost === 'string' ? data.selectedHost : null;
    const uuid = typeof data.uuid === 'string' ? data.uuid : null;
    if (!host || !uuid) return null;
    const name = typeof data.name === 'string' ? data.name : uuid;
    // A MINIMAL row: everything `resolveStream` needs (host + uuid) plus the
    // label. The full row arrives if and when a search repopulates the catalogue.
    return peertubeCandidate({
      host,
      uuid,
      name,
      channel: '',
      duration: 0,
      thumbnailUrl: '',
      isLive: false,
      nsfw: false,
    });
  },
  advance: advanceByKey,
};

// ── TV LIBRARIAN ────────────────────────────────────────────────────────────

function tvCandidate(c: Channel): HlsCandidate {
  return {
    key: c.nanoid,
    label: c.name,
    sublabel: languageLabel(c.languages),
    thumbnailUrl: null,
    badge: c.isGeoBlocked ? 'geo' : null,
    item: c,
  };
}

/** The persisted `TvChannelMeta`, structurally — the profile writes and reads it
 *  without importing the def (which lives under the attest-hashed tree). */
interface TvChannelMetaLike {
  nanoid: string;
  name: string;
  streamUrl: string;
  country: string;
  languages: string[];
}

export const TV_LIBRARIAN_PROFILE: HlsTunerProfile = {
  type: 'tvLibrarian',
  elementTestId: 'tv-video',
  // 12 s, the card's own number.
  loadTimeoutMs: 12_000,
  // A live TV tuner has no transport and no duration, so there is no playhead to
  // publish and no 10 Hz loop to run for one.
  publishesPlayhead: false,
  autoLoadCatalogue: true,
  triggers: [
    {
      paramId: 'cv_next',
      command: 'next',
      why: 'the `next` gate input steps to the next channel in the tuned country — channel-surfing driven by a clock instead of a finger.',
    },
    {
      paramId: 'cv_random',
      command: 'random',
      why: 'the `random` gate input jumps to a DIFFERENT channel, which is the module played as a chance instrument.',
    },
  ],
  selectionKey(data) {
    const ch = data.channel as { nanoid?: unknown } | null | undefined;
    return ch && typeof ch.nanoid === 'string' ? ch.nanoid : null;
  },
  catalogueKey(data) {
    return typeof data.countryCode === 'string' && data.countryCode.length > 0
      ? data.countryCode
      : null;
  },
  async fetchCatalogue(io, key) {
    const raw = await io.fetchJson(countryChannelsUrl(key));
    // Keep geo-blocked rows (badged in the UI), drop youtube-only ones (no clean
    // texture) — `requirePlayable` is the card's own filter, unchanged.
    return filterChannels(parseChannels(raw), { requirePlayable: true }).map(tvCandidate);
  },
  resolveStream(_io, c) {
    const ch = c.item as Channel;
    // Already a direct .m3u8 — there is no per-instance details hop here.
    return Promise.resolve(ch.streamUrl ? { url: ch.streamUrl, kind: 'hls' as const } : null);
  },
  selectionPatch(c) {
    if (!c) return { channel: null };
    const ch = c.item as Channel;
    const meta: TvChannelMetaLike = {
      nanoid: ch.nanoid,
      name: ch.name,
      streamUrl: ch.streamUrl ?? '',
      country: ch.country,
      languages: ch.languages,
    };
    return { channel: meta };
  },
  candidateFromData(data) {
    const ch = data.channel as Partial<TvChannelMetaLike> | null | undefined;
    if (!ch || typeof ch.nanoid !== 'string' || typeof ch.streamUrl !== 'string') return null;
    return tvCandidate({
      nanoid: ch.nanoid,
      name: typeof ch.name === 'string' ? ch.name : ch.nanoid,
      streamUrl: ch.streamUrl,
      country: typeof ch.country === 'string' ? ch.country : '',
      languages: Array.isArray(ch.languages) ? ch.languages : [],
      isGeoBlocked: false,
      youtubeOnly: false,
    });
  },
  advance(catalogue, currentKey, mode, rng) {
    // ⚠ DELEGATED to the module's OWN tested helpers rather than re-derived, so
    // "what does next do" has one answer for tvLibrarian and the existing
    // `tv-librarian-data.test.ts` coverage still describes the shipping
    // behaviour. The generic `advanceByKey` above is behaviourally identical
    // today; keeping the delegation means a future change to either can only
    // move the module it is about.
    const channels = catalogue.map((c) => c.item as Channel);
    const picked =
      mode === 'next' ? nextChannel(channels, currentKey) : randomChannel(channels, currentKey, rng);
    if (!picked) return null;
    return catalogue.find((c) => c.key === picked.nanoid) ?? null;
  },
};

/**
 * Module types this registry owns a controller for.
 *
 * ⚠ THIS IS THE ANCHOR THAT REPLACES `DOM_SOURCE_LANE_TYPES` MEMBERSHIP, and it
 * is asserted in BOTH directions by `node-hls-source-registry.test.ts` and by
 * `dom-source-modules.test.ts`: every type here must be a registered def, and —
 * the direction that matters — a type here must NOT also be in
 * `DOM_SOURCE_LANE_TYPES`, because being in both would mean the card attaches
 * AND a controller attaches, i.e. two owners for one element. Converting a
 * module is therefore ONE atomic edit: it enters this set in the same diff it
 * leaves that one.
 *
 * DERIVED from the profiles rather than typed beside them, so a profile added
 * without an entry (or an entry with no profile) is impossible rather than
 * merely discouraged.
 */
export const HLS_TUNER_PROFILES: readonly HlsTunerProfile[] = [
  PEERTUBE_PROFILE,
  TV_LIBRARIAN_PROFILE,
];

export const NODE_HLS_SOURCE_TYPES: ReadonlySet<string> = new Set<string>(
  HLS_TUNER_PROFILES.map((p) => p.type),
);

export function hlsTunerProfile(type: string): HlsTunerProfile | null {
  return HLS_TUNER_PROFILES.find((p) => p.type === type) ?? null;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface NodeHlsSourceRegistry<E> {
  /** Reconcile controllers against the graph. Called from Canvas's graph effect,
   *  the same place `nodeVideoSource.sync` is called. */
  sync(nodes: readonly ModuleNode[], engine: HlsSourceEngine | null): void;
  /** The published status for a node. Never throws. */
  view(nodeId: string): HlsSourceStatus;
  /** Invoke a gesture on the node's controller. */
  request(nodeId: string, cmd: HlsSourceCommand): VideoSourceRequestResult;
  /** True when a controller exists — the e2e probe's subject. */
  has(nodeId: string): boolean;
  /** Full teardown for one node. Keyed to the GRAPH, never to a card. */
  disposeNode(nodeId: string): void;
  /** Dispose every controller whose node is not in `liveIds`. */
  sweep(liveIds: Iterable<string>): void;
  /** Inspection for tests + the e2e probe. Properties, never a COUNT. */
  snapshot(): Array<{ nodeId: string; type: string } & HlsSourceStatus>;
}

interface Controller<E> {
  node: ModuleNode;
  profile: HlsTunerProfile;
  el: E;
  status: HlsSourceStatus;
  /** Interval handles for the CV poll and the playhead loop, plus the two retry
   *  loops. Cleared as one on dispose. */
  timers: unknown[];
  /** One-shot timer handles (the load timeout, the unavailable skip). */
  loadTimeout: unknown;
  skipTimer: unknown;
  /** Element event unsubscribes. */
  off: Array<() => void>;
  /** The candidate whose stream is CURRENTLY attached.
   *
   *  ⚠ NODE-LIFETIME, and that is defect 2 in the header: on the card this was a
   *  component-scope `let`, so every remount re-attached a live stream. */
  lastAttachedKey: string | null;
  /** The catalogue key the current `status.catalogue` was fetched for. */
  lastCatalogueKey: string | null;
  /** Previous sample per trigger param, for rising-edge detection. */
  lastGate: Map<string, number>;
  /** Monotonic token so a slow resolve for an OLD selection cannot land. */
  attachToken: number;
  disposed: boolean;
  dispose(): void;
}

/**
 * Build a registry over injected seams. See the header for the invariants.
 */
export function createNodeHlsSourceRegistry<E>(
  deps: HlsSourceDeps<E>,
): NodeHlsSourceRegistry<E> {
  const controllers = new Map<string, Controller<E>>();
  let liveEngine: HlsSourceEngine | null = deps.engine;

  function patchStatus(c: Controller<E>, next: Partial<HlsSourceStatus>): void {
    c.status = { ...c.status, ...next };
    try {
      deps.onStatus?.(c.node.id, c.status);
    } catch {
      /* a surface must never break the lifecycle */
    }
  }

  function extrasOf(c: Controller<E>): HlsTunerExtras | null {
    try {
      return liveEngine?.extras(c.node.id) ?? null;
    } catch {
      return null;
    }
  }

  /** Retry an idempotent action until `done()` reports success or the ceiling is
   *  reached. Used for BOTH races against the engine's async `addNode`. */
  function retryUntil(c: Controller<E>, action: () => void, done: () => boolean): void {
    let attempts = 0;
    const handle = deps.clock.setInterval(() => {
      if (c.disposed) {
        deps.clock.clearInterval(handle);
        return;
      }
      attempts++;
      try {
        action();
      } catch {
        /* engine not ready */
      }
      if (done() || attempts >= RETRY_ATTEMPTS) deps.clock.clearInterval(handle);
    }, RETRY_INTERVAL_MS);
    c.timers.push(handle);
    // Try once IMMEDIATELY: when the engine is already up (a node added to a
    // running rack) this lands on the same tick rather than after 100 ms, so a
    // spec that samples straight away sees the source rather than a gap.
    try {
      action();
    } catch {
      /* engine not ready */
    }
    if (done()) deps.clock.clearInterval(handle);
  }

  function attachElement(c: Controller<E>): void {
    retryUntil(
      c,
      () => {
        liveEngine?.attach(c.node.id, c.el);
      },
      () => {
        const ok = liveEngine?.hasElement(c.node.id) === true;
        if (ok !== c.status.attached) patchStatus(c, { attached: ok });
        return ok;
      },
    );
  }

  /**
   * Wire the element's audio into the cross-domain bridge, then UN-MUTE.
   *
   * ⚠ THE UN-MUTE IS THE POINT AND IT MUST HAPPEN AFTER THE WIRE, not before.
   * The element is created `muted` so the programmatic `play()` satisfies the
   * autoplay policy; a MUTED element feeds SILENCE into its
   * MediaElementAudioSourceNode, because the mute gates the audio AT THE SOURCE,
   * upstream of the Web Audio tap. Once `wireAudio()` has succeeded,
   * `createMediaElementSource` has redirected the element's audio INTO the graph
   * and disconnected its native speaker path, so un-muting un-gates the tap
   * WITHOUT playing through the speaker.
   *
   * ⚠ AND THE RETRY IS NODE-LIFETIME BECAUSE THAT IS DEFECT 3. On the card this
   * loop was cleared by `onDestroy`; unmounting inside its ~5 s window left the
   * element muted forever while the node kept playing it.
   */
  function ensureAudioWired(c: Controller<E>): void {
    retryUntil(
      c,
      () => {
        extrasOf(c)?.wireAudio();
      },
      () => {
        const ok = extrasOf(c)?.isAudioWired() === true;
        if (ok !== c.status.audioWired) patchStatus(c, { audioWired: ok });
        if (ok) {
          deps.el.setMuted(c.el, false);
          extrasOf(c)?.fireLoaded?.();
        }
        return ok;
      },
    );
  }

  function clearTimer(c: Controller<E>, which: 'loadTimeout' | 'skipTimer'): void {
    const h = c[which];
    if (h !== null) {
      try {
        deps.clock.clearTimeout(h);
      } catch {
        /* */
      }
      c[which] = null;
    }
  }

  function teardownStream(c: Controller<E>): void {
    clearTimer(c, 'loadTimeout');
    deps.player.destroy(c.node.id);
  }

  function setOnline(c: Controller<E>, on: boolean): void {
    const ex = extrasOf(c);
    ex?.setStreamOnline?.(on);
    ex?.setPlaying?.(on);
  }

  function markUnavailable(c: Controller<E>, message: string): void {
    patchStatus(c, {
      streamState: 'unavailable',
      loadingStream: false,
      isPlaying: false,
      error: message,
      statusMsg: null,
    });
    setOnline(c, false);
    teardownStream(c);
    // Auto-skip after a short beat — never HANG on a dead or CORS-misconfigured
    // stream. Both cards learned this from the archivist hang.
    clearTimer(c, 'skipTimer');
    c.skipTimer = deps.clock.setTimeout(() => {
      c.skipTimer = null;
      if (c.disposed) return;
      if (c.status.catalogue.length > 1 && c.status.streamState === 'unavailable') {
        void advance(c, 'next');
      }
    }, UNAVAILABLE_SKIP_MS);
  }

  /** The element reached a playable state. */
  function onPlayable(c: Controller<E>): void {
    clearTimer(c, 'loadTimeout');
    if (c.status.streamState === 'playing') return;
    patchStatus(c, { streamState: 'playing', loadingStream: false, isPlaying: true, error: null });
    setOnline(c, true);
    ensureAudioWired(c);
  }

  /** Point the element at a resolved stream. */
  function attachStream(c: Controller<E>, stream: ResolvedHlsStream): void {
    teardownStream(c);
    clearTimer(c, 'skipTimer');
    extrasOf(c)?.unwireAudio();
    patchStatus(c, { streamState: 'loading', loadingStream: false, isPlaying: false, audioWired: false });
    setOnline(c, false);
    // Re-mute for THIS stream's autoplay attempt: a channel SWAP leaves the
    // element un-muted from the previous stream, and an un-muted programmatic
    // play() with no user gesture is rejected outright.
    deps.el.setMuted(c.el, true);

    c.loadTimeout = deps.clock.setTimeout(() => {
      c.loadTimeout = null;
      if (c.disposed) return;
      if (c.status.streamState !== 'playing') markUnavailable(c, 'Stream timed out.');
    }, c.profile.loadTimeoutMs);

    if (stream.kind === 'mp4') {
      // Direct progressive file — a plain src, no hls.js needed.
      deps.el.setSrc(c.el, stream.url);
      deps.el.play(c.el);
    } else if (deps.player.supported()) {
      deps.player.create(c.node.id, c.el, stream.url, {
        onManifestParsed: () => {
          if (!c.disposed) deps.el.play(c.el);
        },
        onFatalError: () => {
          if (!c.disposed) markUnavailable(c, 'Stream blocked (CORS) or unavailable.');
        },
      });
    } else if (deps.el.canPlayNativeHls(c.el)) {
      deps.el.setSrc(c.el, stream.url);
      deps.el.play(c.el);
    } else {
      markUnavailable(c, 'HLS not supported in this browser.');
      return;
    }
    // Some renderers fire `loadeddata` without a subsequent `playing`; both
    // cards accepted either, and the element listeners below cover both.
    if (deps.el.hasCurrentData(c.el)) onPlayable(c);
  }

  /** Resolve + attach the candidate the persisted selection names. */
  async function tuneTo(c: Controller<E>, cand: HlsCandidate): Promise<void> {
    const token = ++c.attachToken;
    c.lastAttachedKey = cand.key;
    patchStatus(c, {
      selectionKey: cand.key,
      selectionLabel: cand.label,
      loadingStream: true,
      statusMsg: 'Resolving stream…',
      error: null,
      streamState: 'loading',
    });
    let stream: ResolvedHlsStream | null = null;
    try {
      stream = await c.profile.resolveStream(deps.io, cand);
    } catch (e) {
      if (c.disposed || token !== c.attachToken) return;
      patchStatus(c, { loadingStream: false, statusMsg: null });
      markUnavailable(c, `Could not resolve: ${errorText(e)}`);
      return;
    }
    if (c.disposed || token !== c.attachToken) return;
    patchStatus(c, { loadingStream: false, statusMsg: null });
    if (!stream) {
      markUnavailable(c, 'No playable stream for this one.');
      return;
    }
    attachStream(c, stream);
  }

  async function loadCatalogue(c: Controller<E>, key: string): Promise<void> {
    c.lastCatalogueKey = key;
    patchStatus(c, { loadingCatalogue: true, catalogueKey: key, statusMsg: 'Loading…', error: null });
    try {
      const data = deps.doc.read(c.node.id) ?? {};
      const rows = await c.profile.fetchCatalogue(deps.io, key, data);
      if (c.disposed) return;
      patchStatus(c, {
        catalogue: rows,
        loadingCatalogue: false,
        statusMsg: null,
        error: rows.length === 0 ? 'Nothing playable here — try another.' : null,
      });
    } catch (e) {
      if (c.disposed) return;
      patchStatus(c, {
        catalogue: [],
        loadingCatalogue: false,
        statusMsg: null,
        error: `Could not load: ${errorText(e)}`,
      });
    }
  }

  /** Persist a selection and tune to it. The WRITE is what peers see; the tune
   *  is what THIS browser does, and `applyData` would do it anyway on the next
   *  graph tick — doing it here as well is what makes a local pick instant. */
  async function select(c: Controller<E>, cand: HlsCandidate): Promise<void> {
    deps.doc.write(c.node.id, c.profile.selectionPatch(cand));
    extrasOf(c)?.pulseChannelChanged?.();
    await tuneTo(c, cand);
  }

  /** `next` / `random`, from a CV edge or from a button. */
  async function advance(c: Controller<E>, mode: 'next' | 'random'): Promise<void> {
    if (c.status.catalogue.length === 0) {
      // Nothing to advance INTO. Both cards' fallback was to (re)fetch, which is
      // what makes a `next` on a freshly-loaded rack do something rather than
      // nothing.
      const key = c.status.catalogueKey ?? c.profile.catalogueKey(deps.doc.read(c.node.id) ?? {});
      if (!key) return;
      await loadCatalogue(c, key);
      if (c.disposed || c.status.catalogue.length === 0) return;
    }
    const cand = c.profile.advance(c.status.catalogue, c.status.selectionKey, mode, deps.clock.random);
    if (!cand) return;
    await select(c, cand);
  }

  /**
   * Bring the node in line with its PERSISTED data — the half that used to be
   * two card `$effect`s, so a peer's tune and a patch load reached nothing when
   * no card was mounted.
   *
   * Run on EVERY graph tick, for the reason P1 records: Canvas's sync effect is
   * the reactivity a controller does not have, and it re-runs exactly when
   * `node.data` can have moved.
   */
  function applyData(c: Controller<E>): void {
    const data = deps.doc.read(c.node.id);
    if (!data) return;
    const catKey = c.profile.catalogueKey(data);
    if (c.profile.autoLoadCatalogue && catKey && catKey !== c.lastCatalogueKey) {
      void loadCatalogue(c, catKey);
    }
    const selKey = c.profile.selectionKey(data);
    if (!selKey) return;
    if (selKey === c.lastAttachedKey) return;
    const cand =
      c.status.catalogue.find((x) => x.key === selKey) ?? c.profile.candidateFromData(data);
    if (!cand) return;
    void tuneTo(c, cand);
  }

  /** The CV poll. NODE-lifetime: a gate cable patched into a collapsed tuner did
   *  nothing at all before this moved off the card. */
  function startGateLoop(c: Controller<E>): void {
    if (c.profile.triggers.length === 0) return;
    const handle = deps.clock.setInterval(() => {
      if (c.disposed || !liveEngine) return;
      for (const t of c.profile.triggers) {
        const v = liveEngine.readParam(c.node, t.paramId);
        if (typeof v !== 'number') continue;
        const prev = c.lastGate.get(t.paramId) ?? 0;
        if (prev < GATE_RISING_EDGE && v >= GATE_RISING_EDGE) {
          if (t.command === 'togglePlay') togglePlay(c);
          else void advance(c, t.command);
        }
        c.lastGate.set(t.paramId, v);
      }
    }, GATE_INTERVAL_MS);
    c.timers.push(handle);
  }

  /** The playhead / transport mirror. Only for the module that publishes one. */
  function startPlayheadLoop(c: Controller<E>): void {
    if (!c.profile.publishesPlayhead) return;
    const handle = deps.clock.setInterval(() => {
      if (c.disposed) return;
      const frac = deps.el.positionFrac(c.el);
      const playing = !deps.el.paused(c.el) && !deps.el.ended(c.el);
      const ex = extrasOf(c);
      ex?.setPlayhead?.(frac);
      ex?.setPlaying?.(playing);
      if (frac !== c.status.playheadFrac || playing !== c.status.isPlaying) {
        patchStatus(c, { playheadFrac: frac, isPlaying: playing });
      }
    }, PLAYHEAD_INTERVAL_MS);
    c.timers.push(handle);
  }

  function togglePlay(c: Controller<E>): void {
    if (deps.el.paused(c.el)) deps.el.play(c.el);
    else deps.el.pause(c.el);
  }

  function createController(node: ModuleNode, profile: HlsTunerProfile): Controller<E> {
    // `ensure` (not `adopt`): the element is created PARKED and stays parked
    // until a card adopts it for display. THIS CALL is what makes the source
    // exist with no card mounted anywhere — the whole point of #1511.
    const el = deps.media.ensure(node.id, HLS_SOURCE_SLOT, {
      testId: profile.elementTestId,
      init: (e) => {
        // The init the CARD used to own. Created MUTED so the programmatic
        // play() is allowed without a user gesture; un-muted only once the audio
        // tap is wired (see ensureAudioWired).
        deps.el.setMuted(e, true);
      },
    });
    const c: Controller<E> = {
      node,
      profile,
      el,
      status: { ...NO_HLS_SOURCE },
      timers: [],
      loadTimeout: null,
      skipTimer: null,
      off: [],
      lastAttachedKey: null,
      lastCatalogueKey: null,
      lastGate: new Map(),
      attachToken: 0,
      disposed: false,
      dispose(): void {
        if (c.disposed) return;
        c.disposed = true;
        for (const t of c.timers) {
          try {
            deps.clock.clearInterval(t);
          } catch {
            /* */
          }
        }
        c.timers = [];
        clearTimer(c, 'loadTimeout');
        clearTimer(c, 'skipTimer');
        for (const off of c.off) {
          try {
            off();
          } catch {
            /* */
          }
        }
        c.off = [];
        // ⚠ DELIBERATELY ABSENT: no `attach(id, null)`, no `player.destroy`, no
        // `unwireAudio`. The ELEMENT and its hls.js instance belong to
        // `nodeMedia` and are freed by ITS graph-keyed sweep in the same Canvas
        // effect — the disposer registered below is what runs then. Tearing the
        // stream down here would re-create #1511 one level up: a controller
        // disposed and immediately re-created by a graph churn would kill a
        // stream that never needed to stop.
      },
    };
    // Teardown belongs to the NODE. `nodeMedia` runs this when the element is
    // destroyed, which is the only moment the demuxer must go.
    deps.media.setDisposer(node.id, HLS_SOURCE_SLOT, () => deps.player.destroy(node.id));

    c.off.push(
      deps.el.on(el, 'play', () => {
        if (c.disposed) return;
        patchStatus(c, { isPlaying: true });
        extrasOf(c)?.setPlaying?.(true);
      }),
      deps.el.on(el, 'pause', () => {
        if (c.disposed) return;
        patchStatus(c, { isPlaying: false });
        extrasOf(c)?.setPlaying?.(false);
      }),
      deps.el.on(el, 'ended', () => {
        if (c.disposed) return;
        patchStatus(c, { isPlaying: false });
        const ex = extrasOf(c);
        ex?.setPlaying?.(false);
        ex?.fireEnded?.();
      }),
      deps.el.on(el, 'playing', () => {
        if (!c.disposed) onPlayable(c);
      }),
      deps.el.on(el, 'loadeddata', () => {
        if (!c.disposed && deps.el.hasCurrentData(c.el)) onPlayable(c);
      }),
    );

    attachElement(c);
    startGateLoop(c);
    startPlayheadLoop(c);
    // A node restored from a saved rack already carries its selection; a freshly
    // spawned one does not. Both go through the same call, which no-ops without
    // one — so there is no "was this a load or a spawn" branch to get wrong.
    applyData(c);
    return c;
  }

  return {
    sync(nodes, engine) {
      liveEngine = engine;
      const live = new Set<string>();
      for (const n of nodes) {
        const profile = hlsTunerProfile(n.type);
        if (!profile) continue;
        live.add(n.id);
        const existing = controllers.get(n.id);
        if (existing) {
          // Refresh the node reference: `readParam` needs the CURRENT node
          // object, and the graph hands out a new one on every change.
          existing.node = n;
          applyData(existing);
          continue;
        }
        controllers.set(n.id, createController(n, profile));
      }
      for (const [id, c] of [...controllers]) {
        if (!live.has(id)) {
          c.dispose();
          controllers.delete(id);
        }
      }
    },

    view(nodeId) {
      return controllers.get(nodeId)?.status ?? NO_HLS_SOURCE;
    },

    request(nodeId, cmd) {
      const c = controllers.get(nodeId);
      if (!c) return { delivered: false, error: null };
      try {
        switch (cmd.kind) {
          case 'catalogue':
            void loadCatalogue(c, cmd.key);
            break;
          case 'select': {
            const cand = c.status.catalogue.find((x) => x.key === cmd.candidateKey);
            if (cand) void select(c, cand);
            break;
          }
          case 'next':
            void advance(c, 'next');
            break;
          case 'random':
            void advance(c, 'random');
            break;
          case 'togglePlay':
            togglePlay(c);
            break;
          case 'clearError':
            patchStatus(c, { error: null });
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
      const out: Array<{ nodeId: string; type: string } & HlsSourceStatus> = [];
      for (const [nodeId, c] of controllers) {
        out.push({ nodeId, type: c.profile.type, ...c.status });
      }
      return out;
    },
  };
}

function errorText(e: unknown): string {
  return (e as Error)?.message ?? 'network error';
}
