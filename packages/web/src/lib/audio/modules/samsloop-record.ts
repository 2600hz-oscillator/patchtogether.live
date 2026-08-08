// packages/web/src/lib/audio/modules/samsloop-record.ts
//
// SAMSLOOP recording helpers — pure functions extracted so unit tests can
// pin the byte-budget math, the quantization, the resampling, and the WAV
// header encoding without spinning up Web Audio.
//
// The recording surface for the card:
//   - `samsloopMaxSeconds(rate, bits, channels)` — how long a recording
//     can run before we auto-stop at the byte budget. The card uses
//     this both to draw the live-record bar (waveform x-axis = maxSeconds
//     at current settings) and to know when to stop the capture.
//   - `quantizeF32ToI16` / `quantizeF32ToI8` — convert AudioContext-rate
//     Float32 samples (the raw capture output) to the on-disk bit depth.
//   - `downsample` — drop AudioContext rate (typically 48 kHz) down to the
//     user-chosen RATE switch (22 / 44 / 48 kHz). Integer-factor decimation
//     with a 1-pole IIR pre-filter to suppress aliasing. ⚠ The rate it
//     ACHIEVES is not always the rate you asked for — see
//     `samsloopAchievedRate`, which every caller must tag its bytes with.
//   - `SamsloopCaptureBuffer` — the fixed-capacity L/R accumulator the card
//     writes each tap chunk into (see the class comment for why this is not
//     `AudioRingBuffer`).
//   - `makeWavBlob` — synthesize a standard 44-byte RIFF/WAVE header on
//     the fly for the DOWNLOAD button. Stored bytes are header-less PCM;
//     the header is built only on export.
//
// Quantize + downsample fire ONCE on STOP, so they optimize for clarity.
// `SamsloopCaptureBuffer.append` is the ONE hot path here: it runs in the
// tap's MessagePort handler at 375 messages/second (48 kHz / 128 samples),
// on the same main thread as the audio scheduler.

/**
 * Hard ceiling on stored PCM bytes per SAMSLOOP recording.
 *
 * DERIVATION — the previous value (250 000) had none, which is the whole
 * reason this constant needed fixing. It was cloned from the uploaded-file
 * cap when that cap was also 250 kB, then orphaned when the upload cap was
 * raised 8× to 2 MB (`SAMSLOOP_MAX_FILE_BYTES`); the old comment here even
 * admitted the two numbers were 8× apart without drawing the conclusion. The
 * result was a module that LOADED 62.5 s and RECORDED 1.42 s.
 *
 *   3 MB raw PCM
 *     → ×4/3 for the base64 storage form  = 4 MB in `node.data.sample`
 *     → that is ONE opaque Yjs value, broadcast once per finished take
 *     → the relay warns at 16 MB per rack and crits at 24 MB
 *       (`packages/server/src/rack-accounting.ts` — `RELAY_RACK_WARN_MB`)
 *     → so ONE full-length recording is ≤25 % of the per-rack warn budget.
 *
 * At the shipped defaults (mono / 16-bit / 48 kHz = 96 000 B/s) that is
 * 31.25 s, up from 1.42 s at the old 250 kB + stereo/16/44.1k defaults —
 * 22× longer AND correctly rate-tagged (see `samsloopAchievedRate`).
 *
 * The byte budget is not the only cap: `SAMSLOOP_RECORD_MAX_SECONDS` below
 * bounds the wall-clock length independently, and it is the binding one at
 * the low-fidelity settings.
 */
export const SAMSLOOP_RECORD_BUDGET_BYTES = 3_000_000;

