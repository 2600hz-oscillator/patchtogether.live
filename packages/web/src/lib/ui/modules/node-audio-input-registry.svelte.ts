// node-audio-input-registry.svelte.ts
//
// NODE-OWNED LIVE-INPUT LIFETIME — the registry that keeps a rack's AUDIO IN
// streaming when the CARD that acquired it goes away.
//
// THE BUG THIS EXISTS FOR (#1590, from the #1583 audit). `AudioinCard` ran:
//
//     onDestroy(() => { stopStream(); … });
//
//     function stopStream() {
//       if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
//       …
//       if (e) audioInAttach(e, id, null);
//     }
//
// Collapse the module — or let its dock pane be LRU-evicted when a third
// module is expanded, or press ESC, or M/E, or navigate — and the rack's live
// audio input went SILENT mid-performance, with the OS mic indicator dropping.
//
// ⚠ THIS ROW IS THE IRREVERSIBLE ONE, which is why it is not simply "another
// #1574". Every other member of the family destroyed something that could be
// rebuilt from state the app still had: a rAF can be restarted, a GL context
// re-created, a tap re-enabled. **`MediaStreamTrack.stop()` cannot be undone.**
// A stopped track is permanently `readyState: 'ended'`; the only way back is a
// FRESH `getUserMedia()`, which is a new permission decision, re-runs device
// selection, re-negotiates the channel layout, and on a device another app has
// since grabbed simply FAILS (`NotReadableError`). So where #1574 lost a take
// you could re-record, this lost the input itself — and re-expanding the card
// could not get it back on its own.
//
// THREE card-owned things died with that unmount:
//   1. THE TRACKS      — `t.stop()`, above. Irreversible; the whole reason
//                        this registry owns the stream instead of the card.
//   2. THE ATTACHMENT  — `audioInAttach(e, id, null)` unwires the engine-side
//                        module runtime, so even a surviving stream feeds
//                        nothing.
//   3. THE LATE-ENGINE RECONCILER — the `setInterval` that lands the attach
//                        when the card mounted before the engine booted. AUDIO
//                        IN is hosted as an always-on pinned topbar module, so
//                        that path is the NORMAL one there, not an edge case.
//
// There is deliberately NO render-lease leg (#1531/#1574's fourth mechanism):
// this is an AUDIO module, and Web Audio evaluates the whole connected graph
// regardless of what is on screen. Its absence is a fact about the domain, not
// an omission.
//
// ── THE SHAPE OF THE FIX ────────────────────────────────────────────────────
// The card ADOPTS and READS; it never CREATES or DESTROYS. Teardown is keyed to
// GRAPH lifetime via `sweep(liveNodeIds)`, called from Canvas beside its
// siblings (nodeMedia / nodePresent / nodeRecorder / nodeSamsloop).
//
// ⚠ THE STRUCTURAL GUARD IS THE ABSENCE OF A CARD-LIFECYCLE METHOD. There is no
// `dispose(id)`, no `teardown(id)`, no `onCardUnmount(id)` — so a future
// `onDestroy` CANNOT re-introduce this defect by calling one, because `tsc`
// refuses the call before a test ever runs. `stop(id)` exists and does stop the
// tracks, but it is a USER ACTION (the card's explicit stop/release control) and
// is named for the user's intent, not the component's lifecycle. The unit test
// asserts that distinction from both directions.

import type { EngineContext } from '$lib/audio/engine-context';
import { audioInAttach } from '$lib/audio/modules/audioin';

/** The card's UI state machine, mirrored here because the registry — not the
 *  card — now owns the transitions that outlive a mount. */
export type AudioInputState =
  | 'idle'
  | 'requesting'
  | 'streaming'
  | 'permission-denied'
  | 'no-inputs-found'
  | 'device-in-use'
  | 'unsupported'
  | 'error';

/** A read-only projection for the card. Deliberately carries no MediaStream:
 *  the card renders status, it does not own the resource. */
export interface AudioInputView {
  state: AudioInputState;
  errorMsg: string | null;
  /** Delivered channel layout (0 until a stream attaches). */
  liveChannels: number;
  /** The device the live stream actually resolved to (`settings.deviceId`). */
  deviceId: string | null;
  streaming: boolean;
}

