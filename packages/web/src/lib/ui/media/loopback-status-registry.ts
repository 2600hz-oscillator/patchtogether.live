// packages/web/src/lib/ui/media/loopback-status-registry.ts
//
// THE LOOPBACK CAPTURE-STATUS SEAM — how the faceplate can show, and drive, a
// tab capture whose `getDisplayMedia` stream has exactly ONE owner.
//
// ── Why this exists (measured, on the promotion that created it) ─────────────
//
// Promoting `loopback` makes the shell render a faceplate in the lane, so the
// real `LoopbackCard.svelte` moves into `<HeadlessSourceHost>` — parked at
// `left:-9999px` with `pointer-events: none` and `aria-hidden="true"`.
//
// The STREAM survives that move: the `<video>` and its MediaStream are
// NODE-owned via ./node-media-registry (#1583), and the card's `onDestroy`
// releases its lease WITHOUT stopping the tracks, precisely because a
// getDisplayMedia capture cannot be restarted without a fresh user gesture.
// That half of the media-controller problem is already solved and this file
// does not touch it.
//
// What does NOT survive the move is every INTERACTIVE affordance, because an
// off-screen `pointer-events: none` subtree cannot be clicked:
//
//   * "Start capture" / "Re-capture" — the ONLY user gesture that reaches
//     `getDisplayMedia`. ⚠ AND LOOPBACK HAS NO AUTO-ACQUIRE PATH AT ALL, which
//     makes this strictly worse than CAMERA's case: a camera this origin has
//     already been granted re-acquires itself on mount, so CAMERA's button is
//     the first-visit route. A display capture is granted PER GESTURE, every
//     time, forever — there is no "already granted" state for it to inherit.
//     Without this seam a promoted LOOPBACK could never start at all.
//   * "Stop capture" — the counterpart gesture. It is not expressible as a
//     param either (see the COMMANDS note below), so losing it would be a
//     functional regression, not a cosmetic one.
//   * the ERROR text — the recovery instructions for an unsupported browser or
//     a failed picker. A lamp with no words cannot carry them.
//   * the real capture STATE. A lamp derived from the GRAPH alone cannot exist
//     here at all: NOTHING about a tab capture is in the graph. `gain` and
//     `crop` are the only params, and neither moves when a capture starts,
//     stops, is refused, or is ended from the browser's share bar.
//
// ── Why a registry and not a second capture machine ─────────────────────────
//
// `getDisplayMedia`, the MediaStream and the state machine have ONE owner —
// `LoopbackCard.svelte` — and that must not change: two callers would be two
// owners, each able to strand the other's stream, and a re-share prompt is a
// modal the user has to answer. So this file moves no ownership. The card
// PUBLISHES what it knows and REGISTERS its commands; the faceplate READS the
// status and INVOKES a command. It is a remote control, not a second machine.
//
// ⚠ WHY `stop` IS A COMMAND AND NOT A PARAM, since CAMERA's equivalent IS one.
// CAMERA has an `enabled` ParamDef, so its face gets pause/resume as an
// ordinary toggle cell and needs no command for it. LOOPBACK has no such param
// and CANNOT GROW ONE HERE: `loopback.ts` is in the WebGL attest basis, so
// adding a param moves the attest hash and costs a real-GPU re-attest window
// (this promotion is deliberately hash-neutral — see the PR body). It would
// also be the wrong shape: a synced param would mean one collaborator's toggle
// starting a capture that only ever existed in someone else's browser.
//
// ⚠ WHY THE STATUS IS BROWSER-LOCAL AND NEVER TOUCHES Yjs. A screen-capture
// grant is a property of ONE person's browser and ONE gesture in it — the card
// says so in its own header ("a screen-capture grant is browser-instance-
// local"). Publishing `capturing` into the shared document would assert
// something false about every other participant's machine. This registry is
// process-wide and per-tab by construction: there is no transport in it.
//
// ⚠ DELIVERY IS REPORTED, NEVER DROPPED. `request()` returns whether a command
// owner was actually there to receive it. An acquire writes NOTHING to the
// graph, so `readParam`/`readData` are structurally blind to it — the returned
// `delivered` flag is the only observable, and a caller that discarded it would
// make "the button works" and "the button is wired to nothing"
// indistinguishable.
//
// OWNER-CHECKED HAND-OVER, verbatim the discipline ./node-media-registry and
// ./camera-status-registry use, and for the same reason: the card is remounted
// by view moves (lane → headless host → dock), Svelte gives no cross-tree
// ordering guarantee, and a stale mount's teardown must never unregister the
// live one's commands.
//
// ⚠ DELIBERATE PARALLEL OF ./camera-status-registry, NOT A SHARED GENERIC. The
// mechanism (publish / owner-checked lease / delivery-reporting request /
// per-node subscribe / graph-keyed sweep) is the same; the STATUS and the
// COMMANDS are not, and neither is `stop`'s existence. `$lib/ui/viewport-
// acquire` already stands in exactly this relation to `$lib/ui/camera-acquire`
// and says so. TWO adopters is a pattern; a THIRD is the point at which the
// mechanism should be lifted into one generic registry and both call sites
// migrated — deliberately not done inside a face promotion, where it would put
// a shipped camera seam and its gates at risk for no user-visible gain.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`, NOT `lib/video/**` — that
// directory is hashed WHOLESALE for the WebGL attest, so a change there costs a
// GPU re-attest window. Keeping it here is deliberate and is a constraint on
// any future edit: do not move this file.
//
// TESTABILITY: no DOM, no framework, no globals — the web package's vitest runs
// in `environment: 'node'`, and this file needs nothing from a browser.

