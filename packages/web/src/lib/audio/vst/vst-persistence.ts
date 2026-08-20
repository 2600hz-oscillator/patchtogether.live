// packages/web/src/lib/audio/vst/vst-persistence.ts
//
// Plugin persistence + auto-remount for a VST card — a PURE driver over
// injected IO (read/write the node's Y.Doc data, send control messages,
// timers), so every branch unit-tests without a store, a socket, or a clock
// (vst-persistence.test.ts). The factory (modules/vst-bridge-shared.ts)
// instantiates one per node and feeds it every owner snapshot.
//
// WHAT IT PERSISTS — `node.data.vst: { pluginId, stateB64?, stateBytes? }`,
// written ONLY on discrete events (mount, unmount, a state reply, editor
// close), never per-tick (`cv-modulation-live-store-write-storm`). The blob
// is the AU fullState, base64, capped: past VST_STATE_B64_CAP only the
// pluginId + size are kept (the card shows the too-large warning; the
// helper's parked instance and the user's own plugin-side saving carry big
// sample-based instruments — plan §7 / open question Q2's suggested cap).
//
// AUTO-REMOUNT, and the adopt/cold disambiguation that makes it safe:
//   - ADOPT: on reconnect with the same clientId the bridge REPLAYS
//     `mounted` right after pluginList — the driver sees a mount it never
//     requested and must NOT setState over the live instance (its state is
//     newer than ours); it just re-persists the id and refreshes its copy.
//   - COLD: no replay arrives within VST_REMOUNT_GRACE_MS of the plugin
//     list; if the patch carries a pluginId the driver sends `mount`, and
//     when THAT mount (tracked by id) lands, applies the persisted blob
//     via `setState` — exactly once.
//   - A mount the USER initiated (card picker) looks like an adopt to the
//     driver (unrequested) and takes the same safe path: persist + capture.
//
// STATE REFRESH — `getState` on: every mount that lands (capture the
// baseline), the native editor closing (the one moment state is very likely
// to have changed), and a slow VST_STATE_REFRESH_MS cadence while mounted
// (edits made while the editor stays open). Never per-second.

export interface VstPersisted {
  pluginId: string;
  /** base64 AU fullState; absent when the blob exceeded the cap. */
  stateB64?: string;
  /** Byte length of the last state blob (base64 chars) — the card's size
   *  indicator, kept even when the blob itself is too large to store. */
  stateBytes?: number;
}

/** Max base64 chars persisted into the patch (≈256 KB). */
export const VST_STATE_B64_CAP = 256 * 1024;
/** How long after a plugin list to wait for an adopt-replayed `mounted`
 *  before cold-mounting the persisted plugin. */
export const VST_REMOUNT_GRACE_MS = 1000;
/** Cadence of background `getState` refreshes while mounted. */
export const VST_STATE_REFRESH_MS = 60_000;

/** The slice of the owner snapshot the driver reads (structural subset of
 *  bridge-owner's VstOwnerSnapshot — kept minimal so tests stay small). */
export interface VstDriverSnapshot {
  state: string;
  plugins: ReadonlyArray<{ id: string }>;
  mounted: { plugin: { id: string } } | null;
  mountError: { pluginId: string } | null;
  editorOpen: boolean;
  pluginState: { pluginId: string; data: string } | null;
  /** Monotonic count of EXPLICIT `unmounted` messages (see bridge-owner) —
   *  the ONLY signal that clears the persisted record. A mounted→null
   *  transition alone can be a fresh-session stale-mount invalidation. */
  unmounts: number;
}

export interface VstDriverIO {
  read(): VstPersisted | undefined;
  /** Replace (or clear, with undefined) the persisted record. Implementations
   *  write a fresh PLAIN object each time — never mutate a live Y child. */
  write(next: VstPersisted | undefined): void;
  send(msg: Record<string, unknown>): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

export class VstPersistenceDriver {
  private readonly io: VstDriverIO;
  private prev: VstDriverSnapshot | null = null;
  /** pluginId of a mount THIS DRIVER requested (auto-remount) — a `mounted`
   *  matching it applies the stashed blob; anything else is adopt/user. */
  private pendingMountId: string | null = null;
  private pendingStateB64: string | null = null;
  private remountTimer: unknown = null;
  private refreshTimer: unknown = null;
  private disposed = false;

  constructor(io: VstDriverIO) {
    this.io = io;
  }

