// packages/web/src/lib/ui/modules/ptzcam/ptzcam-status-model.ts
//
// EVERY STRING THE PTZ DEVICE BODY CAN PRODUCE, as pure functions — including
// the ones that are never painted.
//
// An unpainted string that is wrong is invisible to a VRT baseline and to a
// human reading one, which is precisely what the resting-text ruling creates by
// moving measurements onto `aria-label`. So they are decided here, where a unit
// test can read them, exactly as `midiclock-status-model.ts` does for the
// binder next door.

import type { PtzStatus } from '$lib/audio/ptz-midi';
import type { PtzAxisCaps, PtzCaps } from '$lib/audio/ptz-sysex';

/** The three axes, in the order the body paints them and the order the sysex
 *  protocol numbers them. */
export const PTZ_AXES = ['pan', 'tilt', 'zoom'] as const;
export type PtzAxis = (typeof PTZ_AXES)[number];

/**
 * The LINK lamp's sentence — the full status message, whatever the kind.
 *
 * ⚠ ALL NINE KINDS, NOT A HINT-PLUS-ERROR PAIR. `BindingImpl.status()` produces
 * a distinct sentence for every one of `idle | unsupported | denied | no-prompt
 * | no-port | binding | no-reply | bound | camera-absent`, and several of them
 * are the only place in the product that says what to DO ("Start the helper
 * (start_ptz.sh)", "relaunch with --disable-features=MidiMacUmp"). Collapsing
 * them to "connected / not connected" would delete the diagnosis along with the
 * readout. The lamp is the picture; this is what it says when asked.
 */
export function ptzcamLinkDetail(status: PtzStatus | null): string {
  return status?.message ?? 'Not connected. Connect grants MIDI and finds the PT-PTZ helper.';
}

/**
 * Is this status a FAULT — something the player must act on?
 *
 * `idle` is not (nothing has been asked for yet), `binding` is not (a handshake
 * in flight), `bound` is not. Everything else is, and this is the predicate that
 * decides whether the message is painted as a `role="alert"` line as well as
 * spoken by the lamp. An error is permitted painted text precisely because it is
 * ABSENT whenever nothing is wrong.
 */
export function ptzcamIsProblem(status: PtzStatus | null): boolean {
  if (!status) return false;
  return status.kind !== 'bound' && status.kind !== 'idle' && status.kind !== 'binding';
}

/** Is the module talking to a camera right now? (The LINK lamp's `lit`.) */
export function ptzcamIsBound(status: PtzStatus | null): boolean {
  return status?.kind === 'bound';
}

/**
 * ⚠ THE AXIS-MODE LAMP'S `lit`: TRUE for a VELOCITY axis, and the block that
 * holds it must be rendered only while `caps` exists.
 *
 * The underlying fact is THREE-VALUED per axis — `abs | vel | none` — and a
 * boolean lamp is two-valued, so the narrowing is stated rather than hidden.
 * `lit = velocity` is the honest split because velocity is the axis that
 * behaves differently from every other control in the rack: the knob is a RATE,
 * zero is a stop with a deadzone around it, and SLEW does nothing. `abs` and
 * `none` both leave a dark lamp and are separated in the DETAIL.
 *
 * ⚠ AND THE CALLER MUST GUARD ON `caps`, WHICH IS THE HALF A LAMP CANNOT
 * EXPRESS. Pre-bind there are no caps at all, and three dark lamps would be
 * pixel-identical to a bound NexiGo P610 (all three axes absolute) — i.e. the
 * face would be asserting "all three axes are positions" about a module that
 * knows nothing about any camera yet. The legacy card solved this by HIDING the
 * row (`{#if modeLine !== null}`); the body does the same with the lamp block,
 * so "unknown" is the ABSENCE of the indicator rather than one of its states.
 */
export function ptzcamAxisIsVelocity(axis: PtzAxisCaps | undefined): boolean {
  return axis?.mode === 'vel';
}

/** The axis lamp's sentence — what this axis's mode means for the knob and the
 *  CV jack above it. */
export function ptzcamAxisDetail(name: PtzAxis, axis: PtzAxisCaps | undefined): string {
  if (!axis || axis.mode === 'none') {
    return `${name} is not controllable on this camera — the knob and ${name}_cv are ignored`;
  }
  if (axis.mode === 'vel') {
    return (
      `${name} is a VELOCITY axis: knob + ${name}_cv is a RATE, sign is direction, and a value `
      + 'inside the deadzone is an explicit stop. SLEW is ignored on this axis — a commanded '
      + 'stop is never slewed — and the helper halts motion on its own if the page stops '
      + 'streaming'
    );
  }
  return (
    `${name} is an ABSOLUTE axis: knob + ${name}_cv is a POSITION spanning the camera's full `
    + `mechanical range (${axis.min}..${axis.max} in device units), rate-limited by SLEW`
  );
}

/** Every axis lamp's state in one pass — used by the body, and the shape a test
 *  can assert against a captured caps frame. */
export function ptzcamAxisLamps(
  caps: PtzCaps | null | undefined,
): readonly { axis: PtzAxis; lit: boolean; detail: string }[] {
  if (!caps) return [];
  return PTZ_AXES.map((axis) => ({
    axis,
    lit: ptzcamAxisIsVelocity(caps[axis]),
    detail: ptzcamAxisDetail(axis, caps[axis]),
  }));
}

/**
 * The camera picker's option list, including the SYNTHETIC `(offline)` row.
 *
 * ⚠ THE OFFLINE ROW IS PARITY, NOT DECORATION. `node.data.device` is a saved
 * port NAME, and a patch reloaded before the helper starts (or with that camera
 * unplugged) holds a name the live roster does not contain. Without the
 * synthetic option a `<select>` bound to that value would silently fall back to
 * the first entry and the player's saved choice would be lost by rendering. It
 * carries the same `(offline)` suffix the legacy card used.
 */
export function ptzcamPortOptions(
  ports: readonly string[],
  selected: string | null,
): readonly { value: string; label: string }[] {
  const out = ports.map((p) => ({ value: p, label: p }));
  if (selected !== null && selected !== '' && !ports.includes(selected)) {
    out.push({ value: selected, label: `${selected} (offline)` });
  }
  return out;
}
