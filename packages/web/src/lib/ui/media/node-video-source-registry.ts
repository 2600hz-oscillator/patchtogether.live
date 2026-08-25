// packages/web/src/lib/ui/media/node-video-source-registry.ts
//
// NODE-OWNED VIDEO SOURCE LIFECYCLE (LEG-02, #1511) — the controller that makes
// a file-backed video module's SOURCE exist because the NODE exists, not because
// a card is mounted.
//
// ── WHAT WAS ALREADY DONE, AND WHAT WAS NOT ─────────────────────────────────
//
// `./node-media-registry` (#1583) moved the ELEMENT half: the `<video>`, its
// object URL, its MediaStream and an extra disposer are owned per `(nodeId,
// slot)` and torn down only by `nodeMedia.sweep(liveIds)` from the graph. That
// fixed "collapsing the card destroys the loaded file".
//
// It did NOT move the LIFECYCLE half, and the distinction is the whole of
// #1511. Every one of these still lived in `VideoboxCard.svelte`'s own
// component lifetime:
//
//   * `attachExternalSource(id,'video',el)` — driven by an `onMount` 100 ms
//     poll. The engine node existed; its SOURCE was null until a card mounted.
//   * `wireAudio()` — the retry that routes the element into the cross-domain
//     audio bridge. Without it `audio_l`/`audio_r` stay on the silent
//     placeholder, so a patched AUDIO OUT is silent.
//   * the 500 ms DRIFT loop — multiplayer playhead correction against the
//     synced `(isPlaying, lastSyncTime, lastSyncPosition)` triple.
//   * the 33 ms GATE loop — `play_trigger`'s rising edge toggling playback.
//   * the sync→element application (play / pause / seek arriving from a PEER).
//   * `tryReloadFromHandle()` — the patch-load restore from a remembered
//     FileSystemFileHandle.
//
// So a rack containing VIDEOBOX under the shipping shell had its source kept
// alive ONLY by `<HeadlessSourceHost>` parking the real card off-screen. That
// host is the compensation this file exists to retire: a UI component may
// DISPLAY or CONTROL a source; it must not be what makes the source EXIST.
//
// ── THE OWNERSHIP NOW ───────────────────────────────────────────────────────
//
// One controller per videobox NODE, created by `sync(nodes, engine)` from
// `Canvas.svelte`'s graph effect and disposed by the same `sweep(liveIds)` row
// that already retires `nodeMedia`, `nodeExtras`, `nodeRecorder` and friends.
// Graph lifetime, from the graph, in the one place that already owns it.
//
// The controller `ensure`s the node's element (creating it PARKED off-screen, so
// it exists and decodes before any card has mounted), attaches it to the engine,
// wires its audio, and runs all four loops. THE CARD CREATES NOTHING AND
// DISPOSES NOTHING — it `adopt`s the element for display, renders the UI, reads
// `view(id)` for status and forwards user GESTURES through `request(id, …)`.
//
// ⚠ WHY A REGISTRY AND NOT THE FACTORY, which is where SKIFREE's identical bug
// landed (#2192). That commit's own header states the test: a registry exists
// for "a resource the factory COULD NOT own — a media element the card
// acquires". That is exactly this case. A file-backed source begins with a USER
// GESTURE (a file picker, a permission re-grant) that no factory can perform,
// and the bytes live in an object URL the factory has no way to obtain. SKIFREE's
// controller was on the card "by accident of authorship" and could move to the
// factory; this one cannot.
//
// ⚠ AND THE GESTURE SEAM IS NOT OPTIONAL, for a reason measured on cameraInput's
// promotion (see ./camera-status-registry): an off-screen host is
// `pointer-events: none`, so a card-only gesture becomes UNCLICKABLE the moment
// the shell swaps the lane card away. Here the host is going away entirely, so
// there is no off-screen card to click even in principle. `request()` is how a
// faceplate — or any future surface — reaches the picker without becoming a
// SECOND owner of the URL.
//
// ⚠ DELIVERY IS REPORTED, NEVER DROPPED, verbatim the discipline
// ./camera-status-registry documents: a gesture writes nothing to the graph by
// design, so `readParam`/`readData` are structurally blind to it. `request()`
// returns whether a controller was there to receive it, and a caller that
// discarded that flag would make "the picker works" and "the picker is wired to
// nothing" indistinguishable.
//
// HASH TRANSPARENCY: `lib/ui/**`, NOT `lib/video/**`. That directory is hashed
// WHOLESALE for the WebGL attest (`resolveWebglBasis` rule 1 walks the entire
// tree), so a controller placed there would cost a real-GPU re-attest window for
// what is a pure lifetime move with no rendered pixel changed. Everything here
// reaches the engine through its EXISTING public surface —
// `attachExternalSource`, `read('extras')`, `read('hasVideoElement')` — so
// `video/modules/videobox.ts` is untouched. That split is deliberate and is a
// constraint on any future edit: do not move this file, and do not "simplify" it
// by adding an engine-side hook.
//
// TESTABILITY: the web package's vitest runs in `environment: 'node'` (no jsdom),
// so every outside edge is INJECTED — the clock, the timers, the object-URL
// minting, the engine, the Y.Doc writes and the media registry. `nodeVideoSource`
// (bottom of file) is the real singleton; `createNodeVideoSourceRegistry` is the
// pure core the unit tests drive with fakes.

