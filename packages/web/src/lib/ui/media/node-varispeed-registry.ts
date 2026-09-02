// packages/web/src/lib/ui/media/node-varispeed-registry.ts
//
// NODE-OWNED VARISPEED TRANSPORT (LEG-02 P2, #1511) — the controller that makes
// VIDEOVARISPEED's seven-slot player exist, switch and run because the NODE
// exists, not because a card is mounted.
//
// ── WHY A SIBLING OF ./node-video-source-registry AND NOT A GENERALISATION ───
//
// P1 built a node-owned source controller for VIDEOBOX and this module needs the
// same four things it does — an attach that survives the card, an audio wire, a
// gesture seam, and graph lifetime. It is tempting to parameterise one registry
// over both.
//
// The transports are not a parameterisation of each other; they are two models.
// VIDEOBOX's playhead is a WALL CLOCK: `decideDriftCorrection` derives where the
// element SHOULD be from `lastSyncPosition + (now - lastSyncTime)`, and seeks
// when reality drifts. VIDEOVARISPEED's playhead is a VIRTUAL POSITION advanced
// by `speed x dt` per frame, per slot, with six of the seven slots running
// playheads for clips that are not even on air. There is no wall clock to
// correct against, and no drift concept at all — a paused varispeed is not
// "behind", it is where it was left.
//
// So this is a sibling. It shares the SEAMS (the clock/timer injection and the
// delivery-reporting command result are imported from the P1 registry, not
// re-declared) and nothing else. Generalising on a population of two is how the
// wrong abstraction gets locked in; if a third arrives and genuinely rhymes,
// that is when to extract.
//
// ── THE TWO LIVE DEFECTS THIS FIXES ─────────────────────────────────────────
//
// ⚠ 1. A COLLAPSED-GROUP VARISPEED HAS NO CARD ANYWHERE, SO ITS CV INPUTS ARE
// DEAD. `needsHeadlessSourceMount`'s `laneOmitsNode` arm returns
// `CARD_PRODUCER_LANE_TYPES.has(type)`, which is FALSE for videovarispeed — so a
// collapsed group's child gets no headless host AND no lane node. Measured over
// the pure decision, all four lane states:
//
//     lane placeholder (ordinary rack)  HOST     -> CV poll runs
//     dock full view open               no host  -> the DOCK mounts the card
//     inside a COLLAPSED GROUP          NO CARD  -> transport + all 5 CV DEAD
//     canvas-hidden / pinned            NO CARD  -> transport + all 5 CV DEAD
//
// So a clip player wired into ASSET PITCH / ASSET GATE stops switching clips the
// moment someone collapses the group around it — along with cv_start, cv_pause,
// cv_reset and cv_loop_toggle. The jacks stay visibly patched. Nothing logs.
//
// ⚠ 2. EVERY EXPAND OR COLLAPSE RESETS THE SLOT AND WIPES ALL SEVEN PLAYHEADS,
// AND THIS ONE HITS AN ORDINARY RACK. `activeSlot` and `slotPos[]` were card
// `$state` with NO persistence path — not `node.data`, not the Y.Doc, not a
// registry (`slotNames` IS rehydrated from `nodeMedia`; these two never were).
// Expanding the dock moves the card from the headless host into the tray, which
// is an unmount plus a mount, so `activeSlot` re-initialises to 0. Switch to
// slot 3, expand, and you are watching slot 0 from the top.
//
// Both dissolve here rather than being patched: state that lives on the node
// cannot be reset by a view appearing or disappearing.
//
// ── OWNERSHIP ───────────────────────────────────────────────────────────────
//
// One controller per videovarispeed NODE, created by `sync(nodes, engine)` from
// Canvas's graph effect and disposed by the same `sweep(liveIds)` row that
// already retires `nodeMedia` and the P1 source controllers. It owns:
//
//   * all seven slot elements (`ensure`d PARKED, so they exist and decode before
//     any card mounts) and the keep-alive that holds every LOADED slot warm —
//     without it a switch lands on a frame throttled to ~1 fps;
//   * the engine attach, RE-POINTED on every slot switch, plus its retry;
//   * the audio wire, re-pointed with it (audio follows the switched video);
//   * the TRANSPORT loop — playbackRate, throttled reverse scrub, window edges,
//     and the six off-air virtual playheads;
//   * the CV poll — cv_start, cv_pause, cv_reset, cv_loop_toggle and asset_gate;
//   * the PER-SLOT LOADER (`loadFile`), the slot-0 and per-slot SAVED-HANDLE
//     RESTORE and the MULTI-SLOT EXPORT RESOLVER;
//   * the crop push AND its aspect re-fit;
//   * `activeSlot`, `slotPos[]` and the one-shot latch.
//
// ⚠ THE THREE ITEMS ON THE SECOND BULLET ARRIVED IN THE FACE PR, NOT IN P2, AND
// THIS HEADER CLAIMED THEM A WAVE EARLY. Until then `loadFileIntoSlot`,
// `tryReloadFromHandle`, `tryReloadSlotFromHandle` and `resolveAllSlotBytes`
// all lived in `VideoVarispeedCard.svelte` — and this module imports neither
// `video-file-store` nor `video-export-registry`, so it could not load bytes at
// all. That mattered beyond tidiness, because the card's `$effect` on
// `fileMeta.handleId` is the DOCUMENTED DELIVERY MECHANISM for three writers
// OUTSIDE the module: the Loaded-Assets picker spawn and the rebind sweep
// (`$lib/media/asset-spawn` — videovarispeed is the module spawned for EVERY
// video asset) and the perf-zip restore (`Canvas.svelte`), each of which writes
// `fileMeta`/`slotMeta` and waits for a surface to notice. videovarispeed is in
// neither `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so it gets NO
// headless host and the default shell mounts no card anywhere — meaning all
// three were already dock-gated on `main`: drop a video into the asset picker,
// never open the dock, and nothing loads. Moving the loader here is the REPAIR;
// the face promotion is what made it unavoidable rather than what broke it.
//
// The card keeps only what a view owns: which element is adopted into which
// host, and the gestures a mounted surface must originate.
//
// ⚠ THE EDGE DETECTOR IS MOVED VERBATIM, NOT "CORRECTED". CLAUDE.md requires
// `$lib/audio/edge-detect` `createEdgeCounter` for main-thread trigger
// detection, and that rule is about RE-SCANNING AN ANALYSERNODE BUFFER: the
// 2048-sample ring (~42 ms) overlaps the ~25 ms scheduler tick, so a whole-buffer
// rescan counts one edge twice. This reads a SYNTHETIC CV PARAM the engine has
// already edge-shaped — one scalar per poll, no buffer, no overlap — so the
// hazard does not apply and swapping mechanisms would be a behaviour change
// wearing a compliance costume.
//
// HASH TRANSPARENCY: `lib/ui/**`, NOT `lib/video/**` — that directory is hashed
// WHOLESALE for the WebGL attest. The transport MATH is imported from
// `$lib/video/modules/videovarispeed-transport` and left untouched; reading a
// basis file costs nothing, editing one costs a GPU window. Do not move this
// file and do not "simplify" it by adding an engine-side hook.
//
// TESTABILITY: the web package's vitest runs in `environment: 'node'`, so the
// clock, the frame loop, the engine, the Y.Doc and the media registry are all
// INJECTED. `nodeVarispeed` (./node-varispeed.svelte.ts) is the real binding.

