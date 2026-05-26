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
 *  never alias the live Yjs object. Unknown / malformed input → empty.
 *
 *  `data.players` may be EITHER a nested object map ({"0":"alice"}) OR a JSON
 *  STRING of that map. The card stores it as a primitive-string leaf
 *  (node.data.players = JSON.stringify(roster)) because primitive-leaf writes
 *  on node.data sync reliably cross-context (cf. module-naming's
 *  node.data.name), whereas a freshly-added nested Y.Map does not always
 *  reach an already-synced remote peer. We accept both shapes so older
 *  object-form data + tests both decode. */
export function readRoster(data: unknown): DoomRoster {
  const out: DoomRoster = {};
  if (!data || typeof data !== 'object') return out;
  let players = (data as { players?: unknown }).players;
  if (typeof players === 'string') {
    try {
      players = JSON.parse(players) as unknown;
    } catch {
      return out;
    }
  }
  if (!players || typeof players !== 'object') return out;
  for (const [slot, uid] of Object.entries(players as Record<string, unknown>)) {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 0 || n >= MAX_DOOM_PLAYERS) continue;
    if (typeof uid !== 'string' || uid.length === 0) continue;
    out[String(n)] = uid;
  }
  return out;
}

/** Serialize a roster to the primitive-string leaf form stored at
 *  node.data.players. Sorted keys → deterministic string (so identical
 *  rosters produce identical leaves, avoiding redundant Yjs writes). */
