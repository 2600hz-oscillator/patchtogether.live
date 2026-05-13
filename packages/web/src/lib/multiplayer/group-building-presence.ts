// Group-building presence — Y.Awareness soft-lock for the group-builder
// modal (Module-grouping Phase 3C).
//
// When user A opens the group-builder modal, they broadcast
//   awareness.local.groupBuilding = { selectionIds: string[] }
// so remote rack-mates can:
//   1. Dim the canvas cards in user A's selection + render a small
//      "User A is grouping…" badge.
//   2. Disable their OWN "Group modules…" affordance when any of their
//      marquee selection intersects user A's selection (so two users
//      can't race-create overlapping groups).
//
// This is a SOFT lock — the source of truth is still the Yjs doc. Two
// users *can* commit overlapping groups in a Hocuspocus split-brain
// scenario, in which case the reconciler + group-projection layer
// resolve sanely (both groups end up in the snapshot; we don't try to
// merge them). The lock exists to make the common-case multi-user
// experience smooth.
//
// Wire shape (deliberately small):
//   { groupBuilding: { selectionIds: string[] } }
// On modal close, the field is set to null to clear.

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { PresenceUser } from './presence';

/** Wire field name in awareness state. */
export const GROUP_BUILDING_AWARENESS_FIELD = 'groupBuilding';

/** Awareness payload — empty selectionIds is treated identically to a
 *  cleared field, but the explicit empty-list shape lets a future "just
 *  opened the modal but haven't picked nodes yet" mode work. */
export interface GroupBuildingState {
  selectionIds: string[];
}

/** Per-remote summary of a peer's active group-building modal. */
export interface RemoteGroupBuilding {
  clientId: number;
  user: PresenceUser;
  selectionIds: string[];
}

/**
 * Set the local user's group-building state. Pass an empty/null payload
 * to clear (modal closed). Tolerant of missing provider/awareness; both
 * just no-op so callers don't have to special-case single-user mode.
 */
export function setLocalGroupBuildingSelection(
  provider: HocuspocusProvider | null | undefined,
  selectionIds: string[] | null,
): void {
  if (!provider) return;
  const aw = provider.awareness;
  if (!aw) return;
  if (selectionIds === null || selectionIds.length === 0) {
    aw.setLocalStateField(GROUP_BUILDING_AWARENESS_FIELD, null);
    return;
  }
  const prev = (aw.getLocalState() as Record<string, unknown> | null) ?? null;
  const prevState = prev?.[GROUP_BUILDING_AWARENESS_FIELD] as GroupBuildingState | null | undefined;
  const prevIds = prevState?.selectionIds ?? [];
  if (sameStringArray(prevIds, selectionIds)) return;
  aw.setLocalStateField(GROUP_BUILDING_AWARENESS_FIELD, {
    selectionIds: [...selectionIds],
  });
}

/**
 * Read the union of remote rack-mates' active group-builder selections.
 * Excludes the local user (their own modal state is already visible).
 */
export function readRemoteGroupBuilding(
  awareness: import('y-protocols/awareness').Awareness | null | undefined,
  localClientId: number,
): RemoteGroupBuilding[] {
  if (!awareness) return [];
  const out: RemoteGroupBuilding[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === localClientId) continue;
    const s = state as Record<string, unknown> | undefined;
    if (!s) continue;
    const user = s.user as PresenceUser | undefined;
    if (!user) continue;
    const gb = s[GROUP_BUILDING_AWARENESS_FIELD] as GroupBuildingState | null | undefined;
    if (!gb || !Array.isArray(gb.selectionIds) || gb.selectionIds.length === 0) continue;
    out.push({ clientId, user, selectionIds: gb.selectionIds });
  }
  return out;
}

/**
 * Convenience: { nodeId -> first remote user grouping it }. Used by the
 * canvas overlay to render "{user} is grouping" badges + dim those cards.
 * If two remote users happen to overlap selections (shouldn't normally —
 * the soft-lock prevents user B from opening their builder if any of
 * their selection intersects user A's — but defensive), the first one
 * wins.
 */
export function indexRemoteGroupBuildingByNode(
  remotes: RemoteGroupBuilding[],
): Record<string, PresenceUser> {
  const out: Record<string, PresenceUser> = {};
  for (const r of remotes) {
    for (const nodeId of r.selectionIds) {
      if (!(nodeId in out)) out[nodeId] = r.user;
    }
  }
  return out;
}

/**
 * Pure predicate: does `candidateSelection` overlap any remote user's
 * active group-building selection? Used to disable the local "Group
 * modules…" action when a peer's selection intersects ours.
 */
export function overlapsRemoteGroupBuilding(
  candidateSelection: readonly string[],
  remotes: readonly RemoteGroupBuilding[],
): boolean {
  if (candidateSelection.length === 0 || remotes.length === 0) return false;
  const candidate = new Set(candidateSelection);
  for (const r of remotes) {
    for (const id of r.selectionIds) {
      if (candidate.has(id)) return true;
    }
  }
  return false;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
