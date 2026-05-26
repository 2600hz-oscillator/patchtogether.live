// Pure session-mode decisions for the DOOM multiplayer card.
//
// These were inline in DoomCard.svelte, which has no component-test harness;
// pulling them into a pure module makes the load-bearing "is this game
// joinable / is the host live / what does the guest see" logic unit-testable.
//
// The two bugs these guard against:
//
//  - "Guest stuck 'Waiting for host to start a multiplayer game…' while the
//    host IS in a live game." Root cause: a host could have a game running
//    without it being a JOINABLE multiplayer session, and the guest had no
//    authoritative signal that the host was in-level. Fixes:
//      * shouldOpenMultiplayer(): with OTHER members present a launched game
//        ALWAYS opens multiplayer (the host's "single player" choice is only
//        honoured on a genuinely solo rack), so the game is reliably joinable.
//      * computeMpLive(): the host publishes a single authoritative "a
//        multiplayer level is live right now" boolean; the guest reads it.
//      * guestWaitingState(): the "Waiting for host to start…" copy only shows
//        when the host genuinely is NOT in a live MP level.

export type DoomSessionMode = 'single' | 'multi' | undefined;

/** GS_LEVEL ordinal (doomdef.h gamestate_t) — the live in-level state. */
export const GS_LEVEL = 0;

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

export interface MpLiveInput {
  mpMode: DoomSessionMode;
  /** A netgame has been launched on this (host) peer. */
  launched: boolean;
  /** Polled DOOM gamestate_t on this (host) peer. */
  gamestate: number;
}

/** The host's authoritative "a multiplayer level is live RIGHT NOW" signal,
 *  published on the shared node so guests can tell the host is in-level
 *  without relying on their own (possibly absent) launched/gamestate. */
export function computeMpLive(input: MpLiveInput): boolean {
  return input.mpMode === 'multi' && input.launched && input.gamestate === GS_LEVEL;
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

export interface JoinEnabledInput {
  isHost: boolean;
  /** This peer already holds an active or pending slot. */
  seated: boolean;
  /** The game is full (combined active + pending). */
  full: boolean;
  /** Host explicitly locked single-player on a solo rack. */
  mpMode: DoomSessionMode;
}

/** Is the Join affordance OFFERED (rendered) to this peer?
 *
 *  Offered to any unjoined, non-host peer unless the host explicitly locked
 *  single-player. Whether the offered button is ENABLED is a separate concern
 *  (isJoinDisabled) — per the owner's spec the button is shown but DISABLED
 *  until the host is actually running a multiplayer game (mpLive). There is no
 *  deadlock from gating on mpLive: the host flips mpLive itself when it launches
 *  with other members present (shouldOpenMultiplayer), independent of any guest
 *  Join. */
export function isJoinAvailable(input: JoinEnabledInput): boolean {
  if (input.isHost) return false;
  if (input.seated) return false;
  if (input.mpMode === 'single') return false;
  return true;
}

/** Whether the (offered) Join button should be rendered DISABLED. Per the
 *  owner's spec, Join is disabled until the host is running a live multiplayer
 *  game (mpLive) — or when the game is full. The host-side shouldOpenMultiplayer
 *  flips mpLive on launch-with-others, so this gate never deadlocks. */
export function isJoinDisabled(full: boolean, mpLive: boolean): boolean {
  return full || !mpLive;
}
