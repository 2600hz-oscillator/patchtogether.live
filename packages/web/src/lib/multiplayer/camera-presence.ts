// Camera presence — Y.Awareness field for "who has CAMERA active here".
//
// The CAMERA module's stream is local-only (PR-62 ships the input as a
// solo-use input; multiplayer camera streaming is deferred to a future
// phase that needs WebRTC + SFU). To keep co-creators aware of WHO is
// holding a live camera in the rack — without sending pixels — every
// CAMERA card writes the local user's *active node ids* into a single
// awareness field, and remote rack-mates read that field and overlay a
// small badge on the matching card.
//
// Field name: 'cameraNodeIds'. Wire shape: string[] (lightweight enough to
// re-broadcast on every change without coalescing). Empty array (or absent
// field) = no active camera.
//
// Why an array, not a single id: the spec allows up to 4 CAMERA cards per
// user (cameraInputDef.maxInstances), and the rack composer pattern is
// "one source per face / per angle" — supporting >1 keeps the design
// honest.

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { PresenceUser } from './presence';

/** Wire field name in awareness state. */
export const CAMERA_AWARENESS_FIELD = 'cameraNodeIds';

/** Per-remote summary of which node ids hold an active CAMERA. */
export interface RemoteCameraPresence {
  clientId: number;
  user: PresenceUser;
  nodeIds: string[];
}

/**
 * Update the local Awareness state's `cameraNodeIds` field. Pass an empty
 * array to clear (no active cameras for this user).
 *
 * Tolerant of provider-not-yet-attached and provider-without-awareness;
 * those just no-op. The CameraInputCard calls this on mount when streaming
 * resumes, and on stream-stop / unmount.
 */
export function setLocalCameraNodeIds(
  provider: HocuspocusProvider | null | undefined,
  nodeIds: string[],
): void {
  if (!provider) return;
  const aw = provider.awareness;
  if (!aw) return;
  // Awareness `setLocalStateField` merges into the existing local state;
  // pass through unchanged if the value didn't change (avoids needless
  // re-broadcast).
  const prev = (aw.getLocalState() as Record<string, unknown> | null) ?? null;
  const prevIds = (prev?.[CAMERA_AWARENESS_FIELD] as string[] | undefined) ?? [];
  if (sameStringArray(prevIds, nodeIds)) return;
  aw.setLocalStateField(CAMERA_AWARENESS_FIELD, [...nodeIds]);
}

/**
 * Add one node id to the local user's active-camera set. Idempotent.
 */
export function addLocalCameraNodeId(
  provider: HocuspocusProvider | null | undefined,
  nodeId: string,
): void {
  if (!provider) return;
  const aw = provider.awareness;
  if (!aw) return;
  const prev = (aw.getLocalState() as Record<string, unknown> | null) ?? null;
  const prevIds = (prev?.[CAMERA_AWARENESS_FIELD] as string[] | undefined) ?? [];
  if (prevIds.includes(nodeId)) return;
  aw.setLocalStateField(CAMERA_AWARENESS_FIELD, [...prevIds, nodeId]);
}

/**
 * Remove one node id from the local user's active-camera set. Idempotent;
 * removing an id that isn't present is a no-op.
 */
export function removeLocalCameraNodeId(
  provider: HocuspocusProvider | null | undefined,
  nodeId: string,
): void {
  if (!provider) return;
  const aw = provider.awareness;
  if (!aw) return;
  const prev = (aw.getLocalState() as Record<string, unknown> | null) ?? null;
  const prevIds = (prev?.[CAMERA_AWARENESS_FIELD] as string[] | undefined) ?? [];
  if (!prevIds.includes(nodeId)) return;
  const next = prevIds.filter((x) => x !== nodeId);
  aw.setLocalStateField(CAMERA_AWARENESS_FIELD, next);
}

/**
 * Read the union of remote rack-mates' active-camera sets. Excludes the
 * local user (we don't badge our own cards — the in-card UI already shows
 * stream state). Tolerant of awareness states that don't include the
 * cameraNodeIds field (most peers won't, that's the steady state).
 */
export function readRemoteCameraPresence(
  awareness: import('y-protocols/awareness').Awareness | null | undefined,
  localClientId: number,
): RemoteCameraPresence[] {
  if (!awareness) return [];
  const out: RemoteCameraPresence[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === localClientId) continue;
    const s = state as Record<string, unknown> | undefined;
    if (!s) continue;
    const user = s.user as PresenceUser | undefined;
    if (!user) continue;
    const nodeIds = (s[CAMERA_AWARENESS_FIELD] as string[] | undefined) ?? [];
    if (nodeIds.length === 0) continue;
    out.push({ clientId, user, nodeIds });
  }
  return out;
}

/**
 * Convenience: { nodeId -> the (first) remote user holding it }. The
 * AwarenessLayer or per-card overlay uses this to render the "{user} has
 * CAMERA active" badge keyed off the local DOM node id.
 *
 * If two remote users somehow have the same node id (shouldn't happen —
 * node ids are rack-scoped — but defensive), the first one wins.
 */
export function indexRemoteCamerasByNode(
  remotes: RemoteCameraPresence[],
): Record<string, PresenceUser> {
  const out: Record<string, PresenceUser> = {};
  for (const r of remotes) {
    for (const nodeId of r.nodeIds) {
      if (!(nodeId in out)) out[nodeId] = r.user;
    }
  }
  return out;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
