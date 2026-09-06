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
//
// SAME-SESSION PATCH LOADS (the load-staleness fix): `loadEnvelopeIntoStore`
// deletes + re-inserts every node in ONE transaction, and the reconciler
// re-materializes nothing at a reused id — so THIS driver (and its socket,
// and its mounted plugin) SURVIVES a load that replaces `data.vst` under it.
// The driver used to read the record only on connect/list edges: a load never
// re-applied, and worse, the next state capture PERSISTED the still-mounted
// plugin back over the loaded record — silently reverting the load in the
// doc. Now every snapshot tick (meter rate, ~8 Hz) compares the record
// against the ECHO of the driver's own last write (identity fast path, field
// compare only on mismatch): an external change is adopted as authoritative
// INPUT — mount the loaded plugin (swap), setState a same-plugin blob, or
// unmount for an empty record — and until that adoption lands, no state
// reply or adopt-edge write may persist over the loaded value. A load that
// happens while DISCONNECTED needs none of this: the reconnect edge already
// re-reads the live record fresh (grace → maybeColdMount), and an adopt
// replay deliberately keeps the parked instance's newer state.

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

/** `echoRef` sentinel: the store-side identity of the record is unknown —
 *  fresh driver, or right after our own write (the store hands back a NEW
 *  object for it), so the next tick must fall through to the field compare. */
const ECHO_UNSET = Symbol('vst-echo-unset');

/** Field-level equality of two persisted records (either side may be a store
 *  proxy — only the three known fields are read). */
function samePersisted(a: VstPersisted | undefined, b: VstPersisted | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.pluginId === b.pluginId && a.stateB64 === b.stateB64 && a.stateBytes === b.stateBytes;
}

/** A plain field copy, detached from any store proxy. */
function copyPersisted(p: VstPersisted | undefined): VstPersisted | undefined {
  return p ? { pluginId: p.pluginId, stateB64: p.stateB64, stateBytes: p.stateBytes } : undefined;
}

export class VstPersistenceDriver {
  private readonly io: VstDriverIO;
  private prev: VstDriverSnapshot | null = null;
  /** pluginId of a mount THIS DRIVER requested (auto-remount, or the adoption
   *  of an externally loaded record) — a `mounted` matching it applies the
   *  stashed blob; anything else is adopt/user. */
  private pendingMountId: string | null = null;
  private pendingStateB64: string | null = null;
  private remountTimer: unknown = null;
  private refreshTimer: unknown = null;
  private disposed = false;
  /** The record as THIS DRIVER last saw/wrote it: `echoRef` is the exact
   *  value `io.read()` returned (identity fast path), `echoVal` a plain copy
   *  of its fields. A tick whose read differs from both is an EXTERNAL write
   *  (a same-session patch load, or a collaborator). */
  private echoRef: unknown = ECHO_UNSET;
  private echoVal: VstPersisted | undefined = undefined;
  private echoKnown = false;
  /** Active external adoption: the loaded record named this plugin (null =
   *  the loaded record was EMPTY, an unmount is in flight). While set, state
   *  replies and adopt-edge writes must NOT persist over the loaded record —
   *  they describe the plugin the load is replacing. */
  private externalTarget: { pluginId: string | null } | null = null;

  constructor(io: VstDriverIO) {
    this.io = io;
  }

  /** Every record write goes through here so the echo tracks it. */
  private persist(next: VstPersisted | undefined): void {
    this.io.write(next);
    this.echoKnown = true;
    this.echoVal = copyPersisted(next);
    this.echoRef = ECHO_UNSET;
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
      // Any control message we had in flight died with the socket, so drop
      // the pending cold mount AND an external adoption in progress: the
      // reconnect edge re-reads the LIVE record fresh (grace →
      // maybeColdMount), which is strictly more current than what we
      // wanted here.
      this.cancelRemountGrace();
      this.stopRefresh();
      this.pendingMountId = null;
      this.pendingStateB64 = null;
      this.externalTarget = null;
    }

