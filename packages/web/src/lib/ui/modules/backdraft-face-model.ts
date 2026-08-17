// packages/web/src/lib/ui/modules/backdraft-face-model.ts
//
// BACKDRAFT's three derived faceplate readouts, in one pure place.
//
// WHY A DERIVED READOUT AT ALL. The bar (face-readout-values.ts header) is that
// a readout must say something NO SINGLE KNOB READBACK CAN — otherwise it is a
// dial relabelled, and the kick-drum TAIL trap is what happens when nobody
// checks (it tracks SUB DEC, looks right, and is invariant to SUB LEVEL, which
// genuinely shortens the tail). Each function below is paired with a permanent
// negative control in backdraft-face-model.test.ts on the input a nearby dial
// is BLIND to.
//
// ⚠ ONE OF THESE IS DELIBERATELY *NOT* WHAT THE CARD PRINTS, and that is a bug
// report rather than a divergence. BackdraftCard computes its band readout as
//
//     backdraftTvDepth({ fill, gain, widthPx: 1024 })      // no `bezelTb`
//
// — so it falls back to the parameter default `backdraftTvBezel(0.4)` while the
// `bezel` PARAM ships at 0.5. Two consequences, both measured in the test:
// the card is off by a level at the shipped defaults, and its number is
// STRUCTURALLY INVARIANT to a fader sitting inches away on the same card, one
// whose own tooltip calls the bezel "the only high-contrast edge between one
// nesting level and the next". The face passes the live `bezel` through.
//
// ⚠ AND ONE CLAIM THAT LOOKED TRUE AND IS NOT. `backdraftTvDepth`'s `gain`
// argument is fed by `backdraftTvGain(opNorm, feedback, effectScale)`, whose
// FIRST PARAMETER IS UNUSED — it is spelled `_opNorm` and the body is
// `max(0, feedback) * max(0, effectScale)`. So the colour chain (r/g/b/luma/
// chroma) does NOT reach the band count, however much the call site's shape
// suggests it does. The readout is a join of THREE live inputs (zoom, feedback,
// bezel), not seven. Stated here because the call site reads like the opposite.
//
// Everything here is PURE and DOM-free, so the unit test can perturb one input
// and watch the dependent assertions move.

import {
  BACKDRAFT_BUFFER_FRAMES,
  BACKDRAFT_FPS,
  backdraftDelayFrames,
  backdraftTvBezel,
  backdraftTvDepth,
  backdraftTvFill,
  backdraftTvGain,
} from '$lib/video/modules/backdraft';

/** The frame width the nesting arithmetic is evaluated at. The card uses the
 *  engine's own 1024-wide output; the depth law is a `log(2/w)` resolution
 *  ceiling, so this is a REAL input to the answer, not a cosmetic choice. */
export const BACKDRAFT_READOUT_WIDTH_PX = 1024;

/** A param reader as the faceplate supplies it (undefined for a fresh node). */
export type ReadParam = (paramId: string) => number | undefined;

/** Read a param, falling back to `fallback` for undefined/NaN/±Infinity.
 *  TOTALITY MATTERS: these run on EVERY render, so a throw here takes the whole
 *  faceplate down mid-drag (face-readout-values.ts). */
function num(read: ReadParam, id: string, fallback: number): number {
  const v = read(id);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * The fraction of the frame the nested screen fills, from ZOOM alone.
 *
 * Published BESIDE the band count on purpose: this one is BEZEL-INVARIANT and
 * that one is not, so the pair is its own negative control — exactly the
 * `clap-q` / `clap-bandwidth-hz` idiom.
 */
export function backdraftFillPct(read: ReadParam): number {
  return backdraftTvFill(num(read, 'zoom', 1)) * 100;
}

/**
 * How many nesting levels of the bounded screen are actually RESOLVABLE.
 *
 * Three live inputs — ZOOM (through the fill ratio), FEEDBACK (the per-pass
 * gain, which sets the contrast ceiling) and BEZEL (the band whose going
 * sub-pixel is usually the binding ceiling). A ZOOM readback is blind to the
 * last two.
 */
export function backdraftResolvedBands(read: ReadParam): number {
  const fill = backdraftTvFill(num(read, 'zoom', 1));
  const gain = backdraftTvGain(0, num(read, 'feedback', 0.85), 1);
  return backdraftTvDepth({
    fill,
    gain,
    widthPx: BACKDRAFT_READOUT_WIDTH_PX,
    // The live fader — the card's omission is the defect this passes through.
    bezelTb: backdraftTvBezel(num(read, 'bezel', 0.5)),
  }).resolved;
}

/**
 * The feedback tap delay the ring ACTUALLY takes, in whole frames.
 *
 * DELAY is a millisecond fader; the ring is quantised to whole 60 fps frames
 * and floored at 1, so the entire bottom of the fader's travel is ONE frame.
 * The dial cannot show a resolution it does not have — this readout is
 * INVARIANT across that whole range, which is the strong form of the control.
 */
export function backdraftTapFrames(read: ReadParam): number {
  return backdraftDelayFrames(num(read, 'delay', 16), BACKDRAFT_BUFFER_FRAMES, BACKDRAFT_FPS);
}

// ── the printed forms the face registers ───────────────────────────────────

export function backdraftFillText(read: ReadParam): string {
  return `${backdraftFillPct(read).toFixed(0)}%`;
}

export function backdraftBandsText(read: ReadParam): string {
  const n = backdraftResolvedBands(read);
  return n === 1 ? '1 band' : `${n} bands`;
}

export function backdraftTapText(read: ReadParam): string {
  const f = backdraftTapFrames(read);
  return `${f}f · ${((f / BACKDRAFT_FPS) * 1000).toFixed(1)} ms`;
}
