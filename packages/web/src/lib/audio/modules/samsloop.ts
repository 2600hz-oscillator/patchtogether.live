// packages/web/src/lib/audio/modules/samsloop.ts
//
// SAMSLOOP — loop-based sample player. User uploads a small audio file
// (≤250 KB) — anything the browser's AudioContext.decodeAudioData accepts:
// wav, mp3, m4a/aac, ogg, flac, opus, weba — OR records from the
// microphone in-place. The source audio is decoded (uploads) or captured
// (mic) into a Float32Array, mono-mixed if stereo, and posted into the
// worklet at packages/dsp/src/samsloop.ts.
//
// INVARIANT: SAMSLOOP can only hold one sample at a time. A new upload
// REPLACES the previously loaded sample. A new mic recording REPLACES the
// previously loaded sample. There is no playlist, no slot system — one
// instance, one buffer. This is the contract every code path here MUST
// preserve (the worklet's `loadSample` message replaces its private
// buffer, and node.data.samples is overwritten in one go). Keeping this
// invariant means the per-instance memory ceiling is deterministic and
// our cap math (lib/multiplayer/samsloop-limits.ts) doesn't have to
// account for any per-slot multiplier.
//
// Playback runs via a fractional read-cursor with linear interpolation in
// the worklet so varispeed (including reverse) doesn't need a separate
// playback path.
//
// I/O surface:
//   inputs:
//     trig      Gate. Rising edge retriggers the sample at the window edge
//               (start for forward playback, end-1 for reverse).
//     rate_cv   CV → rate AudioParam. ±1 V CV maps to ±1 in rate units, so
//               a ±1V LFO swings the rate by ±100% — combined with the
//               slider this can run between −2 (full-left slider + −1 V CV)
//               and +3 (full-right slider + +1 V CV); the worklet clamps
//               to its declared [−3, +3] range.
//   outputs:
//     out       Mono audio.
//
// Slider mapping (documented in the card panel too):
//   slider full left  = −2.0 → reverse 2×
//   slider center      = +1.0 → forward unity   ← centered "no-op"
//   slider full right = +2.0 → forward 2×
//   So the slider's range is [-2, +2] with default value 1. Negative
//   values play in reverse.
//
// Data shape on node.data:
//   samples: number[]          // mono PCM as a plain JS array — Yjs-safe.
//   sampleRate: number         // source rate; used in the waveform card.
//   sampleLength: number       // samples.length, cached.
//   fileName?: string          // for display.
//
// Hard limit: 250 KB on the raw upload file. Larger files are rejected.
// (Compressed formats at 250 KB decode to roughly 5–15 s of audio at
// typical bitrates, which is the intended scope for a sample looper.)
//
// Inputs:
//   trig (gate): rising edge restarts loop playback from `start`.
//   rate_cv (cv, linear, paramTarget=rate): displaces the playback rate.
//
// Outputs:
//   out (audio): the loop's audio.
//
// Params:
//   rate (linear, default = 1.0 native rate): playback rate (negative = reverse, 1 = native).
//   mode (discrete 0..1, default 1): 0 = one-shot, 1 = loop.
//   start (linear 0..1e6 samples, default 0): in-buffer start sample.
//   end (linear 0..1e6 samples, default 1e6): in-buffer end sample.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/samsloop.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Hard size cap on the uploaded audio file. 250 KB — see card UI.
 *  This is the RAW file-size gate (cheap reject before we touch the
 *  decoder). The decoded-buffer gate (SAMSLOOP_MAX_DECODED_SAMPLES)
 *  fires AFTER decode + downsample to catch the case where a small
 *  source file decodes to a large in-memory buffer (8-bit 16 kHz WAV
 *  upsampled to 48 kHz Float32 = 12× memory expansion). */
export const SAMSLOOP_MAX_FILE_BYTES = 250 * 1024;

/** Maximum recorded PCM length in samples. Matches the file-upload byte
 *  cap divided by sizeof(Float32). At 22050 Hz that's ~2.84 seconds; at
 *  44100 Hz ~1.42 seconds — short enough to feel like a loop, long enough
 *  to capture a phrase. The mic-record path enforces this hard cap by
 *  auto-stopping when it would be exceeded. */
export const SAMSLOOP_MAX_SAMPLES = Math.floor(SAMSLOOP_MAX_FILE_BYTES / 4);

