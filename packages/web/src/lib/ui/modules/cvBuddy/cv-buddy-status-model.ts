// packages/web/src/lib/ui/modules/cvBuddy/cv-buddy-status-model.ts
//
// The CV BUDDY status surface's pure model — every string it shows, and the one
// place a rack-global measurement is turned into words.
//
// PURE by design: no Svelte, no store, no engine. The component reads the patch
// and hands the ANSWERS here, so every sentence this face can produce is
// decidable in the unit lane rather than only in a browser. That matters more
// than usual here, because most of these strings are UNPAINTED — they live in
// `aria-label` and `title` — and an unpainted string that is wrong is invisible
// to a VRT baseline and to a human reviewing one.

import type { CvBuddyAlloc } from '$lib/audio/cv-buddy/slot-alloc';

/**
 * The slot NAME — a landmark, not a measurement, and the one thing on this
 * surface that PAINTS.
 *
 * It is the owner's own disambiguation test made literal: two CV Buddies on a
 * rack are otherwise IDENTICAL plates, and the jacks they own is the only thing
 * that tells them apart. A player with two faceplates open has no other way to
 * know which one is wired to the voice they can hear.
 *
 * `null` for an instance that got no jacks — it has no slot, so it has no name,
 * and the honest render is nothing rather than a placeholder.
 */
export function cvBuddySlotName(alloc: CvBuddyAlloc | undefined): string | null {
  if (!alloc) return null;
  return `JACKS ${alloc.pitchSlot}–${alloc.velSlot ?? alloc.gateSlot}`;
}

/** What that name means, spelled out for `aria-label`/`title`. Derived text, so
 *  it lives in an attribute and never in a text node. */
export function cvBuddySlotDetail(alloc: CvBuddyAlloc | undefined): string {
  if (!alloc) return '';
  return alloc.velSlot == null
    ? `ES-9 jacks ${alloc.pitchSlot} and ${alloc.gateSlot} carry this instance's pitch and gate.`
    : `ES-9 jacks ${alloc.pitchSlot}, ${alloc.gateSlot} and ${alloc.velSlot} carry this instance's `
      + 'pitch, gate and velocity.';
}

/** Is this instance's output actually reaching physical jacks? */
export function cvBuddyRouted(es9Present: boolean, alloc: CvBuddyAlloc | undefined): boolean {
  return es9Present && alloc != null;
}

/**
 * ⚠ THE UNROUTED / CONTENDED COLLAPSE HAPPENS HERE, DELIBERATELY, AND THIS IS
 * THE ARGUMENT FOR IT.
 *
 * The legacy card distinguished two states with two different painted
 * sentences: *"No ES-9 in rack — add an ES-9 module and run the es9-bridge
 * helper"* and *"Inert — the first two CV Buddies own the ES-9 jacks"*. The
 * face collapses them into ONE dark lamp, and the justification is ACTION
 * IDENTITY: in both states this instance's outputs reach no physical jack, and
 * in both states the fix is a change to THE RACK rather than anything on this
 * plate — add an ES-9, or remove a CV Buddy that is holding the pool. Nothing
 * the player can do HERE differs between the two.
 *
 * The evidence that separates them is also already on screen at full size:
 * whether an ES-9 exists is answered by looking at the rack, and it is the
 * ES-9's own card that carries the bridge instructions and the xrun counter.
 * Painting two sentences here duplicated that, in the one place the
 * resting-text ruling forbids prose.
 *
 * ⚠ AND THE DISTINCTION IS NOT LOST, IT IS MOVED: the two states return
 * DIFFERENT detail strings, so the hover, the accessible name and every spec
 * can still tell them apart. That is the same home the deleted readouts moved
 * to, which is why nothing had to be weakened to make this collapse.
 */
export function cvBuddyRoutedDetail(
  es9Present: boolean,
  alloc: CvBuddyAlloc | undefined,
): string {
  if (cvBuddyRouted(es9Present, alloc)) return cvBuddySlotDetail(alloc);
  if (!es9Present) {
    return 'Not routed: no ES-9 in this rack. Add an ES-9 module and run the es9-bridge helper.';
  }
  return 'Not routed: every ES-9 note jack is already allocated to other CV Buddies on this rack.';
}

/** Which mechanism drives the RUN + CLOCK jacks — mirrors
 *  `CvBuddyClockHealth.driver` (cv-buddy.ts read('clockHealth')). */
export type CvBuddyClockDriver = 'worklet' | 'main';

/**
 * The late-tick counter, as words for the lamp's `title` / `aria-label`.
 *
 * ⚠ A ZERO IS INFORMATION, and the card's own comment argued it must always
 * render or "healthy" and "not instrumented" would look identical. The lamp
 * keeps that property and states it BETTER: a lamp that is present and DARK is
 * exactly what "instrumented, and healthy" looks like, with no text at all. The
 * count itself is a measurement, so it goes here rather than onto the plate.
 *
 * The two-instrument sentence is repeated in every branch on purpose — this
 * string is the only place a player is told that `skips` and the ES-9 card's
 * `xruns` have OPPOSITE fixes, and that is the whole diagnostic value of
 * either number.
 *
 * ⚠ THE DRIVER CHANGES WHAT A RISING COUNT MEANS, so it changes the sentence.
 * Under the 'worklet' driver (every real browser) the CLOCK jack is emitted on
 * the audio thread and a main-thread stall costs NOTHING at the jack — the
 * counter keeps rising because it still measures the stalls themselves, which
 * is exactly the number that tells a UI stall from an ES-9 underrun. Under the
 * 'main' driver (test/SSR, or a context whose worklet failed to load) a rising
 * count means what it always meant: pulses the jack never carried.
 */
export function cvBuddySkipDetail(skips: number, driver: CvBuddyClockDriver = 'main'): string {
  const tail =
    'Rising here means a main-thread stall; rising xruns on the ES-9 card instead means the jack '
    + 'is starving. Neither means look elsewhere.';
  if (driver === 'worklet') {
    if (skips <= 0) {
      return `No main-thread stalls since this node was created. The clock itself is generated on `
        + `the audio thread, so a stall would delay nothing at the jack. ${tail}`;
    }
    return `${skips} clock pulse${skips === 1 ? '' : 's'} came due during a main-thread stall — the `
      + `audio-thread clock still emitted ${skips === 1 ? 'it' : 'them'}, so nothing was lost at `
      + `the jack. ${tail}`;
  }
  if (skips <= 0) return `No late clock pulses since this node was created. ${tail}`;
  return `${skips} clock pulse${skips === 1 ? '' : 's'} a late scheduler tick could not place. ${tail}`;
}
