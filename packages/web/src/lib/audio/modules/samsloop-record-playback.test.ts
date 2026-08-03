// packages/web/src/lib/audio/modules/samsloop-record-playback.test.ts
//
// THE TEST WHOSE ABSENCE SHIPPED A SILENT RECORDER.
//
// The bug: `stopRecording` wrote `node.data.sample.bytesB64`; the engine
// factory's `pushSampleIfChanged` read `node.data.fileBytesB64`, then
// `node.data.samples`, and had never heard of `sample`. So REC persisted,
// redrew the waveform, round-tripped through save/load and downloaded a
// correct WAV — and the module made no sound. Every existing samsloop test
// passed throughout, because every one of them tested ONE side:
// `samsloop-record.test.ts` pins the ENCODE, `samsloop.test.ts` pins the
// worklet render given a buffer, and `samsloop.spec.ts` drives the UPLOAD
// path end to end. Nothing joined the recorder's write to the player's read.
//
// So this file is organised around that join, in three layers:
//
//   1. ROUND TRIP — decodeRecordedPcm is the inverse of encodeRecordingBytes
//      across the full bits × channels matrix, with a negative control that
//      the stride actually matters (a decoder blind to `channels` would
//      otherwise pass every one of these).
//   2. THE JOIN, against a REAL Y.Doc — what `buildRecordedSample` commits is
//      what `resolveSamsloopSource` resolves, and decoding the resolved source
//      yields AUDIBLE samples. The OLD reader is re-stated inline as the
//      negative control on the instrument: it must return null for the same
//      node, or this test is not testing the bug that shipped.
//   3. PRECEDENCE + RECOVERY — what happens to racks saved BEFORE the fix,
//      which is the half a write-path-only fix would have left broken.
//
// Real Y.Doc rather than plain objects, per [[yjs-save-load-real-ydoc]]: the
// data these functions read is a syncedStore proxy over a Y.Map, `delete` on
// it is a Yjs operation rather than a JS one, and a plain-object fixture would
// prove nothing about either.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  SAMSLOOP_UPLOAD_DATA_KEYS,
  buildRecordedSample,
  bytesToBase64,
  clearSamsloopUploadKeys,
  decodeRecordedPcm,
  encodeRecordingBytes,
  type SamsloopRecBits,
  type SamsloopRecChannels,
  type SamsloopRecRate,
} from './samsloop-record';
import { resolveSamsloopSource, type SamsloopData } from './samsloop';

const NID = 'samsloop-record-playback-test';

/** A deterministic, obviously-not-silent test signal: a 220 Hz sine at 0.8
 *  peak. Deterministic so a failure is reproducible; loud so "the module is
 *  silent" and "the module is quiet" are different measurements. */
function tone(frames: number, srcRate: number, hz = 220, amp = 0.8): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / srcRate);
  return out;
}

