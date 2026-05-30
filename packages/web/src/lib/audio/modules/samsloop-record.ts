// packages/web/src/lib/audio/modules/samsloop-record.ts
//
// SAMSLOOP recording helpers — pure functions extracted so unit tests can
// pin the byte-budget math, the quantization, the resampling, and the WAV
// header encoding without spinning up Web Audio.
//
// The recording surface for the card:
//   - `samsloopMaxSeconds(rate, bits, channels)` — how long a recording
//     can run before we auto-stop at the 250 kB byte budget. The card uses
//     this both to draw the live-record bar (waveform x-axis = maxSeconds
//     at current settings) and to know when to stop the capture.
//   - `quantizeF32ToI16` / `quantizeF32ToI8` — convert AudioContext-rate
//     Float32 samples (the raw capture output) to the on-disk bit depth.
//   - `downsample` — drop AudioContext rate (typically 48 kHz) down to the
//     user-chosen RATE switch (22 / 44 kHz). Integer-factor decimation
//     with a 1-pole IIR pre-filter to suppress aliasing.
//   - `makeWavBlob` — synthesize a standard 44-byte RIFF/WAVE header on
//     the fly for the DOWNLOAD button. Stored bytes are header-less PCM;
//     the header is built only on export.
//
// None of this is on the hot path — recording-time work runs in a
// MessagePort handler at ≈3 ms / block (48 kHz / 128), and quantize +
// downsample fire ONCE on STOP. Optimize for clarity, not throughput.

/** Hard ceiling on stored PCM bytes per SAMSLOOP recording. 250 000 bytes
 *  — matches the existing 250 KB SAMSLOOP_MAX_FILE_BYTES uploaded-file
 *  budget, so the persistence-layer cost (one Yjs update per recording,
 *  carrying the bytes inside node.data) stays bounded at ≤250 KB
 *  regardless of which RATE × BITS × CHANNELS the user picks. */
export const SAMSLOOP_RECORD_BUDGET_BYTES = 250_000;

/** Discrete option sets — the card's three toggle switches. Exposed as
 *  consts so the card, the helpers, and the tests share one source of
 *  truth (drift here ⇒ a mid-recording settings change makes the budget
 *  math disagree with the auto-stop trigger). */
export const SAMSLOOP_RATE_OPTIONS = [22_050, 44_100] as const;
export const SAMSLOOP_BITS_OPTIONS = [8, 16] as const;
export const SAMSLOOP_CHANNELS_OPTIONS = [1, 2] as const;
export type SamsloopRecRate = (typeof SAMSLOOP_RATE_OPTIONS)[number];
export type SamsloopRecBits = (typeof SAMSLOOP_BITS_OPTIONS)[number];
export type SamsloopRecChannels = (typeof SAMSLOOP_CHANNELS_OPTIONS)[number];

/** Default settings on a fresh module. Picked so a new SAMSLOOP records
 *  at near-CD-quality (44.1 / 16 / 2) inside the 250 kB budget = 1.42 s,
 *  which matches the existing upload-cap heuristic ("short enough to feel
 *  like a loop, long enough to capture a phrase"). */
export const SAMSLOOP_REC_DEFAULTS = {
  rate:     44_100 as SamsloopRecRate,
  bits:     16     as SamsloopRecBits,
  channels: 2      as SamsloopRecChannels,
} as const;

/** Persisted shape on `node.data.sample` for a finished SAMSLOOP recording.
 *  Mirrors the PICTUREBOX persistence pattern (`imageBytes` rides the Yjs
 *  envelope as plain data) — the bytes here are a plain `number[]` of raw
 *  PCM samples (no header; the WAV header is synthesized only on export).
 *
 *  The downloader + player both rebuild a typed array on read by combining
 *  bytes + bits (which width to read) + channels (interleaving). */
export interface SamsloopRecordedSample {
  /** Raw PCM bytes as a plain number[] so it serializes cleanly into
   *  Yjs / JSON. Interleaved if `channels === 2`. Little-endian for
   *  16-bit samples (matches the WAV spec). */
  bytes: number[];
  /** Sample rate the recording was downsampled to. One of the entries
   *  in SAMSLOOP_RATE_OPTIONS. */
  rate: SamsloopRecRate;
  /** Bit depth the recording was quantized to. One of SAMSLOOP_BITS_OPTIONS. */
  bits: SamsloopRecBits;
  /** Channel count. One of SAMSLOOP_CHANNELS_OPTIONS. */
  channels: SamsloopRecChannels;
  /** Convenience field — same as bytes.length / (channels * bytesPerSample) /
   *  rate. Stored so the card can show the duration without recomputing. */
  durationSec: number;
}

