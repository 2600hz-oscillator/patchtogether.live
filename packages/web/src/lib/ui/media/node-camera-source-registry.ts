// packages/web/src/lib/ui/media/node-camera-source-registry.ts
//
// THE NODE-SCOPED OWNER OF THE CAMERA CAPTURE — getUserMedia, the device roster,
// the saved-device rebind, the permission/error state machine and the engine
// attach, on GRAPH lifetime instead of card lifetime.
//
// Same move as `./node-loopback-source-registry`, same reason, one module later.
// Read that file's header for the argument; what follows is only what is
// different about CAMERA, and three of the four differences are load-bearing.
//
// ── 1. THE GESTURE RULE IS WEAKER HERE, AND THAT MAKES MORE WORK, NOT LESS ──
//
// `getDisplayMedia` has no already-granted state, so loopback's controller can
// only ever RESTORE a capture. `getUserMedia` DOES: once an origin holds camera
// permission, a programmatic call succeeds with no gesture. So this controller
// legitimately auto-acquires — and that is exactly why its mount path is full of
// guards rather than a bare call:
//
//   * it acquires only when labels are already visible (`hasLabels`), because an
//     unpermissioned call raises a PERMISSION PROMPT, and a rack LOAD must never
//     raise one;
//   * it acquires only when the `enabled` param says so;
//   * it refuses a doomed exact-`deviceId` request when the saved camera is gone,
//     because that only ever OverconstrainedErrors.
//
// Those guards used to live in the card's `onMount`, which meant they ran when a
// CARD mounted. A card mounting is not a moment at which acquiring is
// appropriate; a NODE entering the graph is.
//
// ── 2. THE `enabled` PARAM OWNS THE HARDWARE ────────────────────────────────
//
// The card carried a hard-won correction here (see its header): the pause/resume
// BUTTON used to stop and start the track beside writing the param, which made
// the button the authority and left every OTHER writer — a collaborator's
// toggle, the faceplate's ON cell — changing a shader branch while the camera
// light stayed on. The fix made the PARAM the authority, watched by an effect.
//
// That effect moves here as a `sync`-time comparison, and the SKIP-FIRST rule
// moves with it verbatim. `enabled` defaults to 1, so acting on the first
// observation would fire getUserMedia for every camera node the moment it
// appears, with none of the mount guards above. The first `sync` RECORDS the
// value; every later one acts on a CHANGE.
//
// ── 3. THE AWARENESS BADGE NOW TRACKS THE STREAM, NOT A MOUNT ───────────────
//
// ⚠ A DELIBERATE BEHAVIOUR CHANGE, called out because it is the one thing here
// that is not a pure relocation. `addLocalCameraNodeId` tells rack-mates "this
// user has a camera live on this node"; the card added it on stream start and
// REMOVED IT IN `onDestroy`, with the stated reason that "leaving it set for an
// unmounted card would show peers a badge for a card that is not on screen".
//
// That reason was right about cards and wrong about the claim. The badge says a
// CAMERA IS LIVE, which is a fact about the stream, not about whose screen has a
// card on it — and it only behaved correctly on the default shell because the
// headless host kept a card mounted for exactly as long as the node existed. Tie
// it to the stream and it is right in every arrangement, including the one where
// no surface is mounted at all. So: added when the stream starts, removed when
// the stream stops or the node leaves the graph.
//
// ── 4. THE DEVICE ROSTER IS RUNTIME STATE WITH NO GRAPH HOME ────────────────
//
// `enumerateDevices()` is per-browser and per-permission; `deviceCount` gates
// whether acquire is offerable at all. It is published rather than stored.
//
// PURE — no DOM, no globals, no timers of its own. Every outside edge is
// injected so the whole state machine unit-tests in the web package's
// `environment: 'node'` lane. The browser binding is `./node-camera-source.svelte.ts`.

import type { ModuleNode } from '$lib/graph/types';
import type { CameraState } from '$lib/video/camera-device';
import { shouldReacquireOnPick } from '$lib/video/camera-device';
import { resolveDevice, shouldRewriteSavedId } from '$lib/graph/device-rebind';
import { isDeviceSlotId } from '$lib/graph/device-slots';

/** The `nodeMedia` slot this controller owns for a camera node. */
export const CAMERA_SOURCE_SLOT = 'main';

