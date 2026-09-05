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
// Data shape on node.data (RECORD path):
//   sample: { bytesB64, rate, bits, channels, byteLength, durationSec,
//             recordedAt }     // header-less PCM as ONE base64 string.
//                              // Decoded to Float32 by decodeRecordedPcm
//                              // (samsloop-record.ts) and pushed to the same
//                              // worklet the upload path feeds.
//
// Legacy field (read-only, no longer written):
//   samples?: number[]         // pre-PR-#XXX patches stored the decoded
//                              // PCM directly as a YArray. The engine
//                              // factory still reads this so old patches
//                              // hydrate; new uploads write fileBytesB64
//                              // instead.
//
// THE ONE-SAMPLE INVARIANT, IN THE DATA. The upload keys and `sample` are
// MUTUALLY EXCLUSIVE: committing a recording deletes fileBytesB64/samples and
// the upload metadata, and an upload deletes `sample`. That is the data-level
// expression of the "one instance, one buffer" rule above, and it is what
// makes `resolveSamsloopSource`'s precedence unobservable on anything written
// after 2026-08-02. Racks saved BEFORE then can hold both — see that function
// for exactly which one wins and why it is the upload.
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
//   start (linear 0..1 FRACTION of the sample, default 0): window start.
//   end (linear 0..1 FRACTION of the sample, default 1): window end.
//   poly (discrete 0..1, default 0): 0 = mono (re-trigger restarts), 1 = poly.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamLandmark, ParamOption } from '$lib/graph/types';
import {
  decodeRecordedPcm,
  type SamsloopRecordedSample,
  type SamsloopRecRate,
  type SamsloopRecBits,
  type SamsloopRecChannels,
} from '$lib/audio/modules/samsloop-record';
import { patch as livePatch } from '$lib/graph/store';
import { MAX_POLY_VOICES } from '$lib/audio/modules/midi-lane';
import workletUrl from '@patchtogether.live/dsp/dist/samsloop.js?url';
import tapWorkletUrl from '@patchtogether.live/dsp/dist/samsloop-tap.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
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
  recRate?: SamsloopRecRate;
  recBits?: SamsloopRecBits;
  recChannels?: SamsloopRecChannels;

  /** Most-recently-recorded sample (the RECORD path; the file-upload path
   *  writes `fileBytesB64` above). Same persistence trick PICTUREBOX uses for
   *  `imageBytes`: raw bytes are base64-encoded and stored as a string so Yjs
   *  treats them as one opaque value (NO per-byte YArray recursion — a 144 kB
   *  Array.from(uint8Array) into a YArray slot blows the stack at insert time,
   *  and re-broadcasts a per-byte update to every peer). Strings are flat
   *  values; one Yjs update per recording, decoded on every peer via atob().
   *
   *  The byte payload is header-less PCM — interleaved if channels === 2,
   *  little-endian for 16-bit. The WAV header is synthesized only when the
   *  user clicks DOWNLOAD (makeWavBlob); PLAYBACK decodes it via
   *  `decodeRecordedPcm`, and `resolveSamsloopSource` below is the ONE place
   *  that decides whether this or an upload is the live buffer.
   *
   *  ⚠ ONE-SAMPLE INVARIANT (file header): this key and `fileBytesB64` /
   *  `samples` are MUTUALLY EXCLUSIVE on anything written after the 2026-08-02
   *  fix — committing a recording deletes the upload keys and vice versa.
   *  Racks saved BEFORE that fix can carry both; see `resolveSamsloopSource`
   *  for exactly what happens to them. */
  sample?: SamsloopRecordedSample;
}

/**
 * WHERE THE LIVE BUFFER COMES FROM — the ONE answer both the engine factory
 * and the card read, as a pure function of `node.data`.
 *
 * ⚠ THIS FUNCTION IS THE P0 FIX. It used to be an inline if/else inside the
 * factory's `pushSampleIfChanged` that knew about `fileBytesB64` and `samples`
 * and **had never heard of `sample`** — the key the record path writes. So a
 * recording persisted, redrew, round-tripped through save/load and downloaded
 * as a correct WAV, and **the module stayed silent**. Making the resolution a
 * named pure function is what lets a unit test assert "the record path's write
 * resolves to a playable source" without an AudioContext — which is the test
 * whose absence let this ship.
 *
 * PRECEDENCE, and why it is this order. It is the order that was ALREADY LIVE
 * for uploads, kept deliberately: any rack that makes sound today makes the
 * same sound after this fix, and only racks that were silent change. Going
 * forward the question cannot arise — each write path deletes the other's keys
 * (the module's one-sample invariant), so at most one branch can match.
 *
 *   1. `fileBytesB64` — an upload. What the factory has always played.
 *   2. `samples`      — the legacy pre-base64 YArray upload. Ditto.
 *   3. `sample`       — a recording. NEW: previously unreachable.
 *
 * A rack saved before the fix that holds BOTH (upload, then record) therefore
 * keeps playing its upload rather than silently swapping to the recording, and
 * the recording is one REC press (or one DOWNLOAD) away — nothing is lost. A
 * rack that holds ONLY a recording — the silent case, the bug — starts playing
 * it on the next load with no migration step and no user action.
 *
 * The `signature` is what the factory's poll loop compares to decide whether to
 * re-push; it must change whenever the BYTES change. Pure.
 */
