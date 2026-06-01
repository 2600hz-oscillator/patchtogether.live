// packages/web/src/lib/audio/modules/scope-draw.ts
//
// Shared 2D-canvas draw logic for SCOPE. Used by:
//   1. ScopeCard.svelte's on-card visualization (HTMLCanvasElement,
//      hot-loop driven by rAF in the card).
//   2. The cross-domain audio→video bridge in VideoEngine, when SCOPE's
//      videoSources entry exposes a `drawFrame` callback. The bridge
//      owns an OffscreenCanvas, asks SCOPE to draw into it each video
//      frame, then uploads pixels to a GL texture for downstream video
//      modules (OUTPUT, video MIXER, etc.).
//
// Why share: PR-65 (SCOPE video-out) shipped a path where the bridge
// used the generic WaveformRenderer (R32F + shader) with the raw
// analyser buffer — no scope params applied. Result: the video output
// showed a 2048-sample window of ch1 at rangeMax=1.0, no scale/offset/
// XY/timeMs, NOT the same trace the on-card canvas drew. To the user
// that looked like "noise" because at 44.1kHz a 2048-sample window
// covers many audio cycles densely-packed across the canvas width
// (vs. the on-card timeMs-windowed, scaled, offset, range-aware
// trace). Sharing the draw function makes the video output a
// pixel-equivalent of the on-card render.
//
// We keep this in plain Canvas2D (no GL) for two reasons:
//   - The on-card canvas is already 2D; sharing means zero new code.
//   - SCOPE's render is feature-rich (XY mode, dual-channel split,
//     scale/offset/range per channel, color stripes). Re-implementing
//     it as a fragment shader would be 3× the LoC for no perf win at
//     ~280×120 sizes.
// The bridge does pay a per-frame canvas→texture upload (texSubImage2D
// from a Uint8ClampedArray), but at 60fps and 640×480 px that's well
// under 1ms on any modern machine.

export interface ScopeSnapshot {
  ch1: Float32Array;
  ch2: Float32Array;
  sampleRate: number;
}

export interface ScopeDrawParams {
  /** Time-window in ms shown across the full canvas width. */
  timeMs: number;
  /** Per-channel multiplicative scale (after range normalization). */
  ch1Scale: number;
  ch2Scale: number;
  /** Per-channel additive vertical offset, in NDC y units (-1..+1). */
  ch1Offset: number;
  ch2Offset: number;
  /** Per-channel range: 0 = audio (±1 fills), 1 = CV (±5 fills). */
  ch1Range: number;
  ch2Range: number;
  /** 0 = split (two stacked traces), 1 = XY (ch1 vs ch2 plot). */
  mode: number;
  /** Stroke colors per channel. Defaults match the cable colors. */
  ch1Color?: string;
  ch2Color?: string;
}

// Display-axis range conventions:
//   AUDIO: ±1.0 — Web Audio float-sample convention. A unity-gain VCO,
//          sampler, or MIXER sums sit in [-1, +1] under nominal levels.
//   CV:    ±5.0 — Eurorack canonical bipolar CV range. Pitch CV (V/oct)
//          travels ±5 octaves around the nominal centre; LFO depth knobs
//          + audio-rate cutoff modulation in this codebase (e.g. BLADES'
//          "±5 octaves at full deflection") all settle on this scale.
//          A 5V pulse fills the channel; a 1V (one-octave) ramp is a
//          readable 1/5 of the channel height — what you want for a
//          pitch-CV trace.
// Exposed for tests + the corner scale-label in drawScope.
export const RANGE_MAX_AUDIO = 1;
export const RANGE_MAX_CV = 5;

/**
 * Map a raw sample value to a vertical pixel offset around mid-line, for
 * the audio-display or CV-display convention. Extracted as a pure helper
 * so unit tests can pin the endpoints; the channel draw loop calls this
 * once per sample.
 *
 *   AUDIO mode (isCv=false): a ±1 sample fills the full half-height.
 *     pixel_y_offset = sample * halfHeight
 *   CV mode    (isCv=true):  a ±cvRange sample fills the full half-height.
 *     pixel_y_offset = (sample / cvRange) * halfHeight
 *
 * The returned offset is the SIGNED delta from the mid-line (positive =
 * up in canvas coords because the caller subtracts it from h/2). The
 * channel-draw loop owns the actual mid-y + scale/offset chain; this
 * helper is the mode-aware normaliser at the input of that chain.
 */
