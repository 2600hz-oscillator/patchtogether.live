// packages/web/src/lib/ui/modules/cvBuddy/cv-buddy-status-model.test.ts
//
// Every string the CV BUDDY status surface can produce.
//
// ⚠ MOST OF THESE ARE NEVER PAINTED — they are `aria-label` and `title` — and
// that is exactly why they are tested here rather than left to the browser. An
// unpainted string is invisible to a VRT baseline and to a human reviewing one,
// so "the hover says the wrong thing" has no other detector. It is also the
// half that carries the whole parity argument: the ruling moved these sentences
// off the plate, and this file is what proves they still EXIST.

import { describe, expect, it } from 'vitest';
import {
  cvBuddyRouted,
  cvBuddyRoutedDetail,
  cvBuddyLateLampLit,
  cvBuddySkipDetail,
  cvBuddySlotDetail,
  cvBuddySlotName,
} from './cv-buddy-status-model';
import { allocateCvBuddySlots } from '$lib/audio/cv-buddy/slot-alloc';

/** A real allocation from the real allocator — never a hand-built literal, so
 *  a change to the slot rule moves these expectations with it. */
function allocOf(kinds: ('full' | 'mini')[], which: number) {
  const ids = kinds.map((_, i) => `n-${i}`);
  const map = allocateCvBuddySlots(ids.map((id, i) => ({ id, kind: kinds[i]! })));
  return map.get(ids[which]!);
}

describe('the slot NAME — the one thing that paints', () => {
  it('names the full kind\'s three jacks', () => {
    expect(cvBuddySlotName(allocOf(['full'], 0))).toBe('JACKS 1–3');
  });

  it('names the mini\'s two', () => {
    expect(cvBuddySlotName(allocOf(['mini'], 0))).toBe('JACKS 1–2');
  });

  it('follows the pool across a MIXED rack', () => {
    // 1 full + 1 mini → {1,2,3} then {4,5}. The second plate's name is what
    // distinguishes it from the first, which is the entire reason it paints.
    expect(cvBuddySlotName(allocOf(['full', 'mini'], 0))).toBe('JACKS 1–3');
    expect(cvBuddySlotName(allocOf(['full', 'mini'], 1))).toBe('JACKS 4–5');
  });

  it('is NULL for an instance that got no jacks — no slot, no name', () => {
    // 3 fulls need 9 note jacks and 6 exist, so the third is inert. A
    // placeholder here would be a state word; nothing is the honest render.
    expect(allocOf(['full', 'full', 'full'], 2)).toBeUndefined();
    expect(cvBuddySlotName(undefined)).toBeNull();
  });

  it('⚠ contains NO state word — it is a name, and it is identical in every state', () => {
    // The name must not become "JACKS 1–3 (routed)". It is a landmark; whether
    // those jacks reach hardware is the lamp's job.
    const name = cvBuddySlotName(allocOf(['full'], 0))!;
    expect(name).not.toMatch(/routed|inert|no |missing|ok\b/i);
  });
});

describe('the slot DETAIL — unpainted, and it names the ROLES', () => {
  it('spells out three roles for a full instance', () => {
    expect(cvBuddySlotDetail(allocOf(['full'], 0))).toContain('pitch, gate and velocity');
  });

  it('spells out two for a mini — the absence IS the feature', () => {
    const d = cvBuddySlotDetail(allocOf(['mini'], 0));
    expect(d).toContain('pitch and gate');
    expect(d, 'a mini has no velocity jack at all').not.toContain('velocity');
  });

  it('is empty for an unallocated instance', () => {
    expect(cvBuddySlotDetail(undefined)).toBe('');
  });
});

describe('⚠ the UNROUTED / CONTENDED collapse', () => {
  const allocated = allocOf(['full'], 0);

  it('lights ONLY when an ES-9 exists AND this instance has jacks', () => {
    expect(cvBuddyRouted(true, allocated)).toBe(true);
    expect(cvBuddyRouted(false, allocated)).toBe(false);
    expect(cvBuddyRouted(true, undefined)).toBe(false);
    expect(cvBuddyRouted(false, undefined)).toBe(false);
  });

  it('⚠ THE TWO DARK STATES REMAIN DISTINGUISHABLE — the collapse is visual only', () => {
    // This is the assertion that makes the action-identity argument honest. The
    // LAMP collapses two states into one picture; the DETAIL does not. If these
    // two strings ever became equal, the card's information really would have
    // been lost rather than moved, and the argument in the model's header would
    // be false.
    const noEs9 = cvBuddyRoutedDetail(false, allocated);
    const contended = cvBuddyRoutedDetail(true, undefined);
    expect(noEs9).not.toBe(contended);
    expect(noEs9).toMatch(/no ES-9/i);
    expect(contended).toMatch(/already allocated/i);
    // …and both say the same true thing first, which is what the lamp shows.
    expect(noEs9.startsWith('Not routed')).toBe(true);
    expect(contended.startsWith('Not routed')).toBe(true);
  });

  it('carries the ACTION for each state — the card\'s prose, moved not deleted', () => {
    // The legacy card told the player what to do. That instruction survives, in
    // the attribute rather than on the plate.
    expect(cvBuddyRoutedDetail(false, allocated)).toContain('es9-bridge helper');
    expect(cvBuddyRoutedDetail(true, undefined)).toContain('other CV Buddies');
  });

  it('when routed, the detail IS the slot detail — one truth, not a second sentence', () => {
    expect(cvBuddyRoutedDetail(true, allocated)).toBe(cvBuddySlotDetail(allocated));
  });
});

