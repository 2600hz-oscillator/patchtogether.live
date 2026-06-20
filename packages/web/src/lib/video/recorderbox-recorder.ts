// packages/web/src/lib/video/recorderbox-recorder.ts
//
// RECORDERBOX recording engine. Encodes a live <canvas> + a MediaStream audio
// track into a HIGH-QUALITY H.264 MP4, streamed to OPFS scratch so the file
// is crash-recoverable, then Save-As'd to disk on stop.
//
// Pipeline (PRIMARY — WebCodecs via Mediabunny):
//   CanvasSource(hiddenCanvas, {codec:'avc', bitrate})   ← per-rAF .add()
//   MediaStreamAudioTrackSource(track, {codec:'aac', bitrate})
//        │
//        ▼
//   Output({ format: Mp4OutputFormat({ fastStart:'fragmented' }),
//            target: StreamTarget(writable) })
//        │  fragments
//        ▼
//   WritableStream → recorderbox-opfs-worker → FileSystemSyncAccessHandle
//        │                                       (real disk, survives crash)
//   On stop: output.finalize() → close handle → STREAM OPFS scratch (chunked)
//            into the destination handle the user chose AT START (Chromium), or
//            read+download the bytes where no handle exists (Firefox/Safari).
//
// fastStart:'fragmented' is the CRASH-RECOVERY guarantee: a fragmented MP4 is
// playable from whatever fragments made it to disk even if finalize() never
// runs. A non-fragmented MP4 needs its moov box (written at finalize) to be
// playable at all — useless after a crash. The OPFS write is synchronous on
// disk per fragment, so a fragment that returned from the Worker's write() is
// durable.
//
// GRACEFUL DEGRADE (REQUIRED — CI runners + some OSes lack an H.264 encoder):
//   probeEncoders() runs Mediabunny's canEncodeVideo('avc') /
//   canEncodeAudio('aac'). The card calls it on mount and:
//     * full support      → record via the WebCodecs path above.
//     * no H.264 at all   → Record button is DISABLED with a clear badge
//                           ("no H.264 encoder available"); never crash.
//   (A MediaRecorder fallback is intentionally out of scope for v1: every
//   browser that ships WebCodecs canEncodeVideo also ships the encoder; the
//   only real "no encoder" case is a headless CI runner, where we degrade to
//   the disabled badge. See the module doc for the rationale.)
//
// This file is import-safe under node/jsdom (the unit tests import it): the
// Mediabunny pipeline is only constructed inside start(), behind a runtime
// feature check, and the probe is injectable so tests don't need real codecs.

import {
  opfsScratchPath,
  putManifest,
  markManifestDone,
  deleteManifest,
  hasOpfs,
  type RecorderboxManifest,
  type ChunkSink,
} from './recorderbox-store';
import {
  AudioCaptureDrain,
  type CaptureChunk,
  type CaptureSampleInit,
} from './recorderbox-capture-drain';
import { CfrClock, planCfrEmit, DEFICIT_SLACK_FRAMES } from './recorderbox-cfr';
import { AudioRingBuffer } from './recorderbox-audio-ring';
import { chunkFileName } from './recorderbox-chunk-name';

// Mediabunny is a real dependency (MPL-2.0). We import its high-level
// canvas/audio sources + the fragmented-MP4 output. Type-only where possible
// so node unit tests that never call start() don't pull the runtime in
// eagerly — but the value imports are tree-shakeable and side-effect-free.
import {
  Output,
  Mp4OutputFormat,
  StreamTarget,
  CanvasSource,
  MediaStreamAudioTrackSource,
  // Sample-accurate (lossless) audio path: a backpressured source we feed
  // worklet-captured planar f32 chunks through AudioSample.add() (awaited per
  // chunk = no dropped samples → no silence-pad → no click). The fallback
  // MediaStreamAudioTrackSource (above) hard-drops under encoder backpressure.
  AudioSampleSource,
  AudioSample,
  canEncodeVideo,
  canEncodeAudio,
  // Remux-to-flat-MP4 pieces (delivery step in stop()): read the fragmented OPFS
  // scratch + re-mux it (codec COPY, no re-encode) into a standard moov-based
  // MP4 that NLEs like DaVinci Resolve will import. All side-effect-free value
  // imports, only constructed inside defaultRemuxToFlatMp4 (behind a runtime).
  Input,
  BlobSource,
  Mp4InputFormat,
  BufferTarget,
  Conversion,
  type VideoCodec,
} from 'mediabunny';

// ── Defaults ──
// These describe the HIGH tier (the historical default). The card now picks a
// per-tier EncodeProfile (recorderbox-quality.ts) and passes its video codec +
// bitrate + keyframe interval + audio bitrate into start(); when no profile is
// supplied (older callers / a probe-only mount) these defaults stand in, so the
// default behavior is byte-for-byte the original ~14 Mbps H.264 MP4.
/** ~14 Mbps VBR video — "high quality" per the spec (HIGH tier). */
export const DEFAULT_VIDEO_BITRATE = 14_000_000;
/** 192 kbps AAC stereo (HIGH tier). */
export const DEFAULT_AUDIO_BITRATE = 192_000;
/** 30 fps capture. */
export const DEFAULT_FPS = 30;
/** Default keyframe interval, seconds (Mediabunny's own default — HIGH tier). */
export const DEFAULT_KEYFRAME_INTERVAL = 2;
/** GoPro-style chunking: roll to a NEW file every ~10 min. Seconds of recorded
 *  wall time per chunk. (Test-injectable via `RecorderboxRecorderOptions`.) */
export const MAX_CHUNK_SECONDS = 600;
/** Seconds of AUDIO that overlap between consecutive chunks: the last N s of
 *  chunk N is duplicated as the first N s of chunk N+1. */
export const OVERLAP_SECONDS = 5;
export const VIDEO_CODEC: VideoCodec = 'avc'; // H.264 — the guaranteed baseline
export const AUDIO_CODEC = 'aac' as const; // AAC-LC (mp4a.40.2)
export const CONTAINER_MIME = 'video/mp4';

export interface EncoderSupport {
  /** WebCodecs H.264 video encode is available at the recording resolution. */
  video: boolean;
  /** WebCodecs AAC audio encode is available. */
  audio: boolean;
  /** OPFS scratch (crash-recovery substrate) is available. */
  opfs: boolean;
  /** True when a full-quality recording is possible (video encoder present —
   *  audio is optional: a silent recording is still useful). */
  canRecord: boolean;
}

/** Injectable probe fns so unit tests can drive the support matrix without a
 *  real codec. Defaults to Mediabunny's real probes. */
export interface ProbeDeps {
  canEncodeVideo?: (codec: typeof VIDEO_CODEC, opts: { width: number; height: number; bitrate: number }) => Promise<boolean>;
  canEncodeAudio?: (codec: typeof AUDIO_CODEC, opts: { numberOfChannels: number; sampleRate: number; bitrate: number }) => Promise<boolean>;
  hasOpfs?: () => boolean;
}

/**
 * The DEFAULT real H.264 video probe. `canEncodeVideo` (→
 * VideoEncoder.isConfigSupported) is NOT trustworthy on its own: headless
 * software runners (CI) report avc as config-supported yet their encoder emits
 * ZERO chunks for real frames — so a recording there writes only an `ftyp` and
 * never a `moof` fragment (an unplayable take). We therefore AND the config
 * check with a tiny end-to-end encode-and-flush smoke test (encode a few real
 * canvas frames, require ≥1 output chunk). Only a runtime that genuinely
 * produces encoded bitstream passes → the card enables Record only where a take
 * will actually be playable; everywhere else it shows the "no encoder" badge.
 *
 * Falls back to the config check alone if the WebCodecs primitives (or a 2D
 * canvas) aren't available, so non-CI environments aren't gated by a probe that
 * can't run.
 */