/**
 * Hard ceiling on recording LENGTH, independent of the byte budget.
 *
 * ⚠ THIS IS AN ARCHITECTURE BOUNDARY, NOT A COMFORT LIMIT. A recording lives
 * in `node.data` and therefore syncs to every peer inside the rackspace
 * envelope. Past roughly a minute that model stops being the right one and
 * the TWOTRACKS model takes over — a worklet-owned buffer carried
 * out-of-band in the `.ptperf.zip`, which does NOT sync the audio to peers.
 * Raising this past ~60 s is an owner decision about that trade, not a
 * tuning knob.
 *
 * It binds wherever the settings are cheap enough that 3 MB would buy more
 * than a minute — e.g. mono / 8-bit / 22.05 kHz is 136 s of budget, capped
 * here to 60 s. At the defaults the BYTE budget binds first (31.25 s).
 */
export const SAMSLOOP_RECORD_MAX_SECONDS = 60;

/** Discrete option sets — the card's three toggle switches. Exposed as
 *  consts so the card, the helpers, and the tests share one source of
 *  truth (drift here ⇒ a mid-recording settings change makes the budget
 *  math disagree with the auto-stop trigger).
 *
 *  48 kHz is here because it is the rate almost every AudioContext actually
 *  runs at, which makes the resampler a genuine no-op rather than the
 *  mis-tagged one it used to be at 44.1 (see `samsloopAchievedRate`). */
export const SAMSLOOP_RATE_OPTIONS = [22_050, 44_100, 48_000] as const;
export const SAMSLOOP_BITS_OPTIONS = [8, 16] as const;
export const SAMSLOOP_CHANNELS_OPTIONS = [1, 2] as const;
export type SamsloopRecRate = (typeof SAMSLOOP_RATE_OPTIONS)[number];
export type SamsloopRecBits = (typeof SAMSLOOP_BITS_OPTIONS)[number];
export type SamsloopRecChannels = (typeof SAMSLOOP_CHANNELS_OPTIONS)[number];

/**
 * Default settings on a fresh module: MONO / 16-bit / 48 kHz = 31.25 s.
 *
 * Why each one moved off the old stereo / 16 / 44.1k (which bought 1.42 s):
 *
 *   - CHANNELS 2 → 1. The second channel was never heard. The playback
 *     worklet buffer is MONO and `decodeRecordedPcm(..., 'mix')` averages
 *     L+R before it gets there, so storing stereo doubled the byte cost to
 *     serve exactly one feature: DOWNLOAD writing a 2-channel WAV. The
 *     switch stays — this is a default, not a removal.
 *   - RATE 44 100 → 48 000. Not a fidelity flex: `downsample` decimates by
 *     an INTEGER factor, so from the usual 48 kHz context a 44.1 kHz target
 *     decimates by round(1.088) = 1 — no decimation at all, and the bytes
 *     used to be TAGGED 44 100 anyway. 48 kHz makes the no-op honest.
 *   - BITS unchanged at 16.
 */
export const SAMSLOOP_REC_DEFAULTS = {
  rate:     48_000 as SamsloopRecRate,
  bits:     16     as SamsloopRecBits,
  channels: 1      as SamsloopRecChannels,
} as const;

/** The persisted shape of a finished SAMSLOOP recording — `node.data.sample`.
 *  Mirrors the PICTUREBOX persistence pattern: the raw PCM rides the Yjs
 *  envelope as ONE opaque base64 string (never a `number[]`, which syncedstore
 *  wraps in a per-byte YArray and which blows the stack at insert).
 *
 *  The payload is HEADER-LESS PCM — interleaved when `channels === 2`,
 *  little-endian for 16-bit, signed-int8 for 8-bit. The WAV header is
 *  synthesized only on export (`makeWavBlob`); the PLAYBACK path decodes it
 *  back to Float32 via `decodeRecordedPcm` below.
 *
 *  ⚠ This interface previously declared `bytes: number[]` — a shape the card
 *  has never written and nothing has ever read (it had zero importers
 *  repo-wide while the shipped write path used `bytesB64: string`). It is now
 *  the REAL shape and is the single declaration both writers and readers use,
 *  so a drift like that one is a type error rather than dead documentation. */
