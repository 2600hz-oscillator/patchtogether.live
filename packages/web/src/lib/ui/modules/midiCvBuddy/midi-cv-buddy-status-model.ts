// packages/web/src/lib/ui/modules/midiCvBuddy/midi-cv-buddy-status-model.ts
//
// Every STRING the MIDI-CV-BUDDY device body can produce, decided where a unit
// test can read it.
//
// ⚠ THE POINT IS THE UNPAINTED ONES. `StatusLed`'s `detail` reaches
// `aria-label` and `title` and never a text node, so it is invisible to a VRT
// baseline and to a human reviewing one — a wrong sentence there would ship
// green forever. The lamp's own correctness (lit vs dark) is a boolean the
// component owns; the sentence beside it is prose, and prose that nothing looks
// at is exactly what needs a test. `midi-cv-buddy-status-model.test.ts` is that
// test, and it is the permanent negative control for this surface.
//
// ── WHERE THE CARD'S READOUT WENT ──────────────────────────────────────────
//
// `MidiCvBuddyCard.svelte` painted a two-row readout — `NOTE  C4` and
// `VEL  100` — and both are derived-state text, which a resting faceplate may
// not carry in any shape. They become the NOTE LAMP: a picture, lit or dark,
// with the note and the velocity in `aria-label`.
//
// ⚠ THE LAMP BINDS TO `heldCount`, NOT `lastNote`, AND THAT IS THE WHOLE
// DIFFICULTY. `lastNote` is LATCHED on purpose — the module keeps it after
// every key is released so a downstream VCO holds its pitch through the gate's
// fall — so a lamp bound to it would light on the first note of a session and
// never go dark again, which is a lamp that says nothing. `heldCount` was added
// to the card state for this; midiLane needed the identical field for the
// identical reason.
//
// ⚠ AND THE FINDING IT CARRIES IS REAL. The two ways this module disappoints —
// nothing patched to the keyboard, and a channel filter aimed at a channel the
// keyboard is not sending on — are BOTH perfectly silent, and both look exactly
// like a correct module between notes. The NOTE lamp is the only thing on the
// promoted surface that distinguishes them.
//
// PURE — no Svelte, no DOM, no engine.

import { noteNameForMidi } from '$lib/audio/note-entry';

/** One entry of the runtime device roster, as the engine reports it. */
export interface MidiCvBuddyDeviceEntry {
  id: string;
  name: string;
  state: string;
}

/**
 * What to show for one device in the picker.
 *
 * Web MIDI returns a null/absent `name` on some platforms, and a blank row is
 * unpickable — the player cannot tell two blanks apart. The engine already
 * falls back to the port id, so this is the second line of defence rather than
 * the first, and it exists because an EMPTY string survives that fallback where
 * `null` does not.
 */
export function midiCvBuddyDeviceName(d: MidiCvBuddyDeviceEntry): string {
  const n = d.name?.trim();
  return n ? n : d.id;
}

/** The subset of the card state the MIDI lamp reads. */
export interface MidiCvBuddyDeviceInput {
  connected: boolean;
  permissionDenied: boolean;
  devices: readonly MidiCvBuddyDeviceEntry[];
  selectedDeviceId: string | null;
}

/**
 * The MIDI lamp's sentence: is this node bound to a device, and which.
 *
 * ⚠ IT NAMES THE DEVICE, not a count of them. A count is the shape the ratchet
 * rules train you to look at twice, and here it is also the less useful half —
 * "3 inputs found" does not tell a player whether the one under their hands is
 * the one this node is listening to, which is the whole question a binder's
 * status has to answer.
 */
export function midiCvBuddyDeviceDetail(s: MidiCvBuddyDeviceInput): string {
  if (!s.connected) {
    return s.permissionDenied
      ? 'not connected — this browser refused or cannot provide MIDI access'
      : 'not connected — press Connect MIDI to grant this site access';
  }
  if (s.devices.length === 0) return 'connected — no MIDI inputs found on this machine';
  const sel = s.devices.find((d) => d.id === s.selectedDeviceId);
  if (!sel) return 'connected — no input selected yet';
  return `connected — listening to ${midiCvBuddyDeviceName(sel)}`;
}

/** The subset of the card state the NOTE lamp reads. */
export interface MidiCvBuddyNoteInput {
  connected: boolean;
  heldCount: number;
  lastNote: number | null;
  lastVelocity: number;
}

/**
 * The NOTE lamp's sentence — what this module is receiving RIGHT NOW.
 *
 * It is honest about the pre-connect case rather than reading "no keys held": a
 * dark lamp on an unbound node means "nothing is telling us", which is a
 * different fact from "you are not playing" and the two must not sound alike —
 * the same distinction `midiclockTransportDetail` draws.
 *
 * ⚠ The lit branch says the NOTE and the VELOCITY, which is strictly the pair
 * the deleted readout printed. The dark-but-connected branch names the LAST
 * note instead, because that is what the PITCH jack is still holding: the
 * latch is a real behaviour a player can be surprised by, and this is the only
 * place left that can explain it.
 */
export function midiCvBuddyNoteDetail(s: MidiCvBuddyNoteInput): string {
  if (!s.connected) return 'no notes — no MIDI device is connected';
  if (s.heldCount > 0) {
    const winner = s.lastNote === null ? 'a note' : noteNameForMidi(s.lastNote).toUpperCase();
    const keys = s.heldCount === 1 ? '1 key held' : `${s.heldCount} keys held`;
    return `receiving ${winner} at velocity ${s.lastVelocity} — ${keys}`;
  }
  if (s.lastNote === null) {
    return 'no notes yet — play a key on the connected device';
  }
  return `no keys held — PITCH is latched at ${noteNameForMidi(s.lastNote).toUpperCase()}`;
}

/**
 * The ERROR line, or null when nothing is wrong.
 *
 * An error is permitted resting text precisely because it is ABSENT at rest: on
 * a browser that supports Web MIDI and a user who granted it, this returns null
 * forever. The wording is the legacy card's, which covered the unsupported and
 * the refused cases in one sentence because the card could not tell them apart
 * either — `requestMIDIAccess` rejecting and `requestMIDIAccess` being absent
 * both land in the same catch.
 */
export function midiCvBuddyErrorLine(s: { permissionDenied: boolean }): string | null {
  return s.permissionDenied
    ? 'Permission denied, or this browser cannot provide Web MIDI. Chrome or Edge can.'
    : null;
}
