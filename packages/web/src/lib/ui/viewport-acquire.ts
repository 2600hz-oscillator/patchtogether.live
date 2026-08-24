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

/**
 * THE ONE DECLARATION of LOOPBACK's capture states.
 *
 * ⚠ IT LIVES HERE, WITH THE ACQUIRE CALL, AND EVERYTHING ELSE IMPORTS IT —
 * `LoopbackCard.svelte` annotates its state machine with it and
 * `$lib/ui/media/loopback-status-registry` aliases it for the value it
 * publishes to the faceplate. CAMERA arrived at the same rule the expensive
 * way: its union is declared twice (the card's local `State` and
 * `camera-device.ts`'s `CameraState`) under a header CLAIMING they are kept
 * byte-in-sync, and nothing checked that claim until a source-level gate was
 * written for it. A state added to the card and missing from the published
 * union is a string the faceplate's lamp cannot render, and every runtime
 * assertion stays green because the card never annotates its publish.
 *
 * One declaration removes the class rather than gating it. `loopback-status-
 * registry.test.ts` holds the line at the SOURCE level in both directions — the
 * registry must ALIAS this type, and the card must IMPORT it rather than
 * re-declaring a local union — because a type alias is invisible at runtime.
 *
 * The members are the card's own machine:
 *   idle        nothing captured yet, or an explicit stop / a cancelled picker
 *   requesting  the picker is up, awaiting the user
 *   capturing   frames are arriving and feeding OUT
 *   ended       the user stopped the share from the browser's own share bar
 *   unsupported this runtime has no Screen Capture API at all
 *   error       getDisplayMedia failed for a reason that is not a refusal
 */
export type LoopbackCaptureState =
  | 'idle'
  | 'requesting'
  | 'capturing'
  | 'ended'
  | 'unsupported'
  | 'error';

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