/** The engine accessor the card hands over at adopt time — the app's own
 *  `EngineContext`, not a private shape, so it cannot drift from the real one.
 *
 *  ⚠ It is the CONTEXT OBJECT, not a live engine. `useEngine()` is a
 *  `getContext` call and so is component-init-only, but the object it returns
 *  is a plain `{ get() }` getter over the engine Canvas owns — it stays valid
 *  after the card that read it has unmounted, and it re-resolves through an
 *  AudioContext reset. Both are exactly what this registry needs. */
export type EngineAccessor = EngineContext;

interface Entry {
  stream: MediaStream | null;
  channelCount: number;
  state: AudioInputState;
  errorMsg: string | null;
  deviceId: string | null;
  engine: EngineAccessor | null;
  /** Set while an attach is owed to an engine that was not up yet. */
  reconcileTimer: ReturnType<typeof setInterval> | null;
  /** Has the ONE unattended acquire this node gets already been claimed? See
   *  `beginAutoAcquire`. Lives on the ENTRY so it is swept with the node — a
   *  module-scope `Set<nodeId>` would be a second lifetime to keep in step. */
  autoAcquired: boolean;
}

const IDLE: AudioInputView = {
  state: 'idle',
  errorMsg: null,
  liveChannels: 0,
  deviceId: null,
  streaming: false,
};

/** How often the late-engine reconciler retries, and how long the fast path
 *  polls before handing off to it. Both lifted verbatim from the card so the
 *  move changes lifetime and nothing else. */
const RECONCILE_MS = 500;
const FAST_ATTACH_WINDOW_MS = 1500;
const FAST_ATTACH_STEP_MS = 50;

class NodeAudioInputRegistry {
  #entries = $state<Record<string, Entry>>({});

