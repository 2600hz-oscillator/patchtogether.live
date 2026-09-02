// packages/web/src/lib/audio/clip-media.ts
//
// The CLIP MEDIA interfaces — one take, from arm to commit, expressed so that
// the audio implementation and the (later) video one are the SAME lifecycle.
//
// ⚠ MEDIA IS KIND-AGNOSTIC ON PURPOSE. Everything here is stated in TRANSPORT
// FRAMES at the capture context's sample rate — never seconds, never video
// frames. That is the single property that lets a video take end on the same
// musical boundary as its audio sibling: the video implementation converts the
// window to its own CFR grid, and the audio clock stays authoritative. Express
// the window in seconds and A/V sync becomes a rounding argument between two
// clocks; express it in frames and it is one number both sides agree on.
//
// ⚠ THE BYTES NEVER LIVE HERE, AND NEVER IN THE Y.DOC. A clip carries a
// `mediaId` and a dozen integers (~120 bytes); the samples live in OPFS and
// travel in the `.ptperf.zip`. samsloop's own ledger is the measurement that
// rules out the alternative: 3 MB per take / 12 MB per rack IN BASE64, against
// a relay that warns at 16 MB — and one 4-bar studio take is already 3 MB.
//
// ⚠ NOTHING IMPORTED FROM `clip-types`. This module is the leaf: `clip-types`
// imports the format union FROM here, so a media concern can never acquire a
// dependency on the launcher's note model.
//
// SLICE 1 SHIPS THE TYPES ONLY. `clip-media-store.ts` (slice 2) implements the
// store; the recorder that produces a `RecordingSession` lands in slices 4-5.

/** What a piece of clip media IS. The audio arm ships; `'video'` is the tie-in
 *  seam — declared now so the store, the manifest and the perf-zip round-trip
 *  are written once rather than twice. */
export type ClipMediaKind = 'audio' | 'video';

/** The stored sample format of an AUDIO take.
 *
 *  - `pcm-f32`  — the capture context's own f32 samples, verbatim. A memcpy,
 *    and the ONLY tier that cannot clip a hot pre-board tap (mixmstrs records a
 *    fully-correlated worst case of 6.7187× at its shipped defaults).
 *  - `pcm-i16`  — half the bytes, one multiply + round per sample, clips at ±1.
 *  - `opus`     — a Worker encoder per lane; carries a declared pre-skip the
 *    playback path has to trim, which is why it is not the default.
 *
 *  NOT a container string: these are the three tiers, and a fourth would be a
 *  product decision, not a spelling. */
export type ClipAudioFormat = 'pcm-f32' | 'pcm-i16' | 'opus';

/** The audio formats, in ladder order (largest/most faithful first). The
 *  membership test for `coerceClipRecord`'s audio branch. */
export const CLIP_AUDIO_FORMATS = ['pcm-f32', 'pcm-i16', 'opus'] as const;

/** True iff `v` is one of the three declared audio formats. A coerce boundary
 *  predicate: an unknown format is a clip that cannot be scheduled, so the
 *  record is dropped rather than half-loaded. PURE. */
export function isClipAudioFormat(v: unknown): v is ClipAudioFormat {
  return typeof v === 'string' && (CLIP_AUDIO_FORMATS as readonly string[]).includes(v);
}

/** One durable piece of media in the clip media store.
 *
 *  ⚠ `frames` IS THE MUSICAL LENGTH AND BOTH KINDS CARRY IT. An audio take and
 *  its video take are the same length by construction because they are handed
 *  the same window, not because two recorders agreed afterwards. */
export interface ClipMedia {
  /** Content key in the clip media store — the name of the OPFS file and the
   *  only reference the Y.Doc ever holds. */
  mediaId: string;
  kind: ClipMediaKind;
  /** Container/codec, e.g. `'pcm-f32'` | `'pcm-i16'` | `'opus'` |
   *  `'video/mp4;codecs=avc1'`. A free string BECAUSE it spans both kinds; the
   *  audio side narrows it to `ClipAudioFormat` at its own boundary. */
  format: string;
  /** On-disk size. */
  bytes: number;
  /** THE MUSICAL LENGTH, in TRANSPORT frames at `audio.sampleRate` (the
   *  capture context's rate). Never seconds; never video frames. */
  frames: number;
  /** Kind-specific truth. Exactly one of these is set for a given `kind`. */
  audio?: { sampleRate: number; channels: 1 | 2; peak?: number };
  video?: { width: number; height: number; fps: number };
  /** `Date.now()` at commit — the CHANGE SIGNATURE. Two takes of the same
   *  length at the same settings are otherwise identical in metadata, and a
   *  player keyed on the rest would keep playing the first (samsloop #1353). */
  takeAt: number;
}

/** The window a take occupies on the transport, in FRAMES. Resolved ONCE on the
 *  main thread from `ctx.currentTime × ctx.sampleRate` at the moment the phase
 *  changes — never accumulated from a tick count, and never re-derived per
 *  quantum (the blood rate-exactness rule). */
export interface RecordingWindow {
  /** The frame the take starts on. */
  startFrame: number;
  /** The frame the take ends on, or null while an ENDLESS take is open. */
  stopFrame: number | null;
  /** The unit loop in frames — what an endless take takes a WHOLE MULTIPLE of.
   *  `stopFrame` is always `startFrame + n × unitFrames`, computed from the
   *  anchor rather than by repeated addition, so the ≤½-sample rounding error
   *  of one loop never accumulates over a long take. */
  unitFrames: number;
}

/** A take, from arm to commit. ONE lifecycle, two implementations.
 *
 *  ⚠ THERE IS NO SURFACE HANDLE IN THIS TYPE, and that is load-bearing. The
 *  video take needs a RENDER LEASE, which is the one field the audio side does
 *  not have; putting a canvas in this interface is exactly how #1574 was
 *  re-opened once already. The lease belongs to the video registry, not to the
 *  session contract both kinds share.
 *
 *  ⚠ AND THERE IS NO `dispose()` / `release()` / `detach()`. The only ways a
 *  take ends are `stopAt`, the frame boundary, and the registry's graph-lifetime
 *  `sweep()`. Its ABSENCE is the guard — a card cannot tear a take down in an
 *  `onDestroy` because there is no method to call and `tsc` refuses the attempt
 *  before any test runs (`node-recorder-registry.svelte.ts`). */
export interface RecordingSession {
  readonly mediaId: string;
  readonly kind: ClipMediaKind;
  /** Resolve the window. Frames are TRANSPORT frames at the capture context's
   *  sample rate — the video implementation converts to its own CFR grid. */
  arm(window: RecordingWindow): void;
  /** ENDLESS stop. Implementations round UP to a whole `unitFrames`; a request
   *  that would land mid-loop is not honoured early, because a partial loop is
   *  the one outcome this mode exists to prevent. */
  stopAt(stopFrame: number): void;
  /** Discard the take and free its scratch. The escape from a stopping take. */
  cancel(): void;
  /** Resolves when the media is DURABLE in the store — not when the last chunk
   *  was posted. */
  committed(): Promise<ClipMedia>;
}
