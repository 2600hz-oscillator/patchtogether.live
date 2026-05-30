// packages/web/src/lib/audio/modules/samsloop-record.test.ts
//
// Unit tests for the SAMSLOOP recording helpers — pure functions, no
// AudioContext involved.
//
// What's pinned here:
//   1. samsloopMaxSeconds — the 8-cell rate × bits × channels table the
//      spec calls out. Drift here means the live-record bar's x-axis
//      stops matching the auto-stop trigger.
//   2. quantizeF32ToI16 / quantizeF32ToI8 — clip + scale to the canonical
//      signed-int-PCM range with NO DC bias on silence.
//   3. downsample — integer-factor decimation with the LP pre-filter;
//      length math + DC preservation.
//   4. makeWavBlob — the 44-byte header bytes match the WAV spec EXACTLY
//      (so a downloaded file plays back in any standard WAV reader).
//   5. encodeRecordingBytes — end-to-end pipeline (resample → quantize →
//      interleave) returns the right byte length for known L/R inputs.
//   6. samsloopDownloadFilename — `samsloop-YYYYMMDD-HHmmss.wav` format.

import { describe, expect, it } from 'vitest';
import {
  samsloopMaxSeconds,
  samsloopMaxSecondsExact,
  quantizeF32ToI16,
  quantizeF32ToI8,
  downsample,
  makeWavBlob,
  encodeRecordingBytes,
  samsloopDownloadFilename,
  bytesToBase64,
  base64ToBytes,
  SAMSLOOP_RECORD_BUDGET_BYTES,
  SAMSLOOP_REC_DEFAULTS,
  SAMSLOOP_RATE_OPTIONS,
  SAMSLOOP_BITS_OPTIONS,
  SAMSLOOP_CHANNELS_OPTIONS,
} from './samsloop-record';

// ---------- (1) samsloopMaxSeconds — the 8-cell pinned table ----------

describe('samsloopMaxSeconds — rate × bits × channels table', () => {
  it('250 kB byte budget is the cap', () => {
    expect(SAMSLOOP_RECORD_BUDGET_BYTES).toBe(250_000);
  });

  // The spec's table (rounded to 2 decimals):
  //   mono   8-bit  22k = 11.34 s   stereo 8-bit  22k = 5.67 s
  //   mono  16-bit  22k =  5.67 s   stereo 16-bit 22k = 2.83 s
  //   mono   8-bit  44k =  5.67 s   stereo 8-bit  44k = 2.83 s   (spec said 5.66 — typo in the brief, mathematically equal to mono 16-bit 22k = 5.67)
  //   mono  16-bit  44k =  2.83 s   stereo 16-bit 44k = 1.42 s
  it.each([
    // [rate, bits, channels, expected seconds]
    [22_050, 8,  1, 11.34],
    [22_050, 16, 1, 5.67],
    [44_100, 8,  1, 5.67],
    [44_100, 16, 1, 2.83],
    [22_050, 8,  2, 5.67],
    [22_050, 16, 2, 2.83],
    [44_100, 8,  2, 2.83],
    [44_100, 16, 2, 1.42],
  ])('rate=%i bits=%i channels=%i → %f s', (rate, bits, channels, expected) => {
    expect(samsloopMaxSeconds(rate, bits, channels)).toBeCloseTo(expected, 2);
  });

  it('returns 0 for non-positive inputs (defensive)', () => {
    expect(samsloopMaxSeconds(0, 16, 1)).toBe(0);
    expect(samsloopMaxSeconds(44100, 0, 1)).toBe(0);
    expect(samsloopMaxSeconds(44100, 16, 0)).toBe(0);
    expect(samsloopMaxSeconds(-1, 16, 1)).toBe(0);
  });

  it('exact + rounded helpers agree to 2 decimals', () => {
    for (const r of SAMSLOOP_RATE_OPTIONS) {
      for (const b of SAMSLOOP_BITS_OPTIONS) {
        for (const c of SAMSLOOP_CHANNELS_OPTIONS) {
          expect(samsloopMaxSeconds(r, b, c)).toBeCloseTo(
            samsloopMaxSecondsExact(r, b, c),
            2,
          );
        }
      }
    }
  });

  it('defaults: 44.1 kHz / 16-bit / 2 ch = 1.42 s budget', () => {
    expect(
      samsloopMaxSeconds(
        SAMSLOOP_REC_DEFAULTS.rate,
        SAMSLOOP_REC_DEFAULTS.bits,
        SAMSLOOP_REC_DEFAULTS.channels,
      ),
    ).toBeCloseTo(1.42, 2);
  });
});

