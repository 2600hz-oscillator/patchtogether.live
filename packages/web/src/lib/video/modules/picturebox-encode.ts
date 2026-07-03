// packages/web/src/lib/video/modules/picturebox-encode.ts
//
// Pure helpers for the PICTUREBOX multiplayer-sync pipeline:
//   1. zoom-fit-crop math (4:3 cover, at the engine VIDEO_RES) — node-testable.
//   2. Uint8Array <-> base64 (browser + jsdom safe).
//   3. browser-side downscaleAndEncode() that turns a File / Blob into a
//      base64 JPEG q=85 string sized to TARGET_W x TARGET_H.
//
// See .myrobots/plans/picturebox-multiplayer-sync.md for the rationale
// behind the codec + size choice.

import { VIDEO_RES } from '../engine';
import type { DecodedGifFrame } from './gif-frames';

export type { DecodedGifFrame };

// Encode at the engine resolution (1024×768, 4:3) so the synced image matches
// the FBO it's rendered into — same 4:3 aspect as the old 640×480, sharper.
export const TARGET_W = VIDEO_RES.width;
export const TARGET_H = VIDEO_RES.height;
export const JPEG_QUALITY = 0.85;
export const IMAGE_MIME = 'image/jpeg';
export const GIF_MIME = 'image/gif';

// --- Animated-GIF sync limits -------------------------------------------------
// The ORIGINAL gif bytes ride the Y.Doc out to every rack-mate (unlike the
// JPEG path, they are NOT downscaled — we must preserve every frame). That makes
// the payload the raw file size, so we cap it: a gif over the cap falls back to a
// first-frame JPEG (+ a card hint) so one huge meme can't hammer the relay. 1.5MB
// raw (~2MB base64) comfortably fits the typical animated gif while bounding the
// worst case. Decoded-frame count is separately capped so a pathological gif
// can't balloon GPU memory (each frame is a resident ImageBitmap).
export const MAX_GIF_BYTES = 1_500_000;
export const MAX_GIF_FRAMES = 300;
/** Fallback per-frame delay when a gif frame reports none (10fps, the gif
 *  default), and the floor we clamp very-short delays to (browsers similarly
 *  clamp sub-20ms gif delays). */
export const DEFAULT_GIF_FRAME_MS = 100;
export const MIN_GIF_FRAME_MS = 20;

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
  targetW: number = TARGET_W,
  targetH: number = TARGET_H,
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
export async function base64ToImageBitmap(
  b64: string,
  mime: string = IMAGE_MIME,
): Promise<ImageBitmap> {
  const bytes = base64ToBytes(b64);
  // The Blob constructor's BlobPart type prefers ArrayBuffer-backed views;
  // a Uint8Array<ArrayBufferLike> from a fresh allocation IS that, but
  // TS's stricter generic widening trips up under svelte-check. The cast
  // is safe — we just allocated this Uint8Array against an ArrayBuffer.
  // For a `image/gif` mime this decodes the FIRST frame statically — used both
  // for the ImageDecoder-unsupported degrade path and the size-cap fallback.
  const blob = new Blob([bytes as BlobPart], { type: mime });
  // Decode bottom-up ('flipY') so that uploading with UNPACK_FLIP_Y_WEBGL=true
  // (see picturebox.setImage) lands the image right-side-up under vUv sampling
  // — the repo-wide orientation convention. EXIF rotation is irrelevant here:
  // these bytes are our OWN re-encoded JPEG (drawn top-down onto an
  // OffscreenCanvas in downscaleAndEncode, which strips EXIF), so 'from-image'
  // was a no-op for rotation AND left the result upside-down. NOTE: Chromium
  // ignores UNPACK_FLIP_Y_WEBGL for Blob-sourced ImageBitmaps, so baking the
  // flip into the bitmap here is what actually corrects orientation.
  return await createImageBitmap(blob, {
    imageOrientation: 'flipY' as ImageBitmapOptions['imageOrientation'],
  });
}