import type { ModuleNode } from '$lib/graph/types';
import {
  decideDriftCorrection,
  type VideoboxFileMeta,
} from '$lib/video/modules/videobox-sync';

/** The media slot every single-source video module uses. Kept as a named
 *  constant because the CARD must adopt the SAME key the controller ensures —
 *  two spellings would silently give the card an empty second element. */
export const VIDEO_SOURCE_SLOT = 'main';

/** How often the multiplayer drift check runs. Mirrors the interval the card
 *  used, and the reason is unchanged: the correction threshold is 0.5 s, so
 *  checking at the same rate bounds worst-case drift at ~1 s. */
export const DRIFT_INTERVAL_MS = 500;

/** How often `play_trigger`'s synthetic CV param is polled for a rising edge.
 *  ~30 Hz, the rate the card used. */
export const GATE_INTERVAL_MS = 33;

/** Retry cadence + ceiling for the two things that race the engine's async
 *  `addNode`: the element ATTACH and the audio WIRE. Both are idempotent, so a
 *  retry is free; both give up quietly after the ceiling rather than spinning
 *  for the life of the rack. */
export const RETRY_INTERVAL_MS = 100;
export const RETRY_ATTEMPTS = 50;

/** The rising-edge threshold for the `play_trigger` gate. Matches the card's
 *  own 0.5 crossing — see `$lib/audio/gate-trigger` for why 0.5 is the
 *  canonical gate level. */
const GATE_RISING_EDGE = 0.5;

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** The engine surface this controller uses. Every method maps 1:1 onto an
 *  EXISTING public call, so nothing here implies an engine-side change. */
export interface VideoSourceEngine {
  /** `videoEngine().attachExternalSource(nodeId, 'video', el)`. */
  attach(nodeId: string, el: unknown | null): void;
  /** `videoEngine().read(nodeId, 'hasVideoElement') === true` — the engine's own
   *  confirmation that the attach LANDED, which is what ends the retry. */
  hasElement(nodeId: string): boolean;
  /** `videoEngine().read(nodeId, 'extras')` — `null` until the node
   *  materializes. */
  extras(nodeId: string): VideoSourceExtras | null;
  /** `engine.readParam(node, paramId)` — the synthetic per-port CV tap. */
  readParam(node: ModuleNode, paramId: string): number | undefined;
}

/** The subset of `VideoboxHandleExtras` the lifecycle needs. Structural, so the
 *  real extras object satisfies it without this file importing the def. */
export interface VideoSourceExtras {
  wireAudio(): void;
  isAudioWired(): boolean;
}

/** The synced state this controller reads and writes. A seam rather than a
 *  direct `$lib/graph/store` import so the core unit-tests with no Y.Doc. */
