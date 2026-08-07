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

  it('index 0 gets {1,2,3} + owns RUN(7) + CLOCK(8) + return pair in{1,2}', () => {
    const m = allocateCvBuddySlots(['a']);
    expect(m.get('a')).toEqual({
      pitchSlot: 1,
      gateSlot: 2,
      velSlot: 3,
      kind: 'full',
      ownsClock: true,
      runSlot: 7,
      clockSlot: 8,
      inPair: [1, 2],
    });
  });

  it('index 1 gets {4,5,6}, owns neither RUN nor CLOCK, return pair in{3,4}', () => {
    const m = allocateCvBuddySlots(['a', 'b']);
    expect(m.get('b')).toEqual({
      pitchSlot: 4,
      gateSlot: 5,
      velSlot: 6,
      kind: 'full',
      ownsClock: false,
      runSlot: null,
      clockSlot: null,
      inPair: [3, 4],
    });
  });

  it('return input pairs are 1st→[1,2], 2nd→[3,4] (id-sorted, collab-convergent)', () => {
    const m = allocateCvBuddySlots(['zeta', 'alpha']);
    expect(m.get('alpha')?.inPair).toEqual([1, 2]);
    expect(m.get('zeta')?.inPair).toEqual([3, 4]);
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
      if (a.velSlot != null) used.add(a.velSlot);
      if (a.runSlot != null) used.add(a.runSlot);
      if (a.clockSlot != null) used.add(a.clockSlot);
    }
    expect([...used].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const s of used) expect(CV_BUDDY_MANAGED_SLOTS).toContain(s);
  });
});

describe('slotToEs9', () => {
  it('maps pitch slots {1,4} → PITCH class', () => {
    expect(slotToEs9(1, 'pitch')).toEqual({ port: 'out1', class: ES9_PITCH });
    expect(slotToEs9(4, 'pitch')).toEqual({ port: 'out4', class: ES9_PITCH });
  });
  it('maps gate slots {2,5}, RUN {7} and CLOCK {8} → GATE class', () => {
    expect(slotToEs9(2, 'gate')).toEqual({ port: 'out2', class: ES9_GATE });
    expect(slotToEs9(5, 'gate')).toEqual({ port: 'out5', class: ES9_GATE });
    expect(slotToEs9(7, 'run')).toEqual({ port: 'out7', class: ES9_GATE });
    expect(slotToEs9(8, 'clock')).toEqual({ port: 'out8', class: ES9_GATE });
  });
  it('maps vel slots {3,6} → CV class', () => {
    expect(slotToEs9(3, 'vel')).toEqual({ port: 'out3', class: ES9_CV });
    expect(slotToEs9(6, 'vel')).toEqual({ port: 'out6', class: ES9_CV });
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
      ['b', { pitchSlot: 4, gateSlot: 5, velSlot: 6, ownsClock: false, kind: 'full' as const, runSlot: null, clockSlot: null, inPair: [3, 4] }],
    ]);
    const desired = allocateCvBuddySlots(['b']); // {1,2,3,7,8}
    expect(slotsToReset(applied, desired)).toEqual([4, 5, 6]);
  });

  it('removing the owner but keeping a survivor never frees the inherited RUN/CLOCK jacks', () => {
    const applied = new Map<string, CvBuddyAlloc>([
      ['a', { pitchSlot: 1, gateSlot: 2, velSlot: 3, ownsClock: true, kind: 'full' as const, runSlot: 7, clockSlot: 8, inPair: [1, 2] }],
      ['b', { pitchSlot: 4, gateSlot: 5, velSlot: 6, ownsClock: false, kind: 'full' as const, runSlot: null, clockSlot: null, inPair: [3, 4] }],
    ]);
    const desired = allocateCvBuddySlots(['b']); // b inherits {1,2,3,7,8}
    expect(slotsToReset(applied, desired)).toEqual([4, 5, 6]);
  });
});


