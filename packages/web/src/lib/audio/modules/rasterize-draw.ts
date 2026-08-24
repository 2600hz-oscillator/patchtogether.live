// packages/web/src/lib/audio/modules/rasterize-draw.ts
//
// Canvas-splatting layer for RASTERIZE. Wraps the pure mapping
// (rasterize-map.ts) with a persistent frame buffer + the per-frame
// canvas blit. Used by BOTH:
//
//   1. The cross-domain audio→video texture bridge in VideoEngine —
//      RASTERIZE's videoSources entry exposes a `drawFrame(canvas)`
//      callback that the bridge invokes each video frame, then uploads
//      the canvas pixels to a GL texture for downstream video modules
//      (OUTPUT, MIXER, …). Same seam SCOPE uses (see scope-draw.ts).
//
//   2. The on-card <canvas> (RasterizeCard.svelte) so the operator sees
//      the same raster painting on the module card itself.
//
// Persistence: the raster painting ACCUMULATES — each frame only the
// freshly-scanned run of pixels changes; the rest of the frame retains
// whatever luminance the cursor last wrote there. That persistence is
// what makes a steady tone build up steady horizontal bands. We keep a
// single Uint8ClampedArray RGBA framebuffer at the engine's video
// resolution and mutate it in place each frame.

import {
  mapRasterFrame,
  wrapModeFromParam,
  normalizeCursor,
  type WrapMode,
} from './rasterize-map';

/** Live RASTERIZE params the draw step reads (mirrors the module def). */
export interface RasterizeDrawParams {
  /** Scan-cursor START OFFSET in pixels (the "scan cursor" knob). Added
   *  to the running cursor only when the operator moves it; the running
   *  cursor otherwise advances on its own. See RasterPainter. */
  cursor: number;
  /** Samples to paint per frame (the "samples/frame" knob). */
  samplesPerFrame: number;
  /** Linear gain applied to each sample pre-luminance. */
  gain: number;
  /** Wrap mode discrete param (0 = wrap, 1 = clamp). */
  wrap: number;
}

/**
 * Stateful raster painter. Owns the persistent RGBA framebuffer + the
 * running scan cursor; `paint()` advances one video frame given the
 * latest audio samples + params.
 *
 * Deliberately NOT pure (it holds the accumulated frame) — the pure
 * mapping math lives in rasterize-map.ts and is unit-tested there. This
 * class is exercised end-to-end by the VRT baseline.
 */