/**
 * Maximum recording length in seconds for the given settings, capped to
 * the 250 kB byte budget. Used as the live-record bar's horizontal axis
 * (waveform fills the bar over `maxSeconds` of capture) AND as the
 * auto-stop trigger (capture ends when the byte count would exceed
 * SAMSLOOP_RECORD_BUDGET_BYTES).
 *
 * Formula: `floor(BUDGET / (rate * bytesPerSample * channels))`.
 *
 * Pinned in `samsloop-record.test.ts`'s 8-cell table:
 *   mono 8-bit  22k = 11.34 s   stereo 8-bit  22k = 5.67 s
 *   mono 16-bit 22k =  5.67 s   stereo 16-bit 22k = 2.83 s
 *   mono 8-bit  44k =  5.66 s   stereo 8-bit  44k = 2.83 s
 *   mono 16-bit 44k =  2.83 s   stereo 16-bit 44k = 1.42 s
 *
 * (The 11.34 / 5.67 / 2.83 / 1.42 cadence comes from the doubling-and-
 * halving of rate × bits × channels — each doubling halves the seconds.)
 */
export function samsloopMaxSeconds(
  rate: number,
  bits: number,
  channels: number,
): number {
  if (rate <= 0 || bits <= 0 || channels <= 0) return 0;
  const bytesPerSample = Math.ceil(bits / 8);
  const bytesPerSecond = rate * bytesPerSample * channels;
  if (bytesPerSecond <= 0) return 0;
  // Round to 2 decimal places (banker's rounding via Math.round is fine
  // for display + auto-stop trigger). The actual byte-count check uses
  // the unrounded value internally — `samsloopMaxSeconds` is for the UI
  // label + the bar's x-axis scale.
  return Math.round(SAMSLOOP_RECORD_BUDGET_BYTES / bytesPerSecond * 100) / 100;
}

/**
 * The unrounded (exact) maxSeconds. Used by the recorder's auto-stop
 * trigger so the byte count is the source of truth — `samsloopMaxSeconds`
 * only rounds for display.
 */
export function samsloopMaxSecondsExact(
  rate: number,
  bits: number,
  channels: number,
): number {
  if (rate <= 0 || bits <= 0 || channels <= 0) return 0;
  const bytesPerSample = Math.ceil(bits / 8);
  const bytesPerSecond = rate * bytesPerSample * channels;
  if (bytesPerSecond <= 0) return 0;
  return SAMSLOOP_RECORD_BUDGET_BYTES / bytesPerSecond;
}

/**
 * Quantize a Float32 buffer (range [-1, +1]) to signed 16-bit PCM. Clips
 * out-of-range samples symmetrically. Returns an Int16Array; the caller is
 * responsible for endian byte-packing if storing as raw bytes (the WAV
 * spec wants little-endian, which is the native byte order on every
 * platform we ship to — but `makeWavBlob` writes via DataView with
 * littleEndian=true anyway so the storage form can be platform-native).
 */
export function quantizeF32ToI16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const f = input[i] ?? 0;
    // Symmetric clip + scale. 0x7fff = 32767 (max positive 16-bit signed);
    // -0x8000 = -32768 (max negative). Multiplying by 0x7fff and clamping
    // gives symmetric clip around 0 with no DC bias — the convention WAV
    // 16-bit decoders expect.
    const clipped = f >= 1 ? 1 : (f <= -1 ? -1 : f);
    out[i] = Math.round(clipped * 0x7fff);
  }
  return out;
}

/**
 * Quantize a Float32 buffer to unsigned 8-bit PCM (WAV convention: 8-bit
 * PCM is UNSIGNED, centered on 128). Returns an Int8Array view shifted
 * by -128 so the byte values are in `[0, 255]` when reinterpreted as
 * Uint8 — matching what `makeWavBlob` writes into the file.
 *
 * Why Int8 and not Uint8: the spec's test cases (and the spec itself in
 * point #8) called for `Int8Array`. Callers that want raw bytes for
 * storage / download should reinterpret via
 * `new Uint8Array(int8.buffer, int8.byteOffset, int8.byteLength)`. The
 * WAV header writer (`makeWavBlob`) handles the reinterpret internally.
 */
