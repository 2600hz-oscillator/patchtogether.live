// packages/web/src/lib/audio/modules/warrenspectrum-draw.ts
//
// Shared renderer for WARRENSPECTRUM's visualization. Called by both
// the on-card 2D canvas effect AND the cross-domain audio→video bridge
// (same drawFrame pattern as SCOPE). Single source of truth for the
// EQ-curve + waveform + acidwarp color cycling + ping flash.

export interface WarrenspectrumSnapshot {
  wave: Float32Array;          // recent L-channel input samples
  flash: number[];             // per-band flash 0..1
  levels: number[];            // per-band slider levels (0..2)
  frame: number;               // monotonic frame counter for hue cycle
  viznoise: number;            // 0..1 — hue cycle speed
}

type Ctx2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const NUM_BANDS = 8;

export function drawWarrenspectrum(
  ctx2d: Ctx2d,
  snap: WarrenspectrumSnapshot,
  w: number,
  h: number,
): void {
  // Dark background — keeps the saturated EQ curve readable.
  ctx2d.fillStyle = '#0a0c12';
  ctx2d.fillRect(0, 0, w, h);

  // Hue cycle: viznoise=0 → 0.5°/frame, viznoise=1 → 8°/frame.
  const huePerFrame = 0.5 + snap.viznoise * 7.5;
  const baseHue = (snap.frame * huePerFrame) % 360;

  // Per-band x position: 8 bars evenly spaced with 6% padding either side.
  const padX = w * 0.06;
  const usable = w - 2 * padX;
  function bandX(i: number): number {
    return padX + (i / (NUM_BANDS - 1)) * usable;
  }

  // Compute bar tops (y = h * (1 - level/2 * 0.85)).
  const tops: { x: number; y: number }[] = [];
  for (let i = 0; i < NUM_BANDS; i++) {
    const lv = Math.max(0, Math.min(2, snap.levels[i] ?? 1));
    const y = h - (lv / 2) * h * 0.85 - h * 0.05;
    tops.push({ x: bandX(i), y });
  }

  // 1. Per-band LED meter columns — drawn BEFORE the EQ so the spline
  //    rides on top. Discrete segments green→yellow→red bottom-up; lit
  //    segment count tracks snap.flash[i] (0..1). Unlit LEDs render at
  //    18% alpha so the column structure stays visible at idle.
  drawLedColumns(ctx2d, snap.flash, bandX, usable, h);

  // 2. Vertical bars at slider positions, hue cycling per band.
  const barW = (usable / (NUM_BANDS - 1)) * 0.18;
  for (let i = 0; i < NUM_BANDS; i++) {
    const top = tops[i]!;
    const hue = (baseHue + i * 24) % 360;
    ctx2d.fillStyle = `hsl(${hue}, 70%, 55%)`;
    ctx2d.fillRect(top.x - barW / 2, top.y, barW, h - top.y - 4);
  }

  // 3. Catmull-Rom-ish spline through bar tops. We use the standard
  //    centripetal CR formulation projected onto cubic Bezier segments
  //    for clean Canvas2D rendering.
  ctx2d.strokeStyle = `hsl(${(baseHue + 60) % 360}, 70%, 65%)`;
  ctx2d.lineWidth = 2;
  ctx2d.lineCap = 'round';
  ctx2d.beginPath();
  ctx2d.moveTo(tops[0]!.x, tops[0]!.y);
  for (let i = 0; i < tops.length - 1; i++) {
    const p0 = tops[Math.max(0, i - 1)]!;
    const p1 = tops[i]!;
    const p2 = tops[i + 1]!;
    const p3 = tops[Math.min(tops.length - 1, i + 2)]!;
    // Standard uniform CR → Bezier control points.
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    ctx2d.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
  ctx2d.stroke();

  // 4. Audio waveform overlay — thin scope trace, semi-transparent.
  ctx2d.strokeStyle = `hsla(${(baseHue + 180) % 360}, 70%, 70%, 0.55)`;
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  const wave = snap.wave;
  const midY = h * 0.5;
  const ampY = h * 0.35;
  for (let i = 0; i < wave.length; i++) {
    const x = (i / (wave.length - 1)) * w;
    const y = midY - Math.max(-1, Math.min(1, wave[i] ?? 0)) * ampY;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();

  // 5. Subtle band-frequency axis ticks at the bottom.
  ctx2d.fillStyle = 'rgba(180, 200, 220, 0.35)';
  ctx2d.font = '8px ui-monospace, monospace';
  ctx2d.textAlign = 'center';
  const labels = ['80', '160', '320', '640', '1.3k', '2.6k', '5.1k', '10k'];
  for (let i = 0; i < NUM_BANDS; i++) {
    ctx2d.fillText(labels[i]!, bandX(i), h - 1);
  }
}

const SEGMENT_COUNT = 10;
const UNLIT_ALPHA = 0.18;

// Hue stops bottom→top: green (130), yellow-green (90), yellow (55), red (0).
// We pick hues per-segment so the gradient visibly moves through the
// classic VU palette regardless of canvas height.
function ledHueForSegment(i: number): number {
  const t = i / (SEGMENT_COUNT - 1);
  // Two-piece linear: 0..0.6 = 130→55 (green→yellow), 0.6..1 = 55→0 (yellow→red).
  if (t < 0.6) return 130 - (t / 0.6) * (130 - 55);
  return 55 - ((t - 0.6) / 0.4) * 55;
}

function drawLedColumns(
  ctx2d: Ctx2d,
  flash: number[],
  bandX: (i: number) => number,
  usable: number,
  h: number,
): void {
  const colW = (usable / (NUM_BANDS - 1)) * 0.45;
  // Reserve top 4% + bottom 12% (label area) so the meter has breathing
  // room and never collides with the frequency labels.
  const botY = h * 0.88;
  const stackH = botY - h * 0.04;
  const segGap = Math.max(1, Math.floor(stackH * 0.012));
  const segH = (stackH - segGap * (SEGMENT_COUNT - 1)) / SEGMENT_COUNT;

  for (let i = 0; i < NUM_BANDS; i++) {
    const level = Math.max(0, Math.min(1, flash[i] ?? 0));
    const litCount = Math.round(level * SEGMENT_COUNT);
    const x = bandX(i) - colW / 2;
    for (let s = 0; s < SEGMENT_COUNT; s++) {
      const hue = ledHueForSegment(s);
      const isLit = s < litCount;
      ctx2d.fillStyle = isLit
        ? `hsl(${hue}, 90%, 55%)`
        : `hsla(${hue}, 70%, 35%, ${UNLIT_ALPHA})`;
      const y = botY - (s + 1) * segH - s * segGap;
      ctx2d.fillRect(x, y, colW, segH);
    }
  }
}
