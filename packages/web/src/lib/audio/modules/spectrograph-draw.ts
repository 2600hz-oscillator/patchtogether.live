// packages/web/src/lib/audio/modules/spectrograph-draw.ts
//
// Pure (GPU-free) core for the SPECTROGRAPH module's two video outputs.
// Lifted from WAVESCULPT's drawSpectrograph (video_mode 2): a log-binned
// scrolling sonogram. Frequency on the vertical axis (log scale, low at
// the BOTTOM, 20 Hz .. 20 kHz), time scrolling horizontally with the
// NEWEST column on the RIGHT.
//
// The data plane is a circular column buffer of dBFS magnitudes
// (`specBuf`, SPEC_W columns × SPEC_H rows, row 0 = top = high Hz). The
// audio module owns the buffer + advances it (binning the live FFT into
// a fresh column each frame); these functions are the STATELESS render
// of the current buffer into an ImageData via a colormap. Two colormaps
// share the exact same binned dB plane:
//   * heatmapRgb     — the WAVESCULPT blue→cyan→yellow→red heat ramp.
//   * grayscaleInvRgb — INVERTED grayscale (quiet = white, loud = black):
//     the classic printed-sonogram look (light page, dark traces).
//
// Pure functions of (buffer, colormap, dims) → no DOM, no analyser, no
// wall clock → unit-testable in node + deterministic for VRT once the
// caller pins the buffer contents.

export const SPEC_W = 256;
export const SPEC_H = 128;

// Display dB window: -90 dBFS (very quiet) → -10 dBFS (loud), normalized
// to [0..1] for the colormap. Linear-in-dB feels more natural than
// mapping raw amplitude (which crushes quiet content). Identical to
// WAVESCULPT's drawSpectrograph window so the heat output matches.
export const DB_LO = -90;
export const DB_HI = -10;

/** A colormap: normalized magnitude m∈[0..1] → [r,g,b] (each 0..255). */
export type Colormap = (m: number) => [number, number, number];

/** Clamp to [0,1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map a normalised magnitude m∈[0..1] to the WAVESCULPT heat ramp
 *  (dark blue → cyan → yellow → red). Inlined arithmetic — kept
 *  byte-identical to WavesculptCard.heatmapRgb so the COLOR output
 *  matches WAVESCULPT's spectrograph pixel-for-pixel. */
export function heatmapRgb(m: number): [number, number, number] {
  const v = clamp01(m);
  if (v < 0.25) {
    // Black → dark blue
    const t = v / 0.25;
    return [0, 0, Math.round(80 + t * 100)];
  }
  if (v < 0.5) {
    // Blue → cyan
    const t = (v - 0.25) / 0.25;
    return [0, Math.round(t * 200), Math.round(180 + t * 75)];
  }
  if (v < 0.75) {
    // Cyan → yellow
    const t = (v - 0.5) / 0.25;
    return [Math.round(t * 255), Math.round(200 + t * 55), Math.round(255 - t * 255)];
  }
  // Yellow → red
  const t = (v - 0.75) / 0.25;
  return [255, Math.round(255 - t * 255), 0];
}

/** INVERTED grayscale: quiet (m=0) → white (255), loud (m=1) → black
 *  (0). The classic printed-sonogram look — a light page with dark
 *  traces. g = round((1 - m) * 255), applied to all three channels. */
export function grayscaleInvRgb(m: number): [number, number, number] {
  const g = Math.round((1 - clamp01(m)) * 255);
  return [g, g, g];
}

/** Normalize a raw dBFS value into the display [0..1] window. */
export function normDb(db: number): number {
  return (db - DB_LO) / (DB_HI - DB_LO);
}

/**
 * Render the circular dB column buffer into `data` (RGBA bytes of size
 * SPEC_W × SPEC_H) using `colormap`. The oldest column lives at
 * `writeCol`, the newest at `writeCol-1` (mod SPEC_W); we walk SPEC_W
 * columns from `writeCol` so the RIGHTMOST screen column is the freshest
 * data (time scrolls left→right, newest at the right). Pure: no canvas,
 * no analyser, no clock.
 *
 * @param buf    SPEC_W*SPEC_H dBFS values, column-major (col*SPEC_H + row).
 * @param writeCol the circular write head (next column to be overwritten).
 * @param data   destination RGBA bytes (length >= SPEC_W*SPEC_H*4).
 * @param colormap normalized-dB → RGB.
 */
export function renderSpectrographInto(
  buf: Float32Array,
  writeCol: number,
  data: Uint8ClampedArray | number[],
  colormap: Colormap,
): void {
  for (let x = 0; x < SPEC_W; x++) {
    const srcCol = (writeCol + x) % SPEC_W;
    for (let y = 0; y < SPEC_H; y++) {
      const db = buf[srcCol * SPEC_H + y] ?? -100;
      const [r, g, b] = colormap(normDb(db));
      const o = (y * SPEC_W + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
}

/**
 * Log-bin one FFT frame into a fresh spectrograph column, written into
 * `buf` at column `writeCol`. Row 0 = top of the image = high Hz; row
 * SPEC_H-1 = bottom = low Hz (frequency on the vertical axis, log scale,
 * low at the bottom — matches WAVESCULPT). Bin k of an `fftSize`-length
 * FFT covers (k * sampleRate / fftSize) Hz; we map each row → target Hz
 * (log-spaced over [20 Hz .. min(20 kHz, Nyquist)]) and pick the nearest
 * FFT bin (clamped to bin 1, skipping DC). Pure: deterministic given
 * (bins, sampleRate, fftSize, writeCol).
 */
export function writeSpectrumColumn(
  buf: Float32Array,
  writeCol: number,
  bins: Float32Array,
  sampleRate: number,
  fftSize: number,
): void {
  const F_LO = 20;
  const F_HI = Math.min(20000, sampleRate * 0.5);
  const logLo = Math.log(F_LO);
  const logHi = Math.log(F_HI);
  const binCount = bins.length;
  const hzPerBin = sampleRate / fftSize;
  for (let r = 0; r < SPEC_H; r++) {
    const t = 1 - r / (SPEC_H - 1); // 0 at bottom, 1 at top
    const hz = Math.exp(logLo + t * (logHi - logLo));
    const binIdx = Math.max(1, Math.min(binCount - 1, Math.round(hz / hzPerBin)));
    buf[writeCol * SPEC_H + r] = bins[binIdx] ?? -100;
  }
}
