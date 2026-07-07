// packages/dsp/src/lib/dsp-utils.ts
//
// Tiny shared per-sample DSP utilities. Lives in `lib/` so esbuild inlines it
// into the top-level worklet entries at build time (the top-level .ts files in
// packages/dsp/src/ are worklet entries; helpers go here and `export` freely —
// see project memory `dsp-worklet-no-top-level-export`).
//
// Extracted from the retired chowkick-dsp core when the CHOWKICK module was
// deleted — kickdrum / snaredrum / snare-roll kept importing these generic
// helpers, so they moved to a neutral home. Behaviour is IDENTICAL (bit-exact
// copies): `clamp` and the 25 Hz-default one-pole DC blocker.

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ────────────────────────────────────────────────────────────────────────
// DC blocker: y[n] = x[n] − x[n−1] + R·y[n−1] (first-order high-pass).
// Keeps a percussive voice's output bipolar (no unipolar DC blob).
// ────────────────────────────────────────────────────────────────────────

export interface DcBlockState {
  x1: number;
  y1: number;
}

export function makeDcBlockState(): DcBlockState {
  return { x1: 0, y1: 0 };
}

export function dcBlockStep(
  x: number,
  state: DcBlockState,
  fcHz = 25,
  sr = 48000,
): number {
  const R = Math.exp(-2 * Math.PI * clamp(fcHz, 1, 0.45 * sr) / sr);
  const y = x - state.x1 + R * state.y1;
  state.x1 = x;
  state.y1 = y;
  return y;
}