    // ---- external record change (same-session patch load) ----------------
    // BEFORE the mount edges: a load and an adopt replay can land in the
    // same snapshot, and the adopt write below must already see the target.
    this.syncExternalRecord(snap);

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
        // OUR mount (cold remount, or the adoption of a loaded record):
        // apply the stashed blob exactly once.
        if (this.pendingStateB64) this.io.send({ type: 'setState', data: this.pendingStateB64 });
        this.pendingMountId = null;
        this.pendingStateB64 = null;
        this.externalTarget = null;
      } else {
        // Adopt replay or a user mount: NEVER setState over a live
        // instance. Persist the id (dropping a different plugin's stale
        // blob) and capture its current state instead — with one exception:
        // while an external adoption (a loaded record) is unresolved, an
        // edge for any OTHER plugin describes the plugin the load is
        // replacing (a swap's outgoing edge, or a race), and writing it
        // would revert the loaded record. A mount request WE sent for the
        // target is still in flight in that case, so the suppression is
        // temporary; without one in flight, a foreign mount is the USER
        // acting, and the user wins.
        const externalActionInFlight =
          this.externalTarget !== null && this.pendingMountId === this.externalTarget.pluginId;
        this.pendingMountId = null;
        this.pendingStateB64 = null;
        if (externalActionInFlight && mountId !== this.externalTarget!.pluginId) {
          // An edge for another plugin while OUR request (the swap-mount, or
          // the unmount for an empty loaded record) is still in flight — the
          // outgoing plugin, or a race. No write; our request resolves
          // (mounted / mountError / unmounted) right after.
        } else {
          // Either no adoption is pending, the loaded plugin itself arrived
          // (persist keeps its blob), or the user mounted over a suppression
          // with nothing in flight (the loaded plugin was not in the
          // helper's list) — the user wins.
          this.externalTarget = null;
          this.persist(
            persisted?.pluginId === mountId
              ? { ...persisted, pluginId: mountId }
              : { pluginId: mountId },
          );
        }
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
      // NOT while a swap to a loaded plugin is in flight: a helper may report
      // the outgoing plugin's unmount as part of the swap, and clearing here
      // would erase the record the load just wrote.
      if (!(this.externalTarget && this.externalTarget.pluginId !== null)) {
        this.persist(undefined);
        this.externalTarget = null;
      }
    }

    // ---- mount failure: drop the pending cold mount ------------------------
    if (snap.mountError && snap.mountError !== (prev?.mountError ?? null)) {
      if (this.pendingMountId === snap.mountError.pluginId) {
        this.pendingMountId = null;
        this.pendingStateB64 = null;
      }
      if (this.externalTarget?.pluginId === snap.mountError.pluginId) {
        // The loaded plugin cannot mount here — stop suppressing captures;
        // the doc keeps the loaded record until the live state overwrites
        // it, which at least reflects what is actually running.
        this.externalTarget = null;
      }
    }

    // ---- editor close: the state very likely changed -----------------------
    if (prev?.editorOpen === true && snap.editorOpen === false && mountId !== null) {
      this.io.send({ type: 'getState' });
    }

    // ---- a state reply: persist (capped) ------------------------------------
    // Skipped while an external adoption is in flight — the reply describes
    // the plugin the load is replacing, and persisting it would silently
    // revert the loaded record (THE bug this guard exists for).
    if (
      snap.pluginState
      && snap.pluginState !== (prev?.pluginState ?? null)
      && mountId !== null
      && this.externalTarget === null
    ) {
      const { data } = snap.pluginState;
      const record: VstPersisted =
        data.length > VST_STATE_B64_CAP
          ? { pluginId: mountId, stateBytes: data.length }
          : { pluginId: mountId, stateB64: data, stateBytes: data.length };
      this.persist(record);
    }
  }

  /**
   * Detect an EXTERNAL replacement of `data.vst` (a same-session patch load
   * at a reused node id, or a collaborator) and adopt it as authoritative
   * input. Runs on every snapshot; the identity fast path makes the steady
   * state O(1) — the field compare only runs when the read's identity is not
   * the one this driver last observed (which includes the tick right after
   * its own write, where the store hands back a fresh object).
   */
  private syncExternalRecord(snap: VstDriverSnapshot): void {
    const persisted = this.io.read();
    if (!this.echoKnown) {
      // First observation — the BOOT record. Cold mount applies it; nothing
      // to adopt.
      this.echoKnown = true;
      this.echoRef = persisted;
      this.echoVal = copyPersisted(persisted);
      return;
    }
    if (persisted === this.echoRef) return;
    if (samePersisted(persisted, this.echoVal)) {
      this.echoRef = persisted;
      return;
    }

    // EXTERNAL WRITE. Adopt it — and from here on, nothing may persist the
    // OLD plugin over it.
    this.echoRef = persisted;
    this.echoVal = copyPersisted(persisted);
    this.pendingMountId = null;
    this.pendingStateB64 = null;
    this.externalTarget = null;

    if (snap.state !== 'connected') {
      // Nothing can clobber the record while disconnected, and the reconnect
      // edge re-reads it fresh (grace → maybeColdMount). An adopt replay
      // deliberately wins over it — the parked instance's state is newer.
      return;
    }
    if (this.remountTimer !== null) {
      // A remount grace is already pending; maybeColdMount() re-reads the
      // live record at fire time, so it will see this value.
      return;
    }

    const mountId = snap.mounted?.plugin.id ?? null;
    if (!persisted?.pluginId) {
      // The loaded patch has NO plugin on this node.
      if (mountId !== null) {
        this.externalTarget = { pluginId: null };
        this.io.send({ type: 'unmount' });
      }
      return;
    }
    if (mountId === persisted.pluginId) {
      // Same plugin, different stored state: apply the loaded blob, then
      // re-capture so a stale in-flight reply cannot re-persist the old
      // state over it for a whole refresh period.
      if (persisted.stateB64) {
        this.io.send({ type: 'setState', data: persisted.stateB64 });
        this.io.send({ type: 'getState' });
      }
      return;
    }
    if (snap.plugins.some((p) => p.id === persisted.pluginId)) {
      // A different plugin: swap-mount it, blob applied when OUR mount lands.
      this.externalTarget = { pluginId: persisted.pluginId };
      this.pendingMountId = persisted.pluginId;
      this.pendingStateB64 = persisted.stateB64 ?? null;
      this.io.send({ type: 'mount', pluginId: persisted.pluginId });
      return;
    }
    // The loaded plugin is not installed on this helper: leave the live
    // instance alone, but never persist it over the loaded record. A later
    // user mount lifts the suppression through the mount edge.
    this.externalTarget = { pluginId: persisted.pluginId };
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
