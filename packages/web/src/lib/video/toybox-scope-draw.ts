// packages/web/src/lib/video/toybox-scope-draw.ts
//
// Pure 2D-canvas draw logic for TOYBOX's per-input inline mini-scopes (sibling
// to audio/modules/scope-draw.ts). Each of the 6 modulation inputs has an
// always-on scope: it plots the post scale+offset modulation value as a filled
// area + a 1px trace through the 0..1 window (the value normalized against the
// routed param's [min,max]). For an AUDIO source it additionally draws the raw
// time-domain waveform as a faint overlay UNDER the trace, so you can see the
// audio that's being envelope-followed.
//
// Kept in plain Canvas2D (no GL): the scopes are tiny (~64×22px) and the card
// already owns a 2D context per row. The card owns the per-input ring buffer of
// recent values; this module only knows how to RENDER one frame from a window.
//
// pixelFromValue is the single mapping (0 → baseline at the bottom, 1 → top), so
// the trace, fill, and waveform all share the same vertical axis. Unit-tested in
// toybox-scope-draw.test.ts.

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Map a normalized 0..1 value to a canvas Y pixel: 0 → the BASELINE (height-1,
 * the bottom), 1 → the TOP (0). Clamped to the [0, height-1] window. Pure.
 *
 *   y = (height - 1) * (1 - clamp01(value))
 */
export function pixelFromValue(value: number, height: number): number {
  const h = Math.max(1, height);
  return (h - 1) * (1 - clamp01(value));
}

/** A color theme for one scope (keyed off the input kind by the card). */
export interface ToyboxScopeColors {
  /** The trace + fill stroke. */
  trace: string;
  /** The fill below the trace (use a low-alpha variant of `trace`). */
  fill: string;
  /** The audio waveform overlay (faint). */
  wave: string;
  /** The 0..1 window frame / baseline. */
  grid: string;
  /** Background. */
  bg: string;
}

/** Inputs for one scope frame. */
export interface ToyboxScopeDrawArgs {
  /** Canvas pixel size (the card sizes the canvas; we read these). */
  width: number;
  height: number;
  /**
   * The ring of recent NORMALIZED values (0..1), oldest→newest. The newest is
   * at the end. Empty/absent → a flat baseline. These are already normalized to
   * the param's [min,max] window by the caller (so the trace fills 0..1).
   */
  values: ArrayLike<number>;
  /** Optional raw audio time-domain window (−1..+1) for the waveform overlay.
   *  Drawn only when present (audio sources). */
  wave?: ArrayLike<number> | null;
  colors: ToyboxScopeColors;
}

/**
 * Draw one TOYBOX input scope into a 2D context: background, the 0..1 window
 * baseline, an optional faint audio waveform overlay, then the filled-area +
 * 1px trace of the modulation values. Deterministic given identical args (no
 * time/random), so the card's VRT freeze can pin it.
 */
export function drawToyboxInputScope(
  ctx: CanvasRenderingContext2D,
  args: ToyboxScopeDrawArgs,
): void {
  const { width: w, height: h, values, wave, colors } = args;
  if (w <= 0 || h <= 0) return;

  // Background.
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  // Baseline (value 0) at the bottom + a faint mid line (value 0.5).
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  const midY = Math.round(pixelFromValue(0.5, h)) + 0.5;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();

  // Audio waveform overlay (faint, centred on 0.5): map −1..+1 → 0..1.
  if (wave && wave.length > 0) {
    ctx.strokeStyle = colors.wave;
    ctx.beginPath();
    const n = wave.length;
    for (let i = 0; i < n; i++) {
      const x = n > 1 ? (i / (n - 1)) * (w - 1) : 0;
      const s = wave[i] ?? 0;
      const y = pixelFromValue(s * 0.5 + 0.5, h);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Modulation trace: filled area under a 1px line through the 0..1 window.
  const m = values.length;
  if (m === 0) {
    // No samples yet: draw a flat baseline trace at value 0.
    const y = Math.round(pixelFromValue(0, h)) + 0.5;
    ctx.strokeStyle = colors.trace;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    return;
  }

  // Fill.
  ctx.fillStyle = colors.fill;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < m; i++) {
    const x = m > 1 ? (i / (m - 1)) * (w - 1) : 0;
    ctx.lineTo(x, pixelFromValue(values[i] ?? 0, h));
  }
  ctx.lineTo(w - 1, h);
  ctx.closePath();
  ctx.fill();

  // 1px trace.
  ctx.strokeStyle = colors.trace;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < m; i++) {
    const x = m > 1 ? (i / (m - 1)) * (w - 1) : 0;
    const y = pixelFromValue(values[i] ?? 0, h);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