export interface VideoSourceDoc {
  /** The node's synced player state, or null when the node is gone. */
  read(nodeId: string): VideoSourceSyncState | null;
  /** Write the `(isPlaying, lastSyncTime, lastSyncPosition)` triple. */
  writeSync(nodeId: string, next: { isPlaying: boolean; currentPositionSec: number }): void;
  /** Publish the loaded file's metadata to peers. */
  writeFileMeta(nodeId: string, meta: VideoboxFileMeta, opts: { resetPlayhead: boolean }): void;
}

export interface VideoSourceSyncState {
  fileMeta: VideoboxFileMeta | null;
  isPlaying: boolean;
  lastSyncTime: number;
  lastSyncPosition: number;
}

/** The element operations. Injected because the core runs in `environment:
 *  'node'` where there is no `HTMLVideoElement`. */
export interface VideoSourceMedia<E> {
  /** Create-or-get the node's PARKED element. The controller calls this at
   *  creation, which is what makes the source exist with no card anywhere. */
  ensure(nodeId: string, slot: string): E;
  /** The object URL currently owned for this key, or null. */
  objectUrl(nodeId: string, slot: string): string | null;
  /** Hand a NEW object URL to the registry, which revokes the previous one.
   *  The controller must never revoke one itself. */
  setObjectUrl(nodeId: string, slot: string, url: string | null, name?: string | null): void;
  /** The local filename stored beside the url — the authority on "does THIS
   *  browser have a local copy", replacing the card's own `$state` mirror. */
  mediaName(nodeId: string, slot: string): string | null;
}

/** Element operations the controller performs on the `<video>` itself. */
export interface VideoElementOps<E> {
  setSrc(el: E, url: string): void;
  setMuted(el: E, muted: boolean): void;
  currentTime(el: E): number;
  seek(el: E, to: number): void;
  paused(el: E): boolean;
  play(el: E): void;
  pause(el: E): void;
  /** Resolve once the element has metadata (duration/readyState populated). */
  awaitMetadata(el: E): Promise<void>;
  /** `el.duration` when finite, else 0. */
  duration(el: E): number;
}

/** Timers + clock, injected so the unit tests drive them deterministically. */
export interface VideoSourceClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface VideoSourceDeps<E> {
  engine: VideoSourceEngine | null;
  doc: VideoSourceDoc;
  media: VideoSourceMedia<E>;
  el: VideoElementOps<E>;
  clock: VideoSourceClock;
  /** `URL.createObjectURL`. Injected: the core has no `URL` in node env. */
  createObjectUrl(file: File): string;
  /** Register/unregister the portable "Export performance" bytes resolver.
   *  NODE-scoped: it used to be registered from the card's `onMount`, so a
   *  collapsed card left the node's loaded video out of the export even though
   *  the bytes were still live. */
  registerExport(nodeId: string, resolve: () => Promise<ExportedVideoBytes | null>): void;
  unregisterExport(nodeId: string): void;
  /** Read the bytes behind an object URL, for the export resolver. */
  fetchBytes(url: string): Promise<Uint8Array>;
  /**
   * Called whenever a node's published status changes.
   *
   * ⚠ PUSH, NOT POLL, and that is a correctness choice rather than a style one.
   * The surface needs `error` and `pendingHandleName` — states that exist for a
   * moment and then matter for as long as the user is looking at them. A poll
   * that samples between two changes shows neither, and a poll fast enough not
   * to is a second interval per node for something that changes a handful of
   * times per session. The real singleton binds this to a `$state` record; the
   * core tests bind it to an array and assert the TRANSITIONS.
   */
  onStatus?(nodeId: string, status: VideoSourceStatus): void;
}

export interface ExportedVideoBytes {
  bytes: Uint8Array;
  name: string;
}

// ---------------------------------------------------------------------------
// Published status + commands
// ---------------------------------------------------------------------------

/**
 * What a SURFACE (the legacy card today, a faceplate later) renders. Everything
 * here is browser-LOCAL: whether this machine holds a copy of the bytes is not a
 * fact about the rack, and syncing it would assert something false about every
 * other participant.
 */