  /** Register the node and its engine accessor. Idempotent and NON-DESTRUCTIVE:
   *  a re-mounted card adopts the entry a previous mount left streaming, which
   *  is the whole point — re-expanding the module must show the live input, not
   *  a fresh idle one. */
  adopt(id: string, engine: EngineAccessor): void {
    const existing = this.#entries[id];
    if (existing) {
      existing.engine = engine;
      return;
    }
    this.#entries[id] = {
      stream: null,
      channelCount: 0,
      state: 'idle',
      errorMsg: null,
      deviceId: null,
      engine,
      reconcileTimer: null,
      autoAcquired: false,
    };
  }

  /**
   * Claim the ONE unattended acquire this node gets. Returns true AT MOST ONCE
   * per node, and only from `idle`.
   *
   * ⚠ THIS IS THE PROMOTION'S IRREVERSIBLE HAZARD, AND IT IS WHY THE GUARD IS
   * HERE RATHER THAN IN A COMPONENT. Before the face, exactly one surface ever
   * ran the returning-visitor auto-acquire, in its own `onMount`. A faced AUDIO
   * IN has TWO — the lane tile's `tileBody` and the dock full view's
   * `fullViewBody` — and a player who expands a module is looking at both at
   * once. `request()`
   * calls `#releaseTracks` FIRST, and `MediaStreamTrack.stop()` cannot be
   * undone, so two surfaces each auto-acquiring would tear each other's capture
   * down mid-performance: the #1590 failure through a new door, with the mount
   * that lost the race left holding a permanently `ended` track.
   *
   * The `state !== 'idle'` half is what makes a SECOND surface a no-op (the
   * first has already moved the entry to `requesting`/`streaming`). The
   * `autoAcquired` half is what stops a re-mount re-opening an input the player
   * deliberately STOPPED — `stop()` returns the entry to `idle`, so the state
   * guard alone would re-acquire on the next expand and the stop control would
   * be un-obeyable.
   *
   * The caller supplies the constraints and the permission probe; this only
   * decides WHO goes, which is the part that must be atomic.
   */
  beginAutoAcquire(id: string): boolean {
    const e = this.#entries[id];
    if (!e) return false; // adopt first — an unknown id has no lifetime to claim
    if (e.autoAcquired) return false;
    if (e.state !== 'idle') return false;
    e.autoAcquired = true;
    return true;
  }

  /** Reactive read for the card. Unknown ids read `idle` rather than throwing —
   *  a card can render one frame before its `adopt` effect runs. */
  view(id: string): AudioInputView {
    const e = this.#entries[id];
    if (!e) return IDLE;
    return {
      state: e.state,
      errorMsg: e.errorMsg,
      liveChannels: e.stream ? e.channelCount : 0,
      deviceId: e.deviceId,
      streaming: e.state === 'streaming' && !!e.stream,
    };
  }

  /** Card-side status transitions the STREAM does not own — e.g.
   *  `refreshDevices()` finding no audio inputs at all. Kept here so the state
   *  machine has ONE home: a card-local copy would go stale the moment a card
   *  re-mounted onto a live entry. */
  setStatus(id: string, state: AudioInputState, errorMsg: string | null): void {
    const e = this.#entries[id];
    if (!e) return;
    e.state = state;
    e.errorMsg = errorMsg;
  }

  /** Is this node currently holding live input? Used by the e2e probe and by
   *  the card to decide whether a device change needs a re-acquire. */
  isStreaming(id: string): boolean {
    const e = this.#entries[id];
    return !!e && e.state === 'streaming' && !!e.stream;
  }

  /**
   * E2E probe — the NODE's own record, never a card's.
   *
   * ⚠ `trackLive` reads the real `MediaStreamTrack.readyState`, not this
   * registry's opinion of it. The defect was an IRREVERSIBLE `t.stop()`, so a
   * probe that echoed only registry state could report a happy `streaming`
   * while the device was already permanently `ended` — the instrument would be
   * blind to the exact thing it exists to catch.
   */
  probe(id: string): AudioInputView & { trackLive: boolean; tracks: number } {
    const e = this.#entries[id];
    const tracks = e?.stream?.getTracks() ?? [];
    return {
      ...this.view(id),
      tracks: tracks.length,
      trackLive: tracks.some((t) => t.readyState === 'live'),
    };
  }

  /**
   * Acquire (or re-acquire) the input for this node.
   *
   * The CONSTRAINTS are the card's business — device enumeration, the saved
   * device id, music mode — so they are passed in fully formed. The STREAM is
   * this registry's business, which is the whole division of labour.
   */
  async request(
    id: string,
    constraints: MediaStreamConstraints,
    opts?: { onResolved?: (deviceId: string | null, channelCount: number) => void },
  ): Promise<AudioInputView> {
    const e = this.#entries[id];
    if (!e) return IDLE;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      e.state = 'unsupported';
      e.errorMsg = 'Browser does not support getUserMedia';
      return this.view(id);
    }

    e.state = 'requesting';
    e.errorMsg = null;
    // Re-acquiring replaces the live stream — that IS a user-initiated stop.
    this.#releaseTracks(id, e);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const ex = err as DOMException;
      if (ex.name === 'NotAllowedError' || ex.name === 'PermissionDeniedError') {
        e.state = 'permission-denied';
        e.errorMsg = 'Microphone permission denied — click to retry';
      } else if (ex.name === 'NotFoundError' || ex.name === 'OverconstrainedError') {
        e.state = 'no-inputs-found';
        e.errorMsg = 'No microphone matches the selected constraints.';
      } else if (ex.name === 'NotReadableError') {
        e.state = 'device-in-use';
        e.errorMsg = 'Microphone is in use by another tab or application.';
      } else {
        e.state = 'error';
        e.errorMsg = `${ex.name}: ${ex.message}`;
      }
      return this.view(id);
    }

    const track = stream.getAudioTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      e.state = 'error';
      e.errorMsg = 'getUserMedia returned a stream with no audio tracks.';
      return this.view(id);
    }

    const settings = track.getSettings();
    // Trust the DELIVERED layout, not the requested one — an unreported
    // channelCount means mono (the safe fan-out path). See AudioinCard's
    // constraint note; that reasoning is unchanged and stays with the card.
    e.channelCount = settings.channelCount ?? 1;
    e.deviceId = settings.deviceId ?? e.deviceId;
    e.stream = stream;

    // End-of-stream (permission revoke / hardware unplug) is a REAL end, not a
    // lifecycle event: the tracks are already dead, so releasing here destroys
    // nothing that was still usable.
    track.addEventListener('ended', () => {
      const cur = this.#entries[id];
      if (!cur || cur.stream !== stream) return;
      if (cur.state !== 'streaming') return;
      cur.state = 'error';
      cur.errorMsg = 'Input stream ended (disconnected or revoked).';
      this.#releaseTracks(id, cur);
    });

    e.state = 'streaming';
    opts?.onResolved?.(e.deviceId, e.channelCount);
    await this.#attach(id, e);
    return this.view(id);
  }

  /**
   * USER-INITIATED release — the card's explicit stop control, and the
   * re-acquire path above.
   *
   * ⚠ NOT a lifecycle hook, and deliberately not named like one. A card
   * unmount must never reach this: that is the defect. See the header note on
   * why the absence of `dispose(id)` is the structural guard.
   */
  stop(id: string): void {
    const e = this.#entries[id];
    if (!e) return;
    this.#releaseTracks(id, e);
    e.state = 'idle';
    e.errorMsg = null;
  }

  /**
   * GRAPH-LIFETIME teardown — the only place tracks are stopped without the
   * user asking. Called from Canvas with the live node ids on every graph
   * change, exactly like its sibling registries.
   */
  sweep(liveNodeIds: Iterable<string>): void {
    const live = liveNodeIds instanceof Set ? liveNodeIds : new Set(liveNodeIds);
    for (const id of Object.keys(this.#entries)) {
      if (live.has(id)) continue;
      const e = this.#entries[id];
      this.#releaseTracks(id, e);
      delete this.#entries[id];
    }
  }

  /** Stop the tracks + drop the engine attachment + clear the reconciler.
   *  Private on purpose: every caller above is either a user action or the
   *  graph sweep, and there is no third kind. */
  #releaseTracks(id: string, e: Entry): void {
    if (e.reconcileTimer !== null) {
      clearInterval(e.reconcileTimer);
      e.reconcileTimer = null;
    }
    if (e.stream) {
      for (const t of e.stream.getTracks()) t.stop();
      e.stream = null;
    }
    e.channelCount = 0;
    const eng = e.engine?.get();
    if (eng) audioInAttach(eng, id, null);
  }

  /** Hand the stream to the engine-side module runtime, with the same bounded
   *  fast poll the card used, falling back to the slow reconciler. */
  async #attach(id: string, e: Entry): Promise<void> {
    const payload = () =>
      e.stream ? { stream: e.stream, channelCount: e.channelCount } : null;

    const tryOnce = (): boolean => {
      const eng = e.engine?.get();
      const p = payload();
      return !!eng && !!p && audioInAttach(eng, id, p);
    };

    if (tryOnce()) return;

    const start = Date.now();
    while (Date.now() - start < FAST_ATTACH_WINDOW_MS) {
      await new Promise((r) => setTimeout(r, FAST_ATTACH_STEP_MS));
      if (!e.stream) return; // released mid-poll
      if (tryOnce()) return;
    }

    // LATE-ENGINE RECONCILER. The pinned topbar AUDIO IN can stream before the
    // engine boots at all, so this is a normal path there. It lives on the
    // ENTRY (node lifetime), which is the fix: as a card-local `$effect` it
    // died with the mount and the attach was simply never made.
    if (e.reconcileTimer !== null) return;
    e.reconcileTimer = setInterval(() => {
      if (!e.stream || e.state !== 'streaming') {
        if (e.reconcileTimer !== null) clearInterval(e.reconcileTimer);
        e.reconcileTimer = null;
        return;
      }
      if (tryOnce()) {
        if (e.reconcileTimer !== null) clearInterval(e.reconcileTimer);
        e.reconcileTimer = null;
      }
    }, RECONCILE_MS);
  }
}

/** The singleton. Module scope = graph scope, which is the lifetime a live
 *  input actually has. */
export const nodeAudioInput = new NodeAudioInputRegistry();
