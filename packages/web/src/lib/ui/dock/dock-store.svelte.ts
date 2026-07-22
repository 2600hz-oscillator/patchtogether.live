// packages/web/src/lib/ui/dock/dock-store.svelte.ts
//
// DOCKING — the LOCAL, reactive dock state (model: ./dock.ts + ./dock-entries.ts).
//
// One module-scope singleton, like skinStore. Two layers of state:
//
//  1. P1 PINNED-DRAWER OCCUPANCY (transient, per tab): which pinned M/E/C
//     card the bottom drawer currently shows. Never persisted — a reload
//     starts with the drawer closed, exactly like P1 shipped.
//
//  2. P2.5a DOCK ENTRIES (persisted per rackspace): {zone, order, scale,
//     restorePosition} per docked nodeId + the TOMBSTONES of retired
//     entries + rail sizes/collapsed flags. Keyed in localStorage as
//     `pt.dock.v2:${rackspaceKey}` — Canvas binds the key on mount. GC
//     runs through sweepDockState (dock-entries.ts): absent ids RETIRE to
//     tombstones and REVIVE on reappearance, so quicksave slot round-trips
//     never wipe dock state (the verifier's naive-prune correction).
//
// Dock state NEVER enters the Y.Doc (transient-state doctrine / the TOYBOX
// write-storm lesson): membership, zone, order, scale, rail sizes are all
// per-user view furniture. The only synced writes docking makes are the
// position write-backs in Canvas (through the EXISTING layouts/
// node.position split).

import {
  isImplementedDockZone,
  toggleDockedId,
  type DockZone,
} from './dock';
import {
  DOCK_STORAGE_PREFIX,
  DEFAULT_ENTRY_SCALE,
  clampScaleToStep,
  parsePersistedDockState,
  stepScale,
  sweepDockState,
  type DockEntry,
  type DockPersistedState,
  type DockTombstone,
} from './dock-entries';

/** Storage seam — injectable for unit tests (node env has no localStorage). */
export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): DockStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // privacy modes can throw on access
  }
}

class DockStore {
  // ---- P1 pinned-drawer occupancy (transient) ----
  #docked = $state<Partial<Record<DockZone, string | null>>>({});

  // ---- P0.3b EXPANDED FULL-VIEW occupancy (transient, per tab) ----
  //
  // The bottom drawer's "expanded full-view" occupant: the ONE node whose FULL
  // faceplate is currently open in the dock ALONGSIDE the pinned drawer occupant
  // (modeled on #docked, one-per-bottom-zone, ESC-closable). This is the shell-
  // preview legacy-fallback's dock half — an UN-MIGRATED module's "open in dock"
  // and a MIGRATED module's "Expand" both set it. It is NEVER a persisted dock
  // ENTRY (so it doesn't swap the lane tile to a stub — the module keeps its
  // curated/placeholder lane face) and is NEVER written to the Y.Doc: pure
  // transient view furniture, lost on reload exactly like the pinned drawer.
  #fullView = $state<string | null>(null);

  // ---- P2.5a entries (persisted per rackspace) ----
  #entries = $state<Record<string, DockEntry>>({});
  #tombstones: Record<string, DockTombstone> = {};
  #railSize = $state<Partial<Record<DockZone, number>>>({});
  #railCollapsed = $state<Partial<Record<DockZone, boolean>>>({});
  /** Pinned-occupant scale (per node id; the trio isn't a dock ENTRY). */
  #pinnedScale = $state<Record<string, number>>({});

  #rackKey: string | null = null;
  #storage: DockStorage | null = defaultStorage();

  /** Test seam: swap the storage backend (unit tests pass a Map-backed shim). */
  __setStorageForTest(storage: DockStorage | null): void {
    this.#storage = storage;
  }

  // ---------------- rackspace binding + persistence ----------------

  /** Bind to a rackspace (Canvas mount). Loads that rackspace's persisted
   *  entries; clears the transient drawer occupancy. */
  bind(rackspaceKey: string): void {
    this.#rackKey = rackspaceKey;
    this.#docked = {};
    this.#fullView = null;
    const parsed = parsePersistedDockState(
      this.#storage?.getItem(DOCK_STORAGE_PREFIX + rackspaceKey) ?? null,
    );
    this.#entries = parsed.entries;
    this.#tombstones = parsed.tombstones;
    this.#railSize = parsed.railSize;
    this.#railCollapsed = parsed.railCollapsed;
  }

