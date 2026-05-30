// packages/web/src/lib/audio/modules/rasterize-map.ts
//
// Pure, table-testable raster-mapping math for the RASTERIZE module
// (slice 1 of "crossing the streams"). See .myrobots/plans/
// audio-video-crossing.md.
//
// The model — the FAITHFUL audio-into-video-raster mapping, NOT an
// oscilloscope trace:
//
//   Each video frame, take a fixed run of audio samples (samplesPerFrame,
//   ~800 at 48k/60fps) and write them as voltage-per-pixel into the
//   640×480 video frame in raster order (left→right, top→bottom). A scan
//   cursor names the pixel index where this frame's run starts; it
//   advances by samplesPerFrame each frame and WRAPS through the frame
//   across successive frames (~1.25 scanlines painted per frame at the
//   default). The audio sample value (roughly -1..+1 after gain) maps to
//   pixel luminance.
//
//   This is what produces the classic look: a steady tone paints
//   horizontal bands whose spacing/drift depends on the audio frequency
//   vs the line/frame rate. There is NO limiter, NO anti-alias, NO
//   feedback guard — the harshness is intentional (see "Fully untamed"
//   in the locked spec).
//
// Everything here is deterministic + side-effect-free so the unit tests
// (rasterize-map.test.ts) can table-drive the cursor wrap, gain,
// samples-per-frame, and luminance arithmetic without a canvas or an
// AudioContext.

/** Wrap modes for the scan cursor when a frame's sample run runs off the
 *  end of the pixel grid. */
export type WrapMode =
  /** WRAP (0): the run continues from pixel 0 (toroidal). The cursor's
   *  next-frame start also wraps modulo the pixel count, so the painted
   *  region drifts smoothly through the frame — the default + the look
   *  the spec asks for. */
  | 'wrap'
  /** CLAMP (1): the run stops at the last pixel (no toroidal continue),
   *  and the next-frame cursor restarts at pixel 0 once it passes the
   *  end. Produces a hard top-to-bottom repaint sweep instead of a
   *  smooth drift. */
  | 'clamp';

/** Map the discrete wrap-mode param (0/1, like every other discrete knob
 *  in the codebase) to the WrapMode union. ≥0.5 ⇒ clamp. */
export function wrapModeFromParam(v: number): WrapMode {
  return v >= 0.5 ? 'clamp' : 'wrap';
}

/**
 * Convert a gained audio sample value (roughly -1..+1, but UNCLAMPED —
 * gain can push it past ±1 and we let it) into an 8-bit luminance
 * 0..255.
 *
 * Mapping: -1 → 0 (black), 0 → 128 (mid grey), +1 → 255 (white). i.e.
 *   luminance = round((sample + 1) / 2 * 255)
 *
 * Values outside ±1 (loud signal × high gain) saturate at 0 / 255 —
 * that hard clip at the *pixel* stage is the only "taming" and it's
 * inherent to writing into an 8-bit framebuffer, not an added limiter.
 */
export function sampleToLuminance(gainedSample: number): number {
  const n = (gainedSample + 1) * 0.5; // -1..+1 → 0..1
  const px = Math.round(n * 255);
  if (px < 0) return 0;
  if (px > 255) return 255;
  return px;
}

/** A single pixel write produced by the mapping: a flat raster pixel
 *  index (0 = top-left, increasing left→right then top→bottom) and the
 *  luminance to write there. */
export interface PixelWrite {
  /** Flat raster index in [0, width*height). */
  index: number;
  /** 8-bit luminance to write at `index`. */
  luminance: number;
}

export interface RasterFrameParams {
  /** Frame dimensions in pixels. */
  width: number;
  height: number;
  /** Pixel index where THIS frame's sample run begins. The caller (the
   *  module) advances + persists this across frames; the pure mapping
   *  never holds state. */
  cursor: number;
  /** How many audio samples to paint this frame. One pixel per sample. */
  samplesPerFrame: number;
  /** Linear gain applied to every sample before the luminance map. */
  gain: number;
  /** Cursor wrap behaviour when the run passes the last pixel. */
  wrap: WrapMode;
}

/** The result of mapping one frame's sample run. */
export interface RasterFrameResult {
  /** The pixel writes, in raster order, for this frame. */
  writes: PixelWrite[];
  /** Where the cursor should START next frame. Always normalised into
   *  [0, width*height) so the module can persist it verbatim. */
  nextCursor: number;
}

/**
 * Normalise an arbitrary (possibly negative or out-of-range) cursor into
 * a valid pixel index [0, total). Used for the start-offset knob, whose
 * raw value can be any integer.
 */
export function normalizeCursor(cursor: number, total: number): number {
  if (total <= 0) return 0;
  // Math.floor first so a fractional cursor (CV-modulated start offset)
  // lands on a concrete pixel; then a true modulo (handles negatives).
  // Guard NaN/Infinity (a stray CV write can produce either) → pixel 0.
  const c = Math.floor(cursor);
  if (!Number.isFinite(c)) return 0;
  return ((c % total) + total) % total;
}

/**
 * Map ONE video frame's worth of audio samples into pixel writes.
 *
 * `samples` is the run of audio sample values for this frame. The mapping
 * paints `min(samples.length, samplesPerFrame)` pixels starting at
 * `cursor`, one pixel per sample, in raster order, applying `gain` then
 * the luminance map. Returns the writes plus the next-frame cursor.
 *
 * Pure: no canvas, no clamping of the sample COUNT to the buffer beyond
 * the obvious `length` guard, no smoothing. The caller decides how to
 * actually splat the writes into an ImageData / texture.
 */
export function mapRasterFrame(
  samples: Float32Array | readonly number[],
  params: RasterFrameParams,
): RasterFrameResult {
  const { width, height, samplesPerFrame, gain, wrap } = params;
  const total = Math.max(0, Math.floor(width) * Math.floor(height));
  if (total === 0) {
    return { writes: [], nextCursor: 0 };
  }

  const count = Math.max(0, Math.min(samples.length, Math.floor(samplesPerFrame)));
  let cursor = normalizeCursor(params.cursor, total);

  const writes: PixelWrite[] = [];
  for (let i = 0; i < count; i++) {
    if (cursor >= total) {
      // Ran off the bottom of the frame mid-run.
      if (wrap === 'clamp') {
        // CLAMP: stop painting this frame; the run is truncated at the
        // frame boundary. nextCursor restarts at the top.
        return { writes, nextCursor: 0 };
      }
      // WRAP: continue from the top (toroidal).
      cursor = 0;
    }
    const s = (samples[i] ?? 0) * gain;
    writes.push({ index: cursor, luminance: sampleToLuminance(s) });
    cursor++;
  }

  // Where does the NEXT frame start?
  let nextCursor: number;
  if (wrap === 'clamp') {
    // CLAMP: the cursor advances linearly and snaps back to 0 once it
    // reaches/passes the end (handled above mid-run; here for the case
    // where the run ended exactly at or before `total`).
    nextCursor = cursor >= total ? 0 : cursor;
  } else {
    // WRAP: toroidal — the next start is just the current cursor modulo
    // total, so the painted region drifts smoothly frame-to-frame.
    nextCursor = cursor % total;
  }
  return { writes, nextCursor };
}

/**
 * Convenience: how many scanlines a single frame's run spans, at the
 * given samplesPerFrame + width. Used by the card's readout + by tests
 * documenting the "~1.25 scanlines/frame at default" behaviour.
 */
export function scanlinesPerFrame(samplesPerFrame: number, width: number): number {
  if (width <= 0) return 0;
  return samplesPerFrame / width;
}