export function quantizeF32ToI8(input: Float32Array): Int8Array {
  const out = new Int8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const f = input[i] ?? 0;
    const clipped = f >= 1 ? 1 : (f <= -1 ? -1 : f);
    // 8-bit signed: [-128, +127]. WAV reads it back as
    // `byte - 128 → [-128, +127]` then divides by 128 → [-1, +1].
    out[i] = Math.round(clipped * 0x7f);
  }
  return out;
}

/**
 * Integer-factor downsample with a 1-pole IIR low-pass pre-filter to
 * suppress aliasing. Picks `factor = round(srcRate / dstRate)` and
 * averages every `factor` samples; the running 1-pole smoother attenuates
 * frequencies near the new Nyquist before decimation.
 *
 * Used to bring AudioContext-rate Float32 samples (typically 48 kHz)
 * down to the user-chosen RATE switch (22 050 / 44 100 Hz). Returns the
 * input unchanged when `srcRate <= dstRate` (no upsampling — we never
 * need to add bandwidth, only remove it).
 *
 * The implementation is a sample-rate-converter sweet spot: not a
 * polyphase resampler (overkill for a sample looper), not a naïve drop-
 * every-Nth (audibly aliases on fast attacks). Returns a fresh
 * Float32Array.
 */
export function downsample(
  samples: Float32Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (srcRate <= 0 || dstRate <= 0) return new Float32Array(0);
  if (srcRate <= dstRate) return samples;
  const factor = Math.max(1, Math.round(srcRate / dstRate));
  const outLen = Math.floor(samples.length / factor);
  const out = new Float32Array(outLen);

  // 1-pole IIR LP smoother: y[n] = (1-a)*x[n] + a*y[n-1].
  // a ≈ 0.5 ⇒ cutoff near Nyquist/2 of the downsampled rate. Good enough
  // for a sample looper — kills the worst of the alias before decimation,
  // doesn't need to be transparent (we WANT a small bit of mellowing on
  // 22 kHz captures, that's part of the lo-fi character).
  const a = 0.5;
  let prev = 0;
  let writeIdx = 0;
  let acc = 0;
  let accCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] ?? 0;
    const y = (1 - a) * x + a * prev;
    prev = y;
    acc += y;
    accCount++;
    if (accCount === factor) {
      if (writeIdx < outLen) out[writeIdx] = acc / factor;
      writeIdx++;
      acc = 0;
      accCount = 0;
    }
  }
  return out;
}

/**
 * Build a standard RIFF/WAVE blob for download. The 44-byte header layout
 * matches the WAV spec (no fact chunk; we only emit PCM):
 *
 *   off 0  "RIFF"            (4 bytes, big-endian ASCII)
 *   off 4  fileSize - 8      (4 bytes, little-endian uint32)
 *   off 8  "WAVE"            (4 bytes, BE ASCII)
 *   off 12 "fmt "            (4 bytes, BE ASCII)
 *   off 16 16                (4 bytes, LE uint32 — fmt chunk size for PCM)
 *   off 20 1                 (2 bytes, LE uint16 — audio format = 1 (PCM))
 *   off 22 channels          (2 bytes, LE uint16)
 *   off 24 sampleRate        (4 bytes, LE uint32)
 *   off 28 byteRate          (4 bytes, LE uint32 = rate * channels * bytesPerSample)
 *   off 32 blockAlign        (2 bytes, LE uint16 = channels * bytesPerSample)
 *   off 34 bitsPerSample     (2 bytes, LE uint16)
 *   off 36 "data"            (4 bytes, BE ASCII)
 *   off 40 dataChunkSize     (4 bytes, LE uint32 = bytes.byteLength)
 *   off 44 <samples...>      (PCM data, interleaved if stereo)
 *
 * `bytes` is the raw PCM payload — for 16-bit it's an Int16Array's
 * underlying buffer (or any view we can copy); for 8-bit it's the
 * Int8Array reinterpreted as unsigned (we shift by +128 here so the
 * stored body matches WAV's unsigned 8-bit PCM convention).
 *
 * Returns a `Blob` with type `audio/wav` ready for download.
 */