/** Target sample rate for stored samples. AudioContext.decodeAudioData
 *  ALWAYS decodes at the context's native rate (typically 48 kHz on
 *  modern Chromium/macOS). For a sample looper we don't need that
 *  fidelity — downsample to 24 kHz to halve memory + halve the cost of
 *  the syncedstore CRDT proxy chain (one YArray record per sample;
 *  this is the dominant per-instance cost — see samsloop-limits.ts).
 *  Only downsample DOWN; if the source was already ≤ this rate, keep
 *  it as-is. */
export const SAMSLOOP_TARGET_SAMPLE_RATE = 24000;

/** Hard cap on stored decoded samples. ~6 seconds at the target 24 kHz
 *  rate. The raw-file gate (SAMSLOOP_MAX_FILE_BYTES) passes a 43 KB
 *  8-bit 16 kHz mono WAV (the bug-report fixture), which decodes to
 *  ~21K samples at source rate but ~65K at 48 kHz native. Without
 *  this cap a contrived small file (e.g. a low-bitrate mp3) could
 *  decode to hundreds of thousands of samples and lock up the main
 *  thread when written into the syncedstore CRDT.
 *
 *  At 24 kHz target rate, 144_000 samples = 6 seconds — well within
 *  the "loop a phrase" use case the module is scoped to. */
export const SAMSLOOP_MAX_DECODED_SAMPLES = 144_000;

export interface SamsloopData {
  samples?: number[];
  sampleRate?: number;
  sampleLength?: number;
  fileName?: string;
  /** Multiplayer attribution — set by Canvas's spawnFromPalette when a
   *  real userId is available. Powers the per-user cap; unattributed
   *  legacy nodes count toward the rackspace cap only. See
   *  lib/multiplayer/samsloop-limits.ts. */
  creatorId?: string;
}

/** Result of attempting to decode + size-check an audio upload. The card
 *  consumes this — `error` populated means the upload was rejected and
 *  the message is suitable for display. */
export interface SamsloopLoadResult {
  ok: boolean;
  error?: string;
  samples?: Float32Array;
  sampleRate?: number;
}

/** Downsample a mono Float32 buffer by an integer factor with a brief
 *  box filter (averaging window) to suppress aliasing. Sufficient for
 *  a sample looper — we're not targeting studio fidelity, just keeping
 *  the stored buffer small enough that the syncedstore CRDT write
 *  doesn't block the main thread.
 *
 *  Exported for tests. */
