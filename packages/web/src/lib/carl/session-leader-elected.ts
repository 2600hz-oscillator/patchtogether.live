// packages/web/src/lib/carl/session-leader-elected.ts
//
// Approach B — "Resilient Carl" exclusivity + leader election.
//
// Two coupled concepts:
//
// 1) **Session record** (Y.Map, persisted in the doc):
//
//      {
//        ownerUserId: string,
//        ownerDisplayName: string,
//        spawnedAt: number,
//        seed: number,
//        active: boolean,            // true between spawn + 86
//      }
//
//    Same shape + Yjs-CRDT semantics as approach A — one writer wins
//    on simultaneous spawns. Used purely as the "Carl is in this room"
//    declaration; nothing here decides WHO ticks.
//
// 2) **Leader presence** (Y.Awareness, ephemeral):
//
//      `carlLeader: { clientId: number, since: number }`
//
//    Each connected tab that sees `session.active=true` participates
//    in an election:
//      - Every 1s, compute leader = peer-with-the-lowest-clientID
//        across ALL awareness states whose user is connected.
//      - If `leader.clientId === myClientId`, this tab runs the
//        controller. Otherwise it stops the controller (idempotent).
//      - Awareness GCs disconnected peers in ~30s, so leader rotation
//        on tab close happens within that window. We accelerate it
//        with a short heartbeat update + a periodic re-evaluation.
//
//    Net effect: Carl keeps ticking even if the spawner leaves, as
//    long as ANY peer is still in the rackspace. Closing the last tab
//    naturally suspends him until someone comes back.
//
// Why not just elect leader on every spawn and embed it in the Y.Map?
// Because we want re-election on leader disconnect to happen WITHOUT
// requiring any surviving peer to write to the doc (a doc write costs
// a server round-trip + persists, an awareness update is fire-and-forget).
// Awareness is the right channel for this.

import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { LOCAL_ORIGIN } from '$lib/graph/store';

export const CARL_SESSION_MAP_KEY = 'carlSession';
export const CARL_LEADER_AWARENESS_FIELD = 'carlLeader';

export interface CarlSessionRecord {
  ownerUserId: string | null;
  ownerDisplayName: string;
  spawnedAt: number;
  seed: number;
  active: boolean;
}

export interface CarlLeaderInfo {
  /** Awareness clientID of the active leader, or null if no leader yet. */
  leaderClientId: number | null;
  /** Whether the LOCAL tab is currently the leader. */
  isLocalLeader: boolean;
  /** All peer clientIDs currently in the election pool. */
  candidates: number[];
}

export function getCarlSessionMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(CARL_SESSION_MAP_KEY);
}

export function readCarlSession(ydoc: Y.Doc): CarlSessionRecord | null {
  const m = getCarlSessionMap(ydoc);
  if (m.get('active') !== true) return null;
  return {
    ownerUserId: (m.get('ownerUserId') as string | null) ?? null,
    ownerDisplayName: (m.get('ownerDisplayName') as string) ?? '(unknown)',
    spawnedAt: (m.get('spawnedAt') as number) ?? 0,
    seed: (m.get('seed') as number) ?? 0,
    active: true,
  };
}

/**
 * Attempt to claim the Carl session. Returns true if THIS caller's write
 * landed (active flipped false→true with our userId).
 *
 * Race resolution: Yjs's deterministic merge picks one writer when two
 * clients call attemptSpawn at the exact same moment. The caller should
 * re-read after sync to confirm — for the common case the synchronous
 * return is correct.
 */
export function attemptSpawn(
  ydoc: Y.Doc,
  record: Omit<CarlSessionRecord, 'active'>,
): boolean {
  const m = getCarlSessionMap(ydoc);
  if (m.get('active') === true) return false;
  ydoc.transact(() => {
    m.set('ownerUserId', record.ownerUserId);
    m.set('ownerDisplayName', record.ownerDisplayName);
    m.set('spawnedAt', record.spawnedAt);
    m.set('seed', record.seed);
    m.set('active', true);
  }, LOCAL_ORIGIN);
  return true;
}

