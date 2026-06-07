// Shared helper for video preview cards: read the LIVE engine source aspect.
//
// Every video preview card blits `videoEngine.canvas` into its 2D preview with
// a letterbox fit. The source aspect used to be hard-coded 4:3 in each card via
// the compile-time VIDEO_RES constant. With the OUTPUT aspect switch the engine
// renders at 1024×768 (4:3) or 1366×768 (16:9), so the helper reads the
// engine's LIVE canvas dimensions and the in-rack thumbnail letterboxes at the
// live aspect. Falls back to 4:3 when the engine canvas reports a 0 dimension
// (e.g. before the first frame) so the preview never divides by zero or
// collapses.

const DEFAULT_ASPECT = 4 / 3;

/**
 * The current source aspect (width / height) of a video engine's drawing
 * surface. `engine` is the VideoEngine (kept untyped here so this helper has no
 * import cycle with the engine module). Falls back to 4:3 when unavailable.
 */
export function liveEngineAspect(
  engine: { canvas?: { width?: number; height?: number } } | null | undefined,
): number {
  const w = engine?.canvas?.width ?? 0;
  const h = engine?.canvas?.height ?? 0;
  if (w > 0 && h > 0) return w / h;
  return DEFAULT_ASPECT;
}
