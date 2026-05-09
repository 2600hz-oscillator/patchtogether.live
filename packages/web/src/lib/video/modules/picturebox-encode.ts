// packages/web/src/lib/video/modules/picturebox-encode.ts
//
// Pure helpers for the PICTUREBOX multiplayer-sync pipeline:
//   1. zoom-fit-crop math (640x480 4:3 cover) — node-testable.
//   2. Uint8Array <-> base64 (browser + jsdom safe).
//   3. browser-side downscaleAndEncode() that turns a File / Blob into a
//      base64 JPEG q=85 string sized to TARGET_W x TARGET_H.
//
// See .myrobots/plans/picturebox-multiplayer-sync.md for the rationale
// behind the codec + size choice.

export const TARGET_W = 640;
export const TARGET_H = 480;
export const JPEG_QUALITY = 0.85;
export const IMAGE_MIME = 'image/jpeg';

export interface CropRect {
  /** Where to draw the source on the destination canvas. */
  dx: number;
  dy: number;
  /** Source size scaled into destination space. */
  dw: number;
  dh: number;
}

/**
 * Compute the destination-space draw rectangle for a `cover`-style
 * zoom-fit-crop into a TARGET_W x TARGET_H canvas. The source aspect is
 * preserved and the longer dimension hangs off the canvas (gets clipped).
 *
 * Pure math, no DOM. Tested under vitest in node.
 */
export function computeZoomFitCrop(
  srcW: number,
  srcH: number,
  targetW = TARGET_W,
  targetH = TARGET_H,
): CropRect {
  if (srcW <= 0 || srcH <= 0) {
    // Defensive fallback: degenerate source draws nothing meaningful.
    return { dx: 0, dy: 0, dw: targetW, dh: targetH };
  }
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (targetW - dw) / 2;
  const dy = (targetH - dh) / 2;
  return { dx, dy, dw, dh };
}

/**
 * Encode a Uint8Array as base64. Chunked to avoid call-stack overflow on
 * large buffers (a 100 KB JPEG would push ~100k char codes through
 * String.fromCharCode in one call otherwise).
 *
 * Mirrors packages/web/src/lib/graph/persistence.ts's bytesToBase64 — kept
 * separate so this module has no upstream import (pure unit-testable).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

/** Decode a base64 string into a Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Browser-only: take a File / Blob (or already-decoded ImageBitmap),
 * decode it, draw it zoom-fit-crop onto an OffscreenCanvas at TARGET_W x
 * TARGET_H, encode as JPEG q=0.85, and return the base64 string.
 *
 * Throws on decode failure (unsupported codec, corrupted file). Caller
 * surfaces the error to the user via toast.
 */
export async function downscaleAndEncode(
  source: File | Blob | ImageBitmap,
): Promise<string> {
  const bitmap =
    source instanceof ImageBitmap
      ? source
      : await createImageBitmap(source, {
          // imageOrientation 'from-image' applies EXIF rotation so e.g. an
          // iPhone portrait photo doesn't render sideways. Browsers that
          // don't recognise the option ignore it.
          imageOrientation: 'from-image' as ImageBitmapOptions['imageOrientation'],
        });

  // OffscreenCanvas is supported in every modern browser we target. If
  // it's not available (very old Safari), we'd need an HTMLCanvasElement
  // fallback — flag it as a future-work item rather than maintaining two
  // paths today. For now, surface the lack of support as an error.
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error(
      'OffscreenCanvas not available — image sync requires a modern browser',
    );
  }

  const canvas = new OffscreenCanvas(TARGET_W, TARGET_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  // Black background so transparent source pixels (PNG alpha) become
  // black instead of leaking the canvas's default rgba(0,0,0,0). The
  // shader treats imageMime as opaque so we want a defined background.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, TARGET_W, TARGET_H);

  const rect = computeZoomFitCrop(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, rect.dx, rect.dy, rect.dw, rect.dh);

  const blob = await canvas.convertToBlob({
    type: IMAGE_MIME,
    quality: JPEG_QUALITY,
  });
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

/**
 * Decode a base64 JPEG string back to an ImageBitmap suitable for
 * `texImage2D`. Used by PictureboxCard's $effect to materialize remote
 * (or just-loaded local) images into the engine's source texture.
 */
export async function base64ToImageBitmap(b64: string): Promise<ImageBitmap> {
  const bytes = base64ToBytes(b64);
  // The Blob constructor's BlobPart type prefers ArrayBuffer-backed views;
  // a Uint8Array<ArrayBufferLike> from a fresh allocation IS that, but
  // TS's stricter generic widening trips up under svelte-check. The cast
  // is safe — we just allocated this Uint8Array against an ArrayBuffer.
  const blob = new Blob([bytes as BlobPart], { type: IMAGE_MIME });
  return await createImageBitmap(blob, {
    imageOrientation: 'from-image' as ImageBitmapOptions['imageOrientation'],
  });
}
