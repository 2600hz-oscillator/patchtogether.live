// packages/web/src/lib/video/recorderbox-capture-drain.test.ts
//
// Unit coverage for the PURE capture-drain core — the load-bearing logic of the
// recorderbox click/pop fix. The old MediaStreamAudioTrackSource path DROPPED
// samples under load (then mediabunny silence-padded the gap = the click); this
// core guarantees every pushed chunk is emitted, in order, with monotonic
// contiguous timestamps, through a backpressured (awaited) add.

import { describe, it, expect } from 'vitest';
import { AudioCaptureDrain, type CaptureChunk, type CaptureSampleInit } from './recorderbox-capture-drain';

const SR = 48_000;

/** A planar stereo chunk whose L plane is filled with `lv`, R plane with `rv`,
 *  so a round-trip can be verified by value. */
function chunk(frames: number, lv: number, rv: number): CaptureChunk {
  const data = new Float32Array(frames * 2);
  data.fill(lv, 0, frames);
  data.fill(rv, frames, frames * 2);
  return { data, frames };
}

describe('AudioCaptureDrain.next — timestamps + ordering', () => {
  it('stamps monotonic, exactly-contiguous timestamps (audio clock)', () => {
    const d = new AudioCaptureDrain(SR);
    d.push(chunk(128, 0.1, 0.2));
    d.push(chunk(128, 0.3, 0.4));
    d.push(chunk(256, 0.5, 0.6));
    const a = d.next()!;
    const b = d.next()!;
    const c = d.next()!;
    expect(a.timestamp).toBe(0);
    expect(b.timestamp).toBeCloseTo(128 / SR, 12);
    expect(c.timestamp).toBeCloseTo(256 / SR, 12);
    // Contiguous: each start === previous start + previous duration.
    expect(b.timestamp).toBeCloseTo(a.timestamp + 128 / SR, 12);
    expect(c.timestamp).toBeCloseTo(b.timestamp + 128 / SR, 12);
  });

  it('carries f32-planar / 2ch / rate + the exact buffer through (no copy/mangle)', () => {
    const d = new AudioCaptureDrain(SR);
    // float32-exact values so the round-trip compares with ===.
    const ch = chunk(64, 0.5, -0.25);
    d.push(ch);
    const s = d.next()!;
    expect(s.format).toBe('f32-planar');
    expect(s.numberOfChannels).toBe(2);
    expect(s.sampleRate).toBe(SR);
    expect(s.data).toBe(ch.data); // same buffer, no copy
    expect(s.data.slice(0, 64).every((v) => v === 0.5)).toBe(true);    // L plane
    expect(s.data.slice(64, 128).every((v) => v === -0.25)).toBe(true); // R plane
  });

  it('honors a non-zero t0 (shared video t0 for A/V sync)', () => {
    const d = new AudioCaptureDrain(SR, 5);
    d.push(chunk(48_000, 0, 0)); // 1 second
    expect(d.next()!.timestamp).toBe(5);
    d.push(chunk(48_000, 0, 0));
    expect(d.next()!.timestamp).toBeCloseTo(6, 9); // 5 + 1s
  });

  it('returns null on an empty queue', () => {
    expect(new AudioCaptureDrain(SR).next()).toBeNull();
  });

  it('ignores malformed chunks without corrupting the timestamp clock', () => {
    const d = new AudioCaptureDrain(SR);
    d.push({ data: new Float32Array(10), frames: 0 });   // zero frames
    d.push({ data: new Float32Array(4), frames: 128 });  // data too short
    d.push(chunk(128, 1, 1));                              // the only valid one
    const s = d.next()!;
    expect(s.timestamp).toBe(0);   // first VALID chunk starts at t0, not offset
    expect(d.next()).toBeNull();    // the malformed ones were dropped, not queued
  });

  it('rejects a non-positive sample rate', () => {
    expect(() => new AudioCaptureDrain(0)).toThrow();
  });
});

describe('AudioCaptureDrain.drain — lossless under backpressure (the bug fix)', () => {
  it('emits EVERY pushed chunk in order even when add() is slow (no drops)', async () => {
    const d = new AudioCaptureDrain(SR);
    const got: CaptureSampleInit[] = [];
    // A SLOW, backpressured add — simulates a busy encoder. Each add yields a few
    // macrotasks before resolving, during which more chunks pile into the queue.
    const add = async (init: CaptureSampleInit) => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      got.push(init);
    };
    const idle = () => new Promise<void>((r) => setTimeout(r, 0));

    // Push the first batch, start draining, then keep pushing WHILE draining
    // (encoder backed up) — the queue must absorb them, none dropped.
    for (let i = 0; i < 5; i++) d.push(chunk(128, i, i));
    const p = d.drain(add, idle);
    for (let i = 5; i < 20; i++) {
      d.push(chunk(128, i, i));
      await new Promise((r) => setTimeout(r, 0));
    }
    d.close();
    await p;

    expect(got).toHaveLength(20);
    // In order + contiguous timestamps across the whole take.
    got.forEach((s, i) => {
      expect(s.data[0]).toBe(i);              // L plane value === push index
      expect(s.timestamp).toBeCloseTo((i * 128) / SR, 12);
    });
    expect(d.framesEmitted).toBe(20 * 128);
    expect(d.pendingFrames).toBe(0);
    // The queue genuinely backed up at some point (proves the backpressure path).
    expect(d.peakPendingFrames).toBeGreaterThan(128);
  });

  it('drains a fully pre-filled queue then exits on close()', async () => {
    const d = new AudioCaptureDrain(SR);
    for (let i = 0; i < 4; i++) d.push(chunk(128, i, i));
    d.close();
    const got: CaptureSampleInit[] = [];
    await d.drain(async (s) => { got.push(s); }, () => Promise.resolve());
    expect(got).toHaveLength(4);
  });

  it('a second concurrent drain() is a no-op (single-flight)', async () => {
    const d = new AudioCaptureDrain(SR);
    d.push(chunk(128, 1, 1));
    let adds = 0;
    const add = async () => { await new Promise((r) => setTimeout(r, 0)); adds++; };
    const p1 = d.drain(add, () => new Promise((r) => setTimeout(r, 0)));
    const p2 = d.drain(add, () => new Promise((r) => setTimeout(r, 0))); // no-op
    await new Promise((r) => setTimeout(r, 5));
    d.close();
    await Promise.all([p1, p2]);
    expect(adds).toBe(1); // the chunk was added exactly once, not twice
  });
});
