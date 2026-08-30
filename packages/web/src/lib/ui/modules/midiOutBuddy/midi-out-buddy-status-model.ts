// packages/web/src/lib/ui/modules/midiOutBuddy/midi-out-buddy-status-model.ts
//
// Every STRING the MIDI-OUT-BUDDY device body can produce, decided where a unit
// test can read it.
//
// ⚠ THE POINT IS THE UNPAINTED ONES. `StatusLed`'s `detail` reaches
// `aria-label` and `title` and never a text node, so it is invisible to a VRT
// baseline and to a human reviewing one — a wrong sentence there would ship
// green forever. `midi-out-buddy-status-model.test.ts` is the permanent
// negative control for this surface.
//
// ── WHERE THE CARD'S TEXT WENT, AND WHY EACH MOVE IS FORCED ────────────────
//
// `MidiOutBuddyCard.svelte` painted three things that a resting faceplate may
// not carry, because the ruling permits the module NAME, section LABELS,
// control CAPTIONS and option/landmark NAMES and nothing else:
//
//   | the card painted | where it is now |
//   |---|---|
//   | `NOTE  C4` + a lit dot | the SEND lamp: `lit` IS the dot, and the note is its `detail` |
//   | `↯ CH 7 ≠ LANE 3` in a violet badge, plus a violet outline on the whole card | the LANE lamp, `tone="warn"`, whose `detail` is the badge's own `title` sentence |
//   | the access-failure message | an ERROR line, absent whenever nothing is wrong |
//
// ⚠ THE LANE WARNING IS THE AFFORDANCE MOST AT RISK IN THIS PROMOTION, so be
// exact about what survives. It is not decoration: a module in lane 3 sending
// on channel 7 is a REAL divergence with a real consequence (the clip lane
// drives it, and a different synth hears it), and the card's whole violet
// treatment existed so that reads at a glance. `lit` carries the same fact as a
// picture at rest, `tone="warn"` carries the "this is a fault, not a readiness"
// half in colour rather than text, and the sentence — including HOW to undo it
// — is the `detail`, which `StatusLed` puts in both `aria-label` and `title`.
// That is the route the ruling names for exactly this class.
//
// ⚠ THE VIOLET IS NOT PORTED, AND THAT IS DELIBERATE RATHER THAN A LOSS.
// `--cable-video` means CABLE DOMAIN everywhere else in the product; the card
// borrowed it as "the only purple in the token set", which is a collision the
// rear-card direction rules already refuse (`rear-direction.test.ts` fails any
// rule that assigns a domain hue to a non-domain meaning). The lamp's `warn`
// amber is the app's own fault colour and says the same thing without spending
// a domain hue on it.
//
// PURE — no Svelte, no DOM, no engine.

import { noteNameForMidi } from '$lib/audio/note-entry';

/** One entry of the runtime OUTPUT roster, as the engine reports it. */
export interface MidiOutBuddyPortEntry {
  id: string;
  name: string;
  state: string;
}

/**
 * What to show for one output port in the picker.
 *
 * Web MIDI returns a null/absent `name` on some platforms and a blank row is
 * unpickable — the player cannot tell two blanks apart. The engine already
 * falls back to the port id, so this is the second line of defence; it exists
 * because an EMPTY string survives that fallback where `null` does not.
 */
export function midiOutBuddyPortName(d: MidiOutBuddyPortEntry): string {
  const n = d.name?.trim();
  return n ? n : d.id;
}

/** The subset of the card state the MIDI lamp reads. */
export interface MidiOutBuddyPortInput {
  connected: boolean;
  permissionDenied: boolean;
  devices: readonly MidiOutBuddyPortEntry[];
  selectedDeviceId: string | null;
}

/**
 * The MIDI lamp's sentence: is this node bound to an output port, and which.
 *
 * ⚠ IT NAMES THE PORT, not a count of them — "3 outputs found" does not tell a
 * player whether the synth they can hear is the one this node is sending to,
 * which is the whole question a binder's status has to answer.
 */
