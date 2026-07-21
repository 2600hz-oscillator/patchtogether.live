// packages/web/src/lib/audio/cv-buddy/slot-alloc.test.ts
//
// PURE unit coverage for the CV Buddy ES-9 slot allocator. No AudioContext,
// no Yjs — plain fixtures. (Flake-check REPEAT=3 pre-MR per CLAUDE.md.)

import { describe, it, expect } from 'vitest';
import {
  allocateCvBuddySlots,
  slotToEs9,
  slotsToReset,
  ES9_AUDIO,
  ES9_CV,
  ES9_PITCH,
  ES9_GATE,
  CV_BUDDY_MANAGED_SLOTS,
  type CvBuddyAlloc,
} from './slot-alloc';

describe('allocateCvBuddySlots', () => {
  it('is empty for no instances', () => {
    expect(allocateCvBuddySlots([]).size).toBe(0);
  });

  it('index 0 gets {1,2,3} + owns RUN(7) + CLOCK(8)', () => {
    const m = allocateCvBuddySlots(['a']);
    expect(m.get('a')).toEqual({
      pitchSlot: 1,
      gateSlot: 2,
      velSlot: 3,
      ownsClock: true,
      runSlot: 7,
      clockSlot: 8,
    });
  });

  it('index 1 gets {4,5,6} and owns neither RUN nor CLOCK', () => {
    const m = allocateCvBuddySlots(['a', 'b']);
    expect(m.get('b')).toEqual({
      pitchSlot: 4,
      gateSlot: 5,
      velSlot: 6,
      ownsClock: false,
      runSlot: null,
      clockSlot: null,
    });
  });

  it('id-sorts ASCENDING regardless of input order (collab-convergent)', () => {
    const m1 = allocateCvBuddySlots(['zeta', 'alpha']);
    const m2 = allocateCvBuddySlots(['alpha', 'zeta']);
    // alpha < zeta so alpha is index 0 (owns run + clock) either way.
    expect(m1.get('alpha')?.ownsClock).toBe(true);
    expect(m2.get('alpha')?.ownsClock).toBe(true);
    expect(m1.get('zeta')?.pitchSlot).toBe(4);
    expect(m2.get('zeta')?.pitchSlot).toBe(4);
  });

  it('3rd+ instances are INERT (no entry — "no free ES-9 slots")', () => {
    const m = allocateCvBuddySlots(['a', 'b', 'c', 'd']);
    expect(m.size).toBe(2);
    expect(m.has('c')).toBe(false);
    expect(m.has('d')).toBe(false);
  });

  it('uses all EIGHT managed jacks across two instances (1-6 note sets + 7 run + 8 clock)', () => {
    const m = allocateCvBuddySlots(['a', 'b']);
    const used = new Set<number>();
    for (const a of m.values()) {
      used.add(a.pitchSlot);
      used.add(a.gateSlot);
      used.add(a.velSlot);
      if (a.runSlot != null) used.add(a.runSlot);
      if (a.clockSlot != null) used.add(a.clockSlot);
    }
    expect([...used].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const s of used) expect(CV_BUDDY_MANAGED_SLOTS).toContain(s);
  });
});

describe('slotToEs9', () => {
  it('maps pitch slots {1,4} → PITCH class', () => {
    expect(slotToEs9(1)).toEqual({ port: 'out1', class: ES9_PITCH });
    expect(slotToEs9(4)).toEqual({ port: 'out4', class: ES9_PITCH });
  });
  it('maps gate slots {2,5}, RUN {7} and CLOCK {8} → GATE class', () => {
    expect(slotToEs9(2)).toEqual({ port: 'out2', class: ES9_GATE });
    expect(slotToEs9(5)).toEqual({ port: 'out5', class: ES9_GATE });
    expect(slotToEs9(7)).toEqual({ port: 'out7', class: ES9_GATE });
    expect(slotToEs9(8)).toEqual({ port: 'out8', class: ES9_GATE });
  });
  it('maps vel slots {3,6} → CV class', () => {
    expect(slotToEs9(3)).toEqual({ port: 'out3', class: ES9_CV });
    expect(slotToEs9(6)).toEqual({ port: 'out6', class: ES9_CV });
  });
  it('class constants match the es9 model (0=audio,1=cv,2=pitch,3=gate)', () => {
    expect([ES9_AUDIO, ES9_CV, ES9_PITCH, ES9_GATE]).toEqual([0, 1, 2, 3]);
  });
});

describe('slotsToReset', () => {
  const one = allocateCvBuddySlots(['a']); // slots {1,2,3,7,8}
  const two = allocateCvBuddySlots(['a', 'b']); // {1,2,3,7,8} + {4,5,6}

  it('is empty when nothing frees', () => {
    expect(slotsToReset(one, one)).toEqual([]);
    expect(slotsToReset(two, two)).toEqual([]);
  });

  it("frees the second instance's slots when it is removed (2 → 1)", () => {
    expect(slotsToReset(two, one)).toEqual([4, 5, 6]);
  });

  it('frees ALL owner slots — including RUN(7) + CLOCK(8) — when the last instance is removed (1 → 0)', () => {
    expect(slotsToReset(one, new Map<string, CvBuddyAlloc>())).toEqual([1, 2, 3, 7, 8]);
  });

  it('a lower-id survivor inheriting the owner role re-claims RUN+CLOCK (only 4,5,6 free)', () => {
    // Applied: only "b" drives its old index-1 triple {4,5,6}. Desired: "b" is
    // now the sole instance → index 0 → {1,2,3,7,8}. Slots 4,5,6 must reset;
    // RUN(7) + CLOCK(8) are now claimed by "b" so they are NOT freed.
    const applied = new Map<string, CvBuddyAlloc>([
      ['b', { pitchSlot: 4, gateSlot: 5, velSlot: 6, ownsClock: false, runSlot: null, clockSlot: null }],
    ]);
    const desired = allocateCvBuddySlots(['b']); // {1,2,3,7,8}
    expect(slotsToReset(applied, desired)).toEqual([4, 5, 6]);
  });

  it('removing the owner but keeping a survivor never frees the inherited RUN/CLOCK jacks', () => {
    const applied = new Map<string, CvBuddyAlloc>([
      ['a', { pitchSlot: 1, gateSlot: 2, velSlot: 3, ownsClock: true, runSlot: 7, clockSlot: 8 }],
      ['b', { pitchSlot: 4, gateSlot: 5, velSlot: 6, ownsClock: false, runSlot: null, clockSlot: null }],
    ]);
    const desired = allocateCvBuddySlots(['b']); // b inherits {1,2,3,7,8}
    expect(slotsToReset(applied, desired)).toEqual([4, 5, 6]);
  });
});