export interface SamsloopRecordedSample {
  /** Base64-encoded raw PCM bytes. One flat Yjs value; length bounded by
   *  SAMSLOOP_RECORD_BUDGET_BYTES pre-encode (the string is ~4/3 of that). */
  bytesB64: string;
  /** The rate the stored samples ACTUALLY are — `samsloopAchievedRate` of
   *  the capture rate and the RATE switch, NOT the switch value itself.
   *  Deliberately a plain `number` and not `SamsloopRecRate`: integer
   *  decimation from a 48 kHz context reaches 48 000 / 24 000 / 16 000 …,
   *  which is not the menu. This is what the playback worklet scales its
   *  read cursor by, so tagging it with the request instead of the result
   *  detunes the take (measured: −148 cents, 8.8 % long). Recordings made
   *  before that fix keep their old tag and play exactly as they always
   *  have — nothing migrates them. */
  rate: number;
  /** Bit depth the recording was quantized to. One of SAMSLOOP_BITS_OPTIONS. */
  bits: SamsloopRecBits;
  /** Channel count. One of SAMSLOOP_CHANNELS_OPTIONS. */
  channels: SamsloopRecChannels;
  /** Raw byte length pre-base64 (so the card can show "8 kB" without
   *  decoding to count). */
  byteLength: number;
  /** Convenience field — same as byteLength / (channels * bytesPerSample) /
   *  rate. Stored so the card can show the duration without recomputing. */
  durationSec: number;
  /** `Date.now()` at commit. NOT decoration: it is what makes the playback
   *  poll's change-signature EXACT. Every other field of a re-recording at
   *  unchanged settings can repeat (same length ⇒ same byteLength, rate, bits,
   *  channels), so a signature built from them alone would alias two different
   *  takes and the worklet would keep playing the FIRST one. Optional because
   *  recordings persisted before it existed do not carry it — those fall back
   *  to the length-based signature, which is exactly as good as it ever was. */
  recordedAt?: number;
}

/**
 * The integer decimation factor `downsample` will actually use.
 *
 * ⚠ EXPORTED SO NOTHING RE-DERIVES IT. `downsample` calls this, the
 * achieved-rate helper calls this, and the card's capture-capacity math
 * calls this. Three copies of `Math.round(src/dst)` is precisely how the
 * tagging bug below stayed alive.
 */
export function samsloopDecimationFactor(srcRate: number, dstRate: number): number {
  if (srcRate <= 0 || dstRate <= 0) return 1;
  if (srcRate <= dstRate) return 1;
  return Math.max(1, Math.round(srcRate / dstRate));
}

/**
 * THE RATE THE BYTES ACTUALLY ARE — which is NOT the rate the user picked.
 *
 * ⚠ THIS FUNCTION EXISTS BECAUSE ITS ABSENCE WAS AN AUDIBLE BUG. `downsample`
 * decimates by an INTEGER factor, so from a 48 kHz AudioContext:
 *
 *   RATE switch 44 100 → factor round(1.088) = 1 → samples stay 48 000 Hz
 *   RATE switch 22 050 → factor round(2.177) = 2 → samples become 24 000 Hz
 *
 * Neither equals the switch. The old code tagged the take with the SWITCH
 * value anyway, and the playback worklet scales its read cursor by
 * bufferRate/contextRate — so `rateScale` came out 44100/48000 = 0.919 and
 * everything played back FLAT AND LONG. Measured against a 1000 Hz
 * reference: 918.3 Hz, −148 cents, 8.8 % long, at BOTH switch positions.
 * Only a 44.1 kHz AudioContext was ever correct.
 *
 * The fix is not a better resampler — it is telling the truth about the one
 * we have. `encodeRecordingBytes` returns this value alongside the bytes so
 * a caller cannot tag a buffer with a rate it merely requested.
 *
 * (Existing recordings keep whatever tag they were written with. They sound
 * exactly as they always have; nothing migrates them. Owner ruling.)
 */
export function samsloopAchievedRate(srcRate: number, dstRate: number): number {
  if (srcRate <= 0 || dstRate <= 0) return 0;
  return srcRate / samsloopDecimationFactor(srcRate, dstRate);
}

