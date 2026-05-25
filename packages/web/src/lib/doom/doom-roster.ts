// packages/web/src/lib/doom/doom-roster.ts
//
// Slice 3 of the DOOM true-4-player plan: the joined-player roster.
//
// ────────────────────────────────────────────────────────────────────────
//  The committed instance model (one node, N runtimes)
// ────────────────────────────────────────────────────────────────────────
//   There is exactly ONE DOOM node per rack (the host spawns it; other
//   peers do NOT spawn their own — they see the shared node via Yjs sync).
//   The node is shared state. The WASM is per-peer: each JOINED player
//   runs their OWN DoomRuntime bound to that one shared node, which is what
//   gives every player their own first-person POV.
//
//   "Who is playing, and in which slot" is the only piece of multiplayer
//   state that has to be shared, so it lives on the node itself —
//   `node.data.players` — and rides the existing Yjs node sync (no extra
//   awareness field, no separate doc). A peer is a "player" iff their
//   userId appears in the roster; otherwise they are a spectator/unjoined.
//
// ────────────────────────────────────────────────────────────────────────
//  Roster shape + slot semantics
// ────────────────────────────────────────────────────────────────────────
//   `node.data.players` is a sparse map of slot-index → userId:
//
//       { "0": "aaa-host", "1": "bbb-guest" }
//
//   Slots are stable for the lifetime of an entry (DOOM semantics: a player
//   "owns" slot i until they release it; we never reshuffle a live player to
//   a lower slot when an earlier one frees up). Claiming takes the FIRST
//   empty slot (lowest index), which — combined with the lex-stable join
//   order — gives a deterministic assignment across peers without
//   negotiation. The cap is MAX_DOOM_PLAYERS (4 = rack cap).
//
//   These are PURE functions over a plain roster object so the unit suite
//   can exercise claim/release/cap logic with no Yjs, no WASM, no DOM. The
//   card + arbiter call them and write the result back into `node.data`.

/** Hard cap on simultaneous DOOM players, matching the per-rack 4-user cap
 *  (owner + 3 others). DOOM's MAXPLAYERS is also 4, so this lines up with
 *  the engine's slot space exactly. */
export const MAX_DOOM_PLAYERS = 4;

/** The roster as stored at `node.data.players`. Sparse slot-index → userId.
 *  Keys are stringified ints (Yjs/JSON object keys are strings); helpers
 *  normalize on read. */
export type DoomRoster = Record<string, string>;

/** Read a roster off a node's `data` blob, defensively. Returns a fresh
 *  normalized copy (string-keyed, only valid string userIds kept) so callers
 *  never alias the live Yjs object. Unknown / malformed input → empty. */
export function readRoster(data: unknown): DoomRoster {
  const out: DoomRoster = {};
  if (!data || typeof data !== 'object') return out;
  const players = (data as { players?: unknown }).players;
  if (!players || typeof players !== 'object') return out;
  for (const [slot, uid] of Object.entries(players as Record<string, unknown>)) {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 0 || n >= MAX_DOOM_PLAYERS) continue;
    if (typeof uid !== 'string' || uid.length === 0) continue;
    out[String(n)] = uid;
  }
  return out;
}

/** The slot index a user currently holds in `roster`, or null if unjoined. */
export function slotForUser(roster: DoomRoster, userId: string): number | null {
  for (const [slot, uid] of Object.entries(roster)) {
    if (uid === userId) return Number(slot);
  }
  return null;
}

/** True if `userId` holds a slot (i.e. is a joined player, not a spectator). */
export function isPlayer(roster: DoomRoster, userId: string): boolean {
  return slotForUser(roster, userId) !== null;
}

/** The set of joined user ids (order undefined; callers that need a stable
 *  order should sort or iterate slots). */
export function rosterUsers(roster: DoomRoster): string[] {
  return Object.values(roster);
}

/** Number of occupied slots. */
export function rosterSize(roster: DoomRoster): number {
  return Object.keys(roster).length;
}

/** True if every slot is taken (no room to join). */
export function isFull(roster: DoomRoster): boolean {
  return rosterSize(roster) >= MAX_DOOM_PLAYERS;
}

/** The lowest empty slot index in [0, MAX_DOOM_PLAYERS), or null if full. */
export function firstEmptySlot(roster: DoomRoster): number | null {
  for (let i = 0; i < MAX_DOOM_PLAYERS; i++) {
    if (!(String(i) in roster)) return i;
  }
  return null;
}

/** Result of a claim/release: a NEW roster object (inputs are never
 *  mutated) plus whether the operation changed anything + the affected
 *  slot. `changed: false` means the roster is returned untouched (e.g. the
 *  user already held a slot, or the roster was full). */
export interface RosterMutation {
  roster: DoomRoster;
  changed: boolean;
  slot: number | null;
}

/**
 * Claim the first empty slot for `userId`. Idempotent: if the user already
 * holds a slot, returns it unchanged (changed=false). If the roster is full
 * (and the user isn't already in it), returns the roster unchanged with
 * slot=null. Otherwise returns a new roster with the user added to the
 * lowest free slot.
 */
export function claimSlot(roster: DoomRoster, userId: string): RosterMutation {
  const existing = slotForUser(roster, userId);
  if (existing !== null) {
    return { roster, changed: false, slot: existing };
  }
  const slot = firstEmptySlot(roster);
  if (slot === null) {
    return { roster, changed: false, slot: null };
  }
  return {
    roster: { ...roster, [String(slot)]: userId },
    changed: true,
    slot,
  };
}

/**
 * Release whatever slot `userId` holds. Idempotent: if the user holds no
 * slot, returns the roster unchanged (changed=false). Otherwise returns a
 * new roster with that user's slot removed.
 */
export function releaseSlot(roster: DoomRoster, userId: string): RosterMutation {
  const slot = slotForUser(roster, userId);
  if (slot === null) {
    return { roster, changed: false, slot: null };
  }
  const next: DoomRoster = { ...roster };
  delete next[String(slot)];
  return { roster: next, changed: true, slot };
}

/**
 * Arbiter-side roster reconciliation. Given the current roster and the set
 * of user ids that are still live in the rack (from awareness), drop any
 * roster entries whose user has disconnected. Used by the arbiter on
 * awareness churn so a player who closes their tab vacates their slot (the
 * "leave by disconnect" path — there is no Leave button by decision).
 *
 * Pure: returns a new roster + whether anything was pruned.
 */
export function pruneRoster(
  roster: DoomRoster,
  liveUserIds: readonly string[],
): RosterMutation {
  const live = new Set(liveUserIds);
  const next: DoomRoster = {};
  let changed = false;
  for (const [slot, uid] of Object.entries(roster)) {
    if (live.has(uid)) {
      next[slot] = uid;
    } else {
      changed = true;
    }
  }
  return { roster: changed ? next : roster, changed, slot: null };
}