export function samsloopDownsample(input: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return input;
  const outLen = Math.floor(input.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const base = i * factor;
    let sum = 0;
    let count = 0;
    for (let j = 0; j < factor && base + j < input.length; j++) {
      sum += input[base + j]!;
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

/** Manually parse a RIFF/WAVE file → mono Float32Array + sample rate.
 *  Handles 8-bit unsigned PCM, 16-bit signed PCM, 24-bit signed PCM,
 *  32-bit signed PCM, and 32-bit IEEE float — the bit depths Chrome's
 *  decodeAudioData has spotty support for (notably 8-bit unsigned PCM,
 *  which silently rejects on some Chrome builds). Returns null if the
 *  bytes are not a valid uncompressed WAV; caller falls back to
 *  decodeAudioData for mp3/ogg/flac/etc.
 *
 *  Exported for tests. */
export function parseWavManually(
  ab: ArrayBuffer,
): { samples: Float32Array; sampleRate: number } | null {
  if (ab.byteLength < 44) return null;
  const view = new DataView(ab);
  // RIFF / WAVE header
  if (view.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
  if (view.getUint32(8, false) !== 0x57415645) return null; // "WAVE"

  // Walk chunks to find fmt + data (LIST/INFO etc. can come before data).
  let cursor = 12;
  let fmtFound = false;
  let dataOffset = -1;
  let dataSize = 0;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  while (cursor + 8 <= view.byteLength) {
    const chunkId = view.getUint32(cursor, false);
    const chunkSize = view.getUint32(cursor + 4, true);
    if (chunkId === 0x666d7420) { // "fmt "
      audioFormat   = view.getUint16(cursor + 8, true);
      channels      = view.getUint16(cursor + 10, true);
      sampleRate    = view.getUint32(cursor + 12, true);
      bitsPerSample = view.getUint16(cursor + 22, true);
      fmtFound = true;
    } else if (chunkId === 0x64617461) { // "data"
      dataOffset = cursor + 8;
      dataSize = chunkSize;
      break;
    }
    cursor += 8 + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }
  if (!fmtFound || dataOffset < 0 || channels < 1) return null;

  // Decode samples by format. 1 = PCM int, 3 = IEEE float.
  const bytesPerSample = bitsPerSample >> 3;
  const frameBytes = bytesPerSample * channels;
  if (frameBytes === 0) return null;
  const frameCount = Math.floor(dataSize / frameBytes);
  const mono = new Float32Array(frameCount);

  if (audioFormat === 1 && bitsPerSample === 8) {
    // 8-bit PCM is UNSIGNED, centered on 128.
    const u8 = new Uint8Array(ab, dataOffset, frameCount * channels);
    for (let i = 0; i < frameCount; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) {
        acc += (u8[i * channels + c]! - 128) / 128;
      }
      mono[i] = acc / channels;
    }
  } else if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i < frameCount; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) {
        acc += view.getInt16(dataOffset + (i * channels + c) * 2, true) / 32768;
      }
      mono[i] = acc / channels;
    }
  } else if (audioFormat === 1 && bitsPerSample === 24) {
    for (let i = 0; i < frameCount; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) {
        const o = dataOffset + (i * channels + c) * 3;
        const b0 = view.getUint8(o), b1 = view.getUint8(o + 1), b2 = view.getInt8(o + 2);
        acc += ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      }
      mono[i] = acc / channels;
    }
  } else if (audioFormat === 1 && bitsPerSample === 32) {
    for (let i = 0; i < frameCount; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) {
        acc += view.getInt32(dataOffset + (i * channels + c) * 4, true) / 2147483648;
      }
      mono[i] = acc / channels;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i < frameCount; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) {
        acc += view.getFloat32(dataOffset + (i * channels + c) * 4, true);
      }
      mono[i] = acc / channels;
    }
  } else {
    // Unsupported PCM variant (e.g. extensible WAVEFORMATEX, A-law,
    // µ-law). Bail so the caller falls back to decodeAudioData.
    return null;
  }

  return { samples: mono, sampleRate };
}

/** Validate + decode an uploaded audio file (any format the browser's
 *  decodeAudioData accepts — wav, mp3, m4a/aac, ogg, flac, opus, weba).
 *  WAV files go through a manual parser first because Chrome's
 *  decodeAudioData silently rejects 8-bit unsigned PCM on some builds;
 *  we cover the full uncompressed-WAV matrix (8/16/24/32-bit int +
 *  32-bit float) ourselves and fall back to decodeAudioData for
 *  compressed formats (mp3, ogg, flac, opus, m4a) + the rare WAV
 *  variants we don't parse (extensible WAVEFORMATEX, A-law, µ-law).
 *
 *  Decoupled from the card so unit tests can exercise the rejection
 *  path without a DOM. Pass an AudioContext that supports
 *  decodeAudioData (a real one or an OfflineAudioContext) — the
 *  function signs the contract; we don't mock the decoder.
 *
 *  After decode this function downsamples to SAMSLOOP_TARGET_SAMPLE_RATE
 *  (24 kHz) if the decoder's native rate is higher. */
