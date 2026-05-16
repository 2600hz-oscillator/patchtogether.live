// packages/web/src/lib/audio/modules/samsloop.test.ts
//
// Unit tests for SAMSLOOP:
//   - module-def shape (ports, params, registry)
//   - WAV size rejection (>250 KB returns a clear error, no decode attempted)
//   - loop vs one-shot semantics in samsloopMath.render
//   - varispeed mapping (slider → playback rate) covering ±2 × forward / reverse
//   - start/end clamp logic enforces start < end inside the buffer
//
// The worklet itself (packages/dsp/src/samsloop.ts) mirrors this math; the
// AudioWorkletProcessor isn't importable under vitest so we exercise the
// pure-math `samsloopMath` mirror, same pattern as macrooscillator.test.ts.

import { describe, expect, it } from 'vitest';
import {
  samsloopDef,
  samsloopMath,
  loadSamsloopWav,
  SAMSLOOP_MAX_FILE_BYTES,
  SAMSLOOP_RATE_RANGE,
} from './samsloop';

// ---------- module-def shape ----------

describe('samsloopDef shape', () => {
  it('declares type=samsloop, label=SAMSLOOP, category=sources', () => {
    expect(samsloopDef.type).toBe('samsloop');
    expect(samsloopDef.label).toBe('SAMSLOOP');
    expect(samsloopDef.category).toBe('sources');
  });

  it('exposes the expected I/O surface (trig + rate_cv in, mono out)', () => {
    const inIds = samsloopDef.inputs.map((p) => p.id);
    expect(inIds).toEqual(['trig', 'rate_cv']);
    const outIds = samsloopDef.outputs.map((p) => p.id);
    expect(outIds).toEqual(['out']);
    expect(samsloopDef.outputs[0]!.type).toBe('audio');
  });

  it('exposes the expected params: rate / mode / start / end', () => {
    const ids = samsloopDef.params.map((p) => p.id);
    expect(ids).toEqual(['rate', 'mode', 'start', 'end']);
  });

  it('rate_cv routes through the rate AudioParam (cvScale: linear)', () => {
    const port = samsloopDef.inputs.find((p) => p.id === 'rate_cv')!;
    expect(port.paramTarget).toBe('rate');
    expect(port.cvScale).toEqual({ mode: 'linear' });
  });

  it('mode param is discrete 0..1 (1-shot / loop)', () => {
    const p = samsloopDef.params.find((p) => p.id === 'mode')!;
    expect(p.curve).toBe('discrete');
    expect(p.min).toBe(0);
    expect(p.max).toBe(1);
  });

  it('rate param: −2..+2 with default 1.0 (slider center = forward unity)', () => {
    const p = samsloopDef.params.find((p) => p.id === 'rate')!;
    expect(p.min).toBe(SAMSLOOP_RATE_RANGE.min);
    expect(p.max).toBe(SAMSLOOP_RATE_RANGE.max);
    expect(p.defaultValue).toBe(SAMSLOOP_RATE_RANGE.defaultValue);
  });
});

// ---------- WAV size rejection ----------

