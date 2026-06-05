// packages/web/src/lib/video/toybox-cv-math.ts
//
// TOYBOX modulation-section math (PURE — no Yjs, no GL, no DOM).
//
// Each of the 6 modulation inputs is a Structure-style attenuverter + offset:
//
//   norm     = clamp( signal * SCALE + OFFSET, 0, 1 )      // in 0..1 space
//   effective = min + norm * (max - min)                   // → param range
//
// where:
//   - `signal` is the live input sample in a unipolar 0..1 convention:
//       * a CV source's bipolar −1..+1 sample folded to 0..1 (cv*0.5+0.5),
//       * an AUDIO source's envelope-follower value (already 0..1),
//       * 0 when NO cable is patched (so OFFSET is the manual control value).
//     We work in ONE internal 0..1 convention (no 1V/5V switch) so the SCALE +
//     OFFSET controls behave identically for cv vs audio.
//   - `SCALE` is the bipolar attenuverter, −1..+1: 0 = off (input ignored, the
//     param parks at OFFSET), +1 = full positive depth, −1 = full inverted.
//   - `OFFSET` is the manual control / no-cable value, 0..1: 0 = param min,
//     1 = param full.
//
// Defaults (DEFAULT_INPUT_SCALE = +1, DEFAULT_INPUT_OFFSET = 0) are chosen so a
// freshly-patched cable IMMEDIATELY modulates: with SCALE +1 / OFFSET 0 a rising
// input sweeps the param from min upward. To get a bipolar wiggle CENTRED in the
// param's range, the user dials OFFSET to ~0.5 (so signal 0.5 ⇒ norm 0.5 ⇒ the
// param's midpoint) — exactly the Structure / attenuverter workflow: patch,
// then dial OFFSET/SCALE and watch the inline scope land in the sweet spot.

/** Default per-input attenuverter — full positive depth (a fresh cable
 *  modulates immediately). */
export const DEFAULT_INPUT_SCALE = 1;

/** Default per-input offset — 0 (param parks at its min with no cable; a rising
 *  input sweeps upward). */
export const DEFAULT_INPUT_OFFSET = 0;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The post-scale/offset NORMALIZED value in 0..1, clamped. This is what the
 * inline scope renders (the value "bouncing through the 0..1 window").
 *
 *   norm = clamp( signal * scale + offset, 0, 1 )
 *
 * Non-finite inputs degrade gracefully (treated as 0 / the default). With
 * signal = 0 (no cable) the result is clamp(offset) — i.e. OFFSET is the manual
 * control value.
 */
export function effectiveNorm(
  signal: number,
  scale: number = DEFAULT_INPUT_SCALE,
  offset: number = DEFAULT_INPUT_OFFSET,
): number {
  const s = Number.isFinite(signal) ? signal : 0;
  const sc = Number.isFinite(scale) ? scale : DEFAULT_INPUT_SCALE;
  const off = Number.isFinite(offset) ? offset : DEFAULT_INPUT_OFFSET;
  return clamp01(s * sc + off);
}

/**
 * Map the post-scale/offset normalized value across a param's [min, max] range.
 * `effective = min + effectiveNorm(signal, scale, offset) * (max - min)`,
 * always within [min, max] (the norm is clamped to 0..1 first).
 *
 * Pure + deterministic: identical inputs → identical output. This is the single
 * source of truth the factory's setParam hot-path uses, so the attenuverter /
 * offset / no-cable / clamp semantics are unit-tested in one place.
 */
export function effectiveCvValue(
  signal: number,
  scale: number,
  offset: number,
  min: number,
  max: number,
): number {
  const norm = effectiveNorm(signal, scale, offset);
  return min + norm * (max - min);
}

/**
 * Fold a bipolar cv/gate sample (−1..+1) into the internal unipolar 0..1
 * convention the attenuverter math works in: `cv*0.5 + 0.5`, clamped. So
 * −1 → 0, 0 → 0.5, +1 → 1. A gate's 0/1 maps to 0.5/1 (a high gate reads
 * as a positive half-swing). Audio is NOT folded — it arrives already 0..1
 * from the envelope follower.
 */
export function foldCvToUnipolar(cv: number): number {
  return clamp01((Number.isFinite(cv) ? cv : 0) * 0.5 + 0.5);
}

/**
 * Mutable one-pole envelope-follower state. `value` is the current 0..1
 * envelope; `attack`/`release` are the per-step smoothing coefficients
 * (0..1, higher = faster). `makeEnvelopeFollower` chooses fast attack / slow
 * release so an audio source's loudness reads as a smooth 0..1 modulation.
 */
export interface EnvelopeFollower {
  value: number;
  attack: number;
  release: number;
}

/** Create an envelope follower with fast-attack / slow-release coefficients
 *  (attack default 0.5, release default 0.05 ⇒ attack ≫ release). */
export function makeEnvelopeFollower(attack = 0.5, release = 0.05): EnvelopeFollower {
  return { value: 0, attack: clamp01(attack), release: clamp01(release) };
}

/**
 * Advance an envelope follower by one step from a window of audio samples
 * (a Float32Array, typically the analyser's time-domain buffer). Computes the
 * window's RMS (a robust loudness measure), then one-poles toward it with a
 * FAST attack when rising / SLOW release when falling. Returns + stores the new
 * 0..1 value. Unipolar by construction (RMS ≥ 0; clamped to 1). A silent window
 * (RMS 0) decays the value toward 0 at the release rate (so 0 in → 0 out at
 * steady state). Pure-ish: mutates `env.value` (the caller owns the state).
 */
export function followEnvelope(env: EnvelopeFollower, samples: Float32Array): number {
  let sumSq = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const s = samples[i] ?? 0;
    sumSq += s * s;
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const target = clamp01(rms);
  const coef = target > env.value ? env.attack : env.release;
  env.value = clamp01(env.value + (target - env.value) * coef);
  return env.value;
}
