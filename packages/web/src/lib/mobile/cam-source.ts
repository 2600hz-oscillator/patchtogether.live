// packages/web/src/lib/mobile/cam-source.ts
//
// Glitch-cam camera controller — owns the page's hidden `<video>` element
// lifecycle: acquire (via the SHARED acquireCameraStream seam, extended with
// facingMode), attach to the engine's cameraInput node, FLIP (front/back
// re-acquire), device switching, and the two mobile re-acquire triggers:
//   - track `ended`      — iOS kills camera tracks on backgrounding,
//   - `visibilitychange` — coming back to a foregrounded tab with a dead
//                          track re-acquires (CameraInputCard precedent).
//
// Framework-free (callback-driven) so the state machine is unit-testable;
// the page holds $state and mirrors `onChange` events into it.

import {
  acquireCameraStream,
  type CameraFacingMode,
  type GetUserMediaFn,
} from '$lib/ui/camera-acquire';

export type CamState = 'idle' | 'starting' | 'live' | 'denied' | 'error';

export interface CamSourceEvents {
  /** Fired on every state transition (incl. facing changes). */
  onChange: (state: CamState, detail: { facing: CameraFacingMode; error: string | null }) => void;
  /** Fired whenever a NEW live stream is playing in the video element —
   *  the page re-attaches the element to the engine node here. */
  onStream: (videoEl: HTMLVideoElement) => void;
}

/** Map a getUserMedia failure to the user-facing state + copy — mirrors
 *  CameraInputCard's error mapping. */
export function mapCameraError(e: DOMException | null): { state: CamState; message: string } {
  const name = e?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      state: 'denied',
      message: 'Camera access was denied. Allow camera access in your browser settings, then retry.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { state: 'error', message: 'No camera found on this device.' };
  }
  if (name === 'NotReadableError') {
    return {
      state: 'error',
      message: 'The camera is busy or failed to start. Close other camera apps and retry.',
    };
  }
  return { state: 'error', message: e?.message || 'Camera failed to start.' };
}

export interface CamSource {
  readonly state: CamState;
  readonly facing: CameraFacingMode;
  readonly errorMessage: string | null;
  /** Acquire with the current facing (first call = the permission prompt). */
  start(): Promise<void>;
  /** Toggle front/back and re-acquire. */
  flip(): Promise<void>;
  /** Switch to a specific device (the ⚙ capture-card sheet). */
  setDevice(deviceId: string | null): Promise<void>;
  /** Stop tracks + detach listeners. */
  dispose(): void;
}

export function createCamSource(
  videoEl: HTMLVideoElement,
  events: CamSourceEvents,
  gum: GetUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c),
): CamSource {
  let state: CamState = 'idle';
  let facing: CameraFacingMode = 'environment'; // spec default: back camera
  let deviceId: string | null = null;
  let errorMessage: string | null = null;
  let stream: MediaStream | null = null;
  let disposed = false;
  let acquiring = false;

  function setState(next: CamState) {
    state = next;
    events.onChange(state, { facing, error: errorMessage });
  }

  function stopTracks() {
    if (stream) {
      for (const t of stream.getTracks()) {
        t.onended = null;
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      }
      stream = null;
    }
  }

  async function acquire(): Promise<void> {
    if (disposed || acquiring) return;
    acquiring = true;
    errorMessage = null;
    setState('starting');
    try {
      stopTracks();
      const r = await acquireCameraStream(gum, deviceId, undefined, facing);
      if (disposed) {
        r.stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!r.stream) {
        const mapped = mapCameraError(r.error);
        errorMessage = mapped.message;
        setState(mapped.state);
        return;
      }
      stream = r.stream;
      // iOS: playsinline + muted are required for an off-DOM autoplaying
      // camera element (set here, not markup, so the controller is complete).
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.srcObject = stream;
      try {
        await videoEl.play();
      } catch {
        // play() can reject on a race with a re-acquire; the rVFC upload
        // keep-alive in the camera module re-pulls it.
      }
      // Track death (iOS backgrounding) → we notice; visibilitychange below
      // decides when to actually re-acquire (must be foregrounded).
      for (const t of stream.getTracks()) {
        t.onended = () => {
          if (!disposed && document.visibilityState === 'visible') void acquire();
        };
      }
      setState('live');
      events.onStream(videoEl);
    } finally {
      acquiring = false;
    }
  }

  function onVisibility() {
    if (disposed) return;
    if (document.visibilityState !== 'visible') return;
    // Foregrounded with a dead/absent track after a successful session →
    // re-acquire. (Never auto-acquire before the user's first gesture.)
    const track = stream?.getVideoTracks()[0];
    if (state === 'live' && (!track || track.readyState === 'ended')) {
      void acquire();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  return {
    get state() {
      return state;
    },
    get facing() {
      return facing;
    },
    get errorMessage() {
      return errorMessage;
    },
    async start() {
      await acquire();
    },
    async flip() {
      facing = facing === 'environment' ? 'user' : 'environment';
      deviceId = null; // facing owns selection again
      await acquire();
    },
    async setDevice(id: string | null) {
      deviceId = id;
      await acquire();
    },
    dispose() {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stopTracks();
      videoEl.srcObject = null;
    },
  };
}
