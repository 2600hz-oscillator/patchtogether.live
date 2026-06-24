// packages/web/src/lib/video/modules/fader-transitions.ts
//
// FADER — the pure transition core (no DOM, no GL). A "transition" blends two
// video frames A→B by a parameter t ∈ [0,1] with a SHAPE (fade / wipe / dissolve
// / star / checkerboard). The card's two faders (A↔B and dry/wet) each pick a
// transition shape; the GL fragment shader in fader.ts mirrors `transitionFactor`
// per pixel. Keeping the math here means the blend logic is unit-testable without
// a WebGL context (the GLSL is a line-for-line port of the same branches).
//
// `transitionFactor(t, mode, ux, uy)` returns the per-pixel A→B blend factor in
// [0,1]: 0 = show A, 1 = show B. The final colour is `mix(A, B, factor)`.

/** Transition shapes, in dropdown / shader-uniform index order. */
export const TRANSITION_NAMES = ['fade', 'wipe', 'dissolve', 'star', 'checkerboard'] as const;
export type TransitionName = (typeof TRANSITION_NAMES)[number];
/** 0=fade 1=wipe 2=dissolve 3=star 4=checkerboard (the `uMode` shader uniform). */
export type TransitionMode = 0 | 1 | 2 | 3 | 4;

export const TRANSITION_COUNT = TRANSITION_NAMES.length;

/** Clamp a mode index from arbitrary input (CV / persisted) to a valid mode. */
export function coerceMode(v: unknown): TransitionMode {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n >= TRANSITION_COUNT) return (TRANSITION_COUNT - 1) as TransitionMode;
  return n as TransitionMode;
}

export type RGB = [number, number, number];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix1 = (a: number, b: number, t: number): number => a + (b - a) * t;
export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [
  mix1(a[0], b[0], t), mix1(a[1], b[1], t), mix1(a[2], b[2], t),
];

/** GLSL-style smoothstep. */
function smoothstep(e0: number, e1: number, x: number): number {
  const d = e1 - e0;
  const t = clamp01((x - e0) / (Math.abs(d) < 1e-6 ? 1e-6 : d));
  return t * t * (3 - 2 * t);
}

/** Deterministic [0,1) hash of two integers (the classic GLSL sin-hash; matches
 *  the shader's `hash21`). Used by DISSOLVE for a stable per-cell threshold. */
export function hash21(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Cells across the frame for DISSOLVE noise + CHECKERBOARD tiling. */
export const DISSOLVE_CELLS = 120;
export const CHECKER_CELLS = 8;

/**
 * Per-pixel A→B blend factor for transition `mode` at progress `t`, at UV
 * (ux,uy) ∈ [0,1]². 0 = A, 1 = B. Endpoints are EXACT for every mode (t≤0 → 0,
 * t≥1 → 1) so a fader at rest is unambiguous.
 */
export function transitionFactor(t: number, mode: TransitionMode, ux: number, uy: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (mode) {
    case 0: // FADE — uniform crossfade.
      return t;
    case 1: { // WIPE — soft vertical edge sweeping left→right.
      const e = 0.02;
      return smoothstep(ux - e, ux + e, t);
    }
    case 2: { // DISSOLVE — random per-cell threshold; more B as t grows.
      const n = hash21(Math.floor(ux * DISSOLVE_CELLS), Math.floor(uy * DISSOLVE_CELLS));
      return n < t ? 1 : 0;
    }
    case 3: { // STAR — a 5-point star iris of B growing from the centre.
      const px = ux - 0.5, py = uy - 0.5;
      const ang = Math.atan2(py, px);
      const rad = Math.hypot(px, py) / 0.7071; // 0 centre → ~1 corner
      const starF = 0.6 - 0.4 * Math.cos(5 * ang); // ~0.2 along spikes, 1.0 in valleys
      const s = clamp01(rad * starF); // smaller along spikes → fills first
      const e = 0.03;
      return 1 - smoothstep(t - e, t + e, s);
    }
    default: { // 4 CHECKERBOARD — even cells fill in the first half of t, odd in the second.
      const cx = Math.floor(ux * CHECKER_CELLS);
      const cy = Math.floor(uy * CHECKER_CELLS);
      const even = (cx + cy) % 2 === 0;
      const phase = even ? t * 2 : t * 2 - 1;
      return clamp01(phase);
    }
  }
}

/** Convenience: the blended colour for two RGBs. */
export function transitionAt(a: RGB, b: RGB, t: number, mode: TransitionMode, ux: number, uy: number): RGB {
  return mixRGB(a, b, transitionFactor(t, mode, ux, uy));
}