/**
 * Maximum recording length in seconds for the given settings — the LOWER of
 * the byte budget and the hard length cap. Used as the live-record bar's
 * horizontal axis (waveform fills the bar over `maxSeconds` of capture) AND
 * as the auto-stop trigger.
 *
 * `min(SAMSLOOP_RECORD_BUDGET_BYTES / (rate · bytesPerSample · channels),
 *      SAMSLOOP_RECORD_MAX_SECONDS)`
 *
 * ⚠ `rate` is the ACHIEVED rate (`samsloopAchievedRate`), not the RATE
 * switch. Passing the switch value is how the encoder came to emit 272 640
 * bytes against a 250 000 budget and get silently trimmed on every take.
 *
 * Pinned in `samsloop-record.test.ts`'s 12-cell table:
 *   mono  8-bit 22k = 60.00 s†  stereo  8-bit 22k = 60.00 s†
 *   mono 16-bit 22k = 60.00 s†  stereo 16-bit 22k = 34.01 s
 *   mono  8-bit 44k = 60.00 s†  stereo  8-bit 44k = 34.01 s
 *   mono 16-bit 44k = 34.01 s   stereo 16-bit 44k = 17.01 s
 *   mono  8-bit 48k = 60.00 s†  stereo  8-bit 48k = 31.25 s
 *   mono 16-bit 48k = 31.25 s   stereo 16-bit 48k = 15.63 s
 *                     ^ DEFAULT
 *   († = the 60 s length cap binds, not the byte budget.)
 */
export function samsloopMaxSeconds(
  rate: number,
  bits: number,
  channels: number,
): number {
  // Round to 2 decimal places (banker's rounding via Math.round is fine
  // for display + auto-stop trigger). The actual byte-count check uses
  // the unrounded value internally — `samsloopMaxSeconds` is for the UI
  // label + the bar's x-axis scale.
  return Math.round(samsloopMaxSecondsExact(rate, bits, channels) * 100) / 100;
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
  const bytesPerSecond = rate * Math.ceil(bits / 8) * channels;
  if (bytesPerSecond <= 0) return 0;
  return Math.min(
    SAMSLOOP_RECORD_BUDGET_BYTES / bytesPerSecond,
    SAMSLOOP_RECORD_MAX_SECONDS,
  );
}

/**
 * How many CAPTURE-rate frames the card may accumulate before the encoded
 * result would breach either cap — i.e. the exact size to pre-allocate.
 *
 * Derived rather than guessed: `downsample` emits
 * `floor(captureFrames / factor)` stored frames, so the largest capture
 * that still encodes to ≤ budget is `storedFramesBudget × factor`. Sizing
 * the accumulator to this is what makes the encoder's output provably ≤
 * `SAMSLOOP_RECORD_BUDGET_BYTES` — so the card's "safety net" trim (which
 * used to fire on EVERY take, silently cutting ~0.118 s) becomes genuinely
 * unreachable rather than merely unlikely. Pinned by a unit test that
 * encodes a full-capacity capture at every settings combination.
 */
