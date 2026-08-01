// packages/web/src/lib/audio/modules/lfo-face-model.ts
//
// The LFO FACE's arithmetic, in one pure place (the `lfo-state` / `dx7-glyph-
// model` / `param-grid-model` idiom): what each of the three knobs' numbers
// MEAN, and the one constant the glyph's amplitude is derived from.
//
// WHY THIS FILE EXISTS AT ALL — the single-source rule. Three surfaces read the
// same two laws and, before this file, each one re-typed them:
//
//   * the DEPTH→swing law lived as a literal `2 *` inside ModuleShell's
//     wave-morph glyph derivation, a second time in `docs.controls.depth`'s
//     prose, and a third time in `packages/dsp/src/lfo.ts` (the only one that
//     is actually authoritative);
//   * the SHAPE anchors (0 = sine, 1 = saw, 2 = square) lived as a bare
//     `SHAPE_GLYPHS` array on `LfoCard.svelte` — invisible to every def-reading
//     gate, which is exactly the divergence class CLAUDE.md's backdraft section
//     is about.
//
// Everything here is PURE and DOM-free (no registry import, no Svelte), so the
// unit test can perturb one constant and watch every dependent assertion move —
// the negative control that proves the wiring is real.

import type { ParamLandmark } from '$lib/graph/types';

/**
 * The DSP's DEPTH→output-gain multiplier: `gain = max(0, depth) * 2`
 * (`packages/dsp/src/lfo.ts` — the per-sample `const gain = Math.max(0,
 * depthRaw) * 2` in `process()`). It is the reason depth's default is 0.5 and
 * not 1: 0.5 × 2 = unity ±1, which is what every pre-depth patch swung at.
 *
 * ⚠ THE ONE HOME FOR THIS NUMBER on the web side. The face glyph's amplitude,
 * the DEPTH readout and the def's authored prose all resolve through it, so a
 * DSP change moves all three together instead of leaving two of them lying.
 */
export const LFO_DEPTH_GAIN = 2;

/** The DEPTH value that swings unity (±1) — derived, never typed twice. Used
 *  as the def's `depth` defaultValue so "the default is unity" is a fact of the
 *  arithmetic rather than a coincidence of two literals agreeing. */
export const LFO_DEPTH_UNITY = 1 / LFO_DEPTH_GAIN;

/**
 * The DSP's own depth→gain law, verbatim. Negative depth is clamped to 0
 * (`Math.max(0, …)` in the worklet) and the result is deliberately NOT capped:
 * depth 1 really does swing ±2, out past the nominal CV range, which is a
 * documented feature of this module.
 */
export function lfoDepthGain(depth: number): number {
  return Math.max(0, depth) * LFO_DEPTH_GAIN;
}

/**
 * Display amplitude for the face's wave-morph glyph: the real gain, CLAMPED to
 * the screen's ±1 box. The clamp is why DEPTH earns a lane rank the glyph
 * cannot buy back — the top half of the range (unity → ±2) draws identically,
 * so the picture stops reporting depth exactly where depth starts leaving the
 * normal CV range.
 */
export function lfoGlyphAmp(depth: number): number {
  return Math.min(1, lfoDepthGain(depth));
}

/**
 * The SHAPE morph's named waypoints (PF-10 `ParamDef.landmarks`) — the three
 * anchors the DSP crossfades between (`morph()` in `packages/dsp/src/lfo.ts`:
 * `s < 1 ? sine·(1−s) + saw·s : saw·(1−(s−1)) + square·(s−1)`).
 *
 * NOT `options` and never convertible to one: every value between the anchors
 * is a real, audible blend, so a Segmented would hide two thirds of the
 * control. `param-vocabulary.test.ts` enforces the split off `curve`.
 */
export const LFO_SHAPE_LANDMARKS: readonly ParamLandmark[] = [
  { value: 0, label: 'sine' },
  { value: 1, label: 'saw' },
  { value: 2, label: 'square' },
] as const;

/** 2 decimals under 10, 1 under 100, none above — a fixed-width-ish readout
 *  that never prints more precision than the dial can resolve. */
function short(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * The RATE readout (PF-3 `ParamDef.format`) — and the one place on this face
 * where a bare number is genuinely useless. The dial spans 0.01–100 Hz, so its
 * bottom two thirds are sub-Hertz, where "0.01" says nothing a patcher can act
 * on and "100 s" says everything: that is one sweep every hundred seconds.
 *
 * So: at or above 1 Hz print the FREQUENCY, below it print the PERIOD. The
 * crossover is 1 Hz because that is the only rate where the two readings are
 * the same number, which makes the switch invisible rather than jarring.
 *
 * Total by contract (it runs on every animation frame while the knob moves):
 * a non-finite or non-positive rate prints an em dash rather than `Infinity s`.
 */
export function lfoRateReadout(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1) return `${short(hz)} Hz`;
  return `${short(1 / hz)} s`;
}

/**
 * The DEPTH readout (PF-3) — the swing the knob actually produces, not the
 * knob's own 0..1 position. `0.50` is the single most misread number on this
 * module (it looks like "half"; it is unity), and `±1.00` is unambiguous.
 *
 * A depth of exactly 0 prints STILL rather than `±0.00`, because a flat line is
 * a mode, not a level: all four taps sit at 0 and the module emits nothing.
 */
export function lfoDepthReadout(depth: number): string {
  if (!Number.isFinite(depth)) return '—';
  const gain = lfoDepthGain(depth);
  if (gain === 0) return 'still';
  return `±${short(gain)}`;
}
