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
// from a Uint8ClampedArray), but at 60fps and 640×360 px that's well
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

const RANGE_MAX_AUDIO = 1;
const RANGE_MAX_CV = 5;

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
  // Center line.
  ctx2d.strokeStyle = '#1f242c';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2);
  ctx2d.lineTo(w, h / 2);
  ctx2d.stroke();

  const samplesInWindow = Math.min(
    snap.ch1.length,
    Math.max(2, Math.round((params.timeMs / 1000) * snap.sampleRate)),
  );
  const step = Math.max(1, Math.floor(samplesInWindow / w));

  drawChannel(ctx2d, snap.ch1, samplesInWindow, step, w, h, ch1Color, 1, params.ch1Scale, params.ch1Offset, ch1RangeMax);
  drawChannel(ctx2d, snap.ch2, samplesInWindow, step, w, h, ch2Color, 0.6, params.ch2Scale, params.ch2Offset, ch2RangeMax);
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
  for (let i = 0; i < samplesInWindow; i += step) {
    const v = ((samples[start + i] ?? 0) / rangeMax) * scale + offset;
    const x = (i / samplesInWindow) * w;
    const y = h / 2 - v * (h / 2);
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;
}
