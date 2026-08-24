// packages/web/src/lib/ui/modules/midiclock/midiclock-status-model.ts
//
// Every STRING the MIDICLOCK device body can produce, decided where a unit test
// can read it.
//
// ⚠ THE POINT IS THE UNPAINTED ONES. `StatusLed`'s `detail` reaches
// `aria-label` and `title` and never a text node, so it is invisible to a VRT
// baseline and to a human reviewing one — a wrong sentence there would ship
// green forever. The lamp's own correctness (lit vs dark) is a boolean the
// component owns; the sentence beside it is prose, and prose that nothing looks
// at is exactly what needs a test. `midiclock-status-model.test.ts` is that
// test, and it is the permanent negative control for this surface.
//
// PURE — no Svelte, no DOM, no engine.

import type { MidiclockCardState } from '$lib/audio/modules/midiclock';

/** One entry of the runtime device roster, as the engine reports it. */
export interface MidiclockDeviceEntry {
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
export function midiclockDeviceName(d: MidiclockDeviceEntry): string {
  const n = d.name?.trim();
  return n ? n : d.id;
}

/**
 * The MIDI lamp's sentence: is this node bound to a device, and which.
 *
 * ⚠ IT NAMES THE DEVICE, not a count of them. A count is the shape the ratchet
 * rules train you to look at twice, and here it is also the less useful half —
 * "3 inputs found" does not tell a player whether the one they can hear is the
 * one this node is listening to, which is the whole question a binder's status
 * has to answer.
 */
export function midiclockDeviceDetail(s: {
  connected: boolean;
  permissionDenied: boolean;
  devices: readonly MidiclockDeviceEntry[];
  selectedDeviceId: string | null;
}): string {
  if (!s.connected) {
    return s.permissionDenied
      ? 'not connected — this browser refused or cannot provide MIDI access'
      : 'not connected — press Connect MIDI to grant this site access';
  }
  if (s.devices.length === 0) return 'connected — no MIDI inputs found on this machine';
  const sel = s.devices.find((d) => d.id === s.selectedDeviceId);
  if (!sel) return 'connected — no input selected yet';
  return `connected — listening to ${midiclockDeviceName(sel)}`;
}

/**
 * The RUN lamp's sentence — the EXTERNAL transport's play state.
 *
 * ⚠ THIS IS THE FINDING THE DELETED `STATE: RUN/STOP` READOUT CARRIED, and it
 * is not redundant with TIMELORDE's transport. The entire premise of this module
 * is that something OUTSIDE the browser is the boss; `run` is a level a player
 * may not have patched anywhere visible, so without this lamp nothing on screen
 * would say whether the master clock is rolling.
 *
 * It is honest about the pre-connect case rather than reading "stopped": a dark
 * lamp on an unbound node means "nothing is telling us", which is a different
 * fact from "the transport is stopped" and the two must not sound alike.
 */
export function midiclockTransportDetail(s: { connected: boolean; running: boolean }): string {
  if (!s.connected) return 'external transport unknown — no MIDI device is connected';
  return s.running
    ? 'external transport RUNNING — MIDI Start or Continue was received'
    : 'external transport STOPPED — waiting for MIDI Start';
}

/** Narrowing helper so the body can pass its whole card state to either detail
 *  function without restating the shape at two call sites. */
export type MidiclockStatusInput = Pick<
  MidiclockCardState,
  'connected' | 'permissionDenied' | 'devices' | 'selectedDeviceId' | 'running'
>;
