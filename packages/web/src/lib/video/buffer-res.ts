// packages/web/src/lib/video/buffer-res.ts
//
// Per-module heavy-buffer resolution override (hd-toggle plan §4.5).
//
// The deep-buffer modules — TOYBOX (33-deep RGBA32F history ring), b3ntb0x
// (8× oversampled float encode/bend passes), VDELAY (32-frame ring), BACKDRAFT
// (31-frame ring) — are O(pixels × depth) and can each consume hundreds of MB to
// ~1 GB of VRAM at 1080p. They DEFAULT to SD internal buffers even when global
// HD is on, and expose a per-module RES dropdown (SD / 720p / 1080p). 720p/1080p
// are only honored when the local global HD toggle is ON (the engine is running
// at an HD res); a peer with HD off renders the node's heavy buffers at SD so a
// saved 1080p node never forces an OOM on a weak GPU.
//
// Scope: the heavy INTERNAL buffers only — the module still composites into the
// global engine `res`; the rings/oversample targets are sampled/upscaled into
// the pipeline. So "SD rings in a 1080p global" = full-res output with softer
// feedback/CRT internal detail.
//
// Pure + GL-free so it unit-tests deterministically.

/** bufferRes param values. Stored as a number param (CV/MIDI-irrelevant) so it
 *  persists with the patch + is e2e-addressable. */
export const BUFFER_RES_SD = 0;
export const BUFFER_RES_720 = 1;
export const BUFFER_RES_1080 = 2;

export type BufferResValue = 0 | 1 | 2;

/** Short-edge line count for each setting. SD = 480 (the VIDEO_RES height). */
export const BUFFER_RES_LINES: Record<BufferResValue, number> = {
  [BUFFER_RES_SD]: 480,
  [BUFFER_RES_720]: 720,
  [BUFFER_RES_1080]: 1080,
};

export interface Dims {
  width: number;
  height: number;
}

/** Coerce an arbitrary stored param value to a valid BufferResValue (default SD). */
export function clampBufferResValue(v: unknown): BufferResValue {
  const n = typeof v === 'number' ? Math.round(v) : 0;
  if (n === BUFFER_RES_720) return BUFFER_RES_720;
  if (n === BUFFER_RES_1080) return BUFFER_RES_1080;
  return BUFFER_RES_SD;
}

/**
 * Compute the effective heavy-buffer dimensions for a hungry module.
 *
 * Rules (plan §4.5):
 *  - Global HD OFF (`!hdActive`) → always SD, regardless of the dropdown.
 *  - Global HD ON → the dropdown's short-edge line count, at the SAME aspect as
 *    the global engine res (so the upscale into the pipeline is a clean scale).
 *  - SD selection (or SD-clamped) → exactly the engine's SD dimensions when HD
 *    is off, else the SD-equivalent at the engine aspect.
 *  - Result rounded to even; never larger than the global engine res on either
 *    axis (allocating bigger-than-output rings is pure waste).
 *
 * @param bufferRes  The module's dropdown value (0=SD, 1=720, 2=1080).
 * @param hdActive   Whether the global engine is running an HD res.
 * @param engineRes  The current global engine render res.
 */
export function effectiveBufferDims(
  bufferRes: BufferResValue,
  hdActive: boolean,
  engineRes: Dims,
): Dims {
  const aspect =
    engineRes.height > 0 ? engineRes.width / engineRes.height : 640 / 480;

  // HD off → clamp to SD (the engine is at VIDEO_RES anyway, so use that).
  const lines = hdActive ? BUFFER_RES_LINES[bufferRes] : BUFFER_RES_LINES[BUFFER_RES_SD];

  // Short edge = `lines`. Width derived from the engine aspect (landscape: width
  // is the long edge; portrait: width is the short edge). Engine res is the
  // single source of orientation truth.
  let w: number;
  let h: number;
  if (aspect >= 1) {
    h = lines;
    w = Math.round(h * aspect);
  } else {
    w = lines;
    h = Math.round(w / aspect);
  }

  // Never exceed the global engine res — the ring is sampled/upscaled INTO the
  // engine-res pipeline, so a bigger ring buys nothing and wastes VRAM.
  if (w > engineRes.width) w = engineRes.width;
  if (h > engineRes.height) h = engineRes.height;

  // Even-round + floor at 2px.
  w -= w & 1;
  h -= h & 1;
  if (w < 2) w = 2;
  if (h < 2) h = 2;
  return { width: w, height: h };
}