// ---------- (2) quantizeF32ToI16 ----------

describe('quantizeF32ToI16', () => {
  it('silence → all zeros', () => {
    const out = quantizeF32ToI16(new Float32Array([0, 0, 0, 0]));
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it('+1.0 → +32767 (peak positive), -1.0 → -32767 (symmetric peak negative)', () => {
    const out = quantizeF32ToI16(new Float32Array([1.0, -1.0]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32767);
  });

  it('clips out-of-range samples symmetrically', () => {
    const out = quantizeF32ToI16(new Float32Array([2.5, -3.7, 0.5, -0.5]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32767);
    expect(out[2]).toBe(Math.round(0.5 * 32767));
    expect(out[3]).toBe(Math.round(-0.5 * 32767));
  });

  it('intermediate values quantize to the rounded multiple', () => {
    // 0.25 → 0.25 * 32767 = 8191.75 → round = 8192
    const out = quantizeF32ToI16(new Float32Array([0.25, -0.25, 0.75, -0.75]));
    expect(out[0]).toBe(8192);
    expect(out[1]).toBe(-8192);
    expect(out[2]).toBe(Math.round(0.75 * 32767));
    expect(out[3]).toBe(Math.round(-0.75 * 32767));
  });
});

// ---------- (3) quantizeF32ToI8 ----------

describe('quantizeF32ToI8', () => {
  it('silence → all zeros', () => {
    const out = quantizeF32ToI8(new Float32Array([0, 0, 0, 0]));
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it('+1.0 → +127, -1.0 → -127 (symmetric int8)', () => {
    const out = quantizeF32ToI8(new Float32Array([1.0, -1.0]));
    expect(out[0]).toBe(127);
    expect(out[1]).toBe(-127);
  });

  it('clips out-of-range samples symmetrically', () => {
    const out = quantizeF32ToI8(new Float32Array([2.0, -2.0]));
    expect(out[0]).toBe(127);
    expect(out[1]).toBe(-127);
  });

  it('intermediate values quantize to the rounded multiple', () => {
    // 0.5 → 0.5 * 127 = 63.5 → round = 64 (banker's rounding in JS → 64)
    const out = quantizeF32ToI8(new Float32Array([0.5, -0.5]));
    expect(out[0]).toBe(Math.round(0.5 * 127));
    expect(out[1]).toBe(Math.round(-0.5 * 127));
  });
});

// ---------- (4) downsample ----------

describe('downsample', () => {
  it('returns input unchanged when src <= dst (no upsample)', () => {
    const buf = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsample(buf, 22050, 44100)).toBe(buf);
    expect(downsample(buf, 22050, 22050)).toBe(buf);
  });

  it('halves length for 48 kHz → 24 kHz (factor 2)', () => {
    const buf = new Float32Array(100).fill(0.5);
    const out = downsample(buf, 48000, 24000);
    expect(out.length).toBe(50);
  });

  it('preserves DC level (constant input → constant output ± LP transient)', () => {
    const buf = new Float32Array(100).fill(0.42);
    const out = downsample(buf, 44100, 22050);
    expect(out.length).toBe(50);
    // After the 1-pole settles (a few samples in), the DC value should
    // be very close to 0.42. Check from sample 10 onwards.
    for (let i = 10; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(0.42, 3);
    }
  });

  it('attenuates a fast-alternating signal (LP behavior)', () => {
    // [+1, -1, +1, -1, ...] at srcRate is the Nyquist tone. Downsampling
    // factor 2 with a box-average alone would give 0 (perfect alias
    // cancellation); the IIR pre-filter biases this to also near 0.
    // We assert |out[i]| < |in[i]| — the high-frequency content is gone.
    const buf = new Float32Array(100);
    for (let i = 0; i < 100; i++) buf[i] = i % 2 === 0 ? 1 : -1;
    const out = downsample(buf, 48000, 24000);
    let maxAbs = 0;
    for (let i = 10; i < out.length; i++) maxAbs = Math.max(maxAbs, Math.abs(out[i]!));
    expect(maxAbs).toBeLessThan(0.2);
  });

  it('returns empty for 0 src rate (defensive)', () => {
    expect(downsample(new Float32Array([1, 2, 3]), 0, 22050).length).toBe(0);
    expect(downsample(new Float32Array([1, 2, 3]), 44100, 0).length).toBe(0);
  });
});

// ---------- (5) makeWavBlob — RIFF/WAVE header byte-for-byte ----------

describe('makeWavBlob — 44-byte header matches the WAV spec', () => {
  async function readHeader(blob: Blob): Promise<DataView> {
    const ab = await blob.arrayBuffer();
    return new DataView(ab);
  }

  it('16-bit mono 44.1 kHz: every header field at the spec offsets', async () => {
    // 4 samples of silence as Int16 (8 bytes payload).
    const samples = new Int16Array([0, 100, -100, 0]);
    const bytesView = new Uint8Array(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength,
    );
    const blob = makeWavBlob(bytesView, 44100, 16, 1);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 8); // header + data
    const v = await readHeader(blob);
    expect(v.getUint32(0, false)).toBe(0x52494646);          // "RIFF"
    expect(v.getUint32(4, true)).toBe(44 + 8 - 8);            // fileSize - 8
    expect(v.getUint32(8, false)).toBe(0x57415645);          // "WAVE"
    expect(v.getUint32(12, false)).toBe(0x666d7420);         // "fmt "
    expect(v.getUint32(16, true)).toBe(16);                  // fmt chunk size
    expect(v.getUint16(20, true)).toBe(1);                   // PCM format
    expect(v.getUint16(22, true)).toBe(1);                   // mono
    expect(v.getUint32(24, true)).toBe(44100);               // sample rate
    expect(v.getUint32(28, true)).toBe(44100 * 1 * 2);       // byte rate
    expect(v.getUint16(32, true)).toBe(2);                   // block align
    expect(v.getUint16(34, true)).toBe(16);                  // bits per sample
    expect(v.getUint32(36, false)).toBe(0x64617461);         // "data"
    expect(v.getUint32(40, true)).toBe(8);                   // data chunk size
    // Body bytes after the 44-byte header should match the Int16 buffer.
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(100);
    expect(v.getInt16(48, true)).toBe(-100);
    expect(v.getInt16(50, true)).toBe(0);
  });

  it('16-bit stereo 22050: byteRate / blockAlign reflect channels', async () => {
    const samples = new Int16Array(8); // 4 frames × 2 ch = 16 bytes
    const bytesView = new Uint8Array(samples.buffer);
    const blob = makeWavBlob(bytesView, 22050, 16, 2);
    expect(blob.size).toBe(44 + 16);
    const v = await readHeader(blob);
    expect(v.getUint16(22, true)).toBe(2);                  // stereo
    expect(v.getUint32(24, true)).toBe(22050);
    expect(v.getUint32(28, true)).toBe(22050 * 2 * 2);      // byteRate
    expect(v.getUint16(32, true)).toBe(2 * 2);              // blockAlign
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(16);
  });

  it('8-bit signed Int8 input → unsigned uint8 PCM body (WAV convention)', async () => {
    // Int8: -1, 0, +1, -64, +63
    const samples = new Int8Array([-1, 0, 1, -64, 63]);
    const bytesView = new Uint8Array(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength,
    );
    const blob = makeWavBlob(bytesView, 22050, 8, 1);
    expect(blob.size).toBe(44 + 5);
    const v = await readHeader(blob);
    expect(v.getUint16(34, true)).toBe(8);
    // WAV 8-bit PCM is UNSIGNED, centered on 128. Our quantizer emits
    // signed values; makeWavBlob shifts by +128. So:
    //   -1 → 127, 0 → 128, +1 → 129, -64 → 64, +63 → 191
    expect(v.getUint8(44)).toBe(127);
    expect(v.getUint8(45)).toBe(128);
    expect(v.getUint8(46)).toBe(129);
    expect(v.getUint8(47)).toBe(64);
    expect(v.getUint8(48)).toBe(191);
  });

  it('body length equals the input bytes.byteLength (16-bit)', async () => {
    const samples = new Int16Array(200);
    for (let i = 0; i < 200; i++) samples[i] = i;
    const bytesView = new Uint8Array(samples.buffer);
    const blob = makeWavBlob(bytesView, 44100, 16, 1);
    expect(blob.size).toBe(44 + samples.byteLength); // 44 + 400 = 444
  });

  it('round-trip: RIFF/WAVE/fmt /data ASCII codes match the parser', async () => {
    // Cross-check against the parseWavManually constants in samsloop.ts.
    const blob = makeWavBlob(new Int16Array([0]), 22050, 16, 1);
    const v = new DataView(await blob.arrayBuffer());
    expect(v.getUint32(0, false)).toBe(0x52494646);
    expect(v.getUint32(8, false)).toBe(0x57415645);
    expect(v.getUint32(12, false)).toBe(0x666d7420);
    expect(v.getUint32(36, false)).toBe(0x64617461);
  });
});

// ---------- (6) encodeRecordingBytes — end-to-end pipeline ----------

describe('encodeRecordingBytes', () => {
  it('mono 8-bit at native rate (no downsample) → 1 byte per sample', () => {
    const l = new Float32Array([0, 0.5, -0.5, 1.0]);
    const r = new Float32Array(4); // ignored for mono
    const bytes = encodeRecordingBytes(l, r, 22050, 22050, 8, 1);
    expect(bytes.byteLength).toBe(4); // mono 8-bit at the same rate
  });

  it('stereo 16-bit at native rate → 4 bytes per frame (interleaved L,R)', () => {
    const l = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const r = new Float32Array([-0.5, -0.5, -0.5, -0.5]);
    const bytes = encodeRecordingBytes(l, r, 22050, 22050, 16, 2);
    expect(bytes.byteLength).toBe(4 * 2 * 2); // 4 frames × 2 ch × 2 bytes
    // Reinterpret as Int16 (little-endian native) and check interleaving.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getInt16(0, true)).toBe(Math.round(0.5 * 32767));   // L
    expect(view.getInt16(2, true)).toBe(Math.round(-0.5 * 32767));  // R
    expect(view.getInt16(4, true)).toBe(Math.round(0.5 * 32767));   // L
    expect(view.getInt16(6, true)).toBe(Math.round(-0.5 * 32767));  // R
  });

  it('mono 16-bit @ 22050 from 44100 source → halves the length post-downsample', () => {
    const l = new Float32Array(200).fill(0.25);
    const r = new Float32Array(200);
    const bytes = encodeRecordingBytes(l, r, 44100, 22050, 16, 1);
    // 200 samples → 100 post-downsample → 100 * 2 bytes = 200 bytes.
    expect(bytes.byteLength).toBe(200);
  });

  it('stays under the 250 kB budget at the slowest settings (sanity)', () => {
    // 2.83 s of stereo 16-bit @ 44.1k = 2.83 * 44100 * 4 bytes ≈ 250 kB.
    // We capture a 1-second buffer here, well under cap.
    const l = new Float32Array(48000).fill(0);
    const r = new Float32Array(48000).fill(0);
    const bytes = encodeRecordingBytes(l, r, 48000, 44100, 16, 2);
    expect(bytes.byteLength).toBeLessThan(SAMSLOOP_RECORD_BUDGET_BYTES);
  });
});

// ---------- (6b) bytesToBase64 / base64ToBytes round-trip ----------
//
// Yjs-safe storage form for the recorded sample. A 144 kB number[] would
// recurse syncedstore's YArray wrapper and blow the stack at insert; a
// base64 string is one opaque value, one Yjs update. The two functions
// here are exported from samsloop-record.ts so the card AND the e2e
// tests share one source of truth.

describe('bytesToBase64 / base64ToBytes', () => {
  it('round-trips empty bytes to "" and back', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('').length).toBe(0);
  });

  it('round-trips small known bytes to the standard base64 alphabet', () => {
    // "hello" = 68 65 6c 6c 6f → "aGVsbG8="
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(bytesToBase64(bytes)).toBe('aGVsbG8=');
    const back = base64ToBytes('aGVsbG8=');
    expect(Array.from(back)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('round-trips a large buffer (250 kB) without stack overflow', () => {
    // The whole point — 250 kB simulates the recording-budget worst case.
    // Without the chunked String.fromCharCode trick this would overflow
    // on most engines (apply() spreads the array as args; max ~65535).
    const bytes = new Uint8Array(250_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const b64 = bytesToBase64(bytes);
    expect(b64.length).toBeGreaterThan(bytes.length); // base64 is ~4/3 of raw
    const back = base64ToBytes(b64);
    expect(back.length).toBe(bytes.length);
    // Spot-check a few positions.
    expect(back[0]).toBe(0);
    expect(back[12345]).toBe(12345 & 0xff);
    expect(back[bytes.length - 1]).toBe((bytes.length - 1) & 0xff);
  });
});

// ---------- (7) samsloopDownloadFilename ----------

describe('samsloopDownloadFilename', () => {
  it('formats samsloop-YYYYMMDD-HHmmss.wav', () => {
    const date = new Date(2026, 4, 30, 14, 5, 9); // 2026-05-30 14:05:09
    const name = samsloopDownloadFilename(date);
    expect(name).toBe('samsloop-20260530-140509.wav');
  });

  it('pads months / days / hours / mins / secs with leading zero', () => {
    const date = new Date(2026, 0, 1, 0, 0, 0);
    expect(samsloopDownloadFilename(date)).toBe('samsloop-20260101-000000.wav');
  });

  it('ends with .wav', () => {
    expect(samsloopDownloadFilename(new Date())).toMatch(/\.wav$/);
  });
});
