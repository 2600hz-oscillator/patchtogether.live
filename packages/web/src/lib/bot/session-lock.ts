// packages/web/src/lib/bot/session-lock.ts
//
// Generalized "one bot per rackspace" lock. Used by both Rackspace Carl and
// Meticulous Mike (and any future patch-monkey bot) to enforce mutual
// exclusion: at most ONE bot of any kind may be active in a rackspace at a
// time.
//
// Layered on top of (not replacing) Carl's per-bot `carlSession` Y.Map:
//
//   - Carl continues to write his existing `carlSession` record so legacy
//     readers (PR #178 test suite + the rackspace UI's per-bot indicator)
//     keep working unchanged.
//   - In addition, BOTH Carl and Mike write a single `botSession` Y.Map
//     with a `kind` discriminator. This is the canonical exclusivity
//     check: `attemptBotSpawn` refuses if a record of a DIFFERENT kind
//     is already active.
//
// Migration / back-compat:
//   - `readBotSession` falls back to reading the legacy `carlSession`
//     map if no `botSession` exists yet (so a doc populated by an
//     older client that only knew about Carl is still treated as having
//     an active Carl bot for exclusivity purposes).
//   - `clearBotSession` always clears `botSession`; Carl's UI also
//     clears the legacy `carlSession` map alongside this (the calling
//     code in `+page.svelte` retains that responsibility — we don't
//     reach across bot boundaries from inside this helper).
//
// All writes use the same LOCAL_ORIGIN as Carl so the writes flow through
// the same UndoManager-tracked path the user takes when patching.

import type * as Y from 'yjs';
import { LOCAL_ORIGIN } from '$lib/graph/store';

/** Yjs map key for the shared bot lock. Keep stable across versions. */
export const BOT_SESSION_MAP_KEY = 'botSession';

/** Yjs map key for Carl's pre-existing session record. We read this as a
 *  fallback so docs written by old clients still produce an active record
 *  for the exclusivity gate. */
export const LEGACY_CARL_SESSION_MAP_KEY = 'carlSession';

export type BotKind = 'carl' | 'mike';

export interface BotSessionRecord {
  kind: BotKind;
  ownerUserId: string | null;
  ownerDisplayName: string;
  spawnedAt: number;
  seed: number;
  active: boolean;
}

export function getBotSessionMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(BOT_SESSION_MAP_KEY);
}

function getLegacyCarlMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(LEGACY_CARL_SESSION_MAP_KEY);
}

/**
 * Read the active bot session, if any. Falls back to the legacy `carlSession`
 * Y.Map (treated as a Carl record) when no entry exists in `botSession`.
 * Returns null when no bot is active in either location.
 */
export function readBotSession(ydoc: Y.Doc): BotSessionRecord | null {
  const m = getBotSessionMap(ydoc);
  if (m.get('active') === true) {
    return {
      kind: (m.get('kind') as BotKind) ?? 'carl',
      ownerUserId: (m.get('ownerUserId') as string | null) ?? null,
      ownerDisplayName: (m.get('ownerDisplayName') as string) ?? '(unknown)',
      spawnedAt: (m.get('spawnedAt') as number) ?? 0,
      seed: (m.get('seed') as number) ?? 0,
      active: true,
    };
  }
  // Legacy fallback: a doc written by a pre-bot-lock Carl will have an
  // active `carlSession` map but no `botSession`. Treat it as Carl.
  const legacy = getLegacyCarlMap(ydoc);
  if (legacy.get('active') === true) {
    return {
      kind: 'carl',
      ownerUserId: (legacy.get('ownerUserId') as string | null) ?? null,
      ownerDisplayName: (legacy.get('ownerDisplayName') as string) ?? '(unknown)',
      spawnedAt: (legacy.get('spawnedAt') as number) ?? 0,
      seed: (legacy.get('seed') as number) ?? 0,
      active: true,
    };
  }
  return null;
}

/**
 * Attempt to claim the bot lock for a given kind. Returns true if the
 * write landed (no other bot active OR the active bot is the SAME kind —
 * idempotent re-spawn). Returns false if a DIFFERENT-kind bot already
 * holds the lock.
 *
 * Yjs's deterministic merge picks one writer on simultaneous spawns from
 * different peers, so the synchronous return value is correct for the
 * common case. Callers that care about the post-sync truth should re-read
 * via `readBotSession` after the next provider sync round-trip.
 */
export function attemptBotSpawn(
  ydoc: Y.Doc,
  record: Omit<BotSessionRecord, 'active'>,
): boolean {
  const current = readBotSession(ydoc);
  if (current?.active && current.kind !== record.kind) return false;
  const m = getBotSessionMap(ydoc);
  ydoc.transact(() => {
    m.set('kind', record.kind);
    m.set('ownerUserId', record.ownerUserId);
    m.set('ownerDisplayName', record.ownerDisplayName);
    m.set('spawnedAt', record.spawnedAt);
    m.set('seed', record.seed);
    m.set('active', true);
  }, LOCAL_ORIGIN);
  return true;
}

/**
 * Flip the shared bot session inactive. Anyone in the rack can call this.
 * Note: callers responsible for clearing the LEGACY per-bot map (e.g.
 * `carlSession`) are expected to do that alongside this call when the
 * cleared bot is Carl. Mike has no legacy map.
 */
export function clearBotSession(ydoc: Y.Doc): void {
  const m = getBotSessionMap(ydoc);
  ydoc.transact(() => {
    m.set('active', false);
    m.delete('kind');
    m.delete('ownerUserId');
    m.delete('ownerDisplayName');
    m.delete('spawnedAt');
    m.delete('seed');
  }, LOCAL_ORIGIN);
}

/**
 * Subscribe to bot-session changes. Fires once immediately with the
 * current value, then on every Y.Map change (including legacy carlSession
 * mutations so a legacy-only Carl spawn lights up Mike's "disabled" UI).
 */
export function observeBotSession(
  ydoc: Y.Doc,
  onChange: (record: BotSessionRecord | null) => void,
): () => void {
  const bot = getBotSessionMap(ydoc);
  const legacy = getLegacyCarlMap(ydoc);
  const handler = () => onChange(readBotSession(ydoc));
  bot.observe(handler);
  legacy.observe(handler);
  onChange(readBotSession(ydoc));
  return () => {
    bot.unobserve(handler);
    legacy.unobserve(handler);
  };
}
