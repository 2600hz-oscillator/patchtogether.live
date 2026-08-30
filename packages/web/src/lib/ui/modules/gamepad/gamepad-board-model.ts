// packages/web/src/lib/ui/modules/gamepad/gamepad-board-model.ts
//
// EVERY STRING AND EVERY COORDINATE THE GAMEPAD MAPPING BODY PRODUCES — pure,
// beside the component that renders them.
//
// ── WHY A MODEL FILE AT ALL ─────────────────────────────────────────────────
//
// Two reasons, and neither is tidiness:
//
//  1. THE SENTENCES ARE NEVER PAINTED. The resting-text ruling puts a control's
//     meaning on `aria-label`, "speakable and assertable but unpainted". An
//     UNPAINTED string that is wrong is invisible to a VRT baseline and to a
//     human reading one, so it has to be decided somewhere a unit test can read
//     it. (The midiclock body's `midiclock-status-model` is the same move for
//     the same reason.)
//
//  2. ⚠ THE `control-grid` GATE'S SHARPEST LEG IS EXPRESSION IDENTITY.
//     `face-rack-status-source.test.ts` refuses any `aria-label={EXPR}` whose
//     SAME expression is also rendered as a bare text node — the violation that
//     wears the ruling's own mechanism as a disguise ("the screen reader gets
//     it, so the sighted user should too"). This body paints twelve LED
//     CAPTIONS, so the naive port (`aria-label={btn.label}` beside
//     `>{btn.label}<`) is exactly the offence that leg was written for. Routing
//     every accessible name through a named function here makes the two
//     expressions structurally different rather than accidentally different.
//
// ⚠ WHAT THE GATE STILL CANNOT SEE, stated rather than implied: its predicate
// is expression IDENTITY, so `aria-label={ledSentence(b)}` clears it whatever
// `ledSentence` returns. The compliance argument rests on the sentence
// genuinely differing in CONTENT from the caption, and the only things that can
// see that are the dock PNG and a human — plus the disjointness leg in
// `gamepad-face-model.test.ts` (the bespoke gate), which asserts it about the real strings.

import {
  bindingForOutput,
  describeControl,
  STICK_DEADZONE,
  type CalibrationSweep,
  type RemapBindings,
} from '$lib/audio/modules/gamepad';

/** The stick pad's edge length in CSS px. The pad is a SQUARE by construction —
 *  a stick's travel is isotropic, so a rectangle would make a circular sweep
 *  read as an ellipse. */
export const PAD_PX = 64;

/** Map a bipolar axis value (-1..+1) to an X offset inside the pad. */
export function dotX(v: number): number {
  const c = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return ((c + 1) / 2) * PAD_PX;
}

/** Map a bipolar axis value to a Y offset inside the pad. The engine emits
 *  +1 = UP (it flips the raw axis), and screen Y grows downward, so the sign
 *  flips back here. */
export function dotY(v: number): number {
  const c = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return ((-c + 1) / 2) * PAD_PX;
}

/** The live sweep drawn as a RECTANGLE inside the pad, in the same coordinate
 *  system as the dot. Null until the sweep has a finite extent on both axes.
 *
 *  ⚠ THIS IS WHAT REPLACED A READOUT, AND THE REPLACEMENT IS STRICTLY BETTER.
 *  The legacy card printed four live numbers during calibration
 *  (`x [-0.98, 0.97] · y [-1.00, 0.86]`) — four measurements at rest, the
 *  sharpest resting-text violation on the module. The finding they carried is
 *  "have I swept far enough?", and HALF of it never needed a number at all:
 *  `complete calibration` is `disabled` until `sweepIsUsable(sweep)`, so "am I
 *  there yet" is already answered by a control's enabled state on a non-text
 *  channel. What the numbers added is HOW CLOSE — and that has a picture: the
 *  box grows as you sweep, and when it reaches the pad's edges you are done.
 *  Same quantity, same coordinate system as the dot the user is already
 *  watching, no reading required. The numbers themselves survive on the pad's
 *  own `aria-label` (see `stickSentence`), so nothing became unassertable. */