  onSnapshot(snap: VstDriverSnapshot): void {
    if (this.disposed) return;
    const prev = this.prev;
    this.prev = snap;

    // ---- connection edges ------------------------------------------------
    const wasConnected = prev?.state === 'connected';
    const isConnected = snap.state === 'connected';
    if (wasConnected && !isConnected) {
      // Socket gone: nothing to send until it returns. Keep the persisted
      // record; the parked instance (or the cold remount) covers the rest.
      this.cancelRemountGrace();
      this.stopRefresh();
    }

    // ---- cold-remount check: on the CONNECTED edge (covers first connect
    // AND reconnects, where the owner's plugin list is already populated)
    // and on a first plugin-list arrival. The grace window lets an
    // adopt-replayed `mounted` win; maybeColdMount() re-reads the live
    // snapshot at fire time.
    const connectedEdge = isConnected && !wasConnected;
    const listArrived = isConnected && snap.plugins.length > 0 && (prev?.plugins.length ?? 0) === 0;
    if ((connectedEdge || listArrived) && snap.mounted === null && this.remountTimer === null) {
      this.remountTimer = this.io.setTimer(() => {
        this.remountTimer = null;
        this.maybeColdMount();
      }, VST_REMOUNT_GRACE_MS);
    }

    // ---- mount edges -----------------------------------------------------
    const prevMountId = prev?.mounted?.plugin.id ?? null;
    const mountId = snap.mounted?.plugin.id ?? null;
    if (mountId !== null && mountId !== prevMountId) {
      // A plugin landed (fresh mount or a swap). An adopt replay makes the
      // cold path moot either way.
      this.cancelRemountGrace();
      const persisted = this.io.read();
      if (this.pendingMountId === mountId) {
        // OUR cold remount: apply the persisted blob exactly once.
        if (this.pendingStateB64) this.io.send({ type: 'setState', data: this.pendingStateB64 });
        this.pendingMountId = null;
        this.pendingStateB64 = null;
      } else {
        // Adopt replay or a user mount: NEVER setState over a live
        // instance. Persist the id (dropping a different plugin's stale
        // blob) and capture its current state instead.
        this.pendingMountId = null;
        this.pendingStateB64 = null;
        this.io.write(
          persisted?.pluginId === mountId
            ? { ...persisted, pluginId: mountId }
            : { pluginId: mountId },
        );
        this.io.send({ type: 'getState' });
      }
      this.startRefresh();
    }
    if (mountId === null && prevMountId !== null) {
      // The plugin left the snapshot — either an explicit unmount or a
      // fresh-session stale-mount invalidation. Refreshing stops either
      // way; the RECORD is cleared only below, on the explicit signal.
      this.stopRefresh();
    }
    if (snap.unmounts > (prev?.unmounts ?? 0)) {
      // EXPLICIT unmount — the user let go of the plugin; clear the record.
      this.io.write(undefined);
    }

    // ---- mount failure: drop the pending cold mount ------------------------
    if (snap.mountError && snap.mountError !== (prev?.mountError ?? null)) {
      if (this.pendingMountId === snap.mountError.pluginId) {
        this.pendingMountId = null;
        this.pendingStateB64 = null;
      }
    }

    // ---- editor close: the state very likely changed -----------------------
    if (prev?.editorOpen === true && snap.editorOpen === false && mountId !== null) {
      this.io.send({ type: 'getState' });
    }

    // ---- a state reply: persist (capped) ------------------------------------
    if (snap.pluginState && snap.pluginState !== (prev?.pluginState ?? null) && mountId !== null) {
      const { data } = snap.pluginState;
      const record: VstPersisted =
        data.length > VST_STATE_B64_CAP
          ? { pluginId: mountId, stateBytes: data.length }
          : { pluginId: mountId, stateB64: data, stateBytes: data.length };
      this.io.write(record);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRemountGrace();
    this.stopRefresh();
  }

  private maybeColdMount(): void {
    if (this.disposed) return;
    const snap = this.prev;
    if (!snap || snap.state !== 'connected' || snap.mounted !== null) return;
    const persisted = this.io.read();
    if (!persisted?.pluginId) return;
    // Only mount what the helper actually lists — a missing plugin would
    // just bounce off mountError, but refusing here keeps the log quiet
    // and the card's mountError surface reserved for USER actions.
    if (!snap.plugins.some((p) => p.id === persisted.pluginId)) return;
    this.pendingMountId = persisted.pluginId;
    this.pendingStateB64 = persisted.stateB64 ?? null;
    this.io.send({ type: 'mount', pluginId: persisted.pluginId });
  }

  private startRefresh(): void {
    this.stopRefresh();
    const tick = () => {
      this.refreshTimer = null;
      const snap = this.prev;
      if (this.disposed || !snap || snap.state !== 'connected' || snap.mounted === null) return;
      this.io.send({ type: 'getState' });
      this.refreshTimer = this.io.setTimer(tick, VST_STATE_REFRESH_MS);
    };
    this.refreshTimer = this.io.setTimer(tick, VST_STATE_REFRESH_MS);
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== null) {
      this.io.clearTimer(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private cancelRemountGrace(): void {
    if (this.remountTimer !== null) {
      this.io.clearTimer(this.remountTimer);
      this.remountTimer = null;
    }
  }
}
