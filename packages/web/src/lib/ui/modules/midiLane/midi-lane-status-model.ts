// packages/web/src/lib/ui/modules/midiLane/midi-lane-status-model.ts
//
// Every STRING the MIDI LANE device body can produce, decided here rather than
// inline in the component — including the ones that are never painted.
//
// The reason is `MidiclockDeviceBody.svelte`'s and it is worth carrying: an
// UNPAINTED string that is wrong is invisible to a VRT baseline and to a human
// reading one. These all end up on a `StatusLed`'s `detail` (its `aria-label` /
// `title`), which is exactly the place the resting-text ruling sends a
// measurement — speakable and assertable, never a text node. So they need a
// unit test, and a unit test needs them out of the markup.

import { noteNameForMidi } from '$lib/audio/note-entry';
import type { MidiLaneCardState } from '$lib/audio/modules/midi-lane';

/** A device's display name, falling back to its id when the browser gives no
 *  name (a real case on some Windows drivers). */
export function midiLaneDeviceName(d: { id: string; name: string }): string {
  const n = d.name.trim();
  return n === '' ? d.id : n;
}

/** The MIDI lamp's detail: whether access is granted and which device this lane
 *  is listening to. */
export function midiLaneDeviceDetail(s: MidiLaneCardState): string {
  if (!s.connected) {
    return s.permissionDenied
      ? 'MIDI access was refused, or this browser has no Web MIDI'
      : 'MIDI access not granted yet — press Connect MIDI';
  }
  if (s.devices.length === 0) return 'MIDI access granted, but no input device was found';
  const sel = s.devices.find((d) => d.id === s.selectedDeviceId);
  if (!sel) return 'MIDI access granted — no device chosen for this lane yet';
  return `listening to ${midiLaneDeviceName(sel)}`;
}

/**
 * The NOTE lamp's detail — how many keys are held on this lane, and what the
 * most recent one was.
 *
 * ⚠ IT READS `heldCount`, NOT `lastNote`, AND THAT IS THE WHOLE POINT OF THE
 * FIELD. `lastNote` is latched: the engine assigns it on note-on and never
 * clears it, so a lamp bound to it lights on the first note of the session and
 * stays lit forever. `heldCount` is `heldStack.length`, maintained on both
 * edges, so the lamp goes dark when the player lifts their hands — which is the
 * only thing that makes it an indicator rather than a decoration.
 */
export function midiLaneNoteDetail(s: MidiLaneCardState): string {
  if (s.heldCount <= 0) return 'no key held on this lane';
  const name = s.lastNote === null ? '' : noteNameForMidi(s.lastNote).toUpperCase();
  const held = s.heldCount === 1 ? '1 key held' : `${s.heldCount} keys held`;
  if (name === '') return `${held} on this lane`;
  return `${held} on this lane, last ${name} at velocity ${s.lastVelocity}`;
}

/**
 * A CC tap lamp's detail. `assigned` is the bound controller number (null when
 * the tap follows nothing) and `learning` is whether this tap is armed and
 * waiting for the next controller message.
 *
 * ⚠ ARMED BEATS BOUND in the wording, because arming is the transient state a
 * player is standing in the middle of: they have pressed LEARN and are about to
 * move something, and what they need to know is that the lane is listening.
 */
export function midiLaneCcDetail(
  tap: 'A' | 'B',
  assigned: number | null,
  learning: boolean,
  lastValue: number | null,
): string {
  if (learning) return `CC ${tap} — armed; move a controller to bind the next number that arrives`;
  if (assigned === null) return `CC ${tap} — not assigned; press LEARN ${tap} and move a controller`;
  const seen = lastValue === null ? 'nothing received yet' : `last value ${lastValue}`;
  return `CC ${tap} — following controller ${assigned}, ${seen}`;
}

/** Is a CC tap doing anything at all — bound, or armed and waiting? The lamp's
 *  `lit`, so it is decided beside the sentence that explains it. */
export function midiLaneCcLit(assigned: number | null, learning: boolean): boolean {
  return learning || assigned !== null;
}
