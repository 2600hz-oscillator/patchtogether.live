// Presence resolution + awareness helpers (Stage B PR B-c).
//
// Maps a userId (or anon-tab UUID) to a stable displayName + color used as
// the visible identity in cursor / dot / rack-bar rendering. Authed users
// pull their displayName from the Clerk session; anon users get a "guest
// 1234" name. Color is a deterministic hash of the userId so the same user
// always renders the same hue across sessions and across collaborators'
// screens.
//
// The Awareness wire format is one object with at least `{ user, cursor }`
// fields: `user` is set once on attach and stays for the session; `cursor`
// is updated at ~30 Hz from pointer-move handlers. Y.Awareness handles the
// actual broadcast + GC of disconnected peers (30s timeout).

import type { HocuspocusProvider } from '@hocuspocus/provider';

export interface PresenceUser {
  id: string;
  displayName: string;
  color: string;
  /** True when this user OWNS the rackspace. Published in awareness so
   *  per-module logic that needs an authoritative arbiter (e.g. the DOOM
   *  host / player-0 election in DoomCard) can prefer the rack owner over a
   *  lex-min tiebreak. Absent / false for guests + anon members. */
  isRackOwner?: boolean;
}

export interface CursorPos {
  x: number;
  y: number;
}

export interface AwarenessUserState {
  user: PresenceUser;
  cursor?: CursorPos;
}

const PRESENCE_PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#d946ef',
  '#ec4899',
] as const;

function fnv1a(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function colorForUserId(userId: string): string {
  const idx = fnv1a(userId) % PRESENCE_PALETTE.length;
  return PRESENCE_PALETTE[idx];
}

export function anonGuestName(userId: string): string {
  const num = fnv1a(userId) % 10000;
  return `guest ${num.toString().padStart(4, '0')}`;
}

export interface ResolvePresenceInput {
  userId: string | null | undefined;
  displayName?: string | null;
  isAnon: boolean;
  /** True when this user owns the rackspace (authed owner only — anon
   *  members can never be the owner). Threaded into the published presence
   *  `user.isRackOwner` flag. */
  isRackOwner?: boolean;
}

export function resolvePresenceUser(input: ResolvePresenceInput): PresenceUser {
  if (input.isAnon || !input.userId) {
    const id = input.userId ?? `anon-${cryptoRandomId()}`;
    return {
      id,
      displayName: anonGuestName(id),
      color: colorForUserId(id),
    };
  }
  const trimmed = (input.displayName ?? '').trim();
  return {
    id: input.userId,
    displayName: trimmed.length > 0 ? trimmed : input.userId.slice(0, 8),
    color: colorForUserId(input.userId),
    isRackOwner: input.isRackOwner === true,
  };
}

function cryptoRandomId(): string {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2, 14);
}

const ANON_TAB_KEY = 'pt:anon-tab-id';

export function getOrCreateAnonTabId(): string {
  try {
    const ss = (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
    if (ss) {
      const existing = ss.getItem(ANON_TAB_KEY);
      if (existing) return existing;
      const fresh = `anon-${cryptoRandomId()}`;
      ss.setItem(ANON_TAB_KEY, fresh);
      return fresh;
    }
  } catch {
    /* sessionStorage may throw in private mode; fall through */
  }
  return `anon-${cryptoRandomId()}`;
}

export interface InitAwarenessOptions {
  provider: HocuspocusProvider;
  user: PresenceUser;
}

export function initAwareness(opts: InitAwarenessOptions): () => void {
  const { provider, user } = opts;
  const awareness = provider.awareness;
  if (!awareness) return () => {};
  awareness.setLocalStateField('user', user);
  return () => {
    try {
      awareness.setLocalState(null);
    } catch {
      /* provider may already be torn down */
    }
  };
}

export interface RemotePresence {
  clientId: number;
  user: PresenceUser;
  cursor?: CursorPos;
}

export function readRemotePresence(
  awareness: import('y-protocols/awareness').Awareness | null | undefined,
  localClientId: number,
): RemotePresence[] {
  if (!awareness) return [];
  const out: RemotePresence[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === localClientId) continue;
    const s = state as Partial<AwarenessUserState> | undefined;
    if (!s || !s.user) continue;
    out.push({ clientId, user: s.user, cursor: s.cursor });
  }
  return out;
}

/**
 * Collapse a list of raw awareness presences into one entry PER DISTINCT
 * user.id. Awareness has one state per connected tab (clientId), so a single
 * user with two tabs open shows up twice in the raw list — and an authed
 * member is NOT counted in the server's `memberUserIds` (DB) source if they
 * joined anonymously via an invite link. This is the single source of truth
 * for BOTH the presence dots and the "N/4 members" count: the count is always
 * exactly `distinctPresentUsers(...).length`, so the number can never disagree
 * with the number of dots rendered.
 *
 * De-dup rule: first-seen wins, keyed by `user.id` (Clerk userId for authed
 * users, the stable anon-tab UUID for guests). Iteration order of
 * `awareness.getStates()` is insertion order, so the earliest-connected tab's
 * presence (color/name) is the one kept.
 */
export function distinctPresentUsers(presences: RemotePresence[]): PresenceUser[] {
  const seen = new Set<string>();
  const out: PresenceUser[] = [];
  for (const p of presences) {
    const user = p?.user;
    if (!user || !user.id) continue;
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    out.push(user);
  }
  return out;
}

/**
 * Number of DISTINCT present users (de-duped by user.id). Multi-tab users
 * count once; anon-via-invite participants are included because they publish
 * awareness like anyone else. Optionally capped (e.g. at the rackspace
 * 4-total member cap) so the display never exceeds "/cap".
 */
export function countDistinctPresentUsers(
  presences: RemotePresence[],
  cap?: number,
): number {
  const n = distinctPresentUsers(presences).length;
  if (typeof cap === 'number' && cap >= 0) return Math.min(n, cap);
  return n;
}
