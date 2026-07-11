// packages/web/src/lib/audio/modules/dockscope-draw.ts
//
// DOCKSCOPE's slim single-channel trace renderer — SHARES scope-draw's
// sample→pixel math (pixelFromSample + the ±1/±5V display-range
// conventions) instead of forking it, per the P2.5b "import/share, don't
// fork" directive. SCOPE's own render paths are untouched (its VRT
// baselines stay byte-stable); this file only ADDS the rail-slim variant.
//
// Rail-optimized: the draw is a PURE VECTOR redraw against whatever
// backing-store size the caller hands it. DockscopeCard re-sizes the
// canvas backing store to the card's LIVE on-screen pixel size
// (getBoundingClientRect × devicePixelRatio — which folds in the dock's
// 50–150% scale ladder) and passes `pixelRatio` so strokes/labels/insets
// scale with it. Result: the trace is re-plotted at native resolution at
// every dock zoom step — no fixed-raster blur (the P2.5a disqualifier for
// docking the regular SCOPE, whose 320×300 bitmap upscales soft).

import { pixelFromSample, RANGE_MAX_AUDIO, RANGE_MAX_CV } from './scope-draw';

export interface DockscopeDrawParams {
  /** Time-window in ms shown across the full canvas width (SCOPE's knob). */
  timeMs: number;
  /** Vertical zoom multiplier (SCOPE's chNScale convention). */
  scale: number;
  /** Display range: 0 = audio (±1 fills), ≥0.5 = CV (±5 fills). */
  range: number;
  /** Trace color (defaults to SCOPE's ch1 amber). */
  color?: string;
  /**
   * Backing-store pixels per LOGICAL (unscaled CSS) pixel — the card passes
   * devicePixelRatio × dock scale. Geometry is proportional to w/h already;
   * this scales the non-proportional bits (stroke width, label font, insets)
   * so the render reads identically at every dock zoom step. Default 1.
   */
  pixelRatio?: number;
}

/** Background fill — same dark screen as SCOPE's BG. */
export const DOCKSCOPE_BG = '#0a0c10';

/**
 * Draw one time-domain trace across the full canvas. Idempotent — safe to
 * call every frame. Geometry mirrors scope-draw's drawChannel: the newest
 * `timeMs` window of samples maps left→right, pixelFromSample normalises
 * amplitude per the range convention, `scale` multiplies on top.
 */
export function drawDockscope(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  sampleRate: number,
  params: DockscopeDrawParams,
  width: number,
  height: number,
): void {
  const k = params.pixelRatio ?? 1;
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.fillStyle = DOCKSCOPE_BG;
  ctx2d.fillRect(0, 0, width, height);

  // Center line (0V reference) — same reference chrome as SCOPE.
  ctx2d.strokeStyle = '#1f242c';
  ctx2d.lineWidth = 1 * k;
  ctx2d.beginPath();
  ctx2d.moveTo(0, height / 2);
  ctx2d.lineTo(width, height / 2);
  ctx2d.stroke();

  const isCv = params.range >= 0.5;
  const rangeMax = isCv ? RANGE_MAX_CV : RANGE_MAX_AUDIO;
  const color = params.color ?? '#fbbf24';

  const samplesInWindow = Math.min(
    samples.length,
    Math.max(2, Math.round((params.timeMs / 1000) * sampleRate)),
  );
  const step = Math.max(1, Math.floor(samplesInWindow / Math.max(1, width)));
  const start = samples.length - samplesInWindow;
  const halfH = height / 2;

  ctx2d.strokeStyle = color;
  ctx2d.globalAlpha = 1;
  ctx2d.lineWidth = 1.5 * k;
  ctx2d.beginPath();
  for (let i = 0; i < samplesInWindow; i += step) {
    // Same normalisation chain as SCOPE's drawChannel: mode-aware ±1 vs
    // ±cvRange (pixelFromSample), then the vertical zoom, around mid-line.
    const yOffsetPx = pixelFromSample(samples[start + i] ?? 0, isCv, halfH, RANGE_MAX_CV);
    const y = halfH - yOffsetPx * params.scale;
    const x = (i / samplesInWindow) * width;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();

  // Corner range label (SCOPE's convention: '±1.0' audio, '±5V' CV).
  ctx2d.save();
  ctx2d.font = `${9 * k}px ui-monospace, monospace`;
  ctx2d.fillStyle = color;
  ctx2d.globalAlpha = 0.65;
  ctx2d.fillText(isCv ? '±5V' : '±1.0', 4 * k, 10 * k);
  ctx2d.restore();
}
