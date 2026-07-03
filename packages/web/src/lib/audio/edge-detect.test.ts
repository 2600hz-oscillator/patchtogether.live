// packages/web/src/lib/audio/edge-detect.test.ts
//
// Regression coverage for the overlap-rescan double-count bug class
// (NUMPAD+/ATLANTIS-CATALYST): a main-thread consumer that re-scans
// the WHOLE 2048-sample analyser buffer every ~25 ms tick counts a rising edge
// that sits in the ~17 ms overlap TWICE → one clock pulse advances two steps.
// createEdgeCounter owns the new-samples-since-last-tick window so this cannot
// happen. These tests drive it through a fake analyser + clock.

import { describe, it, expect } from 'vitest';
import { createEdgeCounter } from './edge-detect';

const SR = 48000;
const FFT = 2048;
const HOP_S = 0.025; // 25 ms scheduler tick
const HOP_N = Math.round(HOP_S * SR); // 1200 samples/tick

/** A fake AnalyserNode whose ring buffer the test sets explicitly. */
class FakeAnalyser {
  fftSize = FFT;
  private _buf: Float32Array<ArrayBuffer> = new Float32Array(FFT);
  set(b: Float32Array<ArrayBuffer>): void {
    this._buf = b;
  }
  getFloatTimeDomainData(out: Float32Array): void {
    out.set(this._buf);
  }
}

/** Mutable fake context — we advance currentTime by hand between polls. */
function fakeCtx(): { sampleRate: number; currentTime: number } {
  return { sampleRate: SR, currentTime: 0 };
}

/** Build a 2048 buffer: low everywhere except [hiStart, hiEnd) set to 1. */
function buf(hiStart: number, hiEnd: number): Float32Array<ArrayBuffer> {
  const b = new Float32Array(FFT);
  for (let i = Math.max(0, hiStart); i < Math.min(FFT, hiEnd); i++) b[i] = 1;
  return b;
}

describe('createEdgeCounter — windowed rising-edge detection', () => {
  it('a HELD-HIGH level fires EXACTLY ONCE across many ticks (the bug)', () => {
    const ctx = fakeCtx();
    const ana = new FakeAnalyser();
    const counter = createEdgeCounter({ ctx: ctx as unknown as BaseAudioContext, analyser: ana as unknown as AnalyserNode });

    // Gate goes high and STAYS high (a held step gate patched as a clock).
    ana.set(buf(0, FFT));
    let total = 0;
    for (let tick = 0; tick < 10; tick++) {
      ctx.currentTime += HOP_S;
      total += counter.poll(ctx.currentTime);
    }
    // Old whole-buffer rescan would have counted the same rising edge on the
    // first tick AND re-counted it in the overlap on the next — and a level
    // that never falls would never re-arm, but the symptom class is "more than
    // one". Windowed → exactly one rise, ever.
    expect(total).toBe(1);
  });

  it('does NOT re-count a single pulse that lingers in the buffer overlap', () => {
    const ctx = fakeCtx();
    const ana = new FakeAnalyser();
    const counter = createEdgeCounter({ ctx: ctx as unknown as BaseAudioContext, analyser: ana as unknown as AnalyserNode });

    // Tick 1: a short pulse near the END of the buffer (just arrived).
    ctx.currentTime += HOP_S;
    ana.set(buf(FFT - 40, FFT)); // rising edge at FFT-40, within the new window
    expect(counter.poll(ctx.currentTime)).toBe(1);

    // Tick 2: the SAME pulse has slid left by HOP_N samples — it is still
    // physically present in the 2048-ring but now OUTSIDE the new-samples
    // window. A whole-buffer rescan would re-detect its rising edge (double
    // count); the windowed counter must NOT.
    ctx.currentTime += HOP_S;
    ana.set(buf(FFT - 40 - HOP_N, FFT - HOP_N));
    expect(counter.poll(ctx.currentTime)).toBe(0);
  });

  it('counts genuinely distinct pulses on distinct ticks', () => {
    const ctx = fakeCtx();
    const ana = new FakeAnalyser();
    const counter = createEdgeCounter({ ctx: ctx as unknown as BaseAudioContext, analyser: ana as unknown as AnalyserNode });

    // Pulse A in tick 1.
    ctx.currentTime += HOP_S;
    ana.set(buf(FFT - 30, FFT));
    expect(counter.poll(ctx.currentTime)).toBe(1);

    // Tick 2: A has fully fallen (low), a NEW pulse B arrives in the new window.
    ctx.currentTime += HOP_S;
    ana.set(buf(FFT - 20, FFT));
    expect(counter.poll(ctx.currentTime)).toBe(1);
  });

  it('respects the 0.5 threshold (sub-threshold ripple counts nothing)', () => {
    const ctx = fakeCtx();
    const ana = new FakeAnalyser();
    const counter = createEdgeCounter({ ctx: ctx as unknown as BaseAudioContext, analyser: ana as unknown as AnalyserNode });
    const b = new Float32Array(FFT).fill(0.4); // never crosses 0.5
    ctx.currentTime += HOP_S;
    ana.set(b);
    expect(counter.poll(ctx.currentTime)).toBe(0);
  });

  it('reset() re-arms so the next high is a fresh rising edge', () => {
    const ctx = fakeCtx();
    const ana = new FakeAnalyser();
    const counter = createEdgeCounter({ ctx: ctx as unknown as BaseAudioContext, analyser: ana as unknown as AnalyserNode });

    ana.set(buf(0, FFT)); // held high
    ctx.currentTime += HOP_S;
    expect(counter.poll(ctx.currentTime)).toBe(1);
    ctx.currentTime += HOP_S;
    expect(counter.poll(ctx.currentTime)).toBe(0); // still high, no new edge

    counter.reset(); // forget cross-tick state
    ctx.currentTime += HOP_S;
    // Buffer still all-high; after reset, last=0, so the first sample reads as
    // a fresh rising edge.
    expect(counter.poll(ctx.currentTime)).toBe(1);
  });
});