export function samsloopMaxCaptureFrames(
  captureRate: number,
  dstRate: number,
  bits: SamsloopRecBits,
  channels: SamsloopRecChannels,
): number {
  if (captureRate <= 0) return 0;
  const achieved = samsloopAchievedRate(captureRate, dstRate);
  const maxSec = samsloopMaxSecondsExact(achieved, bits, channels);
  if (maxSec <= 0) return 0;
  const factor = samsloopDecimationFactor(captureRate, dstRate);
  const storedFrames = Math.floor(maxSec * achieved);
  return storedFrames * factor;
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
 * suppress aliasing. Picks `factor = samsloopDecimationFactor(src, dst)`
 * and averages every `factor` samples; the running 1-pole smoother
 * attenuates frequencies near the new Nyquist before decimation.
 *
 * Used to bring AudioContext-rate Float32 samples (typically 48 kHz)
 * down to the user-chosen RATE switch (22 050 / 44 100 / 48 000 Hz).
 * Returns the input unchanged when `srcRate <= dstRate` (no upsampling —
 * we never need to add bandwidth, only remove it).
 *
 * ⚠ THE OUTPUT IS NOT AT `dstRate` IN GENERAL. Integer decimation can only
 * hit `srcRate / n`; ask for 44 100 from 48 000 and you get 48 000 back
 * unchanged. `samsloopAchievedRate(srcRate, dstRate)` is what the result
 * must be tagged with, and `encodeRecordingBytes` returns it for you.
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
  const factor = samsloopDecimationFactor(srcRate, dstRate);
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
 * (downsampled + quantized + interleaved if stereo).
 *
 * ⚠ RETURNS `{ bytes, rate }`, AND THE `rate` IS THE POINT — read it, never
 * re-use `dstRate` afterwards. `dstRate` is what the user ASKED for;
 * `rate` is what the samples ACTUALLY are after integer decimation
 * (`samsloopAchievedRate`). The card used to persist the request, so a
 * 48 kHz capture at the 44.1 kHz switch position played back 148 cents
 * flat and 8.8 % long. Returning both from the one function that knows the
 * answer is what makes writing the wrong one hard, the same way
 * `postSampleBuffer` returns its frame count to make a post-transfer
 * `f32.length` read hard (samsloop.ts).
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
): { bytes: Uint8Array; rate: number } {
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

  const rate = samsloopAchievedRate(srcRate, dstRate);
  if (bits === 16) {
    const q = quantizeF32ToI16(pre);
    return { bytes: new Uint8Array(q.buffer, q.byteOffset, q.byteLength), rate };
  } else {
    const q = quantizeF32ToI8(pre);
    return { bytes: new Uint8Array(q.buffer, q.byteOffset, q.byteLength), rate };
  }
}

/**
 * FIXED-CAPACITY L/R capture accumulator — what the card writes every tap
 * chunk into while REC is held.
 *
 * ⚠ THIS REPLACES AN O(n²) GROW-COPY, AND THAT WAS THE REAL LIMIT ON
 * RECORDING LENGTH. The card used to allocate a new `Float32Array` the size
 * of the whole take so far and copy into it, PER CHANNEL, on every chunk —
 * and the tap posts 375 chunks/second (48 kHz / 128 samples). Total bytes
 * memcpy'd grows as the square of the take: 145 MB for the 1.42 s the old
 * budget allowed, 259 GB for 60 s, which measured at ~14 % of a core spent
 * on the MAIN THREAD — the same thread as the audio scheduler, which this
 * repo already knows underruns under pressure (`clock-perf-glitch-output-
 * underrun`). Raising the byte budget without fixing this would have
 * shipped a module that degrades the longer you hold REC.
 * Measured for a 60 s take: 8543 ms of copying → 1.7 ms.
 *
 * WHY NOT `AudioRingBuffer` (`$lib/video/recorderbox-audio-ring`), the
 * repo's other capture buffer — three structural reasons, not preference:
 *   1. It is a ROLLING window: once full it discards the OLDEST frames. A
 *      REC must keep the take from its START and stop at the cap (that is
 *      what `stopReason: 'cap'` and the left-to-right fill bar mean).
 *      Reusing it would silently change WHICH 31 s of a long hold you keep.
 *   2. `pushChunk` takes one PLANAR `[L…,R…]` block; the samsloop tap posts
 *      two separate `Float32Array`s per chunk. Adapting means an extra
 *      per-chunk copy into a staging buffer — re-introducing the per-chunk
 *      allocation this class exists to remove.
 *   3. `snapshotPlanar()` allocates and copies `2n` floats; this hands the
 *      encoder zero-copy `subarray` views.
 * They are two different primitives with the same shape. Kept separate, and
 * cross-referenced from both sides so the next reader sees the choice.
 */
