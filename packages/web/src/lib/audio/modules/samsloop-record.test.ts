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
  samsloopMaxCaptureFrames,
  samsloopAchievedRate,
  samsloopDecimationFactor,
  quantizeF32ToI16,
  quantizeF32ToI8,
  downsample,
  makeWavBlob,
  encodeRecordingBytes,
  decodeRecordedPcm,
  samsloopDownloadFilename,
  bytesToBase64,
  base64ToBytes,
  SamsloopCaptureBuffer,
  SAMSLOOP_RECORD_BUDGET_BYTES,
  SAMSLOOP_RECORD_MAX_SECONDS,
  SAMSLOOP_REC_DEFAULTS,
  SAMSLOOP_RATE_OPTIONS,
  SAMSLOOP_BITS_OPTIONS,
  SAMSLOOP_CHANNELS_OPTIONS,
  type SamsloopRecBits,
  type SamsloopRecChannels,
} from './samsloop-record';

// ---------- (1) samsloopMaxSeconds — the 12-cell pinned table ----------

describe('samsloopMaxSeconds — rate × bits × channels table', () => {
  it('the byte budget is 3 MB, and its derivation is the reason it is that', () => {
    // The OLD value (250 000) is what this PR fixed: it was cloned from the
    // uploaded-file cap and then orphaned when that cap was raised 8× to 2 MB,
    // leaving a module that LOADED 62.5 s and RECORDED 1.42 s. The new number
    // is derived (see the constant's comment) rather than inherited:
    //   3 MB raw → ×4/3 base64 → 4 MB in node.data → ≤25 % of the relay's
    //   16 MB per-rack warn threshold for ONE recording.
    expect(SAMSLOOP_RECORD_BUDGET_BYTES).toBe(3_000_000);
    // base64 of a full-budget take stays inside a quarter of the warn budget.
    const b64Bytes = Math.ceil(SAMSLOOP_RECORD_BUDGET_BYTES / 3) * 4;
    const relayWarnBytes = 16 * 1024 * 1024;
    expect(b64Bytes / relayWarnBytes).toBeLessThanOrEqual(0.25);
  });

  it('the LENGTH cap is 60 s — the node.data/TWOTRACKS architecture boundary', () => {
    // Past ~60 s a recording should stop riding node.data (which syncs it to
    // every peer) and become a worklet-owned, out-of-band buffer like
    // TWOTRACKS. Raising this is an owner decision, so it is pinned here.
    expect(SAMSLOOP_RECORD_MAX_SECONDS).toBe(60);
    // …and NO settings combination can exceed it, which is the property that
    // makes the boundary real rather than advisory.
    for (const r of SAMSLOOP_RATE_OPTIONS) {
      for (const b of SAMSLOOP_BITS_OPTIONS) {
        for (const c of SAMSLOOP_CHANNELS_OPTIONS) {
          expect(
            samsloopMaxSecondsExact(r, b, c),
            `${r}/${b}/${c} exceeds the ${SAMSLOOP_RECORD_MAX_SECONDS}s cap`,
          ).toBeLessThanOrEqual(SAMSLOOP_RECORD_MAX_SECONDS);
        }
      }
    }
  });

  // The table (rounded to 2 decimals). † marks the cells where the 60 s LENGTH
  // cap binds rather than the byte budget.
  //   mono  8-bit 22k = 60.00 s†  stereo  8-bit 22k = 60.00 s†
  //   mono 16-bit 22k = 60.00 s†  stereo 16-bit 22k = 34.01 s
  //   mono  8-bit 44k = 60.00 s†  stereo  8-bit 44k = 34.01 s
  //   mono 16-bit 44k = 34.01 s   stereo 16-bit 44k = 17.01 s
  //   mono  8-bit 48k = 60.00 s†  stereo  8-bit 48k = 31.25 s
  //   mono 16-bit 48k = 31.25 s   stereo 16-bit 48k = 15.63 s
  it.each([
    // [rate, bits, channels, expected seconds]
    [22_050, 8,  1, 60.00],
    [22_050, 16, 1, 60.00],
    [44_100, 8,  1, 60.00],
    [44_100, 16, 1, 34.01],
    [48_000, 8,  1, 60.00],
    [48_000, 16, 1, 31.25],
    [22_050, 8,  2, 60.00],
    [22_050, 16, 2, 34.01],
    [44_100, 8,  2, 34.01],
    [44_100, 16, 2, 17.01],
    [48_000, 8,  2, 31.25],
    [48_000, 16, 2, 15.63],
  ])('rate=%i bits=%i channels=%i → %f s', (rate, bits, channels, expected) => {
    expect(samsloopMaxSeconds(rate, bits, channels)).toBeCloseTo(expected, 2);
  });

  it('returns 0 for non-positive inputs (defensive)', () => {
    expect(samsloopMaxSeconds(0, 16, 1)).toBe(0);
    expect(samsloopMaxSeconds(44100, 0, 1)).toBe(0);
    expect(samsloopMaxSeconds(44100, 16, 0)).toBe(0);
    expect(samsloopMaxSeconds(-1, 16, 1)).toBe(0);
  });

  it('the rounded helper is exactly the exact one, to 2 decimals', () => {
    // Equality, not `toBeCloseTo(…, 2)`: 15.625 rounds to 15.63, which is a
    // difference of EXACTLY 0.005 and therefore fails a 2-decimal closeness
    // check while being precisely correct. Assert the contract (round to 2 dp)
    // rather than a tolerance that happens to sit on the boundary.
    for (const r of SAMSLOOP_RATE_OPTIONS) {
      for (const b of SAMSLOOP_BITS_OPTIONS) {
        for (const c of SAMSLOOP_CHANNELS_OPTIONS) {
          expect(samsloopMaxSeconds(r, b, c), `${r}/${b}/${c}`).toBe(
            Math.round(samsloopMaxSecondsExact(r, b, c) * 100) / 100,
          );
        }
      }
    }
  });

  it('defaults: 48 kHz / 16-bit / MONO = 31.25 s budget (was 1.42 s)', () => {
    expect(SAMSLOOP_REC_DEFAULTS).toEqual({ rate: 48_000, bits: 16, channels: 1 });
    expect(
      samsloopMaxSeconds(
        SAMSLOOP_REC_DEFAULTS.rate,
        SAMSLOOP_REC_DEFAULTS.bits,
        SAMSLOOP_REC_DEFAULTS.channels,
      ),
    ).toBeCloseTo(31.25, 2);
    // The old defaults (stereo / 16 / 44.1k) against the old 250 kB budget
    // bought 1.4172 s. Same formula, both numbers, so the 22× claim in the
    // constant's comment is checked rather than asserted in prose.
    const oldSeconds = 250_000 / (44_100 * 2 * 2);
    expect(oldSeconds).toBeCloseTo(1.4172, 3);
    expect(31.25 / oldSeconds).toBeCloseTo(22.05, 1);
  });

  it('every RATE option is offered by the switch AND typed', () => {
    // The card renders its RATE buttons from SAMSLOOP_RATE_OPTIONS, so this
    // list is the single source of truth for the switch, the type and the
    // budget table — the card cannot offer a rate the table has not costed.
    expect([...SAMSLOOP_RATE_OPTIONS]).toEqual([22_050, 44_100, 48_000]);
  });
});

