// packages/web/src/lib/carl/session-ephemeral.ts
//
// Approach A — "Ephemeral Carl" exclusivity.
//
// Carl session is a single record in a dedicated Y.Map ('carlSession'):
//
//   {
//     ownerUserId: string,    // Clerk userId who spawned him
//     ownerDisplayName: string,
//     spawnedAt: number,      // ms epoch
//     seed: number,           // for replayability
//   }
//
// "Whoever wins the CRDT transaction holds the lock" — Yjs guarantees
// that one writer's `set` survives a concurrent write (the conflict
// resolution is deterministic across all replicas). We don't need a
// separate consensus layer.
//
// The tick loop runs in the OWNER's browser tab. If the owner closes
// the tab or loses their connection:
//   - the spawner's session record stays in the Y.Doc (it's a persisted
//     CRDT write, not awareness ephemera)
//   - other peers SEE that the spawner's awareness presence has gone
//     (Y.Awareness 30s timeout)
//   - the UI surfaces a "Carl is orphaned — 86 him?" affordance to
//     anyone (including non-spawners)
//
// This is the simple model. Trade-off: closing the tab silently kills
// Carl from the perspective of the rack (no more ticks) until someone
// clears the session. Pair this with approach B if you want auto-
// migration.

import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { LOCAL_ORIGIN } from '$lib/graph/store';

export const CARL_SESSION_MAP_KEY = 'carlSession';
export const CARL_OWNER_CLIENT_FIELD = 'carlOwnerClientId';

export interface CarlSessionRecord {
  /** Clerk userId of the spawner. null only in tests (no Clerk in /). */
  ownerUserId: string | null;
  /** Display name (Clerk fullName / username / email-localpart). */
  ownerDisplayName: string;
  /** Wall-clock spawn time, ms epoch. */
  spawnedAt: number;
  /** Personality seed (so the run can be replayed). */
  seed: number;
}

export function getCarlSessionMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(CARL_SESSION_MAP_KEY);
}

/** Read the current session, or null if no Carl is active. */
export function readCarlSession(ydoc: Y.Doc): CarlSessionRecord | null {
  const m = getCarlSessionMap(ydoc);
  const owner = m.get('ownerUserId');
  if (owner === undefined) return null;
  return {
    ownerUserId: (owner as string | null) ?? null,
    ownerDisplayName: (m.get('ownerDisplayName') as string) ?? '(unknown)',
    spawnedAt: (m.get('spawnedAt') as number) ?? 0,
    seed: (m.get('seed') as number) ?? 0,
  };
}

/**
 * Attempt to claim the Carl lock. Returns true if THIS caller's write
 * landed (i.e. they're the owner). Returns false if someone else got in
 * first or the record already exists.
 *
 * Yjs makes this race-free: even if two clients call attemptSpawn at
 * the exact same wall-clock moment, only ONE of the writes will survive
 * the eventual merge (the conflict resolution is deterministic). Both
 * clients see the same winner after the next sync round-trip.
 *
 * The caller MUST re-read the session AFTER syncing (e.g. via the next
 * `carlSession.observe` tick) to confirm they actually won, but for the
 * common single-user case the synchronous return is correct.
 */
export function attemptSpawn(
  ydoc: Y.Doc,
  record: CarlSessionRecord,
): boolean {
  const m = getCarlSessionMap(ydoc);
  if (m.get('ownerUserId') !== undefined) {
    // Already occupied — refuse locally. (A concurrent remote write may
    // still win; the caller reconciles via observe.)
    return false;
  }
  ydoc.transact(() => {
    m.set('ownerUserId', record.ownerUserId);
    m.set('ownerDisplayName', record.ownerDisplayName);
    m.set('spawnedAt', record.spawnedAt);
    m.set('seed', record.seed);
  }, LOCAL_ORIGIN);
  return true;
}

/** Clear the Carl session. Anyone can call this (UI may gate it). */
export function clearSession(ydoc: Y.Doc): void {
  const m = getCarlSessionMap(ydoc);
  ydoc.transact(() => {
    m.delete('ownerUserId');
    m.delete('ownerDisplayName');
    m.delete('spawnedAt');
    m.delete('seed');
  }, LOCAL_ORIGIN);
}

/**
 * Subscribe to session changes. Returns a teardown function.
 */
export function observeSession(
  ydoc: Y.Doc,
  onChange: (record: CarlSessionRecord | null) => void,
): () => void {
  const m = getCarlSessionMap(ydoc);
  const handler = () => onChange(readCarlSession(ydoc));
  m.observe(handler);
  // Fire once immediately so the caller sees the current state.
  onChange(readCarlSession(ydoc));
  return () => m.unobserve(handler);
}

/**
 * Approach A: the owner publishes their clientID into the session map so
 * other clients can detect "the spawner has dropped off awareness" and
 * surface a force-86 affordance. Optional — the UI may instead allow
 * anyone to 86 unconditionally.
 */
export function publishOwnerClientId(
  ydoc: Y.Doc,
  clientId: number,
): void {
  const m = getCarlSessionMap(ydoc);
  ydoc.transact(() => {
    m.set(CARL_OWNER_CLIENT_FIELD, clientId);
  }, LOCAL_ORIGIN);
}

/**
 * Returns true if the session has an ownerClientId field AND no peer
 * with that clientId is currently in Y.Awareness — i.e. the owner has
 * almost certainly closed their tab or lost connection.
 *
 * 30s grace period: Y.Awareness GCs disconnected peers after ~30s by
 * default. We trust that; callers should not call this until at least
 * one observe tick after spawn.
 */
export function isOrphaned(
  ydoc: Y.Doc,
  provider: HocuspocusProvider | null,
): boolean {
  if (!provider?.awareness) return false;
  const m = getCarlSessionMap(ydoc);
  const ownerClientId = m.get(CARL_OWNER_CLIENT_FIELD) as number | undefined;
  if (ownerClientId === undefined) return false;
  const states = provider.awareness.getStates();
  return !states.has(ownerClientId);
}