export type SamsloopSource =
  | { kind: 'file';   signature: string; b64: string }
  | { kind: 'legacy'; signature: string; samples: readonly number[]; sampleRate?: number }
  | { kind: 'record'; signature: string; sample: SamsloopRecordedSample }
  | null;

export function resolveSamsloopSource(d: SamsloopData | undefined): SamsloopSource {
  if (d?.fileBytesB64 && typeof d.fileBytesB64 === 'string' && d.fileBytesB64.length > 0) {
    return {
      kind: 'file',
      signature: `bytes:${d.fileSize ?? d.fileBytesB64.length}:${d.fileName ?? ''}`,
      b64: d.fileBytesB64,
    };
  }
  if (d?.samples && d.samples.length > 0) {
    return {
      kind: 'legacy',
      signature: `legacy:${d.samples.length}:${d.fileName ?? ''}`,
      samples: d.samples,
      sampleRate: d.sampleRate,
    };
  }
  const s = d?.sample;
  if (s && typeof s.bytesB64 === 'string' && s.bytesB64.length > 0 && s.byteLength > 0) {
    // `recordedAt` is what makes this EXACT — every other field repeats across
    // two takes of the same length at unchanged settings, so without it a
    // re-record would alias the previous signature and the worklet would keep
    // playing the first take. Legacy recordings have no stamp and fall back to
    // the shape-only signature.
    return {
      kind: 'record',
      signature:
        `record:${s.recordedAt ?? 0}:${s.byteLength}:${s.rate}:${s.bits}:${s.channels}`,
      sample: s,
    };
  }
  return null;
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

/**
 * THE LOOP WINDOW IS A FRACTION OF THE SAMPLE, NOT A FRAME INDEX.
 *
 * ⚠ THIS REPLACED A FRAME-INDEXED WINDOW, AND THE OLD ONE CARRIED A LIVE BUG.
 * `start`/`end` used to be frame counts declared `0..1e6`, which is **20.8 s at
 * 48 kHz** — while this module records to a documented 60 s (31.25 s at the
 * default settings, where the byte budget binds). A param write is clamped to
 * its ParamDef range, so END COULD NOT REACH THE TAIL of any recording past
 * ~20.8 s, on either surface. The card passed `max={sampleLength}` and the
 * model silently clamped it: the backdraft class, shipping.
 *
 * ⚠ AND THE FRACTION IS NOT MERELY A RESCALE — IT DELETES A BUG CLASS. A frame
 * index is only meaningful against the length the buffer had when it was
 * SAVED, so a non-WAV source re-decoded at a different AudioContext rate
 * (`decodeAudioData` resamples) pointed the saved window at the wrong samples.
 * That is what `samsloopMath.rescaleBoundaries` existed to repair — and it is
 * DELETED with this change rather than adapted, because a FRACTION is
 * length-invariant by construction and the mismatch cannot arise at all.
 *
 * ⚠ IT IS ALSO WHAT MAKES THE CV PORTS HONEST. `cvScale.depth: 1` means "full
 * natural-range sweep", and the natural range of a fraction IS the whole
 * sample — for every sample, at every length. Against frames it meant 1e6 of
 * them, which is neither the sample nor reachable.
 */
export const SAMSLOOP_WINDOW_RANGE = { min: 0, max: 1 } as const;

/**
 * The RATE fader's named waypoints, in PARAM UNITS.
 *
 * ⚠ PARAM UNITS, NOT KNOB POSITIONS, and the distinction is the whole reason
 * this is declarable at all. `ParamLandmark` is `{ value, label }` with NO
 * position field: a landmark's PLACEMENT is derived by whatever cell draws it.
 * The warped-fader cell puts each one at `toKnob(value)`, so the non-uniform
 * spacing a player sees — unity at the MIDPOINT rather than three-quarters
 * along — falls out of the module's own piecewise map instead of being typed
 * here. Declaring these as fractions would hard-code the current map's geometry
 * and silently stop matching it the day the map is corrected.
 *
 * The values are the rate scale's own integers and the labels are what the card
 * has always painted; nothing here restates the conversion.
 */
export const SAMSLOOP_RATE_LANDMARKS: readonly ParamLandmark[] = [
  { value: -2, label: '-200%' },
  { value: -1, label: '-100%' },
  { value: 0, label: '0%' },
  { value: 1, label: 'Norm' },
  { value: 2, label: '+200%' },
];

/**
 * LOOP vs ONE-SHOT, as a SELECTABLE roster rather than a two-position dial.
 *
 * ⚠ WITHOUT THIS THE CONTROL IS INERT ON A FACEPLATE, and that is measured
 * rather than theoretical: a `0..1 discrete` param drawn as a knob has exactly
 * two reachable positions across the dial's whole travel, so an ordinary drag
 * quantises back to where it started. `faces-parity` failed `moog962` on
 * precisely this shape, twice — *"dragging the knob commits a param change into
 * the graph"*. `options` is the ONLY mechanism that reaches a segmented cell;
 * `face.paramCells` has no segmented kind to declare.
 *
 * The names are the module's OWN — `SamsloopCard.svelte` has painted `LOOP` /
 * `1-SHOT` on its mode button since the module shipped, and the `docs` prose
 * calls them the same thing. Nothing here is invented.
 */
export const SAMSLOOP_MODE_OPTIONS: readonly ParamOption[] = [
  { value: 0, label: 'one-shot' },
  { value: 1, label: 'loop' },
];

/** MONO vs POLY, same selectability argument as the mode roster above: a
 *  two-state discrete param needs a roster or it is an inert dial. */
export const SAMSLOOP_POLY_OPTIONS: readonly ParamOption[] = [
  { value: 0, label: 'mono' },
  { value: 1, label: 'poly' },
];

/**
 * Convert a saved FRAME-indexed window to the fractional one, idempotently.
 *
 * ⚠ THE DISCRIMINATOR IS `> 1`, AND IT IS SOUND RATHER THAN A HEURISTIC. A
 * fraction is by definition within `[0, 1]`; a legacy frame index for any real
 * sample is far outside it. The one overlap is `start = 0`, which is both the
 * legacy default and the fractional one — and it means the SAME position under
 * either reading, so the ambiguity is not observable. Re-running this on an
 * already-migrated value is therefore a no-op, which is what lets it live on a
 * load path that runs more than once.
 *
 * ⚠ THE DIVISOR IS THE SAMPLE'S OWN LENGTH, NOT THE OLD `1e6` CEILING. Dividing
 * by 1e6 would look right (it was the declared max) and would silently truncate
 * every saved loop to a sliver: a 2-second sample's `end` was 96 000 frames
 * meaning THE WHOLE SAMPLE, and `96000 / 1e6` is 9.6 % of it. The saved
 * `sampleLength` rides the same envelope as the params, so the exact divisor is
 * always in hand and the fallback is never needed.
 *
 * Returns null when there is nothing to convert (already fractional, or no
 * length to divide by) so the caller can skip the write entirely.
 */
export function samsloopWindowToFraction(
  start: number,
  end: number,
  sampleLength: number,
): { start: number; end: number } | null {
  if (!(sampleLength > 0)) return null;
  if (start <= 1 && end <= 1) return null; // already fractional
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const s = clamp01(start / sampleLength);
  const e = clamp01(end / sampleLength);
  // A legacy `end` of 1e6 against a 96 000-frame sample divides to >1 and
  // clamps to 1 — the whole sample, which is exactly what the old worklet
  // played after ITS defensive `min(len, endRaw)` clamp.
  return { start: Math.min(s, e), end: Math.max(s, e) };
}

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

  // ⚠ `rescaleBoundaries` WAS HERE AND IS DELETED. It proportionally re-mapped a
  // saved FRAME window onto a re-decoded buffer of a different length, because an
  // absolute index is only meaningful against the length the buffer had at SAVE
  // time. The window is a FRACTION now — length-invariant by construction — so
  // that failure cannot occur and the helper had no caller left. Leaving it would
  // leave a plausible-looking function for someone to "fix" against fractions.

  /**
   * Resolve the FRACTIONAL window to frame indices inside `[0, len]`.
   *
   * ⚠ THIS IS THE MIRROR OF THE WORKLET'S OWN WINDOW MATH and it must stay
   * arithmetically identical — an `AudioWorkletProcessor` cannot be imported
   * under vitest, so this is the only place the rule is testable at all. The
   * worklet's copy is in `packages/dsp/src/samsloop.ts`; if you change one,
   * change both, and the tests below are what notices.
   *
   * ⚠ THE INPUTS ARE FRACTIONS (0..1) CARRYING KNOB + CV, so either can arrive
   * outside the unit interval and both can move at once.
   *
   * ⚠ THE ORDER IS *END FIRST*, and that is a decision rather than an accident.
   * The natural phrasing — "start is bounded by end, end is bounded by start" —
   * is MUTUALLY RECURSIVE and has no defined answer when both cables move
   * together. Resolving END against the sample and then START against the
   * resolved END breaks the cycle the way the controls are actually used: END
   * says how much of the sample is in play, START says where inside it to
   * begin. Both CV anchors fall out exactly — at the defaults a full +CV on
   * START walks it to the far end, and a full −CV on END walks the window back
   * to the beginning.
   */
  clampWindow(startFrac: number, endFrac: number, len: number): { start: number; end: number } {
    if (len <= 1) return { start: 0, end: Math.max(1, len) };
    const e01 = Math.max(0, Math.min(1, Number.isFinite(endFrac) ? endFrac : 1));
    const s01 = Math.max(0, Math.min(e01, Number.isFinite(startFrac) ? startFrac : 0));
    const s = Math.max(0, Math.min(len - 1, Math.floor(s01 * len)));
    const e = Math.max(s + 1, Math.min(len, Math.ceil(e01 * len)));
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

/** The subset of `MessagePort` this module posts through. Narrowed so a unit
 *  test can drive the real transfer semantics with a plain `MessageChannel`
 *  port and no AudioContext. */
export interface SamsloopSamplePort {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/**
 * Post a decoded mono buffer into a SAMSLOOP worklet and RETURN ITS FRAME COUNT.
 *
 * `bufferRate` is the rate the buffer was CAPTURED at — the worklet scales its
 * read cursor by bufferRate/contextRate so rate=1.0 plays at natural pitch
 * whatever the AudioContext runs at. The ArrayBuffer is TRANSFERRED (zero-copy).
 *
 * ⚠ THE RETURN VALUE IS THE WHOLE POINT — read it, never `f32.length`
 * afterwards. `postMessage(..., [f32.buffer])` transfers the ArrayBuffer, which
 * **DETACHES every view onto it**, so `f32.length` is `0` the instant this call
 * returns. That is not a theoretical hazard: the factory's RECORD branch cached
 * `node.data.sampleLength = f32.length` AFTER posting, so every recording
 * persisted a length of ZERO, and `SamsloopCard` sized both window faders from
 * it. All three of the reported symptoms are that one detached read. ⚠ THE THREE SYMPTOMS BELOW ARE HISTORICAL — they describe the
 * FRAME-INDEXED window, which no longer exists (the window is a fraction now, so
 * neither fader is sized from `sampleLength` any more). They are kept because
 * they are what a zero length LOOKED like from the outside, and the cache is
 * still load-bearing for the legacy-window migration and the waveform draw:
 *   * START became a [0, 1] slider on a 40 000-frame take — full travel moved
 *     the play head by at most one sample, i.e. a control that does nothing;
 *   * touching END wrote an `end` ≤ 1, which the worklet clamps to
 *     `max(start+1, …)` — a ONE-SAMPLE window, so playback went to DC/silence;
 *   * the card's START..END highlight band collapsed to zero width and the
 *     waveform panel lost its lit wash — it reads as black.
 *
 * Capturing the length HERE, before the transfer, is what makes that class of
 * mistake UNWRITABLE at the call site rather than merely fixed once.
 * Negative-controlled in both directions by `samsloop-post-buffer.test.ts`.
 *
 * Exceptions are swallowed: the node can be torn down between the decode and
 * the post, and a teardown race must not break the caller's bookkeeping. The
 * frame count is still returned — it describes the BUFFER, not the delivery.
 */
export function postSampleBuffer(
  port: SamsloopSamplePort,
  f32: Float32Array,
  bufferRate: number | undefined,
): number {
  const frames = f32.length; // BEFORE the transfer detaches the view
  try {
    port.postMessage(
      { type: 'loadSample', samples: f32.buffer, sampleRate: bufferRate },
      [f32.buffer as Transferable],
    );
  } catch {
    // The node can be torn down between the read and the post.
  }
  return frames;
}

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
    { id: 'trig',       type: 'gate', edge: 'trigger' },
    { id: 'rate_cv',    type: 'cv', paramTarget: 'rate', cvScale: { mode: 'linear' } },
    // ⚠ WINDOW CV, AND `depth: 1` IS LOAD-BEARING RATHER THAN DECORATIVE. It
    // means "a full natural-range sweep", and now that the window is a FRACTION
    // the natural range IS the whole sample — so +full CV walks START to the far
    // end and −full CV walks END back to the beginning, on a two-second loop and
    // a sixty-second one alike. Against the old frame indexing the same
    // declaration meant 1e6 frames, which was neither the sample nor reachable.
    //
    // ⚠ `center: 'param'` (the default) is deliberate: these are BIAS knobs, not
    // absolute positions. The player sets a window and the CV moves it from
    // there — an LFO on START is a scrub, not a jump to wherever the cable sits.
    { id: 'start_cv',   type: 'cv', paramTarget: 'start', cvScale: { mode: 'linear', depth: 1 } },
    { id: 'end_cv',     type: 'cv', paramTarget: 'end',   cvScale: { mode: 'linear', depth: 1 } },
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
      defaultValue: 1, min: 0, max: 1, curve: 'discrete',
      options: SAMSLOOP_MODE_OPTIONS },
    // ⚠ FRACTIONS OF THE SAMPLE, not frame indices — see SAMSLOOP_WINDOW_RANGE
    // for the 20.8 s clamp bug this replaced and why a fraction also deletes
    // the re-decode boundary-restore class. `end` defaults to 1 = the whole
    // sample, which is what the old `1e6` ceiling meant after the worklet's
    // own `min(len, …)` clamp.
    { id: 'start', label: 'Start', defaultValue: SAMSLOOP_WINDOW_RANGE.min,
      min: SAMSLOOP_WINDOW_RANGE.min, max: SAMSLOOP_WINDOW_RANGE.max, curve: 'linear' },
    { id: 'end',   label: 'End',   defaultValue: SAMSLOOP_WINDOW_RANGE.max,
      min: SAMSLOOP_WINDOW_RANGE.min, max: SAMSLOOP_WINDOW_RANGE.max, curve: 'linear' },
    // POLYPHONY. 0 = mono (one cursor; a re-trigger restarts it — the historical
    // behaviour and still the default, because a looper that steals its own
    // voice is what a looper is). 1 = poly: each gate edge takes its own cursor,
    // so overlapping strikes layer instead of interrupting.
    { id: 'poly',  label: 'Poly',
      defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: SAMSLOOP_POLY_OPTIONS },
  ],

  // The non-param affordances the faceplate ranks. Each one is a cell in
  // `SHELL_CELLS.samsloop`; the id is the face key and the prefix is the testid
  // the parity sweep drives. ⚠ These are what make the card's buttons
  // REPRESENTABLE at all — a control with no family entry is invisible to
  // `module-face-lint`'s completeness check, which is how a card-only affordance
  // silently fails to survive promotion.
  controlFamilies: [
    { id: 'samsloop-trigger',     label: 'Manual trigger',     kind: 'other', testidPrefix: 'samsloop-trigger' },
    { id: 'samsloop-wav-input',   label: 'Sample loader',      kind: 'other', testidPrefix: 'samsloop-wav-input' },
    { id: 'samsloop-rec',         label: 'Record transport',   kind: 'other', testidPrefix: 'samsloop-rec' },
    { id: 'samsloop-download',    label: 'Sample export',      kind: 'other', testidPrefix: 'samsloop-download' },
    { id: 'samsloop-chan',        label: 'Record channels',    kind: 'other', testidPrefix: 'samsloop-chan' },
    { id: 'samsloop-bits',        label: 'Record bit depth',   kind: 'other', testidPrefix: 'samsloop-bits' },
    // ⚠ The id and the testidPrefix DIVERGE here on purpose. The card's rate
    // switch renders one button per option with a derived testid
    // (`samsloop-rate-${n}k`), so the prefix that actually appears on the card
    // is `samsloop-rate`. The face key stays `-select` because a bare
    // `samsloop-rate` would read as the RATE PARAM, which is a different
    // control entirely — this one is the RECORDING sample rate.
    { id: 'samsloop-rate-select', label: 'Record sample rate', kind: 'other', testidPrefix: 'samsloop-rate' },
  ],

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // WHAT SAMSLOOP IS FOR, in one sentence, because every rank below descends
  // from it: it is the module that turns a RECORDING into an INSTRUMENT — you
  // capture or load one sample, choose a slice of it, and play that slice at any
  // speed in either direction. The verb is "aim the window and fire it".
  //
  // THE TIER LADDER, read back as a sentence: at mini you get RATE, because a
  // looper whose speed you cannot reach is a tape deck. At compact you get RATE
  // and the WINDOW's two ends — aiming is the gesture. The plate adds MODE and
  // the TRIGGER that fires it. The dock adds everything else: the recorder, the
  // loader, the export, and POLY.
  //
  // ⚠ WHY `rate` LEADS AND NOT `start`. START is the more-used control in a
  // session, but it is INERT AT SPAWN: with no sample loaded the window has
  // nothing to aim at, and a hero that does nothing on a fresh module teaches
  // that the module does nothing. RATE is meaningful the instant a sample
  // arrives and is the one control that is never a no-op.
  //
  // ⚠ AND `rate` IS THE WARPED-FADER CELL, not an ordinary fader. Its param is
  // declared `-2..+2 linear`, but the card has always drawn KNOB SPACE with a
  // PIECEWISE map (`samsloop-rate.ts`), which puts unity (+1) at the fader's
  // MIDPOINT rather than at `(1 - -2) / 4 = 3/4`. Drawing it linearly on the
  // face would move "no transpose" a quarter of the control away from where
  // every player's muscle memory has it — a functional-parity break that passes
  // every gate, because they all read the ParamDef and the ParamDef is not what
  // was drawn. See the `warped-fader` entry in `shell-cells.ts`.
  face: {
    // ⚠ The `-{n}` suffix is the NUMBERED-CONTROL form a `controlFamilies`
    // entry is ranked by; a bare family id resolves to nothing.
    order: [
      'rate', 'start', 'end', 'mode', 'samsloop-trigger-{n}', 'poly',
      'samsloop-wav-input-{n}', 'samsloop-rec-{n}', 'samsloop-download-{n}',
      'samsloop-chan-{n}', 'samsloop-bits-{n}', 'samsloop-rate-select-{n}',
    ],

    pages: [
      // ⚠ PAGED BY FUNCTION, and the two pages are genuinely different IDEAS
      // rather than a header hunt: PLAY is what you do with a sample you have,
      // SAMPLE is how you get one. Five bands would have been padding.
      {
        id: 'play',
        label: 'play',
        controls: ['rate', 'start', 'end', 'mode', 'poly', 'samsloop-trigger-{n}'],
      },
      {
        id: 'sample',
        label: 'sample',
        controls: [
          'samsloop-wav-input-{n}',
          'samsloop-rec-{n}',
          'samsloop-download-{n}',
          'samsloop-chan-{n}',
          'samsloop-bits-{n}',
          'samsloop-rate-select-{n}',
        ],
      },
    ],

    // ⚠ `glyph: 'none'` IS FORCED, not chosen — and for the opposite reason to
    // spectrograph's. This module DOES declare an audio output, so a glyph would
    // resolve to a live trace happily. But the dock body below already paints
    // this module's picture, and a live output trace beside a waveform of the
    // SAME audio teaches that they are two different things. The lane tile keeps
    // its ranked cells; the waveform is a dock surface.
    glyph: 'none',

    // The waveform, its window wash and the live playhead arrive through this
    // slot. Promotion stops both surfaces rendering the card, and on a sampler
    // that would leave the player placing loop points BLIND — START and END are
    // the two controls whose entire meaning is "where in this picture".
    // See `$lib/ui/modules/samsloop/shell-extension.ts`.
    extension: 'samsloop',
  },

  docs: {
    explanation:
      "A single-sample loop player. Load one audio file (drag/drop or the upload button — wav, mp3, m4a/aac, ogg, flac, opus, up to 2 MB) OR record straight from the microphone or a patched audio input; either way the source is decoded into one buffer that the faceplate's waveform shows. A recording runs up to 31 seconds at the default settings (MONO / 16-bit / 48 kHz); the CHAN, BITS and RATE switches trade fidelity for length up to a hard 60-second ceiling, and the faceplate\'s \"N.NNs max\" readout always shows what the current settings buy. REC stops itself when it gets there. SAMSLOOP holds exactly ONE sample at a time — a new upload or recording REPLACES it (no playlist, no slots). After loading it sits SILENT and waits: it does NOT auto-play. A TRIGGER (a rising edge on the TRIG input, or the faceplate\'s TRIGGER button) starts playback, and what 'start' means depends on MODE — in one-shot mode the sample plays through the window once and returns to idle; in loop mode the trigger starts a continuous loop and a re-trigger restarts it from the window edge. Playback uses a fractional read-cursor with linear interpolation, so the RATE control is a full varispeed: positive = forward, negative = REVERSE, |value| = speed (2 = double speed / one octave up, 0.5 = half). The START and END markers crop which slice of the sample plays/loops, and they are FRACTIONS of the sample rather than frame counts — 0 is its beginning and 1 is its end whether the sample is two seconds or sixty. That is what lets a patched START CV or END CV sweep the whole sample at any length, and it is why re-loading a patch never lands the window on the wrong samples. POLY decides what a second trigger does while the first is still sounding: in MONO it restarts the single voice (a looper stealing itself, the historical behaviour), in POLY it takes another voice and the two layer, up to the same voice budget MIDI LANE uses, stealing the oldest under pressure. The output is mono.",
    inputs: {
      trig:
        "Rising-edge trigger that STARTS playback per the current MODE: in one-shot mode it plays the cropped window through once; in loop mode it starts the loop (and a re-trigger restarts it from the window edge — START for forward, END for reverse). Works alongside the faceplate's TRIGGER button. While idle (no trigger yet) the module is silent.",
      rate_cv:
        "CV that offsets the RATE param (linear): ±1 V swings the playback rate by ±1 unit on top of the slider, so an LFO here does pitch/speed wobble, tape-stop, or reverse sweeps. The summed rate is clamped to the worklet's [−3, +3] range; crossing zero flips playback direction.",
      start_cv:
        "CV that moves the START of the playback window. Because the window is a FRACTION of the sample rather than a frame count, a full-depth sweep here walks START from the sample's beginning to its far end whatever its length — an LFO scrubs the loop's in-point, an envelope drags it open. It is a BIAS on the knob, not an absolute position: the player sets a window and the CV moves it from there. START is resolved AFTER END (see end_cv), so driving START past END collapses the window onto END rather than pushing it open.",
      end_cv:
        "CV that moves the END of the playback window, in the same sample-relative fractions START uses: a full-depth negative sweep walks END back to the sample's beginning, shortening the loop to nothing. END is resolved FIRST and START is then bounded by the result — the two rules read together are not circular, which is exactly why the order is fixed rather than symmetric. Patch both and END decides how much of the sample is in play while START decides where inside it to begin.",
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
        "START of the playback window, as a FRACTION of the sample (0 = its beginning, 1 = its end) — the left waveform marker. Crops where playback/looping begins, and where reverse playback ends. Being sample-relative rather than a frame index means the same setting means the same musical point on a two-second sample and a sixty-second one, and that a re-loaded patch can never land it on the wrong samples. CV via start_cv.",
      end:
        "END of the playback window, as a FRACTION of the sample (the right waveform marker). Crops where playback/looping ends, and where reverse playback begins. Together START..END select the slice that plays or loops. ⚠ END is resolved BEFORE START: when both are driven at once END is clamped to the sample and START is then clamped to END, so the pair always describes a real window instead of two rules that each depend on the other. CV via end_cv.",
      "samsloop-trigger-{n}":
        "Fires playback by hand, exactly as a rising edge on the TRIG input would: in one-shot it plays the window through once, in loop it starts (or restarts) the loop. It works whether or not a cable is patched, which makes it the fastest way to audition a sample you have just loaded or recorded.",
      "samsloop-wav-input-{n}":
        "Loads one audio file as THE sample — wav, mp3, m4a/aac, ogg, flac or opus, up to 2 MB. SAMSLOOP holds exactly one sample, so a load REPLACES whatever was there (including a recording), and the window reopens over the whole of the new one. The status and error lines under the button report what was decoded, or why it was refused.",
      "samsloop-rec-{n}":
        "Starts and stops recording into the sample buffer, capturing whatever is patched to the record inputs at the current CHAN/BITS/RATE. A take REPLACES the loaded sample. It refuses to arm rather than silently shortening when the rack's sample budget cannot fit a usable take, and it stops itself at the length the current settings buy.",
      "samsloop-download-{n}":
        "Exports the sample to a file: a recording is written as a WAV at the rate, depth and channel count it was captured with, while an uploaded file comes back as its ORIGINAL bytes — an mp3 stays an mp3, losslessly. Nothing to export means nothing happens.",
      "samsloop-chan-{n}":
        "How many channels a RECORDING captures. MONO halves the bytes per second and so roughly doubles the take length the budget allows; STEREO records both record inputs. It applies to the next take — the settings are frozen for the duration of one, and changing this mid-take ends it cleanly.",
      "samsloop-bits-{n}":
        "The bit depth a RECORDING is quantized to. 16 is the default and is transparent for most material; 8 halves the bytes per second, doubling the available length at the cost of an audible noise floor — which on a looper is often a sound you want rather than a compromise.",
      "samsloop-rate-select-{n}":
        "The sample rate a RECORDING is decimated to. Lower rates trade bandwidth for length, and the decimation is by an INTEGER factor, so a requested rate that does not divide the audio context's rate lands on the nearest one that does — the faceplate says so rather than claiming a rate it did not produce.",
      poly:
        "What a trigger does while the module is already sounding. MONO (0, default) restarts the single voice — the historical behaviour, and what a looper usually wants. POLY (1) gives each trigger its own read-cursor so overlapping strikes LAYER instead of interrupting, sharing the same voice budget MIDI LANE allocates and stealing the oldest voice when they are all busy. Voices sum rather than average, so layering gets louder rather than ducking.",
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
    const workletNode = createWorkletNode(node, ctx, 'samsloop', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // ⚠ THE POLY WIDTH CROSSES THE PACKAGE BOUNDARY AS DATA, not as a second
      // copy of the number. `packages/dsp` cannot import from `packages/web`,
      // so a worklet that needed its own `const MAX_VOICES = 16` would be the
      // two-sided-contract shape again — and the side that drifted would be the
      // one nothing reads. `MAX_POLY_VOICES` stays the single authority in
      // `midi-lane.ts` (it is the same steal-oldest budget on both ends of a
      // real MIDI chain) and the worklet is TOLD.
      processorOptions: { maxVoices: MAX_POLY_VOICES },
    });

    /**
     * THE LIVE PLAYHEAD, as last published by the worklet.
     *
     * ⚠ PUSHED ON THE WORKLET'S OWN CLOCK, PULLED BY WHOEVER IS LOOKING. The
     * cursor lives on the audio thread and there is no way to read it
     * synchronously, so the worklet posts it at ~20 Hz and this is where the
     * newest one rests. Surfaces READ this (through the handle's `playhead`
     * key) at whatever rate they paint — nobody subscribes, so a surface that
     * is not mounted costs nothing and a surface that mounts late is correct on
     * its first frame instead of waiting for the next publish.
     *
     * ⚠ A FRACTION, matching the window params, so a consumer drawing into a
     * canvas of its own width needs no knowledge of the buffer length.
     * `position: -1` means NO VOICE IS SOUNDING — which a fraction cannot
     * otherwise express, and which is a different fact from "position 0".
     */
    let playhead: { position: number; voices: number } = { position: -1, voices: 0 };
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; position?: number; voices?: number } | null;
      if (!m || m.type !== 'playhead') return;
      playhead = {
        position: typeof m.position === 'number' ? m.position : -1,
        voices: typeof m.voices === 'number' ? m.voices : 0,
      };
    };

    // Recording tap. Two audio inputs (L + R), 1 silent output (Web Audio
    // requires at least one output to keep the node alive in the graph;
    // the tap doesn't drive anything downstream — record-only). Owned by
    // the factory so it can be cleanly disposed; enable/disable is via
    // port message from the card.
    const tapNode = createWorkletNode(node, ctx, 'samsloop-tap', {
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
        // ⚠ `result.samples`, NOT `f32` — `f32` is a COPY whose buffer was just
        // TRANSFERRED to the worklet, so `f32.length` is 0 here. (`result.samples`
        // is a different buffer and survives.) See postBuffer below for the
        // regression this exact read caused on the record branch.
        const newLen = result.samples.length;
        // LEGACY WINDOW MIGRATION — frame indices → the fractional window.
        //
        // ⚠ THIS IS THE WHOLE MIGRATION, AND IT LIVES HERE RATHER THAN IN
        // `persistence.ts` ON PURPOSE. That loader's stated policy is TOLERANT
        // READ with no value reshaping — *"a patch stores TOPOLOGY + authored
        // values only, and is never reshaped on load"* — and the per-module
        // `schemaVersion` / `moduleSchemas` substrate was deliberately collapsed
        // in the envelope-v2 cleanup. Re-opening it for one module would undo
        // that decision (and drag `persistence.ts`, a collab-attest basis file,
        // along with it). The factory already owns the one moment where the
        // saved window and the sample's true length are both in hand, which is
        // exactly what the conversion needs.
        //
        // ⚠ AND THE OLD PROPORTIONAL RESCALE IS GONE WITH THE FRAME INDEXING,
        // not merely moved. It existed because an absolute index is only valid
        // against the length the buffer had at SAVE time, so a non-WAV source
        // re-decoded at a different AudioContext rate (`decodeAudioData`
        // resamples) pointed the window at the wrong samples. A FRACTION is
        // length-invariant, so that failure cannot occur and there is nothing
        // left to repair — the bug class is deleted, not patched.
        const savedLen = typeof ld.sampleLength === 'number' ? ld.sampleLength : 0;
        if (live.params) {
          const p = live.params as Record<string, number>;
          // Prefer the SAVED length as the divisor — the frames were written
          // against it. Fall back to the freshly-decoded one when the envelope
          // carried no length (very old patches).
          const migrated = samsloopWindowToFraction(
            p.start ?? 0,
            p.end ?? 1,
            savedLen > 0 ? savedLen : newLen,
          );
          if (migrated) {
            p.start = migrated.start;
            p.end = migrated.end;
            // Re-apply to the worklet immediately (the poll loop only repushes
            // the sample, not start/end — those are set once at factory init).
            params.get('start')?.setValueAtTime(migrated.start, ctx.currentTime);
            params.get('end')?.setValueAtTime(migrated.end, ctx.currentTime);
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

    /** The factory's bound form of `postSampleBuffer` (module scope, above) —
     *  posts into THIS node's worklet port and returns the frame count. */
    function postBuffer(f32: Float32Array, bufferRate: number | undefined): number {
      return postSampleBuffer(workletNode.port, f32, bufferRate);
    }

    // Send the initial sample (if present in node.data — typically not on
    // first spawn, but rehydrated from a saved patch envelope or multiplayer
    // join). Poll-on-data-change: when the card's upload or RECORD handler
    // mutates node.data, the loop picks it up within POLL_MS and reposts to
    // the worklet.
    //
    // WHICH source it is, and the precedence between them, is `resolveSamsloopSource`
    // (top of this file) — a pure function so a unit test can assert every
    // branch without an AudioContext. That matters: this loop used to inline
    // the decision and knew only about the two UPLOAD keys, so **a recording
    // never reached the worklet at all**. Three kinds:
    //   - 'file'   — base64 original upload bytes. Decoded through the
    //                AudioContext (async ⇒ the `decodeInFlight` re-entrancy
    //                guard), which also caches sampleLength / sampleRate back
    //                into node.data so the card's faders re-bound.
    //   - 'legacy' — pre-base64 patches with the decoded YArray. Read-only.
    //   - 'record' — the RECORD path's header-less PCM. Decoded SYNCHRONOUSLY
    //                (we own the format; no AudioContext round-trip needed).
    let lastSignature: string | null = null;
    let decodeInFlight = false;
    function pushSampleIfChanged(): void {
      const live = livePatch.nodes[node.id];
      const d = live?.data as SamsloopData | undefined;
      const src = resolveSamsloopSource(d);
      const sig = src?.signature ?? 'empty';
      if (sig === lastSignature) return;
      if (src?.kind === 'file') {
        // The async branch guards re-entrancy BEFORE claiming the signature,
        // so a decode still in flight is retried on the next poll rather than
        // dropped.
        if (decodeInFlight) return;
        lastSignature = sig;
        decodeInFlight = true;
        decodeBytesAndPush(src.b64).finally(() => {
          decodeInFlight = false;
        });
        return;
      }
      lastSignature = sig;
      if (!src) return;
      if (src.kind === 'legacy') {
        postBuffer(new Float32Array(src.samples), src.sampleRate);
        return;
      }
      // 'record' — mono-mix a stereo take, exactly as the upload path
      // mono-mixes a stereo file. An empty decode posts nothing rather than
      // clearing a buffer that is already playing.
      const f32 = decodeRecordedPcm(src.sample, 'mix');
      if (f32.length === 0) return;
      // `frames` comes from postBuffer's RETURN, not from f32 — the post
      // transfers (and therefore detaches) f32.buffer, so `f32.length` is 0
      // from here on. See postBuffer's comment: reading it here is what wrote
      // `sampleLength: 0` onto every recording and broke both window faders.
      const frames = postBuffer(f32, src.sample.rate);
      // Cache the derived metadata the START/END faders bound against, the
      // same way decodeBytesAndPush does for an upload — without it the card
      // sizes both faders to `Math.max(1, 0)` and the loop window is unusable
      // on a recording.
      try {
        const ld = live?.data as SamsloopData | undefined;
        if (!ld) return;
        if (ld.sampleLength !== frames) ld.sampleLength = frames;
        if (ld.sampleRate !== src.sample.rate) ld.sampleRate = src.sample.rate;
      } catch {
        // syncedstore writes throw if the node was deleted; ignore.
      }
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
        // ⚠ EVERY `paramTarget` PORT MUST PUBLISH ITS AudioParam HERE, and the
        // failure mode is silent by design. `AudioEngine.addEdge` reads `param`
        // to decide whether a cable is MODULATION or SIGNAL; with it absent it
        // falls back to `{node, input}` and the cable becomes audio into worklet
        // input 0 — the control does nothing and nothing throws. The window CV
        // shipped that way in this PR's first CI run: the ports were declared on
        // the def and never added to this map. `samsloop-cv-contract.test.ts`
        // now asserts the two sides agree.
        ['rate_cv',    { node: workletNode, input: 0, param: params.get('rate')! }],
        ['start_cv',   { node: workletNode, input: 0, param: params.get('start')! }],
        ['end_cv',     { node: workletNode, input: 0, param: params.get('end')! }],
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
        // The live play position, as a FRACTION of the sample, plus how many
        // voices are sounding. `position: -1` = nothing is playing. Read by the
        // waveform surfaces on their own paint clock; see the `playhead`
        // binding above for why this is a pull rather than a subscription.
        if (key === 'playhead') return playhead;
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