// ---------- (1b) the ACHIEVED rate — the tagging bug ----------

describe('samsloopAchievedRate — what the bytes ACTUALLY are', () => {
  it('integer decimation cannot honour 44.1k from a 48k context', () => {
    // THE BUG, stated as arithmetic. round(48000/44100) = 1 ⇒ no decimation.
    expect(samsloopDecimationFactor(48_000, 44_100)).toBe(1);
    expect(samsloopAchievedRate(48_000, 44_100)).toBe(48_000);
    // …and 22.05k from 48k lands on 24k, not 22.05k. BOTH switch positions
    // were mis-tagged from a 48 kHz context; only a 44.1 kHz one was correct.
    expect(samsloopDecimationFactor(48_000, 22_050)).toBe(2);
    expect(samsloopAchievedRate(48_000, 22_050)).toBe(24_000);
  });

  it('is exact wherever the context divides evenly', () => {
    expect(samsloopAchievedRate(44_100, 44_100)).toBe(44_100);
    expect(samsloopAchievedRate(44_100, 22_050)).toBe(22_050);
    expect(samsloopAchievedRate(48_000, 48_000)).toBe(48_000);
    expect(samsloopAchievedRate(96_000, 48_000)).toBe(48_000);
    // No upsampling: a slower context than the target stays where it is.
    expect(samsloopAchievedRate(44_100, 48_000)).toBe(44_100);
  });

  it('agrees with what downsample actually emits, at every context × switch', () => {
    // ⚠ THE NEGATIVE CONTROL ON THE INSTRUMENT. `samsloopAchievedRate` is a
    // PREDICTION about `downsample`; if the two ever drift, the prediction
    // would keep returning a confident, wrong number. Tie them to the same
    // observable — output length — rather than trusting both to use the same
    // rounding rule.
    const SECONDS = 1;
    for (const srcRate of [44_100, 48_000, 96_000]) {
      const src = new Float32Array(srcRate * SECONDS);
      for (const dst of SAMSLOOP_RATE_OPTIONS) {
        const out = downsample(src, srcRate, dst);
        const predicted = samsloopAchievedRate(srcRate, dst);
        expect(
          out.length,
          `src=${srcRate} dst=${dst}: downsample emitted ${out.length} frames, ` +
          `samsloopAchievedRate predicts ${predicted} Hz × ${SECONDS}s`,
        ).toBe(Math.floor(predicted * SECONDS));
      }
    }
  });

  it('MEASURED: the old tag detunes a 1000 Hz reference by −148 cents', () => {
    // The whole reason `rate` moved off the RATE switch. Encode one second of
    // a 1000 Hz tone captured at 48 kHz with the switch at 44.1k, then ask
    // what the playback path HEARS — the worklet reads the buffer at
    // bufferRate/contextRate, so the tag is the tempo/pitch.
    const SRC = 48_000;
    const HZ = 1000;
    const src = new Float32Array(SRC);
    for (let i = 0; i < SRC; i++) src[i] = Math.sin((2 * Math.PI * HZ * i) / SRC);
    const { bytes, rate } = encodeRecordingBytes(src, src, SRC, 44_100, 16, 1);
    const back = decodeRecordedPcm({ bytesB64: bytesToBase64(bytes), bits: 16, channels: 1 });

    let crossings = 0;
    for (let i = 1; i < back.length; i++) if (back[i - 1]! < 0 && back[i]! >= 0) crossings++;

    // With the CORRECT (new) tag: 1000 Hz, and the take reports its true 1 s.
    const heardNow = crossings / (back.length / rate);
    expect(rate).toBe(48_000);
    expect(heardNow, `heard ${heardNow.toFixed(1)} Hz`).toBeCloseTo(HZ, -1);
    expect(back.length / rate, 'duration must be the 1 s that was recorded').toBeCloseTo(1, 3);

    // NEGATIVE CONTROL: the tag the card used to write. If this leg ever stops
    // being wrong, the assertion above has stopped proving anything.
    const heardBefore = crossings / (back.length / 44_100);
    const cents = 1200 * Math.log2(heardBefore / HZ);
    expect(heardBefore, `old tag heard ${heardBefore.toFixed(1)} Hz`).toBeCloseTo(918.3, 0);
    expect(cents, `old tag ${cents.toFixed(0)} cents`).toBeCloseTo(-148, 0);
    expect(back.length / 44_100, 'old tag claimed 8.8 % more time than was recorded')
      .toBeCloseTo(1.088, 2);
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
    const { bytes, rate } = encodeRecordingBytes(l, r, 22050, 22050, 8, 1);
    expect(bytes.byteLength).toBe(4); // mono 8-bit at the same rate
    expect(rate).toBe(22050);
  });

  it('stereo 16-bit at native rate → 4 bytes per frame (interleaved L,R)', () => {
    const l = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const r = new Float32Array([-0.5, -0.5, -0.5, -0.5]);
    const { bytes } = encodeRecordingBytes(l, r, 22050, 22050, 16, 2);
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
    const { bytes, rate } = encodeRecordingBytes(l, r, 44100, 22050, 16, 1);
    // 200 samples → 100 post-downsample → 100 * 2 bytes = 200 bytes.
    expect(bytes.byteLength).toBe(200);
    expect(rate).toBe(22050);
  });

  it('reports the ACHIEVED rate, which is not always the one it was given', () => {
    const l = new Float32Array(480);
    const r = new Float32Array(480);
    expect(encodeRecordingBytes(l, r, 48000, 44100, 16, 1).rate).toBe(48000);
    expect(encodeRecordingBytes(l, r, 48000, 22050, 16, 1).rate).toBe(24000);
    expect(encodeRecordingBytes(l, r, 48000, 48000, 16, 1).rate).toBe(48000);
  });
});