describe('CV Buddy MINI — the owner\'s two rack configurations', () => {
  // A MINI drives pitch + gate only (2 ES-9 jacks), where a FULL also drives
  // velocity (3). Owner, 2026-08-07: "up to 3 of them (with 7/8 still doing
  // clock), or one of them, occupying outputs 1,2,7,8 and still have 4 free
  // channels for send-return." Both are asserted here by jack number, because
  // the whole point is which PHYSICAL outputs are left over.

  const mini = (id: string) => ({ id, kind: 'mini' as const });
  const full = (id: string) => ({ id, kind: 'full' as const });

  /** Every note jack claimed by an allocation (excludes RUN/CLOCK). */
  function noteJacks(m: Map<string, CvBuddyAlloc>): number[] {
    const s = new Set<number>();
    for (const a of m.values()) {
      s.add(a.pitchSlot); s.add(a.gateSlot);
      if (a.velSlot != null) s.add(a.velSlot);
    }
    return [...s].sort((x, y) => x - y);
  }

  it('CONFIG A — THREE minis all fit, and 7/8 are STILL the clock', () => {
    const m = allocateCvBuddySlots([mini('a'), mini('b'), mini('c')]);
    expect(m.size, 'all three are allocated').toBe(3);
    expect(m.get('a')).toMatchObject({ pitchSlot: 1, gateSlot: 2, velSlot: null, ownsClock: true, runSlot: 7, clockSlot: 8 });
    expect(m.get('b')).toMatchObject({ pitchSlot: 3, gateSlot: 4, velSlot: null, ownsClock: false });
    expect(m.get('c')).toMatchObject({ pitchSlot: 5, gateSlot: 6, velSlot: null, ownsClock: false });
    expect(noteJacks(m)).toEqual([1, 2, 3, 4, 5, 6]);
    // The headline: the transport survives three minis.
    expect(m.get('a')!.clockSlot, 'jack 8 is still the clock').toBe(8);
  });

  it('CONFIG B — ONE mini uses 1,2,7,8 and leaves FOUR jacks free for audio', () => {
    const m = allocateCvBuddySlots([mini('solo')]);
    const a = m.get('solo')!;
    expect(a).toMatchObject({ pitchSlot: 1, gateSlot: 2, velSlot: null, ownsClock: true, runSlot: 7, clockSlot: 8 });
    const used = new Set([a.pitchSlot, a.gateSlot, a.runSlot!, a.clockSlot!]);
    expect([...used].sort((x, y) => x - y), 'occupies exactly 1,2,7,8').toEqual([1, 2, 7, 8]);
    const free = CV_BUDDY_MANAGED_SLOTS.filter((j) => !used.has(j));
    expect(free, 'four channels left for send/return').toEqual([3, 4, 5, 6]);
    expect(free.length).toBe(4);
  });

  it('NO JACK IS EVER CLAIMED TWICE — the failure mode is silent wrong voltage', () => {
    // Two modules driving one DC-coupled jack produces no error, just a wrong
    // note at the hardware. Checked across every mix, not just the happy ones.
    for (const set of [
      [mini('a'), mini('b'), mini('c')],
      [full('a'), full('b')],
      [full('a'), mini('b')],
      [mini('a'), full('b')],
      [mini('a'), mini('b'), full('c')],
      [full('a'), mini('b'), mini('c'), mini('d')],
    ]) {
      const m = allocateCvBuddySlots(set);
      const all: number[] = [];
      for (const a of m.values()) {
        all.push(a.pitchSlot, a.gateSlot);
        if (a.velSlot != null) all.push(a.velSlot);
        if (a.runSlot != null) all.push(a.runSlot);
        if (a.clockSlot != null) all.push(a.clockSlot);
      }
      expect(new Set(all).size, `duplicate jack in ${set.map((x) => x.kind).join('+')}`).toBe(all.length);
      for (const j of all) expect(CV_BUDDY_MANAGED_SLOTS).toContain(j);
    }
  });

  it('BACK-COMPAT — two FULLs allocate exactly as before mini existed', () => {
    // The pre-mini contract, asserted verbatim so the generalisation cannot
    // quietly re-number an existing user's rack.
    const m = allocateCvBuddySlots(['a', 'b']); // bare ids ⇒ all full
    expect(m.get('a')).toMatchObject({ pitchSlot: 1, gateSlot: 2, velSlot: 3, ownsClock: true, kind: 'full' as const, runSlot: 7, clockSlot: 8, inPair: [1, 2] });
    expect(m.get('b')).toMatchObject({ pitchSlot: 4, gateSlot: 5, velSlot: 6, ownsClock: false, kind: 'full' as const, runSlot: null, clockSlot: null, inPair: [3, 4] });
  });

  it('over-subscription is INERT, and a mini still fits a 2-jack gap a full cannot', () => {
    // 1 full (3) + 1 full (3) fills the pool; a third gets nothing.
    expect(allocateCvBuddySlots([full('a'), full('b'), full('c')]).size).toBe(2);
    // 2 fulls leave 0 — even a mini is out.
    expect(allocateCvBuddySlots([full('a'), full('b'), mini('c')]).has('c')).toBe(false);
    // 1 full + 1 mini leaves exactly 1 jack: nothing else fits, but the pair did.
    const m = allocateCvBuddySlots([full('a'), mini('b'), mini('c')]);
    expect(m.get('a')).toMatchObject({ pitchSlot: 1, gateSlot: 2, velSlot: 3 });
    expect(m.get('b')).toMatchObject({ pitchSlot: 4, gateSlot: 5, velSlot: null });
    expect(m.has('c'), 'only one jack left — inert').toBe(false);
  });

  it('the CLOCK follows the id-smallest ALLOCATED instance, of either kind', () => {
    const m = allocateCvBuddySlots([full('b'), mini('a')]);
    expect(m.get('a')!.ownsClock, 'a sorts first, so a owns the transport').toBe(true);
    expect(m.get('b')!.ownsClock).toBe(false);
    expect(m.get('a')!.clockSlot).toBe(8);
  });

  it('slotToEs9 is ROLE-driven — a mixed layout puts the right class on each jack', () => {
    // With one full then one mini, jack 4 is a PITCH. Number-derived classing
    // (the old behaviour) would also have said pitch for 4 — so use jack 5,
    // which is a mini GATE here but was a "gate slot" by number too. Jack 3 is
    // the discriminator: vel for the full, but a mini pitch in a 3-mini rack.
    expect(slotToEs9(3, 'vel')).toEqual({ port: 'out3', class: ES9_CV });
    expect(slotToEs9(3, 'pitch'), 'same jack, different role, different class')
      .toEqual({ port: 'out3', class: ES9_PITCH });
    expect(slotToEs9(4, 'gate')).toEqual({ port: 'out4', class: ES9_GATE });
  });
});
