// clip-audio-cache.test.ts — the PCM decode maths and the byte-capped LRU.
//
// The conversion is the half that guards playback correctness: an off-by-one
// in the de-interleave is a swapped channel or a one-sample shift on EVERY
// loop pass. The LRU is the half that guards memory: eviction must free by
// USE recency and must never evict the row it just admitted.

import { describe, expect, it } from 'vitest';

import {
  ClipAudioCache,
  clipAudioCacheKey,
  pcmToChannelData,
} from './clip-audio-cache';
import type { AudioClipRecord } from './modules/clip-types';

function f32Bytes(samples: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(samples).buffer);
}
function i16Bytes(samples: number[]): Uint8Array {
  return new Uint8Array(new Int16Array(samples).buffer);
}

describe('pcmToChannelData', () => {
  it('de-interleaves stereo f32 [L0,R0,L1,R1,…] into the right legs', () => {
    const { l, r, frames } = pcmToChannelData(f32Bytes([0.1, -0.2, 0.3, -0.4]), 'pcm-f32', 2, 2);
    expect(frames).toBe(2);
    expect([...l]).toEqual([Float32Array.of(0.1)[0], Float32Array.of(0.3)[0]]);
    expect([...r]).toEqual([Float32Array.of(-0.2)[0], Float32Array.of(-0.4)[0]]);
  });

  it('duplicates MONO onto both legs (the dual-mono policy, no probe)', () => {
    const { l, r } = pcmToChannelData(f32Bytes([0.5, 0.25]), 'pcm-f32', 1, 2);
    expect([...l]).toEqual([...r]);
    expect(l[0]).toBeCloseTo(0.5);
  });

  it('scales i16 by 1/32768', () => {
    const { l, r } = pcmToChannelData(i16Bytes([16384, -32768]), 'pcm-i16', 2, 1);
    expect(l[0]).toBeCloseTo(0.5);
    expect(r[0]).toBeCloseTo(-1);
  });

  it('clamps to what the bytes actually hold — a crash-truncated file never claims phantom frames', () => {
    // The record says 4 frames; the disk holds 2.
    const { frames } = pcmToChannelData(f32Bytes([1, 1, 1, 1]), 'pcm-f32', 2, 4);
    expect(frames).toBe(2);
    // POSITIVE CONTROL: with enough bytes, the requested count comes back.
    const full = pcmToChannelData(f32Bytes([1, 1, 1, 1, 1, 1, 1, 1]), 'pcm-f32', 2, 4);
    expect(full.frames).toBe(4);
  });
});

// A minimal BaseAudioContext for the decode path: createBuffer + copyToChannel.
function fakeCtx() {
  return {
    createBuffer(channels: number, frames: number, sampleRate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate,
        duration: frames / sampleRate,
        copyToChannel(src: Float32Array, ch: number) {
          data[ch]!.set(src);
        },
        getChannelData(ch: number) {
          return data[ch]!;
        },
      } as unknown as AudioBuffer;
    },
  } as unknown as BaseAudioContext;
}

function rec(mediaId: string, frames: number, takeAt = 1): AudioClipRecord {
  return {
    kind: 'audio',
    mediaId,
    lengthSteps: 16,
    frames,
    sampleRate: 48000,
    channels: 2,
    format: 'pcm-f32',
    takeAt,
    loop: true,
  };
}

function mediaFor(frames: number): Blob {
  return new Blob([new Float32Array(frames * 2).fill(0.5)]);
}

describe('ClipAudioCache', () => {
  it('decodes through the injected reader, caches by (mediaId, takeAt), and dedupes in-flight reads', async () => {
    let reads = 0;
    const cache = new ClipAudioCache(1_000_000, async () => {
      reads++;
      return mediaFor(100);
    });
    const ctx = fakeCtx();
    const [a, b] = await Promise.all([
      cache.getBuffer(ctx, rec('m1', 100)),
      cache.getBuffer(ctx, rec('m1', 100)),
    ]);
    expect(a).toBe(b);
    expect(reads).toBe(1);
    expect(a!.length).toBe(100);
    // A hit costs no read…
    await cache.getBuffer(ctx, rec('m1', 100));
    expect(reads).toBe(1);
    // …but a RE-RECORDED take (new takeAt) is a different row — the samsloop
    // #1353 change-signature rule.
    await cache.getBuffer(ctx, rec('m1', 100, 2));
    expect(reads).toBe(2);
    expect(clipAudioCacheKey(rec('m1', 100, 2))).not.toBe(clipAudioCacheKey(rec('m1', 100, 1)));
  });

  it('evicts least-recently-USED rows past the byte cap, never the row just added', async () => {
    // 100 frames × 2ch × 4B = 800 bytes per row; the cap fits two rows.
    let reads = 0;
    const cache = new ClipAudioCache(1700, async () => {
      reads++;
      return mediaFor(100);
    });
    const ctx = fakeCtx();
    await cache.getBuffer(ctx, rec('a', 100));
    await cache.getBuffer(ctx, rec('b', 100));
    expect(cache.size).toBe(2);
    // Touch `a` so `b` is the LRU, then admit `c` — `b` must be the eviction.
    await cache.getBuffer(ctx, rec('a', 100));
    await cache.getBuffer(ctx, rec('c', 100));
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBeLessThanOrEqual(1700);
    expect(reads).toBe(3);
    // `a` survived (a hit — no new read); `b` was evicted (a fresh read).
    await cache.getBuffer(ctx, rec('a', 100));
    expect(reads).toBe(3);
    await cache.getBuffer(ctx, rec('b', 100));
    expect(reads).toBe(4);
  });

  it('a take larger than the whole cap still decodes (the cache just holds only it)', async () => {
    const cache = new ClipAudioCache(100, async () => mediaFor(1000));
    const buf = await cache.getBuffer(fakeCtx(), rec('big', 1000));
    expect(buf).not.toBeNull();
    expect(cache.size).toBe(1);
  });

  it('absent media and undecodable formats are null — a named state, not a throw', async () => {
    const cache = new ClipAudioCache(1000, async () => null);
    expect(await cache.getBuffer(fakeCtx(), rec('gone', 10))).toBeNull();
    const opus = { ...rec('o', 10), format: 'opus' as const };
    expect(await cache.getBuffer(fakeCtx(), opus)).toBeNull();
  });
});
