// packages/web/src/lib/mike/session-leader-elected.ts
//
// Mike's session API. The leader-election infrastructure (awareness
// candidacy + lowest-clientID-wins) is reused from Carl's session
// module — election picks ONE tab to tick the bot, independent of
// which bot is active. The session record itself uses the shared bot
// lock so Carl and Mike are mutually exclusive within a rackspace.
//
// We deliberately keep a separate awareness field for Mike's
// candidacy (vs reusing Carl's `carlLeader` field) so peers can tell
// "is THIS tab a candidate to tick Mike?" without inferring it from
// the global bot kind. Net effect: if Mike's session is active, peers
// publish to `mikeLeader`; if Carl's is active, peers publish to
// `carlLeader`. Both fields use the same lowest-clientID semantics.

import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  attemptBotSpawn,
  clearBotSession,
  observeBotSession,
  readBotSession,
  type BotSessionRecord,
} from '$lib/bot/session-lock';

export const MIKE_LEADER_AWARENESS_FIELD = 'mikeLeader';

export interface MikeSessionRecord {
  ownerUserId: string | null;
  ownerDisplayName: string;
  spawnedAt: number;
  seed: number;
  active: boolean;
}

export interface MikeLeaderInfo {
  leaderClientId: number | null;
  isLocalLeader: boolean;
  candidates: number[];
}

interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  getLocalState(): Record<string, unknown> | null;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change' | 'update', handler: () => void): void;
  off(event: 'change' | 'update', handler: () => void): void;
}

/** Read Mike's active session — only returns non-null when the bot
 *  lock holds an active Mike record. */
export function readMikeSession(ydoc: Y.Doc): MikeSessionRecord | null {
  const rec = readBotSession(ydoc);
  if (!rec || !rec.active || rec.kind !== 'mike') return null;
  return {
    ownerUserId: rec.ownerUserId,
    ownerDisplayName: rec.ownerDisplayName,
    spawnedAt: rec.spawnedAt,
    seed: rec.seed,
    active: true,
  };
}

/**
 * Attempt to claim the bot lock for Mike. Returns false if a different
 * bot (Carl) is already active in the rackspace.
 */
export function attemptSpawn(
  ydoc: Y.Doc,
  record: Omit<MikeSessionRecord, 'active'>,
): boolean {
  return attemptBotSpawn(ydoc, {
    kind: 'mike',
    ownerUserId: record.ownerUserId,
    ownerDisplayName: record.ownerDisplayName,
    spawnedAt: record.spawnedAt,
    seed: record.seed,
  });
}

/** Release the bot lock if THIS bot is Mike. No-op otherwise. */
export function clearSession(ydoc: Y.Doc): void {
  const rec = readBotSession(ydoc);
  if (rec?.kind !== 'mike') return;
  clearBotSession(ydoc);
}

/**
 * Subscribe to Mike-session changes. Wraps `observeBotSession` and
 * filters to just the Mike record (so a Carl spawn doesn't fire
 * Mike's onChange with a non-null value).
 */
export function observeSession(
  ydoc: Y.Doc,
  onChange: (record: MikeSessionRecord | null) => void,
): () => void {
  return observeBotSession(ydoc, (rec: BotSessionRecord | null) => {
    if (!rec || !rec.active || rec.kind !== 'mike') {
      onChange(null);
      return;
    }
    onChange({
      ownerUserId: rec.ownerUserId,
      ownerDisplayName: rec.ownerDisplayName,
      spawnedAt: rec.spawnedAt,
      seed: rec.seed,
      active: true,
    });
  });
}

// ---------------- Leader election ----------------

export function publishLeaderCandidacy(awareness: AwarenessLike): void {
  awareness.setLocalStateField(MIKE_LEADER_AWARENESS_FIELD, {
    clientId: awareness.clientID,
    since: Date.now(),
  });
}

export function withdrawLeaderCandidacy(awareness: AwarenessLike): void {
  awareness.setLocalStateField(MIKE_LEADER_AWARENESS_FIELD, null);
}

export function computeLeader(awareness: AwarenessLike): MikeLeaderInfo {
  const candidates: number[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    const tag = (state as Record<string, unknown>)[MIKE_LEADER_AWARENESS_FIELD];
    if (tag) candidates.push(clientId);
  }
  candidates.sort((a, b) => a - b);
  const leaderClientId = candidates.length > 0 ? candidates[0]! : null;
  return {
    leaderClientId,
    isLocalLeader: leaderClientId !== null && leaderClientId === awareness.clientID,
    candidates,
  };
}

export function observeLeader(
  provider: HocuspocusProvider | null | undefined,
  onChange: (info: MikeLeaderInfo) => void,
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

export function readLeader(
  provider: HocuspocusProvider | null | undefined,
): MikeLeaderInfo {
  const awareness = provider?.awareness as unknown as AwarenessLike | null | undefined;
  if (!awareness) {
    return { leaderClientId: null, isLocalLeader: false, candidates: [] };
  }
  return computeLeader(awareness);
}
