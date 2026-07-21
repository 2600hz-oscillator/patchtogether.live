// packages/web/src/lib/audio/modules/samsloop.ts
//
// SAMSLOOP — loop-based sample player. User uploads an audio file
// (≤2 MB) — anything the browser's AudioContext.decodeAudioData accepts:
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
// IDLE-BY-DEFAULT (no autoplay): after a sample loads SAMSLOOP sits SILENT
// — it does NOT auto-play. A TRIGGER starts playback and is MODE-AWARE:
//   - one-shot mode (mode=0): a trigger plays the sample through ONCE, then
//     returns to idle/silent.
//   - loop mode (mode=1): a trigger STARTS looping and keeps looping; a
//     re-trigger restarts the loop from the window edge.
// The trigger comes from BOTH the `trig` gate input (a rising edge) AND the
// on-card TRIGGER button (a `{ type: 'trigger' }` port message — works
// whether or not a cable is patched into `trig`). The `playing` state is
// worklet-private and is NOT persisted: a loaded patch hydrates the sample
// but stays idle until the user (or a patched gate) triggers it.
//
// I/O surface:
//   inputs:
//     trig      Gate. A rising edge STARTS playback per the current mode
//               (one-shot = play once; loop = start/restart the loop) from
//               the window edge (start for forward playback, end-1 for
//               reverse).
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
// Data shape on node.data (file-upload path):
//   fileBytesB64: string       // base64-encoded ORIGINAL file bytes
//                              // (wav/mp3/m4a/...). The single opaque
//                              // Yjs value persisted for an upload —
//                              // mirrors the recording-path trick
//                              // (`sample.bytesB64`). The decoded
//                              // Float32 buffer is NEVER persisted: it's
//                              // produced lazily on hydrate inside the
//                              // engine factory.
//   fileSize: number           // bytes pre-base64 (display + cap check).
//   fileMime?: string          // original mime type (download fidelity).
//   sampleRate: number         // post-decode rate of the buffer pushed
//                              // to the worklet. Used by the card to
//                              // size start/end faders.
//   sampleLength: number       // post-decode sample count, cached for
//                              // the same reason.
//   fileName?: string          // for display + download filename.
//
// Legacy field (read-only, no longer written):
//   samples?: number[]         // pre-PR-#XXX patches stored the decoded
//                              // PCM directly as a YArray. The engine
//                              // factory still reads this so old patches
//                              // hydrate; new uploads write fileBytesB64
//                              // instead.
//
// Hard limit: 2 MB on the raw upload file. Larger files are rejected.
// (Compressed formats at 2 MB decode to roughly a minute of audio at
// typical bitrates, which is the intended scope for a sample looper. The
// decoded-buffer backstop SAMSLOOP_MAX_DECODED_SAMPLES still caps the
// in-memory PCM regardless of how a small source file decodes.)
//
// Inputs:
//   trig (gate): rising edge STARTS playback per the current mode (one-shot
//                = play once; loop = start/restart the loop) from `start`.
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
import tapWorkletUrl from '@patchtogether.live/dsp/dist/samsloop-tap.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Hard size cap on the uploaded audio file. 2 MB — see card UI.
 *  This is the RAW file-size gate (cheap reject before we touch the
 *  decoder). The decoded-buffer gate (SAMSLOOP_MAX_DECODED_SAMPLES)
 *  fires AFTER decode + downsample to catch the case where a small
 *  source file decodes to a large in-memory buffer (8-bit 16 kHz WAV
 *  upsampled to 48 kHz Float32 = 12× memory expansion) — so even at the
 *  raised 2 MB file cap the in-memory PCM stays bounded by the 1.5M-sample
 *  decoded backstop. Collab cost: a 2 MB upload persists as ~2.7 MB of
 *  base64 in node.data, synced through the single-process relay as one
 *  opaque Yjs value (see lib/multiplayer/samsloop-limits.ts). */
export const SAMSLOOP_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Maximum recorded PCM length in samples. Derived from the file-upload
 *  byte cap divided by sizeof(Float32) so it scales with the cap, but the
 *  mic-record path is independently bounded by the much tighter
 *  SAMSLOOP_RECORD_BUDGET_BYTES (see samsloop-record.ts) — recordings stay
 *  short regardless of this ceiling. The record machine enforces its cap by
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