/** The engine-attach retry, verbatim from the card's `onMount` (~5s). */
export const RETRY_INTERVAL_MS = 100;
export const RETRY_ATTEMPTS = 50;

/** What a surface can ask of a camera node. `pick` carries an argument, so this
 *  is a discriminated union rather than the bare command id the status seam
 *  currently exposes — see the note on `request`. */
export type CameraSourceCommand =
  | { kind: 'acquire' }
  | { kind: 'stop' }
  | { kind: 'pick'; deviceId: string };

export interface CameraDeviceEntry {
  readonly deviceId: string;
  readonly label: string;
}

export interface CameraSourceStatus {
  readonly state: CameraState;
  readonly errorMsg: string | null;
  /** How many video inputs `enumerateDevices()` returned. Zero disables the
   *  acquire affordance on every surface. */
  readonly deviceCount: number;
  /** Set when the saved camera was re-found by NAME because its saved id had
   *  been regenerated, else null. Deliberately NOT `errorMsg` — a successful
   *  rebind is an outcome, not a failure. */
  readonly rebindNotice: string | null;
  /** This session's device roster. Published so a picker on ANY surface reads
   *  one roster rather than each enumerating its own. */
  readonly devices: readonly CameraDeviceEntry[];
  /** Whether device labels are visible yet — i.e. whether this origin already
   *  holds camera permission. */
  readonly hasDeviceLabels: boolean;
  /** The device this node is bound to, or null for the browser default. */
  readonly selectedDeviceId: string | null;
  /** Has the engine confirmed it holds this node's element? */
  readonly attached: boolean;
}

export const NO_CAMERA_SOURCE: CameraSourceStatus = {
  state: 'idle',
  errorMsg: null,
  deviceCount: 0,
  rebindNotice: null,
  devices: [],
  hasDeviceLabels: false,
  selectedDeviceId: null,
  attached: false,
};

export interface CameraRequestResult {
  readonly delivered: boolean;
  readonly error: unknown;
}

export interface CameraSourceEngine {
  attach(nodeId: string, el: unknown | null): void;
  hasElement(nodeId: string): boolean;
}

export interface CameraSourceMedia<E> {
  ensure(nodeId: string, slot: string): E;
  setStream(nodeId: string, slot: string, stream: MediaStream | null): void;
  stream(nodeId: string, slot: string): MediaStream | null;
}

export interface CameraElementOps<E> {
  setStream(el: E, stream: MediaStream | null): void;
  play(el: E): void;
}

/** The acquisition edge. `acquire` goes through the repo's retry seam
 *  (`$lib/ui/camera-acquire`), which tries webcam-friendly constraints and then
 *  ONE bare deviceId-only retry for a device that NotReadableErrors — the thing
 *  that distinguishes a format-picky capture driver from a genuinely held one. */
export interface CameraCaptureOps {
  supported(): boolean;
  enumerate(): Promise<CameraDeviceEntry[]>;
  acquire(deviceId: string | null): Promise<{
    stream: MediaStream | null;
    error: { name: string; message: string } | null;
    usedBareRetry: boolean;
  }>;
  /** The track's own `deviceId`, once the browser has chosen one. */
  chosenDeviceId(stream: MediaStream): string | null;
  onEnded(stream: MediaStream, fn: () => void): () => void;
}

/** The graph read/write for the two persisted device keys. */
export interface CameraSourceDoc {
  savedDeviceId(nodeId: string): string | null;
  savedDeviceLabel(nodeId: string): string | null;
  writeSavedDevice(nodeId: string, deviceId: string | null, label: string | null): void;
  /** `params.enabled > 0.5`. */
  enabled(nodeId: string): boolean;
}

/** The multiplayer awareness badge. See note 3 in the header. */
export interface CameraPresenceOps {
  add(nodeId: string): void;
  remove(nodeId: string): void;
}

export interface CameraSourceClock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CameraSourceDeps<E> {
  engine: CameraSourceEngine | null;
  media: CameraSourceMedia<E>;
  el: CameraElementOps<E>;
  capture: CameraCaptureOps;
  doc: CameraSourceDoc;
  presence: CameraPresenceOps;
  clock: CameraSourceClock;
  onStatus?(nodeId: string, status: CameraSourceStatus): void;
}

