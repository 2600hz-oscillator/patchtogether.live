// packages/web/src/lib/ui/controls/scope-screen-model.ts
//
// PURE path-geometry for ScopeScreen.svelte — the point lists a screen mode
// strokes onto its canvas. No DOM, no engine: the curve/wave math is
// unit-testable and the Svelte component is a thin renderer that fills the dark
// screen and strokes these points (per the design guidance: canvas for
// generative graphics, not hand-authored SVG). Three modes:
//   - envelope: an ADSR curve from attack/decay/sustain/release params.
//   - wave:     one cycle of the oscillator's wave shape (a saw↔pulse morph
//               like TIDY VCO's shape law, or an explicit single-cycle buffer).
//   - waveform: a live time-domain trace (samples straight from an analyser).

export interface ScreenPoint {
  x: number;
  y: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return v > 0 ? 1 : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---- ENVELOPE mode ---------------------------------------------------------

export interface AdsrParams {
  /** Attack time (any unit — only the RATIO between stages matters here). */
  attack: number;
  decay: number;
  /** Sustain LEVEL, 0..1. */
  sustain: number;
  release: number;
}

/** Fraction of (attack+decay+release) spent holding the sustain plateau, so the
 *  DECAY-screen curve always shows a visible sustain segment even when the
 *  stage times are tiny. */
export const ENV_HOLD_FRAC = 0.28;
/** Vertical inset (fraction of height) so the peak/floor aren't flush to the edge. */
export const ENV_V_PAD = 0.08;

/**
 * ADSR anchor points across a `width`×`height` box (y grows DOWN — canvas
 * convention; value 1 = top, 0 = bottom). Five anchors: start(0) → attack peak
 * → decay to sustain → sustain hold → release to 0. The time axis is normalized
 * to the SUM of the stage times (+ a fixed hold), so the shape reflects the
 * RELATIVE durations regardless of absolute seconds. Redraw whenever a param
 * changes. Returns [] for a degenerate box.
 */
export function envelopeCurvePoints(
  p: AdsrParams,
  width: number,
  height: number,
): ScreenPoint[] {
  if (width <= 0 || height <= 0) return [];
  const a = Math.max(0, p.attack);
  const d = Math.max(0, p.decay);
  const r = Math.max(0, p.release);
  const s = clamp01(p.sustain);
  const hold = ENV_HOLD_FRAC * (a + d + r);
  const total = a + d + hold + r;
  // All stages zero → flat line at the bottom.
  if (total <= 0) {
    const y0 = valueToY(0, height);
    return [
      { x: 0, y: y0 },
      { x: width, y: y0 },
    ];
  }
  const xAttack = (a / total) * width;
  const xDecay = ((a + d) / total) * width;
  const xHold = ((a + d + hold) / total) * width;
  return [
    { x: 0, y: valueToY(0, height) },
    { x: xAttack, y: valueToY(1, height) },
    { x: xDecay, y: valueToY(s, height) },
    { x: xHold, y: valueToY(s, height) },
    { x: width, y: valueToY(0, height) },
  ];
}

/** Map an envelope value (0..1, 1 = peak) to a canvas y with vertical padding. */
export function valueToY(value: number, height: number): number {
  const v = clamp01(value);
  const pad = ENV_V_PAD * height;
  const usable = height - 2 * pad;
  return pad + (1 - v) * usable;
}

// ---- WAVE mode -------------------------------------------------------------

/**
 * One sample (−1..1) of a saw↔pulse morph at phase `phase01` (0..1). morph 0 =
 * sawtooth ramp, morph 1 = pulse (duty `pw`), linear crossfade between — TIDY
 * VCO's shape law (def: "0 = saw, 1 = pulse, continuous crossfade"). Pure so
 * the wave-mode geometry is testable at known phases.
 */
export function morphWaveSample(phase01: number, morph: number, pw = 0.5): number {
  const ph = phase01 - Math.floor(phase01); // wrap to [0,1)
  const saw = 2 * ph - 1;
  const square = ph < pw ? 1 : -1;
  const m = clamp01(morph);
  return (1 - m) * saw + m * square;
}

/** One cycle of the morph wave as canvas points across `width`×`height`. */
export function morphWavePoints(
  morph: number,
  width: number,
  height: number,
  samples = 128,
  pw = 0.5,
): ScreenPoint[] {
  if (width <= 0 || height <= 0 || samples < 2) return [];
  const pts: ScreenPoint[] = [];
  for (let i = 0; i < samples; i++) {
    const ph = i / (samples - 1);
    const v = morphWaveSample(ph, morph, pw);
    pts.push({ x: ph * width, y: bipolarToY(v, height) });
  }
  return pts;
}

/**
 * One sample (−1..1) of the LFO's 3-anchor morph at phase `phase01` (0..1):
 * shape 0 = sine, 1 = rising saw, 2 = square, with LINEAR crossfades between
 * adjacent anchors (0.5 = halfway sine↔saw) — the lfo def's documented shape
 * law. `amp` scales the swing (the lfo card's depth: 0.5 = unity ±1, so pass
 * min(1, 2·depth) for the display). Pure.
 */
export function triMorphWaveSample(phase01: number, shape: number, amp = 1): number {
  // Clamped to ONE display cycle [0,1] (no wrap): the endpoint keeps the
  // saw's full ramp / the square's second half instead of snapping back to
  // phase 0, so the drawn cycle reads cleanly edge to edge.
  const ph = phase01 < 0 ? 0 : phase01 > 1 ? 1 : phase01;
  const s = shape < 0 ? 0 : shape > 2 ? 2 : shape;
  const sine = Math.sin(ph * 2 * Math.PI);
  const saw = 2 * ph - 1;
  const square = ph < 0.5 ? 1 : -1;
  const v = s <= 1 ? (1 - s) * sine + s * saw : (2 - s) * saw + (s - 1) * square;
  return v * amp;
}

/**
 * One cycle of the LFO tri-morph as a sample buffer (−1..1) for ScopeScreen's
 * explicit-buffer `wave` mode — the lfo face's PARAM-REACTIVE live glyph
 * (recomputed whenever shape/depth change). Deterministic + pure.
 */
export function triMorphWaveSamples(shape: number, amp = 1, samples = 128): Float32Array {
  const n = Math.max(2, Math.floor(samples));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = triMorphWaveSample(i / (n - 1), shape, amp);
  }
  return out;
}

