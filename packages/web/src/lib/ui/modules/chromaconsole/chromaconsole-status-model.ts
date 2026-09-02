// packages/web/src/lib/ui/modules/chromaconsole/chromaconsole-status-model.ts
//
// EVERY STRING THE CHROMA CONSOLE'S DEVICE BODY CAN PRODUCE — including the
// ones that are never painted.
//
// The ptzcam / midiclock discipline: an unpainted string that is wrong is
// invisible to a VRT baseline AND to a human reading one, so the sentences are
// decided here, where a unit test can read them, rather than inline in markup.
//
// ⚠ THE SPLIT THIS FILE ENFORCES. On a `readBack: 'none'` device the difference
// between a NAME and a MEASUREMENT is the difference between a legal caption and
// a resting readout, and it is easy to blur:
//
//   PAINTED (a name)      the assigned control's own label — `tilt`, `time`,
//                         `bypass · character`. It changes when the ASSIGNMENT
//                         changes, never when the value does.
//   NOT PAINTED (a value) what the app last sent. There is no readout on this
//                         surface at all: `formatControlValue` is the card's,
//                         and the face deletes it under the 2026-08-17 ruling.
//
// So every function below returns either a name (safe to paint) or a `detail`
// sentence (StatusLed / aria-label only), and the two are separate exports so a
// call site cannot reach for the wrong one by accident.

import type { DeviceStatus } from '$lib/devices/device-module';
import type { DeviceControl, ResolvedSlot } from '$lib/devices/device-descriptor';

/** One slot as the board paints it. */
export interface SlotChip {
  /** The ParamDef id backing this slot (`slot1`…). */
  slotId: string;
  /** 0-based position, for the fallback caption. */
  index: number;
  /** The assigned control, when the id resolves. */
  control: DeviceControl | undefined;
  /** PAINTED. The assigned control's short name, or `slot N` when empty. */
  name: string;
  /** PAINTED as a `·snap` marker beside the name — see `snapNote`. */
  snapped: boolean;
  /** A saved assignment that no longer resolves. */
  stale: boolean;
  /** NOT PAINTED. The whole sentence, for the chip's accessible name. */
  detail: string;
}

/**
 * A slot caption short enough for a board cell.
 *
 * The descriptor's labels are QUALIFIED for the assignment picker, where the
 * distinction matters (`amount · character` vs `effect vol · character`). On the
 * board the qualifier is already in the picker directly behind the chip, and the
 * full string overlaps its neighbours at this width — which is worse than
 * shortening it.
 *
 * ⚠ ONE IMPLEMENTATION, TWO SURFACES. The legacy card had this arithmetic
 * inline (`knobLabel`); the face body needs the same answer, and a hand-copy is
 * how the two would drift. It is exported for both.
 */
export function chromaconsoleSlotName(
  control: DeviceControl | undefined,
  index: number,
): string {
  if (!control) return `slot ${index + 1}`;
  const parts = control.label.split('·');
  return (parts.at(-1) ?? control.label).trim();
}

/**
 * The sentence for one slot chip — what it drives, on which controller, and
 * whether the pedal will snap it.
 *
 * ⚠ IT NAMES NO VALUE. The chip says WHAT the slot is, never where it is set;
 * the knob cell in the band below is where the position lives, and its own
 * `aria-valuetext` is where that number is speakable.
 */
export function chromaconsoleSlotDetail(slot: ResolvedSlot, index: number): string {
  const n = index + 1;
  if (slot.stale) {
    return (
      `slot ${n} points at "${slot.controlId}", which this device no longer has. `
      + 'Automation is still writing into it and nothing is reaching the pedal — reassign it.'
    );
  }
  if (!slot.control) return `slot ${n} is unassigned and sends nothing.`;
  const cc =
    slot.control.resolution === 14
      ? `CC ${slot.control.cc} (14-bit, LSB on CC ${slot.control.cc + 32})`
      : `CC ${slot.control.cc}`;
  const snap = slot.control.quantize ? ` ${slot.control.quantize.note}` : '';
  return `slot ${n} drives ${slot.control.label} on ${cc}. ${slot.control.doc}${snap}`;
}

/** The board's eight chips, in slot order. */
export function chromaconsoleSlotChips(slots: readonly ResolvedSlot[]): SlotChip[] {
  return slots.map((slot, index) => ({
    slotId: slot.slotId,
    index,
    control: slot.control,
    name: chromaconsoleSlotName(slot.control, index),
    snapped: !!slot.control?.quantize,
    stale: slot.stale,
    detail: chromaconsoleSlotDetail(slot, index),
  }));
}

/**
 * The LINK lamp's sentence. Lit means A PORT IS SELECTED and nothing more —
 * never that the pedal is there, powered, on this channel, or holding these
 * values. The card's header is emphatic about this and the face inherits it:
 * there is no "synced" state to show, because the device cannot be asked.
 */
export function chromaconsoleLinkDetail(status: DeviceStatus): string {
  if (!status.connected) {
    return (
      'No MIDI output selected, so nothing is being transmitted. Press Connect MIDI to grant '
      + 'access, then pick the pedal in the output list.'
    );
  }
  return (
    `Sending to ${status.portName ?? status.portId} on channel ${status.channel}. `
    + 'The pedal cannot report back, so this says what has been sent, not what the pedal holds.'
  );
}

/** The board's own accessible name — how many of the eight are assigned, and
 *  how many have gone stale. A DERIVED count, so it is spoken and not painted. */
export function chromaconsoleBoardDetail(slots: readonly ResolvedSlot[]): string {
  const assigned = slots.filter((s) => !!s.control).length;
  const stale = slots.filter((s) => s.stale).length;
  const tail = stale > 0 ? `, ${stale} pointing at a control this device no longer has` : '';
  return `Slot board: ${assigned} of ${slots.length} slots assigned${tail}.`;
}

/** MIDI output picker rows. The port NAME is a name, so it may be painted. */
export function chromaconsolePortOptions(
  outputs: readonly { id: string; name: string }[],
): { value: string; label: string }[] {
  return outputs.map((o) => ({ value: o.id, label: o.name }));
}

/** The sixteen MIDI channels, 1-based on both sides (`DeviceCardApi.setChannel`
 *  takes a 1-based channel and clamps to 1..16). */
export const CHROMA_CHANNEL_CHOICES: readonly { value: string; label: string }[] = Array.from(
  { length: 16 },
  (_, i) => ({ value: String(i + 1), label: `ch ${i + 1}` }),
);
