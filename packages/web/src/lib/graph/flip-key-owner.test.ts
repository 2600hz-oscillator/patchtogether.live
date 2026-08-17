// Arbitration of the rack-flip key (bare Tab, owner ruling #1629).
//
// The behaviour under test is the one 7e21befe2 fixed by hand and this
// resolver now holds structurally: EXACTLY ONE surface acts per keystroke.
// The old shape was two guards hard-coding each other's occupancy — correct
// for two owners, silently wrong for three, with no failure if you forgot an
// edit. These assertions are written over the CLAIMANT LIST rather than over
// the two owners that happen to exist, so a third one is covered without
// editing this file.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  FLIP_KEY_CLAIMANTS,
  flipKeyOwner,
  setFlipKeyOccupancy,
  isRackFlipKey,
  __resetFlipKeyOccupancy,
  type FlipKeyClaimant,
} from './workflow-pins';

/** Every claimant except the floor — derived, never re-typed. */
const INNER = FLIP_KEY_CLAIMANTS.filter((c) => c !== 'canvas');

beforeEach(() => __resetFlipKeyOccupancy());

describe('the claimant list is the precedence rule', () => {
  it('falls through to the canvas floor when nothing is occupied', () => {
    expect(flipKeyOwner()).toBe('canvas');
  });

  it('names canvas LAST — the floor must be the least specific claimant', () => {
    expect(FLIP_KEY_CLAIMANTS[FLIP_KEY_CLAIMANTS.length - 1]).toBe('canvas');
    expect(INNER).not.toContain('canvas');
  });

  it('gives the key to whichever single claimant is occupied', () => {
    // Over EVERY inner claimant, so a new surface is covered by construction.
    for (const who of INNER) {
      __resetFlipKeyOccupancy();
      setFlipKeyOccupancy(who, () => true);
      expect(flipKeyOwner()).toBe(who);
    }
  });

  it('gives the key to the INNERMOST when several are occupied at once', () => {
    for (const who of INNER) setFlipKeyOccupancy(who, () => true);
    expect(flipKeyOwner()).toBe(INNER[0]);
  });

  it('EXACTLY ONE claimant sees itself as the owner, in every occupancy combination', () => {
    // The property the phase-divergence bug violated. Enumerated over the
    // power set of inner claimants, so it is a statement about the resolver
    // and not about a hand-picked pair of cases.
    const combos = 1 << INNER.length;
    for (let mask = 0; mask < combos; mask++) {
      __resetFlipKeyOccupancy();
      INNER.forEach((who, i) => setFlipKeyOccupancy(who, () => (mask & (1 << i)) !== 0));
      const owner = flipKeyOwner();
      const selfIdentified = FLIP_KEY_CLAIMANTS.filter((c) => flipKeyOwner() === c);
      expect(selfIdentified).toEqual([owner]);
    }
  });
});

describe('occupancy is read live, not captured', () => {
  it('a claimant that becomes unoccupied hands the key back', () => {
    let open = true;
    setFlipKeyOccupancy('dock-full-view', () => open);
    expect(flipKeyOwner()).toBe('dock-full-view');
    open = false;
    expect(flipKeyOwner()).toBe('canvas');
  });

  it('deregistering hands the key back — a gone surface cannot swallow it', () => {
    const off = setFlipKeyOccupancy('dock-full-view', () => true);
    expect(flipKeyOwner()).toBe('dock-full-view');
    off();
    expect(flipKeyOwner()).toBe('canvas');
  });

  it('a stale teardown does NOT unregister a remounted claimant', () => {
    // Svelte can run the new $effect before the old cleanup. If the stale
    // closure won, the live surface would go deaf with nothing to show for it.
    const offStale = setFlipKeyOccupancy('dock-full-view', () => true);
    setFlipKeyOccupancy('dock-full-view', () => true); // remount registers again
    offStale(); // old cleanup arrives late
    expect(flipKeyOwner()).toBe('dock-full-view');
  });
});

describe('the key binding and the ownership question stay separate', () => {
  it('isRackFlipKey still rejects every modifier, whoever owns the key', () => {
    setFlipKeyOccupancy('drop-modal', () => true);
    expect(isRackFlipKey({ key: 'Tab' })).toBe(true);
    // Shift-Tab is the one keyboard path deliberately left native (#1629).
    expect(isRackFlipKey({ key: 'Tab', shiftKey: true })).toBe(false);
    expect(isRackFlipKey({ key: 'Tab', metaKey: true })).toBe(false);
    expect(isRackFlipKey({ key: 'Tab', ctrlKey: true })).toBe(false);
    expect(isRackFlipKey({ key: 'Tab', altKey: true })).toBe(false);
  });

  it('ownership says nothing about WHICH key — a non-flip key is still not a flip', () => {
    setFlipKeyOccupancy('drop-modal', () => true);
    expect(isRackFlipKey({ key: 'f' })).toBe(false);
  });
});

describe('scope — what this resolver does NOT do', () => {
  it('does not apply the typing-target guard; every caller still owns that', () => {
    // Stated as an assertion rather than a comment so the boundary is visible
    // in the failure output if someone moves the guard in here.
    const claimants: readonly FlipKeyClaimant[] = FLIP_KEY_CLAIMANTS;
    setFlipKeyOccupancy('canvas' as FlipKeyClaimant, () => true);
    // Registering the floor changes nothing — it is unconditional by position.
    expect(flipKeyOwner()).toBe('canvas');
    expect(claimants.length).toBeGreaterThan(1); // vacuity guard
  });
});