export interface VideoSourceStatus {
  /** The local filename, or null when this browser has no copy. */
  readonly fileName: string | null;
  /** A load failure to show the user, or null. */
  readonly error: string | null;
  /**
   * The name of a remembered file handle whose read permission is in the
   * `prompt` state — the surface offers a one-click re-allow, and the
   * `requestPermission()` behind it MUST run inside that click's gesture.
   */
  readonly pendingHandleName: string | null;
  /** Has the engine confirmed the element is attached? Distinguishes "no file"
   *  from "file loaded but the node never materialized". */
  readonly attached: boolean;
  /** Has the element's audio reached the cross-domain bridge? */
  readonly audioWired: boolean;
}

/** The status a surface sees for a node with NO controller — a REAL state
 *  ("this node is not in the graph, or the graph effect has not run yet"), not a
 *  missing value to paper over. */
export const NO_VIDEO_SOURCE: VideoSourceStatus = {
  fileName: null,
  error: null,
  pendingHandleName: null,
  attached: false,
  audioWired: false,
};

/** What `request()` reports. See the DELIVERY paragraph in the header. */
export interface VideoSourceRequestResult {
  /** Was a controller registered to receive this? */
  readonly delivered: boolean;
  /** Set when the controller's handler threw — `delivered` is still true. */
  readonly error: unknown;
}

/** The gestures a surface may invoke. Each one is a USER ACTION that cannot
 *  originate anywhere else; none of them is a value a param could carry. */
export type VideoSourceCommand =
  /** A picked or dropped File became the node's source. */
  | { kind: 'load'; file: File; handle?: unknown; reuseHandleId?: string }
  /** Toggle transport, composing the same sync write a peer would see. */
  | { kind: 'togglePlay' }
  /** Seek to an absolute position in seconds. */
  | { kind: 'seek'; toSec: number }
  /** Clear the load error after the surface has shown it. */
  | { kind: 'clearError' };

export interface NodeVideoSourceRegistry<E> {
  /** Reconcile controllers against the graph. Creates one per matching node,
   *  disposes controllers whose node has left. Called from Canvas's graph
   *  effect, the same place `nodeExtras.sync` is called. */
  sync(nodes: readonly ModuleNode[], engine: VideoSourceEngine | null): void;
  /** The published status for a node. Never throws; returns `NO_VIDEO_SOURCE`
   *  when no controller exists. */
  view(nodeId: string): VideoSourceStatus;
  /** Invoke a gesture on the node's controller. */
  request(nodeId: string, cmd: VideoSourceCommand): VideoSourceRequestResult;
  /** True when a controller exists — the e2e probe's subject. */
  has(nodeId: string): boolean;
  /** Full teardown for one node. Keyed to the GRAPH, never to a card. */
  disposeNode(nodeId: string): void;
  /** Dispose every controller whose node is not in `liveIds`. */
  sweep(liveIds: Iterable<string>): void;
  /** Inspection for tests + the e2e probe. Properties, never a population
   *  COUNT that anything asserts on. */
  snapshot(): Array<{ nodeId: string } & VideoSourceStatus>;
}

/** Module types this registry owns a controller for.
 *
 *  ⚠ THIS IS THE ANCHOR THAT REPLACES `DOM_SOURCE_LANE_TYPES` MEMBERSHIP, and
 *  it is asserted in BOTH directions by `node-video-source-registry.test.ts`:
 *  every type here must be a registered def, and — the direction that matters —
 *  a type here must NOT also be in `DOM_SOURCE_LANE_TYPES`, because being in
 *  both would mean the card still attaches AND a controller attaches, i.e. two
 *  owners for one element. Converting a module is therefore one atomic edit:
 *  it enters this set in the same diff it leaves that one. */
export const NODE_VIDEO_SOURCE_TYPES: ReadonlySet<string> = new Set<string>([
  'videobox',
]);

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

interface Controller<E> {
  node: ModuleNode;
  el: E;
  status: VideoSourceStatus;
  /** Handles for the two long-running loops + the two retry loops. */
  timers: unknown[];
  /** Latched so the handle-reload runs once per node, not once per graph tick. */
  handleReloadAttempted: boolean;
  /** Previous `cv_play_trigger` sample, for rising-edge detection. */
  lastGateValue: number;
  /** Set by dispose so an in-flight async load cannot resurrect a dead node. */
  disposed: boolean;
  dispose(): void;
}