export function makeWavBlob(
  bytes: ArrayBufferView,
  rate: number,
  bits: number,
  channels: number,
): Blob {
  const bytesPerSample = Math.ceil(bits / 8);
  const blockAlign = channels * bytesPerSample;
  const byteRate = rate * blockAlign;
  // Reinterpret the input view as bytes. We may need to shift signed
  // 8-bit → unsigned 8-bit (WAV convention), so we materialize an owned
  // Uint8Array first.
  const srcBytes = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  let dataBytes: Uint8Array;
  if (bits === 8) {
    // WAV 8-bit PCM is UNSIGNED centered on 128. Our quantizer emits
    // signed Int8 in [-128, +127]; convert by adding 128.
    dataBytes = new Uint8Array(srcBytes.length);
    for (let i = 0; i < srcBytes.length; i++) {
      // Read as signed Int8 (so 255 → -1), then shift.
      const signed = (srcBytes[i]! << 24) >> 24;
      dataBytes[i] = signed + 128;
    }
  } else {
    dataBytes = new Uint8Array(srcBytes); // copy
  }
  const dataSize = dataBytes.byteLength;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);

  // ASCII writer — DataView has no string method. setUint32(BE) of the
  // packed code is the shortest pattern; matches what parseWavManually
  // reads back.
  view.setUint32(0,  0x52494646, false); // "RIFF"
  view.setUint32(4,  fileSize - 8, true);
  view.setUint32(8,  0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);
  new Uint8Array(buf, headerSize).set(dataBytes);

  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Combine L + R Float32 channel buffers into the on-disk byte form
 * (downsampled + quantized + interleaved if stereo). Returns the raw
 * bytes ready to stash in `node.data.sample.bytes` AS a `number[]` (we
 * stop short of the array conversion here — the caller does it once at
 * commit time).
 *
 * `l` and `r` MUST be the same length. `srcRate` is the AudioContext
 * rate the L+R buffers were captured at. `dstRate` / `bits` / `channels`
 * are the user-chosen target settings; when channels === 1, the L
 * channel is mono-mixed (the helper averages L+R if R was distinct,
 * otherwise L is used directly).
 *
 * Exported so a unit test can pin the end-to-end pipeline at one entry
 * point rather than chaining 4 helpers in the test body.
 */
export function encodeRecordingBytes(
  l: Float32Array,
  r: Float32Array,
  srcRate: number,
  dstRate: SamsloopRecRate,
  bits: SamsloopRecBits,
  channels: SamsloopRecChannels,
): Uint8Array {
  // Resample each channel independently, then quantize, then interleave.
  const lDs = downsample(l, srcRate, dstRate);
  const rDs = channels === 2 ? downsample(r, srcRate, dstRate) : null;
  const n = lDs.length;

  // Build the pre-quantize buffer (mono mix when channels === 1).
  let pre: Float32Array;
  if (channels === 1) {
    if (rDs) {
      pre = new Float32Array(n);
      for (let i = 0; i < n; i++) pre[i] = ((lDs[i] ?? 0) + (rDs[i] ?? 0)) * 0.5;
    } else {
      pre = lDs;
    }
  } else {
    // Stereo: interleave L, R, L, R...
    const rUse = rDs ?? lDs; // mono input + stereo target ⇒ duplicate L
    pre = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pre[i * 2]     = lDs[i] ?? 0;
      pre[i * 2 + 1] = rUse[i] ?? 0;
    }
  }

  if (bits === 16) {
    const q = quantizeF32ToI16(pre);
    return new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
  } else {
    const q = quantizeF32ToI8(pre);
    return new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
  }
}

/**
 * Encode a byte buffer to base64. Yjs-safe storage form for the recorded
 * sample (one string write = one Yjs update; vs. a 144 kB number[] which
 * Yjs wraps in a YArray, blowing the stack at insert and broadcasting a
 * per-byte update to every peer in the rackspace).
 *
 * Chunked to avoid `String.fromCharCode.apply(null, hugeArray)` stack
 * overflows. Matches the strategy in persistence.ts (bytesToBase64).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as number[],
    );
  }
  return btoa(binary);
}

/** Inverse of bytesToBase64. Used to materialize the persisted sample
 *  back into a Uint8Array for the DOWNLOAD button + waveform redraw. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Generate the download filename for the WAV export. Suffix is the
 * timestamp at click time, formatted as `YYYYMMDD-HHmmss` so files sort
 * chronologically when dropped in a folder. Exposed for testing.
 */
export function samsloopDownloadFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `samsloop-${stamp}.wav`;
}