describe('the LATE lamp\'s detail — a count that never paints', () => {
  it('a ZERO still says something — "instrumented AND healthy"', () => {
    // The card's own comment argued a zero must always render or "healthy" and
    // "not instrumented" look identical. The lamp keeps that by being PRESENT
    // and dark; this string is what a hover adds.
    const d = cvBuddySkipDetail(0);
    expect(d).toMatch(/No late clock pulses/);
    expect(d, 'a zero must not be printed as a number').not.toMatch(/\b0\b/);
  });

  it('a non-zero count reaches the string, singular and plural', () => {
    expect(cvBuddySkipDetail(1)).toContain('1 clock pulse a late scheduler tick');
    expect(cvBuddySkipDetail(7)).toContain('7 clock pulses a late scheduler tick');
  });

  it('⚠ BOTH branches name the OTHER instrument — the diagnostic is the PAIR', () => {
    // `skips` and the ES-9 card's `xruns` have OPPOSITE fixes, and this string
    // is the only place a player is told so. Dropping it from the healthy
    // branch would make the pairing discoverable only after something broke.
    for (const n of [0, 1, 42]) {
      expect(cvBuddySkipDetail(n)).toMatch(/xruns on the ES-9 card/);
      expect(cvBuddySkipDetail(n)).toMatch(/main-thread stall/);
    }
  });

  it('NEGATIVE CONTROL: a negative count reads as the healthy branch, not as a number', () => {
    // `read('state')` returning something odd must not produce "-3 clock pulses".
    expect(cvBuddySkipDetail(-3)).toBe(cvBuddySkipDetail(0));
  });

  it("the 'worklet' driver never claims a loss — the audio-thread clock absorbed the stall", () => {
    // Under the cv-clock worklet a rising count measures main-thread stalls
    // the jack never felt. The 'main' text ("could not place") would be a
    // false alarm about pulses that WERE emitted.
    const d = cvBuddySkipDetail(3, 'worklet');
    expect(d).toContain('3 clock pulses');
    expect(d).toMatch(/audio-thread clock still emitted/);
    expect(d).not.toMatch(/could not place/);
    expect(cvBuddySkipDetail(1, 'worklet')).toContain('1 clock pulse came due');
  });

  it("the 'worklet' healthy branch says WHY a stall would be harmless", () => {
    const d = cvBuddySkipDetail(0, 'worklet');
    expect(d).toMatch(/generated on the audio thread/);
    expect(d, 'a zero must not be printed as a number').not.toMatch(/\b0\b/);
  });

  it('⚠ the two-instrument pairing survives under BOTH drivers', () => {
    for (const n of [0, 1, 42]) {
      for (const driver of ['worklet', 'main'] as const) {
        expect(cvBuddySkipDetail(n, driver)).toMatch(/xruns on the ES-9 card/);
        expect(cvBuddySkipDetail(n, driver)).toMatch(/main-thread stall/);
      }
    }
  });

  it("the default driver is 'main' — the existing card contract is unchanged", () => {
    expect(cvBuddySkipDetail(7)).toBe(cvBuddySkipDetail(7, 'main'));
  });

  it('a REAL worklet drop overrides the absorbed-stall sentence — a lit lamp never hovers "nothing was lost"', () => {
    const d = cvBuddySkipDetail(3, 'worklet', 2);
    expect(d).toContain('2 clock pulses dropped by the audio-thread clock');
    expect(d).not.toMatch(/nothing was lost/);
    expect(d).toMatch(/xruns on the ES-9 card/);
    expect(cvBuddySkipDetail(0, 'worklet', 1)).toContain('1 clock pulse dropped');
  });
});

describe("the LATE lamp's PAINTED state — deterministic at rest (the #2343 vrt catch)", () => {
  // The shadow `skips` counter tracks main-thread stalls, i.e. the RUNNER'S
  // load average. Painting it on a resting face made `face-cvBuddy-dock`
  // capture lit-or-dark boot-to-boot on contended VRT shards. Under the
  // 'worklet' driver the lamp therefore follows workletSkips — pulses the
  // audio-thread clock ITSELF dropped — which is 0 at rest, always.

  it("'worklet' driver: ambient stalls do NOT light the lamp, real drops DO", () => {
    expect(cvBuddyLateLampLit('worklet', 0, 0)).toBe(false);
    expect(cvBuddyLateLampLit('worklet', 42, 0)).toBe(false); // a stalled boot paints DARK
    expect(cvBuddyLateLampLit('worklet', 0, 1)).toBe(true); // a real hole paints LIT
    expect(cvBuddyLateLampLit('worklet', 42, 1)).toBe(true);
  });

  it("'main' driver: every skip IS a lost pulse, so the old predicate stands", () => {
    expect(cvBuddyLateLampLit('main', 0, 0)).toBe(false);
    expect(cvBuddyLateLampLit('main', 1, 0)).toBe(true);
  });

  it('DETERMINISM: at rest (no real drops) the paint is dark under both drivers and any stall count', () => {
    for (const skips of [0, 1, 9, 240]) {
      expect(cvBuddyLateLampLit('worklet', skips, 0)).toBe(false);
    }
    expect(cvBuddyLateLampLit('main', 0, 0)).toBe(false);
  });

  it('the lamp and its sentence AGREE: lit ⇒ the hover names a loss', () => {
    // The pair the component renders together, checked as a pair: whenever the
    // predicate lights, the detail must not read as the healthy/absorbed text.
    for (const [driver, skips, ws] of [
      ['worklet', 0, 1],
      ['worklet', 9, 3],
      ['main', 1, 0],
    ] as const) {
      expect(cvBuddyLateLampLit(driver, skips, ws)).toBe(true);
      const d = cvBuddySkipDetail(skips, driver, ws);
      expect(d).toMatch(/dropped|could not place/);
      expect(d).not.toMatch(/nothing was lost|No late|No main-thread stalls/);
    }
  });
});