import type { ModuleNode } from '$lib/graph/types';
import {
  speedKnobToMultiplier,
  effectiveSpeedKnob,
  effectiveStartFraction,
  effectiveEndFraction,
  resolveWindow,
  decideEdgeAction,
  reverseScrubStep,
  type PlaybackWindow,
} from '$lib/video/modules/videovarispeed-transport';
import { slotForVOct, ASSET_SLOTS } from '$lib/video/asset-select';
import type { CropRect } from '$lib/video/crop-core';
import type { VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
// ⚠ The per-slot size cap comes from the DEF, never re-typed here — the same
// one-source rule a card's control range obeys. Reading a WebGL-basis file is
// free; editing one costs a GPU attest window.
import { VIDEOVARISPEED_MAX_SLOT_BYTES } from '$lib/video/modules/videovarispeed';
import type {
  VideoSourceClock,
  VideoSourceHandleHooks,
  VideoSourceRequestResult,
} from './node-video-source-registry';

/**
 * The media slot key for asset slot `i`.
 *
 * ⚠ `slot0`, NOT `main`, and this is not cosmetic. `nodeMedia` is keyed
 * `(nodeId, slot)`, so the CARD must adopt exactly the key the controller
 * ensured — and VideoVarispeedCard has always written `slot${i}` for EVERY
 * slot, slot 0 included. A controller that ensured `main` would mint a SECOND,
 * empty element for slot 0, leave the card adopting the original, and orphan the
 * bytes of every rack already saved with a `slot0` url. ONE spelling, exported,
 * so the two cannot drift.
 */
export function varispeedSlotKey(i: number): string {
  return `slot${i}`;
}

/** Module types this registry owns. Anchored in both directions by
 *  `node-varispeed-registry.test.ts`, and asserted DISJOINT from
 *  `DOM_SOURCE_LANE_TYPES` — membership of both would mean the card and the
 *  controller both attach, i.e. two owners for one element. */
export const NODE_VARISPEED_TYPES: ReadonlySet<string> = new Set<string>([
  'videovarispeed',
]);

/** CV poll cadence — ~30 Hz, the rate the card used. */
export const CV_INTERVAL_MS = 33;
/** Housekeeping cadence — the saved-handle restore, the crop aspect re-fit and
 *  the published duration. Deliberately an order of magnitude slower than the
 *  gate poll; see `startHousekeepingLoop`. */
export const HOUSEKEEPING_INTERVAL_MS = 250;
/** Retry cadence + ceiling for the races against the engine's async `addNode`. */
export const RETRY_INTERVAL_MS = 100;
export const RETRY_ATTEMPTS = 50;
/** The canonical gate rising-edge threshold. */
const GATE_RISING_EDGE = 0.5;

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** The engine surface, every method a 1:1 map onto an EXISTING public call. */
export interface VarispeedEngine {
  attach(nodeId: string, el: unknown | null): void;
  hasElement(nodeId: string): boolean;
  extras(nodeId: string): VarispeedExtras | null;
  readParam(node: ModuleNode, paramId: string): number | undefined;
  /**
   * The KNOB value for a param — `node.params[id]` with the DEF'S DEFAULT as the
   * fallback.
   *
   * ⚠ NOT `readParam`, and the difference is not cosmetic. `readParam` reads the
   * ENGINE's value, which is 0 for a param the user has never touched; the knob
   * reader falls back to the DEF's `defaultValue`. `end` defaults to 1, so
   * reading it through `readParam` yields 0 -> `startSec < endSec` is false ->
   * `hasWindow` false -> the transport PAUSES the element and the engine stops
   * uploading frames. MEASURED: `videovarispeed-switch.spec.ts` failed with
   * "engine frame uploads must climb after the switch (was 40)". The card always
   * used its `paramVal` helper here; this seam is that helper.
   */
  knob(node: ModuleNode, paramId: string): number;
  /** Is `portId` actually patched? The window math treats an UNPATCHED cv input
   *  differently from one sitting at zero. */
  isConnected(node: ModuleNode, portId: string): boolean;
}

export interface VarispeedExtras {
  wireAudio(): void;
  isAudioWired(): boolean;
  /**
   * Push the crop rectangle (null = full-frame passthrough).
   *
   * ⚠ THIS IS NODE LIFETIME FOR THE SAME REASON AS THE REST, and it was the
   * third defect of the family. The rect is PERSISTED on `node.data`, but the
   * only thing that ever pushed it to the engine was a card `$effect` — so a
   * rack saved with a crop and reopened with the module collapsed applied NO
   * crop, silently, with the control still showing one.
   */
  setCrop(rect: unknown | null): void;
  /** Hold a LOADED but off-air slot warm. Without it the browser throttles an
   *  unrendered element to ~1 fps and a switch lands on a stale frame. */
  keepSlotAlive(el: unknown): void;
}

/** The synced state this controller reads and writes. */
export interface VarispeedDoc {
  read(nodeId: string): VarispeedSyncState | null;
  writePlaying(nodeId: string, next: boolean): void;
  writeLoop(nodeId: string, next: boolean): void;
  /** Publish the ACTIVE-slot-0 file metadata (`node.data.fileMeta`) — the
   *  legacy single-video key the perf-zip loader, the asset picker and the
   *  rebind sweep all write and read. */
  writeFileMeta(nodeId: string, meta: VideoboxFileMeta): void;
  /** Publish one slot's metadata into the synced `slotMeta` array. `null`
   *  clears the slot. The binding owns the PLAIN-clone discipline (never
   *  re-insert a live Y type — the sequencer save-to-slot trap). */
  writeSlotMeta(nodeId: string, slot: number, meta: VideoboxFileMeta | null): void;
  /**
   * Read the eight file-meta records (slot 0's legacy `fileMeta` plus the seven
   * `slotMeta` rows).
   *
   * ⚠ A SEPARATE READER FROM `read()` ON PURPOSE, AND IT IS A HOT-PATH
   * CONSTRAINT RATHER THAN A TIDY-UP. `read()` is called on EVERY rAF frame by
   * `transportTick`, PER NODE, and a rack can hold ten varispeeds. Folding the
   * metas into it would make each of those frames clone eight objects for a
   * value the frame path never looks at. The metas are needed only by the
   * saved-handle restore, which runs a handful of times per node, so they get
   * their own reader and the frame path stays exactly as cheap as it was before
   * this module owned the loader.
   */
  readMeta(nodeId: string): VarispeedMetaState | null;
  /** Persist the crop rect. Used ONLY by the aspect re-fit — every other crop
   *  write is a surface gesture that goes through `crop-edit`. */
  writeCrop(nodeId: string, active: boolean, rect: CropRect): void;
}

/**
 * LOOP is ON by default for this module. ONE owner for that fact, exported so
 * the doc binding cannot pick a different fallback than the transport assumes —
 * which is exactly the defect that shipped: the binding defaulted it to `false`,
 * so a FRESH node ran as ONE-SHOT, latched at the window end and PAUSED, and the
 * engine stopped uploading frames. Invisible until the node is in the state
 * nobody sets explicitly, i.e. every fresh node.
 */
export const VARISPEED_DEFAULT_LOOP = true;

export interface VarispeedSyncState {
  isPlaying: boolean;
  /** Undefined means "never set" — resolved with VARISPEED_DEFAULT_LOOP. */
  loop?: boolean;
  /** The persisted crop rect COERCED against the live output aspect, or null
   *  for full-frame passthrough. */
  crop: unknown | null;
  /** The RAW stored rect, uncoerced — the aspect re-fit needs both halves to
   *  tell "the stored value is still valid" from "it moved and must be
   *  re-persisted". Absent when nothing is stored. */
  rawCrop?: CropRect | null;
  /** The live OUTPUT aspect the crop is locked to (16:9 ↔ 4:3). */
  outAspect?: number;
}

/** The eight file-meta records, read OFF the frame path. See `readMeta`. */
export interface VarispeedMetaState {
  /** Slot 0's legacy single-video metadata. */
  fileMeta: VideoboxFileMeta | null;
  /** The synced 7-slot metadata array (sparse; `null` = empty slot). */
  slotMeta: readonly (VideoboxFileMeta | null)[];
}

/** Element operations, injected because node-env has no HTMLVideoElement. */
export interface VarispeedElementOps<E> {
  currentTime(el: E): number;
  seek(el: E, to: number): void;
  paused(el: E): boolean;
  play(el: E): void;
  pause(el: E): void;
  setMuted(el: E, muted: boolean): void;
  setPlaybackRate(el: E, rate: number): void;
  playbackRate(el: E): number;
  duration(el: E): number;
  /** Point the element at an object URL. */
  setSrc(el: E, url: string): void;
  /** Drop the element's source (an explicit user CLEAR of a slot). */
  clearSrc(el: E): void;
  /** Resolve once the element has metadata (duration / readyState populated). */
  awaitMetadata(el: E): Promise<void>;
}

/** The node-media seam — the same registry P1 uses, narrowed. */
export interface VarispeedMedia<E> {
  ensure(nodeId: string, slot: string): E;
  mediaName(nodeId: string, slot: string): string | null;
  /** The object URL currently owned for this slot, or null. */
  objectUrl(nodeId: string, slot: string): string | null;
  /** Hand a NEW object URL to the registry, which revokes the previous one.
   *  The controller must NEVER revoke one itself — that is the specific
   *  teardown that made a loaded file unrecoverable (#1511). */
  setObjectUrl(nodeId: string, slot: string, url: string | null, name?: string | null): void;
}

/** A per-frame loop. Bound to rAF in the browser; driven by hand in tests, so a
 *  transport assertion never depends on a real frame arriving. */
export interface VarispeedFrameLoop {
  start(tick: (nowMs: number) => void): unknown;
  stop(handle: unknown): void;
}

export interface VarispeedDeps<E> {
  engine: VarispeedEngine | null;
  doc: VarispeedDoc;
  media: VarispeedMedia<E>;
  el: VarispeedElementOps<E>;
  clock: VideoSourceClock;
  frames: VarispeedFrameLoop;
  /** `URL.createObjectURL`. Injected: the core has no `URL` in node env. */
  createObjectUrl(file: File): string;
  /** Register / unregister the portable "Export performance" bytes resolver.
   *  NODE-scoped: it used to be registered from the card's `onMount`, so a rack
   *  whose videovarispeed had no card mounted — which is EVERY rack under the
   *  default shell — exported none of its seven slots' bytes. */
  registerExport(nodeId: string, resolve: () => Promise<VarispeedExportedBytes[] | null>): void;
  unregisterExport(nodeId: string): void;
  /** Read the bytes behind an object URL, for the export resolver. */
  fetchBytes(url: string): Promise<Uint8Array>;
  onStatus?(nodeId: string, status: VarispeedStatus): void;
}

/** One populated slot's bytes for the portable .zip. `slot` rides along so the
 *  loader restores into the matching slot index (the Fix B multi-slot shape). */
export interface VarispeedExportedBytes {
  bytes: Uint8Array;
  name: string;
  slot: number;
}

// ---------------------------------------------------------------------------
// Published status
// ---------------------------------------------------------------------------

export interface VarispeedStatus {
  /** Which asset slot is ON AIR. NODE state now — it used to be card `$state`
   *  initialised to 0, so every remount snapped the player back to slot 0. */
  readonly activeSlot: number;
  /** Per-slot local filename, or null where this browser holds no bytes. */
  readonly slotNames: readonly (string | null)[];
  /** The active slot's live position, for the seek bar. */
  readonly positionSec: number;
  /** All seven VIRTUAL playheads. Published because they are node state now:
   *  the e2e hook that reads them must work with NO card mounted, which is the
   *  whole condition under test. */
  readonly slotPos: readonly number[];
  readonly attached: boolean;
  readonly audioWired: boolean;
  /** The ACTIVE slot's duration in seconds, read from its element at
   *  `loadedmetadata`. Published because the synced `fileMeta.duration` lags a
   *  freshly loaded slot by a round trip, and a surface reading 0 draws a dead
   *  scrubber over a clip that is playing. */
  readonly durationSec: number;
  /** A load failure to show the player, or null. */
  readonly error: string | null;
  /** The name of a remembered handle whose read permission is in the `prompt`
   *  state. The surface offers the one-click re-allow, because
   *  `requestPermission()` is honoured only inside that click's gesture — the
   *  controller can offer it but cannot perform it. */
  readonly pendingHandleName: string | null;
  /** Which slots have a load in flight (the row's `…` caption). */
  readonly loadingSlots: readonly boolean[];
}

export const NO_VARISPEED: VarispeedStatus = {
  activeSlot: 0,
  slotNames: new Array(ASSET_SLOTS).fill(null),
  positionSec: 0,
  slotPos: new Array(ASSET_SLOTS).fill(0),
  attached: false,
  audioWired: false,
  durationSec: 0,
  error: null,
  pendingHandleName: null,
  loadingSlots: new Array(ASSET_SLOTS).fill(false),
};

/** Gestures a mounted surface may originate. */
export type VarispeedCommand =
  | { kind: 'selectSlot'; slot: number }
  | { kind: 'togglePlay' }
  | { kind: 'seek'; toSec: number }
  | { kind: 'setLoop'; loop: boolean }
  | { kind: 'gateStart' }
  | { kind: 'gatePause' }
  | { kind: 'gateReset' }
  /** Bytes arrived in (or left) a slot: re-run the keep-alive, the audio wire
   *  and the attach. The controller cannot observe an object-URL write. */
  | { kind: 'slotLoaded'; slot: number }
  /** The persisted crop changed — re-push it. */
  | { kind: 'cropChanged' }
  /** A picked / dropped / re-allowed File becomes slot `slot`'s source. THE
   *  gesture the whole module is for, and the one a def-reading gate cannot
   *  see: no ParamCellKind mounts an `<input type=file>`. */
  | { kind: 'loadFile'; slot: number; file: File; handle?: unknown; reuseHandleId?: string }
  /** An explicit user CLEAR of one slot — the one place a surface may free a
   *  slot's bytes, because it is a deliberate content change rather than a view
   *  teardown. */
  | { kind: 'clearSlot'; slot: number }
  /** Dismiss the load error after a surface has shown it. */
  | { kind: 'clearError' };

export interface NodeVarispeedRegistry {
  sync(nodes: readonly ModuleNode[], engine: VarispeedEngine | null): void;
  view(nodeId: string): VarispeedStatus;
  request(nodeId: string, cmd: VarispeedCommand): VideoSourceRequestResult;
  has(nodeId: string): boolean;
  disposeNode(nodeId: string): void;
  sweep(liveIds: Iterable<string>): void;
  snapshot(): Array<{ nodeId: string } & VarispeedStatus>;
}

// ---------------------------------------------------------------------------

interface Controller<E> {
  node: ModuleNode;
  els: E[];
  status: VarispeedStatus;
  timers: unknown[];
  frameHandle: unknown;
  /** VIRTUAL playheads, one per slot. The six off-air ones keep advancing so a
   *  switch lands on a de-synced live position rather than where the clip was
   *  abandoned — the behaviour the card had, now on node lifetime. */
  slotPos: number[];
  slotDuration: number[];
  /** Render-local one-shot latch: a ONE-SHOT clip that reached END stays
   *  stopped until a START gate or a LOOP re-enable re-arms it. */
  oneShotEnded: boolean;
  reverseActive: boolean;
  reverseAccumMs: number;
  lastFrameMs: number;
  lastGate: Record<string, number>;
  /** Per-slot restore latch — each slot's saved-handle reload runs ONCE per
   *  controller, not once per graph tick. */
  reloadAttempted: boolean[];
  /** The aspect the stored crop was last re-fitted for. */
  lastRefitAspect: number;
  disposed: boolean;
  dispose(): void;
}

export function createNodeVarispeedRegistry<E>(
  deps: VarispeedDeps<E>,
  hooks?: VideoSourceHandleHooks,
): NodeVarispeedRegistry {
  const controllers = new Map<string, Controller<E>>();
  let liveEngine: VarispeedEngine | null = deps.engine;

  function patch(c: Controller<E>, next: Partial<VarispeedStatus>): void {
    c.status = { ...c.status, ...next };
    try { deps.onStatus?.(c.node.id, c.status); } catch { /* a view must never break the lifecycle */ }
  }

  function activeEl(c: Controller<E>): E | null {
    return c.els[c.status.activeSlot] ?? null;
  }

  function hasBytes(c: Controller<E>, slot: number): boolean {
    return deps.media.mediaName(c.node.id, varispeedSlotKey(slot)) !== null;
  }

  function readCv(c: Controller<E>, paramId: string): number {
    const v = liveEngine?.readParam(c.node, paramId);
    return typeof v === 'number' ? v : 0;
  }

  function risingEdge(c: Controller<E>, paramId: string): boolean {
    const v = readCv(c, paramId);
    const prev = c.lastGate[paramId] ?? 0;
    c.lastGate[paramId] = v;
    return prev < GATE_RISING_EDGE && v >= GATE_RISING_EDGE;
  }

  function readKnob(c: Controller<E>, paramId: string): number {
    return liveEngine?.knob(c.node, paramId) ?? 0;
  }

  function effectiveSpeed(c: Controller<E>): number {
    return speedKnobToMultiplier(effectiveSpeedKnob(readKnob(c, 'speed'), readCv(c, 'speedCv')));
  }

  function slotDurationSec(c: Controller<E>, i: number): number {
    const el = c.els[i];
    if (el) {
      const d = deps.el.duration(el);
      if (Number.isFinite(d) && d > 0) return d;
    }
    return c.slotDuration[i] ?? 0;
  }

  function windowFor(c: Controller<E>, i: number): PlaybackWindow {
    // ⚠ The cv-CONNECTED booleans are load-bearing, not decoration: an
    // UNPATCHED start/end cv input is ignored entirely, whereas one patched and
    // sitting at zero pulls the window to the clip head. `effective*Fraction`
    // owns that distinction; this only has to supply it honestly.
    const startFraction = effectiveStartFraction(
      readKnob(c, 'start'),
      readCv(c, 'startCv'),
      liveEngine?.isConnected(c.node, 'startCv') ?? false,
    );
    const endFraction = effectiveEndFraction(
      readKnob(c, 'end'),
      readCv(c, 'endCv'),
      liveEngine?.isConnected(c.node, 'endCv') ?? false,
    );
    return resolveWindow(slotDurationSec(c, i), startFraction, endFraction);
  }

  function retryUntil(c: Controller<E>, action: () => void, done: () => boolean): void {
    let attempts = 0;
    const handle = deps.clock.setInterval(() => {
      if (c.disposed) { deps.clock.clearInterval(handle); return; }
      attempts++;
      try { action(); } catch { /* engine not ready */ }
      if (done() || attempts >= RETRY_ATTEMPTS) deps.clock.clearInterval(handle);
    }, RETRY_INTERVAL_MS);
    c.timers.push(handle);
    try { action(); } catch { /* engine not ready */ }
    if (done()) deps.clock.clearInterval(handle);
  }

  /** Point the engine at the ACTIVE slot's element and re-point audio with it.
   *  Called at creation and on every switch — `wireAudio` is idempotent and
   *  re-points `audio_l`/`audio_r` at the now-active splitter, which is what
   *  makes audio follow the switched video. */
  function attachActive(c: Controller<E>): void {
    retryUntil(
      c,
      () => { liveEngine?.attach(c.node.id, activeEl(c)); },
      () => {
        const ok = liveEngine?.hasElement(c.node.id) === true;
        if (ok !== c.status.attached) patch(c, { attached: ok });
        return ok;
      },
    );
    ensureAudioWired(c);
  }

  function ensureAudioWired(c: Controller<E>): void {
    retryUntil(
      c,
      () => { liveEngine?.extras(c.node.id)?.wireAudio(); },
      () => {
        const ok = liveEngine?.extras(c.node.id)?.isAudioWired() === true;
        if (ok !== c.status.audioWired) patch(c, { audioWired: ok });
        return ok;
      },
    );
  }

  /** Push the persisted crop to the engine, retried against the async
   *  materialise like every other engine-facing call here. */
  function pushCrop(c: Controller<E>): void {
    let pushed = false;
    retryUntil(
      c,
      () => {
        const extras = liveEngine?.extras(c.node.id);
        if (!extras) return;
        extras.setCrop(deps.doc.read(c.node.id)?.crop ?? null);
        pushed = true;
      },
      () => pushed,
    );
  }

  /** Hold every LOADED slot warm. Retried against the engine's async materialise
   *  for the same reason the attach is. */
  function ensureAllSlotsAlive(c: Controller<E>): void {
    retryUntil(
      c,
      () => {
        const extras = liveEngine?.extras(c.node.id);
        if (!extras) return;
        for (let i = 0; i < ASSET_SLOTS; i++) {
          if (!hasBytes(c, i)) continue;
          const el = c.els[i];
          if (el) extras.keepSlotAlive(el);
        }
      },
      () => {
        const extras = liveEngine?.extras(c.node.id);
        if (!extras) return false;
        // Done once there is something loaded and the extras handle exists; the
        // call is idempotent, so a later load re-runs through selectSlot/load.
        for (let i = 0; i < ASSET_SLOTS; i++) if (hasBytes(c, i)) return true;
        return false;
      },
    );
  }

  // ── THE LOADER ────────────────────────────────────────────────────────────
  //
  // Moved verbatim from `VideoVarispeedCard.loadFileIntoSlot`, with the two
  // card-only mirrors (`slotNames`, `slotDuration` `$state`) replaced by reads
  // through `nodeMedia` and the element — the stale-mirror class the card's own
  // rehydration effect existed to paper over.

  function setLoading(c: Controller<E>, slot: number, on: boolean): void {
    const next = [...c.status.loadingSlots];
    next[slot] = on;
    patch(c, { loadingSlots: next });
  }

  /** Load `file` into asset slot `slot`. Slot 0 also writes the legacy
   *  single-video `fileMeta` (the key the perf-zip loader, the asset picker and
   *  the rebind sweep all use); every slot writes its `slotMeta` row. */
  async function loadFileIntoSlot(
    c: Controller<E>,
    slot: number,
    file: File,
    opts?: { handle?: unknown; reuseHandleId?: string },
  ): Promise<void> {
    if (c.disposed) return;
    if (slot < 0 || slot >= ASSET_SLOTS) return;
    patch(c, { error: null });
    if (slot === c.status.activeSlot) patch(c, { pendingHandleName: null });
    if (!file.type.startsWith('video/')) {
      patch(c, { error: `Not a video file: ${file.type || file.name}` });
      return;
    }
    if (Number.isFinite(file.size) && file.size > VIDEOVARISPEED_MAX_SLOT_BYTES) {
      const mb = Math.round(VIDEOVARISPEED_MAX_SLOT_BYTES / (1024 * 1024));
      patch(c, { error: `File too large (max ${mb} MB per slot)` });
      return;
    }
    setLoading(c, slot, true);
    try {
      const key = varispeedSlotKey(slot);
      // Hand the new url to the NODE-owned registry: it revokes THIS slot's
      // previous url and keeps the new one alive across every surface change.
      deps.media.setObjectUrl(c.node.id, key, deps.createObjectUrl(file), file.name);
      const url = deps.media.objectUrl(c.node.id, key);
      const el = c.els[slot];
      if (!url || !el) return;
      deps.el.setSrc(el, url);
      // muted=false so the audio reaches MediaElementSource; slots 1..6 are
      // re-muted by the transport whenever they are off air.
      deps.el.setMuted(el, false);
      refreshNames(c);

      await deps.el.awaitMetadata(el);
      if (c.disposed) return;

      const duration = deps.el.duration(el);
      c.slotDuration[slot] = duration;
      // Keep this (and every other loaded) slot's decode alive even while it is
      // NOT the active source, so a later switch lands on an already-warm
      // element rather than one throttled to ~1 fps.
      ensureAllSlotsAlive(c);

      // Persist the handle (slot 0 only — slots 1..6 restore from the perf-zip
      // blob store, which seeds a handle under the slot's own id).
      let handleId: string | undefined = opts?.reuseHandleId;
      if (opts?.handle && hooks?.canPersist()) {
        try {
          if (!handleId) handleId = hooks.newId();
          await hooks.put(handleId, opts.handle);
        } catch { handleId = opts?.reuseHandleId; }
      }
      if (c.disposed) return;

      const meta: VideoboxFileMeta = {
        name: file.name,
        duration: Number.isFinite(duration) ? duration : 0,
        size: Number.isFinite(file.size) ? file.size : undefined,
        handleId,
      };
      if (slot === 0) deps.doc.writeFileMeta(c.node.id, meta);
      deps.doc.writeSlotMeta(c.node.id, slot, meta);

      // Force a first frame to decode so the output streams immediately even
      // before play — rVFC fires on the first decoded frame.
      try { deps.el.seek(el, 0); } catch { /* */ }
      c.slotPos[slot] = 0;

      refreshNames(c);
      publishDuration(c);
      if (slot === c.status.activeSlot) attachActive(c);
    } finally {
      if (!c.disposed) setLoading(c, slot, false);
    }
  }

  /** An explicit user CLEAR. The ONE place a surface may free a slot's bytes. */
  function clearSlot(c: Controller<E>, slot: number): void {
    if (slot < 0 || slot >= ASSET_SLOTS) return;
    const el = c.els[slot];
    if (el) {
      try { deps.el.pause(el); } catch { /* */ }
      try { deps.el.clearSrc(el); } catch { /* */ }
    }
    deps.media.setObjectUrl(c.node.id, varispeedSlotKey(slot), null);
    c.slotDuration[slot] = 0;
    c.slotPos[slot] = 0;
    deps.doc.writeSlotMeta(c.node.id, slot, null);
    refreshNames(c);
    // Cleared the ACTIVE slot → fall back to slot 0 when it still holds bytes.
    if (slot === c.status.activeSlot && slot !== 0 && hasBytes(c, 0)) selectSlot(c, 0);
    publishDuration(c);
  }

  /** Restore one slot from a remembered handle. The `granted` branch needs NO
   *  gesture, which is what makes "a saved rack comes back playing with no
   *  surface mounted" true; `prompt` is published for a surface to offer as a
   *  click, because `requestPermission()` is honoured only inside one. */
  async function tryReloadSlot(c: Controller<E>, slot: number): Promise<void> {
    if (!hooks || c.disposed) return;
    if (hasBytes(c, slot)) return;
    const metas = deps.doc.readMeta(c.node.id);
    const meta = slot === 0
      ? (metas?.fileMeta ?? metas?.slotMeta?.[0] ?? null)
      : (metas?.slotMeta?.[slot] ?? null);
    const handleId = meta?.handleId;
    if (!handleId) return;
    let handle: unknown | null = null;
    try { handle = await hooks.get(handleId); } catch { return; }
    if (!handle || c.disposed) return;
    let perm: 'granted' | 'prompt' | 'denied';
    try { perm = await hooks.queryPermission(handle); } catch { return; }
    if (c.disposed) return;
    if (perm === 'granted') {
      try {
        const file = await hooks.getFile(handle);
        await loadFileIntoSlot(c, slot, file, { handle, reuseHandleId: handleId });
      } catch { /* moved or deleted on disk — the re-link prompt covers it */ }
      return;
    }
    // Only slot 0's lapsed permission is offerable: the re-allow overlay names
    // ONE file, and slots 1..6 are re-picked from the bank instead.
    if (perm === 'prompt' && slot === 0) {
      patch(c, { pendingHandleName: meta?.name ?? handleId });
    }
    // 'denied' → the re-link prompt covers it.
  }

  /** Fire every slot's restore once its synced meta carries a handleId. Latched
   *  per slot so a late-arriving `slotMeta` (a peer's write, a perf-zip load
   *  that lands after the controller was built) still gets its one attempt. */
  function pumpReloads(c: Controller<E>): void {
    if (!hooks || c.disposed) return;
    // Every slot already latched or already holding bytes ⇒ nothing to read.
    // That is the steady state for the whole life of a loaded node, so the
    // expensive `readMeta` never runs on it.
    let pending = false;
    for (let i = 0; i < ASSET_SLOTS; i++) {
      if (!c.reloadAttempted[i] && !hasBytes(c, i)) { pending = true; break; }
    }
    if (!pending) return;
    const metas = deps.doc.readMeta(c.node.id);
    if (!metas) return;
    for (let i = 0; i < ASSET_SLOTS; i++) {
      if (c.reloadAttempted[i] || hasBytes(c, i)) continue;
      const meta = i === 0
        ? (metas.fileMeta ?? metas.slotMeta?.[0] ?? null)
        : (metas.slotMeta?.[i] ?? null);
      if (!meta?.handleId) continue;
      c.reloadAttempted[i] = true;
      void tryReloadSlot(c, i);
    }
  }

  /**
   * RE-FIT the stored crop on an OUTPUT-aspect flip (16:9 ↔ 4:3) and re-persist
   * it when it actually moved.
   *
   * ⚠ A PERSISTENCE-CORRECTNESS EFFECT, and it was a card `$effect` — so a rack
   * whose aspect flipped while the module had no surface kept a rect that is
   * invalid for the new aspect, and the next reader silently coerced it to
   * something the player never chose. `doc.read().crop` is ALREADY coerced for
   * the live aspect (the binding owns the one coercion), so the whole job here
   * is noticing the aspect moved and writing the coerced value back.
   */
  function refitCropForAspect(c: Controller<E>): void {
    const state = deps.doc.read(c.node.id);
    if (!state) return;
    const a = state.outAspect;
    if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) return;
    const fitted = state.crop as CropRect | null;
    if (!fitted) { c.lastRefitAspect = a; return; }
    if (a === c.lastRefitAspect) return;
    c.lastRefitAspect = a;
    const raw = state.rawCrop ?? null;
    if (!raw) return;
    if (
      Math.abs(fitted.x - raw.x) > 1e-6 ||
      Math.abs(fitted.y - raw.y) > 1e-6 ||
      Math.abs(fitted.w - raw.w) > 1e-6
    ) {
      deps.doc.writeCrop(c.node.id, true, fitted);
    }
  }

  /** Resolve EVERY populated slot's bytes for the portable .zip. The bytes live
   *  only in the per-slot object URL (never on `node.data` — only the per-slot
   *  meta syncs), so each loaded URL is fetched back. */
  async function resolveAllSlotBytes(nodeId: string): Promise<VarispeedExportedBytes[] | null> {
    const out: VarispeedExportedBytes[] = [];
    for (let i = 0; i < ASSET_SLOTS; i++) {
      const key = varispeedSlotKey(i);
      const url = deps.media.objectUrl(nodeId, key);
      if (!url) continue;
      try {
        const bytes = await deps.fetchBytes(url);
        if (bytes.length === 0) continue;
        out.push({ bytes, name: deps.media.mediaName(nodeId, key) ?? `slot-${i}.mp4`, slot: i });
      } catch { /* revoked / torn-down URL — skip this slot */ }
    }
    return out.length > 0 ? out : null;
  }

  /**
   * Switch the on-air slot. NODE state, so it survives every view change — the
   * defect this replaces reset it to 0 on each expand/collapse.
   */
  function selectSlot(c: Controller<E>, i: number): void {
    if (i < 0 || i >= ASSET_SLOTS || !hasBytes(c, i)) return;
    if (i === c.status.activeSlot) {
      // A RE-TRIGGER of the live slot restarts it from its window start — a
      // fresh strike of the same clip — and syncs the virtual playhead.
      const w = windowFor(c, i);
      const pos = w.hasWindow ? w.startSec : 0;
      c.slotPos[i] = pos;
      const el = c.els[i];
      if (el) { try { deps.el.seek(el, pos); } catch { /* */ } }
      return;
    }
    const prev = activeEl(c);
    // Snapshot the OUTGOING element's REAL time so a switch back resumes on the
    // right frame: the on-air slot's virtual playhead IS its element's time.
    if (prev) {
      const t = deps.el.currentTime(prev);
      if (Number.isFinite(t)) c.slotPos[c.status.activeSlot] = t;
      if (!deps.el.paused(prev)) { try { deps.el.pause(prev); } catch { /* */ } }
    }
    patch(c, { activeSlot: i, slotPos: [...c.slotPos] });
    const next = c.els[i];
    if (next) {
      const w = windowFor(c, i);
      let pos = c.slotPos[i] ?? 0;
      if (w.hasWindow) pos = Math.min(Math.max(pos, w.startSec), w.endSec);
      c.slotPos[i] = pos;
      try { deps.el.seek(next, pos); } catch { /* */ }
      const state = deps.doc.read(c.node.id);
      if ((state?.isPlaying ?? false) && effectiveSpeed(c) >= 0) {
        try { deps.el.play(next); } catch { /* autoplay */ }
      }
    }
    attachActive(c);
  }

  /** Advance the OFF-AIR slots' virtual playheads so a switch lands on a live,
   *  de-synced position. Pure bookkeeping — no element writes. */
  function advanceVirtual(c: Controller<E>, dtMs: number, speed: number, loop: boolean): void {
    const state = deps.doc.read(c.node.id);
    if (!(state?.isPlaying ?? false) || c.oneShotEnded || dtMs <= 0) return;
    const dtSec = dtMs / 1000;
    for (let i = 0; i < ASSET_SLOTS; i++) {
      if (i === c.status.activeSlot || !hasBytes(c, i)) continue;
      const w = windowFor(c, i);
      if (!w.hasWindow) continue;
      const forward = speed >= 0;
      let pos = (c.slotPos[i] ?? 0) + speed * dtSec;
      const action = decideEdgeAction(pos, w, forward, loop);
      if (action.kind === 'loop') pos = action.seekTo;
      else if (action.kind === 'stop') pos = action.clampTo;
      else pos = Math.min(Math.max(pos, w.startSec), w.endSec);
      c.slotPos[i] = pos;
    }
  }

  function transportTick(c: Controller<E>, nowMs: number): void {
    if (c.disposed) return;
    const el = activeEl(c);
    const dt = c.lastFrameMs === 0 ? 0 : Math.max(0, nowMs - c.lastFrameMs);
    c.lastFrameMs = nowMs;
    if (!el || !hasBytes(c, c.status.activeSlot)) return;

    const state = deps.doc.read(c.node.id);
    const isPlaying = state?.isPlaying ?? false;
    const loop = state?.loop ?? VARISPEED_DEFAULT_LOOP;
    const speed = effectiveSpeed(c);
    const w = windowFor(c, c.status.activeSlot);

    const t = deps.el.currentTime(el);
    if (Number.isFinite(t)) c.slotPos[c.status.activeSlot] = t;
    advanceVirtual(c, dt, speed, loop);
    if (t !== c.status.positionSec) patch(c, { positionSec: t, slotPos: [...c.slotPos] });

    if (!w.hasWindow) {
      if (!deps.el.paused(el)) { try { deps.el.pause(el); } catch { /* */ } }
      return;
    }

    const forward = speed >= 0;
    if (!forward && !c.reverseActive) {
      c.reverseActive = true;
      c.reverseAccumMs = 0;
      deps.el.setMuted(el, true);
      try { deps.el.pause(el); } catch { /* */ }
    } else if (forward && c.reverseActive) {
      c.reverseActive = false;
      deps.el.setMuted(el, c.status.activeSlot > 0);
    }

    if (!isPlaying || c.oneShotEnded) return;

    if (forward) {
      const rate = Math.max(0.0625, Math.min(16, speed));
      if (Math.abs(deps.el.playbackRate(el) - rate) > 0.001) {
        try { deps.el.setPlaybackRate(el, rate); } catch { /* */ }
      }
      if (deps.el.paused(el)) { try { deps.el.play(el); } catch { /* autoplay */ } }
    } else {
      c.reverseAccumMs += dt;
      const step = reverseScrubStep(
        deps.el.currentTime(el),
        Math.abs(speed),
        c.reverseAccumMs,
        w.startSec,
      );
      if (step.seek) {
        c.reverseAccumMs = 0;
        try { deps.el.seek(el, step.toSec); } catch { /* */ }
      }
    }

    const action = decideEdgeAction(deps.el.currentTime(el), w, forward, loop);
    if (action.kind === 'loop') {
      try { deps.el.seek(el, action.seekTo); } catch { /* */ }
      c.slotPos[c.status.activeSlot] = action.seekTo;
      if (forward && deps.el.paused(el)) { try { deps.el.play(el); } catch { /* */ } }
    } else if (action.kind === 'stop') {
      try { deps.el.seek(el, action.clampTo); } catch { /* */ }
      try { deps.el.pause(el); } catch { /* */ }
      c.slotPos[c.status.activeSlot] = action.clampTo;
      // Render-local latch ONLY — never a writePlaying(false) from inside the
      // transport loop, which would race every peer's copy of the same clip.
      c.oneShotEnded = true;
    }
  }

  function gateStart(c: Controller<E>): void {
    c.oneShotEnded = false;
    const w = windowFor(c, c.status.activeSlot);
    const el = activeEl(c);
    const pos = w.hasWindow ? w.startSec : (el ? deps.el.currentTime(el) : 0);
    if (el && hasBytes(c, c.status.activeSlot)) { try { deps.el.seek(el, pos); } catch { /* */ } }
    if (w.hasWindow) c.slotPos[c.status.activeSlot] = pos;
    deps.doc.writePlaying(c.node.id, w.hasWindow);
  }

  function gatePause(c: Controller<E>): void {
    c.oneShotEnded = false;
    const state = deps.doc.read(c.node.id);
    deps.doc.writePlaying(c.node.id, !(state?.isPlaying ?? false));
  }

  function gateReset(c: Controller<E>): void {
    const w = windowFor(c, c.status.activeSlot);
    const pos = w.hasWindow ? w.startSec : 0;
    const el = activeEl(c);
    if (el && hasBytes(c, c.status.activeSlot)) { try { deps.el.seek(el, pos); } catch { /* */ } }
    c.slotPos[c.status.activeSlot] = pos;
  }

  /** The CV poll — five triggers, all of which were dead whenever no card was
   *  mounted (a collapsed group, a canvas-hidden node). */
  function startCvLoop(c: Controller<E>): void {
    const handle = deps.clock.setInterval(() => {
      if (c.disposed || !liveEngine) return;
      if (risingEdge(c, 'cv_start')) gateStart(c);
      if (risingEdge(c, 'cv_pause')) gatePause(c);
      if (risingEdge(c, 'cv_reset')) gateReset(c);
      if (risingEdge(c, 'cv_loop_toggle')) {
        const state = deps.doc.read(c.node.id);
        deps.doc.writeLoop(c.node.id, !(state?.loop ?? VARISPEED_DEFAULT_LOOP));
      }
      // ASSET SELECT: on a rising gate, map the raw asset_pitch V/oct to a slot
      // and switch IF that slot holds local bytes. A black-key pitch maps to
      // null and an unlinked slot is ignored — both are no-ops, not errors.
      if (risingEdge(c, 'asset_gate')) {
        const slot = slotForVOct(readCv(c, 'asset_pitch'));
        if (slot != null && hasBytes(c, slot)) selectSlot(c, slot);
      }
    }, CV_INTERVAL_MS);
    c.timers.push(handle);
  }

  /**
   * The three HOUSEKEEPING jobs that used to be card `$effect`s: the
   * saved-handle restore, the crop aspect re-fit and the published duration.
   *
   * ⚠ THEIR OWN, SLOWER LOOP — NOT THE 33 Hz CV POLL, AND NOT THE rAF FRAME.
   * None of them is a per-frame fact: a handle restore fires a handful of times
   * per node, an aspect flip is a user action, and a duration arrives once per
   * load. Running them at gate cadence would cost a ten-varispeed rack 900 doc
   * reads a second to learn nothing — main-thread pressure paid against the
   * concurrent video decodes that are the whole point of this module.
   *
   * They also run BEFORE any `liveEngine` guard on purpose: none of them
   * touches the engine, and a saved rack must restore its clips even where the
   * video engine never materialises.
   */
  function startHousekeepingLoop(c: Controller<E>): void {
    const handle = deps.clock.setInterval(() => {
      if (c.disposed) return;
      pumpReloads(c);
      refitCropForAspect(c);
      publishDuration(c);
    }, HOUSEKEEPING_INTERVAL_MS);
    c.timers.push(handle);
  }

  function refreshNames(c: Controller<E>): void {
    const names: (string | null)[] = [];
    for (let i = 0; i < ASSET_SLOTS; i++) names.push(deps.media.mediaName(c.node.id, varispeedSlotKey(i)));
    const changed = names.some((n, i) => n !== c.status.slotNames[i]);
    if (changed) patch(c, { slotNames: names });
    // A slot that just acquired bytes clears the re-link/re-allow offer for it.
    if (changed && c.status.pendingHandleName !== null && hasBytes(c, 0)) {
      patch(c, { pendingHandleName: null });
    }
  }

  /** Publish the ACTIVE slot's duration — the scrubber's `max`. */
  function publishDuration(c: Controller<E>): void {
    const d = slotDurationSec(c, c.status.activeSlot);
    if (d !== c.status.durationSec) patch(c, { durationSec: d });
  }

  function createController(node: ModuleNode): Controller<E> {
    // `ensure` every slot: the elements exist PARKED from node creation, which
    // is what makes the player exist with no card mounted anywhere.
    const els: E[] = [];
    for (let i = 0; i < ASSET_SLOTS; i++) els.push(deps.media.ensure(node.id, varispeedSlotKey(i)));
    const c: Controller<E> = {
      node,
      els,
      status: {
        ...NO_VARISPEED,
        slotNames: new Array(ASSET_SLOTS).fill(null),
        slotPos: new Array(ASSET_SLOTS).fill(0),
      },
      timers: [],
      frameHandle: null,
      slotPos: new Array(ASSET_SLOTS).fill(0),
      slotDuration: new Array(ASSET_SLOTS).fill(0),
      oneShotEnded: false,
      reverseActive: false,
      reverseAccumMs: 0,
      lastFrameMs: 0,
      lastGate: {},
      reloadAttempted: new Array(ASSET_SLOTS).fill(false),
      lastRefitAspect: 0,
      disposed: false,
      dispose(): void {
        if (c.disposed) return;
        c.disposed = true;
        for (const t of c.timers) { try { deps.clock.clearInterval(t); } catch { /* */ } }
        c.timers = [];
        if (c.frameHandle !== null) { try { deps.frames.stop(c.frameHandle); } catch { /* */ } }
        c.frameHandle = null;
        try { deps.unregisterExport(node.id); } catch { /* */ }
        // ⚠ DELIBERATELY ABSENT: no `attach(id, null)`, no url revoke, no track
        // stop. The elements and their bytes belong to `nodeMedia` and are freed
        // by ITS graph-keyed sweep in the same Canvas effect. Detaching here
        // would re-create #1511 one level down.
      },
    };
    // The multi-slot bytes resolver, registered on NODE lifetime. It reads the
    // live per-slot urls each export, so it always reflects the current state.
    deps.registerExport(node.id, () => resolveAllSlotBytes(node.id));
    refreshNames(c);
    publishDuration(c);
    attachActive(c);
    ensureAllSlotsAlive(c);
    pushCrop(c);
    // A node restored from a saved rack (or one the asset picker just wrote
    // `fileMeta` onto) already carries the handle ids; a freshly spawned one
    // does not. Both go through the same call — it no-ops without one.
    pumpReloads(c);
    startCvLoop(c);
    startHousekeepingLoop(c);
    c.frameHandle = deps.frames.start((nowMs) => transportTick(c, nowMs));
    return c;
  }

  return {
    sync(nodes, engine) {
      liveEngine = engine;
      const live = new Set<string>();
      for (const n of nodes) {
        if (!NODE_VARISPEED_TYPES.has(n.type)) continue;
        live.add(n.id);
        const existing = controllers.get(n.id);
        if (existing) {
          existing.node = n;
          // Pick up bytes that arrived since the last tick (a load, a slot
          // clear) without waiting for a transport frame.
          refreshNames(existing);
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
      if (!c) return NO_VARISPEED;
      refreshNames(c);
      return c.status;
    },

    request(nodeId, cmd) {
      const c = controllers.get(nodeId);
      if (!c) return { delivered: false, error: null };
      try {
        switch (cmd.kind) {
          case 'selectSlot': selectSlot(c, cmd.slot); break;
          case 'togglePlay': gatePause(c); break;
          case 'seek': {
            if (!Number.isFinite(cmd.toSec)) break;
            const el = activeEl(c);
            if (el) { try { deps.el.seek(el, cmd.toSec); } catch { /* */ } }
            c.slotPos[c.status.activeSlot] = cmd.toSec;
            patch(c, { positionSec: cmd.toSec });
            break;
          }
          case 'setLoop':
            deps.doc.writeLoop(nodeId, cmd.loop);
            // Re-enabling LOOP re-arms a one-shot that ran out: a looping clip
            // can never "end", so the latch would otherwise strand it stopped.
            if (cmd.loop) c.oneShotEnded = false;
            break;
          case 'slotLoaded':
            refreshNames(c);
            ensureAllSlotsAlive(c);
            if (cmd.slot === c.status.activeSlot) attachActive(c);
            break;
          case 'cropChanged': pushCrop(c); break;
          case 'loadFile':
            void loadFileIntoSlot(c, cmd.slot, cmd.file, {
              handle: cmd.handle,
              reuseHandleId: cmd.reuseHandleId,
            });
            break;
          case 'clearSlot': clearSlot(c, cmd.slot); break;
          case 'clearError': patch(c, { error: null }); break;
          case 'gateStart': gateStart(c); break;
          case 'gatePause': gatePause(c); break;
          case 'gateReset': gateReset(c); break;
        }
      } catch (error) {
        return { delivered: true, error };
      }
      return { delivered: true, error: null };
    },

    has(nodeId) { return controllers.has(nodeId); },

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
      const out: Array<{ nodeId: string } & VarispeedStatus> = [];
      for (const [nodeId, c] of controllers) out.push({ nodeId, ...c.status });
      return out;
    },
  };
}
