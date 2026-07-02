// packages/web/src/lib/ui/camera-acquire.ts
//
// Camera acquisition with a BARE-CONSTRAINTS retry — the seam CameraInputCard
// uses instead of calling getUserMedia directly.
//
// WHY: professional capture devices exposed through exclusive-access drivers
// (Blackmagic WDM/DirectShow is the canonical case) frequently REJECT a
// getUserMedia that carries width/height/frameRate hints, because the driver
// only offers the broadcast formats of the live input signal (1080p59.94,
// 720p60, …) and won't negotiate toward a webcam-ish 640×360@30 request.
// Chrome surfaces that driver start-failure as `NotReadableError` — the SAME
// error name as "another app holds the device" — so a card that maps it
// straight to "in use" both misdiagnoses and gives up too early. The fix:
// on NotReadableError with a specific device selected, wait briefly (WDM
// drivers release handles asynchronously after a previous track.stop()) and
// retry ONCE with deviceId-only constraints, letting the driver pick its own
// native format. A second NotReadableError is then reported honestly as
// "busy OR failed to start (signal/format)".

export interface AcquireResult {
  stream: MediaStream | null;
  /** The error from the FINAL attempt (null on success). */
  error: DOMException | null;
  /** True when the stream came from the bare-constraints retry path. */
  usedBareRetry: boolean;
}

export type GetUserMediaFn = (c: MediaStreamConstraints) => Promise<MediaStream>;

/** Delay between the rich attempt and the bare retry — long enough for a WDM
 *  driver to finish releasing a just-stopped handle, short enough to feel
 *  instant in the card. */
export const BARE_RETRY_DELAY_MS = 300;

/**
 * Acquire a camera stream: rich (webcam-friendly) constraints first, then —
 * only for a specific selected device that failed with NotReadableError —
 * one bare `{ deviceId: { exact } }` retry at the device's native format.
 */
export async function acquireCameraStream(
  gum: GetUserMediaFn,
  targetDeviceId: string | null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<AcquireResult> {
  const rich: MediaStreamConstraints = {
    video: targetDeviceId
      ? {
          deviceId: { exact: targetDeviceId },
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 30 },
        }
      : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
    audio: false,
  };

  try {
    return { stream: await gum(rich), error: null, usedBareRetry: false };
  } catch (err) {
    const e = err as DOMException;
    // Only NotReadableError on a SPECIFIC device warrants the bare retry:
    // permission and not-found failures won't be cured by dropping format
    // hints, and without a target id there is no exclusive device to blame.
    if (e?.name !== 'NotReadableError' || !targetDeviceId) {
      return { stream: null, error: e, usedBareRetry: false };
    }
    await sleep(BARE_RETRY_DELAY_MS);
    try {
      const stream = await gum({
        video: { deviceId: { exact: targetDeviceId } },
        audio: false,
      });
      return { stream, error: null, usedBareRetry: true };
    } catch (err2) {
      return { stream: null, error: err2 as DOMException, usedBareRetry: true };
    }
  }
}