export interface NodeCameraSourceRegistry<E> {
  sync(nodes: readonly ModuleNode[], engine: CameraSourceEngine | null): void;
  view(nodeId: string): CameraSourceStatus;
  request(nodeId: string, cmd: CameraSourceCommand): CameraRequestResult;
  has(nodeId: string): boolean;
  disposeNode(nodeId: string): void;
  sweep(liveIds: Iterable<string>): void;
  snapshot(): Array<{ nodeId: string } & CameraSourceStatus>;
}

/**
 * The types whose camera source this registry owns.
 *
 * ⚠ ANCHORED IN BOTH DIRECTIONS by `dom-source-modules.test.ts` — absent from
 * `DOM_SOURCE_LANE_TYPES`, present in exactly one node-owner set. Neither half
 * of the conversion can land alone.
 */
export const NODE_CAMERA_SOURCE_TYPES: ReadonlySet<string> = new Set<string>(['cameraInput']);

interface Controller<E> {
  node: ModuleNode;
  el: E;
  status: CameraSourceStatus;
  retry: unknown | null;
  offEnded: (() => void) | null;
  /** Last `enabled` this controller ACTED on. `null` until the first sync — the
   *  SKIP-FIRST rule (header note 2). */
  actedEnabled: boolean | null;
  /** Has the mount-time acquire decision been made for this node yet? */
  bootstrapped: boolean;
  disposed: boolean;
  dispose(): void;
}

