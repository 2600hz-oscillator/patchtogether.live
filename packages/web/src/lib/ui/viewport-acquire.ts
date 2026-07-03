// packages/web/src/lib/ui/viewport-acquire.ts
//
// Screen-capture acquisition seam for the LOOPBACK module — the thin wrapper
// LoopbackCard uses instead of calling getDisplayMedia directly (mirrors
// camera-acquire.ts for CAMERA). Keeping it here makes the card's capture path
// feature-detectable + unit-testable (a mock getDisplayMedia) without a real
// display prompt.
//
// Mechanism: LOOPBACK captures the CURRENT TAB with the Screen Capture API,
// steering the picker toward "this tab" and permitting self-capture so the app
// can record its own viewport:
//   * displaySurface: 'browser'      — prefer a browser-tab surface (vs window/monitor)
//   * preferCurrentTab: true         — (Chromium) pre-select THIS tab in the picker
//   * selfBrowserSurface: 'include'  — allow the current tab to be a valid choice
//                                      (Chromium defaults to EXCLUDE it otherwise)
//   * surfaceSwitching/systemAudio: 'exclude' — no live surface swap, no system audio
//
// getDisplayMedia REQUIRES a user gesture, so the card only calls this from the
// "Start capture" button click. The picker can be cancelled (rejects
// NotAllowedError) and the returned track can END later (the user clicks the
// browser's "Stop sharing") — the card handles both by returning to idle.

export interface ViewportAcquireResult {
  stream: MediaStream | null;
  /** The error from getDisplayMedia (null on success). NotAllowedError = the
   *  user cancelled the picker or denied permission. */
  error: DOMException | null;
}

export type GetDisplayMediaFn = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

/** Is the Screen Capture API available in this runtime? Feature-detected so the
 *  card can render a graceful "capture not supported" state (Safari < 13,
 *  insecure context, some embedded webviews) rather than throwing on click. */
export function isViewportCaptureSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof (navigator.mediaDevices as unknown as {
      getDisplayMedia?: unknown;
    }).getDisplayMedia === 'function'
  );
}

/** Current-tab capture constraints. The non-standard Chromium hints
 *  (displaySurface / preferCurrentTab / selfBrowserSurface / surfaceSwitching /
 *  systemAudio) aren't all in the shared DOM lib type, so the literal is cast
 *  through `unknown` — browsers that don't support a hint ignore it, degrading
 *  to a generic display-surface picker. */
export const VIEWPORT_CAPTURE_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    displaySurface: 'browser',
    frameRate: { ideal: 30 },
  },
  audio: false,
  preferCurrentTab: true,   // Chromium: pre-select THIS tab in the picker
  selfBrowserSurface: 'include', // Chromium: allow capturing THIS tab
  surfaceSwitching: 'exclude',   // no live surface-switching UI
  systemAudio: 'exclude',        // never pull system audio
} as unknown as MediaStreamConstraints;

/**
 * Acquire a current-tab capture stream. Resolves with `{ stream }` on success
 * or `{ stream: null, error }` when the picker is cancelled / denied / errors.
 * NEVER throws — the card branches on `result.stream`. The `gdm` seam is
 * injected so tests can drive success + rejection without a real prompt.
 */
export async function acquireViewportStream(
  gdm: GetDisplayMediaFn,
): Promise<ViewportAcquireResult> {
  try {
    const stream = await gdm(VIEWPORT_CAPTURE_CONSTRAINTS);
    return { stream, error: null };
  } catch (err) {
    return { stream: null, error: err as DOMException };
  }
}
