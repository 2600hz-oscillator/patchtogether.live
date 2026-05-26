// packages/web/src/lib/doom/doom-gating.test.ts
import { describe, it, expect } from 'vitest';
import {
  GS_LEVEL,
  GS_INTERMISSION,
  canAddDoom,
  isOwnerOnlyModule,
  canAddModule,
  computeMpLive,
  joinAffordance,
  canJoinNow,
  shouldHotJoinRelaunch,
} from './doom-gating';

describe('owner-only widget instantiation', () => {
  it('the rack owner may add DOOM', () => {
    expect(canAddDoom(true)).toBe(true);
  });

  it('an explicit non-owner may NOT add DOOM', () => {
    expect(canAddDoom(false)).toBe(false);
  });

  it('single-user / no-provider (undefined) may add DOOM — sole user is owner', () => {
    expect(canAddDoom(undefined)).toBe(true);
  });

  it('doom is the owner-only module; other types are not', () => {
    expect(isOwnerOnlyModule('doom')).toBe(true);
    expect(isOwnerOnlyModule('reverb')).toBe(false);
    expect(isOwnerOnlyModule('analogVco')).toBe(false);
  });

  it('canAddModule gates only owner-only types', () => {
    // Owner-only: gated by ownership.
    expect(canAddModule('doom', true)).toBe(true);
    expect(canAddModule('doom', false)).toBe(false);
    expect(canAddModule('doom', undefined)).toBe(true);
    // Everything else: always addable regardless of ownership.
    expect(canAddModule('reverb', false)).toBe(true);
    expect(canAddModule('reverb', true)).toBe(true);
    expect(canAddModule('reverb', undefined)).toBe(true);
  });
});

describe('computeMpLive — host-authoritative "MP is live" signal', () => {
  it('is true only in a multi session, launched, and in-level', () => {
    expect(computeMpLive({ mpMode: 'multi', launched: true, gamestate: GS_LEVEL })).toBe(true);
  });

  it('is false in single-player mode even if launched + in-level', () => {
    expect(computeMpLive({ mpMode: 'single', launched: true, gamestate: GS_LEVEL })).toBe(false);
  });

  it('is false when no session mode chosen yet', () => {
    expect(computeMpLive({ mpMode: undefined, launched: false, gamestate: -1 })).toBe(false);
  });

  it('is false before launch (lobby open but no game)', () => {
    expect(computeMpLive({ mpMode: 'multi', launched: false, gamestate: -1 })).toBe(false);
  });

  it('is false at intermission (between maps — not joinable yet)', () => {
    expect(computeMpLive({ mpMode: 'multi', launched: true, gamestate: GS_INTERMISSION })).toBe(
      false,
    );
  });
});

describe('joinAffordance — guest Join button state', () => {
  const base = { isHost: false, alreadySeated: false, full: false, mpLive: true } as const;

  it('the host never sees a Join button (it is already P1)', () => {
    expect(joinAffordance({ ...base, isHost: true }).show).toBe(false);
  });

  it('an already-seated peer never sees a Join button', () => {
    expect(joinAffordance({ ...base, alreadySeated: true }).show).toBe(false);
  });

  it('a guest sees a DISABLED Join when MP is not live, with the waiting copy', () => {
    const s = joinAffordance({ ...base, mpLive: false });
    expect(s.show).toBe(true);
    if (!s.show) throw new Error('unreachable');
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/waiting for host/i);
    expect(s.reason).toMatch(/multiplayer game/i);
  });

  it('a guest sees an ENABLED Join when MP is live (one-click hot-join)', () => {
    const s = joinAffordance(base);
    expect(s.show).toBe(true);
    if (!s.show) throw new Error('unreachable');
    expect(s.enabled).toBe(true);
    expect(s.reason).toMatch(/hot-drop/i);
  });

  it('a full game disables Join with a Full label even when MP is live', () => {
    const s = joinAffordance({ ...base, full: true });
    expect(s.show).toBe(true);
    if (!s.show) throw new Error('unreachable');
    expect(s.enabled).toBe(false);
    expect(s.label).toBe('Full');
  });

  it('not-live takes precedence over full (waiting copy shown first)', () => {
    const s = joinAffordance({ ...base, mpLive: false, full: true });
    if (!s.show) throw new Error('unreachable');
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/waiting for host/i);
  });

  it('canJoinNow mirrors the enabled state', () => {
    expect(canJoinNow(base)).toBe(true);
    expect(canJoinNow({ ...base, mpLive: false })).toBe(false);
    expect(canJoinNow({ ...base, full: true })).toBe(false);
    expect(canJoinNow({ ...base, isHost: true })).toBe(false);
    expect(canJoinNow({ ...base, alreadySeated: true })).toBe(false);
  });
});

describe('shouldHotJoinRelaunch — auto-relaunch on join', () => {
  it('fires when the arbiter seats a new active player mid-level', () => {
    expect(
      shouldHotJoinRelaunch({ isArbiter: true, gameInProgress: true, addedActivePlayer: true }),
    ).toBe(true);
  });

  it('does NOT fire on a non-arbiter (single broadcaster)', () => {
    expect(
      shouldHotJoinRelaunch({ isArbiter: false, gameInProgress: true, addedActivePlayer: true }),
    ).toBe(false);
  });

  it('does NOT fire when no level is running (lobby / intermission)', () => {
    expect(
      shouldHotJoinRelaunch({ isArbiter: true, gameInProgress: false, addedActivePlayer: true }),
    ).toBe(false);
  });

  it('does NOT fire when no new active player was added (idempotent re-pass)', () => {
    expect(
      shouldHotJoinRelaunch({ isArbiter: true, gameInProgress: true, addedActivePlayer: false }),
    ).toBe(false);
  });
});