// ---------- (6a) THE BUDGET IS ENFORCED BY CONSTRUCTION ----------
//
// ⚠ THE SILENT-TRUNCATION FIX, AS A PROPERTY. The card used to encode
// whatever it had accumulated and then `subarray(0, BUDGET)` it — a "safety
// net" whose comment said it should never fire and which, because the
// accumulator ran on the SWITCH rate while the encoder produced bytes at the
// ACHIEVED rate, fired on EVERY take (272 640 bytes against a 250 000 budget:
// ~0.118 s cut off the end, every time). The net is gone. What replaces it is
// this: the accumulator's capacity comes from the same budget the encoder is
// measured against, so a full-capacity capture CANNOT overshoot.

describe('a full-capacity capture always encodes inside the budget', () => {
  const CONTEXT_RATES = [44_100, 48_000, 96_000];

  for (const captureRate of CONTEXT_RATES) {
    for (const dstRate of SAMSLOOP_RATE_OPTIONS) {
      for (const bits of SAMSLOOP_BITS_OPTIONS) {
        for (const channels of SAMSLOOP_CHANNELS_OPTIONS) {
          it(`ctx ${captureRate} → ${dstRate}/${bits}-bit/${channels}ch fills to the cap and fits`, () => {
            const cap = samsloopMaxCaptureFrames(
              captureRate, dstRate, bits as SamsloopRecBits, channels as SamsloopRecChannels,
            );
            expect(cap).toBeGreaterThan(0);
            // A full accumulator, encoded exactly as the card encodes it.
            const l = new Float32Array(cap);
            const { bytes, rate } = encodeRecordingBytes(
              l, l, captureRate, dstRate,
              bits as SamsloopRecBits, channels as SamsloopRecChannels,
            );
            expect(
              bytes.byteLength,
              `${bytes.byteLength} B at ctx ${captureRate} → ${dstRate}/${bits}/${channels}`,
            ).toBeLessThanOrEqual(SAMSLOOP_RECORD_BUDGET_BYTES);
            // …and inside the length cap, measured with the ACHIEVED rate.
            const frames = bytes.byteLength / (Math.ceil(bits / 8) * channels);
            expect(frames / rate).toBeLessThanOrEqual(SAMSLOOP_RECORD_MAX_SECONDS + 1e-9);
            // NEGATIVE CONTROL on the capacity itself: it is not merely
            // "small enough" — it is the LARGEST capture that still fits, so
            // the budget is spent rather than left on the table. One more
            // stored frame would breach one of the two caps.
            const factor = samsloopDecimationFactor(captureRate, dstRate);
            const oneMore = encodeRecordingBytes(
              new Float32Array(cap + factor), new Float32Array(cap + factor),
              captureRate, dstRate,
              bits as SamsloopRecBits, channels as SamsloopRecChannels,
            );
            const overBytes = oneMore.bytes.byteLength > SAMSLOOP_RECORD_BUDGET_BYTES;
            const overSecs =
              (oneMore.bytes.byteLength / (Math.ceil(bits / 8) * channels)) / oneMore.rate
                > SAMSLOOP_RECORD_MAX_SECONDS;
            expect(
              overBytes || overSecs,
              'capacity leaves budget unused — one more stored frame still fits',
            ).toBe(true);
          });
        }
      }
    }
  }
});

