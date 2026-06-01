// packages/web/src/lib/doom/doom-awareness-signature.ts
//
// THROTTLE the high-frequency awareness storm that hangs DOOM multiplayer.
//
// ── The hang this fixes ───────────────────────────────────────────────────
//
// DOOM runs at ~35 Hz and the netcode writes EACH joined peer's latest ticcmd
// to a sticky awareness field (`doom-net:<mid>:ticcmd`) every tic it changes
// (see doom-netcode.broadcastLocalTiccmd). With 2 active players that is up to
// ~70 awareness `update` events/sec, fanned to every peer through the one
// relay. Both the DoomCard observer (recomputeHost + roster sync + slot
// assignment + identity) AND the netcode observer (recomputeMembership: peer-id
// map rebuild + arbiter election + WebRTC reconcile) were wired to run their
// FULL machinery on EVERY awareness update — so during active play they fired
// ~70×/sec on both clients and saturated the main thread → unresponsive tabs.
//
// ── The fix: only recompute when an ELECTION-RELEVANT field changed ─────────
//
// Host/arbiter election + roster + slot-assignment + identity depend ONLY on a
// small, slow-changing set of awareness fields:
//
//   • user.id           — membership (who is in the rack)
//   • user.isRackOwner  — ownership (decides the host)
//   • user.displayName  — identity (badge/label)
//   • doom:<mid>:host   — the sticky host-claim hint (anon-rack fallback)
//   • doom:<mid>:join-req — outstanding join requests (slot assignment)
//
// NONE of those change per-tic. The per-tic firehose is the ticcmd field
// (`doom-net:<mid>:ticcmd`) plus the relay packet fields, signal SDP/ICE, the
// gamestart blob, the key-relay field, cursor churn — all of which have their
// OWN dedicated, deduped consumers and must NOT drive election/roster.
//
// So we compute a cheap, deterministic SIGNATURE of just the election-relevant
// fields across all clients. The observer compares it to the previous
// signature and SKIPS the expensive recompute when it is unchanged. A pure
// ticcmd/relay/cursor update therefore produces ZERO election work — bounded
// per-second observer cost regardless of tic rate. (The cheap edge-triggered
// key-relay still runs every update; it is already deduped on its own cursor.)
//
// Pure + total + side-effect-free so the unit suite can pin it with a plain
// Map of fake awareness states — no Yjs, no Svelte, no WASM.

/** The minimal awareness-states shape we read: clientId → its state record. */
export type AwarenessStates = Map<number, Record<string, unknown> | undefined>;

/** Awareness field name carrying a client's "I am host for module mid" claim. */
export function hostClaimField(moduleId: string): string {
  return `doom:${moduleId}:host`;
}

/** Awareness field name carrying a client's outstanding join request. */
export function joinReqField(moduleId: string): string {
  return `doom:${moduleId}:join-req`;
}

/**
 * Compute a cheap, deterministic signature over ONLY the awareness fields that
 * can change the host/arbiter election, roster, slot-assignment, or identity
 * for DOOM module `moduleId`. Two awareness snapshots that differ only in
 * high-frequency fields (ticcmd, relay packets, signaling, gamestart, key
 * relay, cursor) yield the SAME signature — so an observer keyed on it does no
 * election/roster work for the per-tic storm.
 *
 * Deterministic across peers: we sort by clientId so identical input maps
 * produce identical strings (the signature is only ever compared to the same
 * client's own previous value, but determinism keeps it stable + testable).
 */
export function electionAwarenessSignature(
  states: AwarenessStates,
  moduleId: string,
): string {
  const hostField = hostClaimField(moduleId);
  const joinField = joinReqField(moduleId);
  const parts: string[] = [];
  // Sort entries by clientId for a stable, order-independent signature.
  const sorted = [...states.entries()].sort((a, b) => a[0] - b[0]);
  for (const [clientId, state] of sorted) {
    if (!state) continue;
    const user = (state as { user?: { id?: unknown; isRackOwner?: unknown; displayName?: unknown } }).user;
    const uid = typeof user?.id === 'string' ? user.id : '';
    // Skip phantom clients that carry no user id and none of our fields.
    const host = state[hostField];
    const join = state[joinField];
    const hasAny =
      uid !== '' ||
      typeof host === 'string' ||
      typeof join === 'string';
    if (!hasAny) continue;
    const owner = user?.isRackOwner === true ? '1' : user?.isRackOwner === false ? '0' : '';
    const name = typeof user?.displayName === 'string' ? user.displayName : '';
    const hostClaim = typeof host === 'string' ? host : '';
    const joinReq = typeof join === 'string' ? join : '';
    // Field separator that cannot appear in a uid/name (we use unit-sep \x1f
    // between fields and record-sep \x1e between clients).
    parts.push(
      `${clientId}\x1f${uid}\x1f${owner}\x1f${name}\x1f${hostClaim}\x1f${joinReq}`,
    );
  }
  return parts.join('\x1e');
}
