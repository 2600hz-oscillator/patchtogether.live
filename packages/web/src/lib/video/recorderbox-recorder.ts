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
  streamOpfsToWritable,
  hasOpfs,
  type RecorderboxManifest,
  type ChunkSink,
} from './recorderbox-store';

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
  canEncodeVideo,
  canEncodeAudio,
} from 'mediabunny';

// ── Locked defaults (user said proceed; overridable later) ──
/** ~14 Mbps VBR video — "high quality" per the spec. */
export const DEFAULT_VIDEO_BITRATE = 14_000_000;
/** 192 kbps AAC stereo. */
export const DEFAULT_AUDIO_BITRATE = 192_000;
/** 30 fps capture. */
export const DEFAULT_FPS = 30;
export const VIDEO_CODEC = 'avc' as const; // H.264
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
   *  MediaStreamAudioDestinationNode). Null = record video only (silent). */
  audioTrack: MediaStreamTrack | null;
  /** User-chosen base filename (sanitized at save time + baked into the OPFS
   *  scratch path so a recovered/partial file carries the intended name). */
  filename: string;
  /**
   * The destination the user chose AT START via showSaveFilePicker (Chromium).
   * When present, stop() STREAMS the OPFS scratch straight into this handle in
   * chunks (correct name, never a full in-memory read) instead of calling
   * saveBytes. Persisted to the manifest so crash-recovery can restore to the
   * same path. Absent on Firefox/Safari (no picker) → stop() falls back to
   * saveBytes (the <a download> blob path).
   */
  destHandle?: FileSystemFileHandle | null;
  /** Video bitrate override (defaults to 14 Mbps). */
  videoBitrate?: number;
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

/**
 * A single live recording session. Construct → start() → (per-rAF) frame()
 * → stop(). One per Record ON/OFF cycle; the card creates a fresh one each
 * time.
 */
export class RecorderboxRecorder {
  private opts: RecorderboxRecorderOptions;
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

