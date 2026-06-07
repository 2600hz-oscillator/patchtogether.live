// Shared helper for video preview cards: read the LIVE engine source aspect.
//
// Every video preview card blits `videoEngine.canvas` into its 2D preview with
// a letterbox fit. The source aspect used to be hard-coded 4:3 (ENGINE_W=640 /
// ENGINE_H=480) in each card. With the HD toggle the engine can render at
// 1920×1080 / 1440×1080 / etc., so the letterbox must follow the engine's LIVE
// canvas dimensions. This helper reads those, falling back to the SD 4:3 ratio
// when the engine canvas reports a 0 dimension (e.g. mid-rebuild on an HD
// toggle) so the preview never divides by zero or collapses.

const SD_ASPECT = 640 / 480;

/**
 * The current source aspect (width / height) of a video engine's drawing
 * surface. `engine` is the VideoEngine (kept untyped here so this helper has no
 * import cycle with the engine module). Falls back to 4:3 when unavailable.
 */
export function liveEngineAspect(engine: { canvas?: { width?: number; height?: number } } | null | undefined): number {
  const w = engine?.canvas?.width ?? 0;
  const h = engine?.canvas?.height ?? 0;
  if (w > 0 && h > 0) return w / h;
  return SD_ASPECT;
}
