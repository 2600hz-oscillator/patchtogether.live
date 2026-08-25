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
//   * the per-slot saved-handle restore and the multi-slot export resolver;
//   * `activeSlot`, `slotPos[]` and the one-shot latch.
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
import type { VideoSourceClock, VideoSourceRequestResult } from './node-video-source-registry';

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
  /** The persisted crop rect, or null for full-frame passthrough. */
  crop: unknown | null;
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
}

/** The node-media seam — the same registry P1 uses, narrowed. */
export interface VarispeedMedia<E> {
  ensure(nodeId: string, slot: string): E;
  mediaName(nodeId: string, slot: string): string | null;
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
  onStatus?(nodeId: string, status: VarispeedStatus): void;
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
}

export const NO_VARISPEED: VarispeedStatus = {
  activeSlot: 0,
  slotNames: new Array(ASSET_SLOTS).fill(null),
  positionSec: 0,
  slotPos: new Array(ASSET_SLOTS).fill(0),
  attached: false,
  audioWired: false,
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
  | { kind: 'cropChanged' };

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
  disposed: boolean;
  dispose(): void;
}

export function createNodeVarispeedRegistry<E>(
  deps: VarispeedDeps<E>,
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

  function refreshNames(c: Controller<E>): void {
    const names: (string | null)[] = [];
    for (let i = 0; i < ASSET_SLOTS; i++) names.push(deps.media.mediaName(c.node.id, varispeedSlotKey(i)));
    const changed = names.some((n, i) => n !== c.status.slotNames[i]);
    if (changed) patch(c, { slotNames: names });
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
      disposed: false,
      dispose(): void {
        if (c.disposed) return;
        c.disposed = true;
        for (const t of c.timers) { try { deps.clock.clearInterval(t); } catch { /* */ } }
        c.timers = [];
        if (c.frameHandle !== null) { try { deps.frames.stop(c.frameHandle); } catch { /* */ } }
        c.frameHandle = null;
        // ⚠ DELIBERATELY ABSENT: no `attach(id, null)`, no url revoke, no track
        // stop. The elements and their bytes belong to `nodeMedia` and are freed
        // by ITS graph-keyed sweep in the same Canvas effect. Detaching here
        // would re-create #1511 one level down.
      },
    };
    refreshNames(c);
    attachActive(c);
    ensureAllSlotsAlive(c);
    pushCrop(c);
    startCvLoop(c);
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