export class SamsloopCaptureBuffer {
  /** Frames this buffer can hold. Sized by `samsloopMaxCaptureFrames`. */
  readonly capacityFrames: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private written = 0;

  constructor(capacityFrames: number) {
    this.capacityFrames = Math.max(0, Math.floor(capacityFrames));
    this.bufL = new Float32Array(this.capacityFrames);
    this.bufR = new Float32Array(this.capacityFrames);
  }

  /** Frames captured so far (0..capacity). */
  get frames(): number {
    return this.written;
  }

  /** True once the capacity is reached — the card's auto-stop trigger. */
  get full(): boolean {
    return this.written >= this.capacityFrames;
  }

  /**
   * Append one tap chunk. Writes `min(chunk length, remaining capacity)`
   * frames and returns how many it took, so a caller can tell a clean stop
   * from a dropped tail. Over-long chunks are TRUNCATED, never wrapped —
   * the head of the take is what we keep.
   */
  append(l: Float32Array, r: Float32Array): number {
    const room = this.capacityFrames - this.written;
    if (room <= 0) return 0;
    const n = Math.min(room, l.length, r.length);
    if (n <= 0) return 0;
    // `set` on a subarray view is a single memcpy of exactly n frames — no
    // allocation, no growth, O(chunk) not O(take).
    this.bufL.set(n === l.length ? l : l.subarray(0, n), this.written);
    this.bufR.set(n === r.length ? r : r.subarray(0, n), this.written);
    this.written += n;
    return n;
  }

  /** Zero-copy views of exactly the captured frames. Valid until the next
   *  `append`; the encoder consumes them immediately on STOP. */
  channels(): { l: Float32Array; r: Float32Array } {
    return {
      l: this.bufL.subarray(0, this.written),
      r: this.bufR.subarray(0, this.written),
    };
  }
}

/**
 * The `node.data` keys an UPLOAD owns. The RECORD commit deletes every one of
 * them, and the upload commit deletes `sample` — that pair of deletes IS the
 * module's one-sample invariant ("a new upload or recording REPLACES the
 * previous one", samsloop.ts header) expressed in the data rather than in
 * prose. It lives here, as one list both writers import, because the failure
 * mode is a writer that forgets one key: the two sources then coexist and the
 * READER's precedence, not the user's last action, silently decides what
 * plays. That is the shape of the P0 this file's decoder exists to fix.
 */
export const SAMSLOOP_UPLOAD_DATA_KEYS = [
  'fileBytesB64',
  'samples',
  'fileName',
  'fileSize',
  'fileMime',
  'sampleLength',
  'sampleRate',
] as const;

/**
 * Delete every upload key from a LIVE `node.data`, guarding each one on
 * presence.
 *
 * ⚠ THE GUARD IS NOT DEFENSIVE PADDING — an unguarded `delete` here THROWS.
 * `node.data` is a syncedStore proxy over a Y.Map and its `deleteProperty`
 * trap returns falsish for a key the map does not hold, which V8 reports as
 * `TypeError: 'deleteProperty' on proxy: trap returned falsish`. So the
 * ordinary case — REC with no previous upload, i.e. most recordings — is
 * exactly the case that would blow up mid-commit and abandon the take. (The
 * shipped card only ever deleted under an `if (d.samples)`, which is why this
 * never surfaced; it is stated here so the next writer does not rediscover it
 * in production.)
 */
export function clearSamsloopUploadKeys(d: Record<string, unknown>): void {
  for (const k of SAMSLOOP_UPLOAD_DATA_KEYS) {
    if (k in d) delete d[k];
  }
}

/**
 * Assemble the persisted record of a finished take — the whole of what REC
 * commits, as a pure function of the encoded bytes and the three settings.
 *
 * Extracted from the card so the commit SHAPE is unit-testable: the P0 was a
 * writer and a reader that disagreed about a key, and neither side had a test
 * that named the other. Now `resolveSamsloopSource` can be asserted directly
 * against this function's output, so "what REC writes is what playback reads"
 * is a checkable statement rather than two files that happen to agree.
 *
 * `frames` is the DECODED length — `decodeRecordedPcm` of the returned sample
 * returns exactly this many samples — which is what the START/END window and
 * the card's faders bound against.
 */