  constructor(opts: RecorderboxRecorderOptions) {
    this.opts = opts;
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
    // Bake the user's intended name into the scratch path (+ a .partial marker)
    // so the recovery UI + any recovered file carry it, not just nodeId+epoch.
    this.opfsPath = opfsScratchPath(this.opts.nodeId, this.startEpoch, this.opts.filename);

    // OPFS scratch writer (Worker-backed by default).
    this.writer = (this.opts.makeWriter ?? defaultMakeWriter)(this.opfsPath);

    // Recovery manifest — written BEFORE the first byte so a crash 100ms in
    // still leaves a recover candidate pointing at the (possibly tiny) file.
    // The destHandle (the path the user picked at START) rides along so
    // recovery can restore to the original chosen location with the right name.
    const manifest: RecorderboxManifest = {
      nodeId: this.opts.nodeId,
      filename: this.opts.filename,
      startedAt: this.startEpoch,
      mime: CONTAINER_MIME,
      opfsPath: this.opfsPath,
      status: 'recording',
      ...(this.opts.destHandle ? { destHandle: this.opts.destHandle } : {}),
    };
    await putManifest(manifest);

    // StreamTarget → OPFS writer. Mediabunny writes fragments as
    // { type:'write', data, position }; we forward data+position to the writer.
    const writer = this.writer;
    const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
      async write(chunk) {
        await writer.write({ data: chunk.data, position: chunk.position });
      },
    });

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new StreamTarget(writable as unknown as WritableStream),
    });
    this.output = output;

    // Video track from the hidden capture canvas.
    const canvasSource = new CanvasSource(this.opts.canvas as HTMLCanvasElement, {
      codec: VIDEO_CODEC,
      bitrate: this.opts.videoBitrate ?? DEFAULT_VIDEO_BITRATE,
      // The engine canvas keeps a stable size for a recording; deny size
      // changes mid-stream (the encoder's first-frame box is authoritative).
      sizeChangeBehavior: 'contain',
    });
    this.canvasSource = canvasSource;
    output.addVideoTrack(canvasSource, { frameRate: DEFAULT_FPS });

    // Audio track — optional. A null track records video only (silent MP4).
    if (this.opts.audioTrack) {
      try {
        const audioSource = new MediaStreamAudioTrackSource(
          this.opts.audioTrack as MediaStreamAudioTrack,
          { codec: AUDIO_CODEC, bitrate: DEFAULT_AUDIO_BITRATE },
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

    try {
      await output.start();
      this.setState('recording');
    } catch (err) {
      this.setState('error');
      // Roll back the manifest + writer so we don't leave a phantom recover
      // candidate for a recording that never started.
      try { await this.writer.close(); } catch { /* */ }
      await deleteManifest(this.opfsPath);
      throw err;
    }
  }

  /**
   * Encode the current canvas contents as one frame. Call once per rAF while
   * recording. Timestamps are wall-clock seconds since start (shared t0 with
   * the audio track's synced-zero base → A/V stay in sync). Non-blocking:
   * drops the frame if the previous encode hasn't drained (backpressure).
   */
  frame(): void {
    if (this.state !== 'recording' || !this.canvasSource) return;
    if (this.addInFlight) return;
    const ts = (performance.now() - this.t0) / 1000;
    this.addInFlight = true;
    this.frameCount++;
    // CanvasSource.add(timestamp, duration?) — pass the nominal frame duration
    // so the muxer has a sensible default if the next frame is late.
    void this.canvasSource
      .add(ts, 1 / DEFAULT_FPS)
      .catch(() => { /* encoder backpressure / closed — drop */ })
      .finally(() => { this.addInFlight = false; });
  }

  /**
   * Finalize the recording: flush + finalize the muxer (writes the final
   * fragment), close the OPFS writer, then deliver the take to its destination:
   *
   *   * destHandle present (Chromium, the user picked a path at START) — STREAM
   *     the OPFS scratch straight into the handle in chunks (correct name at the
   *     chosen path; never reads the whole GB-scale file into memory).
   *   * no destHandle (Firefox/Safari, or a test capture) — read the bytes back
   *     and hand them to saveBytes (the <a download> blob fallback).
   *
   * On success, mark the manifest done + delete the scratch. On a failed save
   * (picker cancel / permission revoked), KEEP the scratch + manifest as a
   * recover candidate. Returns the saved filename, or null if nothing landed.
   */
  async stop(): Promise<string | null> {
    if (this.state !== 'recording' || !this.output) {
      // Already stopped / never started.
      return null;
    }
    this.setState('finalizing');
    try {
      await this.output.finalize();
    } catch {
      // Even a failed finalize leaves the fragmented file recoverable; press on
      // to deliver whatever fragments landed.
    }
    try { await this.writer?.close(); } catch { /* */ }

    const savedName = this.opts.filename;

    // ── Streaming save to the chosen handle (Chromium) ──
    if (this.opts.destHandle) {
      try {
        const sink = await createWritableSink(this.opts.destHandle);
        const written = await streamOpfsToWritable(this.opfsPath, sink);
        if (written > 0) {
          await this.retire();
          this.setState('idle');
          return savedName;
        }
        // Nothing landed — fall through to cleanup (empty take).
      } catch {
        // Permission revoked / write failed — KEEP the scratch + manifest so the
        // user can retry via recovery.
        this.setState('idle');
        return null;
      }
      await this.retire();
      this.setState('idle');
      return null;
    }

    // ── Fallback: full read → saveBytes (<a download> blob) ──
    // Reading OPFS is allowed on the main thread; only the SyncAccessHandle
    // WRITE is worker-only. This path has no streaming-to-disk API anyway.
    let bytes: Uint8Array | null = null;
    try {
      const { readOpfsBytes } = await import('./recorderbox-store');
      bytes = await readOpfsBytes(this.opfsPath);
    } catch {
      bytes = null;
    }
    if (bytes && bytes.byteLength > 0) {
      try {
        await this.opts.saveBytes(bytes, savedName, CONTAINER_MIME);
      } catch {
        // Save failed — KEEP the scratch + leave the manifest as a recover
        // candidate so they can try again.
        this.setState('idle');
        return null;
      }
    }
    await this.retire();
    this.setState('idle');
    return bytes && bytes.byteLength > 0 ? savedName : null;
  }

  /** Retire the recovery state + delete the OPFS scratch (best-effort). */
  private async retire(): Promise<void> {
    await markManifestDone(this.opfsPath);
    try {
      const { deleteOpfsFile } = await import('./recorderbox-store');
      await deleteOpfsFile(this.opfsPath);
      await deleteManifest(this.opfsPath);
    } catch {
      /* best-effort cleanup */
    }
  }

  /** Hard cancel (card destroyed mid-record): finalize best-effort + leave the
   *  scratch + manifest as a recover candidate (do NOT delete). */
  async abandon(): Promise<void> {
    if (this.state !== 'recording' || !this.output) return;
    this.setState('idle');
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
// Default OPFS writer — Worker-backed (SyncAccessHandle is worker-only)
// ---------------------------------------------------------------------------

/** Build the real OPFS writer. The Worker owns the FileSystemSyncAccessHandle
 *  and writes each fragment to disk synchronously (durable + crash-safe). */
export function defaultMakeWriter(opfsPath: string): OpfsWriter {
  return new WorkerOpfsWriter(opfsPath);
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
