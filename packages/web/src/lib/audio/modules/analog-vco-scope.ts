// packages/web/src/lib/audio/modules/analog-vco-scope.ts
//
// Single-cycle waveform extraction + 2D draw for the ANALOG VCO card's
// on-card scope. Pure functions (no DOM, no engine) so they're unit-
// testable; the card wires them to an HTMLCanvasElement on rAF.
//
// The card reads a snapshot from the engine handle's read('waveform') —
// a live time-domain buffer off an AnalyserNode tapped on the MORPH output
// — so the trace reflects the live `shape` morph AND any FM / pitch / PM
// modulation, NOT an idealized static curve.
//
// Windowing strategy (in priority order):
//   1. Zero-crossing lock: find a rising zero-crossing, then the NEXT
//      rising zero-crossing one period later, and draw that exact span.
//      This locks one cycle even when FM/pitch has shifted the actual
//      frequency away from the knob-implied value — the displayed period
//      tracks the real modulated output.
//   2. Frequency fallback: if no clean cycle is found (silence, sub-audio,
//      or a waveform with no clean rising crossing), size the window from
//      the knob-implied freqHz (sampleRate / freqHz samples).
// Both are clamped to the available buffer length.

export interface VcoScopeWindow {
  /** Start index into the source buffer for the displayed cycle. */
  start: number;
  /** Number of samples in the displayed cycle. */
  length: number;
  /** True when a zero-crossing-locked cycle was found (vs. freq fallback). */
  locked: boolean;
}

/**
 * Find one period of the waveform in `data`, preferring zero-crossing lock.
 * Returns a window {start, length} that the draw routine maps across the
 * full canvas width. Falls back to the knob-implied frequency when no clean
 * rising→rising cycle can be located.
 */
export function findCycleWindow(
  data: Float32Array,
  sampleRate: number,
  freqHz: number,
): VcoScopeWindow {
  const n = data.length;
  // Expected period in samples from the knob-implied frequency. Used both as
  // the fallback window and as a sanity bound on the zero-crossing search.
  const expected = freqHz > 0 ? sampleRate / freqHz : n;
  const fallback: VcoScopeWindow = {
    start: 0,
    length: Math.max(2, Math.min(n, Math.round(expected))),
    locked: false,
  };
  if (n < 4) return fallback;

  // A small hysteresis band keeps noise near zero from registering as
  // spurious crossings. Scale it to the signal's peak so quiet signals still
  // detect; silent buffers (peak ~0) skip detection and use the fallback.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(data[i]!);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return fallback;
  const eps = peak * 0.02;

  const firstRising = (from: number, to: number): number => {
    for (let i = from; i < to; i++) {
      if (data[i]! <= -eps && data[i + 1]! > -eps) return i;
    }
    return -1;
  };

  const start = firstRising(0, n - 1);
  if (start < 0) return fallback;

  // Lock on the NEXT rising crossing — the true period is start→next,
  // regardless of the knob-implied frequency. This makes the displayed period
  // track the REAL (FM/pitch-modulated) output, not a stale knob estimate.
  // A small ABSOLUTE minimum gap rejects the hysteresis-band sample jitter
  // immediately after the crossing WITHOUT assuming a period (so even a wildly
  // wrong implied frequency still locks the real cycle). 2 samples is the floor;
  // a 20 kHz tone at 48 kHz has a ~2.4-sample period, the worst audible case.
  const next = firstRising(start + 2, n - 1);
  if (next < 0) return fallback;

  return { start, length: next - start, locked: true };
}

export interface VcoScopeColors {
  trace: string;
  axis: string;
  bg: string;
}

/**
 * Draw one cycle of `data` (sliced to the cycle window) across the full
 * canvas. Vertical range is fixed to [-1, 1] (the morph output is bounded).
 */
export function drawVcoCycle(
  ctx2d: CanvasRenderingContext2D,
  data: Float32Array,
  sampleRate: number,
  freqHz: number,
  width: number,
  height: number,
  colors: VcoScopeColors,
): void {
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.fillStyle = colors.bg;
  ctx2d.fillRect(0, 0, width, height);

  // Zero axis.
  const mid = height / 2;
  ctx2d.strokeStyle = colors.axis;
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, mid);
  ctx2d.lineTo(width, mid);
  ctx2d.stroke();

  const win = findCycleWindow(data, sampleRate, freqHz);
  if (win.length < 2) return;

  ctx2d.strokeStyle = colors.trace;
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  // Vertical scale: leave a small margin so peaks aren't clipped at the edge.
  const ampH = (height / 2) * 0.9;
  for (let x = 0; x < width; x++) {
    // Map canvas x → sample index within the cycle window.
    const frac = width <= 1 ? 0 : x / (width - 1);
    const idx = win.start + Math.min(win.length - 1, Math.round(frac * win.length));
    const v = data[idx] ?? 0;
    const y = mid - v * ampH;
    if (x === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}
