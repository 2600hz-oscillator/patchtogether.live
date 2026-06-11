// packages/web/src/lib/video/vfpga/snapshot.ts
//
// CPU-side preview snapshots for VFPGA effects that have a deterministic
// generator pattern (so the host card can draw an on-card preview WITHOUT a GL
// readback — and identically whether the effect renders on the main thread or
// the off-main-thread worker). v1 ships only the smpte-bars snapshot, which
// mirrors the SMPTE_FRAG colour math in plain TS so it's pure + unit-testable.
//
// Sibling to acidwarp's buildCardSnapshot — same motivation (a cheap, GL-free,
// pollable preview), same fixed internal resolution.

/** Card preview internal resolution (4:3, matches acidwarp's 320×240). */
export const SNAPSHOT_W = 320;
export const SNAPSHOT_H = 240;

export interface SmpteSnapshotArgs {
  /** Pattern shift (0..7 columns) — mirrors uShift. */
  shift: number;
  /** Overall brightness gain control (0.5..1.0) — mirrors uBrightness. */
  brightness: number;
  /** Chroma saturation (0..1) — mirrors uSaturation. */
  saturation: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// The 7 top bars at 75% amplitude (EG 1-1990), index 0=grey..6=blue. Returns
// 0..1 RGB (matches SMPTE_FRAG.topBar).
function topBar(i: number): [number, number, number] {
  switch (i) {
    case 0: return [0.75, 0.75, 0.75]; // grey
    case 1: return [0.75, 0.75, 0.0];  // yellow
    case 2: return [0.0, 0.75, 0.75];  // cyan
    case 3: return [0.0, 0.75, 0.0];   // green
    case 4: return [0.75, 0.0, 0.75];  // magenta
    case 5: return [0.75, 0.0, 0.0];   // red
    default: return [0.0, 0.0, 0.75];  // blue
  }
}

function midBar(i: number): [number, number, number] {
  switch (i) {
    case 0: return [0.0, 0.0, 0.75];   // blue
    case 1: return [0.0, 0.0, 0.0];    // black
    case 2: return [0.75, 0.0, 0.75];  // magenta
    case 3: return [0.0, 0.0, 0.0];    // black
    case 4: return [0.0, 0.75, 0.75];  // cyan
    case 5: return [0.0, 0.0, 0.0];    // black
    default: return [0.75, 0.75, 0.75]; // grey
  }
}

function plugeBar(x: number): [number, number, number] {
  if (x < 1.0 / 6.0) return [0.0, 0.0, 0.30];  // -I
  if (x < 2.0 / 6.0) return [1.0, 1.0, 1.0];   // 100% white
  if (x < 3.0 / 6.0) return [0.18, 0.0, 0.34]; // +Q
  if (x < 4.0 / 6.0) return [0.0, 0.0, 0.0];   // black
  if (x < 5.0 / 6.0) {
    const t = (x - 4.0 / 6.0) * 18.0;
    if (t < 1.0) return [0.035, 0.035, 0.035]; // sub-black
    if (t < 2.0) return [0.0, 0.0, 0.0];       // black
    return [0.075, 0.075, 0.075];              // super-black
  }
  return [0.0, 0.0, 0.0]; // black
}

/**
 * Compute one RGB pixel of the SMPTE-bars pattern at normalized (x, y) in
 * top-down 0..1 coordinates. Pure — the single source of truth shared by the
 * snapshot raster + the unit test (and a 1:1 mirror of SMPTE_FRAG).
 */
export function smptePixel(
  x: number,
  y: number,
  args: SmpteSnapshotArgs,
): [number, number, number] {
  const yTopEnd = 0.67;
  const yMidEnd = 0.75;
  let col: [number, number, number];
  if (y < yTopEnd) {
    const idx = Math.floor(clamp01(x) * 7) % 7;
    const s = Math.round(args.shift);
    const shifted = (((idx + s) % 7) + 7) % 7;
    col = topBar(shifted);
  } else if (y < yMidEnd) {
    const idx = Math.floor(clamp01(x) * 7) % 7;
    col = midBar(idx);
  } else {
    col = plugeBar(clamp01(x));
  }
  // SATURATION → desaturate toward Rec.601 luma.
  const luma = col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114;
  const sat = clamp01(args.saturation);
  col = [
    luma + (col[0] - luma) * sat,
    luma + (col[1] - luma) * sat,
    luma + (col[2] - luma) * sat,
  ];
  // BRIGHTNESS → map 0.5..1.0 knob to 1.0..1.3333 gain.
  const gain = 1.0 + clamp01((args.brightness - 0.5) * 2.0) * (1.0 / 0.75 - 1.0);
  return [clamp01(col[0] * gain), clamp01(col[1] * gain), clamp01(col[2] * gain)];
}

/**
 * Render the SMPTE-bars pattern into a fresh ImageData at SNAPSHOT_W×SNAPSHOT_H
 * (top-down). The card putImageData()s this into its preview canvas. Allocates
 * one ImageData per call — the card polls at ~30 Hz; the pattern is cheap.
 *
 * Guarded for jsdom/test: when ImageData isn't available we return a plain
 * {data,width,height} that the snapshot unit test reads directly (the real
 * card only runs in the browser where ImageData exists).
 */
export function renderSmpteSnapshot(args: SmpteSnapshotArgs): ImageData {
  const w = SNAPSHOT_W;
  const h = SNAPSHOT_H;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const y = (j + 0.5) / h; // top-down
    for (let i = 0; i < w; i++) {
      const x = (i + 0.5) / w;
      const [r, g, b] = smptePixel(x, y, args);
      const p = (j * w + i) * 4;
      px[p] = Math.round(r * 255);
      px[p + 1] = Math.round(g * 255);
      px[p + 2] = Math.round(b * 255);
      px[p + 3] = 255;
    }
  }
  if (typeof ImageData !== 'undefined') {
    return new ImageData(px, w, h);
  }
  // jsdom fallback (unit tests): a structurally-compatible object.
  return { data: px, width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData;
}