export function createNodeCameraSourceRegistry<E>(
  deps: CameraSourceDeps<E>,
): NodeCameraSourceRegistry<E> {
  const controllers = new Map<string, Controller<E>>();

  function publish(c: Controller<E>, next: Partial<CameraSourceStatus>): void {
    const merged: CameraSourceStatus = { ...c.status, ...next };
    const same =
      merged.state === c.status.state &&
      merged.errorMsg === c.status.errorMsg &&
      merged.deviceCount === c.status.deviceCount &&
      merged.rebindNotice === c.status.rebindNotice &&
      merged.devices === c.status.devices &&
      merged.hasDeviceLabels === c.status.hasDeviceLabels &&
      merged.selectedDeviceId === c.status.selectedDeviceId &&
      merged.attached === c.status.attached;
    if (same) return;
    c.status = merged;
    deps.onStatus?.(c.node.id, merged);
  }

  function labelFor(c: Controller<E>, deviceId: string | null): string | null {
    if (!deviceId) return null;
    const found = c.status.devices.find((d) => d.deviceId === deviceId);
    return found && found.label !== '' ? found.label : null;
  }

  /**
   * Persist the bound device.
   *
   * ⚠ ONLY EVER WRITE A REAL LABEL, AND NEVER CLEAR A GOOD ONE — carried over
   * verbatim from the card, because it is the whole reason the name fallback
   * works. Before permission is granted `enumerateDevices()` redacts every label
   * to '', so persisting whatever is on hand would save a name that matches
   * EVERY unlabelled device on the next machine: a fallback with maximum
   * confidence and no information.
   */
  function saveDevice(c: Controller<E>, deviceId: string | null): void {
    deps.doc.writeSavedDevice(c.node.id, deviceId, labelFor(c, deviceId));
    publish(c, { selectedDeviceId: deviceId });
  }

  async function refreshDevices(c: Controller<E>): Promise<boolean> {
    const devices = await deps.capture.enumerate();
    if (c.disposed) return false;
    const hasLabels = devices.some((d) => d.label !== '');
    publish(c, { devices, deviceCount: devices.length, hasDeviceLabels: hasLabels });
    return hasLabels;
  }

  function startAttachRetry(c: Controller<E>): void {
    if (c.retry !== null) return;
    let attempts = 0;
    c.retry = deps.clock.setInterval(() => {
      attempts++;
      const eng = deps.engine;
      if (eng) {
        try {
          eng.attach(c.node.id, c.el);
          if (eng.hasElement(c.node.id)) {
            stopAttachRetry(c);
            publish(c, { attached: true });
            return;
          }
        } catch {
          /* engine not ready */
        }
      }
      if (attempts > RETRY_ATTEMPTS) stopAttachRetry(c);
    }, RETRY_INTERVAL_MS);
  }

  function stopAttachRetry(c: Controller<E>): void {
    if (c.retry === null) return;
    deps.clock.clearInterval(c.retry);
    c.retry = null;
  }

  /**
   * An EXPLICIT stop — the user paused, the device was unplugged, permission was
   * revoked, or the node is leaving. A content event; never a view teardown.
   */
  function stopStream(c: Controller<E>): void {
    const nodeId = c.node.id;
    c.offEnded?.();
    c.offEnded = null;
    deps.media.setStream(nodeId, CAMERA_SOURCE_SLOT, null);
    deps.el.setStream(c.el, null);
    try {
      deps.engine?.attach(nodeId, null);
    } catch {
      /* engine gone */
    }
    // The badge follows the STREAM (header note 3).
    deps.presence.remove(nodeId);
    publish(c, { attached: false });
  }

  /**
   * Acquire a camera stream.
   *
   * The error taxonomy is carried over from the card unchanged, because each
   * branch's TEXT is the module's only recovery instruction and the states are
   * distinguishable to a user in ways the raw DOMException names are not.
   * `NotReadableError` in particular is ambiguous — another app holding the
   * device OR a driver failing to start the source — and the text says both,
   * because "in use" alone sends people hunting for an app that may not exist.
   */
  async function acquire(c: Controller<E>): Promise<void> {
    const nodeId = c.node.id;
    if (!deps.capture.supported()) {
      publish(c, { state: 'unsupported', errorMsg: 'Browser does not support getUserMedia' });
      return;
    }
    publish(c, { state: 'requesting', errorMsg: null });
    stopStream(c);

    const target = c.status.selectedDeviceId;
    const result = await deps.capture.acquire(target ?? null);
    if (c.disposed) {
      result.stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!result.stream) {
      const e = result.error;
      if (!e) {
        publish(c, { state: 'error', errorMsg: 'Camera acquisition failed.' });
        return;
      }
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        publish(c, {
          state: 'permission-denied',
          errorMsg: 'Camera permission blocked. Grant in browser site settings.',
        });
      } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
        publish(c, {
          state: 'no-cameras-found',
          errorMsg: 'No camera matches the selected constraints.',
        });
      } else if (e.name === 'NotReadableError') {
        publish(c, {
          state: 'device-in-use',
          errorMsg:
            'Camera is busy or failed to start. Close other capture apps ' +
            '(OBS, Desktop Video Setup), and check the device has a live input signal.',
        });
      } else {
        publish(c, { state: 'error', errorMsg: `${e.name}: ${e.message}` });
      }
      return;
    }

    const stream = result.stream;
    deps.media.setStream(nodeId, CAMERA_SOURCE_SLOT, stream);
    // Permission granted — re-enumerate to pick up the real device labels.
    await refreshDevices(c);
    if (c.disposed) return;

    deps.el.setStream(c.el, stream);
    deps.el.play(c.el);
    try {
      deps.engine?.attach(nodeId, c.el);
    } catch {
      /* the retry keeps offering */
    }

    // Record which camera the browser actually gave us.
    const realId = deps.capture.chosenDeviceId(stream);
    if (realId && realId !== c.status.selectedDeviceId) {
      saveDevice(c, realId);
    } else if (c.status.selectedDeviceId) {
      saveDevice(c, c.status.selectedDeviceId);
    }

    c.offEnded = deps.capture.onEnded(stream, () => {
      if (c.disposed) return;
      if (c.status.state !== 'streaming') return;
      stopStream(c);
      publish(c, {
        state: 'error',
        errorMsg: 'Camera stream ended (disconnected or revoked).',
      });
    });

    publish(c, {
      state: 'streaming',
      errorMsg: null,
      attached: deps.engine?.hasElement(nodeId) ?? false,
    });
    deps.presence.add(nodeId);
  }

  function pick(c: Controller<E>, deviceId: string): void {
    saveDevice(c, deviceId);
    // A pick ANSWERS any "I reconnected this by name" notice, so it must not
    // linger over a choice the player has now made explicitly.
    publish(c, { rebindNotice: null });
    if (shouldReacquireOnPick(c.status.state)) void acquire(c);
  }

  /**
   * The ONE-TIME mount decision, moved off the card's `onMount`.
   *
   * ⚠ EVERY GUARD HERE IS LOAD-BEARING AND EACH ONE COST A BUG. In order: an
   * empty roster is `no-cameras-found` rather than a doomed request; an origin
   * with no labels yet is left alone so a rack LOAD never raises a permission
   * prompt; a saved device that no longer resolves is reported rather than
   * requested (an exact-`deviceId` request for a missing camera only
   * OverconstrainedErrors); and "nothing saved" is NOT "not found" — a fresh
   * camera with no saved device falls through to an UNCONSTRAINED request and
   * gets the browser's default, which is what a freshly-spawned camera has
   * always done. Collapsing those last two left every fresh camera stuck at
   * `no-cameras-found` having never called getUserMedia at all.
   */
  async function bootstrap(c: Controller<E>): Promise<void> {
    const hasLabels = await refreshDevices(c);
    if (c.disposed) return;
    if (c.status.devices.length === 0) {
      publish(c, { state: 'no-cameras-found', errorMsg: 'No cameras detected.' });
      return;
    }
    if (!hasLabels || !deps.doc.enabled(c.node.id)) return;

    const savedLabel = deps.doc.savedDeviceLabel(c.node.id);
    const hadSavedDevice = Boolean(c.status.selectedDeviceId || savedLabel);
    // ⚠ AN UNBOUND DEVICE SLOT IS DARK, AND MUST NOT REACH getUserMedia.
    //
    // A dynamic camera with nothing saved falls through to the UNCONSTRAINED
    // request below and gets the browser's default camera — which is right,
    // because a dynamic camera only exists because the user just pressed ＋
    // and asked for one. A RESERVED DEVICE SLOT (graph/device-slots.ts) exists
    // in every rack whether or not anyone asked, so the same fall-through
    // would mean: for any operator who has EVER granted camera permission to
    // this origin, four slots each fire an unconstrained getUserMedia on
    // every single rack boot. That is a camera light on at boot, and four
    // clients contending for one physical default device — the
    // `NotReadableError` class the acquire path already carries a bare-retry
    // for.
    //
    // A slot acquires when it is BOUND, and not before.
    if (!hadSavedDevice && isDeviceSlotId(c.node.id)) return;
    const rebind = resolveDevice(
      { id: c.status.selectedDeviceId, name: savedLabel },
      c.status.devices.map((d) => ({ id: d.deviceId, name: d.label })),
    );
    if (hadSavedDevice && rebind.id === null) {
      publish(c, {
        state: 'no-cameras-found',
        errorMsg: 'Saved camera not found — pick another from the list.',
      });
      return;
    }
    if (rebind.id !== null && rebind.matchedBy !== 'exact-id') {
      // ⚠ NEVER RE-POINT A PATCH SILENTLY. The saved id is gone and a DIFFERENT
      // id has been bound by name; that is almost always the same physical
      // camera, and "almost always" is exactly the case that needs saying out
      // loud rather than being discovered later as "why is this the wrong
      // camera".
      publish(c, {
        rebindNotice:
          rebind.matchedBy === 'name-ambiguous'
            ? `Reconnected to "${savedLabel}" by name — ${rebind.candidates.length} cameras share that name, so this may not be the same one.`
            : `Reconnected to "${savedLabel}" by name (its saved id changed).`,
        selectedDeviceId: rebind.id,
      });
      // Self-healing: persist THIS session's id so the next load is an exact hit
      // and the fallback is not paid twice.
      if (shouldRewriteSavedId(rebind)) saveDevice(c, rebind.id);
    }
    await acquire(c);
  }

  function createController(node: ModuleNode): Controller<E> {
    const el = deps.media.ensure(node.id, CAMERA_SOURCE_SLOT);
    const supported = deps.capture.supported();
    const c: Controller<E> = {
      node,
      el,
      status: {
        ...NO_CAMERA_SOURCE,
        state: supported ? 'idle' : 'unsupported',
        errorMsg: supported ? null : 'Browser does not support getUserMedia',
        selectedDeviceId: deps.doc.savedDeviceId(node.id),
      },
      retry: null,
      offEnded: null,
      actedEnabled: null,
      bootstrapped: false,
      disposed: false,
      dispose(): void {
        c.disposed = true;
        stopAttachRetry(c);
        c.offEnded?.();
        c.offEnded = null;
        // The NODE is leaving — here, and only here, releasing the hardware and
        // dropping the badge is right.
        deps.presence.remove(c.node.id);
      },
    };
    deps.onStatus?.(node.id, c.status);
    if (supported) {
      startAttachRetry(c);

      // REHYDRATE first: a controller can be rebuilt for a node whose camera is
      // already streaming (a sync race, an undo round-trip) while `nodeMedia`
      // kept the stream. Coming back to 'idle' would tell the user the camera
      // stopped when it did not — and worse, `bootstrap` would then re-acquire.
      const existing = deps.media.stream(node.id, CAMERA_SOURCE_SLOT);
      if (existing) {
        deps.el.setStream(el, existing);
        c.offEnded = deps.capture.onEnded(existing, () => {
          if (c.disposed) return;
          if (c.status.state !== 'streaming') return;
          stopStream(c);
          publish(c, { state: 'error', errorMsg: 'Camera stream ended (disconnected or revoked).' });
        });
        c.bootstrapped = true;
        publish(c, { state: 'streaming', errorMsg: null });
        deps.presence.add(node.id);
      } else {
        c.bootstrapped = true;
        void bootstrap(c);
      }
    }
    return c;
  }

  return {
    sync(nodes, engine) {
      deps.engine = engine;
      const live = new Set<string>();
      for (const n of nodes) {
        if (!NODE_CAMERA_SOURCE_TYPES.has(n.type)) continue;
        live.add(n.id);
        const existing = controllers.get(n.id);
        if (!existing) {
          controllers.set(n.id, createController(n));
          continue;
        }
        existing.node = n;

        // ── THE `enabled` PARAM OWNS THE HARDWARE (header note 2) ───────────
        //
        // ⚠ SKIP-FIRST. `enabled` defaults to 1, so acting on the first
        // observation would fire getUserMedia for every camera node the moment
        // it appears, bypassing every guard in `bootstrap`. The first sync
        // RECORDS; later syncs act on a CHANGE.
        const on = deps.doc.enabled(n.id);
        if (existing.actedEnabled === null) {
          existing.actedEnabled = on;
        } else if (on !== existing.actedEnabled) {
          existing.actedEnabled = on;
          if (!on) {
            // Pause means the hardware is FREED, not that a shader branch
            // changed — the param's own docs say so, and honouring it here is
            // what makes a collaborator's toggle and the faceplate's ON cell
            // behave like the card's button always did.
            stopStream(existing);
            publish(existing, { state: 'paused', errorMsg: null });
          } else if (shouldReacquireOnPick(existing.status.state)) {
            void acquire(existing);
          }
        }

        // ── AN EXTERNAL DEVICE PICK ─────────────────────────────────────────
        //
        // ⚠ THE CARD HYDRATED THIS ONCE ON MOUNT AND NEVER LOOKED AGAIN, so a
        // device chosen anywhere other than that card's own `<select>` was saved
        // and never acted on. The live case is COLLABORATION: `deviceId` is in
        // Yjs, so a rack-mate's pick already arrived and sat in the document
        // doing nothing. Running it off the graph snapshot is what makes it
        // land — and it is guarded three ways so it cannot loop or fight the
        // user: only on a real difference, only for a non-null id, and only
        // from a state that would accept a local pick.
        const saved = deps.doc.savedDeviceId(n.id);
        if (saved && saved !== existing.status.selectedDeviceId) {
          publish(existing, { selectedDeviceId: saved });
          if (shouldReacquireOnPick(existing.status.state)) void acquire(existing);
        }
      }
      for (const [id, c] of [...controllers]) {
        if (!live.has(id)) {
          c.dispose();
          controllers.delete(id);
        }
      }
    },

    view(nodeId) {
      return controllers.get(nodeId)?.status ?? NO_CAMERA_SOURCE;
    },

    request(nodeId, cmd) {
      const c = controllers.get(nodeId);
      if (!c) return { delivered: false, error: null };
      try {
        switch (cmd.kind) {
          case 'acquire':
            // NOT awaited: on a first visit this call IS inside the surface's
            // click gesture, and the permission prompt depends on it.
            void acquire(c);
            break;
          case 'stop':
            stopStream(c);
            publish(c, { state: 'idle', errorMsg: null });
            break;
          case 'pick':
            pick(c, cmd.deviceId);
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
      const out: Array<{ nodeId: string } & CameraSourceStatus> = [];
      for (const [nodeId, c] of controllers) out.push({ nodeId, ...c.status });
      return out;
    },
  };
}
