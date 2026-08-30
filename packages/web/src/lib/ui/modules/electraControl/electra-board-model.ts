// packages/web/src/lib/ui/modules/electraControl/electra-board-model.ts
//
// THE BOARD'S ACCESSIBLE NAMES — the sentences `ElectraGridBody.svelte` speaks
// and never paints.
//
// ── WHY THIS IS A MODULE AND NOT AN INLINE TEMPLATE EXPRESSION ──────────────
//
// Two reasons, and the first one is a GATE.
//
// 1. `face-rack-status-source.test.ts` gives the `control-grid` role a leg that
//    no other role has: whatever expression is bound to `aria-label={…}` must
//    NOT also appear as a bare text mustache. It is the resting-text ruling
//    wearing its own mechanism as a disguise — an author who writes
//    `aria-label={slotName}` beside `>{slotName}<` has satisfied the letter of
//    "the sentence is speakable" while painting it anyway. Routing every
//    accessible name through this file makes the two expressions STRUCTURALLY
//    different rather than accidentally so, which is the fix `gamepad`'s entry
//    records for the same leg.
// 2. A sentence assembled in markup is a sentence no unit test can reach. These
//    are pinned in `electracontrol-face-model.test.ts` against the SAME firmware
//    coordinates `graph/electra-control.test.ts` anchors, so the board and the
//    preset generator cannot drift about what a slot IS.
//
// ⚠ THE FIRMWARE COORDINATE IS THE POINT OF THE SLOT NAME. A player's hands are
// on a physical pot, and the grid position only IMPLIES which one: the storage
// order is row-major but the firmware's walk is not (odd rows are pots 1-6, even
// rows are pots 7-12 of the SAME control set — see the header of
// `$lib/graph/electra-control.ts`, which says in terms not to derive it from a
// naive `floor(slot/12)`). So the name says both, and it is derived HERE from
// `electraPosOf` rather than re-typed — the same one-source rule that keeps
// `push-electra-model.ts` re-exporting the geometry instead of re-deriving 6.
//
// ⚠ THESE ARE NAMES, NOT MEASUREMENTS, which is what makes them permitted at
// all. "Row 3 knob 4, control set 2 pot 10" disambiguates one control's own
// position among thirty-six identical ones — the fourth item on the resting-text
// ruling's permitted list — and it lives on `aria-label` because `<Knob>`'s own
// `aria-valuetext` already carries the VALUE. Nothing here is a state word, a
// reading or a count.

import { electraPosOf } from '$lib/graph/electra-control';

/** The firmware coordinate, spoken. `Row 2 knob 2, control set 1 pot 8`. */
export function slotPositionName(row: number, knob: number): string {
  const { controlSetId, potId } = electraPosOf(row, knob);
  return `Row ${row} knob ${knob}, control set ${controlSetId} pot ${potId}`;
}

// ⚠ A FILLED SLOT'S KNOB KEEPS THE CARD'S ACCESSIBLE NAME — its own label — and
// does NOT gain the coordinate. `Knob.svelte` derives `aria-label` from its
// `label` prop and exposes no override, so putting the coordinate there would
// mean adding a prop to the primitive every faced module in the fleet renders.
// That is a platform change, and a face PR is the wrong place to make one for a
// nicety. A filled slot already has a disambiguating NAME (the source param's
// label, or the user's typed one) and its VALUE on `aria-valuetext`; the slot
// whose place was genuinely unspeakable is the EMPTY one, which is what
// `emptySlotName` below fixes. Recorded so the omission reads as a decision
// rather than an oversight.

/**
 * The accessible name of an EMPTY slot.
 *
 * ⚠ THE CARD MARKED THESE `aria-hidden="true"`, AND THAT IS THE ONE BEHAVIOUR
 * THIS PORT DELIBERATELY CHANGES. An empty slot is a PLACE, not an absence —
 * that is the whole reason the card enumerates all thirty-six from `(row, knob)`
 * rather than from the data. A board where thirty of its thirty-six places are
 * unspeakable is a board a screen reader cannot describe at all, while the
 * sighted player sees a complete 6×6 map of their hardware. This is not keyboard
 * a11y (which the owner has ruled out): it is the accessible NAME of an element
 * that is already rendered, which every other cell on this board carries.
 */
export function emptySlotName(row: number, knob: number): string {
  return `${slotPositionName(row, knob)} — empty`;
}

/** The accessible name of the board container. */
export function boardName(assigned: number): string {
  // ⚠ A COUNT, AND THEREFORE DERIVED — permitted only because it is in an
  // accessible name and never painted. It is computed from the live slot map by
  // the caller, never typed.
  return `Electra One board — 6 rows of 6, ${assigned} assigned`;
}
