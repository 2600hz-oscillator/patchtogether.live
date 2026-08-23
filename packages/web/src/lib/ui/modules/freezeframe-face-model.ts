// packages/web/src/lib/ui/modules/freezeframe-face-model.ts
//
// The PURE model behind the FREEZEFRAME faceplate — the arithmetic for its two
// derived readouts.
//
// WHY DERIVED. Both readouts answer a question that spans SEVERAL knobs, and in
// both cases the single nearest knob gives a confidently wrong answer:
//
//   DEPTH  A QUANT knob reads `0.50`. What the picture actually has is
//          THIRTY-TWO LEVELS, because the sweep is geometric in log2 — and the
//          number that governs the visible banding is the COARSEST of the four
//          channels, not the one you happen to be holding. A `quant_r`
//          readback is blind to `quant_luma`, which is the knob with the
//          widest reach (it scales all three channels at once) and the one
//          #1861 was hiding a defect in.
//   DECAY  `decay_time` reads `0.50 s` whether or not DECAY IS ON. Turning the
//          switch off does not move that dial, so a `decay_time` readback
//          prints a live-looking duration for an effect that is switched off.
//          The derived version reports the switch first and the duration only
//          when it means something.
//
// ANCHORED TO THE MODULE'S OWN FUNCTIONS: `quantLevels` and `lumaIsFullDepth`
// are imported from the def, so the caption cannot drift from the level counts
// the shader is actually handed.
//
// PURE: no DOM, no engine, no store. Every function is a pure function of the
// live param values.

import {
  DECAY_MAX_S,
  DECAY_MIN_S,
  QUANT_MAX_LEVELS,
  lumaIsFullDepth,
  quantLevels,
} from '$lib/video/modules/freezeframe';

/** The live params the two readouts need, with the def's own defaults filled
 *  in — `node.params` is a SPARSE overlay of what has been TOUCHED. */
export interface FreezeframeFaceParams {
  quant_r: number;
  quant_g: number;
  quant_b: number;
  quant_luma: number;
  decay: number;
  decay_invert: number;
  decay_time: number;
}

const DEFAULTS: FreezeframeFaceParams = {
  quant_r: 0,
  quant_g: 0,
  quant_b: 0,
  quant_luma: 0,
  decay: 0,
  decay_invert: 0,
  decay_time: 0.5,
};

export function freezeframeFaceParams(
  read: (paramId: string) => number | undefined,
): FreezeframeFaceParams {
  const one = (k: keyof FreezeframeFaceParams): number => {
    const v = read(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k];
  };
  return {
    quant_r: one('quant_r'),
    quant_g: one('quant_g'),
    quant_b: one('quant_b'),
    quant_luma: one('quant_luma'),
    decay: one('decay'),
    decay_invert: one('decay_invert'),
    decay_time: one('decay_time'),
  };
}

/** The repo's canonical switch reading — `curve: 'discrete'`, 0..1, high at
 *  the midpoint (`looksLikeToggle`, `$lib/graph/group-controls`). */
const switchIsOn = (v: number): boolean => v >= 0.5;

/**
 * THE EFFECTIVE COLOUR DEPTH of the combined output.
 *
 * The coarsest of the four channels, because that is the one whose banding you
 * see. Returns `QUANT_MAX_LEVELS` when nothing is quantizing at all.
 *
 * ⚠ `quant_luma` IS INCLUDED, and that inclusion is the point. It reaches the
 * combined output through a different path from the other three (a
 * hue-preserving luma ratio, not a per-channel posterize), so a readout built
 * from R/G/B alone would be structurally blind to the widest-reaching knob on
 * the module — and blind in exactly the place #1861 lived. The permanent
 * negative control in `freezeframe-face-model.test.ts` moves `quant_luma`
 * ALONE and requires this number to follow it.
 */
export function freezeframeDepthLevels(p: FreezeframeFaceParams): number {
  return Math.min(
    quantLevels(p.quant_r),
    quantLevels(p.quant_g),
    quantLevels(p.quant_b),
    quantLevels(p.quant_luma),
  );
}

/** Is every channel at full depth — i.e. is the module a passthrough? */
export function freezeframeIsPassthrough(p: FreezeframeFaceParams): boolean {
  return (
    lumaIsFullDepth(quantLevels(p.quant_r)) &&
    lumaIsFullDepth(quantLevels(p.quant_g)) &&
    lumaIsFullDepth(quantLevels(p.quant_b)) &&
    lumaIsFullDepth(quantLevels(p.quant_luma))
  );
}

/**
 * DEPTH, as text. `off` when nothing is quantizing, otherwise a level count.
 *
 * ⚠ `off` IS A NAME, NOT A NUMBER, and it is doing work a number cannot: at
 * the defaults every QUANT dial reads `0.00`, which a player reasonably reads
 * as "zero depth" when it means the exact opposite — FULL depth, 256 levels,
 * a passthrough. Naming the state is what disambiguates it (owner ruling on
 * face readouts: a name disambiguates otherwise-identical states, a number
 * restates the dial).
 *
 * The level count is ROUNDED for display only. `quantLevels` returns a
 * continuous count on purpose so a CV sweep of the knob is smooth, and the
 * shader accepts any real >= 2.
 */
export function freezeframeDepthText(p: FreezeframeFaceParams): string {
  if (freezeframeIsPassthrough(p)) return 'off';
  const levels = freezeframeDepthLevels(p);
  if (!Number.isFinite(levels)) return '—';
  return `${Math.max(2, Math.round(levels))} lv`;
}

/**
 * DECAY, as text. `off` when the switch is off — regardless of what the TIME
 * dial says, which is the whole reason this is derived — otherwise the
 * duration and where it fades TO.
 *
 * The duration reads as "gone by": at the time dialled in, the frame has
 * reached the target exactly (see `decayEnvelope` on the def), which is why it
 * is printed as a plain time rather than a time constant.
 */
export function freezeframeDecayText(p: FreezeframeFaceParams): string {
  if (!switchIsOn(p.decay)) return 'off';
  const target = switchIsOn(p.decay_invert) ? 'white' : 'black';
  const t = Math.min(DECAY_MAX_S, Math.max(DECAY_MIN_S, p.decay_time));
  const secs = t < 1 ? `${t.toFixed(2)} s` : `${t.toFixed(1)} s`;
  return `${secs} ${target}`;
}

/** Exported so the test can assert the readout's own vocabulary rather than
 *  re-typing the strings it checks. */
export const FREEZEFRAME_OFF_TEXT = 'off';
export { QUANT_MAX_LEVELS };