/** Hard cap on stored decoded samples. Sized to accommodate the bulk of
 *  realistic short-MP3 loads while staying inside browser-memory limits.
 *
 *  At the target 24 kHz mono rate:
 *    1_500_000 samples ≈ 62.5 seconds
 *  At 48 kHz native (e.g. if the source was already <= 24 kHz, no
 *  downsample applied):
 *    1_500_000 samples ≈ 31 seconds
 *
 *  Why this is safe even though a 1.5M-sample number[] would obliterate
 *  the syncedstore CRDT: we no longer PERSIST the decoded sample as a
 *  YArray. Uploads round-trip as base64'd ORIGINAL file bytes
 *  (`SamsloopData.fileBytesB64`, ~250 KB-bounded by the file-byte gate)
 *  and the engine factory decodes them lazily on hydrate into a
 *  worklet-owned Float32 buffer. The decoded buffer never touches Yjs,
 *  so its size is bounded only by browser memory + this cap — not by
 *  the CRDT-wrap overhead that pinned the old 144_000 ceiling.
 *
 *  This cap still gates the decode step itself: a contrived file that
 *  decodes to many millions of samples (e.g. a long FLAC) would lock up
 *  the main thread when copied + downsampled, regardless of CRDT
 *  storage. 1.5M is the largest size we're willing to do that work for
 *  in a single shot on the main thread. */
export const SAMSLOOP_MAX_DECODED_SAMPLES = 1_500_000;

export interface SamsloopData {
  /** LEGACY field, read-only on new code paths. Pre-PR-#XXX patches
   *  stored the decoded PCM directly as a YArray; the engine factory
   *  still hydrates this if present, but new uploads write to
   *  `fileBytesB64` below instead. See the file's header comment for
   *  the rationale (CRDT-bloat at the new 1.5M-sample cap). */
  samples?: number[];
  /** Base64-encoded ORIGINAL upload bytes (wav/mp3/m4a/ogg/flac/opus).
   *  The decoded Float32 buffer is never persisted — it's regenerated
   *  on hydrate inside the engine factory. Bounded by
   *  SAMSLOOP_MAX_FILE_BYTES (2 MB raw, ~2.7 MB base64). */
  fileBytesB64?: string;
  /** Raw byte length pre-base64. Cached for cap checks + the card's
   *  "loaded N kB" status line. */
  fileSize?: number;
  /** Original file's mime type, captured at upload. Used for the
   *  DOWNLOAD button so the export round-trips losslessly (mp3 stays
   *  mp3, wav stays wav). Optional because the browser doesn't always
   *  give us one. */
  fileMime?: string;
  sampleRate?: number;
  sampleLength?: number;
  fileName?: string;
  /** Multiplayer attribution — set by Canvas's spawnFromPalette when a
   *  real userId is available. Powers the per-user cap; unattributed
   *  legacy nodes count toward the rackspace cap only. See
   *  lib/multiplayer/samsloop-limits.ts. */
  creatorId?: string;

  /** Recording settings — three discrete toggles on the card (CHAN /
   *  BITS / RATE). Defaults from SAMSLOOP_REC_DEFAULTS. Persisted with
   *  the rest of node.data so a loaded patch remembers the user's
   *  encoding preferences. */
  recRate?: 22050 | 44100;
  recBits?: 8 | 16;
  recChannels?: 1 | 2;

