// packages/web/src/lib/video/recorderbox-audio-ring.test.ts
//
// Unit coverage for the rolling 5-second audio overlap ring buffer. It retains
// the trailing N frames of emitted capture audio so a chunk roll can PREPEND the
// last 5 s as the start of the next chunk. PURE — CI-safe, no encoder. Verifies:
// retains exactly the last `cap` frames; under-cap returns only what it has
// (first-chunk overlap = none); planar L/R layout preserved; wraparound correct.

import { describe, it, expect } from 'vitest';
import { AudioRingBuffer, type PlanarStereoChunk } from './recorderbox-audio-ring';

/** A planar stereo chunk whose L plane is `lStart, lStart+1, …` and R plane is
 *  `rStart, rStart+1, …` so order/wraparound is checkable by value. */
function chunk(frames: number, lStart: number, rStart: number): PlanarStereoChunk {
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    data[i] = lStart + i;          // L plane
    data[frames + i] = rStart + i; // R plane
  }
  return { data, frames };
}

describe('AudioRingBuffer — retention window', () => {
  it('under capacity → snapshot returns only what it has (first-chunk overlap=none)', () => {
    const ring = new AudioRingBuffer(100);
    expect(ring.retainedFrames).toBe(0);
    // Empty ring → zero-length snapshot (the very first chunk has no overlap).
    const empty = ring.snapshotPlanar();
    expect(empty.frames).toBe(0);
    expect(empty.data.length).toBe(0);

    ring.pushChunk(chunk(30, 0, 1000));
    expect(ring.retainedFrames).toBe(30);
    const snap = ring.snapshotPlanar();
    expect(snap.frames).toBe(30);
    expect(snap.data.length).toBe(60);
  });

  it('retains EXACTLY the last `capacity` frames once full', () => {
    const cap = 50;
    const ring = new AudioRingBuffer(cap);
    // Push 130 frames across three chunks → only the last 50 are retained.
    ring.pushChunk(chunk(40, 0, 5000));    // frames 0..39
    ring.pushChunk(chunk(40, 40, 5040));   // frames 40..79
    ring.pushChunk(chunk(50, 80, 5080));   // frames 80..129
    expect(ring.retainedFrames).toBe(cap);
    const snap = ring.snapshotPlanar();
    expect(snap.frames).toBe(cap);
    // The retained window is frames 80..129 (the last 50). L plane first value:
    expect(snap.data[0]).toBe(80);            // oldest retained L
    expect(snap.data[cap - 1]).toBe(129);     // newest retained L
    // R plane (offset by cap in the planar block).
    expect(snap.data[cap]).toBe(5080);        // oldest retained R
    expect(snap.data[cap * 2 - 1]).toBe(5129);// newest retained R
  });

  it('preserves chronological order across a wraparound', () => {
    const cap = 8;
    const ring = new AudioRingBuffer(cap);
    // 12 frames in 3-frame chunks → head wraps; retained = last 8 (frames 4..11).
    for (let i = 0; i < 4; i++) ring.pushChunk(chunk(3, i * 3, 100 + i * 3));
    expect(ring.retainedFrames).toBe(cap);
    const snap = ring.snapshotPlanar();
    // Oldest-first L plane should read 4,5,6,7,8,9,10,11 (no reorder at the wrap).
    expect(Array.from(snap.data.slice(0, cap))).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(Array.from(snap.data.slice(cap))).toEqual([104, 105, 106, 107, 108, 109, 110, 111]);
  });

  it('a chunk bigger than the whole window keeps only its TAIL', () => {
    const cap = 10;
    const ring = new AudioRingBuffer(cap);
    ring.pushChunk(chunk(25, 0, 0)); // 25 > 10 → keep frames 15..24
    expect(ring.retainedFrames).toBe(cap);
    const snap = ring.snapshotPlanar();
    expect(Array.from(snap.data.slice(0, cap))).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  it('5-second overlap at 48 kHz = 240000 frames capacity', () => {
    const sr = 48_000;
    const ring = new AudioRingBuffer(5 * sr);
    expect(ring.capacityFrames).toBe(240_000);
  });

  it('copies data in (caller may reuse its buffer)', () => {
    const ring = new AudioRingBuffer(10);
    const c = chunk(4, 1, 1);
    ring.pushChunk(c);
    c.data.fill(999); // mutate the source AFTER push
    const snap = ring.snapshotPlanar();
    // The ring kept its own copy — unaffected by the post-push mutation.
    expect(Array.from(snap.data.slice(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it('ignores malformed chunks (zero frames / short data)', () => {
    const ring = new AudioRingBuffer(10);
    ring.pushChunk({ data: new Float32Array(8), frames: 0 });   // zero frames
    ring.pushChunk({ data: new Float32Array(2), frames: 4 });   // data too short
    expect(ring.retainedFrames).toBe(0);
    ring.pushChunk(chunk(3, 7, 7));
    expect(ring.retainedFrames).toBe(3);
  });

  it('clear() drops the retained window', () => {
    const ring = new AudioRingBuffer(10);
    ring.pushChunk(chunk(5, 0, 0));
    ring.clear();
    expect(ring.retainedFrames).toBe(0);
    expect(ring.snapshotPlanar().frames).toBe(0);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new AudioRingBuffer(0)).toThrow();
  });
});