function rms(x: Float32Array): number {
  if (x.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** Spawn a live samsloop node with the given `data`, in one origin-tagged
 *  transaction — the same shape the store sees on a patch load. */
function spawn(data: SamsloopData): void {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'samsloop',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: data as Record<string, unknown>,
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
}

const liveData = (): SamsloopData =>
  (patch.nodes[NID] as ModuleNode).data as unknown as SamsloopData;

/**
 * THE READER AS IT SHIPPED — the exact precedence `pushSampleIfChanged` had
 * before the fix, restated here so the regression can be asserted rather than
 * described. Any test below that passes under BOTH this and the real resolver
 * is not testing the bug.
 */
function shippedReaderFoundASource(d: SamsloopData | undefined): boolean {
  if (d?.fileBytesB64 && typeof d.fileBytesB64 === 'string' && d.fileBytesB64.length > 0) return true;
  return !!(d?.samples && d.samples.length > 0);
}

/** Remove the test node if it exists. The presence check is REQUIRED, not
 *  tidiness: `delete` on the syncedStore proxy throws for an absent key (see
 *  `clearSamsloopUploadKeys`), so an unguarded teardown fails every test in
 *  the file that never spawned one. */
function despawn(): void {
  if (!patch.nodes[NID]) return;
  ydoc.transact(() => { delete patch.nodes[NID]; }, LOCAL_ORIGIN);
}

beforeEach(despawn);
afterEach(despawn);

// ── 1 · ROUND TRIP ──────────────────────────────────────────────────────────

describe('decodeRecordedPcm is the inverse of encodeRecordingBytes', () => {
  const SRC_RATE = 48_000;
  const MATRIX: [SamsloopRecRate, SamsloopRecBits, SamsloopRecChannels][] = [
    [22_050, 8, 1], [22_050, 8, 2], [22_050, 16, 1], [22_050, 16, 2],
    [44_100, 8, 1], [44_100, 8, 2], [44_100, 16, 1], [44_100, 16, 2],
  ];

  for (const [rate, bits, channels] of MATRIX) {
    it(`${rate} Hz · ${bits}-bit · ${channels}ch survives the round trip`, () => {
      const src = tone(SRC_RATE, SRC_RATE);
      const bytes = encodeRecordingBytes(src, src, SRC_RATE, rate, bits, channels);
      const back = decodeRecordedPcm({ bytesB64: bytesToBase64(bytes), bits, channels }, 'mix');

      // Frame count: bytes / (bytesPerSample × channels), exactly.
      const bytesPerSample = Math.ceil(bits / 8);
      expect(back.length).toBe(Math.floor(bytes.byteLength / (bytesPerSample * channels)));
      expect(back.length).toBeGreaterThan(0);

      // Level survives. L === R here, so a stereo take mono-mixes to the same
      // signal — the downsample's 1-pole pre-filter takes a little off the top
      // of a 220 Hz tone, and 8-bit quantisation adds ~0.002 of noise, so the
      // window is generous on the LOW side and tight on the high.
      const r = rms(back);
      expect(r, `${bits}-bit ${channels}ch rms=${r.toFixed(4)}`).toBeGreaterThan(0.4);
      expect(r, `${bits}-bit ${channels}ch rms=${r.toFixed(4)}`).toBeLessThan(0.65);

      // And it is a real waveform, not a DC rail or a rail-to-rail square:
      // peak within a hair of the 0.8 source amplitude.
      let peak = 0;
      for (let i = 0; i < back.length; i++) peak = Math.max(peak, Math.abs(back[i]!));
      expect(peak, `peak=${peak.toFixed(4)}`).toBeGreaterThan(0.6);
      expect(peak, `peak=${peak.toFixed(4)}`).toBeLessThan(0.9);
    });
  }

  it('NEGATIVE CONTROL: the channel stride is load-bearing (a decoder blind to it fails)', () => {
    // Encode a STEREO take whose two channels are genuinely different — L a
    // 220 Hz tone, R silence — then decode it correctly and decode it as if it
    // were mono. If the stride were ignored the two would agree, and every
    // assertion in the matrix above would pass on a decoder that cannot read
    // stereo at all.
    const SRC_RATE = 48_000;
    const l = tone(SRC_RATE, SRC_RATE);
    const r = new Float32Array(SRC_RATE); // silent right channel
    const bytes = encodeRecordingBytes(l, r, SRC_RATE, 44_100, 16, 2);
    const b64 = bytesToBase64(bytes);

    const correct = decodeRecordedPcm({ bytesB64: b64, bits: 16, channels: 2 }, 'mix');
    const wrongStride = decodeRecordedPcm({ bytesB64: b64, bits: 16, channels: 1 }, 'mix');

    expect(correct.length).toBe(Math.floor(wrongStride.length / 2));
    // The correct mono MIX of (tone, silence) is half-amplitude; reading the
    // interleaved stream as mono reads tone and silence alternately, which has
    // a different RMS *and* a 22 kHz alternation the mix does not have.
    expect(rms(correct)).toBeGreaterThan(0.2);
    expect(Math.abs(rms(correct) - rms(wrongStride))).toBeGreaterThan(0.05);
  });

  it("'left' and 'mix' differ on a stereo take and agree on a mono one", () => {
    const SRC_RATE = 48_000;
    const l = tone(SRC_RATE, SRC_RATE);
    const r = new Float32Array(SRC_RATE);

    const stereo = encodeRecordingBytes(l, r, SRC_RATE, 44_100, 16, 2);
    const sB64 = bytesToBase64(stereo);
    const sMix = decodeRecordedPcm({ bytesB64: sB64, bits: 16, channels: 2 }, 'mix');
    const sLeft = decodeRecordedPcm({ bytesB64: sB64, bits: 16, channels: 2 }, 'left');
    // mix = (L + 0)/2 = L/2 ⇒ exactly half the level of 'left'.
    expect(rms(sMix) / rms(sLeft)).toBeGreaterThan(0.45);
    expect(rms(sMix) / rms(sLeft)).toBeLessThan(0.55);

    const mono = encodeRecordingBytes(l, r, SRC_RATE, 44_100, 16, 1);
    const mB64 = bytesToBase64(mono);
    expect(decodeRecordedPcm({ bytesB64: mB64, bits: 16, channels: 1 }, 'mix')).toEqual(
      decodeRecordedPcm({ bytesB64: mB64, bits: 16, channels: 1 }, 'left'),
    );
  });

  it('an empty or absent payload decodes to zero frames rather than throwing', () => {
    expect(decodeRecordedPcm({ bytesB64: '', bits: 16, channels: 2 }).length).toBe(0);
  });
});

// ── 2 · THE JOIN ────────────────────────────────────────────────────────────

describe('a RECORDED sample reaches the player (the P0)', () => {
  const SRC_RATE = 48_000;

  /** Exactly what the card's REC commit produces, via the same builder. */
  function recordTake(
    rate: SamsloopRecRate = 44_100,
    bits: SamsloopRecBits = 16,
    channels: SamsloopRecChannels = 2,
    now = 1_700_000_000_000,
  ) {
    const src = tone(SRC_RATE, SRC_RATE);
    const bytes = encodeRecordingBytes(src, src, SRC_RATE, rate, bits, channels);
    return buildRecordedSample(bytes, rate, bits, channels, now);
  }

  it('resolves to a playable source, and the decoded audio is AUDIBLE', () => {
    const { sample, frames } = recordTake();
    spawn({ sample });

    // (a) THE NEGATIVE CONTROL ON THE INSTRUMENT. The reader as it shipped
    //     finds nothing on this exact node — so this test is measuring the bug
    //     and not merely re-asserting that a resolver resolves.
    expect(
      shippedReaderFoundASource(liveData()),
      'the pre-fix reader must find NO source here — if it does, this test has stopped testing the P0',
    ).toBe(false);

    // (b) The fixed reader finds it.
    const src = resolveSamsloopSource(liveData());
    expect(src?.kind).toBe('record');
    if (src?.kind !== 'record') throw new Error('unreachable — asserted above');

    // (c) And what it resolves to is real audio, not an empty buffer. This is
    //     the assertion the module shipped without: "REC produces sound".
    const f32 = decodeRecordedPcm(src.sample, 'mix');
    expect(f32.length).toBe(frames);
    expect(rms(f32), `recorded rms=${rms(f32).toFixed(4)} — a silent buffer is the bug`).toBeGreaterThan(0.4);
  });

  it('the poll SIGNATURE changes between two takes of identical length and settings', () => {
    // Without `recordedAt` every field of a re-record at unchanged settings
    // repeats, the signature aliases, and the factory keeps playing the FIRST
    // take forever — a second bug of exactly the shape of the first.
    const a = recordTake(44_100, 16, 2, 1_700_000_000_000);
    const b = recordTake(44_100, 16, 2, 1_700_000_000_001);
    expect(a.sample.byteLength).toBe(b.sample.byteLength);
    expect(a.sample.rate).toBe(b.sample.rate);

    spawn({ sample: a.sample });
    const sigA = resolveSamsloopSource(liveData())!.signature;
    ydoc.transact(() => { liveData().sample = b.sample; }, LOCAL_ORIGIN);
    const sigB = resolveSamsloopSource(liveData())!.signature;
    expect(sigB, `two takes must not share a signature (${sigA})`).not.toBe(sigA);
  });

  it('a take carrying no recordedAt (a rack saved before the stamp) still resolves', () => {
    const { sample } = recordTake();
    const legacy = { ...sample };
    delete legacy.recordedAt;
    spawn({ sample: legacy });
    const src = resolveSamsloopSource(liveData());
    expect(src?.kind).toBe('record');
    expect(src!.signature).toContain('record:0:');
  });

  it('a zero-byte take resolves to NOTHING rather than to an empty buffer', () => {
    spawn({ sample: { bytesB64: '', rate: 44_100, bits: 16, channels: 2, byteLength: 0, durationSec: 0 } });
    expect(resolveSamsloopSource(liveData())).toBeNull();
  });
});

// ── 3 · PRECEDENCE + RECOVERY ───────────────────────────────────────────────

describe('resolveSamsloopSource precedence — what happens to already-saved racks', () => {
  const REC = buildRecordedSample(
    encodeRecordingBytes(tone(48_000, 48_000), tone(48_000, 48_000), 48_000, 44_100, 16, 2),
    44_100, 16, 2, 1_700_000_000_000,
  ).sample;

  it('an UPLOAD-only rack resolves to the upload, byte for byte as before', () => {
    spawn({ fileBytesB64: 'QUJD', fileSize: 3, fileName: 'a.wav' });
    const src = resolveSamsloopSource(liveData());
    expect(src?.kind).toBe('file');
    expect(src!.signature).toBe('bytes:3:a.wav');
  });

  it('a LEGACY YArray rack resolves to the legacy buffer', () => {
    spawn({ samples: [0.1, -0.2, 0.3], sampleRate: 24_000 });
    const src = resolveSamsloopSource(liveData());
    expect(src?.kind).toBe('legacy');
    expect(src!.signature).toBe('legacy:3:');
  });

  it('an EMPTY rack resolves to null', () => {
    spawn({});
    expect(resolveSamsloopSource(liveData())).toBeNull();
  });

  it('a rack saved BEFORE the fix holding BOTH keeps playing its UPLOAD', () => {
    // The recovery contract, stated as a test. A pre-fix upload-then-record
    // rack carries both keys; picking the upload means NO rack that makes
    // sound today changes what it makes, and only the silent case (a
    // recording with no upload) starts working. The recording is not lost —
    // DOWNLOAD still prefers it, and one more REC press makes it the source.
    spawn({ fileBytesB64: 'QUJD', fileSize: 3, fileName: 'a.wav', sample: REC });
    expect(resolveSamsloopSource(liveData())?.kind).toBe('file');
  });

  it('clearing the upload keys on that rack hands the module to the recording', () => {
    spawn({ fileBytesB64: 'QUJD', fileSize: 3, fileName: 'a.wav', sample: REC });
    // The RECORD commit's first act, against the real Y.Map.
    ydoc.transact(() => {
      clearSamsloopUploadKeys(liveData() as Record<string, unknown>);
    }, LOCAL_ORIGIN);
    expect(resolveSamsloopSource(liveData())?.kind).toBe('record');
  });

  it('clearing runs on a node that has NO upload keys — the common REC case', () => {
    // ⚠ THE CASE THAT MUST NOT THROW, and the one an unguarded `delete` would
    // break: recording into a fresh module. `node.data` is a syncedStore proxy
    // whose deleteProperty trap returns falsish for a key the Y.Map does not
    // hold, so `delete d.fileBytesB64` on a never-uploaded node is a TypeError
    // that abandons the commit mid-write and loses the take. Asserted against
    // the REAL proxy, because a plain object cannot fail this way at all.
    spawn({ recRate: 44_100, recBits: 16, recChannels: 2 });
    expect(() => {
      ydoc.transact(() => {
        clearSamsloopUploadKeys(liveData() as Record<string, unknown>);
      }, LOCAL_ORIGIN);
    }).not.toThrow();
    // NEGATIVE CONTROL on that claim: the unguarded form really does throw, so
    // the guard is load-bearing rather than decorative.
    expect(() => {
      ydoc.transact(() => {
        delete (liveData() as Record<string, unknown>).fileBytesB64;
      }, LOCAL_ORIGIN);
    }).toThrow(/deleteProperty/);
    // The recording settings are untouched — they are not upload keys.
    expect(liveData().recRate).toBe(44_100);
  });

  it('SAMSLOOP_UPLOAD_DATA_KEYS covers every upload key resolveSamsloopSource reads', () => {
    // The list is what the RECORD commit deletes. If an upload key were added
    // to the reader and not to this list, a record-after-upload would leave
    // the pair on node.data and the reader's precedence would keep the stale
    // upload playing over the new take — silently, exactly like the P0.
    const keys = new Set<string>(SAMSLOOP_UPLOAD_DATA_KEYS);
    expect(keys.has('fileBytesB64')).toBe(true);
    expect(keys.has('samples')).toBe(true);

    spawn({ fileBytesB64: 'QUJD', fileSize: 3, fileName: 'a.wav', samples: [0.1, 0.2], sampleRate: 24_000, sampleLength: 2, fileMime: 'audio/wav', sample: REC });
    ydoc.transact(() => {
      clearSamsloopUploadKeys(liveData() as Record<string, unknown>);
    }, LOCAL_ORIGIN);
    // Nothing an upload owns survives, so `record` is reachable rather than
    // shadowed by whichever key was forgotten.
    expect(resolveSamsloopSource(liveData())?.kind).toBe('record');
  });
});

describe('SamsloopRecordedSample is the shape the card actually writes', () => {
  it('buildRecordedSample fills every declared field', () => {
    const bytes = encodeRecordingBytes(tone(48_000, 48_000), tone(48_000, 48_000), 48_000, 22_050, 8, 1);
    const { sample, frames } = buildRecordedSample(bytes, 22_050, 8, 1, 42);
    expect(sample.byteLength).toBe(bytes.byteLength);
    expect(sample.rate).toBe(22_050);
    expect(sample.bits).toBe(8);
    expect(sample.channels).toBe(1);
    expect(sample.recordedAt).toBe(42);
    expect(frames).toBe(bytes.byteLength); // 8-bit mono ⇒ 1 byte per frame
    expect(sample.durationSec).toBeCloseTo(frames / 22_050, 6);
    // …and the declared durationSec agrees with the DECODED length, which is
    // what the card prints and what the START/END faders bound against.
    expect(decodeRecordedPcm(sample).length).toBe(frames);
  });
});

beforeEach(() => {
  // A previous file's node must never decide this one's precedence.
  if (patch.nodes[NID]) {
    ydoc.transact(() => { delete patch.nodes[NID]; }, LOCAL_ORIGIN);
  }
});
