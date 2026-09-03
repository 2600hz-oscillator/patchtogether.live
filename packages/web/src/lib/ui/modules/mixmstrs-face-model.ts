// packages/web/src/lib/ui/modules/mixmstrs-face-model.ts
//
// THE PURE MODEL BEHIND MIXMSTRS' FACEPLATE — the console's ranking axis, and
// the four hero readouts.
//
// ⚠ NOTHING HERE RE-TYPES A RANGE, A DEFAULT OR A POPULATION. Every list is
// built from `MIXMSTRS_CHANNELS` / `MIXMSTRS_RETURNS` (the def's own exported
// single-source-of-truth lists), every fallback value is resolved off
// `mixmstrsDef.params`, and the compressor's enable law is `mapCompMacro`
// IMPORTED from the def rather than restated — so a ninth channel, a re-ranged
// fader or a change to the macro's mapping moves this model with it instead of
// silently past it.
//
// ── THE RANKING AXIS: SCOPE ────────────────────────────────────────────────
//
// A mixer is N interchangeable channel strips, and #1701 named the trap: a rank
// over N identical controls has no priority to express. There, the resolution
// was to rank on an INTRINSIC axis (a filter bank's centre frequency, low→high).
// Here the intrinsic axis exists and it is SCOPE — how many of the mixer's ten
// stereo inputs a control's effect reaches, read straight off the DSP's summing
// expression (`mixmstrs.dsp:329-336`):
//
//   master_volume      × the SUM of eight channels and two returns   scope 10
//   send{R}Pre         re-taps all eight channels for one send bus   scope  8
//   ret{R}_volume      one return path                               scope  1 return
//   ret{R}_{lo,md,hi}  one band of one return path                   scope  1 return
//   ch{N}_*            one channel                                   scope  1 channel
//
// That axis is TOTAL over the thirteen bus-scoped controls and exactly TIED over
// the eighty channel-scoped ones. **The tie is not a defect of the axis — it is
// the truth about a console**, and the face is arranged so the tie never has to
// be consulted: the thirteen bus-scoped controls take ranks 1–13, which is longer
// than the largest lane tier (`FACE_TIER_CAPS.full`), so NO LANE TIER EVER
// PAINTS A CHANNEL-SCOPED CONTROL and no channel is ever privileged over
// another. `mixmstrs-face-model.test.ts` asserts exactly that, derived from the
// def on both sides.
//
// The alternative — `master_volume` then `ch1_volume … ch5_volume` — makes the
// six-cell plate look like a FIVE-CHANNEL MIXER. That is not a subset of an
// eight-channel mixer, it is a different and wrong instrument, and a player
// with only channel 6 patched would see a fader that does nothing to their
// signal. That is #1701's defect with faders instead of filter knobs.
//
// Within the bus-scoped block: `master_volume` (largest scope AND the largest
// measured mover), then the two return STRIPS whole, then the two PRE/POST
// switches last — because they are BIT-EXACTLY INERT until a send opens
// (measured 0.0000e+0 across both positions with every send at 0, against
// 3.2138e-1 with the sends at 0.5) and their enablers are channel-scoped, so
// "enabler outranks dependent" and the scope axis cannot both hold as a total
// order. The property that is kept is the operational half — NO LANE TIER MAY
// PAINT A CONTROL INERT AT THE SHIPPED DEFAULTS — since a lane tier is the only
// place `order` decides what a player meets as a subset.
//
// Within the channel block the order is FUNCTION-MAJOR, CHANNEL-MINOR: the
// eight instances of one control, in strip order, then the next control. The
// channel index therefore never discriminates between two DIFFERENT controls —
// it only orders the eight instances of the SAME one, where "left to right" is
// the console's own numbering and expresses nothing more.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import {
  MIXMSTRS_CHANNELS,
  MIXMSTRS_RETURNS,
  mapCompMacro,
  mixmstrsChannelIndex,
  mixmstrsDef,
} from '$lib/audio/modules/mixmstrs';

/** The reader a `FaceReadoutValue` is handed: params only, `undefined` when the
 *  node has never written one (a fresh spawn). */
