// packages/web/src/lib/audio/modules/wavecel-draw.ts
//
// Shared 2D-canvas draw logic for WAVECEL. Used by:
//   1. WavecelCard.svelte's on-card visualization (HTMLCanvasElement,
//      hot-loop driven by rAF; user toggles between '3d' and 'scope' modes).
//   2. The cross-domain audio→video bridges in VideoEngine for
//      WAVECEL.scope_out (mono-video) and WAVECEL.wave3d_out (video).
//      Each bridge owns an OffscreenCanvas and asks WAVECEL to draw into
//      it each video frame, then uploads pixels into a GL texture.
//
// Why share: keeps the on-card preview and the patched-out video signal
// pixel-equivalent (same compositing rules as scope-draw.ts for the
// SCOPE module — see PR-69 for the bug that motivated that pattern).
//
// The two video output ports ALWAYS render their respective views
// (scope_out always renders scope-style, wave3d_out always renders 3D-
// style) regardless of the card's vizMode toggle — the toggle controls
// only the on-card preview.

import type { SpreadTap } from '$lib/audio/wavecel-math';

export interface WavecelDrawParams {
  /** Active wavetable frame index (== morph * (frames.length - 1)).
   *  Used by the scope view AND by the 3D view as the fallback single-
   *  frame highlight when `taps` is omitted (e.g. video-bridge calls). */
  activeFrame: number;
  /** Optional per-tap descriptors from spreadTaps(). When provided to
   *  drawWave3D, the 3D view paints a multi-frame highlight blended
   *  toward white per tap weight (the on-card preview's behavior, which
   *  reflects spread + morph CV). When omitted, the 3D view falls back
   *  to a single white line at `activeFrame` (the video-bridge path). */
  taps?: SpreadTap[];
  /** Override stroke colors for the scope view. Defaults match the
   *  on-card orange so video-out parity is exact. */
  scopeColor?: string;
  scopeBackground?: string;
  /** Override the dim midline color for the scope grid. */
  scopeMidColor?: string;
}

const BG = '#0a0c11';
const SCOPE_FG = '#ff9628';
const SCOPE_MID = '#1f242e';
const ORANGE_3D = (alpha: number): string => `rgba(255,150,40,${alpha.toFixed(3)})`;
const ACTIVE_3D = '#ffffff';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * 3D wavetable view: orange polylines per frame, stacked back-to-front
 * in pseudo-perspective; active frame highlighted in white. RGB output —
 * route via cable type `video` (NOT `mono-video`) so the orange + white
 * colors survive downstream.
 */
export function drawWave3D(
  ctx: Ctx2D,
  fs: Float32Array[],
  w: number,
  h: number,
  params: WavecelDrawParams,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  if (!fs || fs.length === 0) return;

  const FC = fs.length;
  const margin = Math.max(4, Math.round(Math.min(w, h) * 0.025));
  const drawW = w - margin * 2;
  const drawH = h - margin * 2;
  // Pseudo-perspective: frame 0 sits at the back (highest y, smallest
  // width); frame FC-1 sits at the front. Each successive frame is
  // shifted DOWN-RIGHT by a small fraction and drawn slightly wider.
  const backWidth = drawW * 0.55;
  const frontWidth = drawW * 0.95;
  const totalDepth = drawH * 0.7;
  const yBack = margin + drawH * 0.05;

  // Per-frame highlight weight: when `taps` is supplied (on-card preview),
  // each tap contributes its weight to the two adjacent integer frames so
  // multi-frame spread + fractional morph paint a blended highlight. With
  // no taps (video-bridge call), fall back to a single white line at
  // params.activeFrame — preserves the original wave3d_out behavior.
  const highlight = new Float32Array(FC);
  if (params.taps && params.taps.length > 0) {
    for (const tap of params.taps) {
      const f1 = Math.floor(tap.frameFloat);
      const f2 = f1 + 1;
      if (f1 >= 0 && f1 < FC) highlight[f1] = Math.max(highlight[f1]!, tap.weight);
      if (f2 >= 0 && f2 < FC) highlight[f2] = Math.max(highlight[f2]!, tap.weight);
    }
  }

  for (let f = 0; f < FC; f++) {
    const t = FC > 1 ? f / (FC - 1) : 0;
    const frameW = backWidth + (frontWidth - backWidth) * t;
    const frameY = yBack + totalDepth * t;
    const xLeft = margin + (drawW - frameW) / 2 + (drawW * 0.05) * (t - 0.5) * 2;
    ctx.beginPath();
    const arr = fs[f]!;
    const N = arr.length;
    const sliceH = drawH * 0.16 * (0.6 + 0.4 * t);
    for (let s = 0; s < N; s++) {
      const x = xLeft + (s / (N - 1)) * frameW;
      const y = frameY - (arr[s]! ?? 0) * sliceH;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const hw = highlight[f]!;
    if (params.taps && hw > 0) {
      // Blend orange (depth-faded) → white as highlight weight grows.
      const baseAlpha = 0.25 + 0.6 * t;
      const orangeR = 255, orangeG = 150, orangeB = 40;
      const r = Math.round(orangeR + (255 - orangeR) * hw);
      const g = Math.round(orangeG + (255 - orangeG) * hw);
      const b = Math.round(orangeB + (255 - orangeB) * hw);
      const alpha = Math.min(1, baseAlpha + (1 - baseAlpha) * hw);
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(0.9, Math.min(w, h) / 100) + 0.7 * hw;
    } else if (!params.taps && f === params.activeFrame) {
      ctx.strokeStyle = ACTIVE_3D;
      ctx.lineWidth = Math.max(1.2, Math.min(w, h) / 80);
    } else {
      const alpha = 0.25 + 0.6 * t;
      ctx.strokeStyle = ORANGE_3D(alpha);
      ctx.lineWidth = Math.max(0.7, Math.min(w, h) / 140);
    }
    ctx.stroke();
  }
}

/**
 * Scope view: single-trace oscilloscope-style render of the active
 * wavetable frame. Mono-video friendly — the stroke color sits on a
 * dark background, brightness-only is what survives downcasting.
 */
export function drawWaveScope(
  ctx: Ctx2D,
  fs: Float32Array[],
  w: number,
  h: number,
  params: WavecelDrawParams,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = params.scopeBackground ?? BG;
  ctx.fillRect(0, 0, w, h);
  if (!fs || fs.length === 0) return;
  const arr = fs[Math.max(0, Math.min(fs.length - 1, params.activeFrame))]!;
  const margin = Math.max(4, Math.round(Math.min(w, h) * 0.025));
  const drawW = w - margin * 2;
  const drawH = h - margin * 2;
  const midY = margin + drawH / 2;
  ctx.strokeStyle = params.scopeMidColor ?? SCOPE_MID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin, midY);
  ctx.lineTo(margin + drawW, midY);
  ctx.stroke();
  ctx.beginPath();
  const N = arr.length;
  for (let s = 0; s < N; s++) {
    const x = margin + (s / (N - 1)) * drawW;
    const y = midY - arr[s]! * (drawH / 2) * 0.9;
    if (s === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = params.scopeColor ?? SCOPE_FG;
  ctx.lineWidth = Math.max(1.2, Math.min(w, h) / 90);
  ctx.stroke();
}