export async function loadSamsloopWav(
  file: { size: number; arrayBuffer(): Promise<ArrayBuffer> },
  ctx: BaseAudioContext,
): Promise<SamsloopLoadResult> {
  if (file.size > SAMSLOOP_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `File too large: ${(file.size / 1024).toFixed(1)} KB exceeds the ${
        SAMSLOOP_MAX_FILE_BYTES / 1024
      } KB limit.`,
    };
  }
  const ab = await file.arrayBuffer();

  // Try the manual WAV parser first — it handles 8-bit PCM that Chrome
  // sometimes rejects. parseWavManually returns null for non-WAV bytes
  // or unsupported WAV variants; we fall through to decodeAudioData.
  const manual = parseWavManually(ab);
  if (manual) {
    return finalizeSamsloopBuffer(manual.samples, manual.sampleRate);
  }

  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(ab.slice(0));
  } catch (err) {
    return {
      ok: false,
      error: `Could not decode audio: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Mono-mix if stereo. The worklet plays one channel; stereo modules
  // downstream (StereoVCA, mixmstrs) handle widening.
  const len = buf.length;
  const channels = buf.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i]! += ch[i]! / channels;
  }
  return finalizeSamsloopBuffer(mono, buf.sampleRate);
}

/** Apply the integer-factor downsample to SAMSLOOP_TARGET_SAMPLE_RATE +
 *  the decoded-buffer cap. Shared by both the manual WAV path and the
 *  decodeAudioData path. */
function finalizeSamsloopBuffer(
  mono: Float32Array,
  sampleRate: number,
): SamsloopLoadResult {
  let outSamples: Float32Array<ArrayBuffer> = mono as Float32Array<ArrayBuffer>;
  let outRate = sampleRate;
  if (sampleRate > SAMSLOOP_TARGET_SAMPLE_RATE) {
    const factor = Math.floor(sampleRate / SAMSLOOP_TARGET_SAMPLE_RATE);
    if (factor >= 2) {
      outSamples = samsloopDownsample(mono, factor) as Float32Array<ArrayBuffer>;
      outRate = sampleRate / factor;
    }
  }
  if (outSamples.length > SAMSLOOP_MAX_DECODED_SAMPLES) {
    return {
      ok: false,
      error: `Decoded buffer too large: ${outSamples.length} samples exceeds the ${
        SAMSLOOP_MAX_DECODED_SAMPLES
      }-sample cap (~${(SAMSLOOP_MAX_DECODED_SAMPLES / SAMSLOOP_TARGET_SAMPLE_RATE).toFixed(1)} s at ${
        SAMSLOOP_TARGET_SAMPLE_RATE / 1000
      } kHz).`,
    };
  }
  return { ok: true, samples: outSamples, sampleRate: outRate };
}

/** Slider position semantics — exported so the card AND the unit tests
 *  share one source of truth. See the comment block at the top of the
 *  file for the convention. */
export const SAMSLOOP_RATE_RANGE = { min: -2, max: 2, defaultValue: 1 } as const;

// ---------- mic-record state machine ----------
//
// The card owns the actual MediaStream + AudioContext nodes; this
// machine is the pure-logic core driving it. Three states:
//   'idle'      → not recording, ready to start.
//   'recording' → live capture in progress; samples accumulating.
//   'stopped'   → recording just ended, sample is loaded into the
//                  node and the machine is back at idle on next start.
//
// Errors (mic permission denied, no device, AudioContext not ready) are
// surfaced via `error: string | null` rather than thrown — the card
// renders them inline next to the REC button, matching the upload error
// surface. The card guarantees that REC and file-upload are mutually
// exclusive: when one is in-flight the other is disabled.

export type SamsloopRecState = 'idle' | 'recording' | 'stopped';

export interface SamsloopRecMachine {
  state: SamsloopRecState;
  /** Recorded samples so far. Empty until `start()` is called, populated
   *  during 'recording', frozen at the same length when 'stopped'. */
  samples: Float32Array;
  /** Sample-rate the recording was captured at. Comes from the
   *  AudioContext driving the mic-tap node. */
  sampleRate: number;
  /** Most recent inline error message, or null. Set on permission-denied
   *  / no-device / bad-state transitions. */
  error: string | null;
  /** Reason the most recent recording terminated, or null while idle/
   *  active. 'user' = user clicked stop; 'cap' = auto-stop triggered by
   *  reaching SAMSLOOP_MAX_SAMPLES. */
  stopReason: 'user' | 'cap' | null;
}

/** Initial state — fresh idle machine with no samples and no error. */
export function createSamsloopRecMachine(sampleRate = 22050): SamsloopRecMachine {
  return {
    state: 'idle',
    samples: new Float32Array(0),
    sampleRate,
    error: null,
    stopReason: null,
  };
}

/**
 * Transition: begin recording. Resets the sample buffer (the one-sample
 * invariant — start always discards the previous take). Only valid from
 * 'idle' or 'stopped'; calling while 'recording' is a no-op (idempotent
 * UI clicks shouldn't drop the in-flight capture).
 *
 * Pure: returns a NEW machine; does not mutate the input.
 */
export function samsloopRecStart(m: SamsloopRecMachine, sampleRate: number): SamsloopRecMachine {
  if (m.state === 'recording') return m;
  return {
    state: 'recording',
    samples: new Float32Array(0),
    sampleRate,
    error: null,
    stopReason: null,
  };
}

/**
 * Append a chunk of mono Float32 samples to the in-progress recording.
 * If the new total would exceed SAMSLOOP_MAX_SAMPLES the chunk is
 * truncated, the machine auto-transitions to 'stopped' with
 * stopReason='cap', and the caller is expected to surface the
 * "max length reached" UI message. Called from a MediaStream tap (an
 * AudioWorkletNode or ScriptProcessor in the card).
 *
 * Returns a new machine. Allocates a new Float32Array each call so
 * downstream consumers can rely on identity changes for reactivity.
 */
export function samsloopRecAppend(m: SamsloopRecMachine, chunk: Float32Array): SamsloopRecMachine {
  if (m.state !== 'recording') return m;
  const remaining = SAMSLOOP_MAX_SAMPLES - m.samples.length;
  if (remaining <= 0) {
    // Already at cap — flip to stopped without altering samples.
    return { ...m, state: 'stopped', stopReason: 'cap' };
  }
  const take = Math.min(remaining, chunk.length);
  const next = new Float32Array(m.samples.length + take);
  next.set(m.samples, 0);
  next.set(chunk.subarray(0, take), m.samples.length);
  if (next.length >= SAMSLOOP_MAX_SAMPLES) {
    return { ...m, samples: next, state: 'stopped', stopReason: 'cap' };
  }
  return { ...m, samples: next };
}

/** Transition: stop recording on user request. No-op when already
 *  stopped or idle (idempotent). */
export function samsloopRecStop(m: SamsloopRecMachine): SamsloopRecMachine {
  if (m.state !== 'recording') return m;
  return { ...m, state: 'stopped', stopReason: 'user' };
}

/** Transition: mic permission error / no device / context not ready.
 *  Drops back to idle with the error string set; the card renders it
 *  inline. NOT a thrown exception — error surfacing is the caller's
 *  job (we don't want a permission-denied to propagate uncaught). */
export function samsloopRecFail(m: SamsloopRecMachine, error: string): SamsloopRecMachine {
  return {
    state: 'idle',
    samples: new Float32Array(0),
    sampleRate: m.sampleRate,
    error,
    stopReason: null,
  };
}

/** Pure-math helpers — call site is unit tests + the card. Mirrors the
 *  worklet's playback logic (cursor with linear interpolation, wrap on
 *  loop, silence on one-shot exit). Keep in sync with the worklet at
 *  packages/dsp/src/samsloop.ts. */
export const samsloopMath = {
  /** Convert the slider value to a playback rate. Slider center = 1.0
   *  forward; full left = −2 (reverse 2×); full right = +2 (forward 2×).
   *  CV is added on top by the worklet's a-rate `rate` AudioParam, not
   *  here — this is just the slider mapping for tests and labels. */
  sliderToRate(sliderValue: number): number {
    if (!Number.isFinite(sliderValue)) return 1;
    return Math.max(SAMSLOOP_RATE_RANGE.min, Math.min(SAMSLOOP_RATE_RANGE.max, sliderValue));
  },

  /** Clamp start/end indices to a valid window inside `[0, len]`. Caller
   *  passes raw slider-derived values; we enforce start < end and both
   *  inside the buffer. Returns the clamped pair. */
  clampWindow(startRaw: number, endRaw: number, len: number): { start: number; end: number } {
    if (len <= 1) return { start: 0, end: Math.max(1, len) };
    let s = Math.max(0, Math.min(len - 1, Math.floor(startRaw)));
    let e = Math.max(s + 1, Math.min(len, Math.floor(endRaw)));
    return { start: s, end: e };
  },

  /** Render `n` output samples for a given buffer + rate + window + mode.
   *  Used by unit tests to verify forward / reverse / loop / one-shot
   *  semantics without spinning up a real AudioContext. */
  render(
    buf: Float32Array,
    n: number,
    rate: number,
    start: number,
    end: number,
    mode: 'loop' | 'one-shot',
  ): { out: Float32Array; finalCursor: number; active: boolean } {
    const out = new Float32Array(n);
    if (buf.length === 0) return { out, finalCursor: 0, active: false };
    const { start: s, end: e } = samsloopMath.clampWindow(start, end, buf.length);
    let cursor = rate >= 0 ? s : e - 1;
    let active = true;
    for (let i = 0; i < n; i++) {
      if (!active) { out[i] = 0; continue; }
      const ipos = Math.floor(cursor);
      const f = cursor - ipos;
      if (ipos >= 0 && ipos < buf.length - 1) {
        const a = buf[ipos] ?? 0;
        const b = buf[ipos + 1] ?? 0;
        out[i] = a + (b - a) * f;
      } else if (ipos === buf.length - 1) {
        out[i] = buf[ipos] ?? 0;
      } else {
        out[i] = 0;
      }
      cursor += rate;
      if (cursor >= e) {
        if (mode === 'loop') {
          const winLen = e - s;
          cursor = s + ((cursor - s) % winLen);
        } else {
          cursor = e;
          active = false;
        }
      } else if (cursor < s) {
        if (mode === 'loop') {
          const winLen = e - s;
          const overshoot = s - cursor;
          cursor = e - (overshoot % winLen);
        } else {
          cursor = s;
          active = false;
        }
      }
    }
    return { out, finalCursor: cursor, active };
  },
};

const POLL_MS = 200;

export const samsloopDef: AudioModuleDef = {
  type: 'samsloop',
  domain: 'audio',
  label: 'SAMSLOOP',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    { id: 'trig',    type: 'gate' },
    { id: 'rate_cv', type: 'cv', paramTarget: 'rate', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],
  params: [
    // Slider value: ±2 maps to ±2× playback. Default = 1 (forward unity).
    // The CV sums into the AudioParam through the linear cvScale, so a
    // ±1V LFO swings the rate by ±1 unit on top of the slider value.
    { id: 'rate',  label: 'Rate',
      defaultValue: SAMSLOOP_RATE_RANGE.defaultValue,
      min: SAMSLOOP_RATE_RANGE.min, max: SAMSLOOP_RATE_RANGE.max,
      curve: 'linear' },
    { id: 'mode',  label: 'Mode',
      defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    // Start/end ranges are dynamically clamped client-side to the loaded
    // sample length; the param's declared max is a generous ceiling so
    // the slider doesn't need to be re-bounded on every upload.
    { id: 'start', label: 'Start', defaultValue: 0,    min: 0, max: 1e6, curve: 'linear' },
    { id: 'end',   label: 'End',   defaultValue: 1e6,  min: 0, max: 1e6, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 1 input slot for the trig gate; rate CV rides into the AudioParam
    // through the engine's cvScale routing (same pattern as macrooscillator).
    const workletNode = new AudioWorkletNode(ctx, 'samsloop', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of samsloopDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Send the initial sample (if present in node.data — typically not on
    // first spawn, but rehydrated from a saved patch envelope or multiplayer
    // join). Poll-on-data-change: when the card's upload handler mutates
    // node.data, the loop picks it up within POLL_MS and reposts to the
    // worklet.
    let lastSignature: string | null = null;
    function pushSampleIfChanged(): void {
      const live = livePatch.nodes[node.id];
      const d = live?.data as SamsloopData | undefined;
      const samples = d?.samples;
      const sig = samples ? `${samples.length}:${d?.fileName ?? ''}` : 'empty';
      if (sig === lastSignature) return;
      lastSignature = sig;
      if (!samples || samples.length === 0) return;
      // Transfer the underlying buffer to the worklet (zero-copy when the
      // browser supports transferables — falls back to structuredClone
      // otherwise). Pass the buffer's captured sampleRate so the worklet
      // can scale the cursor — rate=1.0 must play at the sample's natural
      // pitch even when the AudioContext runs at a different rate.
      const f32 = new Float32Array(samples);
      workletNode.port.postMessage(
        { type: 'loadSample', samples: f32.buffer, sampleRate: d?.sampleRate },
        [f32.buffer],
      );
    }
    pushSampleIfChanged();

    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function poll(): void {
      if (!alive) return;
      pushSampleIfChanged();
      pollTimer = setTimeout(poll, POLL_MS);
    }
    pollTimer = setTimeout(poll, POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['trig',    { node: workletNode, input: 0 }],
        ['rate_cv', { node: workletNode, input: 0, param: params.get('rate')! }],
      ]),
      outputs: new Map([
        ['out', { node: workletNode, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'sampleLength') {
          const live = livePatch.nodes[node.id];
          return (live?.data as SamsloopData | undefined)?.sampleLength ?? 0;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