describe('loadSamsloopWav size limit', () => {
  // Minimal fake BaseAudioContext — we only ever exercise the size path
  // here, so decodeAudioData should never be called. The test asserts that.
  function makeCtx(): { ctx: BaseAudioContext; calls: number } {
    let calls = 0;
    const ctx = {
      decodeAudioData: async (_ab: ArrayBuffer) => {
        calls++;
        // Should be unreachable in the rejection path.
        return { length: 0, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(0) } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    return { ctx, get calls() { return calls; } } as { ctx: BaseAudioContext; calls: number };
  }

  it(`rejects files over ${SAMSLOOP_MAX_FILE_BYTES} bytes with a clear error`, async () => {
    const { ctx } = makeCtx();
    const oversized = {
      size: SAMSLOOP_MAX_FILE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(SAMSLOOP_MAX_FILE_BYTES + 1),
    };
    const result = await loadSamsloopWav(oversized, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too large/i);
    expect(result.error).toMatch(/250 KB/i);
    expect(result.samples).toBeUndefined();
  });

  it('does NOT attempt to decode oversize files (early bail)', async () => {
    const probe = makeCtx();
    const oversized = {
      size: SAMSLOOP_MAX_FILE_BYTES * 4,
      arrayBuffer: async () => new ArrayBuffer(SAMSLOOP_MAX_FILE_BYTES * 4),
    };
    await loadSamsloopWav(oversized, probe.ctx);
    expect(probe.calls).toBe(0);
  });

  it('accepts a file exactly at the limit', async () => {
    // Build a tiny synthetic WAV in-memory and stub decodeAudioData to
    // return a 1-sample mono buffer. We're only testing that the size
    // gate passes when size === SAMSLOOP_MAX_FILE_BYTES.
    const ctx = {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => {
        return {
          length: 1,
          numberOfChannels: 1,
          sampleRate: 22050,
          getChannelData: () => new Float32Array([0.5]),
        } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    const fakeFile = {
      size: SAMSLOOP_MAX_FILE_BYTES,
      arrayBuffer: async () => new ArrayBuffer(SAMSLOOP_MAX_FILE_BYTES),
    };
    const result = await loadSamsloopWav(fakeFile, ctx);
    expect(result.ok).toBe(true);
    expect(result.samples).toBeDefined();
    expect(result.samples!.length).toBe(1);
  });
});

// ---------- varispeed mapping ----------

describe('samsloopMath.sliderToRate', () => {
  it('center (1.0) → unity forward', () => {
    expect(samsloopMath.sliderToRate(1)).toBe(1);
  });

  it('full right (+2.0) → 2× forward', () => {
    expect(samsloopMath.sliderToRate(2)).toBe(2);
  });

  it('full left (−2.0) → 2× reverse', () => {
    expect(samsloopMath.sliderToRate(-2)).toBe(-2);
  });

  it('0 → halts pitch but still advances (slider value === playback rate)', () => {
    // 0 isn't a meaningful musical value on the slider, but it IS a valid
    // value; the rate becomes 0 and the cursor stops. The slider's center
    // is +1, not 0 — see the rate fader's defaultValue in samsloopDef.
    expect(samsloopMath.sliderToRate(0)).toBe(0);
  });

  it('values past the limits clamp to ±2', () => {
    expect(samsloopMath.sliderToRate(10)).toBe(2);
    expect(samsloopMath.sliderToRate(-10)).toBe(-2);
  });

  it('the convention: center = forward 100%, NOT zero', () => {
    // Sanity check for the slider mapping: the default value is +1, and
    // +1 maps to forward unity. This is the load-bearing constraint the
    // task brief calls out — "0 V CV, slider mid = 1.0× normal playback".
    const c = samsloopDef.params.find((p) => p.id === 'rate')!.defaultValue;
    expect(samsloopMath.sliderToRate(c)).toBe(1.0);
  });
});

// ---------- start/end clamp ----------

describe('samsloopMath.clampWindow', () => {
  it('start < end in [0, len]', () => {
    const { start, end } = samsloopMath.clampWindow(10, 100, 200);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(200);
  });

  it('clamps negative start to 0', () => {
    const w = samsloopMath.clampWindow(-50, 100, 200);
    expect(w.start).toBe(0);
    expect(w.end).toBe(100);
  });

  it('clamps end past buffer length to length', () => {
    const w = samsloopMath.clampWindow(10, 9999, 500);
    expect(w.start).toBe(10);
    expect(w.end).toBe(500);
  });

  it('enforces start < end even when caller passes start === end', () => {
    const w = samsloopMath.clampWindow(50, 50, 200);
    expect(w.end).toBeGreaterThan(w.start);
  });

  it('enforces start < end when caller passes start > end', () => {
    const w = samsloopMath.clampWindow(150, 50, 200);
    expect(w.end).toBeGreaterThan(w.start);
  });

  it('clamps start to len-1 for too-large start', () => {
    const w = samsloopMath.clampWindow(1000, 1200, 500);
    expect(w.start).toBe(499);
    expect(w.end).toBe(500);
  });
});

// ---------- loop vs one-shot semantics ----------

function rampBuffer(n: number): Float32Array {
  // Buffer with `samples[i] = i/n` so we can identify which position the
  // cursor was at by inspecting an output sample.
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = i / n;
  return buf;
}

describe('samsloopMath.render — loop mode', () => {
  it('forward playback inside the window produces non-zero samples', () => {
    const buf = rampBuffer(100);
    const { out, active } = samsloopMath.render(buf, 50, 1, 0, 100, 'loop');
    expect(active).toBe(true);
    expect(out[0]).toBe(0);
    expect(out[49]).toBeCloseTo(49 / 100, 5);
  });

  it('looping wraps cursor: forward playback past `end` resumes near `start`', () => {
    // Window [0..100), rate=1, render 250 samples → cursor wraps twice.
    // After wrap, sample N should equal (N % 100) / 100.
    const buf = rampBuffer(100);
    const { out } = samsloopMath.render(buf, 250, 1, 0, 100, 'loop');
    expect(out[105]).toBeCloseTo(5 / 100, 5);
    expect(out[210]).toBeCloseTo(10 / 100, 5);
  });

  it('reverse playback (rate < 0) starts at end-1 and walks backward', () => {
    const buf = rampBuffer(100);
    const { out } = samsloopMath.render(buf, 50, -1, 0, 100, 'loop');
    expect(out[0]).toBeCloseTo(99 / 100, 5);
    expect(out[10]).toBeCloseTo(89 / 100, 5);
  });

  it('reverse playback wraps from start back to end-1 in loop mode', () => {
    const buf = rampBuffer(100);
    // Start at 99, decrement by 1 each sample. After 100 samples we wrap.
    const { out } = samsloopMath.render(buf, 150, -1, 0, 100, 'loop');
    // At i=0 cursor=99 → value 0.99. At i=99 cursor=0 → value 0. At i=100
    // we've wrapped; cursor should be near end-1 again. Look around i=100.
    expect(out[0]).toBeCloseTo(99 / 100, 5);
    expect(out[99]).toBeCloseTo(0 / 100, 5);
    // After the wrap, we should be back near the high end of the buffer.
    expect(out[101]).toBeGreaterThan(0.5);
  });

  it('rate=2 (forward 2× slider) advances cursor 2× per output sample', () => {
    // Buffer of 200 samples, window [0..200), rate=2 → 100 output samples
    // cover the full buffer.
    const buf = rampBuffer(200);
    const { out } = samsloopMath.render(buf, 100, 2, 0, 200, 'loop');
    // Sample 50: cursor = 100. Value should be ~0.5.
    expect(out[50]).toBeCloseTo(100 / 200, 4);
  });

  it('rate=-2 (reverse 2× slider) walks back 2× per output sample', () => {
    const buf = rampBuffer(200);
    const { out } = samsloopMath.render(buf, 100, -2, 0, 200, 'loop');
    // Sample 0: cursor = 199. Value ~ 0.995.
    expect(out[0]).toBeCloseTo(199 / 200, 4);
    // Sample 50: cursor ≈ 99.
    expect(out[50]).toBeCloseTo(99 / 200, 4);
  });
});

describe('samsloopMath.render — one-shot mode', () => {
  it('one-shot mode stops at end-of-window and emits silence after', () => {
    const buf = rampBuffer(100);
    // Window [0..100), rate=1, render 150 samples. After sample 100 we
    // should be silent.
    const { out, active } = samsloopMath.render(buf, 150, 1, 0, 100, 'one-shot');
    expect(active).toBe(false);
    expect(out[110]).toBe(0);
    expect(out[140]).toBe(0);
  });

  it('one-shot reverse stops at start and emits silence after', () => {
    const buf = rampBuffer(100);
    const { out, active } = samsloopMath.render(buf, 150, -1, 0, 100, 'one-shot');
    expect(active).toBe(false);
    expect(out[110]).toBe(0);
  });
});

describe('samsloopMath.render — empty buffer', () => {
  it('renders silence for an empty buffer with no crashes', () => {
    const empty = new Float32Array(0);
    const { out, active } = samsloopMath.render(empty, 50, 1, 0, 100, 'loop');
    expect(active).toBe(false);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});
