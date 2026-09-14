// packages/web/src/lib/doom/doom-presence.ts
//
// Per-DOOM-module Yjs awareness channel. Awareness carries ONLY small
// fields — every payload here is bounded to a handful of scalars:
//
//   KEY ENVELOPES (small): {kind:'key', moduleId, srcUserId, doomKey, pressed, ts}
//      Non-host users emit one each time their card sees keyboard input or a
//      CV-gate edge; the host's runtime mirror sees them and feeds the queue.
//
// NOTE (relay-OOM fix): there used to be a second "FRAME" payload that
// base64-encoded the host's ~1.4 MB BGRA framebuffer and broadcast it at
// ~10 Hz so unjoined spectators could watch the host's screen. That path was
// REMOVED — pushing video frames through a CRDT/awareness channel is the wrong
// design: the Hocuspocus relay holds + rebroadcasts awareness IN PROCESS
// MEMORY, so the firehose blew past its RAM cap and OOM-killed the dev relay
// (exit 137), wiping shared state + breaking multiuser sync. Spectators now see
// the DOOM attract/black screen until they JOIN, at which point they run their
// own per-peer WASM + render their own POV (the existing per-peer model). A
// future low-rate spectator stream, if wanted, must ride a proper media channel
// — NOT awareness.
//
// Both encode/decode are pure functions — testable as part of the unit
// suite without spinning up a Yjs provider. The actual awareness wiring
// (subscribing, throttling, host-migration tie-break) lives in DoomSurface
// and is e2e-tested by the multi-tab Playwright scenario.

import { CV_GATE_PORT_IDS } from './doomkeys';

// ---------------- Key envelopes ----------------

export interface KeyEnvelope {
  kind: 'key';
  /** DOOM module instance id (one host per module-id). */
  moduleId: string;
  /** Who fired the input (Y.Awareness clientID or `${currentUserId}`). */
  srcUserId: string;
  /** doomkeys.h constant (0..255). */
  doomKey: number;
  pressed: boolean;
  /** Wall-clock millis at emit, retained for compatibility with older peers. */
  ts: number;
  /** Sender lifetime and sequence identify events even when wall time repeats. */
  session?: string;
  seq?: number;
}

export function encodeKey(env: KeyEnvelope): KeyEnvelope {
  // The "encoding" here is the typed object itself — Yjs awareness state
  // serializes JSON natively. We surface this function anyway so future
  // schema bumps can interpose validation (e.g. clamp doomKey to 0..255).
  return {
    kind: 'key',
    moduleId: env.moduleId,
    srcUserId: env.srcUserId,
    doomKey: env.doomKey & 0xff,
    pressed: !!env.pressed,
    ts: env.ts,
    ...(env.session !== undefined && env.seq !== undefined ? { session: env.session, seq: env.seq } : {}),
  };
}

export function decodeKey(raw: unknown): KeyEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'key') return null;
  if (typeof r['moduleId'] !== 'string') return null;
  if (typeof r['srcUserId'] !== 'string') return null;
  if (typeof r['doomKey'] !== 'number') return null;
  if (typeof r['pressed'] !== 'boolean') return null;
  if (typeof r['ts'] !== 'number') return null;
  if (r['session'] !== undefined || r['seq'] !== undefined) {
    if (typeof r['session'] !== 'string' || !r['session'] || !Number.isSafeInteger(r['seq'])
      || (r['seq'] as number) < 1) return null;
  }
  return {
    kind: 'key',
    moduleId: r['moduleId'] as string,
    srcUserId: r['srcUserId'] as string,
    doomKey: (r['doomKey'] as number) & 0xff,
    pressed: r['pressed'] as boolean,
    ts: r['ts'] as number,
    ...(r['session'] !== undefined ? { session: r['session'] as string, seq: r['seq'] as number } : {}),
  };
}

// ---------------- Host-side relay receiver (edge-triggered) ----------------
//
// PHANTOM-INPUT BUG (fixed here): the host's awareness 'update' listener
// fires on EVERY awareness change in the rack — not just on a remote
// keystroke. Host-election / cursor / presence churn each emit awareness
// updates. The original receiver re-read each remote client's CURRENT
// `doom:<id>:key` field on every such update and re-pushed it into the
// runtime unconditionally.
//
// Result: a single still-held (or not-yet-cleared) remote key envelope —
// e.g. a second browser tab the user forgot about, which counts as a
// distinct awareness client — got re-injected as a fresh key event ~10×/sec.
// For KEY_DOWNARROW that reads in-game as the marine being shoved backward
// continuously with no key pressed ("random CV on the movement pot").
//
// Fix: track the last sender session and sequence per source client, with
// a timestamp fallback for older senders. Only a new envelope is pushed.
// Repeated observations of the same (sticky) envelope across unrelated
// awareness updates are ignored. This is a pure reducer so it's unit-
// testable without a live Yjs provider.

