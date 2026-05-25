// packages/web/src/lib/video/video-audio-keepalive.ts
//
// Shared silent audio keep-alive for <video>-source modules (VIDEOBOX,
// VIDEOVARISPEED, CAMERA). ONE correct implementation rather than three
// copies — see the per-module wireAudio() callers.
//
// WHY THIS EXISTS — the multi-video throttle bug:
//
// Each video-source module owns an <video> element decoded into a GL texture
// (rVFC-driven). Chromium throttles a <video>'s decode to ~1 fps unless the
// element is BOTH visibly rendered AND its audio is being pulled by the
// AudioContext in real time. The card previews are tiny / offscreen and the
// engine samples the element into a texture (which does NOT count as "pulling"
// for the throttle heuristic), so the only reliable way to keep an unpatched
// source decoding at full rate is to route its audio through the AudioContext
// to the context destination — even when the user hasn't patched audio out.
//
// PR #301 fixed this for VIDEOBOX only by adding a
//   createMediaElementSource(videoEl) -> gain(0) -> ctx.destination
// keep-alive. VIDEOVARISPEED + CAMERA created a MediaElementSource (or none at
// all) but NEVER connected anything to the destination, so their elements were
// never pulled -> Chromium throttled all-but-one decode -> "only one video
// plays at a time." This helper gives all three the same keep-alive.
//
// The gain is 0, so the keep-alive emits NO audible output. The user's own
// audio_l / audio_r patches run in parallel off the module's splitter and are
// unaffected (audible exactly as before). The keep-alive ALSO resumes a
// suspended context: a suspended AudioContext does not pull any source, so
// loading a video while the context is suspended (e.g. right after a reload,
// before the audio-gate's user-gesture resume) would otherwise leave EVERY
// source stalled. Loading a file is itself a user gesture, so the resume()
// should succeed; we swallow the rejection on engines without state/resume.

/** A wired keep-alive: a MediaElementAudioSourceNode bridged to the context
 *  destination through a gain(0) node so the element is pulled in real time.
 *  Holds onto both nodes so disconnect() can tear them down on unwire/dispose
 *  (no leaked graph nodes when a card is removed). */
export interface VideoAudioKeepAlive {
  /** The MediaElementAudioSourceNode created from the <video> element. The
   *  caller fans this into its own ChannelSplitter for audio_l / audio_r so
   *  the file's audio is patchable downstream. Construction freezes the
   *  element's audio into the Web Audio graph (it no longer plays through the
   *  element's native output) — that's intended. */
  readonly source: MediaElementAudioSourceNode;
  /** Disconnect + drop the keep-alive gain AND the MediaElementSource. After
   *  this the element's audio is no longer routed anywhere (the caller should
   *  also disconnect its own splitter). Idempotent. */
  disconnect(): void;
}

/**
 * Create the silent keep-alive for a video element's audio.
 *
 *   src = ctx.createMediaElementSource(videoEl)
 *   src -> gain(0) -> ctx.destination   (keep-alive; inaudible)
 *
 * Returns the `source` node so the caller can ALSO fan it into its own
 * splitter for the module's audio_l / audio_r outputs. Throws if
 * createMediaElementSource fails (e.g. the element already has a source
 * attached after a hot-reload) — the caller catches + falls back to silent
 * ConstantSourceNodes, same as before.
 *
 * Resumes a suspended context so the element is actually pulled (a suspended
 * context pulls nothing).
 */
export function createVideoAudioKeepAlive(
  ctx: AudioContext,
  videoEl: HTMLVideoElement,
): VideoAudioKeepAlive {
  const source = ctx.createMediaElementSource(videoEl);

  // Silent keep-alive: src -> gain(0) -> destination. This is what makes the
  // AudioContext pull the element in real time so its decode doesn't throttle
  // to ~1 fps when no audio is patched. Gain 0 = zero audible output.
  const keepAlive = ctx.createGain();
  keepAlive.gain.value = 0;
  source.connect(keepAlive);
  keepAlive.connect(ctx.destination);

  // A suspended context won't pull the element (decode stays throttled), so
  // resume it. Loading a file is a user gesture, so this should succeed; guard
  // the suspended case + swallow the rejection (older engines may not expose
  // state/resume).
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      /* best-effort; the audio-gate's user-gesture resume is the backstop */
    });
  }

  let disconnected = false;
  return {
    source,
    disconnect(): void {
      if (disconnected) return;
      disconnected = true;
      try { keepAlive.disconnect(); } catch { /* */ }
      try { source.disconnect(); } catch { /* */ }
    },
  };
}