  /** Most-recently-recorded sample (the recording feature, separate from
   *  the file-upload `samples`/`sampleRate` fields above). Same persistence
   *  trick PICTUREBOX uses for `imageBytes`: raw bytes are base64-encoded
   *  and stored as a string so Yjs treats them as one opaque value (NO
   *  per-byte YArray recursion — a 144 kB Array.from(uint8Array) into a
   *  YArray slot blows the stack at insert time, and re-broadcasts a
   *  per-byte update to every peer). Strings are flat values; one Yjs
   *  update per recording, deserialized on every peer via atob().
   *
   *  The byte payload is header-less PCM — interleaved if channels === 2,
   *  little-endian for 16-bit. The WAV header is synthesized only when
   *  the user clicks DOWNLOAD (via makeWavBlob in samsloop-record.ts). */
  sample?: {
    /** base64-encoded raw PCM bytes. Length is bounded by
     *  SAMSLOOP_RECORD_BUDGET_BYTES = 250 000 (raw bytes pre-encode;
     *  the base64 string is ~4/3 of that). */
    bytesB64: string;
    rate: 22050 | 44100;
    bits: 8 | 16;
    channels: 1 | 2;
    /** Raw byte length pre-base64 (useful so the card can show "8 kB"
     *  without decoding to count). */
    byteLength: number;
    /** durationSec = byteLength / (channels * bytesPerSample * rate). */
    durationSec: number;
  };
}

/** Result of attempting to decode + size-check an audio upload. The card
 *  consumes this — `error` populated means the upload was rejected and
 *  the message is suitable for display.
 *
 *  On success, the result carries BOTH the decoded buffer (for immediate
 *  worklet push) AND the ORIGINAL file bytes (for persistence). The card
 *  pushes the decoded buffer into the engine handle, then writes only
 *  the bytes + small metadata into node.data — see the file header
 *  comment for the no-decoded-in-Yjs invariant. */
export interface SamsloopLoadResult {
  ok: boolean;
  error?: string;
  samples?: Float32Array;
  sampleRate?: number;
  /** Original file bytes (unmodified). Populated on success so the
   *  card can persist them via base64 instead of the decoded PCM. */
  fileBytes?: Uint8Array;
  /** Original file size in bytes. Same as fileBytes.byteLength but
   *  exposed separately for symmetry with the file-input metadata. */
  fileSize?: number;
  /** Original mime type (e.g. "audio/mpeg"). May be empty on some
   *  browser/file combos — surfaced as-is. */
  fileMime?: string;
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
  file: { size: number; type?: string; arrayBuffer(): Promise<ArrayBuffer> },
  ctx: BaseAudioContext,
): Promise<SamsloopLoadResult> {
  if (file.size > SAMSLOOP_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `File too large: ${(file.size / (1024 * 1024)).toFixed(2)} MB exceeds the ${
        SAMSLOOP_MAX_FILE_BYTES / (1024 * 1024)
      } MB limit.`,
    };
  }
  const ab = await file.arrayBuffer();
  // Snapshot the original bytes for persistence. We do this BEFORE the
  // decoders run because decodeAudioData consumes (neuters) the
  // ArrayBuffer on some browsers; the manual WAV parser is read-only but
  // we keep the same path for symmetry. `new Uint8Array(ab)` aliases
  // — fine here because we never mutate it.
  const fileBytes = new Uint8Array(ab.slice(0));
  const fileMime = typeof file.type === 'string' ? file.type : '';

  // Try the manual WAV parser first — it handles 8-bit PCM that Chrome
  // sometimes rejects. parseWavManually returns null for non-WAV bytes
  // or unsupported WAV variants; we fall through to decodeAudioData.
  const manual = parseWavManually(ab);
  if (manual) {
    return finalizeSamsloopBuffer(manual.samples, manual.sampleRate, fileBytes, fileMime);
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
  return finalizeSamsloopBuffer(mono, buf.sampleRate, fileBytes, fileMime);
}

/** Apply the integer-factor downsample to SAMSLOOP_TARGET_SAMPLE_RATE +
 *  the decoded-buffer cap. Shared by both the manual WAV path and the
 *  decodeAudioData path. Threads the original file bytes through so the
 *  caller (the card OR the engine factory's hydrate path) can both push
 *  the decoded buffer AND persist the bytes in one shot. */