import type { LoopbackCaptureState } from '$lib/ui/viewport-acquire';

/**
 * The capture states a LOOPBACK card can be in.
 *
 * ⚠ RE-EXPORTED, NEVER RE-DECLARED — the same discipline
 * `camera-status-registry` applies to `CameraState`, arrived at the same way.
 * The union's ONE home is `$lib/ui/viewport-acquire`, the capture seam that
 * owns `getDisplayMedia` feature detection and the acquire call; the CARD
 * imports it from there too, so unlike CAMERA there is no second copy to keep
 * in sync and no sync gate to write. `loopback-status-registry.test.ts` asserts
 * that shape at the SOURCE level in both places, because nothing at runtime can
 * see a type alias.
 *
 * ⚠ TYPE-ONLY IMPORT. `viewport-acquire.ts` is under `lib/ui/**` so this is
 * hash-free either way, but `attest-code-basis.ts` drops type-only imports
 * regardless — the habit is what keeps a future move cheap.
 */
export type LoopbackStatusState = LoopbackCaptureState;

/** What the owning card publishes about its capture. Everything here is
 *  browser-local; none of it is in the shared document. */
export interface LoopbackStatus {
  readonly state: LoopbackStatusState;
  /** The card's recovery guidance for a failed state, or null. */
  readonly errorMsg: string | null;
  /**
   * Does this runtime have the Screen Capture API at all
   * (`isViewportCaptureSupported()`)? False disables the acquire affordance,
   * exactly as it does on the card. It is a separate field rather than being
   * folded into `state === 'unsupported'` because the two answer different
   * questions: `state` is where this capture IS, `supported` is what this
   * browser CAN do, and a consumer disabling a button needs the second one
   * whatever the first says.
   */
  readonly supported: boolean;
}

/** The commands a status consumer may invoke on the owning card. */
export interface LoopbackCommands {
  /**
   * (Re)acquire the tab capture — the card's "Start capture" / "Re-capture"
   * button. MUST be called from a real user gesture: it reaches
   * `getDisplayMedia`, and unlike `getUserMedia` there is no previously-granted
   * state that would let a programmatic call succeed.
   */
  acquire(): void;
  /** End the capture and return to idle — the card's "Stop capture" button.
   *  A genuine content change, so it DOES stop the node-owned tracks. */
  stop(): void;
}

/** Which command a `request()` names. */
export type LoopbackCommandId = keyof LoopbackCommands;

/** A card's claim on a node's command slot. `release()` is idempotent AND
 *  owner-checked: it does nothing once another mount has registered. */
export interface LoopbackCommandLease {
  release(): void;
}

/** What `request()` reports. See the DELIVERY paragraph in the header. */
export interface LoopbackRequestResult {
  /** Was a command owner registered to receive this? */
  readonly delivered: boolean;
  /** Set when the owner's handler threw — delivered is still true. */
  readonly error: unknown;
}

