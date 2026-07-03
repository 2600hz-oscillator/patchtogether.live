// packages/web/src/lib/video/modules/gif-frames.ts
//
// PURE frame scheduler for animated-GIF playback in PICTUREBOX (no DOM, no
// engine, no WebGL). Given a list of per-frame durations (milliseconds) and an
// elapsed time, decide which frame index is on screen — looping forever. The
// PICTUREBOX module calls frameIndexAtTime() once per engine draw() from
// ctx.time; keeping the math here makes it trivially unit-testable in node
// (mirrors asset-select.ts / mandelbulb-math.ts).
//
// Design:
//   - A frame with a non-positive / non-finite duration contributes ZERO to the
//     loop length and is never shown (browsers collapse 0-delay GIF frames the
//     same way). If EVERY duration is non-positive the clip is treated as a
//     single static frame (index 0) — never a divide-by-zero.
//   - Time loops modulo the total duration, so playback repeats indefinitely.

/** One decoded GIF frame: an uploadable bitmap + how long it displays (ms).
 *  Defined here (the dependency-free leaf) so both the browser decode helper
 *  (picturebox-encode.ts) and the node-testable module (picturebox.ts) can share
 *  the type without either importing the other's runtime. */
export interface DecodedGifFrame {
  bitmap: ImageBitmap;
  durationMs: number;
}

/** Sum of the positive, finite per-frame durations (the loop length, ms). */
export function totalDurationMs(durationsMs: readonly number[]): number {
  let total = 0;
  for (const d of durationsMs) {
    if (Number.isFinite(d) && d > 0) total += d;
  }
  return total;
}

/**
 * Which frame index is displayed at elapsed time `tMs`, looping. Pure:
 * identical inputs → identical output.
 *
 *   - 0 or 1 frames                → always 0.
 *   - total loop length <= 0       → 0 (all frames instantaneous → static).
 *   - tMs < 0 / non-finite         → clamped to 0.
 *   - otherwise                    → the frame whose cumulative window contains
 *                                    (tMs mod total).
 */
export function frameIndexAtTime(durationsMs: readonly number[], tMs: number): number {
  const n = durationsMs.length;
  if (n <= 1) return 0;
  const total = totalDurationMs(durationsMs);
  if (total <= 0) return 0;
  let t = Number.isFinite(tMs) ? tMs : 0;
  if (t < 0) t = 0;
  t = t % total; // loop
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const raw = durationsMs[i]!;
    const d = Number.isFinite(raw) && raw > 0 ? raw : 0;
    cum += d;
    if (t < cum) return i;
  }
  // Floating-point safety: t ≈ total lands here — show the last frame.
  return n - 1;
}