export function serializeRoster(roster: DoomRoster): string {
  const sorted: DoomRoster = {};
  for (const k of Object.keys(roster).sort()) sorted[k] = roster[k]!;
  return JSON.stringify(sorted);
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
 * Arbiter-authoritative slot assignment (slice 4 — fixes the slice-3
 * clobber).
 *
 * ─ The slice-3 bug ─
 *   In slice 3 each peer claimed its own slot by READING node.data.players,
 *   running claimSlot() locally, and WRITING the result back. node.data is a
 *   last-write-wins primitive-string leaf, so two peers that join at the same
 *   time both read the same starting roster (say {}), both compute slot 0,
 *   and both write {"0": <self>} — the second write CLOBBERS the first with
 *   no Yjs conflict (it's a single string leaf, not a CRDT map). One joiner
 *   silently loses their slot.
 *
 * ─ The slice-4 fix ─
 *   Make the roster SINGLE-WRITER. A peer no longer writes the roster to
 *   join; it only sets an awareness "join-request" field. The ARBITER (the
 *   lex-min member — there is exactly one) observes the set of outstanding
 *   requests and assigns slots, writing the roster itself. Since only the
 *   arbiter ever writes node.data.players, concurrent requests can't clobber:
 *   the arbiter sees both requests and gives them DISTINCT slots in one
 *   deterministic pass.
 *
 *   `assignRequestedSlots` is that pass, expressed as a pure function so the
 *   unit suite can hammer it with concurrent-request batches. Given the
 *   current roster + the set of user ids requesting to join, it:
 *     - keeps everyone who already holds a slot (idempotent — a re-request
 *       from a joined player is a no-op),
 *     - assigns each NOT-yet-joined requester the lowest free slot, in
 *       lex-sorted requester order (deterministic across peers + stable),
 *     - stops at MAX_DOOM_PLAYERS (the 5th+ requester gets no slot — the
 *       card surfaces "game full" to them).
 *
 *   Lex-sorting the requesters means the assignment is identical regardless
 *   of the order awareness delivered the requests, so even if the arbiter
 *   runs this pass multiple times as requests trickle in, a given user always
 *   lands in the same slot.
 *
 * Returns a NEW roster (input never mutated) + whether anything changed +
 * the per-user assignment result (so the arbiter / tests can see who got
 * what, and who was rejected as full).
 */
/** Order a set of requesters deterministically for slot assignment: rack
 *  owner(s) first (lex-sorted among themselves), then everyone else lex-
 *  sorted. Pure; shared by both assignment passes so owner-first seating is
 *  consistent. */
function orderRequesters(uids: readonly string[], ownerIds: readonly string[]): string[] {
  const owners = uids.filter((u) => ownerIds.includes(u)).sort();
  const rest = uids.filter((u) => !ownerIds.includes(u)).sort();
  return [...owners, ...rest];
}

export interface SlotAssignment {
  roster: DoomRoster;
  changed: boolean;
  /** userId → assigned slot, for users that hold a slot after this pass
   *  (includes already-joined users + newly-assigned ones). */
  assigned: Record<string, number>;
  /** Requesters that could NOT be given a slot because the roster is full. */
  rejected: string[];
}

export function assignRequestedSlots(
  roster: DoomRoster,
  requesters: readonly string[],
  ownerIds: readonly string[] = [],
): SlotAssignment {
  const next: DoomRoster = { ...roster };
  let changed = false;
  const rejected: string[] = [];

  // Deduplicate + order so the assignment is deterministic across peers and
  // stable across repeated passes. The RACK OWNER (if requesting) is ordered
  // FIRST so it takes the lowest free slot — slot 0 / player 0 on a fresh
  // roster — matching "the rack host is player 0". Everyone else follows in
  // lex order. (Pre-fix this was pure lex order, so a guest whose id sorted
  // before the owner's grabbed slot 0 — the "guest seated as P1" bug.)
  const sortedNew = orderRequesters(
    [...new Set(requesters)]
      .filter((uid) => typeof uid === 'string' && uid.length > 0)
      .filter((uid) => slotForUser(next, uid) === null), // skip already-joined
    ownerIds,
  );

  for (const uid of sortedNew) {
    const slot = firstEmptySlot(next);
    if (slot === null) {
      rejected.push(uid);
      continue;
    }
    next[String(slot)] = uid;
    changed = true;
  }

  // Build the assignment map from the resulting roster.
  const assigned: Record<string, number> = {};
  for (const [slot, uid] of Object.entries(next)) {
    assigned[uid] = Number(slot);
  }

  return { roster: changed ? next : roster, changed, assigned, rejected };
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

// ────────────────────────────────────────────────────────────────────────
//  Slice 6: pending (late-join) vs active slots
// ────────────────────────────────────────────────────────────────────────
//
//   A peer that joins while a game is already in progress does NOT spawn into
//   the running map (DOOM has no mid-level join). It RESERVES a slot — so the
//   UI can show "joining as Player N next map" and the slot can't be
//   double-claimed — but that slot is PENDING: it does not count toward the
//   running game's numPlayers / live marines until the arbiter launches the
//   next map at intermission, at which point pending slots are PROMOTED to
//   active.
//
//   We model this as TWO sparse slot→userId maps on the node:
//     - `node.data.players` — the ACTIVE roster (drives numPlayers + the
//        playeringame[] live marines; same field + semantics as slices 3-5).
//     - `node.data.pending` — the PENDING roster (late joiners awaiting the
//        next map). Same DoomRoster shape, same string-leaf encoding.
//
//   The two maps share one slot-index space: a pending entry occupies a slot
//   index so a new active joiner (rare — joins during a level all go pending)
//   never lands on a slot a late joiner already reserved, and so the late
//   joiner keeps the SAME slot when promoted. `combinedRoster` is the union
//   used for slot-occupancy queries (firstEmptySlot / isFull); `assignSlots`
//   below routes a requester to the active OR pending map based on whether a
//   game is currently in progress.

/** A roster split into the slots that are live in the running game (active)
 *  and the slots reserved for late joiners who will spawn at the next map
 *  (pending). Both are the same sparse slot→userId shape; they never share a
 *  slot index (the assignment pass keeps them disjoint). */
export interface DoomRosterState {
  active: DoomRoster;
  pending: DoomRoster;
}

/** Read the pending roster off a node's `data` blob (the `pending` leaf).
 *  Same decoding rules as readRoster (string-or-object, normalized). */
export function readPending(data: unknown): DoomRoster {
  if (!data || typeof data !== 'object') return {};
  // Reuse readRoster's normalization by aliasing the `pending` field to the
  // `players` field it expects.
  const pending = (data as { pending?: unknown }).pending;
  return readRoster({ players: pending });
}

/** Read both rosters off a node's `data` blob in one call. */
export function readRosterState(data: unknown): DoomRosterState {
  return { active: readRoster(data), pending: readPending(data) };
}

/** Serialize the pending roster to the same primitive-string leaf form as
 *  serializeRoster (sorted keys → deterministic). */
export function serializePending(pending: DoomRoster): string {
  return serializeRoster(pending);
}

/** The union of active + pending as one occupancy map (active wins on the
 *  rare overlap, which the assignment pass prevents). Used for slot-occupancy
 *  queries so neither map double-assigns a slot the other already holds. */
export function combinedRoster(state: DoomRosterState): DoomRoster {
  return { ...state.pending, ...state.active };
}

/** The slot a user holds in EITHER map (active first), or null. */
export function slotForUserInState(
  state: DoomRosterState,
  userId: string,
): number | null {
  return slotForUser(combinedRoster(state), userId);
}

/** True if the user holds an ACTIVE slot (is a live player this game). */
export function isActivePlayer(state: DoomRosterState, userId: string): boolean {
  return slotForUser(state.active, userId) !== null;
}

/** True if the user holds a PENDING slot (a late joiner awaiting the next
 *  map). */
export function isPendingPlayer(state: DoomRosterState, userId: string): boolean {
  return slotForUser(state.pending, userId) !== null;
}

/** Rack members who are UNJOINED SPECTATORS — i.e. present in the rack but
 *  holding NEITHER an active nor a pending slot. `selfId` (the host asking) is
 *  always excluded: the host is a player, never its own spectator.
 *
 *  This is the gate for the host's ~10 Hz framebuffer broadcast. In the
 *  per-peer-WASM model every JOINED player (active OR pending late joiner) runs
 *  its own DOOM, so only a pure unjoined spectator needs the host's mirror.
 *  Broadcasting the ~1.37 MB base64 framebuffer at 10 Hz when NOBODY needs it
 *  pushed ~13.7 MB/s of awareness traffic through the single Hocuspocus relay
 *  process and OOM-killed it (→ rack freeze + lost-node-on-rejoin). Pure +
 *  order-stable so it is unit-testable without a provider. */
export function unjoinedSpectatorIds(
  state: DoomRosterState,
  memberIds: readonly string[],
  selfId: string,
): string[] {
  const seated = new Set(Object.values(combinedRoster(state)));
  const out: string[] = [];
  for (const uid of memberIds) {
    if (uid === selfId) continue;
    if (!seated.has(uid)) out.push(uid);
  }
  return out;
}

/** Convenience: does ANY current rack member need the host's framebuffer
 *  mirror (is an unjoined spectator)? See unjoinedSpectatorIds. */
export function hasUnjoinedSpectator(
  state: DoomRosterState,
  memberIds: readonly string[],
  selfId: string,
): boolean {
  return unjoinedSpectatorIds(state, memberIds, selfId).length > 0;
}

/** Result of a combined-state assignment pass: a NEW state (inputs never
 *  mutated) + whether each map changed + the per-user assignment (slot +
 *  whether it landed active or pending) + requesters rejected as full. */
export interface RosterStateAssignment {
  state: DoomRosterState;
  /** active or pending changed. */
  changed: boolean;
  /** userId → { slot, pending } for every user that holds a slot after the
   *  pass (active + pending). */
  assigned: Record<string, { slot: number; pending: boolean }>;
  rejected: string[];
}

/**
 * Slice 6 arbiter-authoritative assignment over the SPLIT (active + pending)
 * roster. Same single-writer / lex-sorted / cap-at-4 / idempotent contract as
 * assignRequestedSlots, extended with a `gameInProgress` flag that decides
 * which map a NEW requester lands in:
 *
 *   - gameInProgress === false  → new requesters go ACTIVE (they'll spawn at
 *     the next launch — pre-game lobby, or the next-map seating after
 *     promotion). This is the slices-3-5 behavior.
 *   - gameInProgress === true   → new requesters go PENDING (a level is
 *     running; they spectate until the arbiter launches the next map).
 *
 * Both maps share one slot space (combinedRoster occupancy), so a pending
 * late joiner reserves a distinct slot that no active joiner can take, and
 * keeps that same slot when promoted. Already-seated users (in either map)
 * are left in place (idempotent re-request). The cap is the COMBINED size.
 */
export function assignSlots(
  state: DoomRosterState,
  requesters: readonly string[],
  gameInProgress: boolean,
  ownerIds: readonly string[] = [],
): RosterStateAssignment {
  const active: DoomRoster = { ...state.active };
  const pending: DoomRoster = { ...state.pending };
  let changed = false;
  const rejected: string[] = [];

  // A combined occupancy view kept in sync as we assign, so firstEmptySlot
  // never hands out a slot already held in the other map.
  const occupancy: DoomRoster = { ...pending, ...active };

  // Owner-first ordering (see assignRequestedSlots): the rack owner takes the
  // lowest free slot — slot 0 / player 0 on a fresh roster — so the rack host
  // is player 0 regardless of where its user id sorts.
  const sortedNew = orderRequesters(
    [...new Set(requesters)]
      .filter((uid) => typeof uid === 'string' && uid.length > 0)
      // Skip anyone already seated in either map (idempotent).
      .filter((uid) => slotForUser(occupancy, uid) === null),
    ownerIds,
  );

  for (const uid of sortedNew) {
    const slot = firstEmptySlot(occupancy);
    if (slot === null) {
      rejected.push(uid);
      continue;
    }
    occupancy[String(slot)] = uid;
    if (gameInProgress) {
      pending[String(slot)] = uid;
    } else {
      active[String(slot)] = uid;
    }
    changed = true;
  }

  const assigned: Record<string, { slot: number; pending: boolean }> = {};
  for (const [slot, uid] of Object.entries(active)) {
    assigned[uid] = { slot: Number(slot), pending: false };
  }
  for (const [slot, uid] of Object.entries(pending)) {
    assigned[uid] = { slot: Number(slot), pending: true };
  }

  return {
    state: changed ? { active, pending } : state,
    changed,
    assigned,
    rejected,
  };
}

/**
 * Promote ALL pending slots to active. Called by the arbiter when it launches
 * the next map at intermission: every late joiner who reserved a pending slot
 * becomes a live player at the SAME slot index for the new level. Returns a
 * new state (inputs never mutated) + whether anything was promoted + the set
 * of promoted user ids (so the arbiter / tests can see who got seated).
 *
 * A pending slot whose index somehow collides with an existing active slot
 * (should never happen — assignSlots keeps them disjoint) is dropped rather
 * than clobbering the active occupant, so promotion can never evict a live
 * player.
 */
export interface RosterPromotion {
  state: DoomRosterState;
  changed: boolean;
  /** userIds moved from pending → active by this promotion. */
  promoted: string[];
}

export function promotePending(state: DoomRosterState): RosterPromotion {
  if (rosterSize(state.pending) === 0) {
    return { state, changed: false, promoted: [] };
  }
  const active: DoomRoster = { ...state.active };
  const promoted: string[] = [];
  for (const [slot, uid] of Object.entries(state.pending)) {
    if (active[slot] !== undefined && active[slot] !== uid) continue; // never evict
    if (active[slot] === uid) continue; // already active (defensive)
    active[slot] = uid;
    promoted.push(uid);
  }
  if (promoted.length === 0) {
    return { state, changed: false, promoted: [] };
  }
  return { state: { active, pending: {} }, changed: true, promoted };
}

/**
 * Prune BOTH maps against the live member set (disconnect cleanup), extending
 * pruneRoster to the split state. A late joiner who closes their tab before
 * the next map vacates their pending reservation too.
 */
export function pruneRosterState(
  state: DoomRosterState,
  liveUserIds: readonly string[],
): { state: DoomRosterState; changed: boolean } {
  const a = pruneRoster(state.active, liveUserIds);
  const p = pruneRoster(state.pending, liveUserIds);
  if (!a.changed && !p.changed) return { state, changed: false };
  return { state: { active: a.roster, pending: p.roster }, changed: true };
}
