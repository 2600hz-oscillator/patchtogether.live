// packages/web/src/lib/doom/doom-host-authority.ts
//
// DETERMINISTIC, split-brain-PROOF host/arbiter authority for the DOOM
// multiplayer card — and the reusable pattern for any "one authoritative
// peer per rackspace" feature.
//
// ── The bug this replaces ─────────────────────────────────────────────────
//
// The old election COUNTED awareness: each peer read the live member set out
// of awareness, ran a tiebreak (lex-min, with the rack owner preferred), and
// elected a host. That is correct ONLY when every peer sees the same complete
// awareness set. But presence/awareness can be momentarily empty or partial
// (a fresh connect before backfill, a relay restart that wiped in-memory
// awareness, a peer that hasn't received the others' states yet). When a peer
// sees ONLY ITSELF, the lex-min/owner tiebreak resolves to ITSELF — so BOTH
// browsers in a 2-user rack each elect themselves host. That is the DOOM
// "two P1s / split-brain" the operator hit live.
//
// ── The fix: authority from RELIABLE local identity, not awareness counting ─
//
// A client knows ONE thing reliably without any network round-trip: whether
// IT is the rack owner. That comes from the page load (server data:
// `data.rackspace.ownerUserId === data.currentUserId`), published into its own
// local awareness as `user.isRackOwner`. A client's OWN local state is
// authoritative for itself — it set it, it didn't receive it.
//
// So the decision is:
//   • If I am CONFIRMED the owner  → I am the host. Always. (No counting.)
//   • If I am CONFIRMED a guest    → I am NEVER the host. I wait for the owner.
//     Even under empty/partial awareness I do NOT seat myself as host/P1.
//   • If ownership is UNKNOWN to me (a genuinely anon rack with no owner
//     concept) → fall back to the deterministic awareness election (lex-min,
//     owner-preferred). An anon rack has no owner, so SOME peer must lead, and
//     lex-min is symmetric across peers → still no split-brain.
//
// Invariants guaranteed (and unit-tested):
//   1. Never two hosts: at most one peer can be CONFIRMED owner (server data),
//      and a confirmed guest never elects itself — so in any rack that HAS an
//      owner, exactly the owner is host on every peer's view.
//   2. A guest never seats itself as P1: localIsOwner===false ⇒ role 'guest'.
//   3. Under incomplete/empty awareness a non-owner WAITS rather than claiming:
//      localIsOwner===false ⇒ 'guest' regardless of how few members are seen.
//   4. Anon racks (no owner) still get a single deterministic leader via the
//      lex-min fallback (unchanged behaviour for the all-anon case).

import { pickHost } from './doom-presence';

export type HostRole = 'host' | 'guest';

export interface HostDecisionInput {
  /** This client's OWN user id (from its local awareness / identity). */
  localUserId: string;
  /** Whether THIS client is the rack owner, as known from RELIABLE local
   *  identity (server page data → local presence `user.isRackOwner`), NOT from
   *  counting remote awareness:
   *    true  → confirmed owner (this client owns the rack).
   *    false → confirmed NON-owner (the rack has an owner and it is not me).
   *    null  → unknown: anon rack with no owner concept, or ownership not yet
   *            resolvable. Falls back to the deterministic awareness election. */
  localIsOwner: boolean | null;
  /** The current host claim observed in awareness (for fallback stickiness),
   *  or null when none. Only consulted in the anon/unknown fallback path. */
  currentHost: string | null;
  /** Live member user ids observed in awareness (including self). Only
   *  consulted in the anon/unknown fallback path. */
  members: readonly string[];
  /** Member ids observed to claim rack ownership in awareness (usually 0/1).
   *  Only consulted in the anon/unknown fallback path. */
  ownerIds: readonly string[];
}

export interface HostDecision {
  role: HostRole;
  /** The user id this client believes is host, or null if it cannot determine
   *  one yet (a confirmed guest that has not yet seen the owner in awareness).
   *  `role === 'host'` iff `hostUserId === localUserId`. */
  hostUserId: string | null;
}

/**
 * Decide this client's host role deterministically.
 *
 * Pure: no awareness reads, no side effects. The caller resolves the inputs
 * (its own id, its reliable ownership, the observed awareness sets) and feeds
 * them in. This is the single authority both DoomCard.isHost and the netcode
 * arbiter election route through, so they can never disagree.
 */
export function decideHostRole(input: HostDecisionInput): HostDecision {
  // 1. Confirmed owner → host, unconditionally. No awareness counting.
  if (input.localIsOwner === true) {
    return { role: 'host', hostUserId: input.localUserId };
  }

  // 2. Confirmed guest → NEVER host. Wait for the owner. We report the owner's
  //    id as host when we can see exactly one owner in awareness (so the UI can
  //    name them); otherwise hostUserId is null ("waiting for the owner"), but
  //    the role is ALWAYS 'guest' — a guest never seats itself as P1, even if
  //    awareness is empty and it is the only member it can see.
  if (input.localIsOwner === false) {
    const owner = uniqueOwner(input.ownerIds, input.members);
    return { role: 'guest', hostUserId: owner };
  }

  // 3. Unknown ownership (anon rack / not-yet-resolved) → deterministic
  //    awareness election. pickHost is symmetric across peers (owner-preferred,
  //    else sticky current host, else lex-min), so every peer agrees.
  const host = pickHost(input.currentHost, input.members, input.ownerIds);
  return {
    role: host !== null && host === input.localUserId ? 'host' : 'guest',
    hostUserId: host,
  };
}

/** The single owner id when awareness shows exactly one (and it is a live
 *  member); null otherwise. Lets a confirmed guest name the host in its UI
 *  without ever influencing its own role. */
function uniqueOwner(
  ownerIds: readonly string[],
  members: readonly string[],
): string | null {
  const live = new Set(members);
  const owners = [...new Set(ownerIds)].filter((id) => live.has(id));
  if (owners.length === 1) return owners[0]!;
  // If we see no owner yet (awareness still arriving) we can't name them — but
  // we still stay a guest. If we somehow see >1 owner (shouldn't happen for a
  // real rack), pick the lex-min so the NAME is at least deterministic; the
  // role is unaffected (still guest).
  if (owners.length > 1) return [...owners].sort()[0]!;
  return null;
}