type Read = (paramId: string) => number | undefined;

// ── ID BUILDERS — derived, never typed ─────────────────────────────────────

/** The eight instances of one per-channel control, in strip order. */
export const perChannel = (suffix: string): string[] =>
  MIXMSTRS_CHANNELS.map((c) => `ch${c}_${suffix}`);

/** The eight COMP macros. `comp{N}`, not `ch{N}_comp` — the def's own naming. */
export const compMacroIds = (): string[] => MIXMSTRS_CHANNELS.map((c) => `comp${c}`);

/** One send-bus PRE/POST flag per bus. There is exactly one send bus per RETURN
 *  (the bus feeds the effect, the return brings the wet back), which is why the
 *  same index list drives both families. */
export const sendPreIds = (): string[] => MIXMSTRS_RETURNS.map((r) => `send${r}Pre`);

/** One return strip, in signal order: level, then its three EQ bands. */
export const returnStripIds = (r: number): string[] => [
  `ret${r}_volume`,
  `ret${r}_low`,
  `ret${r}_mid`,
  `ret${r}_high`,
];

/**
 * Does this param act on exactly ONE channel — i.e. is it a member of the
 * interchangeable set?
 *
 * ⚠ A PREDICATE OVER THE DEF'S OWN NAMING, NOT A COPY OF `face.order`. The
 * ranking lives in exactly one place (the def), and the gate reads it back
 * THROUGH this predicate: a second list here would be a second opinion that
 * agrees at authoring time and drifts the first time a channel control is
 * added. `mixmstrs-face-model.test.ts` anchors it both ways against the live
 * def — every param matches this or is one of the thirteen bus-scoped ids, and
 * the two sets partition `mixmstrsDef.params` with nothing left over.
 *
 * ⚠ THE REGEX ITSELF MOVED TO THE DEF (#1825, `mixmstrsChannelIndex`), because
 * the face's per-column LANE COLOUR needs the same question answered with a
 * channel INDEX rather than a yes/no. Two regexes over one naming convention is
 * the drift this comment was already warning about; this predicate is now a
 * thin `!== null` over the one that lives beside the loop that builds the ids.
 */
export const isChannelScoped = (paramId: string): boolean =>
  mixmstrsChannelIndex(paramId) !== null;

// ── THE HERO READOUTS ARE GONE, AND SO IS THEIR ARITHMETIC ─────────────────
//
// This file used to continue with a param snapshot (`mixmstrsFaceParams`) and
// three derived readouts built on it: `busGainText` (the fully-correlated
// worst-case gain into the master), `compAsleepText` (how many thresh/ratio
// faders are bit-exactly inert right now) and `sendText` (each send bus's tap
// point AND whether it is alive). Each was a JOIN over controls no single
// readback can perform, each was permanently negative-controlled on the input a
// knob readback is blind to, and the `bus` one was this face's own merit
// argument — the headroom warning that TWO correlated hot channels already clip
// the bus at the shipped defaults.
//
// Owner ruling 2026-08-17: *"[MASTER 1.00 / BUS ≤ 8.60× · +18.7 dB / ASLEEP 16
// asleep] these numbers and text should go away"*, and generally *"we don't
// want text like that in our faceplates"*.
//
// ⚠ DELETED RATHER THAN ORPHANED. The obvious smaller diff — drop the two
// entries from `face.hero.readouts` and leave the functions and their registry
// providers in place — leaves a computation nothing can reach, which reads like
// a shipped decision to the next person and is exactly the "declaration nobody
// renders" shape this repo treats as a defect. The measurements those functions
// carried are preserved verbatim in the def's comment above `hero`, and the
// clipping behaviour they warned about is stated in the module's authored
// `docs`, which is where an explanation belongs.
//
// What REMAINS in this file is the part that is still load-bearing: the ranking
// axis (SCOPE), the id builders every list is derived from, and
// `isChannelScoped` — the predicate `mixmstrs-face-model.test.ts` anchors the
// face's tie-free ranking against, in both directions.
