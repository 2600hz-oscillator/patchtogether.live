// packages/web/src/lib/control/push2/push2-view.svelte.ts
//
// "…or the most recent module VIEWED on the push if we've viewed the lane
// previously IN THIS RACK" — the memory half of the push-card focus rule.
//
// PER-MACHINE, PER-RACK, in localStorage. NOT in the Y.Doc, and that is a
// decision, not an oversight:
//
//   · `dx7-selection.svelte.ts` states the precedent verbatim — "putting it in
//     the Y.Doc means a rack-mate clicking OP 5 yanks YOUR detail panel". A
//     hardware screen is strictly more personal than a detail panel: your
//     rack-mate turning their encoder must not change what is on YOUR Push.
//   · The push2 plan §1 says the same: "Binding is per-machine localStorage;
//     LED/screen frames are LOCAL render state, NEVER synced."
//   · `push2-control.svelte.ts` already persists `pt.push2.selectedChannel`
//     the same way, so this is the same file's own precedent.
//
// localStorage rather than dx7's in-memory map because the owner said "in THIS
// RACK" — a property of the rack, not of the page load, so it survives a
// reload. (Owner question, one line either way behind this same API: should
// lane focus reset each session instead? Callers never see the difference.)
//
// Keyed by rackspace id so two racks on one machine do not cross-talk, LRU-
// capped so the key cannot grow without bound.

import { getBoundRackspaceId } from '$lib/graph/store';

/** localStorage key: `{ [rackspaceId]: { [lane]: nodeId } }`. */
export const PUSH_VIEW_STORAGE_KEY = 'pt.push2.laneFocus';

/** How many rackspaces keep a remembered focus before the least-recently-used
 *  one is dropped. Eight racks of eight lanes is ~64 short strings — bounded,
 *  and far more racks than a single machine cycles through in a session. */
export const PUSH_VIEW_MAX_RACKS = 8;

type LaneMap = Record<string, string>;
/** Insertion order IS the LRU order: a touched rack is re-inserted at the end. */
type Store = Record<string, LaneMap>;

/** The rack a memory belongs to. An unbound store (tests, a dashboard route)
 *  still gets a stable bucket rather than silently sharing every rack's. */
function rackKey(): string {
  return getBoundRackspaceId() ?? '_unbound';
}

function read(): Store {
  try {
    const raw = localStorage.getItem(PUSH_VIEW_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [rack, lanes] of Object.entries(parsed as Record<string, unknown>)) {
      if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) continue;
      const m: LaneMap = {};
      for (const [lane, id] of Object.entries(lanes as Record<string, unknown>)) {
        if (typeof id === 'string' && id) m[lane] = id;
      }
      out[rack] = m;
    }
    return out;
  } catch {
    // No localStorage (the node unit lane), private mode, or corrupt JSON — a
    // missing memory is never an error, it just means "fall back to the most
    // recently ADDED module", which is the documented default anyway.
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(PUSH_VIEW_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota — session-only, same as selectedChannel */
  }
}

/** The module last viewed on the Push for `lane` in the current rack, or null. */
export function lastViewed(lane: number): string | null {
  return read()[rackKey()]?.[String(lane)] ?? null;
}

/**
 * Remember `nodeId` as the lane's viewed module. Re-inserting the rack key
 * moves it to the END of the store's insertion order, which is what makes the
 * cap an LRU rather than an arbitrary eviction.
 */
export function setLastViewed(lane: number, nodeId: string): void {
  if (!nodeId) return;
  const store = read();
  const rack = rackKey();
  const lanes = { ...(store[rack] ?? {}), [String(lane)]: nodeId };
  delete store[rack]; // re-insert at the end → most-recently-used last
  store[rack] = lanes;
  const keys = Object.keys(store);
  for (const stale of keys.slice(0, Math.max(0, keys.length - PUSH_VIEW_MAX_RACKS))) {
    delete store[stale];
  }
  write(store);
}

/** Drop the memory for one lane of the current rack (the remembered module left
 *  the lane). Called on the fall-back path so the memory converges on what the
 *  Push is actually showing instead of drifting. */
export function forgetLane(lane: number): void {
  const store = read();
  const rack = rackKey();
  if (!store[rack]?.[String(lane)]) return;
  delete store[rack][String(lane)];
  write(store);
}

/** Drop every remembered lane of the current rack. */
export function forgetRack(): void {
  const store = read();
  if (!(rackKey() in store)) return;
  delete store[rackKey()];
  write(store);
}

/** TEST-ONLY: wipe the whole store (every rack). */
export function __test_resetPushView(): void {
  try {
    localStorage.removeItem(PUSH_VIEW_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