export function sweepBox(
  sweep: CalibrationSweep,
): { left: number; top: number; width: number; height: number } | null {
  if (
    !Number.isFinite(sweep.minX) ||
    !Number.isFinite(sweep.maxX) ||
    !Number.isFinite(sweep.minY) ||
    !Number.isFinite(sweep.maxY)
  ) {
    return null;
  }
  const left = dotX(sweep.minX);
  const right = dotX(sweep.maxX);
  // +Y is UP, so the sweep's MAX maps to the SMALLER screen coordinate.
  const top = dotY(sweep.maxY);
  const bottom = dotY(sweep.minY);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Which CALIBRATABLE stick, spelled for a sentence. Exactly the two sticks that
 *  own a persisted `StickCalibration` record (`leftStickCalibration` /
 *  `rightStickCalibration`), which is why it stays narrow: `calibrationDetail`
 *  and `startCalibration` must not accept a stick that has nowhere to store a
 *  sweep. */
export type Stick = 'left' | 'right';

/** Which stick BLOCK on the board — the two calibratable sticks plus `aux`, the
 *  third X/Y pair a flight stick's twist / rudder / lever gets bound to. `aux`
 *  is deliberately NOT a `Stick`: it has a live pad, remap buttons and invert
 *  toggles, but no calibration record, because its axes are bound by hand or by
 *  preset and a bound axis that already spans ±1 has nothing to calibrate. */
export type StickSlot = Stick | 'aux';

function fixed(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

/** The PAD lamp's detail — the connected controller's OS-reported name, or the
 *  gesture that is the whole connection protocol.
 *
 *  ⚠ THE INSTRUCTION HALF IS NOT A READOUT AND THE NAME HALF IS. The legacy
 *  card painted `snapshot.id` truncated to 24 chars in a text node beside the
 *  title: a device name outside every control, restating what is bound, that
 *  CHANGES with state — precisely the shape `StatusLed` was built to make
 *  inexpressible. It moves here, to `aria-label`/`title`. The "press any button"
 *  half survives as painted copy in the body's EMPTY STATE (midiclock's shipped
 *  precedent), because instructional copy in an empty state is not a
 *  measurement of anything. */
export function padDetail(connected: boolean, id: string): string {
  if (!connected) {
    return 'no controller in this slot. The Gamepad API only reveals a pad after you press a '
      + 'button ON THE CONTROLLER — nothing on this screen can do it for you.';
  }
  return id.trim().length
    ? `connected: ${id}`
    : 'connected (the browser reported no name for this pad)';
}

/** A calibration lamp's detail. Replaces the `calibrated` badge — a state word
 *  about the module, which may not paint. */
export function calibrationDetail(stick: Stick, calibrated: boolean): string {
  return calibrated
    ? `${stick} stick is CALIBRATED — its swept range is remapped to full ±1 and its captured `
      + 'rest position reads 0. Clear it to fall back to the fixed deadzone.'
    : `${stick} stick is UNCALIBRATED — it uses the fixed ${STICK_DEADZONE} deadzone and assumes `
      + 'full travel. Sweep it to capture its real range.';
}

/** The outcome of the last save / load / preset gesture.
 *
 *  ⚠ THE "IT IS TRANSIENT, SO THE RULING DOES NOT REACH IT" ARGUMENT IS
 *  AVAILABLE HERE AND IS REFUSED. The card's status line self-cleared after 4 s,
 *  and the ruling is about text AT REST, so a real case exists that a toast
 *  after an explicit gesture is outside it. It is refused because "transient" is
 *  an unbounded category — every readout on every card can be re-timed into one
 *  — and because refusing costs nothing here: the lamp carries the WHOLE message
 *  in `detail`, separates SUCCESS from REJECTED in `tone` (colour, the
 *  primitive's stated design), and is MORE persistent than the toast was. A user
 *  who looked away for five seconds currently misses `ignored: invalid JSON`
 *  entirely, so the load-failure report gets BETTER, not worse. */
export function mappingDetail(outcome: MappingOutcome | null): string {
  if (!outcome) {
    return 'no mapping has been saved or loaded on this node yet. SAVE MAPPING downloads the '
      + 'current bindings, inverts and calibrations as JSON; LOAD MAPPING reads one back.';
  }
  return outcome.message;
}

/** The last save/load/preset result. `ok: false` tints the lamp amber. */
export interface MappingOutcome {
  ok: boolean;
  message: string;
}

/** The sentence on a REMAPPABLE control — an LED, a trigger row, or a stick
 *  axis button. Row 6 of the resting-text census (the card's hover `title`) plus
 *  row 8's `●` mark, made speakable and PERMANENT instead of mouse-only.
 *
 *  ⚠ NO INFORMATION IS LOST BY DELETING THE `title`; it stops being reachable
 *  only by a mouse. That is the whole trade. */
export function remapSentence(opts: {
  /** The output port this control rebinds (`a`, `lt`, `lx`, …). */
  outputId: string;
  /** The control's painted caption (`A`, `LT`, `X`). */
  caption: string;
  /** What the output IS, for a reader who cannot see the layout. */
  role: string;
  bindings: RemapBindings;
  /** True while THIS control is the armed listener. */
  armed: boolean;
  /** How this control is armed and cleared — the two differ between the axis
   *  buttons (click / right-click) and the LEDs (right-click / alt-click). */
  gestures: string;
}): string {
  const { outputId, caption, role, bindings, armed, gestures } = opts;
  if (armed) {
    return `${caption} — ${role}. LISTENING: move the physical control you want bound to it, or `
      + 'press Escape to cancel.';
  }
  const b = bindingForOutput(outputId, bindings);
  const source = b ? `driven by ${describeControl(b)}` : 'on its default control';
  return `${caption} — ${role}, ${source}. ${gestures}`;
}

/** The sentence on an INVERT toggle. */
export function invertSentence(stick: StickSlot, axis: 'x' | 'y', on: boolean): string {
  return `invert ${stick} stick ${axis.toUpperCase()} — currently ${on ? 'INVERTED' : 'normal'}. `
    + 'Flips the sign of whatever physical axis is mapped to that output, on top of any remap.';
}

/** The stick pad's own accessible name — the live picture, spoken.
 *
 *  ⚠ THIS IS WHERE THE DELETED SWEEP READOUT LANDS. The four numbers the card
 *  printed are here verbatim while a sweep is running, so the arithmetic is
 *  still assertable; what changed is that the SIGHTED channel became the box
 *  drawn inside the pad (`sweepBox`) rather than a row of decimals. */
export function stickSentence(opts: {
  stick: StickSlot;
  x: number;
  y: number;
  /** `null` for a stick that has no calibration record at all (the aux pair) —
   *  the sentence then ends after the position rather than claiming
   *  "Uncalibrated.", which would name a state that stick cannot be in. */
  calibrated: boolean | null;
  sweep: CalibrationSweep | null;
}): string {
  const { stick, x, y, calibrated, sweep } = opts;
  const head = `${stick} stick position: x ${fixed(x)}, y ${fixed(y)} `
    + '(a live picture of the controller, not a control — drag does nothing).';
  if (sweep) {
    return `${head} CALIBRATING: swept x [${fixed(sweep.minX)}, ${fixed(sweep.maxX)}] · `
      + `y [${fixed(sweep.minY)}, ${fixed(sweep.maxY)}] over ${sweep.samples} samples. `
      + 'Sweep to the pad\'s edges, then COMPLETE.';
  }
  if (calibrated === null) return head;
  return `${head} ${calibrated ? 'Calibrated.' : 'Uncalibrated.'}`;
}

/** The sentence on a live TRIGGER bar (the picture beside its remappable
 *  label). Unipolar 0..1, so it is a level rather than a position. */
export function triggerSentence(caption: string, value: number): string {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return `${caption} travel: ${fixed(v)} of 1 (a live picture of the controller, not a control).`;
}
