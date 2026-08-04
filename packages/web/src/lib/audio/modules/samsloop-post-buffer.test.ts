// packages/web/src/lib/audio/modules/samsloop-post-buffer.test.ts
//
// THE TEST WHOSE ABSENCE SHIPPED A DEAD START/END WINDOW.
//
// The regression (#1316 → owner report): the engine factory's RECORD branch
// did
//
//     postBuffer(f32, rate);                       // transfers f32.buffer
//     if (ld.sampleLength !== f32.length) ld.sampleLength = f32.length;
//
// `postMessage(msg, [f32.buffer])` TRANSFERS the ArrayBuffer, which DETACHES
// every view onto it — so by the next statement `f32.length` is **0**, and
// every recording persisted `node.data.sampleLength = 0`. `SamsloopCard` sizes
// BOTH window faders to `Math.max(1, sampleLength)`, so on a 40 000-frame take
// START and END became [0, 1] sliders: START moved the play head by at most one
// sample (a control that visibly does nothing), touching END wrote an `end` the
// worklet clamped to a one-sample window (silence), and the card's
// `end / samples.length` highlight band collapsed to zero width so the waveform
// panel lost its lit wash and read as black.
//
// WHY THIS IS A UNIT TEST AND NOT ONLY AN E2E. The hazard is a JS OBJECT-MODEL
// fact — "a transferred buffer detaches its views" — not an audio fact, so it
// is checkable with a real MessageChannel, no AudioContext, and zero flake. And
// it needs its OWN negative control, because a test that only asserts
// `postSampleBuffer(...) === 40000` would pass just as happily against an
// implementation that never transferred anything at all. So leg (b) asserts the
// detachment REALLY HAPPENS on this runtime — if it ever stopped, this suite
// would be certifying a property it no longer tests.

import { describe, it, expect } from 'vitest';
import { postSampleBuffer, type SamsloopSamplePort } from './samsloop';

/** A port that records what it received and performs a REAL transfer. */
function recordingPort(): {
  port: SamsloopSamplePort;
  seen: Array<{ type?: string; byteLength: number; sampleRate?: number }>;
} {
  const seen: Array<{ type?: string; byteLength: number; sampleRate?: number }> = [];
  const chan = new MessageChannel();
  const port: SamsloopSamplePort = {
    postMessage(message, transfer) {
      const m = message as { type?: string; samples: ArrayBuffer; sampleRate?: number };
      seen.push({ type: m.type, byteLength: m.samples.byteLength, sampleRate: m.sampleRate });
      // The REAL thing: hand the buffer to another port, which detaches it here.
      chan.port1.postMessage(message, transfer);
    },
  };
  return { port, seen };
}

const FRAMES = 40_000;

function take(frames = FRAMES): Float32Array {
  const f = new Float32Array(frames);
  for (let i = 0; i < frames; i++) f[i] = Math.sin(i / 17) * 0.8;
  return f;
}

describe('postSampleBuffer — the frame count must survive the transfer', () => {
  it('(a) returns the PRE-TRANSFER frame count, which is what sampleLength caches', () => {
    const { port, seen } = recordingPort();
    const f32 = take();

    const frames = postSampleBuffer(port, f32, 44100);

    expect(frames, 'the returned count is what node.data.sampleLength stores').toBe(FRAMES);
    // And it really was posted, with the payload the worklet expects.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('loadSample');
    expect(seen[0]!.byteLength).toBe(FRAMES * 4);
    expect(seen[0]!.sampleRate).toBe(44100);
  });

  it('(b) NEGATIVE CONTROL: the view IS detached afterwards — reading f32.length there gives 0', () => {
    const { port } = recordingPort();
    const f32 = take();

    const frames = postSampleBuffer(port, f32, 44100);

    // This is the shipped bug, stated as an assertion. If this ever fails the
    // runtime stopped detaching and leg (a) is no longer testing anything.
    expect(
      f32.length,
      'a transferred ArrayBuffer must detach its views — that is the hazard this helper exists to hide',
    ).toBe(0);
    expect(f32.buffer.byteLength, 'the ArrayBuffer itself is detached').toBe(0);
    // …and the two readings genuinely differ, so the helper is load-bearing.
    expect(frames).not.toBe(f32.length);
    expect(frames).toBe(FRAMES);
  });

  it('(c) the count is the BUFFER\'s, not the delivery\'s: a torn-down port still reports it', () => {
    // The factory swallows a post that throws (the node can be disposed between
    // the decode resolving and the post). The frame count describes the buffer,
    // so bookkeeping must not silently become 0 on that race either.
    const port: SamsloopSamplePort = {
      postMessage() { throw new DOMException('port closed', 'InvalidStateError'); },
    };
    const f32 = take(1234);
    expect(postSampleBuffer(port, f32, 22050)).toBe(1234);
  });

  it('(d) an empty buffer reports 0 — "nothing to play" stays distinguishable', () => {
    const { port } = recordingPort();
    expect(postSampleBuffer(port, new Float32Array(0), 44100)).toBe(0);
  });
});

describe('the fader bound that made a wrong sampleLength user-visible', () => {
  // SamsloopCard: max={Math.max(1, sampleLength)} on BOTH window faders.
  // Pinned here so the coupling is stated where the regression lives: a
  // sampleLength of 0 does not degrade the control gracefully, it collapses it
  // to a single sample of travel.
  const faderMax = (sampleLength: number) => Math.max(1, sampleLength);

  it('sampleLength 0 collapses both window faders to one sample of travel', () => {
    expect(faderMax(0)).toBe(1);
  });

  it('a real take gives the faders the take\'s full range', () => {
    expect(faderMax(FRAMES)).toBe(FRAMES);
  });
});