// ---- WAVEFORM mode (live trace) + explicit single-cycle buffers ------------

/** Vertical inset (fraction of height) for bipolar (−1..1) traces. */
export const TRACE_V_PAD = 0.1;

/** Map a bipolar sample (−1..1) to canvas y (y grows down; +1 = top). */
export function bipolarToY(sample: number, height: number): number {
  const pad = TRACE_V_PAD * height;
  const usable = height - 2 * pad;
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return pad + ((1 - clamped) / 2) * usable;
}

/**
 * Map a buffer of bipolar samples across the full `width` as canvas points,
 * decimating to at most `maxPoints` columns (one point per pixel column is
 * plenty; a 2048-sample analyser buffer over a ~120px screen decimates hard).
 * Used by both the live waveform trace and an explicit single-cycle wavetable
 * buffer. Returns [] for an empty buffer or degenerate box.
 */
export function samplesToPoints(
  data: ArrayLike<number>,
  width: number,
  height: number,
  maxPoints = 256,
): ScreenPoint[] {
  const n = data.length;
  if (n === 0 || width <= 0 || height <= 0) return [];
  const cols = Math.max(2, Math.min(maxPoints, Math.round(width)));
  const pts: ScreenPoint[] = [];
  for (let c = 0; c < cols; c++) {
    const frac = cols <= 1 ? 0 : c / (cols - 1);
    const idx = Math.min(n - 1, Math.round(frac * (n - 1)));
    pts.push({ x: frac * width, y: bipolarToY(data[idx] ?? 0, height) });
  }
  return pts;
}

/** Peak absolute sample in a buffer — used to gate "is the trace non-flat"
 *  (live-signal proof) without re-scanning in the component/tests. */
export function peakAmplitude(data: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i] ?? 0);
    if (a > peak) peak = a;
  }
  return peak;
}

// ---- STATIC glyph buffers (ModuleShell face glyphs) -------------------------
//
// The shell's tile glyphs are STATIC in this pass (no live taps): each
// `face.glyph` kind maps to a deterministic single-buffer trace rendered via
// the existing `wave`-mode explicit-buffer path (samplesToPoints). Pure + cheap
// (computed once at module scope by the consumer), so the VRT scenes stay
// pixel-deterministic.

/**
 * One (or `cycles`) full sine cycle(s), −1..1 — the generic "this module emits
 * a wave" glyph. Used for `glyph: 'waveform'` faces (LFO's default shape IS a
 * sine; for other oscillators it reads as a neutral wave placeholder until a
 * live trace is wired). Starts and ends at 0 for a seam-free trace.
 */
export function sineWaveSamples(samples = 128, cycles = 1): Float32Array {
  const n = Math.max(2, Math.floor(samples));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin((i / (n - 1)) * cycles * 2 * Math.PI);
  }
  return out;
}

/**
 * A decaying oscillation burst — sin(2π·cycles·t) · e^(−decay·t) — the
 * "struck/percussive source at rest" glyph for `glyph: 'scope'` faces (e.g.
 * kickdrum): a transient that rings down to idle, unlike the tidyVco saw morph
 * (which reads as a continuous oscillator). Deterministic; peak ≈ the first
 * quarter-cycle, tail → ~e^(−decay).
 */
export function burstWaveSamples(samples = 256, cycles = 3, decay = 5): Float32Array {
  const n = Math.max(2, Math.floor(samples));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = Math.sin(t * cycles * 2 * Math.PI) * Math.exp(-decay * t);
  }
  return out;
}
