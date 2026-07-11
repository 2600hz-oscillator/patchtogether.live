// packages/web/src/lib/ui/dock/dock-entries.ts
//
// DOCKING P2.5a — the pure per-node dock-entry model (design:
// .myrobots/docking-recommendation.md §2.2). A docked module NEVER leaves
// patch.nodes/edges; an entry here is a purely LOCAL projection: which
// zone the card renders in, its slot order, its independent scale, and the
// canvas position undock returns it to.
//
// Everything in this file is framework-free and unit-tested against plain
// values; the reactive wrapper lives in dock-store.svelte.ts.
//
// TOMBSTONE GC (the verifier correction): entries whose nodeId is absent
// from the snapshot are RETIRED, not deleted — quicksave slot switches
// reload a different patch into the same rackspace, and naive pruning
// would wipe dock state on every slot round-trip. A retired entry REVIVES
// when its id reappears (same ids on quickload); it hard-drops only after
// TOMBSTONE_MAX_ABSENT_SWEEPS snapshot commits spent absent, when the
// tombstone map overflows TOMBSTONE_CAP (oldest first), or when the LOCAL
// user explicitly deletes the node (noteExplicitDelete in the store).

import type { DockZone } from './dock';

/** One docked module's local projection. */
export interface DockEntry {
  zone: DockZone;
  /** Slot order within the zone (ascending; append = max+1). */
  order: number;
  /** Independent content scale (ZOOM_STEPS member; default 1). */
  scale: number;
  /** Canvas position captured at dock time — undock returns the node here
   *  through the existing layouts/node.position split. */
  restorePosition: { x: number; y: number };
}

/** A retired entry awaiting revive (nodeId absent from the snapshot). */
export interface DockTombstone {
  entry: DockEntry;
  /** How many GC sweeps (≈ snapshot commits) the id has been absent. */
  absentSweeps: number;
}

/** Serializable dock state for one rackspace (localStorage payload). */
export interface DockPersistedState {
  entries: Record<string, DockEntry>;
  tombstones: Record<string, DockTombstone>;
  /** Per-zone rail cross-axis size (px) where user-resized. */
  railSize: Partial<Record<DockZone, number>>;
  /** Per-zone collapsed flag (snap-to-collapse grabbers). */
  railCollapsed: Partial<Record<DockZone, boolean>>;
}

/** localStorage key prefix — bump the suffix on breaking shape changes. */
export const DOCK_STORAGE_PREFIX = 'pt.dock.v2:';

/** Hard-drop a tombstone after this many sweeps spent absent. Generous on
 *  purpose: a quicksave slot round-trip is a handful of commits; hundreds
 *  of commits with the id absent means the node is genuinely gone. */
export const TOMBSTONE_MAX_ABSENT_SWEEPS = 400;

/** Max retired entries kept per rackspace (oldest-absent dropped first). */
export const TOMBSTONE_CAP = 64;

// ---------------- Independent zoom (discrete steps) ----------------

/** The discrete dock-card scales: 50–150% in 25% steps (owner-approved
 *  P2.5a band; NOT the free-pinch continuum — see "What NOT to build"). */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5];
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
export const DEFAULT_ENTRY_SCALE = 1;

/** Clamp an arbitrary scale onto the discrete step ladder (nearest step). */
export function clampScaleToStep(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_ENTRY_SCALE;
  let best = ZOOM_STEPS[0];
  for (const s of ZOOM_STEPS) {
    if (Math.abs(s - scale) < Math.abs(best - scale)) best = s;
  }
  return best;
}

/** Step a scale up (+1) / down (−1) the ladder; clamps at the ends. */
export function stepScale(scale: number, direction: 1 | -1): number {
  const cur = clampScaleToStep(scale);
  const i = ZOOM_STEPS.indexOf(cur);
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction));
  return ZOOM_STEPS[next];
}

// ---------------- GC sweep (pure) ----------------

export interface SweepResult {
  entries: Record<string, DockEntry>;
  tombstones: Record<string, DockTombstone>;
  /** nodeIds evicted THIS sweep because a peer grouped them (toast these). */
  evictedGrouped: string[];
  /** nodeIds revived from tombstones this sweep (entry restored). */
  revived: string[];
  /** True when anything changed (persist + re-render only when so). */
  changed: boolean;
}

/**
 * One GC sweep against the live snapshot:
 *  - docked id absent            → retire to tombstone (absentSweeps=0)
 *  - docked id under a collapsed group → EVICT (hard-drop; caller toasts)
 *  - tombstoned id present again → revive (entry restored verbatim)
 *  - tombstoned id still absent  → age; hard-drop past
 *    TOMBSTONE_MAX_ABSENT_SWEEPS or beyond TOMBSTONE_CAP (oldest first).
 *
 * Pure: returns fresh maps (inputs untouched) + what changed.
 */