async function defaultCanEncodeVideo(
  codec: typeof VIDEO_CODEC,
  opts: { width: number; height: number; bitrate: number },
): Promise<boolean> {
  // 1) Config support (Mediabunny → VideoEncoder.isConfigSupported).
  let configOk = false;
  try {
    configOk = await canEncodeVideo(codec, opts);
  } catch {
    configOk = false;
  }
  if (!configOk) return false;

  // 2) Real encode-and-flush smoke test (the false-positive guard).
  interface MiniVideoEncoder {
    configure: (c: unknown) => void;
    encode: (frame: unknown, o?: unknown) => void;
    flush: () => Promise<void>;
    close: () => void;
  }
  const g = globalThis as unknown as {
    VideoEncoder?: new (init: { output: (c: unknown) => void; error: (e: unknown) => void }) => MiniVideoEncoder;
    VideoFrame?: new (src: CanvasImageSource, init: { timestamp: number; duration?: number }) => { close: () => void };
    document?: { createElement: (t: string) => HTMLCanvasElement };
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
  };
  const VE = g.VideoEncoder;
  const VF = g.VideoFrame;
  if (typeof VE !== 'function' || typeof VF !== 'function') {
    // No WebCodecs primitives to smoke-test with — trust the config check.
    return configOk;
  }

  // A small canvas; gradient content so the encoder does real work.
  const W = 64, H = 64;
  let cv: HTMLCanvasElement | OffscreenCanvas | null = null;
  let ctx: (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null = null;
  try {
    if (g.document?.createElement) {
      const el = g.document.createElement('canvas');
      el.width = W; el.height = H;
      cv = el;
      ctx = el.getContext('2d');
    } else if (typeof g.OffscreenCanvas === 'function') {
      const oc = new g.OffscreenCanvas(W, H);
      cv = oc;
      ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    }
  } catch {
    cv = null;
  }
  if (!cv || !ctx) return configOk; // can't smoke-test → trust config.

  // The raw WebCodecs VideoEncoder.configure needs a FULL codec string
  // (avc1.PPCCLL) — the short Mediabunny name ('avc') is not valid there. Try
  // High then Baseline; a runtime that emits chunks for either really encodes.
  const fullCodecs = ['avc1.640028', 'avc1.42E01E'];
  for (const fullCodec of fullCodecs) {
    let chunks = 0;
    let errored = false;
    let enc: MiniVideoEncoder | null = null;
    try {
      enc = new VE({ output: () => { chunks++; }, error: () => { errored = true; } });
      enc.configure({ codec: fullCodec, width: W, height: H, bitrate: 1_000_000, framerate: 30 });
      for (let i = 0; i < 4 && !errored; i++) {
        ctx.fillStyle = `rgb(${(i * 60) % 256},${(i * 30) % 256},${(i * 90) % 256})`;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.fillRect(i * 8, i * 8, 24, 24);
        const frame = new VF(cv as CanvasImageSource, { timestamp: i * 33_333, duration: 33_333 });
        enc.encode(frame, { keyFrame: i === 0 });
        frame.close();
      }
      await enc.flush();
    } catch {
      errored = true;
    } finally {
      try { enc?.close(); } catch { /* */ }
    }
    if (!errored && chunks > 0) return true;
  }
  return false;
}

/**
 * Probe the runtime's encoder support. Pure w.r.t. the injected deps — the
 * card calls it with no args (real Mediabunny probes); tests inject stubs.
 *
 * H.264 (avc) is OS-encoder-dependent, so we probe at the ACTUAL recording
 * resolution. The default video probe (defaultCanEncodeVideo) does NOT trust
 * VideoEncoder.isConfigSupported alone — that returns a false positive on
 * headless software runners (CI), which then write an `ftyp` but never a `moof`
 * fragment. It ANDs the config check with a tiny real encode-and-flush smoke
 * test, so canRecord is true only where a take will actually be playable. AAC
 * is near-universal but probed too. (Injected stubs bypass the smoke test.)
 */
export async function probeEncoders(
  width: number,
  height: number,
  sampleRate = 48_000,
  deps: ProbeDeps = {},
): Promise<EncoderSupport> {
  const cev = deps.canEncodeVideo ?? defaultCanEncodeVideo;
  const cea = deps.canEncodeAudio ?? canEncodeAudio;
  const opfsFn = deps.hasOpfs ?? hasOpfs;
  let video = false;
  let audio = false;
  try {
    video = await cev(VIDEO_CODEC, { width, height, bitrate: DEFAULT_VIDEO_BITRATE });
  } catch {
    video = false;
  }
  try {
    audio = await cea(AUDIO_CODEC, { numberOfChannels: 2, sampleRate, bitrate: DEFAULT_AUDIO_BITRATE });
  } catch {
    audio = false;
  }
  const opfs = !!opfsFn();
  return { video, audio, opfs, canRecord: video };
}

/** State a live recorder exposes to the card for its indicator + timer. */
export type RecorderState = 'idle' | 'recording' | 'finalizing' | 'error';

export interface RecorderboxRecorderOptions {
  nodeId: string;
  /** The hidden capture canvas the card draws the engine frame into each rAF. */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** The merged L+R MediaStream audio track (from the module's
   *  MediaStreamAudioDestinationNode). Null = record video only (silent).
   *  Used ONLY as the FALLBACK when `audioCapture` is absent (the legacy
   *  MediaStreamAudioTrackSource path, which hard-drops samples under encoder
   *  backpressure → the clicks/pops bug). */
  audioTrack: MediaStreamTrack | null;
  /**
   * The PREFERRED, sample-accurate audio source: the recorderbox-capture
   * worklet's MessagePort (planar f32 stereo chunks posted from the audio
   * thread) + its encodable sample rate. When present, start() ARMS the worklet,
   * drains every posted chunk through mediabunny's BACKPRESSURED
   * AudioSampleSource.add() (the awaited add = lossless — no dropped samples →
   * no silence-pad → no click), and IGNORES audioTrack. Absent → fall back to
   * the MediaStreamAudioTrackSource(audioTrack) path. Null is equivalent to
   * absent (the module publishes null when there's no AudioContext / the worklet
   * failed to load). */
  audioCapture?: { port: MessagePort; sampleRate: number } | null;
  /** User-chosen base filename (sanitized at save time + baked into the OPFS
   *  scratch path so a recovered/partial file carries the intended name). */
  filename: string;
  /**
   * LEGACY single-file destination chosen via showSaveFilePicker. When present
   * (and no `dirHandle`), stop() writes the finalized flat MP4 to this one handle.
   * Persisted to the manifest for crash-recovery. Mostly superseded by
   * `dirHandle` (the folder model that enables no-prompt + chunking); kept so a
   * caller can still target a single file, and the recovery flow keeps working.
   * Absent on Firefox/Safari (no picker) → saveBytes (<a download>) fallback.
   */
  destHandle?: FileSystemFileHandle | null;
  /**
   * The destination FOLDER the user picked ONCE at recording START via
   * showDirectoryPicker (Chromium) — the model the no-prompt save + GoPro
   * chunking unify around. When present, each finalized chunk is written INTO
   * this folder under its `FILENAME-CHUNK#-DATETIME.mp4` name (the recorder
   * resolves the per-chunk file handle itself), with NO per-save prompt.
   * Persisted to the manifest so crash-recovery writes the recovered chunk back
   * into the same folder. Takes precedence over `destHandle`. Absent on
   * Firefox/Safari (no directory picker) → saveBytes (<a download>) fallback,
   * still named per chunk.
   */
  dirHandle?: FileSystemDirectoryHandle | null;
  /** Override the ~10-min chunk-roll threshold (seconds). Defaults to
   *  MAX_CHUNK_SECONDS (600). The e2e shrinks it (e.g. 6 s) to exercise a roll on
   *  a dev Mac without a 10-minute recording. */
  maxChunkSeconds?: number;
  /** Called after each chunk is finalized + delivered (rolled OR final), with the
   *  1-based chunk index + its resolved file name. Lets the card surface "saved
   *  RECORDING-001-… (002 recording…)" + drives the download-fallback per chunk. */
  onChunkSaved?: (info: { index: number; name: string; bytes: number }) => void;
  /** Video codec to encode with (defaults to H.264 'avc'). The card resolves
   *  this per quality tier via pickEncodeProfile (HEVC for BALANCED/SMALL where
   *  the OS has a hardware encoder; H.264 always for HIGH + as the fallback). The
   *  MP4 container carries both avc/hevc, so the codec swap does NOT change the
   *  container, extension, or crash-recovery semantics. */
  videoCodec?: VideoCodec;
  /** Video bitrate override (defaults to 14 Mbps — the HIGH H.264 baseline). */
  videoBitrate?: number;
  /** Keyframe interval in seconds (defaults to ~2 s — the HIGH tier). Longer =
   *  smaller file, at a slightly coarser seek/recovery granularity. */
  keyFrameInterval?: number;
  /** AAC audio bitrate (defaults to 192 kbps — the HIGH tier). */
  audioBitrate?: number;
  /** Hardware-acceleration hint for the video encoder (defaults to
   *  'prefer-hardware'). A realtime recorder must use the HARDWARE encoder so a
   *  software video encode can't saturate the CPU and starve the audio thread
   *  into clicks/pops. Resolved by pickEncodeProfile. */
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** Recording-resolution width/height (the encoder's first-frame box). */
  width: number;
  height: number;
  /** Save the finalized bytes to disk — the FALLBACK path used only when no
   *  destHandle was provided (Firefox/Safari download, or a test capture).
   *  Injectable so the card supplies the <a download> flow and tests supply a
   *  capture sink. */
  saveBytes: (bytes: Uint8Array, filename: string, mime: string) => Promise<void>;
  /** OPFS-writer factory. Defaults to the real Worker-backed writer; tests
   *  inject an in-memory sink. */
  makeWriter?: (opfsPath: string) => OpfsWriter;
  /** Mediabunny Output factory for one chunk. Defaults to the real fragmented-MP4
   *  Output(StreamTarget→writer). Injectable so the chunk-roll unit tests drive
   *  buildChunkSession + rollChunk WITHOUT a real encoder. */
  makeOutput?: (writer: OpfsWriter) => MuxOutputLike;
  /** Build the video track source for one chunk. Defaults to the real
   *  CanvasSource. Injectable so the chunk-roll unit tests skip the real
   *  WebCodecs canvas encoder. */
  makeCanvasSource?: () => CanvasSourceLike;
  /** Factory for the backpressured audio source used by the sample-accurate
   *  capture path (only when `audioCapture` is present). Defaults to the real
   *  mediabunny AudioSampleSource + AudioSample; tests inject a fake so the
   *  lossless-drain behavior is verifiable without a real AAC encoder. */
  makeAudioSampleSource?: (encodingConfig: {
    codec: typeof AUDIO_CODEC;
    bitrate: number;
  }) => AudioSampleSourceLike;
  /** Remux the finalized FRAGMENTED OPFS scratch into a flat (moov-based) MP4 for
   *  delivery — the Resolve-import fix. Returns the flat bytes, or null if the
   *  remux can't run (then stop() falls back to delivering the raw fragmented
   *  bytes so a take is never lost). Defaults to the real Mediabunny remux; tests
   *  inject a stub (so node unit tests don't run a real Conversion). */
  remuxToFlatMp4?: (opfsPath: string) => Promise<Uint8Array | null>;
  onStateChange?: (state: RecorderState) => void;
  /** Called if the AUDIO track fails to add / encode (e.g. an unsupported AAC
   *  profile from a low-rate capture). The video recording still proceeds
   *  (silent); the card can surface a "audio not recorded" note. Observability
   *  for the historical silent-recording bug. */
  onAudioError?: (err: Error) => void;
}

/** The OPFS scratch writer the StreamTarget pipes fragments into. The real
 *  impl is Worker-backed (recorderbox-opfs-worker). Abstracted so tests can
 *  supply an in-memory implementation. */
export interface OpfsWriter {
  write(chunk: { data: Uint8Array; position: number }): Promise<void>;
  close(): Promise<void>;
}

/** The narrow mediabunny AudioSampleSource surface the recorder uses: a
 *  backpressured `add(sample)` (await it = honor encoder backpressure), plus the
 *  object the muxer needs for `output.addAudioTrack`. Abstracted so tests inject
 *  a fake (and so the recorder doesn't hard-depend on the concrete class). */
export interface AudioSampleSourceLike {
  /** Backpressured: resolves once the output can accept more. Await it. */
  add(sample: AudioSample): Promise<void>;
}

/** The narrow mediabunny Output surface the recorder drives per chunk. Abstracted
 *  so the chunk-roll unit tests inject a fake (no real encoder/muxer). */
export interface MuxOutputLike {
  addVideoTrack(source: unknown, opts?: { frameRate?: number }): void;
  addAudioTrack(source: unknown): void;
  start(): Promise<void>;
  finalize(): Promise<void>;
}

/** The narrow video-source surface frame() drives. */
export interface CanvasSourceLike {
  add(timestamp: number, duration?: number): Promise<void>;
}

/** The DEFAULT backpressured audio source: a real mediabunny AudioSampleSource.
 *  The drain wraps each planar-f32 chunk in an AudioSample before add(). */
function defaultMakeAudioSampleSource(encodingConfig: {
  codec: typeof AUDIO_CODEC;
  bitrate: number;
}): AudioSampleSourceLike {
  return new AudioSampleSource(encodingConfig) as unknown as AudioSampleSourceLike;
}

/** Yield a macrotask — the drain's idle() while the queue is momentarily empty,
 *  so the event loop can deliver the next worklet port message + the encoder can
 *  make progress (vs. a tight spin). */
function macrotask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * A single live recording session. Construct → start() → (per-rAF) frame()
 * → stop(). One per Record ON/OFF cycle; the card creates a fresh one each
 * time.
 */
export class RecorderboxRecorder {
  private opts: RecorderboxRecorderOptions;
  // ── Current CHUNK session ──
  // These describe the CHUNK currently being written. A long take ROLLS: on roll
  // the current session is finalized + delivered and a fresh one replaces these
  // (see rollChunk). For a take under the roll threshold there is exactly one
  // chunk (index 001). (The stop/recovery unit tests drive these fields directly,
  // so they stay first-class.)
  private output: Output | null = null;
  private canvasSource: CanvasSource | null = null;
  private state: RecorderState = 'idle';
  private startEpoch = 0;
  private t0 = 0;
  private opfsPath = '';
  private writer: OpfsWriter | null = null;
  private frameCount = 0;
  /** Set if the audio track failed to add/encode (e.g. an unsupported AAC
   *  profile). The video keeps recording; this records WHY audio was dropped. */
  private audioEncodeError: Error | null = null;
  /** Backpressure guard: skip a frame if the previous .add() hasn't resolved
   *  (Mediabunny's add() returns a promise we should await, but per-rAF we
   *  don't want to stall the loop — drop instead). */
  private addInFlight = false;

  // ── CONSTANT FRAME RATE (the OSX slow-mo fix) ──
  /** Drives evenly-spaced grid PTS (index/fps) instead of jittery wall-clock
   *  PTS — see recorderbox-cfr.ts. */
  private cfr = new CfrClock(DEFAULT_FPS);
  /** 1-based index of the chunk currently recording (001, 002, …). */
  private chunkIndex = 1;
  /** Consecutive rAF ticks the CFR grid has been BEHIND wall-clock (i.e. we
   *  emitted while still behind). Drives planCfrEmit's sustained-deficit ramp:
   *  once it crosses SUSTAINED_DEFICIT_TICKS the per-tick catch-up cap relaxes so
   *  video DURATION tracks real time under persistently slow rendering (the
   *  A/V-desync fix). Reset to 0 the moment we're on pace / ahead, and on a roll
   *  (the new chunk's grid restarts at 0). */
  private deficitStreak = 0;
  /** Wall-clock elapsed (s) at which the current chunk started — the roll timer
   *  measures (elapsed - chunkStartElapsed) against maxChunkSeconds. */
  private chunkStartElapsed = 0;
  /** Re-entrancy guard so a roll in flight isn't started twice from rAF. */
  private rolling = false;

  // ── Sample-accurate audio capture (the clicks/pops fix) ──
  /** The worklet port we ARM/DISARM + read planar f32 chunks off (when
   *  audioCapture was provided). Null = the MediaStreamAudioTrackSource fallback
   *  path is in use. */
  private capturePort: MessagePort | null = null;
  /** The lossless drain: queues worklet chunks, hands them to the backpressured
   *  add() in monotonic, contiguous-timestamp order. */
  private captureDrain: AudioCaptureDrain | null = null;
  /** The running drain loop (drain.drain(...)). Awaited in stop() so the final
   *  partial chunk lands before finalize(). */
  private captureDrainLoop: Promise<void> | null = null;
  /** The CURRENT chunk's backpressured audio source the drain feeds. Swapped on
   *  roll so the new chunk's samples go to the new muxer. Null = video-only. */
  private currentAudioSource: AudioSampleSourceLike | null = null;
  /** Frames written to the CURRENT chunk's audio track (incl. the prepended 5 s
   *  overlap). Drives the per-chunk audio timestamp so EACH file's audio starts
   *  at 0 + stays contiguous — independent of the global take clock. */
  private chunkAudioFrames = 0;
  /** Rolling buffer of the trailing OVERLAP_SECONDS of emitted audio — prepended
   *  to the next chunk on roll (the 5 s overlap). Built once the sample rate is
   *  known (setupCaptureSource). */
  private audioRing: AudioRingBuffer | null = null;
  /** Capture sample rate (for the ring + per-chunk audio clock). */
  private captureSampleRate = 0;
  /**
   * HOLD buffer for live samples the long-lived drain pops DURING a chunk roll —
   * i.e. between detaching the finishing chunk's audio source and installing +
   * priming chunk N+1's. The old code early-returned (dropped) here, leaving a
   * real audio gap (the finalize window, tens-to-hundreds ms) at every ~10-min
   * boundary. We instead STASH each popped sample in order and flush it into the
   * new chunk's source AFTER the overlap prepend, so ZERO samples are lost across
   * a roll. Non-null only while a roll is in flight (addAudioToCurrentChunk holds
   * whenever this is non-null; rollChunk allocates it before the swap, flushes it
   * after, then nulls it). */
  private heldDuringRoll: CaptureSampleInit[] | null = null;

  constructor(opts: RecorderboxRecorderOptions) {
    this.opts = opts;
  }

  /** The roll threshold (seconds) — option override else the ~10-min default. */
  private get maxChunkSeconds(): number {
    const v = this.opts.maxChunkSeconds;
    return v && v > 0 ? v : MAX_CHUNK_SECONDS;
  }

  getState(): RecorderState {
    return this.state;
  }

  /** Seconds elapsed since start (for the card's timer). 0 when idle. */
  elapsed(): number {
    if (this.state === 'idle' || this.t0 === 0) return 0;
    return (performance.now() - this.t0) / 1000;
  }

  private setState(s: RecorderState): void {
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  /**
   * Begin recording. Builds the Mediabunny output, wires the OPFS StreamTarget,
   * writes the recovery manifest, and starts the encoders. After this resolves,
   * call frame() once per rAF.
   *
   * Throws (and sets state 'error') if the encoder path can't be constructed —
   * the card should have gated on probeEncoders().canRecord first, so this is a
   * belt-and-suspenders guard.
   */
  async start(): Promise<void> {
    this.startEpoch = Date.now();
    this.t0 = performance.now();
    this.chunkIndex = 1;
    this.chunkStartElapsed = 0;

    // Build the first chunk session (output + writer + video track + audio
    // track). buildChunkSession sets this.output/writer/opfsPath/canvasSource and
    // (for the capture path) wires the drain + the per-chunk audio source.
    const captureSampleSource = await this.buildChunkSession(this.chunkIndex, new Date(this.startEpoch));

    try {
      await this.output!.start();
      this.setState('recording');
    } catch (err) {
      this.setState('error');
      // Roll back the manifest + writer so we don't leave a phantom recover
      // candidate for a recording that never started.
      try { await this.writer?.close(); } catch { /* */ }
      await deleteManifest(this.opfsPath);
      throw err;
    }

    // ── ARM the capture worklet + start the lossless drain (after start) ──
    // The output is now accepting samples, so it's safe to begin draining. The
    // drain feeds `this.currentAudioSource` (swapped on roll), so ONE long-lived
    // lossless drain spans every chunk.
    if (captureSampleSource) this.armCaptureDrain();
  }

  /**
   * Build one CHUNK session: the OPFS scratch path + writer, the recovery
   * manifest, a fresh fragmented-MP4 Output, the video track (CFR-declared), and
   * the audio track (sample-accurate capture, or the legacy MediaStream
   * fallback). Sets this.output/writer/opfsPath/canvasSource and (capture path)
   * this.currentAudioSource. Returns the capture audio source (for the FIRST
   * chunk's arm step) or null (video-only / fallback path / rolled chunk).
   *
   * Used by start() (chunk 001) AND rollChunk() (chunk N+1), so a rolled chunk is
   * byte-for-byte the same pipeline as a fresh recording.
   */
  private async buildChunkSession(
    chunkIndex: number,
    when: Date,
    freshAudio = true,
  ): Promise<AudioSampleSourceLike | null> {
    // Each chunk's scratch is a DISTINCT OPFS partial (so recovery can offer them
    // independently). The first chunk keeps the bare path (back-compat with the
    // single-chunk recovery flow); rolled chunks carry a -cNNN segment.
    this.opfsPath = opfsScratchPath(
      this.opts.nodeId,
      this.startEpoch,
      this.opts.filename,
      chunkIndex > 1 ? chunkIndex : undefined,
    );
    // The resolved chunk file name (FILENAME-CHUNK#-DATETIME.mp4) — the delivered
    // name + what recovery writes a recovered chunk as inside the folder.
    const chunkName = chunkFileName(this.opts.filename, chunkIndex, when);

    // OPFS scratch writer (Worker-backed by default).
    this.writer = (this.opts.makeWriter ?? defaultMakeWriter)(this.opfsPath);

    // Recovery manifest — written BEFORE the first byte so a crash 100ms in
    // still leaves a recover candidate pointing at the (possibly tiny) file. The
    // dirHandle (folder picked once at START) / destHandle (legacy single file)
    // ride along so recovery can restore to the original chosen location.
    const manifest: RecorderboxManifest = {
      nodeId: this.opts.nodeId,
      filename: this.opts.filename,
      startedAt: this.startEpoch,
      mime: CONTAINER_MIME,
      opfsPath: this.opfsPath,
      status: 'recording',
      chunkName,
      ...(this.opts.dirHandle ? { dirHandle: this.opts.dirHandle } : {}),
      ...(this.opts.destHandle ? { destHandle: this.opts.destHandle } : {}),
    };
    await putManifest(manifest);

    const output = (this.opts.makeOutput ?? defaultMakeOutput)(this.writer);
    this.output = output as unknown as Output;

    // Video track from the hidden capture canvas. frameRate: DEFAULT_FPS is now a
    // TRUTHFUL CFR declaration — frame() emits PTS exactly on the index/fps grid
    // (recorderbox-cfr.ts), so this is a no-op snap, not a lossy repair of jittery
    // wall-clock PTS (the OSX slow-mo cause).
    const canvasSource = this.opts.makeCanvasSource
      ? this.opts.makeCanvasSource()
      : this.makeRealCanvasSource();
    this.canvasSource = canvasSource as unknown as CanvasSource;
    output.addVideoTrack(canvasSource, { frameRate: DEFAULT_FPS });

    // ── Audio track — optional, two paths ──
    //   1. PREFERRED: the sample-accurate capture tap (audioCapture). A
    //      backpressured AudioSampleSource we feed worklet-captured planar f32
    //      chunks through (awaited add = lossless → no clicks/pops).
    //   2. FALLBACK: MediaStreamAudioTrackSource(audioTrack) — the legacy path,
    //      which hard-drops samples under encoder backpressure (the bug). Used
    //      only when no capture tap is available. NOTE: the MediaStream fallback
    //      can't be re-attached to a rolled chunk (a track can feed one output),
    //      so chunking's per-chunk audio uses the capture path; the fallback path
    //      records a single chunk (no roll) for audio continuity.
    //   A null/absent of both records video only (silent MP4).
    let captureSampleSource: AudioSampleSourceLike | null = null;
    if (this.opts.audioCapture) {
      if (freshAudio) {
        // FIRST chunk: wire the drain + ring + worklet port (one long-lived drain
        // spans every chunk).
        captureSampleSource = this.setupCaptureSource(output, this.opts.audioCapture);
      } else if (this.capturePort) {
        // ROLLED chunk: the drain/ring/port already exist — just build this
        // chunk's audio source (the caller installs it as currentAudioSource).
        try {
          captureSampleSource = this.makeChunkAudioSource(output);
        } catch (e) {
          this.audioEncodeError = e instanceof Error ? e : new Error(String(e));
          this.opts.onAudioError?.(this.audioEncodeError);
        }
      }
    } else if (this.opts.audioTrack) {
      try {
        const audioSource = new MediaStreamAudioTrackSource(
          this.opts.audioTrack as MediaStreamAudioTrack,
          { codec: AUDIO_CODEC, bitrate: this.opts.audioBitrate ?? DEFAULT_AUDIO_BITRATE },
        );
        // IMPORTANT: Mediabunny surfaces internal encode errors via
        // `errorPromise`, NOT the constructor — and warns (in console) if you
        // never access it. The historical "silent recording on a low-rate
        // (Bluetooth/HFP 16 kHz) machine" bug came from Mediabunny selecting an
        // HE-AAC profile (mp4a.40.29) the browser can't encode; the error fired
        // here, asynchronously, and was previously dropped. The capture stream
        // is now resampled to 48 kHz upstream (recorderbox.ts) so AAC-LC is
        // chosen + this never fires, but we OBSERVE the promise so any future
        // config mismatch is recorded (onAudioError) instead of going silent.
        try {
          const ep = (audioSource as unknown as { errorPromise?: Promise<unknown> }).errorPromise;
          void ep?.catch((e) => {
            this.audioEncodeError = e instanceof Error ? e : new Error(String(e));
            this.opts.onAudioError?.(this.audioEncodeError);
          });
        } catch { /* older mediabunny without errorPromise — ignore */ }
        output.addAudioTrack(audioSource);
      } catch (e) {
        // Audio encode unavailable / track invalid — record video only rather
        // than failing the whole recording. Surface it so it isn't fully silent.
        this.audioEncodeError = e instanceof Error ? e : new Error(String(e));
        this.opts.onAudioError?.(this.audioEncodeError);
      }
    }
    return captureSampleSource;
  }

  /**
   * Wire the sample-accurate capture source onto the muxer + the worklet port.
   * Returns the backpressured source (already added to `output`), or null if
   * setup failed (then the recording proceeds video-only). Extracted from
   * start() so the wiring is unit-testable without the real Mediabunny Output.
   */
  private setupCaptureSource(
    output: { addAudioTrack: (s: AudioSampleSource) => void },
    tap: { port: MessagePort; sampleRate: number },
  ): AudioSampleSourceLike | null {
    try {
      const audioSource = this.makeChunkAudioSource(output);
      this.currentAudioSource = audioSource;
      this.capturePort = tap.port;
      this.captureSampleRate = tap.sampleRate;
      // The 5 s overlap ring (planar f32, last OVERLAP_SECONDS at this rate) — the
      // recorder taps every emitted chunk into it so a roll can prepend the tail.
      this.audioRing = new AudioRingBuffer(Math.max(1, Math.round(OVERLAP_SECONDS * tap.sampleRate)));
      // A/V SYNC: the video CanvasSource timestamps each frame at index/fps (CFR)
      // from 0; the drain clocks audio off the AUDIO sample count from 0 too, so
      // audio sample N lands at N/sampleRate seconds — both tracks share the zero
      // epoch (no drift; both clocks are sample/frame-accurate). The PER-CHUNK
      // audio clock (chunkAudioFrames) lives in the drain's add() so each rolled
      // file's audio starts at 0 again.
      this.captureDrain = new AudioCaptureDrain(tap.sampleRate, 0);
      this.chunkAudioFrames = 0;
      const drain = this.captureDrain;
      this.capturePort.onmessage = (e: MessageEvent) => {
        drain.push(e.data as CaptureChunk);
      };
      return audioSource;
    } catch (e) {
      // Capture-source setup failed — record video only rather than failing the
      // whole recording. Surface it so it isn't fully silent.
      this.audioEncodeError = e instanceof Error ? e : new Error(String(e));
      this.opts.onAudioError?.(this.audioEncodeError);
      this.capturePort = null;
      this.captureDrain = null;
      this.currentAudioSource = null;
      this.audioRing = null;
      return null;
    }
  }

  /** Build the REAL CanvasSource for one chunk (the default video-source path).
   *  Codec + bitrate + keyframe interval come from the resolved quality tier;
   *  prefer-hardware is the audio-glitch fix (a software video encode starves the
   *  audio capture path → clicks/pops). Extracted so buildChunkSession can swap in
   *  a fake via makeCanvasSource for the chunk-roll unit tests. */
  private makeRealCanvasSource(): CanvasSourceLike {
    return new CanvasSource(this.opts.canvas as HTMLCanvasElement, {
      codec: this.opts.videoCodec ?? VIDEO_CODEC,
      bitrate: this.opts.videoBitrate ?? DEFAULT_VIDEO_BITRATE,
      keyFrameInterval: this.opts.keyFrameInterval ?? DEFAULT_KEYFRAME_INTERVAL,
      hardwareAcceleration: this.opts.hardwareAcceleration ?? 'prefer-hardware',
      // The engine canvas keeps a stable size for a recording; deny size
      // changes mid-stream (the encoder's first-frame box is authoritative).
      sizeChangeBehavior: 'contain',
    }) as unknown as CanvasSourceLike;
  }

  /** Build a backpressured audio source for ONE chunk's Output + wire its
   *  error-promise observer. Extracted so rollChunk can build the next chunk's
   *  source identically. */
  private makeChunkAudioSource(
    output: { addAudioTrack: (s: AudioSampleSource) => void },
  ): AudioSampleSourceLike {
    const makeASS = this.opts.makeAudioSampleSource ?? defaultMakeAudioSampleSource;
    const audioSource = makeASS({
      codec: AUDIO_CODEC,
      bitrate: this.opts.audioBitrate ?? DEFAULT_AUDIO_BITRATE,
    });
    try {
      const ep = (audioSource as unknown as { errorPromise?: Promise<unknown> }).errorPromise;
      void ep?.catch((e) => {
        this.audioEncodeError = e instanceof Error ? e : new Error(String(e));
        this.opts.onAudioError?.(this.audioEncodeError);
      });
    } catch { /* older mediabunny without errorPromise — ignore */ }
    output.addAudioTrack(audioSource as unknown as AudioSampleSource);
    return audioSource;
  }

  /** Add one planar-stereo init to the CURRENT chunk's audio source on the
   *  PER-CHUNK clock (each file's audio restarts at 0 + stays contiguous), and
   *  tap it into the overlap ring. Shared by the drain loop + the roll prepend.
   *
   *  ROLL SAFETY: while a roll is in flight (`heldDuringRoll` non-null) we do NOT
   *  write to the source — we STASH the init in order and rollChunk flushes the
   *  hold (after the overlap prepend) so no sample popped during the finalize
   *  window is lost OR reordered ahead of the overlap. We must never early-return
   *  (drop) when the source is momentarily null mid-roll. */
  private async addAudioToCurrentChunk(init: CaptureSampleInit): Promise<void> {
    if (this.heldDuringRoll) {
      // Mid-roll: the finishing chunk's source is detached and the new chunk's
      // overlap hasn't been primed yet. Hold this live sample (in capture order)
      // for rollChunk to flush into chunk N+1 after the overlap. No drop.
      this.heldDuringRoll.push(init);
      return;
    }
    await this.writeAudioToChunk(init);
  }

  /** Write one planar-stereo init to the CURRENT chunk's audio source on the
   *  per-chunk clock + tap the overlap ring. The actual write, with NO roll
   *  gate — only addAudioToCurrentChunk (live drain) and rollChunk's hold-flush
   *  call this, so the roll-ordering invariant (overlap → held → live) holds. A
   *  null source (genuine video-only) is a no-op. */
  private async writeAudioToChunk(init: CaptureSampleInit): Promise<void> {
    const src = this.currentAudioSource;
    if (!src) return;
    const frames = init.data.length / 2; // planar stereo: data = [L…, R…]
    const timestamp = this.chunkAudioFrames / this.captureSampleRate;
    this.chunkAudioFrames += frames;
    // Tap into the rolling overlap window (the next chunk prepends this tail).
    this.audioRing?.pushChunk({ data: init.data, frames });
    await src.add(new AudioSample({ ...init, timestamp }));
  }

  /**
   * ARM the worklet (it begins posting batches — idle until now, so nothing
   * buffers between takes) and start the lossless drain loop. Each posted chunk
   * is fed through the BACKPRESSURED add() (awaited), so a busy encoder fills the
   * queue + drains later — never drops a sample. ONE long-lived drain spans every
   * chunk: it feeds `this.currentAudioSource`, which rollChunk swaps. Extracted
   * from start() for testing.
   */
  private armCaptureDrain(): void {
    const drain = this.captureDrain;
    const port = this.capturePort;
    if (!drain || !port) return;
    port.postMessage({ type: 'arm' });
    this.captureDrainLoop = drain.drain(
      (init: CaptureSampleInit) => this.addAudioToCurrentChunk(init),
      macrotask,
    ).catch(() => { /* drain errors must not crash the recording */ });
  }

  /**
   * Encode the current canvas contents as CFR video frame(s). Call once per rAF
   * while recording.
   *
   * THE OSX SLOW-MO FIX: instead of timestamping each frame off WALL CLOCK
   * (variable under render load → an irregular PTS stream a player reads as
   * slow-motion), we drive PTS off a MONOTONIC FRAME INDEX on a fixed grid
   * (index/fps). Per rAF we ask the CFR clock how many grid frames "should" exist
   * by now and emit to catch the grid up: skip when ahead (no collision), emit one
   * on pace, or duplicate the current canvas (bounded) when behind — so the
   * encoded stream is true CONSTANT frame rate regardless of rAF jitter, and the
   * muxer's frameRate:30 is a truthful declaration, not a lossy repair.
   *
   * Also drives GoPro CHUNKING: once the current chunk reaches the roll threshold
   * it rolls to a new file (internal — the rAF call site is unchanged).
   *
   * Non-blocking: skips this tick if the previous encode hasn't drained
   * (backpressure) — honored per emitted grid frame.
   */
  frame(): void {
    if (this.state !== 'recording' || !this.canvasSource) return;
    const elapsed = (performance.now() - this.t0) / 1000;

    // ── GoPro roll: once this chunk hits the threshold, roll to a new file. ──
    if (!this.rolling && elapsed - this.chunkStartElapsed >= this.maxChunkSeconds) {
      void this.rollChunk();
      return; // resume CFR emission on the next rAF, into the new chunk.
    }
    if (this.rolling) return; // mid-roll: don't feed a finalizing/closing output.

    if (this.addInFlight) return; // previous grid frame still draining → skip tick.

    // How many grid frames to emit this tick (drop/dup to the CFR grid). The grid
    // is CHUNK-RELATIVE: frameCount resets to 0 on a roll, so compare against the
    // elapsed time SINCE this chunk started (else a rolled chunk thinks it's
    // 10 min behind + floods catch-up frames). PTS is therefore index/fps from 0
    // for each chunk file. Usually [] (ahead) or one index (on pace); a hitch
    // duplicates up to a bounded few.
    const chunkElapsed = elapsed - this.chunkStartElapsed;
    // Deficit-aware: track how long we've been MEANINGFULLY behind the grid and
    // pass that streak to planCfrEmit so it relaxes the per-tick catch-up cap once
    // the deficit is SUSTAINED — otherwise a render persistently below ~10 fps lets
    // the video frameCount lag the grid forever and the video track ends shorter
    // than the sample-accurate audio (growing A/V desync). A perfectly on-pace
    // render is ALWAYS ~1 frame behind (the frame is emitted the tick its slot
    // becomes due), so we only count a deficit LARGER than DEFICIT_SLACK_FRAMES —
    // that's what keeps an on-pace / transiently-hitched render from ever tripping
    // the sustained ramp. Update the streak BEFORE emitting.
    const due = this.cfr.framesDue(chunkElapsed);
    this.deficitStreak =
      due - this.frameCount > DEFICIT_SLACK_FRAMES ? this.deficitStreak + 1 : 0;
    const plan = planCfrEmit(this.cfr, this.frameCount, chunkElapsed, 2, this.deficitStreak);
    if (plan.length === 0) return;

    // Emit the first grid frame now (honoring backpressure via addInFlight); any
    // bounded catch-up duplicates ride the same canvas content + chain after it so
    // each lands on its own grid slot without colliding.
    const src = this.canvasSource;
    const dur = this.cfr.frameDuration;
    this.addInFlight = true;
    let p: Promise<void> = Promise.resolve();
    for (const index of plan) {
      const ts = this.cfr.ptsForFrame(index); // EVEN grid PTS: 0, 1/fps, 2/fps …
      this.frameCount++;
      p = p.then(() => src.add(ts, dur)).catch(() => { /* backpressure/closed — drop */ });
    }
    void p.finally(() => { this.addInFlight = false; });
  }

  /**
   * Roll to a NEW chunk file (GoPro-style, every ~10 min). Finalizes + delivers
   * the current chunk, opens a fresh chunk session, and PREPENDS the trailing 5 s
   * of audio (the overlap) as the start of the new chunk. The single long-lived
   * drain keeps feeding `this.currentAudioSource` (swapped here), so no captured
   * sample is lost across the boundary. Video for the new chunk starts fresh at
   * frame 0 (only AUDIO overlaps, per spec); the visual cut is at the boundary.
   */
  private async rollChunk(): Promise<void> {
    if (this.rolling || this.state !== 'recording') return;
    this.rolling = true;
    const rolledIndex = this.chunkIndex;
    try {
      // 1) Snapshot the trailing audio BEFORE we swap sources (the overlap tail).
      const overlap = this.audioRing?.snapshotPlanar() ?? { data: new Float32Array(0), frames: 0 };

      // 2) Wait for any in-flight video frame to drain, then finalize + deliver
      //    the current chunk. The long-lived drain keeps popping audio (lossless)
      //    while we finalize — those samples are captured AFTER the roll boundary
      //    and belong in chunk N+1. We ARM the hold buffer BEFORE detaching the
      //    finishing source so addAudioToCurrentChunk stashes (never drops) every
      //    sample popped during the finalize window; step 4 flushes them into the
      //    new chunk after the overlap, preserving order + sample-accuracy. (Old
      //    bug: a null source here made addAudioToCurrentChunk early-return-DROP,
      //    a real audio gap at each ~10-min boundary.)
      while (this.addInFlight) await macrotask();
      const finishing = this.output;
      const finishingPath = this.opfsPath;
      const finishingWriter = this.writer;
      // Arm the hold, THEN detach the finishing session's audio source so the
      // drain stops feeding the finishing muxer but loses nothing in the gap.
      this.heldDuringRoll = [];
      this.currentAudioSource = null;
      try { await finishing?.finalize(); } catch { /* recoverable fragments remain */ }
      try { await finishingWriter?.close(); } catch { /* */ }
      void this.deliverChunk(finishingPath, rolledIndex);

      // 3) Open chunk N+1 (a fresh session: new OPFS path, manifest, Output, video
      //    + audio tracks). freshAudio=false REUSES the long-lived drain/ring/port
      //    — only a new per-chunk audio source is built. Reset the per-chunk video
      //    grid + audio clock to 0 so the new file's timestamps start at 0.
      this.chunkIndex = rolledIndex + 1;
      const newSrc = await this.buildChunkSession(this.chunkIndex, new Date(), false);
      this.frameCount = 0;
      this.deficitStreak = 0; // new chunk's grid restarts at 0 — no carried deficit.
      this.chunkStartElapsed = (performance.now() - this.t0) / 1000;
      this.chunkAudioFrames = 0;
      try {
        await this.output!.start();
      } catch {
        // The new chunk's output failed to start — stop cleanly rather than feed a
        // dead output. (Rare; the first chunk already proved the encoder works.)
        this.setState('error');
        return;
      }
      this.currentAudioSource = newSrc;

      // 4) PREPEND the overlap, then FLUSH the hold — both via writeAudioToChunk
      //    (the direct, NON-roll-gated write) so they land BEFORE live capture
      //    resumes, in this exact order on the per-chunk clock:
      //      (a) the retained ≤5 s overlap tail of chunk N (timestamp 0…), then
      //      (b) the live samples popped DURING the finalize window, in capture
      //          order (continuing the per-chunk clock right after the overlap).
      //    Only after the hold is drained do we null heldDuringRoll, so any sample
      //    the drain pops in the meantime is still held (never reordered ahead of
      //    the overlap/earlier-held samples). (First chunk has an empty ring → no
      //    prepend; a video-only take has a null source → writeAudioToChunk no-ops
      //    and the hold is simply discarded.)
      if (newSrc && overlap.frames > 0 && this.captureSampleRate > 0) {
        await this.writeAudioToChunk({
          data: overlap.data,
          format: 'f32-planar',
          numberOfChannels: 2,
          sampleRate: this.captureSampleRate,
          timestamp: 0, // recomputed by writeAudioToChunk on the chunk clock
        });
      }
      // Flush every sample held during the finalize window, in order. We swap the
      // buffer out for a FRESH empty hold each pass so any sample the drain pops
      // while we await an add() is appended to the fresh hold (still ordered AFTER
      // these) instead of mutating the array we're iterating. Loop until a pass
      // adds nothing new, then null the hold so live capture writes directly.
      for (;;) {
        const held = this.heldDuringRoll ?? [];
        if (held.length === 0) break;
        this.heldDuringRoll = []; // fresh hold catches anything popped during the awaits
        for (const init of held) await this.writeAudioToChunk(init);
      }
      // Roll complete: live capture resumes writing directly (heldDuringRoll null).
      this.heldDuringRoll = null;
    } finally {
      this.rolling = false;
      this.heldDuringRoll = null;
    }
  }

  /** Finalize-delivery for ONE chunk's OPFS scratch: remux → flat MP4 (fall back
   *  to raw fragmented bytes), then write it to the destination under the chunk's
   *  name, and retire that scratch on success. Used by rollChunk (rolled chunks)
   *  and stop() (the final chunk). Reports via onChunkSaved. */
  private async deliverChunk(opfsPath: string, chunkIndex: number): Promise<string | null> {
    const chunkName = chunkFileName(this.opts.filename, chunkIndex, new Date());

    // Build the FLAT deliverable (remux fragmented → moov-based; fall back to raw
    // fragmented bytes so a take is never lost).
    const remux = this.opts.remuxToFlatMp4 ?? defaultRemuxToFlatMp4;
    let bytes: Uint8Array | null = null;
    try { bytes = await remux(opfsPath); } catch { bytes = null; }
    if (!bytes || bytes.byteLength === 0) {
      try {
        const { readOpfsBytes } = await import('./recorderbox-store');
        bytes = await readOpfsBytes(opfsPath);
      } catch { bytes = null; }
    }
    if (!bytes || bytes.byteLength === 0) {
      // Nothing to deliver — KEEP the scratch + manifest as a recover candidate.
      return null;
    }

    // Deliver. Folder model (Chromium) → write FILENAME-CHUNK#-DATETIME.mp4 into
    // the picked folder. Legacy single-file handle → write there (first chunk
    // only). No handle (Firefox/Safari) → saveBytes (<a download>) per chunk.
    let delivered = false;
    if (this.opts.dirHandle) {
      try {
        const fh = await (this.opts.dirHandle as unknown as {
          getFileHandle: (n: string, o?: { create?: boolean }) => Promise<FileSystemFileHandle>;
        }).getFileHandle(chunkName, { create: true });
        const sink = await createWritableSink(fh);
        await sink.write(bytes as unknown as BufferSource);
        await sink.close();
        delivered = true;
      } catch {
        delivered = false;
      }
    } else if (this.opts.destHandle && chunkIndex === 1) {
      try {
        const sink = await createWritableSink(this.opts.destHandle);
        await sink.write(bytes as unknown as BufferSource);
        await sink.close();
        delivered = true;
      } catch {
        delivered = false;
      }
    } else {
      try {
        await this.opts.saveBytes(bytes, chunkName, CONTAINER_MIME);
        delivered = true;
      } catch {
        delivered = false;
      }
    }

    if (!delivered) return null; // KEEP the scratch + manifest as a recover candidate.
    await this.retireScratch(opfsPath);
    this.opts.onChunkSaved?.({ index: chunkIndex, name: chunkName, bytes: bytes.byteLength });
    return chunkName;
  }

  /**
   * Finalize the recording: drain the audio tail, finalize the muxer, close the
   * OPFS writer, then deliver the FINAL chunk to its destination via deliverChunk
   * (remux → flat MP4 → write under the chunk's FILENAME-CHUNK#-DATETIME name).
   *
   * WHY REMUX (2026-06-17): the OPFS scratch is a FRAGMENTED MP4 — the
   * crash-recovery guarantee (playable from whatever fragments hit disk). But
   * DaVinci Resolve + some NLEs refuse to import fragmented MP4 (they play fine in
   * a browser / QuickTime, the "plays in preview, won't import into Resolve"
   * symptom). We remux to a standard moov-based MP4 — container only, codec COPY,
   * no re-encode. If the remux can't run we fall back to delivering the RAW
   * fragmented bytes so a take is NEVER lost.
   *
   * GoPro chunking: stop() finalizes the CURRENT chunk (its real length — 10 min,
   * or shorter if it's the final/only chunk), so a single take under the roll
   * threshold yields exactly one file (RECORDING-001-<datetime>.mp4). A failed
   * save KEEPS the scratch + manifest as a recover candidate. Returns the final
   * chunk's delivered name, or null if nothing landed.
   */
  async stop(): Promise<string | null> {
    if (this.state !== 'recording' || !this.output) {
      // Already stopped / never started.
      return null;
    }
    this.setState('finalizing');
    // Don't race a roll: if one is mid-flight let it settle so we finalize the
    // chunk it produced, not a half-built output.
    while (this.rolling) await macrotask();

    // ── Drain the capture tail BEFORE finalize ──
    // DISARM flushes the worklet's final partial batch (so the take isn't
    // truncated), close() lets the drain loop exit once the queue empties, and
    // awaiting captureDrainLoop guarantees every captured sample reached the
    // backpressured add() before we close the muxer's audio track.
    if (this.capturePort) {
      try { this.capturePort.postMessage({ type: 'disarm' }); } catch { /* */ }
      // Give the disarm flush a macrotask to be delivered + pushed before close.
      await macrotask();
    }
    if (this.captureDrain) {
      this.captureDrain.close();
    }
    if (this.captureDrainLoop) {
      try { await this.captureDrainLoop; } catch { /* */ }
    }
    if (this.capturePort) {
      try { this.capturePort.onmessage = null; } catch { /* */ }
    }

    try {
      await this.output.finalize();
    } catch {
      // Even a failed finalize leaves the fragmented file recoverable; press on
      // to deliver whatever fragments landed.
    }
    try { await this.writer?.close(); } catch { /* */ }

    // Deliver the final chunk (remux + write under its chunk name; retire on
    // success). deliverChunk returns null when nothing landed → KEEP the scratch
    // as a recover candidate.
    const delivered = await this.deliverChunk(this.opfsPath, this.chunkIndex);
    this.setState('idle');
    return delivered;
  }

  /** Retire the recovery state + delete the OPFS scratch at `path` (best-effort). */
  private async retireScratch(path: string): Promise<void> {
    await markManifestDone(path);
    try {
      const { deleteOpfsFile } = await import('./recorderbox-store');
      await deleteOpfsFile(path);
      await deleteManifest(path);
    } catch {
      /* best-effort cleanup */
    }
  }

  /** Hard cancel (card destroyed mid-record): finalize best-effort + leave the
   *  scratch + manifest as a recover candidate (do NOT delete). */
  async abandon(): Promise<void> {
    if (this.state !== 'recording' || !this.output) return;
    this.setState('idle');
    // Tear down the capture tap best-effort (disarm flushes the final partial;
    // close + await the drain so the captured tail lands in the recoverable
    // fragments before finalize).
    if (this.capturePort) {
      try { this.capturePort.postMessage({ type: 'disarm' }); } catch { /* */ }
      await macrotask();
    }
    if (this.captureDrain) this.captureDrain.close();
    if (this.captureDrainLoop) { try { await this.captureDrainLoop; } catch { /* */ } }
    if (this.capturePort) { try { this.capturePort.onmessage = null; } catch { /* */ } }
    try { await this.output.finalize(); } catch { /* */ }
    try { await this.writer?.close(); } catch { /* */ }
    // Intentionally NOT deleting the manifest/scratch — that's the recovery
    // candidate the next mount will offer.
  }

  /** Frames encoded so far (test/observability). */
  getFrameCount(): number {
    return this.frameCount;
  }

  /** The audio-track add/encode error, if the soundtrack was dropped (else
   *  null). Lets the card / tests detect a silent-audio recording. */
  getAudioEncodeError(): Error | null {
    return this.audioEncodeError;
  }
}

/**
 * Open a `FileSystemWritableFileStream` on the user's chosen destination handle
 * and adapt it to the narrow `ChunkSink` the streaming copy writes into. Writing
 * to a user-picked file goes through the browser's swap file (so it is NOT
 * crash-safe mid-stream — that's why OPFS remains the real partial); this stream
 * is only opened at STOP, once the take is finalized.
 */
async function createWritableSink(handle: FileSystemFileHandle): Promise<ChunkSink> {
  const writable = await (handle as unknown as {
    createWritable: (o?: { keepExistingData?: boolean }) => Promise<{
      write: (d: BufferSource | Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }).createWritable();
  return {
    write: (chunk: BufferSource | Blob) => writable.write(chunk),
    close: () => writable.close(),
  };
}

// ---------------------------------------------------------------------------
// Default remux: fragmented OPFS scratch → flat (moov-based) MP4
// ---------------------------------------------------------------------------

/**
 * The DEFAULT remux used by stop(): read the FRAGMENTED OPFS scratch as a ranged
 * Blob and re-mux it (codec COPY — no re-encode) into a standard, NON-fragmented
 * moov-based MP4 that DaVinci Resolve + other NLEs will import. Returns the flat
 * bytes, or null if it can't run (OPFS missing / Mediabunny unavailable / the
 * input wasn't a readable MP4) — stop() then falls back to the raw fragmented
 * bytes so a take is never lost.
 *
 * `fastStart:'in-memory'` assembles the whole output in RAM before flushing, so
 * peak memory ≈ the output file size at SAVE time (the recording itself streamed
 * to OPFS durably during capture). Fine for typical takes; a streaming remux for
 * multi-GB recordings is a noted follow-up.
 */
async function defaultRemuxToFlatMp4(opfsPath: string): Promise<Uint8Array | null> {
  let file: File | null = null;
  try {
    const { getOpfsFileForRead } = await import('./recorderbox-store');
    file = await getOpfsFileForRead(opfsPath);
  } catch {
    file = null;
  }
  if (!file || file.size === 0) return null;
  try {
    const input = new Input({ source: new BlobSource(file), formats: [new Mp4InputFormat()] });
    const target = new BufferTarget();
    const output = new Output({
      // A standard moov-based MP4 (not 'fragmented') — the layout NLEs expect.
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    // No video/audio options → Conversion COPIES the encoded samples (remux only,
    // no transcode), so the codec + quality are byte-identical — only the
    // container layout changes from fragmented to flat.
    const conversion = await Conversion.init({ input, output });
    await conversion.execute();
    const buf = target.buffer;
    return buf ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default OPFS writer — Worker-backed (SyncAccessHandle is worker-only)
// ---------------------------------------------------------------------------

/** Build the real OPFS writer. The Worker owns the FileSystemSyncAccessHandle
 *  and writes each fragment to disk synchronously (durable + crash-safe). */
export function defaultMakeWriter(opfsPath: string): OpfsWriter {
  return new WorkerOpfsWriter(opfsPath);
}

/** Build the real fragmented-MP4 Output: a StreamTarget piping each fragment
 *  ({ data, position }) into the OPFS writer, awaiting the writer's ack so the
 *  muxer won't outrun the disk. fastStart:'fragmented' is the crash-recovery
 *  guarantee (playable from whatever fragments hit disk before finalize). */
function defaultMakeOutput(writer: OpfsWriter): MuxOutputLike {
  const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
    async write(chunk) {
      await writer.write({ data: chunk.data, position: chunk.position });
    },
  });
  return new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(writable as unknown as WritableStream),
  }) as unknown as MuxOutputLike;
}

/**
 * Inline (Blob-URL) Worker that owns the OPFS SyncAccessHandle. Mirrors the
 * scheduler-clock.ts inline-worker pattern so no bundler worker-entry config
 * is needed. Each write() round-trips to the worker + awaits its ack so
 * StreamTarget backpressure is honored (the muxer won't outrun the disk).
 */
class WorkerOpfsWriter implements OpfsWriter {
  private worker: Worker | null = null;
  private ready: Promise<void>;
  private seq = 0;
  private pending = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();

  constructor(opfsPath: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      try {
        const blob = new Blob([OPFS_WORKER_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const w = new Worker(url, { type: 'module' });
        URL.revokeObjectURL(url);
        this.worker = w;
        w.onmessage = (e: MessageEvent) => {
          const d = e.data as { type: string; id?: number; error?: string };
          if (d.type === 'open-ok') { resolve(); return; }
          if (d.type === 'open-err') { reject(new Error(d.error ?? 'opfs open failed')); return; }
          if (d.type === 'write-ok' && d.id !== undefined) {
            this.pending.get(d.id)?.resolve();
            this.pending.delete(d.id);
          }
          if (d.type === 'write-err' && d.id !== undefined) {
            this.pending.get(d.id)?.reject(new Error(d.error ?? 'opfs write failed'));
            this.pending.delete(d.id);
          }
        };
        w.onerror = (err) => reject(err);
        w.postMessage({ type: 'open', path: opfsPath });
      } catch (err) {
        reject(err);
      }
    });
  }

  async write(chunk: { data: Uint8Array; position: number }): Promise<void> {
    await this.ready;
    const w = this.worker;
    if (!w) throw new Error('opfs worker gone');
    const id = ++this.seq;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Copy into a fresh ArrayBuffer we can transfer (mediabunny may reuse
      // its buffer). Transfer avoids a structured-clone copy of the fragment.
      const copy = chunk.data.slice();
      w.postMessage({ type: 'write', id, position: chunk.position, data: copy }, [copy.buffer]);
    });
  }

  async close(): Promise<void> {
    try { await this.ready; } catch { /* never opened */ }
    const w = this.worker;
    if (!w) return;
    await new Promise<void>((resolve) => {
      const onClose = (e: MessageEvent) => {
        if ((e.data as { type?: string })?.type === 'close-ok') {
          w.removeEventListener('message', onClose);
          resolve();
        }
      };
      w.addEventListener('message', onClose);
      try { w.postMessage({ type: 'close' }); } catch { resolve(); }
      // Safety timeout: never hang the stop() flow on a wedged worker.
      setTimeout(resolve, 2000);
    });
    try { w.terminate(); } catch { /* */ }
    this.worker = null;
  }
}

// The OPFS worker source. Holds a FileSystemSyncAccessHandle and writes each
// fragment to disk synchronously (the only API that durably writes immediately
// + survives a crash). Self-contained classic-worker-friendly module source.
const OPFS_WORKER_SOURCE = `
let accessHandle = null;

async function openFile(path) {
  const root = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  // createSyncAccessHandle is worker-only. Truncate to 0 in case a stale file
  // exists at this exact path (shouldn't — path carries the start epoch).
  accessHandle = await fileHandle.createSyncAccessHandle();
  accessHandle.truncate(0);
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'open') {
    try {
      await openFile(d.path);
      self.postMessage({ type: 'open-ok' });
    } catch (err) {
      self.postMessage({ type: 'open-err', error: String(err && err.message || err) });
    }
    return;
  }
  if (d.type === 'write') {
    try {
      // Synchronous write AT THE GIVEN OFFSET — fragmented MP4 writes are
      // monotonic but we honor the position to be safe. flush() forces the
      // bytes to disk so a crash right after can't lose this fragment.
      accessHandle.write(d.data, { at: d.position });
      accessHandle.flush();
      self.postMessage({ type: 'write-ok', id: d.id });
    } catch (err) {
      self.postMessage({ type: 'write-err', id: d.id, error: String(err && err.message || err) });
    }
    return;
  }
  if (d.type === 'close') {
    try {
      if (accessHandle) { accessHandle.flush(); accessHandle.close(); accessHandle = null; }
    } catch (err) { /* */ }
    self.postMessage({ type: 'close-ok' });
    return;
  }
};
`;
