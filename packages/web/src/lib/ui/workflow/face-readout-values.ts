// packages/web/src/lib/ui/workflow/face-readout-values.ts
//
// PF-20 — the REGISTRY for DERIVED face readouts (`FaceReadout.valueId`).
//
// WHY THIS EXISTS, stated as the bug it prevents. A faceplate readout is
// usually a param: the dial says `450 ms` and the caption beside it should say
// `450 ms`, so it reads the same param through the same ladder. But some of the
// numbers a mock prints are NOT any one knob, and printing the nearest knob
// instead is the "a wrong metric reads exactly like a finding" trap in
// CLAUDE.md, drawn on a faceplate:
//
//   kick drum's TAIL — how long the voice rings to −60 dB of its own peak.
//   The nearest knob is SUB DEC (450 ms). It moves when you turn SUB DEC. It
//   looks right. It is INVARIANT to SUB LEVEL, which genuinely shortens the
//   tail, and the true answer at the def's defaults is 398 ms, because the
//   envelope is a sum of three layers each scaled by its own mix. A reviewer
//   checking "does it move when I turn the decay knob" gets a green.
//
// So a readout may instead name a DERIVED value: a pure function of the live
// params, registered here, that computes the number the way the DSP does. The
// def declares a STRING id, never a function — exactly like `sidebar-panels.ts`
// — so `face` stays serialisable data and nothing in the shell imports a
// module. `module-face-lint` fails a `valueId` naming an unregistered id, so a
// typo is loud in the unit lane instead of silently printing `—`.
//
// THE BAR FOR ADDING ONE. A derived readout must be negative-controlled on the
// input a knob readback would be BLIND to, permanently — not once at authoring
// time. `kickdrum-face-model.test.ts` perturbs SUB LEVEL and asserts the
// printed tail moves; that assertion is what makes the difference between this
// registry and a relabelled knob observable at all.
//
// PURE: no DOM, no engine, no store. Each entry takes a param reader and
// returns the formatted string.

import { fmtMs } from '$lib/audio/modules/kickdrum-format';
import {
  kickdrumEnvelopeParams,
  kickdrumTailMs,
} from '$lib/ui/modules/kickdrum-face-model';

/** A derived readout: live params in (through the caller's reader, which
 *  already resolves def defaults for untouched params), formatted string out.
 *  TOTAL — it is called on every render, so a throw on a transient NaN would
 *  take the faceplate down mid-drag. */
export type FaceReadoutValue = (read: (paramId: string) => number | undefined) => string;

/** id → derived value. Keys are the strings a `FaceReadout.valueId` declares. */
const FACE_READOUT_VALUES: Readonly<Record<string, FaceReadoutValue>> = {
  // KICK DRUM's TAIL. Computed through the WORKLET'S OWN decay law
  // (`decayCoeff`) over the three layer envelopes at their live mix levels —
  // see kickdrum-face-model. NOT `sub_decay`.
  'kickdrum-tail': (read) => fmtMs(kickdrumTailMs(kickdrumEnvelopeParams(read))),
};

/** The derived value for a declared id, or `null` (⇒ the readout prints `—`
 *  and the lint is red). */
export function faceReadoutValueFor(valueId: string): FaceReadoutValue | null {
  return FACE_READOUT_VALUES[valueId] ?? null;
}

/** Every registered id — the roster module-face-lint checks a declared
 *  `valueId` against. */
export function faceReadoutValueIds(): string[] {
  return Object.keys(FACE_READOUT_VALUES).sort();
}