  /** Unbind (Canvas unmount): drop transient occupancy; entries stay
   *  persisted for the next bind of the same rackspace. */
  unbind(): void {
    this.#rackKey = null;
    this.#docked = {};
    this.#fullView = null;
    this.#entries = {};
    this.#tombstones = {};
    this.#railSize = {};
    this.#railCollapsed = {};
    this.#pinnedScale = {};
  }

  #persist(): void {
    if (!this.#rackKey || !this.#storage) return;
    const payload: DockPersistedState = {
      entries: this.#entries,
      tombstones: this.#tombstones,
      railSize: this.#railSize,
      railCollapsed: this.#railCollapsed,
    };
    try {
      this.#storage.setItem(DOCK_STORAGE_PREFIX + this.#rackKey, JSON.stringify(payload));
    } catch {
      /* quota / privacy — dock state degrades to session-only */
    }
  }

  // ---------------- P1 pinned-drawer API (unchanged semantics) ----------------

  /** The pinned nodeId occupying `zone`'s drawer slot, or null. */
  dockedNodeId(zone: DockZone): string | null {
    return this.#docked[zone] ?? null;
  }

  /** True when any pinned drawer is open. */
  get anyOpen(): boolean {
    return Object.values(this.#docked).some((v) => v != null);
  }

  /** Toggle the pinned occupant of `zone` (same id closes; different id
   *  replaces — one pinned card per zone). */
  toggle(zone: DockZone, nodeId: string): void {
    if (!isImplementedDockZone(zone)) return;
    this.#docked[zone] = toggleDockedId(this.dockedNodeId(zone), nodeId);
  }

  /** Close `zone`'s pinned drawer (no-op when already empty). */
  close(zone: DockZone): void {
    if (this.#docked[zone] != null) this.#docked[zone] = null;
  }

  /** Close every pinned drawer (rack mount/unmount hygiene). */
  closeAll(): void {
    this.#docked = {};
    this.#fullView = null;
  }

  // ---------------- P0.3b expanded full-view occupancy (transient) ----------------

  /** The node whose full faceplate is open in the bottom dock full-view, or
   *  null. Reactive — the bottom rail's card list reads this. */
  get fullViewNodeId(): string | null {
    return this.#fullView;
  }

  /** Open `nodeId`'s full faceplate in the bottom dock full-view (transient —
   *  never a persisted entry). Un-collapses the bottom rail so the card shows.
   *  Opening a different node REPLACES the occupant (one-per-bottom-zone). */
  openFullView(nodeId: string): void {
    this.#fullView = nodeId;
    if (this.#railCollapsed.bottom) {
      this.#railCollapsed = { ...this.#railCollapsed, bottom: false };
    }
  }

  /** Close the full-view (no-op when already closed). */
  closeFullView(): void {
    if (this.#fullView !== null) this.#fullView = null;
  }

  // ---------------- P2.5a dock entries ----------------

  /** The dock entry for `nodeId`, or null. */
  entryFor(nodeId: string): DockEntry | null {
    return this.#entries[nodeId] ?? null;
  }

  /** Reactive predicate the flowNodes derivation reads (stub swap). */
  isDocked(nodeId: string): boolean {
    return this.#entries[nodeId] !== undefined;
  }

  /** All docked ids (reactive). */
  get dockedIds(): string[] {
    return Object.keys(this.#entries);
  }

  /** Zone contents, order-ascending (reactive). */
  entriesFor(zone: DockZone): Array<{ nodeId: string; entry: DockEntry }> {
    return Object.entries(this.#entries)
      .filter(([, e]) => e.zone === zone)
      .map(([nodeId, entry]) => ({ nodeId, entry }))
      .sort((a, b) => a.entry.order - b.entry.order);
  }

  /** Dock `nodeId` into `zone` (append order). Re-docking an already-docked
   *  node MOVES it (keeps scale + restorePosition). Expanding a collapsed
   *  rail on dock keeps the new card visible. */
  dock(nodeId: string, zone: DockZone, restorePosition: { x: number; y: number }): void {
    const existing = this.#entries[nodeId];
    const orders = Object.values(this.#entries)
      .filter((e) => e.zone === zone)
      .map((e) => e.order);
    const order = orders.length > 0 ? Math.max(...orders) + 1 : 0;
    this.#entries = {
      ...this.#entries,
      [nodeId]: existing
        ? { ...existing, zone, order }
        : { zone, order, scale: DEFAULT_ENTRY_SCALE, restorePosition },
    };
    delete this.#tombstones[nodeId];
    if (this.#railCollapsed[zone]) this.#railCollapsed = { ...this.#railCollapsed, [zone]: false };
    this.#persist();
  }

  /** Undock `nodeId`; returns the removed entry (caller writes the position
   *  back through the existing layouts/node.position split). */
  undock(nodeId: string): DockEntry | null {
    const entry = this.#entries[nodeId];
    if (!entry) return null;
    const next = { ...this.#entries };
    delete next[nodeId];
    this.#entries = next;
    this.#persist();
    return entry;
  }

  /** The LOCAL user explicitly deleted these nodes → hard-drop entries AND
   *  tombstones (an explicit delete is the one signal that retirement must
   *  not revive). Returns the ids that were docked (caller toasts). */
  noteExplicitDelete(nodeIds: Iterable<string>): string[] {
    const wasDocked: string[] = [];
    let touched = false;
    const next = { ...this.#entries };
    for (const id of nodeIds) {
      if (next[id]) {
        delete next[id];
        wasDocked.push(id);
        touched = true;
      }
      if (this.#tombstones[id]) {
        delete this.#tombstones[id];
        touched = true;
      }
    }
    if (touched) {
      this.#entries = next;
      this.#persist();
    }
    return wasDocked;
  }

  /** GC sweep against the live snapshot (see dock-entries.sweepDockState).
   *  Returns ids evicted because a peer grouped them (caller toasts). */
  sweep(liveIds: ReadonlySet<string>, groupedIds: ReadonlySet<string>): string[] {
    const res = sweepDockState(this.#entries, this.#tombstones, liveIds, groupedIds);
    if (res.changed) {
      this.#entries = res.entries;
      this.#tombstones = res.tombstones;
      this.#persist();
    }
    return res.evictedGrouped;
  }

  /** Tombstone count (unit-test observability). */
  get tombstoneCount(): number {
    return Object.keys(this.#tombstones).length;
  }

  // ---------------- independent zoom (per entry / per pinned card) ----------------

  /** Content scale for a docked entry OR a pinned drawer occupant. */
  scaleOf(nodeId: string): number {
    return this.#entries[nodeId]?.scale ?? this.#pinnedScale[nodeId] ?? DEFAULT_ENTRY_SCALE;
  }

  /** Set a card's scale (snapped to the discrete ZOOM_STEPS ladder). */
  setScaleOf(nodeId: string, scale: number): void {
    const snapped = clampScaleToStep(scale);
    const entry = this.#entries[nodeId];
    if (entry) {
      this.#entries = { ...this.#entries, [nodeId]: { ...entry, scale: snapped } };
      this.#persist();
    } else {
      this.#pinnedScale = { ...this.#pinnedScale, [nodeId]: snapped };
    }
  }

  /** Step a card's scale up/down one 25% notch (clamps 50–150%). */
  stepScaleOf(nodeId: string, direction: 1 | -1): void {
    this.setScaleOf(nodeId, stepScale(this.scaleOf(nodeId), direction));
  }

  // ---------------- rails ----------------

  railCollapsed(zone: DockZone): boolean {
    return this.#railCollapsed[zone] === true;
  }

  setRailCollapsed(zone: DockZone, collapsed: boolean): void {
    this.#railCollapsed = { ...this.#railCollapsed, [zone]: collapsed };
    this.#persist();
  }

  railSize(zone: DockZone): number | null {
    const v = this.#railSize[zone];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  setRailSize(zone: DockZone, px: number): void {
    if (!Number.isFinite(px)) return;
    this.#railSize = { ...this.#railSize, [zone]: Math.max(0, Math.round(px)) };
    this.#persist();
  }
}

/** The app-wide dock singleton (local view state — per tab). */
export const dockStore = new DockStore();