/**
 * Flip the session inactive. Anyone connected to the rack can call this
 * (we don't gate on userId because the UX rule is "any participant can
 * 86 Carl" — disagreements are a social problem, not a code one).
 */
export function clearSession(ydoc: Y.Doc): void {
  const m = getCarlSessionMap(ydoc);
  ydoc.transact(() => {
    m.set('active', false);
    m.delete('ownerUserId');
    m.delete('ownerDisplayName');
    m.delete('spawnedAt');
    m.delete('seed');
  }, LOCAL_ORIGIN);
}

export function observeSession(
  ydoc: Y.Doc,
  onChange: (record: CarlSessionRecord | null) => void,
): () => void {
  const m = getCarlSessionMap(ydoc);
  const handler = () => onChange(readCarlSession(ydoc));
  m.observe(handler);
  onChange(readCarlSession(ydoc));
  return () => m.unobserve(handler);
}

// ---------------- Leader election ----------------

interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  getLocalState(): Record<string, unknown> | null;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change' | 'update', handler: () => void): void;
  off(event: 'change' | 'update', handler: () => void): void;
}

/**
 * Publish a leader-candidacy heartbeat into Y.Awareness. All connected
 * tabs publish; the election picker is pure (lowest clientId in the
 * candidate set wins). Heartbeat exists so peers can SEE us in the
 * candidate pool without us touching the doc.
 */
export function publishLeaderCandidacy(awareness: AwarenessLike): void {
  awareness.setLocalStateField(CARL_LEADER_AWARENESS_FIELD, {
    clientId: awareness.clientID,
    since: Date.now(),
  });
}

/** Stop participating in leader election (call when 86ing carl). */
export function withdrawLeaderCandidacy(awareness: AwarenessLike): void {
  awareness.setLocalStateField(CARL_LEADER_AWARENESS_FIELD, null);
}

/**
 * Compute the current leader from awareness state. Pure; given the same
 * input, every peer computes the same answer.
 *
 * Rule: the leader is the peer with the LOWEST clientID among all peers
 * whose state has a non-null carlLeader field. Ties impossible (clientId
 * is unique per Y.Awareness instance).
 */
export function computeLeader(
  awareness: AwarenessLike,
): CarlLeaderInfo {
  const candidates: number[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    const tag = (state as Record<string, unknown>)[CARL_LEADER_AWARENESS_FIELD];
    if (tag) candidates.push(clientId);
  }
  candidates.sort((a, b) => a - b);
  const leaderClientId = candidates.length > 0 ? candidates[0]! : null;
  return {
    leaderClientId,
    isLocalLeader:
      leaderClientId !== null && leaderClientId === awareness.clientID,
    candidates,
  };
}

/**
 * Subscribe to leader changes. The handler fires on every awareness
 * `change` event AND once immediately at attach time. Returns a
 * teardown function.
 *
 * Implementation note: we don't bother coalescing rapid updates — Yjs
 * batches change events naturally, and the handler is cheap.
 */
export function observeLeader(
  provider: HocuspocusProvider | null | undefined,
  onChange: (info: CarlLeaderInfo) => void,
): () => void {
  const awareness = provider?.awareness as unknown as AwarenessLike | null | undefined;
  if (!awareness) {
    onChange({ leaderClientId: null, isLocalLeader: false, candidates: [] });
    return () => {};
  }
  const fire = () => onChange(computeLeader(awareness));
  awareness.on('change', fire);
  awareness.on('update', fire);
  fire();
  return () => {
    awareness.off('change', fire);
    awareness.off('update', fire);
  };
}

/**
 * Convenience: read leader info synchronously. Useful for one-shot
 * tests + initial-render decisions.
 */
export function readLeader(
  provider: HocuspocusProvider | null | undefined,
): CarlLeaderInfo {
  const awareness = provider?.awareness as unknown as AwarenessLike | null | undefined;
  if (!awareness) {
    return { leaderClientId: null, isLocalLeader: false, candidates: [] };
  }
  return computeLeader(awareness);
}