export function sweepDockState(
  entries: Readonly<Record<string, DockEntry>>,
  tombstones: Readonly<Record<string, DockTombstone>>,
  liveIds: ReadonlySet<string>,
  groupedIds: ReadonlySet<string>,
): SweepResult {
  const nextEntries: Record<string, DockEntry> = {};
  const nextTombstones: Record<string, DockTombstone> = {};
  const evictedGrouped: string[] = [];
  const revived: string[] = [];
  let changed = false;

  for (const [id, entry] of Object.entries(entries)) {
    if (groupedIds.has(id)) {
      // A peer (or the local user) folded the node into a collapsed group:
      // the card has no canvas presence to stub — evict outright.
      evictedGrouped.push(id);
      changed = true;
      continue;
    }
    if (!liveIds.has(id)) {
      nextTombstones[id] = { entry, absentSweeps: 0 };
      changed = true;
      continue;
    }
    nextEntries[id] = entry;
  }

  for (const [id, tomb] of Object.entries(tombstones)) {
    if (nextEntries[id] || nextTombstones[id]) continue; // freshly written above wins
    if (liveIds.has(id)) {
      // REVIVE: the id reappeared (quickload round-trip) — restore as-is.
      nextEntries[id] = tomb.entry;
      revived.push(id);
      changed = true;
      continue;
    }
    const aged = { entry: tomb.entry, absentSweeps: tomb.absentSweeps + 1 };
    if (aged.absentSweeps > TOMBSTONE_MAX_ABSENT_SWEEPS) {
      changed = true; // hard-drop by age
      continue;
    }
    nextTombstones[id] = aged;
    changed = true; // aging counts as a change (persisted counter)
  }

  // Cap: drop the oldest-absent tombstones beyond TOMBSTONE_CAP.
  const tombIds = Object.keys(nextTombstones);
  if (tombIds.length > TOMBSTONE_CAP) {
    const keep = tombIds
      .sort((a, b) => nextTombstones[a].absentSweeps - nextTombstones[b].absentSweeps)
      .slice(0, TOMBSTONE_CAP);
    const kept: Record<string, DockTombstone> = {};
    for (const id of keep) kept[id] = nextTombstones[id];
    changed = true;
    return { entries: nextEntries, tombstones: kept, evictedGrouped, revived, changed };
  }

  return { entries: nextEntries, tombstones: nextTombstones, evictedGrouped, revived, changed };
}

// ---------------- Persistence (guarded parse) ----------------

/** Parse a persisted payload; ANY malformed shape → clean empty state
 *  (never throw on a stale/corrupt localStorage blob). */
export function parsePersistedDockState(raw: string | null): DockPersistedState {
  const empty: DockPersistedState = { entries: {}, tombstones: {}, railSize: {}, railCollapsed: {} };
  if (!raw) return empty;
  try {
    const p = JSON.parse(raw) as Partial<DockPersistedState> | null;
    if (!p || typeof p !== 'object') return empty;
    const entries: Record<string, DockEntry> = {};
    for (const [id, e] of Object.entries(p.entries ?? {})) {
      if (!e || typeof e !== 'object') continue;
      const zone = (e as DockEntry).zone;
      if (zone !== 'top' && zone !== 'left' && zone !== 'bottom') continue;
      const rp = (e as DockEntry).restorePosition;
      entries[id] = {
        zone,
        order: Number.isFinite((e as DockEntry).order) ? (e as DockEntry).order : 0,
        scale: clampScaleToStep((e as DockEntry).scale),
        restorePosition:
          rp && Number.isFinite(rp.x) && Number.isFinite(rp.y) ? { x: rp.x, y: rp.y } : { x: 24, y: 24 },
      };
    }
    const tombstones: Record<string, DockTombstone> = {};
    for (const [id, t] of Object.entries(p.tombstones ?? {})) {
      const te = (t as DockTombstone | null)?.entry;
      if (!te) continue;
      const zone = te.zone;
      if (zone !== 'top' && zone !== 'left' && zone !== 'bottom') continue;
      tombstones[id] = {
        entry: {
          zone,
          order: Number.isFinite(te.order) ? te.order : 0,
          scale: clampScaleToStep(te.scale),
          restorePosition:
            te.restorePosition &&
            Number.isFinite(te.restorePosition.x) &&
            Number.isFinite(te.restorePosition.y)
              ? { x: te.restorePosition.x, y: te.restorePosition.y }
              : { x: 24, y: 24 },
        },
        absentSweeps: Number.isFinite((t as DockTombstone).absentSweeps)
          ? (t as DockTombstone).absentSweeps
          : 0,
      };
    }
    return {
      entries,
      tombstones,
      railSize: typeof p.railSize === 'object' && p.railSize ? p.railSize : {},
      railCollapsed: typeof p.railCollapsed === 'object' && p.railCollapsed ? p.railCollapsed : {},
    };
  } catch {
    return empty;
  }
}
