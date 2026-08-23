// packages/web/src/lib/ui/media/camera-status-registry.ts
//
// THE CAPTURE-STATUS SEAM — how a SECOND surface can show, and drive, a camera
// whose stream has exactly ONE owner.
//
// WHY THIS EXISTS (measured, on the promotion that created it). Promoting
// `cameraInput` removes it from `NON_SHELL_LANE_TYPES`, so its real card stops
// rendering in the lane and moves into `<HeadlessSourceHost>` — which parks at
// `left:-9999px` with `pointer-events: none` and `aria-hidden="true"`. The
// STREAM survives that move (the `<video>` and its MediaStream are node-owned;
// see ./node-media-registry), and the picture keeps arriving. What does NOT
// survive is every INTERACTIVE affordance the card draws, because an off-screen
// pointer-events-none subtree cannot be clicked:
//
//   * "Request access" / "Retry" — the ONLY user gesture that calls
//     `getUserMedia`. The card's mount-time auto-acquire fires only when
//     `enumerateDevices()` already returns real LABELS, i.e. only when this
//     origin was granted permission on some earlier visit. So without this seam
//     a FIRST-TIME user has no way to start the camera at all in the default
//     shell — which is the owner's original "no video at all" P0 reproduced
//     through a different mechanism, not a cosmetic loss.
//   * the ERROR text — `permission-denied` says "Grant in browser site
//     settings", `device-in-use` names OBS and a missing input signal. Those are
//     the recovery instructions, and a lamp with no words cannot carry them.
//   * the real capture STATE. A face lamp derived from the GRAPH alone can only
//     say "a device is chosen and capture is enabled"; it cannot distinguish
//     that from "permission was denied", and a lamp that shows ARMED while the
//     browser is refusing frames is worse than no lamp.
//
// WHY A REGISTRY AND NOT A SECOND PERMISSION MACHINE. `getUserMedia`, the
// `MediaStream` and the state machine have ONE owner — `CameraInputCard.svelte`
// — and that must not change: two callers would be two owners, and whichever
// tore down last would strand the survivor. So this file moves no ownership. The
// card PUBLISHES what it knows and REGISTERS its acquire command; another
// surface READS the status and INVOKES the command. It is a remote control, not
// a second machine.
//
// ⚠ WHY THE STATUS IS BROWSER-LOCAL AND NEVER TOUCHES Yjs. A permission grant is
// a property of ONE person's browser. `CameraInputCard`'s own header says so
// ("permission grants are browser-instance-local"), and the def repeats it.
// Syncing `permission-denied` would assert something false about every other
// participant's machine. This registry is process-wide and per-tab by
// construction: there is no transport in it.
//
// ⚠ DELIVERY IS REPORTED, NEVER DROPPED. `request()` returns whether a command
// owner was actually there to receive it. An action-shaped affordance writes
// nothing to the graph, so `readParam`/`readData` are structurally blind to it —
// the returned `delivered` flag is the only observable, and a caller that
// discarded it would make "the button works" and "the button is wired to
// nothing" indistinguishable.
//
// OWNER-CHECKED HAND-OVER, verbatim the discipline ./node-media-registry uses
// and for the same reason: the card is remounted by view moves (lane → headless
// host → dock), Svelte gives no cross-tree ordering guarantee, and a stale
// mount's teardown must never unregister the live one's command.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`, NOT `lib/video/**` — that
// directory is hashed WHOLESALE for the WebGL attest, so a change there costs a
// GPU re-attest window. Keeping it here is deliberate and is a constraint on any
// future edit: do not move this file.
//
// TESTABILITY: no DOM, no framework, no globals — the web package's vitest runs
// in `environment: 'node'`, and this file needs nothing from a browser.

import type { CameraState } from '$lib/video/camera-device';