export function buildRecordedSample(
  bytes: Uint8Array,
  /** The ACHIEVED rate — `encodeRecordingBytes(...).rate`, never the RATE
   *  switch value. See `SamsloopRecordedSample.rate`. */
  rate: number,
  bits: SamsloopRecBits,
  channels: SamsloopRecChannels,
  now: number = Date.now(),
): { sample: SamsloopRecordedSample; frames: number } {
  const bytesPerSample = Math.ceil(bits / 8);
  const frames = Math.floor(bytes.byteLength / (bytesPerSample * channels));
  return {
    frames,
    sample: {
      bytesB64: bytesToBase64(bytes),
      rate,
      bits,
      channels,
      byteLength: bytes.byteLength,
      durationSec: frames / rate,
      recordedAt: now,
    },
  };
}

/**
 * THE INVERSE OF `encodeRecordingBytes` — persisted PCM bytes back to Float32.
 *
 * ⚠ THIS FUNCTION EXISTS BECAUSE ITS ABSENCE WAS A P0. The record path wrote
 * `node.data.sample.bytesB64` and the engine factory read only
 * `node.data.fileBytesB64` / `node.data.samples`, so **a recorded sample never
 * reached the worklet and the module was silent after REC** — while the
 * waveform redrew, the download worked and the bytes round-tripped through
 * save/load intact. The two sides now share ONE decoder: the playback path and
 * the card's waveform preview call this, so a future change to the storage
 * form cannot make one of them right and the other wrong.
 *
 * `channel` picks what a stereo recording collapses to:
 *   * `'mix'`  — average L+R. What PLAYBACK wants: the worklet buffer is mono
 *                and this is the same collapse the upload path applies to a
 *                stereo file (samsloop.ts's decode → mono-mix).
 *   * `'left'` — L only. What the WAVEFORM draws (a peak trace of one channel
 *                keeps its shape stable regardless of the CHAN setting).
 *
 * Mono recordings are identical under both. Returns an EMPTY array — never
 * null — for an empty/undecodable payload, so callers can treat "no audio" and
 * "zero frames" the same way.
 */
export function decodeRecordedPcm(
  sample: Pick<SamsloopRecordedSample, 'bytesB64' | 'bits' | 'channels'>,
  channel: 'mix' | 'left' = 'mix',
): Float32Array {
  if (!sample.bytesB64) return new Float32Array(0);
  const bytes = base64ToBytes(sample.bytesB64);
  const bytesPerSample = Math.ceil(sample.bits / 8);
  const stride = bytesPerSample * sample.channels;
  if (stride <= 0) return new Float32Array(0);
  const frames = Math.floor(bytes.byteLength / stride);
  const out = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stereoMix = sample.channels === 2 && channel === 'mix';
  for (let i = 0; i < frames; i++) {
    const off = i * stride;
    if (sample.bits === 16) {
      // Little-endian signed int16, scaled by 0x7fff — the exact inverse of
      // quantizeF32ToI16's symmetric clip-and-scale.
      const l = view.getInt16(off, true) / 0x7fff;
      out[i] = stereoMix ? (l + view.getInt16(off + 2, true) / 0x7fff) * 0.5 : l;
    } else {
      // 8-bit is stored as SIGNED int8 (our quantizer's output cast to uint8 =
      // the raw two's-complement byte), NOT the unsigned form WAV files use —
      // makeWavBlob does the +128 shift only on export.
      const l = ((view.getUint8(off) << 24) >> 24) / 0x7f;
      out[i] = stereoMix ? (l + (((view.getUint8(off + 1) << 24) >> 24) / 0x7f)) * 0.5 : l;
    }
  }
  return out;
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