// ---------------------------------------------------------------------------
// Animated-GIF support
// ---------------------------------------------------------------------------

/**
 * Count the image frames in a GIF byte stream — PURE, node-testable (no
 * ImageDecoder). Walks the GIF89a block structure counting Image Descriptors
 * (0x2C separators), correctly skipping the logical-screen / global colour
 * table, extension blocks (incl. Graphic Control Extensions), local colour
 * tables, and LZW image data sub-blocks. Returns 0 for a non-GIF / malformed
 * header, or the frame count so far on truncation (defensive, never throws).
 *
 * `> 1` ⇒ animated (worth byte-preserving); `<= 1` ⇒ a still that can take the
 * cheaper JPEG path.
 */
export function countGifFrames(bytes: Uint8Array): number {
  // Header: "GIF87a" / "GIF89a".
  if (bytes.length < 13) return 0;
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return 0; // 'G','I','F'

  let p = 6; // past the 6-byte signature
  // Logical Screen Descriptor (7 bytes): w(2) h(2) packed(1) bg(1) aspect(1).
  const packed = bytes[p + 4]!;
  p += 7;
  // Global Colour Table, if present.
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    p += gctSize;
  }

  let frames = 0;
  const skipSubBlocks = (): void => {
    // A chain of length-prefixed sub-blocks terminated by a 0x00 length byte.
    while (p < bytes.length) {
      const len = bytes[p++]!;
      if (len === 0) return;
      p += len;
    }
  };

  while (p < bytes.length) {
    const block = bytes[p++]!;
    if (block === 0x3b) break; // Trailer — end of stream.
    if (block === 0x21) {
      // Extension: label byte, then sub-blocks.
      p++; // label (0xF9 GCE, 0xFE comment, 0xFF app, 0x01 plain-text)
      skipSubBlocks();
      continue;
    }
    if (block === 0x2c) {
      // Image Descriptor = one frame. 9 bytes: left(2) top(2) w(2) h(2) packed(1).
      frames++;
      const imgPacked = bytes[p + 8];
      p += 9;
      if (imgPacked === undefined) break; // truncated
      if (imgPacked & 0x80) {
        const lctSize = 3 * (1 << ((imgPacked & 0x07) + 1));
        p += lctSize;
      }
      p++; // LZW minimum code size
      skipSubBlocks(); // image data
      continue;
    }
    // Unknown block id → malformed; stop with the count so far.
    break;
  }
  return frames;
}

/** True iff these bytes are an ANIMATED gif (more than one image frame). */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  return countGifFrames(bytes) > 1;
}

/** Result of encoding a user-picked file for sync. */
export interface EncodedPick {
  /** base64 payload written to node.data (imageBytes / assets[i]). */
  base64: string;
  /** MIME of `base64`: 'image/gif' (animated, byte-preserved) or 'image/jpeg'. */
  mime: string;
  /** True iff the stored bytes are an animated gif the render path animates. */
  animated: boolean;
  /** 'gif-too-large' when an animated gif exceeded MAX_GIF_BYTES and we fell
   *  back to a first-frame JPEG (the card surfaces a hint). 'none' otherwise. */
  fellBack: 'none' | 'gif-too-large';
}

/**
 * Browser-only: turn a picked File into the bytes we sync.
 *
 *   - Animated gif within the size cap → the ORIGINAL gif bytes (base64,
 *     mime 'image/gif'). No re-encode, so every frame is preserved.
 *   - Animated gif OVER the cap → first-frame JPEG + fellBack:'gif-too-large'.
 *   - Single-frame gif / any other image → JPEG q=0.85 (the existing path).
 */
