import { describe, it, expect } from 'vitest';
import {
  shouldOpenMultiplayer,
  computeMpLive,
  guestWaitingState,
  isJoinAvailable,
  isJoinDisabled,
  GS_LEVEL,
} from './doom-session';

const GS_INTERMISSION = 1;

describe('shouldOpenMultiplayer (deadlock fix)', () => {
  it('opens MP when host LAUNCHED a game with other members present, even if host chose single', () => {
    // The exact deadlock: host clicked "Single Player" but launched a game with
    // a guest in the rack. The running game MUST be joinable → override to MP.
    expect(
      shouldOpenMultiplayer({
        mpMode: 'single',
        memberCount: 2,
        outstandingRequests: 0,
        rosterSize: 0,
        hostLaunched: true,
      }),
    ).toBe(true);
  });

  it('does NOT auto-open MP merely because a 2nd member appeared (no game running)', () => {
    // Round-5 made MP an explicit action; a host idling on the start-choice
    // screen with a guest present must not be auto-seated into a netgame.
    expect(
      shouldOpenMultiplayer({
        mpMode: undefined,
        memberCount: 2,
        outstandingRequests: 0,
        rosterSize: 0,
        hostLaunched: false,
      }),
    ).toBe(false);
  });

  it('honours host single-player on a genuinely solo rack', () => {
    expect(
      shouldOpenMultiplayer({
        mpMode: 'single',
        memberCount: 1,
        outstandingRequests: 0,
        rosterSize: 0,
        hostLaunched: true,
      }),
    ).toBe(false);
  });

  it('stays idle on a solo rack with no choice and nobody wanting MP', () => {
    expect(
      shouldOpenMultiplayer({
        mpMode: undefined,
        memberCount: 1,
        outstandingRequests: 0,
        rosterSize: 0,
        hostLaunched: false,
      }),
    ).toBe(false);
  });

  it('opens MP when the host explicitly chose multi', () => {
    expect(
      shouldOpenMultiplayer({
        mpMode: 'multi',
        memberCount: 1,
        outstandingRequests: 0,
        rosterSize: 0,
        hostLaunched: false,
      }),
    ).toBe(true);
  });

  it('opens MP when a guest has an outstanding join-request (solo→multi)', () => {
    expect(
      shouldOpenMultiplayer({
        mpMode: undefined,
        memberCount: 1, // member list may lag the awareness join-request
        outstandingRequests: 1,
        rosterSize: 0,
        hostLaunched: false,
      }),
    ).toBe(true);
  });

  it('opens MP when a roster already exists', () => {
    expect(
      shouldOpenMultiplayer({
        mpMode: undefined,
        memberCount: 2,
        outstandingRequests: 0,
        rosterSize: 1,
        hostLaunched: false,
      }),
    ).toBe(true);
  });
});

describe('computeMpLive (host authoritative in-level signal)', () => {
  it('is true when host is in a launched multi level', () => {
    expect(computeMpLive({ mpMode: 'multi', launched: true, gamestate: GS_LEVEL })).toBe(true);
  });

  it('is false in single-player even when in-level', () => {
    expect(computeMpLive({ mpMode: 'single', launched: true, gamestate: GS_LEVEL })).toBe(false);
  });

  it('is false before launch', () => {
    expect(computeMpLive({ mpMode: 'multi', launched: false, gamestate: -1 })).toBe(false);
  });

  it('is false at intermission (between maps)', () => {
    expect(computeMpLive({ mpMode: 'multi', launched: true, gamestate: GS_INTERMISSION })).toBe(false);
  });
});

describe('guestWaitingState (no false "Waiting" while host is live)', () => {
  it('shows our own slot once our level is live', () => {
    expect(guestWaitingState({ ownInLevel: true, hostMpLive: true })).toBe('in-level');
  });

  it('says the host is in a game when host is live but our GAMESTART lags', () => {
    // THE deadlock symptom: host in-level, guest has not started its own game.
    // We must NOT say "Waiting for host to start…".
    expect(guestWaitingState({ ownInLevel: false, hostMpLive: true })).toBe('host-live-joining');
  });

  it('only says "Waiting" when the host genuinely is not in a live level', () => {
    expect(guestWaitingState({ ownInLevel: false, hostMpLive: false })).toBe('waiting');
  });
});

describe('isJoinAvailable / isJoinDisabled (no Join deadlock)', () => {
  it('offers Join to an unjoined non-host guest regardless of host mpLive', () => {
    // Join must NOT be gated on mpLive — the request itself opens MP. Otherwise
    // Join would be the only thing that flips mpLive yet disabled until mpLive.
    expect(isJoinAvailable({ isHost: false, seated: false, full: false, mpMode: undefined })).toBe(
      true,
    );
    expect(isJoinAvailable({ isHost: false, seated: false, full: false, mpMode: 'multi' })).toBe(
      true,
    );
  });

  it('hides Join from the host and from a seated player', () => {
    expect(isJoinAvailable({ isHost: true, seated: false, full: false, mpMode: 'multi' })).toBe(
      false,
    );
    expect(isJoinAvailable({ isHost: false, seated: true, full: false, mpMode: 'multi' })).toBe(
      false,
    );
  });

  it('hides Join when host explicitly locked single-player (solo rack)', () => {
    expect(isJoinAvailable({ isHost: false, seated: false, full: false, mpMode: 'single' })).toBe(
      false,
    );
  });

  it('disables (but still shows) Join only when full', () => {
    expect(isJoinDisabled(true)).toBe(true);
    expect(isJoinDisabled(false)).toBe(false);
  });
});

describe('end-to-end deadlock scenario', () => {
  it('host in-level with members present ⇒ mpLive true ⇒ guest Join enabled, no false wait', () => {
    // Host: 2 members, launched a multi level.
    const hostMpLive = computeMpLive({ mpMode: 'multi', launched: true, gamestate: GS_LEVEL });
    expect(hostMpLive).toBe(true);
    // The arbiter would have opened MP (game launched, others present).
    expect(
      shouldOpenMultiplayer({
        mpMode: 'multi',
        memberCount: 2,
        outstandingRequests: 0,
        rosterSize: 1,
        hostLaunched: true,
      }),
    ).toBe(true);
    // Guest (unjoined, sees hostMpLive): Join is available + enabled, and the
    // copy is NOT the false "Waiting for host to start…".
    expect(isJoinAvailable({ isHost: false, seated: false, full: false, mpMode: 'multi' })).toBe(
      true,
    );
    expect(isJoinDisabled(false)).toBe(false);
    expect(guestWaitingState({ ownInLevel: false, hostMpLive })).not.toBe('waiting');
  });

  it('solo host on / stays single-player (no spurious multiplayer)', () => {
    expect(
      shouldOpenMultiplayer({
        mpMode: 'single',
        memberCount: 1,
        outstandingRequests: 0,
        rosterSize: 0,
        hostLaunched: true,
      }),
    ).toBe(false);
    expect(computeMpLive({ mpMode: 'single', launched: true, gamestate: GS_LEVEL })).toBe(false);
  });
});