/**
 * Build a registry over injected seams. See the header for the invariants.
 *
 * `hooks` lets a caller supply the FileSystemFileHandle machinery, which is
 * Chromium-only and IndexedDB-backed. It is optional so the core tests need no
 * IDB: a build without it simply never offers the one-click re-allow, which is
 * the same thing Firefox and Safari already do.
 */
export function createNodeVideoSourceRegistry<E>(
  deps: VideoSourceDeps<E>,
  hooks?: VideoSourceHandleHooks,
): NodeVideoSourceRegistry<E> {
  const controllers = new Map<string, Controller<E>>();
  let liveEngine: VideoSourceEngine | null = deps.engine;

  function patchStatus(c: Controller<E>, next: Partial<VideoSourceStatus>): void {
    c.status = { ...c.status, ...next };
    try { deps.onStatus?.(c.node.id, c.status); } catch { /* a surface must never break the lifecycle */ }
  }

  /** Retry an idempotent action until `done()` reports success or the ceiling is
   *  reached. Used for BOTH races against the engine's async `addNode`. */
  function retryUntil(c: Controller<E>, action: () => void, done: () => boolean): void {
    let attempts = 0;
    const handle = deps.clock.setInterval(() => {
      if (c.disposed) { deps.clock.clearInterval(handle); return; }
      attempts++;
      try { action(); } catch { /* engine not ready */ }
      if (done() || attempts >= RETRY_ATTEMPTS) deps.clock.clearInterval(handle);
    }, RETRY_INTERVAL_MS);
    c.timers.push(handle);
    // Try once IMMEDIATELY as well: when the engine is already up (the common
    // case for a node added to a running rack) this attaches on the same tick
    // rather than after a 100 ms interval, so a spec that samples straight away
    // sees the source rather than a gap it has to wait out.
    try { action(); } catch { /* engine not ready */ }
    if (done()) deps.clock.clearInterval(handle);
  }

  function attachAndWire(c: Controller<E>): void {
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

  /** Wire the element's audio into the cross-domain bridge. Only meaningful
   *  once a file is loaded — an element with no src has nothing to route — so
   *  this is called from the load path, not at creation. */
  function ensureAudioWired(c: Controller<E>): void {
    retryUntil(
      c,
      () => {
        liveEngine?.extras(c.node.id)?.wireAudio();
      },
      () => {
        const ok = liveEngine?.extras(c.node.id)?.isAudioWired() === true;
        if (ok !== c.status.audioWired) patchStatus(c, { audioWired: ok });
        return ok;
      },
    );
  }

  /** Bring the local element in line with the SYNCED state — the half that used
   *  to be a card `$effect`, so a peer's play/pause reached nothing when no card
   *  was mounted. */
  function applySync(c: Controller<E>): void {
    const state = deps.doc.read(c.node.id);
    if (!state) return;
    if (deps.media.mediaName(c.node.id, VIDEO_SOURCE_SLOT) === null) return;
    if (state.isPlaying && deps.el.paused(c.el)) {
      // Programmatic play() can reject on autoplay-policy grounds even after a
      // page gesture; the next user click retries from a fresh one.
      try { deps.el.play(c.el); } catch { /* autoplay blocked */ }
    } else if (!state.isPlaying && !deps.el.paused(c.el)) {
      try { deps.el.pause(c.el); } catch { /* */ }
    }
    const decision = decideDriftCorrection(
      { isPlaying: state.isPlaying, lastSyncTime: state.lastSyncTime, lastSyncPosition: state.lastSyncPosition },
      deps.el.currentTime(c.el),
      deps.clock.now(),
      state.fileMeta?.duration ?? 0,
    );
    if (decision.kind === 'seek') {
      try { deps.el.seek(c.el, decision.to); } catch { /* */ }
    }
  }

  function startDriftLoop(c: Controller<E>): void {
    const handle = deps.clock.setInterval(() => {
      if (c.disposed) return;
      applySync(c);
    }, DRIFT_INTERVAL_MS);
    c.timers.push(handle);
  }

  /** `play_trigger`'s rising edge toggles transport. NODE-lifetime: a gate cable
   *  patched into a videobox whose card is collapsed did nothing before this
   *  moved off the card. */
  function startGateLoop(c: Controller<E>): void {
    const handle = deps.clock.setInterval(() => {
      if (c.disposed || !liveEngine) return;
      const v = liveEngine.readParam(c.node, 'cv_play_trigger');
      if (typeof v !== 'number') return;
      if (c.lastGateValue < GATE_RISING_EDGE && v >= GATE_RISING_EDGE) {
        const state = deps.doc.read(c.node.id);
        const cur = deps.media.mediaName(c.node.id, VIDEO_SOURCE_SLOT) !== null
          ? deps.el.currentTime(c.el)
          : (state?.lastSyncPosition ?? 0);
        deps.doc.writeSync(c.node.id, {
          isPlaying: !(state?.isPlaying ?? false),
          currentPositionSec: cur,
        });
      }
      c.lastGateValue = v;
    }, GATE_INTERVAL_MS);
    c.timers.push(handle);
  }

  async function loadFile(
    c: Controller<E>,
    file: File,
    opts?: { handle?: unknown; reuseHandleId?: string },
  ): Promise<void> {
    if (c.disposed) return;
    patchStatus(c, { error: null, pendingHandleName: null });
    if (!file.type.startsWith('video/')) {
      patchStatus(c, { error: `Not a video file: ${file.type || file.name}` });
      return;
    }
    const prevMeta = deps.doc.read(c.node.id)?.fileMeta ?? null;
    // Hand the new url to the registry, which revokes the PREVIOUS one. The
    // controller must never revoke one itself — that is the specific teardown
    // that made a loaded file unrecoverable.
    deps.media.setObjectUrl(c.node.id, VIDEO_SOURCE_SLOT, deps.createObjectUrl(file), file.name);
    const url = deps.media.objectUrl(c.node.id, VIDEO_SOURCE_SLOT);
    if (!url) return;
    deps.el.setSrc(c.el, url);
    // muted=false so audio reaches MediaElementSource, which IS the output once
    // wireAudio() runs. Web Audio mutes the element's own speaker path at that
    // point, so this only matters for the window before it.
    deps.el.setMuted(c.el, false);
    patchStatus(c, { fileName: file.name });

    await deps.el.awaitMetadata(c.el);
    if (c.disposed) return;

    // Persist the handle BEFORE writing fileMeta, so the id stamped into the
    // synced meta is the one the handle is stored under.
    let handleId: string | undefined = opts?.reuseHandleId;
    if (opts?.handle && hooks?.canPersist()) {
      try {
        if (!handleId) handleId = hooks.newId();
        await hooks.put(handleId, opts.handle);
      } catch { handleId = opts?.reuseHandleId; }
    }
    if (c.disposed) return;

    // ⚠ Reset the playhead only for a genuinely DIFFERENT file. Doing it
    // unconditionally was an independent cause of "it stopped playing": the
    // handle-reload path re-loads the SAME file through here, so a node that
    // restored itself came back paused at 0 even though its synced state said
    // it was playing.
    const isSameFile =
      prevMeta?.handleId !== undefined && handleId !== undefined && prevMeta.handleId === handleId;
    deps.doc.writeFileMeta(
      c.node.id,
      {
        name: file.name,
        duration: deps.el.duration(c.el),
        size: Number.isFinite(file.size) ? file.size : undefined,
        handleId,
      },
      { resetPlayhead: !isSameFile },
    );
    ensureAudioWired(c);
    applySync(c);
  }

  /** Patch-load restore from a remembered handle. The `granted` branch needs NO
   *  gesture, which is what makes "rack save/reload restores the source without
   *  a card ever mounting" true. The `prompt` branch cannot be done here at all
   *  — it is published for a surface to offer as a click. */
  async function tryReloadFromHandle(c: Controller<E>): Promise<void> {
    if (!hooks || c.disposed) return;
    const meta = deps.doc.read(c.node.id)?.fileMeta ?? null;
    const handleId = meta?.handleId;
    if (!handleId) return;
    if (deps.media.mediaName(c.node.id, VIDEO_SOURCE_SLOT) !== null) return;
    let handle: unknown | null = null;
    try { handle = await hooks.get(handleId); } catch { return; }
    if (!handle || c.disposed) return;
    let perm: 'granted' | 'prompt' | 'denied';
    try { perm = await hooks.queryPermission(handle); } catch { return; }
    if (c.disposed) return;
    if (perm === 'granted') {
      try {
        const file = await hooks.getFile(handle);
        await loadFile(c, file, { handle, reuseHandleId: handleId });
      } catch { /* moved/deleted on disk — the surface's re-link prompt covers it */ }
      return;
    }
    if (perm === 'prompt') {
      patchStatus(c, { pendingHandleName: meta?.name ?? handleId });
    }
    // 'denied' → nothing; the re-link prompt covers it.
  }

  function createController(node: ModuleNode): Controller<E> {
    // `ensure` (not `adopt`): the element is created PARKED and stays parked
    // until some card adopts it for display. THIS CALL is what makes the source
    // exist with no card mounted anywhere — the whole point of #1511.
    const el = deps.media.ensure(node.id, VIDEO_SOURCE_SLOT);
    const c: Controller<E> = {
      node,
      el,
      status: {
        ...NO_VIDEO_SOURCE,
        fileName: deps.media.mediaName(node.id, VIDEO_SOURCE_SLOT),
      },
      timers: [],
      handleReloadAttempted: false,
      lastGateValue: 0,
      disposed: false,
      dispose(): void {
        if (c.disposed) return;
        c.disposed = true;
        for (const t of c.timers) {
          try { deps.clock.clearInterval(t); } catch { /* */ }
        }
        c.timers = [];
        try { deps.unregisterExport(node.id); } catch { /* */ }
        // ⚠ DELIBERATELY ABSENT: no `attach(id, null)`, no `revokeObjectURL`,
        // no `stopStream`. The ELEMENT and its url belong to `nodeMedia` and are
        // freed by ITS graph-keyed sweep in the same Canvas effect. Detaching
        // here would re-create the #1511 bug one level down: a controller
        // disposed and immediately re-created by a graph tick would blank a
        // source that never needed to go away.
      },
    };
    deps.registerExport(node.id, async () => {
      const url = deps.media.objectUrl(node.id, VIDEO_SOURCE_SLOT);
      if (!url) return null;
      const bytes = await deps.fetchBytes(url);
      const name =
        deps.media.mediaName(node.id, VIDEO_SOURCE_SLOT) ??
        deps.doc.read(node.id)?.fileMeta?.name ??
        'videobox.mp4';
      return { bytes, name };
    });
    attachAndWire(c);
    startDriftLoop(c);
    startGateLoop(c);
    // A node restored from a saved rack already has fileMeta; a freshly spawned
    // one does not. Both go through the same call — it no-ops without a
    // handleId — so there is no "was this a load or a spawn" branch to get wrong.
    c.handleReloadAttempted = true;
    void tryReloadFromHandle(c);
    // Re-wire audio for a node whose bytes are ALREADY live (a controller
    // re-created after a graph churn while the url survived in nodeMedia).
    if (deps.media.mediaName(node.id, VIDEO_SOURCE_SLOT) !== null) ensureAudioWired(c);
    return c;
  }

  return {
    sync(nodes, engine) {
      liveEngine = engine;
      const live = new Set<string>();
      for (const n of nodes) {
        if (!NODE_VIDEO_SOURCE_TYPES.has(n.type)) continue;
        live.add(n.id);
        const existing = controllers.get(n.id);
        if (existing) {
          // Refresh the node reference: `readParam` needs the CURRENT node
          // object, and the graph hands out a new one on every change.
          existing.node = n;
          // ⚠ APPLY THE SYNCED STATE ON EVERY GRAPH TICK, not only on the drift
          // interval. MEASURED (videobox-output.spec.ts, `VIDEOBOX -> BENTBOX ->
          // VIDEO-OUT`): without this, pressing play left the element paused for
          // up to DRIFT_INTERVAL_MS, the render burst read frame 0, and BENTBOX's
          // FBO came back a FLAT FILL — `uploads > 0` and the chain fully wired,
          // so every liveness guard passed while the picture was a still frame.
          //
          // The card this replaces got it right by accident of framework: it had
          // a Svelte `$effect` on the synced triple, so play/pause reached the
          // element the moment the Y.Doc changed. A controller is not reactive,
          // and Canvas's sync effect IS — it re-runs on every `snapshot.nodes`
          // change, which is exactly when the triple can have moved. So this is
          // the same reactivity, taken from the place that still has it, and the
          // drift loop returns to being what its name says: a periodic
          // CORRECTION, not the delivery mechanism for user intent.
          applySync(existing);
          continue;
        }
        controllers.set(n.id, createController(n));
      }
      for (const [id, c] of [...controllers]) {
        if (!live.has(id)) { c.dispose(); controllers.delete(id); }
      }
    },

    view(nodeId) {
      const c = controllers.get(nodeId);
      if (!c) return NO_VIDEO_SOURCE;
      // The filename is read THROUGH the registry rather than mirrored, so a
      // surface can never come up believing the node has no local file while
      // the bytes are live — the exact stale-mirror bug the card had.
      const name = deps.media.mediaName(nodeId, VIDEO_SOURCE_SLOT);
      if (name !== c.status.fileName) patchStatus(c, { fileName: name });
      return c.status;
    },

    request(nodeId, cmd) {
      const c = controllers.get(nodeId);
      if (!c) return { delivered: false, error: null };
      try {
        switch (cmd.kind) {
          case 'load':
            void loadFile(c, cmd.file, { handle: cmd.handle, reuseHandleId: cmd.reuseHandleId });
            break;
          case 'togglePlay': {
            const state = deps.doc.read(nodeId);
            const has = deps.media.mediaName(nodeId, VIDEO_SOURCE_SLOT) !== null;
            deps.doc.writeSync(nodeId, {
              isPlaying: !(state?.isPlaying ?? false),
              currentPositionSec: has ? deps.el.currentTime(c.el) : (state?.lastSyncPosition ?? 0),
            });
            // Apply to the element NOW rather than waiting for the graph tick to
            // come back around. The sync in `sync()` is the general mechanism
            // (and covers PEER changes); this makes the LOCAL press instant,
            // which is the difference between a transport that feels wired and
            // one that feels laggy.
            applySync(c);
            break;
          }
          case 'seek': {
            if (!Number.isFinite(cmd.toSec)) break;
            if (deps.media.mediaName(nodeId, VIDEO_SOURCE_SLOT) !== null) {
              try { deps.el.seek(c.el, cmd.toSec); } catch { /* */ }
            }
            // Written REGARDLESS of a local copy — peers that have one follow.
            deps.doc.writeSync(nodeId, {
              isPlaying: deps.doc.read(nodeId)?.isPlaying ?? false,
              currentPositionSec: cmd.toSec,
            });
            applySync(c);
            break;
          }
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
        if (!live.has(id)) { c.dispose(); controllers.delete(id); }
      }
    },

    snapshot() {
      const out: Array<{ nodeId: string } & VideoSourceStatus> = [];
      for (const [nodeId, c] of controllers) out.push({ nodeId, ...c.status });
      return out;
    },
  };
}

/** The FileSystemFileHandle machinery, injected because it is Chromium-only and
 *  IndexedDB-backed — neither exists in the node-env unit lane. */
export interface VideoSourceHandleHooks {
  canPersist(): boolean;
  newId(): string;
  put(id: string, handle: unknown): Promise<void>;
  get(id: string): Promise<unknown | null>;
  queryPermission(handle: unknown): Promise<'granted' | 'prompt' | 'denied'>;
  requestPermission(handle: unknown): Promise<'granted' | 'prompt' | 'denied'>;
  getFile(handle: unknown): Promise<File>;
}