export class RasterPainter {
  readonly width: number;
  readonly height: number;
  /** RGBA8 framebuffer, width*height*4. Persists across frames. */
  private readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  /** The running raster cursor (pixel index). Advances every frame. */
  private cursor = 0;
  /** Last START-OFFSET param value we saw, so we only RE-SEAT the running
   *  cursor when the operator actually moves the knob (vs. the automatic
   *  per-frame advance). */
  private lastStartOffset = 0;
  /** The one ImageData view over `rgba` — see `imageData()`. */
  private imageDataCache: ImageData | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    // Back the buffer with an explicit ArrayBuffer (not SharedArrayBuffer)
    // so the ImageData constructor's strict typed-array signature is met.
    this.rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    // Initialise to opaque black so an unpainted frame reads as black
    // (matches the video engine's black-background convention).
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
  }

  /** Reset the framebuffer to opaque black + cursor to 0. */
  reset(): void {
    this.rgba.fill(0);
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
    this.cursor = 0;
    this.lastStartOffset = 0;
  }

  /**
   * Current running cursor (pixel index).
   *
   * ⚠ THE STATED CONSUMER NO LONGER EXISTS, AND THE SEAM IS KEPT ANYWAY. This
   * said "Exposed for the card readout"; that readout was the resting decimal
   * deleted by the 2026-08-17 faceplate ruling, and a sweep now finds exactly
   * two references to this getter — its own definition and the one call inside
   * `rasterize.ts`'s `read('cursor')`. No card, no body, no test, no e2e.
   *
   * It is NOT dead code to delete on sight: it is the only external read of the
   * RUNNING cursor, which is precisely the observable a fix for the SCAN
   * change-detector defect has to assert against ("the knob says 1000, the
   * cursor says 49,800" — the knob and the drifting position diverge
   * permanently, because re-selecting a value the knob already shows is a
   * no-op). A dead seam carrying a stale reason is how a future sweep deletes
   * the thing a fix needs; the reason is now the real one.
   */
  get currentCursor(): number {
    return this.cursor;
  }

  /**
   * Advance one video frame: map `samples` into pixel writes, mutate the
   * persistent RGBA buffer, and advance the running cursor. Returns
   * nothing — read the buffer via `blitTo` / `imageData`.
   */
  paint(samples: Float32Array | readonly number[], params: RasterizeDrawParams): void {
    const total = this.width * this.height;
    if (total === 0) return;

    // When the operator moves the START-OFFSET knob, re-seat the running
    // cursor (a manual scrub). Otherwise leave the running cursor alone so
    // it keeps drifting on its own — that drift is the whole point.
    const startOffset = Math.floor(params.cursor);
    if (startOffset !== this.lastStartOffset) {
      this.cursor = normalizeCursor(startOffset, total);
      this.lastStartOffset = startOffset;
    }

    const wrap: WrapMode = wrapModeFromParam(params.wrap);
    const { writes, nextCursor } = mapRasterFrame(samples, {
      width: this.width,
      height: this.height,
      cursor: this.cursor,
      samplesPerFrame: params.samplesPerFrame,
      gain: params.gain,
      wrap,
    });

    for (const w of writes) {
      const o = w.index * 4;
      this.rgba[o] = w.luminance; // R
      this.rgba[o + 1] = w.luminance; // G
      this.rgba[o + 2] = w.luminance; // B
      this.rgba[o + 3] = 255; // A
    }
    this.cursor = nextCursor;
  }

  /**
   * The persistent framebuffer as an ImageData (sized to the painter).
   *
   * ⚠ THE WRAPPER IS CACHED, AND THAT IS NOT A BEHAVIOUR CHANGE. `new
   * ImageData(buf, w, h)` ALIASES its typed array rather than copying it, so
   * every call has always handed back a live view of the SAME `rgba` buffer —
   * two successive calls could never disagree. What was new each time was only
   * the wrapper object.
   *
   * It was allocated per call, and this is a per-FRAME path with up to three
   * callers (the card, the dock body, the cross-domain bridge). At
   * `VIDEO_RES` that is a fresh 1024x768 ImageData — 786,432 pixels of
   * descriptor churn — for an object whose contents are identical to the last
   * one. `width`/`height` are `readonly` and `rgba` is never reallocated
   * (`reset()` fills in place), so one instance is valid for the painter's
   * whole lifetime.
   */
  imageData(): ImageData {
    if (!this.imageDataCache) {
      this.imageDataCache = new ImageData(this.rgba, this.width, this.height);
    }
    return this.imageDataCache;
  }

  /**
   * Blit the persistent framebuffer to a canvas. If the canvas size
   * matches the painter, `putImageData` is used directly; otherwise we
   * stage the buffer in a temp canvas + `drawImage`-scale into the target
   * (a card / dock canvas is smaller than the VIDEO_RES video resolution).
   */
  blitTo(canvas: OffscreenCanvas | HTMLCanvasElement): void {
    const ctx2d = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx2d) return;
    const img = this.imageData();
    if (canvas.width === this.width && canvas.height === this.height) {
      ctx2d.putImageData(img, 0, 0);
      return;
    }
    // Scale path: stage at native size, then drawImage into the target.
    if (typeof OffscreenCanvas !== 'undefined') {
      const stage = new OffscreenCanvas(this.width, this.height);
      const sctx = stage.getContext('2d');
      if (!sctx) return;
      sctx.putImageData(img, 0, 0);
      ctx2d.imageSmoothingEnabled = false;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.drawImage(stage, 0, 0, canvas.width, canvas.height);
      return;
    }
    // No OffscreenCanvas (old Safari / jsdom): fall back to a 1:1 putImage
    // clipped to the target. Better than nothing; mainstream browsers
    // never hit this branch.
    ctx2d.putImageData(img, 0, 0);
  }
}
