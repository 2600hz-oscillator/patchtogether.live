// packages/web/src/lib/audio/clip-media-drain.test.ts
//
// The one property this file exists for: WHEN THE DISK FALLS BEHIND, THE DRAIN
// STALLS. It does not drop a chunk to catch up, because a dropped chunk is a
// hole in the middle of a loop — heard on every single pass, unlike a video
// glitch, and exactly the silence-padded discontinuity that made recorderbox
// click.

import { describe, it, expect } from 'vitest';
import { ClipMediaDrain } from './clip-media-drain';
import type { ClipMediaWriter } from './clip-media-store';

/** A writer that records what it was asked to do and can be made arbitrarily
 *  slow — the instrument for "does the queue grow, or does something vanish". */
function slowWriter(opts: { delayFor?: (position: number) => number; failAt?: Set<number> } = {}) {
  const writes: { position: number; bytes: number[] }[] = [];
  const completed: number[] = [];
  const writer: ClipMediaWriter = {
    mediaId: 'm',
    async write(bytes, position) {
      const ms = opts.delayFor?.(position) ?? 0;
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      if (opts.failAt?.has(position)) throw new Error(`fail@${position}`);
      writes.push({ position, bytes: [...bytes] });
      completed.push(position);
    },
    async close() {},
  };
  return { writer, writes, completed };
}

const bytes = (n: number, seed = 0) => new Uint8Array(Array.from({ length: n }, (_, i) => (seed + i) & 0xff));

describe('ClipMediaDrain — never drops, ever', () => {
  it('writes every chunk, in arrival order, at its own byte offset', async () => {
    const { writer, writes } = slowWriter();
    const d = new ClipMediaDrain(writer, { bytesPerFrame: 4 });
    await Promise.all([
      d.add({ firstFrame: 0, frames: 2, bytes: bytes(8, 1) }),
      d.add({ firstFrame: 2, frames: 2, bytes: bytes(8, 50) }),
      d.add({ firstFrame: 4, frames: 2, bytes: bytes(8, 90) }),
    ]);
    await d.flush();
    expect(writes.map((w) => w.position)).toEqual([0, 8, 16]);
    expect(d.framesWritten).toBe(6);
    expect(d.dropped).toBe(0);
  });

  it('STALLS when the disk falls behind — the queue grows, nothing is lost', async () => {
    // The first write takes 30 ms; nine more arrive while it is in flight.
    const { writer, writes } = slowWriter({ delayFor: (p) => (p === 0 ? 30 : 0) });
    const d = new ClipMediaDrain(writer, { bytesPerFrame: 4 });
    const all: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) all.push(d.add({ firstFrame: i * 2, frames: 2, bytes: bytes(8, i) }));
    // Mid-stall the queue is deep — that is the stall, observable as a number.
    expect(d.queued).toBeGreaterThan(1);
    await Promise.all(all);
    await d.flush();

    // ⚠ THE ASSERTION THAT MATTERS. Ten in, ten out. A drop-to-catch-up
    // implementation would have written fewer and looked "fast".
    expect(writes).toHaveLength(10);
    expect(writes.map((w) => w.position)).toEqual([0, 8, 16, 24, 32, 40, 48, 56, 64, 72]);
    expect(d.dropped).toBe(0);
    expect(d.peakQueued).toBeGreaterThanOrEqual(9);
    expect(d.queued).toBe(0);
  });

  it('serialises: a slow chunk finishes BEFORE the next one starts', async () => {
    // Order is structural (each add chains onto the previous promise), not a
    // thing the caller has to remember — so an out-of-order completion is
    // impossible rather than unlikely.
    const { writer, completed } = slowWriter({ delayFor: (p) => (p === 0 ? 25 : 1) });
    const d = new ClipMediaDrain(writer, { bytesPerFrame: 1 });
    void d.add({ firstFrame: 0, frames: 1, bytes: bytes(1) });
    void d.add({ firstFrame: 1, frames: 1, bytes: bytes(1) });
    void d.add({ firstFrame: 2, frames: 1, bytes: bytes(1) });
    await d.flush();
    expect(completed).toEqual([0, 1, 2]);
  });

  it('a FAILED write does not abandon the rest of the take', async () => {
    // A recoverable partial should not be shortened further just because one
    // chunk failed; the scratch is kept as a recover candidate either way.
    const { writer, writes } = slowWriter({ failAt: new Set([8]) });
    const d = new ClipMediaDrain(writer, { bytesPerFrame: 4 });
    const ok1 = d.add({ firstFrame: 0, frames: 2, bytes: bytes(8) });
    const bad = d.add({ firstFrame: 2, frames: 2, bytes: bytes(8) });
    const ok2 = d.add({ firstFrame: 4, frames: 2, bytes: bytes(8) });
    await expect(ok1).resolves.toBeUndefined();
    await expect(bad).rejects.toThrow('fail@8');
    await expect(ok2).resolves.toBeUndefined();
    await d.flush();
    expect(writes.map((w) => w.position)).toEqual([0, 16]);
    expect(String(d.error)).toContain('fail@8');
    expect(d.queued).toBe(0);
  });

  it('reports progress as the highest CONTIGUOUS frame reached, monotonically', async () => {
    const seen: number[] = [];
    const { writer } = slowWriter();
    const d = new ClipMediaDrain(writer, { bytesPerFrame: 2, onProgress: (f) => seen.push(f) });
    await d.add({ firstFrame: 0, frames: 4, bytes: bytes(8) });
    await d.add({ firstFrame: 4, frames: 4, bytes: bytes(8) });
    // A re-delivered earlier chunk must not walk the count BACKWARDS — the
    // manifest's frame count is a recovery length and a shrinking one would
    // truncate a take that is actually longer.
    await d.add({ firstFrame: 0, frames: 4, bytes: bytes(8) });
    await d.flush();
    expect(seen).toEqual([4, 8]);
    expect(d.framesWritten).toBe(8);
  });

  it('flush() resolves even with nothing queued', async () => {
    const { writer } = slowWriter();
    await expect(new ClipMediaDrain(writer, { bytesPerFrame: 4 }).flush()).resolves.toBeUndefined();
  });
});