// ---------- (6b) SamsloopCaptureBuffer ----------

describe('SamsloopCaptureBuffer', () => {
  it('accumulates chunks in order and hands back exactly what was written', () => {
    const buf = new SamsloopCaptureBuffer(10);
    expect(buf.frames).toBe(0);
    expect(buf.full).toBe(false);
    expect(buf.append(new Float32Array([1, 2, 3]), new Float32Array([-1, -2, -3]))).toBe(3);
    expect(buf.append(new Float32Array([4, 5]), new Float32Array([-4, -5]))).toBe(2);
    const { l, r } = buf.channels();
    expect(Array.from(l)).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(r)).toEqual([-1, -2, -3, -4, -5]);
    expect(buf.frames).toBe(5);
  });

  it('TRUNCATES at capacity — it keeps the HEAD of the take, never the tail', () => {
    // The distinction from AudioRingBuffer, asserted rather than described: a
    // rolling ring would answer [3,4,5], which would silently change WHICH
    // seconds of a long hold the user keeps.
    const buf = new SamsloopCaptureBuffer(3);
    expect(buf.append(new Float32Array([1, 2, 3, 4, 5]), new Float32Array([1, 2, 3, 4, 5]))).toBe(3);
    expect(buf.full).toBe(true);
    expect(Array.from(buf.channels().l)).toEqual([1, 2, 3]);
    // Further chunks are dropped, not wrapped.
    expect(buf.append(new Float32Array([9]), new Float32Array([9]))).toBe(0);
    expect(Array.from(buf.channels().l)).toEqual([1, 2, 3]);
  });

  it('a zero-capacity buffer accepts nothing and reports itself full', () => {
    const buf = new SamsloopCaptureBuffer(0);
    expect(buf.full).toBe(true);
    expect(buf.append(new Float32Array([1]), new Float32Array([1]))).toBe(0);
    expect(buf.channels().l.length).toBe(0);
  });

  it('NEGATIVE CONTROL: byte-identical to the old grow-and-copy accumulator', () => {
    // The capture fix must be a pure performance change. Feed both the old
    // implementation (reallocate + copy per chunk) and the new one the same
    // chunk stream and require the encoded bytes to match EXACTLY — a
    // performance fix that changed a sample would be the worst outcome.
    const CHUNK = 128;
    const CHUNKS = 200;
    let oldL = new Float32Array(0);
    let oldR = new Float32Array(0);
    const buf = new SamsloopCaptureBuffer(CHUNK * CHUNKS);
    for (let c = 0; c < CHUNKS; c++) {
      const l = new Float32Array(CHUNK);
      const r = new Float32Array(CHUNK);
      for (let i = 0; i < CHUNK; i++) {
        l[i] = Math.sin((c * CHUNK + i) * 0.01) * 0.9;
        r[i] = Math.cos((c * CHUNK + i) * 0.013) * 0.7;
      }
      // OLD: allocate the whole take again, copy it, append the chunk.
      const nl = new Float32Array(oldL.length + l.length);
      nl.set(oldL, 0); nl.set(l, oldL.length); oldL = nl;
      const nr = new Float32Array(oldR.length + r.length);
      nr.set(oldR, 0); nr.set(r, oldR.length); oldR = nr;
      // NEW.
      buf.append(l, r);
    }
    const now = buf.channels();
    expect(now.l.length).toBe(oldL.length);
    expect(Array.from(now.l)).toEqual(Array.from(oldL));
    expect(Array.from(now.r)).toEqual(Array.from(oldR));
    // …and the same all the way through the encoder, which is what actually
    // reaches node.data.
    const before = encodeRecordingBytes(oldL, oldR, 48_000, 48_000, 16, 2);
    const after = encodeRecordingBytes(now.l, now.r, 48_000, 48_000, 16, 2);
    expect(after.rate).toBe(before.rate);
    expect(Array.from(after.bytes)).toEqual(Array.from(before.bytes));
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
