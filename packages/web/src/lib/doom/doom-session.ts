// Pure session-mode decisions for the DOOM multiplayer card.
//
// These were inline in DoomCard.svelte, which has no component-test harness;
// pulling them into a pure module makes the load-bearing "is this game
// joinable / what does the guest see" logic unit-testable. The mpLive +
// Join-affordance helpers live in doom-gating.ts; this module holds the two
// session decisions round-6 added (and #330 reverted, now re-landed on the
// split-brain-proof base):
//
//  - shouldOpenMultiplayer(): with OTHER members present a launched game
//    ALWAYS opens multiplayer (the host's "single player" choice is only
//    honoured on a genuinely solo rack), so a host's running game is reliably
//    joinable — no "guest stuck on Waiting… with no working Join" deadlock.
//  - guestWaitingState(): the "Waiting for host to start…" copy only shows
//    when the host genuinely is NOT in a live MP level; once the host is live
//    a joining guest sees "Host is in a game — joining…", never "hasn't
//    started".

import { GS_LEVEL } from './doom-gating';

export type DoomSessionMode = 'single' | 'multi' | undefined;

export interface OpenMultiplayerInput {
  /** The host's explicit session-mode choice (node.data.mpMode). */
  mpMode: DoomSessionMode;
  /** Number of rack members INCLUDING self. >1 means others are present. */
  memberCount: number;
  /** How many peers have an outstanding join-request flag raised. */
  outstandingRequests: number;
  /** Current combined (active + pending) roster occupancy. */
  rosterSize: number;
  /** Whether the host has a game ACTUALLY running (launched). A host's running
   *  game must be joinable; a host merely sitting on the start-choice screen
   *  should NOT auto-open MP (round-5 made MP an explicit action). */
  hostLaunched: boolean;
}

/** Should the arbiter open a multiplayer session (mpMode → 'multi')?
 *
 *  The owner's model: "others see the widget and can Join IF a multiplayer
 *  game is running." So whenever the host has a RUNNING game and other members
 *  are present, that game must be joinable — we open multiplayer even if the
 *  host clicked "Single Player" (the prior deadlock: a solo-launched host
 *  stranded every guest on "Waiting…" with no working Join).
 *
 *  We deliberately do NOT auto-open MP merely because a second member appeared
 *  with NO game running and no host action — that would re-introduce the
 *  round-5 implicit-auto-seat behaviour. MP still opens on an explicit choice
 *  ('multi'), a guest's join-request, an existing roster, OR a host whose game
 *  is already running with others present. An explicit 'single' is honoured
 *  until the host actually launches a game in front of other members. */
export function shouldOpenMultiplayer(input: OpenMultiplayerInput): boolean {
  const othersPresent = input.memberCount > 1;
  const runningWithOthers = input.hostLaunched && othersPresent;
  if (input.mpMode === 'single' && !runningWithOthers) return false;
  return (
    input.mpMode === 'multi' ||
    runningWithOthers ||
    input.outstandingRequests > 0 ||
    input.rosterSize > 0
  );
}

export type GuestWaiting = 'in-level' | 'host-live-joining' | 'waiting';

export interface GuestWaitingInput {
  /** This guest's OWN level is live (its WASM started + entered GS_LEVEL). */
  ownInLevel: boolean;
  /** The host's published mpLive (a multiplayer level is live on the host). */
  hostMpLive: boolean;
}

/** What a joined non-arbiter guest should display:
 *   - 'in-level'         → our own level is running ("playing as P{n}").
 *   - 'host-live-joining'→ host is in a live MP level but our GAMESTART hasn't
 *                          landed yet ("Host is in a game — joining…"). We must
 *                          NEVER say the host hasn't started here.
 *   - 'waiting'          → host genuinely is not in a live MP level. */
export function guestWaitingState(input: GuestWaitingInput): GuestWaiting {
  if (input.ownInLevel) return 'in-level';
  if (input.hostMpLive) return 'host-live-joining';
  return 'waiting';
}

// Re-export GS_LEVEL so callers needing it from the session module resolve
// without duplicating the constant (authoritatively defined in doom-gating.ts).
export { GS_LEVEL };