export function midiOutBuddyPortDetail(s: MidiOutBuddyPortInput): string {
  if (!s.connected) {
    return s.permissionDenied
      ? 'not connected — this browser refused or cannot provide MIDI access'
      : 'not connected — press Connect MIDI to grant this site access';
  }
  if (s.devices.length === 0) return 'connected — no MIDI outputs found on this machine';
  const sel = s.devices.find((d) => d.id === s.selectedDeviceId);
  if (!sel) return 'connected — no output selected yet';
  return `connected — sending to ${midiOutBuddyPortName(sel)}`;
}

/** The subset of the card state the SEND lamp reads. */
export interface MidiOutBuddySendInput {
  connected: boolean;
  channel: number;
  activeNote: number | null;
}

/**
 * The SEND lamp's sentence — is a note sounding on the external instrument.
 *
 * ⚠ NOT LATCHED, unlike the sibling module's. `activeNote` is the tracker's
 * `soundingNote`: it is set on the Note On this module sent and cleared on the
 * matching Note Off, so the lamp really does follow the note rather than
 * reporting the last one forever. That is why this one needs no companion field
 * where MIDI-CV-BUDDY's NOTE lamp needed `heldCount`.
 *
 * It names the CHANNEL in every branch, because "nothing is happening" and
 * "everything is happening on a channel your synth is not listening to" are the
 * two states this module is most often in, and they are indistinguishable
 * without it.
 */
export function midiOutBuddySendDetail(s: MidiOutBuddySendInput): string {
  if (!s.connected) return 'sending nothing — no MIDI output is connected';
  if (s.activeNote === null) {
    return `idle on channel ${s.channel} — waiting for a gate on the inputs`;
  }
  return `sending ${noteNameForMidi(s.activeNote).toUpperCase()} on channel ${s.channel}`;
}

/** What the LANE lamp knows: where the module lives and where it sends. */
export interface MidiOutBuddyLaneInput {
  /** The workflow channel column this node belongs to, or null on free canvas. */
  laneChannel: number | null;
  /** The channel MIDI is actually sent on. */
  channel: number;
}

/**
 * True when the module sits in a lane but sends somewhere else — the condition
 * the legacy card painted violet.
 *
 * ⚠ DERIVED HERE FROM THE SAME TWO SCALARS THE ENGINE USES, never re-computed
 * from `node.data` a second way. The def owns `isMidiOutChannelOverridden`; the
 * body passes it in, and this function exists so the LAMP's inputs and its
 * SENTENCE cannot drift apart.
 */
export function midiOutBuddyLaneDiverged(v: MidiOutBuddyLaneInput): boolean {
  return v.laneChannel !== null && v.laneChannel !== v.channel;
}

/**
 * The LANE lamp's sentence — the card's `↯ CH n ≠ LANE m` badge and its hover
 * title, fused into the one sentence the lamp cannot draw.
 *
 * ⚠ It never restates the lamp. `lit` already says "this module routes off its
 * lane"; this says WHICH two numbers disagree and HOW to make them agree again,
 * which a two-state picture structurally cannot carry.
 *
 * The un-diverged branches are not filler: a lamp with no `detail` announces
 * only its caption, and "LANE, off" is ambiguous between "it follows its lane"
 * and "it has no lane" — two different facts a player acts on differently.
 */
export function midiOutBuddyLaneDetail(v: MidiOutBuddyLaneInput): string {
  if (v.laneChannel === null) {
    return `not in a channel lane — MIDI goes out on channel ${v.channel}`;
  }
  if (!midiOutBuddyLaneDiverged(v)) {
    return `following lane ${v.laneChannel} — MIDI goes out on that channel`;
  }
  return (
    `MIDI is sent on channel ${v.channel}, but this module lives in lane ${v.laneChannel}. `
    + `Set CH back to ${v.laneChannel} to follow the lane.`
  );
}

/**
 * The ERROR line, or null when nothing is wrong.
 *
 * ⚠ IT STAYS LOUD, and the legacy card's own comment is the reason: *"The old
 * copy was a one-line hint swap that a user reading a dead button did not
 * register — and the suppressed-prompt case produced NO message at all."* The
 * string comes from the shared `midiOutcomeMessage` seam through the card
 * state, which always yields a nameable outcome including the case where the
 * browser silently declined to show a prompt. An error is permitted resting
 * text precisely because it is ABSENT whenever nothing is wrong.
 */
export function midiOutBuddyErrorLine(s: { accessMessage: string }): string | null {
  const m = s.accessMessage?.trim();
  return m ? m : null;
}