export interface LoopbackStatusRegistry {
  /** The owning card publishes its current capture state. */
  publish(nodeId: string, status: LoopbackStatus): void;
  /** The current status for a node, or null when no card has published one —
   *  which is a REAL state a consumer must render ("no card is mounted"), not a
   *  missing value to paper over. */
  read(nodeId: string): LoopbackStatus | null;
  /**
   * The owning card registers its command handlers. TRANSFERS ownership away
   * from any previous mount, so mount/unmount ORDER between two component trees
   * cannot strand the slot.
   */
  registerCommands(nodeId: string, commands: LoopbackCommands): LoopbackCommandLease;
  /** Is a command owner currently registered? Lets a consumer disable an
   *  affordance it cannot deliver rather than offering a dead button. */
  hasCommands(nodeId: string): boolean;
  /** Invoke one command. Reports delivery — see the header. */
  request(nodeId: string, command: LoopbackCommandId): LoopbackRequestResult;
  /** Subscribe to status/command-ownership changes for one node. Returns the
   *  unsubscribe. Fires on publish, on register and on release. */
  subscribe(nodeId: string, fn: () => void): () => void;
  /** Drop everything for one node. Called when the node leaves the GRAPH,
   *  never when a card unmounts. */
  clear(nodeId: string): void;
  /** Drop every node NOT present in `liveIds`. The graph is the authority. */
  sweep(liveIds: Iterable<string>): void;
}

interface Entry {
  status: LoopbackStatus | null;
  commands: LoopbackCommands | null;
  /** Identity of the mount that registered `commands` — the owner check. */
  owner: object | null;
  listeners: Set<() => void>;
}

/** Build a registry. Pure — no DOM, no globals, no transport. */
export function createLoopbackStatusRegistry(): LoopbackStatusRegistry {
  const entries = new Map<string, Entry>();

  function entryFor(nodeId: string): Entry {
    let e = entries.get(nodeId);
    if (!e) {
      e = { status: null, commands: null, owner: null, listeners: new Set() };
      entries.set(nodeId, e);
    }
    return e;
  }

  /** Drop everything for one node and tell its consumers. A LOCAL function
   *  rather than a method, so `sweep` can call it without depending on `this`
   *  — see the note at the call site. */
  function clearEntry(nodeId: string): void {
    const e = entries.get(nodeId);
    if (!e) return;
    e.status = null;
    e.commands = null;
    e.owner = null;
    notify(e);
    entries.delete(nodeId);
  }

  function notify(e: Entry): void {
    // Copy before iterating: a listener may unsubscribe itself.
    for (const fn of [...e.listeners]) {
      try {
        fn();
      } catch {
        /* a broken consumer must never break the publisher */
      }
    }
  }

  return {
    publish(nodeId, status) {
      const e = entryFor(nodeId);
      e.status = status;
      notify(e);
    },

    read(nodeId) {
      return entries.get(nodeId)?.status ?? null;
    },

    registerCommands(nodeId, commands) {
      const e = entryFor(nodeId);
      // TRANSFER: the newest mount always wins.
      const token = {};
      e.commands = commands;
      e.owner = token;
      notify(e);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          // OWNER CHECK: a stale mount's teardown must do nothing once another
          // mount has taken the slot.
          if (e.owner !== token) return;
          e.owner = null;
          e.commands = null;
          notify(e);
        },
      };
    },

    hasCommands(nodeId) {
      return entries.get(nodeId)?.commands != null;
    },

    request(nodeId, command) {
      const c = entries.get(nodeId)?.commands;
      if (!c) return { delivered: false, error: null };
      try {
        c[command]();
        return { delivered: true, error: null };
      } catch (error) {
        // Delivered but threw: the distinction matters, because "nobody was
        // listening" and "the owner failed" need different fixes.
        return { delivered: true, error };
      }
    },

    subscribe(nodeId, fn) {
      const e = entryFor(nodeId);
      e.listeners.add(fn);
      return () => {
        e.listeners.delete(fn);
      };
    },

    clear: clearEntry,

    sweep(liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
      for (const nodeId of [...entries.keys()]) {
        // ⚠ THE LOCAL FUNCTION, NEVER `this.clear`. Canvas calls these as
        // `loopbackStatus.sweep(liveIds)` today, so `this` happens to bind —
        // but a `this`-dependent method breaks silently the first time someone
        // destructures the registry (`const { sweep } = loopbackStatus`), which
        // is an ordinary thing to do and which every sibling registry in this
        // directory is safe against because they close over their helpers.
        if (!live.has(nodeId)) clearEntry(nodeId);
      }
    },
  };
}

/**
 * The process-wide capture-status registry.
 *
 * `LoopbackCard.svelte` publishes into it and registers its commands;
 * `LoopbackOutputBody.svelte` (the dock faceplate's extension body) reads and
 * invokes. Per-tab by construction — see the Yjs paragraph in the header.
 */
export const loopbackStatus: LoopbackStatusRegistry = createLoopbackStatusRegistry();