function finalizeSamsloopBuffer(
  mono: Float32Array,
  sampleRate: number,
  fileBytes?: Uint8Array,
  fileMime?: string,
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
      }-sample cap (~${(SAMSLOOP_MAX_DECODED_SAMPLES / SAMSLOOP_TARGET_SAMPLE_RATE).toFixed(0)} s at ${
        SAMSLOOP_TARGET_SAMPLE_RATE / 1000
      } kHz mono, ~${(SAMSLOOP_MAX_DECODED_SAMPLES / 48000).toFixed(0)} s at 48 kHz). Try a shorter clip.`,
    };
  }
  return {
    ok: true,
    samples: outSamples,
    sampleRate: outRate,
    fileBytes,
    fileSize: fileBytes?.byteLength,
    fileMime,
  };
}

/** Decode a base64-encoded audio file's bytes into a mono Float32 PCM
 *  buffer + sample rate, applying the same downsample + cap pipeline as
 *  a fresh upload. Used by the engine factory's hydrate path so a
 *  persisted upload (fileBytesB64 stored on node.data) re-decodes into
 *  the worklet on patch load + on multiplayer late-join.
 *
 *  Errors are surfaced as null — the factory has nowhere to render an
 *  error message, and a hydrate-time failure should NOT crash audio.
 *  The card's upload path is the one that surfaces decode errors to
 *  the user. */
export async function samsloopDecodeBytesB64(
  bytesB64: string,
  ctx: BaseAudioContext,
): Promise<SamsloopLoadResult | null> {
  if (!bytesB64 || bytesB64.length === 0) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(bytesB64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  // Wrap as a File-like for loadSamsloopWav. Slice a fresh ArrayBuffer
  // each time since decodeAudioData can neuter it.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const fileLike = {
    size: bytes.byteLength,
    type: '',
    arrayBuffer: async () => ab,
  };
  try {
    return await loadSamsloopWav(fileLike, ctx);
  } catch {
    return null;
  }
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
 *  loop, silence on one-shot exit). `render` models the always-playing
 *  steady state (used by the spectral ART tests); `renderWithTriggers`
 *  models the IDLE-BY-DEFAULT play-state machine (no autoplay until a trig
 *  edge / manual TRIGGER, mode-aware stop). Keep both in sync with the
 *  worklet at packages/dsp/src/samsloop.ts. */
export const samsloopMath = {
  /** Convert the slider value to a playback rate. Slider center = 1.0
   *  forward; full left = −2 (reverse 2×); full right = +2 (forward 2×).
   *  CV is added on top by the worklet's a-rate `rate` AudioParam, not
   *  here — this is just the slider mapping for tests and labels. */
  sliderToRate(sliderValue: number): number {
    if (!Number.isFinite(sliderValue)) return 1;
    return Math.max(SAMSLOOP_RATE_RANGE.min, Math.min(SAMSLOOP_RATE_RANGE.max, sliderValue));
  },

  /**
   * Re-scale saved loop boundaries when the buffer is re-decoded to a DIFFERENT
   * length than it had at save time — the SAMSLOOP boundary-restore bug.
   *
   * Boundaries persist as ABSOLUTE sample indices against the decoded length at
   * save time (`savedLen`). On a perf-zip load on a machine whose AudioContext
   * runs at a different sample rate, a NON-WAV source (mp3/m4a/ogg — anything
   * routed through `decodeAudioData`, which resamples to the live ctx rate)
   * re-decodes to a different `newLen`, so the saved absolute indices point at
   * the WRONG positions (e.g. a 25%..75% window collapses or overruns). WAV
   * sources parse losslessly at their own rate, so `newLen === savedLen` and
   * this is a no-op for them.
   *
   * We map start/end PROPORTIONALLY from the saved length onto the new length so
   * the loop window keeps the same musical placement. Returns null when no
   * rescale is needed (lengths equal / no usable saved length / boundaries are
   * still at their pristine defaults — a full-buffer window, which the worklet's
   * own clamp already handles).
   */
  rescaleBoundaries(
    start: number,
    end: number,
    savedLen: number,
    newLen: number,
  ): { start: number; end: number } | null {
    if (!Number.isFinite(savedLen) || !Number.isFinite(newLen)) return null;
    if (savedLen <= 0 || newLen <= 0) return null;
    if (savedLen === newLen) return null; // same machine / WAV — indices are exact
    // A pristine full-buffer window (start=0, end>=savedLen, or the param default
    // 1e6 ceiling) needs no proportional map — re-anchor end to the new length so
    // the fader bound is right; the worklet clamps anyway.
    const sClamped = Math.max(0, Math.min(savedLen, Math.round(start)));
    const eClamped = Math.max(sClamped, Math.min(savedLen, Math.round(end)));
    if (sClamped === 0 && end >= savedLen) {
      return { start: 0, end: newLen };
    }
    const scale = newLen / savedLen;
    const ns = Math.max(0, Math.min(newLen - 1, Math.round(sClamped * scale)));
    const ne = Math.max(ns + 1, Math.min(newLen, Math.round(eClamped * scale)));
    return { start: ns, end: ne };
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

  /** Render `n` output samples modelling the worklet's IDLE-BY-DEFAULT
   *  play-state machine — the mirror used to test the no-autoplay +
   *  mode-aware-trigger behavior without a real AudioContext.
   *
   *  Starts IDLE (silent). At each sample index present in `trigSamples`
   *  (a set of rising-edge indices — the trig gate AND the manual TRIGGER
   *  button both surface as one of these) playback (re)starts: `playing`
   *  flips true and the cursor resets to the window edge (start forward,
   *  end-1 reverse). While !playing the output is silence. Mode-aware stop:
   *  in one-shot, the cursor running off the window flips playing=false
   *  (and the run goes silent again, exactly like the worklet); in loop it
   *  wraps and stays playing.
   *
   *  Keep in sync with packages/dsp/src/samsloop.ts process(). */
  renderWithTriggers(
    buf: Float32Array,
    n: number,
    rate: number,
    start: number,
    end: number,
    mode: 'loop' | 'one-shot',
    trigSamples: Iterable<number>,
  ): { out: Float32Array; finalCursor: number; playing: boolean } {
    const out = new Float32Array(n);
    if (buf.length === 0) return { out, finalCursor: 0, playing: false };
    const trigs = new Set<number>(trigSamples);
    const { start: s, end: e } = samsloopMath.clampWindow(start, end, buf.length);
    let cursor = rate >= 0 ? s : e - 1;
    let playing = false; // IDLE-BY-DEFAULT: no autoplay.
    for (let i = 0; i < n; i++) {
      // A trigger at this index STARTS / restarts playback from the window
      // edge — checked before emission so the first sample of the burst
      // lands in this same frame (mirrors the worklet's pre-emit edge test).
      if (trigs.has(i)) {
        cursor = rate >= 0 ? s : e - 1;
        playing = true;
      }
      if (!playing) { out[i] = 0; continue; }
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
          playing = false; // one-shot pass complete → idle/silent.
        }
      } else if (cursor < s) {
        if (mode === 'loop') {
          const winLen = e - s;
          const overshoot = s - cursor;
          cursor = e - (overshoot % winLen);
        } else {
          cursor = s;
          playing = false;
        }
      }
    }
    return { out, finalCursor: cursor, playing };
  },
};

const POLL_MS = 200;

export const samsloopDef: AudioModuleDef = {
  type: 'samsloop',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'samsloop',
  category: 'sources',

  // Chain-role (Design-D): SAMSLOOP is genuinely a 'both' module — a looper that
  // PLAYS its captured buffer (source, re-triggered by clips via `trig`) OR
  // RECORDS external audio through its stereo record inputs (insert). This pass
  // DEFAULTS it to 'source' so it is head-eligible AND its `trig` gate receives
  // clip note control (clip triggers playback). As a declared source its audio
  // record inputs are NOT read as a fed chain insert.
  // TODO(both): the "record external audio as an insert" mode needs the
  //   context-dependent 'both' switching described on isChainSource
  //   (patch-convenience.ts) — deferred to keep this pass correct, not half-
  //   working. Owner may flip this to role:'both' + inPorts:['audio_l_in',
  //   'audio_r_in'] once that context threading lands.
  chainWiring: { role: 'source' },

  inputs: [
    { id: 'trig',       type: 'gate' },
    { id: 'rate_cv',    type: 'cv', paramTarget: 'rate', cvScale: { mode: 'linear' } },
    // Stereo record inputs — patched audio is captured + quantized +
    // downsampled into node.data.sample on STOP. `audio_r_in` normalizes
    // to `audio_l_in` when unpatched (same rule as stereovca / cofefve
    // — see the per-input `inputs[i]?.[0] === undefined` test in the
    // tap worklet processor). Mono → stereo record without a second
    // cable.
    { id: 'audio_l_in', type: 'audio' },
    { id: 'audio_r_in', type: 'audio' },
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

  docs: {
    explanation:
      "A single-sample loop player. Load one audio file (drag/drop or the upload button — wav, mp3, m4a/aac, ogg, flac, opus, up to 2 MB) OR record straight from the microphone or a patched audio input; either way the source is decoded into one buffer that the on-card waveform shows. SAMSLOOP holds exactly ONE sample at a time — a new upload or recording REPLACES it (no playlist, no slots). After loading it sits SILENT and waits: it does NOT auto-play. A TRIGGER (a rising edge on the TRIG input, or the on-card TRIGGER button) starts playback, and what 'start' means depends on MODE — in one-shot mode the sample plays through the window once and returns to idle; in loop mode the trigger starts a continuous loop and a re-trigger restarts it from the window edge. Playback uses a fractional read-cursor with linear interpolation, so the RATE control is a full varispeed: positive = forward, negative = REVERSE, |value| = speed (2 = double speed / one octave up, 0.5 = half). The START and END markers crop which slice of the sample plays/loops (draggable on the waveform). The output is mono.",
    inputs: {
      trig:
        "Rising-edge trigger that STARTS playback per the current MODE: in one-shot mode it plays the cropped window through once; in loop mode it starts the loop (and a re-trigger restarts it from the window edge — START for forward, END for reverse). Works alongside the on-card TRIGGER button. While idle (no trigger yet) the module is silent.",
      rate_cv:
        "CV that offsets the RATE param (linear): ±1 V swings the playback rate by ±1 unit on top of the slider, so an LFO here does pitch/speed wobble, tape-stop, or reverse sweeps. The summed rate is clamped to the worklet's [−3, +3] range; crossing zero flips playback direction.",
      audio_l_in:
        "Left audio RECORD input — patch a source here and arm recording to capture it into the sample buffer (replacing whatever was loaded). Mono sources work with just this jack.",
      audio_r_in:
        "Right audio RECORD input — the second channel for a stereo recording (it's mono-mixed into the single buffer on stop). Normalizes to audio_l_in when left unpatched, so a mono source needs only the left jack.",
    },
    outputs: {
      out: "Mono audio output — the played/looped sample at the current RATE (forward or reversed), cropped to the START..END window. Silent until a trigger starts playback.",
    },
    controls: {
      rate:
        "Varispeed playback RATE (−2..+2, default +1 = forward unity). Positive plays forward, negative plays in REVERSE; |value| is the speed (2 = 2× / +1 octave, 0.5 = half / −1 octave). Center (+1) is the no-op unity speed. CV via the rate_cv input (summed, clamped to ±3).",
      mode:
        "Playback MODE: LOOP (1, default) = a trigger starts a continuous loop that keeps going (re-trigger restarts it); ONE-SHOT (0) = a trigger plays the window through once and returns to idle/silent.",
      start:
        "START of the playback window, in sample frames from the buffer's beginning (the left waveform marker). Crops where playback/looping begins (and where reverse playback ends). Auto-clamped to the loaded sample's length.",
      end:
        "END of the playback window, in sample frames (the right waveform marker). Crops where playback/looping ends (and where reverse playback begins). Together START..END select the slice that plays or loops; auto-clamped to the sample length.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      // The tap worklet is loaded once per context too. Two separate
      // worklet modules so the playback worklet's `samsloop` registration
      // doesn't drift each time we touch the recorder.
      await ctx.audioWorklet.addModule(tapWorkletUrl);
      loadedContexts.add(ctx);
    }

    // 1 input slot for the trig gate; rate CV rides into the AudioParam
    // through the engine's cvScale routing (same pattern as macrooscillator).
    const workletNode = new AudioWorkletNode(ctx, 'samsloop', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Recording tap. Two audio inputs (L + R), 1 silent output (Web Audio
    // requires at least one output to keep the node alive in the graph;
    // the tap doesn't drive anything downstream — record-only). Owned by
    // the factory so it can be cleanly disposed; enable/disable is via
    // port message from the card.
    const tapNode = new AudioWorkletNode(ctx, 'samsloop-tap', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // Connect the tap to a muted gain → destination so Web Audio keeps
    // calling process() (a node with no downstream is permitted to be
    // GC'd / paused by some implementations).
    const tapSink = ctx.createGain();
    tapSink.gain.value = 0;
    try { tapNode.connect(tapSink); tapSink.connect(ctx.destination); } catch { /* */ }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of samsloopDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    /** Decode persisted bytes (via the shared samsloopDecodeBytesB64
     *  helper) and push the resulting buffer to the worklet — same
     *  postMessage shape the legacy YArray path uses. Also writes the
     *  derived sampleLength/sampleRate back into node.data so the card's
     *  faders + waveform reactivity pick up the loaded sample without
     *  re-decoding it themselves.
     *
     *  Bails silently on failure: hydrate-time decode errors should NOT
     *  crash audio. The interactive upload path in the card surfaces
     *  errors to the user; this is the headless rehydrate path. */
    async function decodeBytesAndPush(b64: string): Promise<void> {
      const result = await samsloopDecodeBytesB64(b64, ctx);
      if (!result || !result.ok || !result.samples) return;
      const f32 = new Float32Array(result.samples);
      try {
        workletNode.port.postMessage(
          { type: 'loadSample', samples: f32.buffer, sampleRate: result.sampleRate },
          [f32.buffer],
        );
      } catch {
        // postMessage can throw if the node was torn down between the
        // decode promise resolving and the post. Safe to ignore — the
        // dispose path cleared the worklet anyway.
        return;
      }
      // Cache derived metadata so the card knows the sample length even
      // before its own $effect runs. We write defensively — the node
      // may have been removed during the decode.
      try {
        const live = livePatch.nodes[node.id];
        if (!live) return;
        if (!live.data) live.data = {} as never;
        const ld = live.data as SamsloopData;
        const newLen = result.samples.length;
        // BOUNDARY-RESTORE FIX: the saved loop start/end are ABSOLUTE indices
        // against the length the buffer had at SAVE time (ld.sampleLength, just
        // restored from the envelope). When this re-decode yields a DIFFERENT
        // length — a non-WAV source re-decoded on a machine with a different
        // AudioContext rate (decodeAudioData resamples to ctx.sampleRate) — the
        // saved indices point at the wrong samples. Re-scale start/end
        // PROPORTIONALLY onto the new length so the loop window keeps its
        // placement. WAV / same-machine loads have newLen === savedLen → no-op.
        const savedLen = typeof ld.sampleLength === 'number' ? ld.sampleLength : 0;
        if (savedLen > 0 && savedLen !== newLen && live.params) {
          const p = live.params as Record<string, number>;
          const rescaled = samsloopMath.rescaleBoundaries(
            p.start ?? 0,
            p.end ?? newLen,
            savedLen,
            newLen,
          );
          if (rescaled) {
            p.start = rescaled.start;
            p.end = rescaled.end;
            // Re-apply to the worklet immediately (the poll loop only repushes
            // the sample, not start/end — those are set once at factory init).
            params.get('start')?.setValueAtTime(rescaled.start, ctx.currentTime);
            params.get('end')?.setValueAtTime(rescaled.end, ctx.currentTime);
          }
        }
        if (ld.sampleLength !== newLen) {
          ld.sampleLength = newLen;
        }
        if (ld.sampleRate !== result.sampleRate) {
          ld.sampleRate = result.sampleRate;
        }
      } catch {
        // syncedstore writes can throw if the node was deleted; ignore.
      }
    }

    // Send the initial sample (if present in node.data — typically not on
    // first spawn, but rehydrated from a saved patch envelope or multiplayer
    // join). Poll-on-data-change: when the card's upload handler mutates
    // node.data, the loop picks it up within POLL_MS and reposts to the
    // worklet.
    //
    // Two source paths:
    //   - `fileBytesB64` (new path, written by uploads since PR-#XXX):
    //       base64-encoded original file bytes. The factory decodes them
    //       to Float32 via the AudioContext, posts to the worklet, and
    //       — crucially — caches the decoded length back into node.data
    //       (sampleLength / sampleRate) so the card's faders re-bound
    //       without us re-decoding on every render. Decode is async; we
    //       guard against re-entrancy with `decodeInFlight`.
    //   - `samples` (legacy path, pre-PR-#XXX patches): plain number[]
    //       stored in Yjs as a YArray. Kept read-only for back-compat;
    //       old patches still hydrate without any migration step.
    let lastSignature: string | null = null;
    let decodeInFlight = false;
    function pushSampleIfChanged(): void {
      const live = livePatch.nodes[node.id];
      const d = live?.data as SamsloopData | undefined;
      // New path takes precedence: if the user re-uploaded since this
      // node hydrated, fileBytesB64 is the source of truth.
      if (d?.fileBytesB64 && typeof d.fileBytesB64 === 'string' && d.fileBytesB64.length > 0) {
        const sig = `bytes:${d.fileSize ?? d.fileBytesB64.length}:${d.fileName ?? ''}`;
        if (sig === lastSignature) return;
        if (decodeInFlight) return;
        lastSignature = sig;
        decodeInFlight = true;
        const b64 = d.fileBytesB64;
        decodeBytesAndPush(b64).finally(() => {
          decodeInFlight = false;
        });
        return;
      }
      // Legacy path: pre-PR-#XXX patches with the decoded YArray.
      const samples = d?.samples;
      const sig = samples ? `legacy:${samples.length}:${d?.fileName ?? ''}` : 'empty';
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
        ['trig',       { node: workletNode, input: 0 }],
        ['rate_cv',    { node: workletNode, input: 0, param: params.get('rate')! }],
        // Record-tap audio inputs. These wire user-patched audio into the
        // samsloop-tap worklet, which forwards captured L/R blocks to the
        // card via the tap port (subscribed via the handle's read('recTap')
        // surface). Independent of the playback worklet — recording one
        // sample and playing another back is fine.
        ['audio_l_in', { node: tapNode, input: 0 }],
        ['audio_r_in', { node: tapNode, input: 1 }],
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
        // Manual TRIGGER (the on-card button). Returns a function that posts
        // a `{ type: 'trigger' }` message to the playback worklet — the same
        // effect as a `trig` gate rising edge, so it STARTS playback per the
        // current mode and works whether or not a cable is patched into the
        // `trig` input. Idle-by-default means nothing plays until this (or a
        // gate edge) fires; the play-state is worklet-private and never
        // persisted, so a patch load stays silent.
        if (key === 'manualTrigger') {
          return () => {
            try { workletNode.port.postMessage({ type: 'trigger' }); } catch { /* */ }
          };
        }
        // Expose the tap's MessagePort + a helper to enable/disable it.
        // The card subscribes to the port's onmessage to receive captured
        // L/R chunks during a recording. The two are surfaced together
        // under one key so the card grabs them atomically (no race
        // between "I subscribed" and "I enabled" — the card enables
        // AFTER attaching its onmessage).
        if (key === 'recTap') {
          return {
            port: tapNode.port,
            setEnabled: (enabled: boolean) => {
              try { tapNode.port.postMessage({ type: 'enable', enabled }); } catch { /* */ }
            },
            /** The AudioContext's native sample rate — the rate at which
             *  the tap captures. The card uses this as `srcRate` when it
             *  calls `encodeRecordingBytes` on STOP. */
            sampleRate: ctx.sampleRate,
          };
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { workletNode.disconnect(); } catch { /* */ }
        try { tapNode.port.postMessage({ type: 'enable', enabled: false }); } catch { /* */ }
        try { tapNode.disconnect(); } catch { /* */ }
        try { tapSink.disconnect(); } catch { /* */ }
      },
    };
  },
};