export function pixelFromSample(
  sample: number,
  isCv: boolean,
  halfHeight: number,
  cvRange: number,
): number {
  if (isCv) {
    return (sample / cvRange) * halfHeight;
  }
  return sample * halfHeight;
}

/** Top-level draw entry. Clears the canvas, fills bg, dispatches to
 *  drawSplit / drawXY based on mode. Idempotent — safe to call every
 *  frame against the same canvas. */
export function drawScope(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  snap: ScopeSnapshot,
  params: ScopeDrawParams,
  width: number,
  height: number,
): void {
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.fillStyle = '#0a0c10';
  ctx2d.fillRect(0, 0, width, height);

  const xyMode = (params.mode ?? 0) >= 0.5;
  const ch1Color = params.ch1Color ?? '#fbbf24';
  const ch2Color = params.ch2Color ?? '#60a5fa';
  const ch1RangeMax = (params.ch1Range ?? 0) >= 0.5 ? RANGE_MAX_CV : RANGE_MAX_AUDIO;
  const ch2RangeMax = (params.ch2Range ?? 0) >= 0.5 ? RANGE_MAX_CV : RANGE_MAX_AUDIO;

  if (xyMode) {
    drawXY(ctx2d, snap, params, width, height, ch1Color, ch1RangeMax, ch2RangeMax);
  } else {
    drawSplit(ctx2d, snap, params, width, height, ch1Color, ch2Color, ch1RangeMax, ch2RangeMax);
  }
}

/** Two traces stacked, sharing the same horizontal time axis. */
function drawSplit(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  snap: ScopeSnapshot,
  params: ScopeDrawParams,
  w: number,
  h: number,
  ch1Color: string,
  ch2Color: string,
  ch1RangeMax: number,
  ch2RangeMax: number,
): void {
  // Center line (0V reference).
  ctx2d.strokeStyle = '#1f242c';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2);
  ctx2d.lineTo(w, h / 2);
  ctx2d.stroke();

  // CV-mode reference rails. For each channel in CV mode, draw faint
  // dashed lines at ±cvRange so the user has a visual reference for
  // the trace's voltage corners. The rails sit at the channel's full
  // half-height (i.e. the pixel positions a ±cvRange sample would hit
  // before scale/offset). We don't draw rails for AUDIO mode — the ±1
  // limits are already at the visible top/bottom of the channel, so a
  // dashed line there is redundant with the canvas edge.
  const ch1IsCv = (params.ch1Range ?? 0) >= 0.5;
  const ch2IsCv = (params.ch2Range ?? 0) >= 0.5;
  if (ch1IsCv || ch2IsCv) {
    ctx2d.save();
    ctx2d.setLineDash([3, 3]);
    ctx2d.strokeStyle = '#1f242c';
    ctx2d.globalAlpha = 0.7;
    ctx2d.lineWidth = 1;
    if (ch1IsCv) {
      // ch1 rails sit one half-height from the mid-line — same scale as
      // the sample-to-pixel mapping in drawChannel (pixelFromSample
      // returns halfHeight for sample=cvRange). Drawing at h/2 ± (h/2)
      // would land at the canvas edges; we leave a 2px inset so the
      // dashes are visible without overlapping the border.
      ctx2d.beginPath();
      ctx2d.moveTo(0, 2);
      ctx2d.lineTo(w, 2);
      ctx2d.moveTo(0, h - 2);
      ctx2d.lineTo(w, h - 2);
      ctx2d.stroke();
    }
    ctx2d.restore();
  }

  const samplesInWindow = Math.min(
    snap.ch1.length,
    Math.max(2, Math.round((params.timeMs / 1000) * snap.sampleRate)),
  );
  const step = Math.max(1, Math.floor(samplesInWindow / w));

  drawChannel(ctx2d, snap.ch1, samplesInWindow, step, w, h, ch1Color, 1, params.ch1Scale, params.ch1Offset, ch1RangeMax);
  drawChannel(ctx2d, snap.ch2, samplesInWindow, step, w, h, ch2Color, 0.6, params.ch2Scale, params.ch2Offset, ch2RangeMax);

  // Corner scale labels — one for each channel in its own tint. Tells
  // the user at a glance which display range the trace is plotted against
  // ("±1.0" for AUDIO, "±5V" for CV). Drawn last so the trace lines
  // don't paint over them.
  drawScaleLabel(ctx2d, ch1RangeMax === RANGE_MAX_CV ? '±5V' : '±1.0', 4, 10, ch1Color);
  drawScaleLabel(ctx2d, ch2RangeMax === RANGE_MAX_CV ? '±5V' : '±1.0', 4, h - 4, ch2Color);
}