/** Last relayed envelope identity, keyed by awareness clientID.
 *  Callers own one map per DOOM surface. */
export type RelayCursor = Map<number, number | { session: string; seq: number }>;

/** One key event the host should push into its runtime this update. */
export interface RelayPush {
  doomKey: number;
  pressed: boolean;
}

/**
 * Given the current awareness states + the cursor of already-relayed
 * envelopes, return ONLY the key events that are new since last call and
 * advance the cursor in place. Pure aside from the cursor mutation:
 * calling it twice with the same states + cursor yields an empty list the
 * second time (the dedup that kills the phantom re-injection).
 *
 *  - skips the host's own client (selfClientId)
 *  - skips envelopes the host itself authored (selfUserId) — defends
 *    against a host that is ALSO relaying (shouldn't happen, but cheap)
 *  - skips envelopes for a different module id
 *  - skips null / malformed `doom:<id>:key` fields (cleared envelopes)
 */
export function collectIncomingKeyPushes(args: {
  states: Map<number, Record<string, unknown>>;
  moduleId: string;
  selfClientId: number;
  selfUserId: string;
  cursor: RelayCursor;
}): RelayPush[] {
  const { states, moduleId, selfClientId, selfUserId, cursor } = args;
  const pushes: RelayPush[] = [];
  states.forEach((state, clientId) => {
    if (clientId === selfClientId) return;
    const env = decodeKey((state as Record<string, unknown>)[`doom:${moduleId}:key`]);
    if (!env || env.moduleId !== moduleId) return;
    if (env.srcUserId === selfUserId) return;
    const last = cursor.get(clientId);
    if (env.session !== undefined && env.seq !== undefined) {
      if (typeof last === 'object' && last.session === env.session && env.seq <= last.seq) return;
      cursor.set(clientId, { session: env.session, seq: env.seq });
    } else {
      // Compatibility for already-open older clients. Never let their stale
      // envelope replace a sequence-aware sender in the same awareness session.
      if (typeof last === 'object' || (typeof last === 'number' && env.ts <= last)) return;
      cursor.set(clientId, env.ts);
    }
    pushes.push({ doomKey: env.doomKey, pressed: env.pressed });
  });
  return pushes;
}

// ---------------- Host election + migration tie-break ----------------
//
// Election order (deterministic + symmetric across clients → no quorum):
//   1. The RACK OWNER, if they are present. The DOOM host runs the
//      authoritative instance + is seated at player 0; the operator's
//      requirement is "the rack host should be the arbiter/player 0", so
//      whoever owns the rackspace is the DOOM host whenever they're online —
//      regardless of where their user id sorts. (Pre-fix this used pure
//      lex-min, so a guest whose id sorted before the owner's hijacked
//      host + player 0 — the "guest seated as P1" bug.)
//   2. Otherwise (anon rack with no resolvable owner, or owner offline) the
//      lex-smallest live member, preserving the old deterministic fallback +
//      giving a clean migration target when the owner leaves.
//
// `currentHost` stickiness is preserved EXCEPT when the rack owner is present
// and isn't already the host — the owner reclaims the seat (so an owner who
// joins after a guest took the temporary host seat takes it back). When the
// owner is absent, a current host that is still live is kept (no needless
// churn / migration storms).

/** Pure: given the current host (or null on first spawn), the live set of
 *  rack-member user ids, and the set of member ids known to OWN the rack
 *  (usually 0 or 1 — anon racks have none), return who should be host this
 *  tick.
 *
 *  `ownerIds` defaults to empty so existing 2-arg callers (and the lex-min
 *  fallback tests) keep their old behavior. */
export function pickHost(
  currentHost: string | null,
  members: readonly string[],
  ownerIds: readonly string[] = [],
): string | null {
  if (members.length === 0) return null;
  // 1. The rack owner, when present, is always the host. If more than one
  //    member somehow claims ownership, the lex-smallest owner wins (stable).
  const ownersPresent = members.filter((m) => ownerIds.includes(m)).sort();
  if (ownersPresent.length > 0) return ownersPresent[0]!;
  // 2. No owner present — keep a still-live current host (avoid churn)…
  if (currentHost !== null && members.includes(currentHost)) {
    return currentHost;
  }
  // …else elect the lex-smallest live member (deterministic fallback).
  const sorted = [...members].sort();
  return sorted[0] ?? null;
}

// ---------------- Module-level invariants exported for tests ----------------

export const SUPPORTED_KEY_PORT_IDS = CV_GATE_PORT_IDS;