/**
 * The capture states a camera card can be in.
 *
 * ⚠ RE-EXPORTED, NEVER RE-DECLARED. `$lib/video/camera-device` already owns this
 * union and its header already claims it is "kept BYTE-IN-SYNC with the card's
 * `State` union" — a claim NOTHING checked until
 * `camera-status-registry.test.ts` grew the source gate for it. A third hand-
 * typed copy here would have been a third thing to keep in sync and a third
 * place for a new state to go missing, so this is an alias.
 *
 * ⚠ TYPE-ONLY IMPORT, WHICH IS ALSO WHY IT IS FREE. `camera-device.ts` is in the
 * WebGL attest basis; `attest-code-basis.ts` drops type-only imports, so reading
 * this type here costs no GPU re-attest window.
 */
export type CameraCaptureState = CameraState;

/** What the owning card publishes about its capture. Everything here is
 *  browser-local; none of it is in the shared document. */
export interface CameraStatus {
  readonly state: CameraCaptureState;
  /** The card's recovery guidance for a failed state, or null. */
  readonly errorMsg: string | null;
  /** How many video inputs `enumerateDevices()` returned. Zero disables the
   *  acquire affordance, exactly as it does on the card. */
  readonly deviceCount: number;
}

/** The commands a status consumer may invoke on the owning card. */
export interface CameraCommands {
  /** (Re)acquire the stream — the card's "Request access" / "Retry" button.
   *  MUST be called from a real user gesture: it reaches `getUserMedia`. */
  acquire(): void;
}

/** A card's claim on a node's command slot. `release()` is idempotent AND
 *  owner-checked: it does nothing once another mount has registered. */
export interface CameraCommandLease {
  release(): void;
}

/** What `request()` reports. See the DELIVERY paragraph in the header. */
export interface CameraRequestResult {
  /** Was a command owner registered to receive this? */
  readonly delivered: boolean;
  /** Set when the owner's handler threw — delivered is still true. */
  readonly error: unknown;
}

export interface CameraStatusRegistry {
  /** The owning card publishes its current capture state. */
  publish(nodeId: string, status: CameraStatus): void;
  /** The current status for a node, or null when no card has published one —
   *  which is a REAL state a consumer must render ("no card is mounted"), not a
   *  missing value to paper over. */
  read(nodeId: string): CameraStatus | null;
  /**
   * The owning card registers its command handlers. TRANSFERS ownership away
   * from any previous mount, so mount/unmount ORDER between two component trees
   * cannot strand the slot.
   */
  registerCommands(nodeId: string, commands: CameraCommands): CameraCommandLease;
  /** Is a command owner currently registered? Lets a consumer disable an
   *  affordance it cannot deliver rather than offering a dead button. */
  hasCommands(nodeId: string): boolean;
  /** Invoke the acquire command. Reports delivery — see the header. */
  request(nodeId: string): CameraRequestResult;
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
  status: CameraStatus | null;
  commands: CameraCommands | null;
  /** Identity of the mount that registered `commands` — the owner check. */
  owner: object | null;
  listeners: Set<() => void>;
}

/** Build a registry. Pure — no DOM, no globals, no transport. */
export function createCameraStatusRegistry(): CameraStatusRegistry {
  const entries = new Map<string, Entry>();

  function entryFor(nodeId: string): Entry {
    let e = entries.get(nodeId);
    if (!e) {
      e = { status: null, commands: null, owner: null, listeners: new Set() };
      entries.set(nodeId, e);
    }
    return e;
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

    request(nodeId) {
      const c = entries.get(nodeId)?.commands;
      if (!c) return { delivered: false, error: null };
      try {
        c.acquire();
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

    clear(nodeId) {
      const e = entries.get(nodeId);
      if (!e) return;
      e.status = null;
      e.commands = null;
      e.owner = null;
      notify(e);
      entries.delete(nodeId);
    },

    sweep(liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
      for (const nodeId of [...entries.keys()]) {
        if (!live.has(nodeId)) this.clear(nodeId);
      }
    },
  };
}

/**
 * The process-wide capture-status registry.
 *
 * `CameraInputCard.svelte` publishes into it and registers its acquire command;
 * `CameraInputOutputBody.svelte` (the dock faceplate's extension body) reads and
 * invokes. Per-tab by construction — see the Yjs paragraph in the header.
 */
export const cameraStatus: CameraStatusRegistry = createCameraStatusRegistry();