/** Tiny corner-label drawer. Same font + alpha as the tuner readout. */
function drawScaleLabel(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx2d.save();
  ctx2d.font = '9px ui-monospace, monospace';
  ctx2d.fillStyle = color;
  ctx2d.globalAlpha = 0.65;
  ctx2d.fillText(text, x, y);
  ctx2d.restore();
}

/** XY plot — ch1 horizontal, ch2 vertical. Phase relationships visible. */
function drawXY(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  snap: ScopeSnapshot,
  params: ScopeDrawParams,
  w: number,
  h: number,
  ch1Color: string,
  ch1RangeMax: number,
  ch2RangeMax: number,
): void {
  // Crosshair grid through the (offset-aware) origin.
  const cx = w / 2 + (params.ch1Offset * w) / 2;
  const cy = h / 2 - (params.ch2Offset * h) / 2;
  ctx2d.strokeStyle = '#1f242c';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, cy);
  ctx2d.lineTo(w, cy);
  ctx2d.moveTo(cx, 0);
  ctx2d.lineTo(cx, h);
  ctx2d.stroke();

  const samplesInWindow = Math.min(
    snap.ch1.length,
    Math.max(2, Math.round((params.timeMs / 1000) * snap.sampleRate)),
  );
  const start1 = snap.ch1.length - samplesInWindow;
  const start2 = snap.ch2.length - samplesInWindow;
  const step = Math.max(1, Math.floor(samplesInWindow / w));

  ctx2d.strokeStyle = ch1Color;
  ctx2d.globalAlpha = 0.85;
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  for (let i = 0; i < samplesInWindow; i += step) {
    const xv = ((snap.ch1[start1 + i] ?? 0) / ch1RangeMax) * params.ch1Scale + params.ch1Offset;
    const yv = ((snap.ch2[start2 + i] ?? 0) / ch2RangeMax) * params.ch2Scale + params.ch2Offset;
    const xPx = w / 2 + (xv * w) / 2;
    const yPx = h / 2 - (yv * h) / 2;
    if (i === 0) ctx2d.moveTo(xPx, yPx);
    else ctx2d.lineTo(xPx, yPx);
  }
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;
}

function drawChannel(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  samplesInWindow: number,
  step: number,
  w: number,
  h: number,
  color: string,
  alpha: number,
  scale: number,
  offset: number,
  rangeMax: number,
): void {
  ctx2d.strokeStyle = color;
  ctx2d.globalAlpha = alpha;
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  const start = samples.length - samplesInWindow;
  const halfH = h / 2;
  const isCv = rangeMax === RANGE_MAX_CV;
  for (let i = 0; i < samplesInWindow; i += step) {
    // pixelFromSample handles the mode-aware ±1 vs ±cvRange normalisation;
    // scale + offset apply on top (faders), then we translate around the
    // mid-line. NB: offset is in NDC y-units (-1..+1) — multiplied by
    // halfH to land in canvas pixels.
    const yOffsetPx = pixelFromSample(samples[start + i] ?? 0, isCv, halfH, RANGE_MAX_CV);
    const y = halfH - (yOffsetPx * scale + offset * halfH);
    const x = (i / samplesInWindow) * w;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;
}