export async function encodePickedFile(file: File | Blob): Promise<EncodedPick> {
  const name = (file as File).name ?? '';
  const isGif = file.type === GIF_MIME || /\.gif$/i.test(name);
  if (isGif) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isAnimatedGif(bytes)) {
      if (bytes.length <= MAX_GIF_BYTES) {
        return { base64: bytesToBase64(bytes), mime: GIF_MIME, animated: true, fellBack: 'none' };
      }
      // Too large to sync as-is — degrade to a static first-frame JPEG.
      const base64 = await downscaleAndEncode(file);
      return { base64, mime: IMAGE_MIME, animated: false, fellBack: 'gif-too-large' };
    }
    // Single-frame gif → JPEG (createImageBitmap decodes its one frame).
  }
  const base64 = await downscaleAndEncode(file);
  return { base64, mime: IMAGE_MIME, animated: false, fellBack: 'none' };
}

// --- WebCodecs ImageDecoder (self-contained types) ---------------------------
// The WebCodecs `ImageDecoder` / `VideoFrame` globals are NOT in the TS DOM lib
// we build against, so we declare the narrow surface we use here rather than
// pulling a whole @types package. Runtime feature-detection guards every use.
interface DecodedImageResult {
  image: { duration: number | null; close: () => void };
  complete: boolean;
}
interface ImageDecoderTrack {
  frameCount: number;
}
interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack: ImageDecoderTrack | null };
  decode: (opts: { frameIndex: number }) => Promise<DecodedImageResult>;
  close: () => void;
}
interface ImageDecoderCtor {
  new (init: { type: string; data: BufferSource }): ImageDecoderLike;
  isTypeSupported: (type: string) => Promise<boolean>;
}

/** True iff this runtime can decode animated gifs via WebCodecs ImageDecoder. */
export async function canDecodeAnimatedGif(): Promise<boolean> {
  const ID = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  if (!ID || typeof ID.isTypeSupported !== 'function') return false;
  try {
    return await ID.isTypeSupported(GIF_MIME);
  } catch {
    return false;
  }
}

/**
 * Browser-only: decode an animated gif (base64) into per-frame bitmaps +
 * durations via WebCodecs ImageDecoder. Returns null when ImageDecoder is
 * unavailable / the type is unsupported / decode fails — the caller then
 * gracefully degrades to a static first frame (base64ToImageBitmap).
 *
 * Ownership: the returned ImageBitmaps are handed to the module, which closes
 * them on replace/clear/dispose. The intermediate VideoFrames + the decoder are
 * closed HERE (no leak) once each bitmap is materialised.
 */
export async function decodeAnimatedGif(
  b64: string,
  mime: string = GIF_MIME,
): Promise<DecodedGifFrame[] | null> {
  const ID = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  if (!ID) return null;
  if (!(await canDecodeAnimatedGif())) return null;

  const bytes = base64ToBytes(b64);
  let decoder: ImageDecoderLike | null = null;
  try {
    // Cast mirrors base64ToImageBitmap's BlobPart cast: a freshly-allocated
    // Uint8Array IS ArrayBuffer-backed, but TS widens it to ArrayBufferLike.
    decoder = new ID({ type: mime, data: bytes as unknown as BufferSource });
    await decoder.tracks.ready;
    let frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (!Number.isFinite(frameCount) || frameCount <= 0) return null;
    frameCount = Math.min(frameCount, MAX_GIF_FRAMES);

    const frames: DecodedGifFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
      let result: DecodedImageResult;
      try {
        result = await decoder.decode({ frameIndex: i });
      } catch {
        break; // partial gif — keep whatever decoded
      }
      const image = result.image;
      let durationMs = DEFAULT_GIF_FRAME_MS;
      if (typeof image.duration === 'number' && image.duration > 0) {
        durationMs = image.duration / 1000; // VideoFrame.duration is microseconds
      }
      durationMs = Math.max(MIN_GIF_FRAME_MS, durationMs);
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(image as unknown as ImageBitmapSource, {
          imageOrientation: 'flipY' as ImageBitmapOptions['imageOrientation'],
        });
      } catch {
        bitmap = null;
      } finally {
        try { image.close(); } catch { /* already closed */ }
      }
      if (bitmap) frames.push({ bitmap, durationMs });
    }
    return frames.length > 0 ? frames : null;
  } catch {
    return null;
  } finally {
    try { decoder?.close(); } catch { /* already closed */ }
  }
}
