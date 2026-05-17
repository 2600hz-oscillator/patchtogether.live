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
  samsloopDownsample,
  SAMSLOOP_MAX_FILE_BYTES,
  SAMSLOOP_MAX_SAMPLES,
  SAMSLOOP_MAX_DECODED_SAMPLES,
  SAMSLOOP_TARGET_SAMPLE_RATE,
  SAMSLOOP_RATE_RANGE,
  createSamsloopRecMachine,
  samsloopRecStart,
  samsloopRecAppend,
  samsloopRecStop,
  samsloopRecFail,
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

// ---------- multi-format gate (not WAV-only) ----------
//
// The gate must NOT discriminate by extension or magic bytes — it hands
// any bytes the picker accepts straight to decodeAudioData and lets the
// browser decide. This guards against the regression where the loader
// (or, more commonly, the file picker `accept` attribute) was wav-only,
// which silently rejected m4a / mp3 / ogg / flac uploads even though
// the underlying decoder supports them. The decoder is stubbed so the
// test exercises only the gate, not any real codec.
describe('loadSamsloopWav accepts any browser-decodable audio', () => {
  function makeMockingCtx(): BaseAudioContext {
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: 8,
        numberOfChannels: 1,
        sampleRate: 44100,
        getChannelData: () => new Float32Array([0.1, 0.2, 0.3, 0.4, -0.1, -0.2, -0.3, -0.4]),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  it('accepts an m4a file under the size cap (gate is not wav-only)', async () => {
    const fakeM4a = {
      size: 25 * 1024,
      arrayBuffer: async () => new ArrayBuffer(25 * 1024),
    };
    const result = await loadSamsloopWav(fakeM4a, makeMockingCtx());
    expect(result.ok).toBe(true);
    expect(result.samples).toBeDefined();
    expect(result.samples!.length).toBe(8);
    expect(result.sampleRate).toBe(44100);
  });

  it('accepts an mp3 file under the size cap', async () => {
    const fakeMp3 = {
      size: 50 * 1024,
      arrayBuffer: async () => new ArrayBuffer(50 * 1024),
    };
    const result = await loadSamsloopWav(fakeMp3, makeMockingCtx());
    expect(result.ok).toBe(true);
    expect(result.samples).toBeDefined();
  });

  it('reports a friendly "could not decode audio" error (no "WAV" in the copy)', async () => {
    // The decoder rejects → the gate surfaces a format-agnostic message.
    const failingCtx = {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => {
        throw new Error('EncodingError: Unable to decode audio data');
      },
    } as unknown as BaseAudioContext;
    const fakeBlob = {
      size: 1024,
      arrayBuffer: async () => new ArrayBuffer(1024),
    };
    const result = await loadSamsloopWav(fakeBlob, failingCtx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not decode audio/i);
    expect(result.error).not.toMatch(/\bWAV\b/);
  });
});

// ---------- decoded-buffer cap + downsample (load-hang regression) ----------
//
// Regression: a 43 KB 8-bit mono 16 kHz WAV got stuck on "parsing..."
// indefinitely. The raw-file gate (250 KB) passed, but the decoder
// upsampled to the context's native 48 kHz rate (3× sample count), and
// writing the resulting Array<number> into the syncedstore CRDT
// serialized one YArray record per sample — locking the main thread
// for 10+ seconds and broadcasting the same payload to every peer in
// the rackspace. The fix downsamples to a target rate (24 kHz) before
// returning + adds a decoded-buffer cap that fires AFTER decode so a
// small upload that decodes to a huge buffer is rejected cleanly.

describe('samsloopDownsample', () => {
  it('returns the input unchanged when factor <= 1', () => {
    const buf = new Float32Array([0.1, 0.2, 0.3]);
    expect(samsloopDownsample(buf, 1)).toBe(buf);
    expect(samsloopDownsample(buf, 0)).toBe(buf);
  });

  it('halves length when factor=2 with a box-filter average', () => {
    const buf = new Float32Array([0.0, 1.0, 0.0, 1.0]);
    const out = samsloopDownsample(buf, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it('preserves DC offset (constant input → constant output)', () => {
    const buf = new Float32Array(12);
    buf.fill(0.42);
    const out = samsloopDownsample(buf, 3);
    expect(out.length).toBe(4);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(0.42, 6);
    }
  });
});

describe('loadSamsloopWav downsamples high-rate decoder output', () => {
  function makeCtx(decodedRate: number, decodedLen: number): BaseAudioContext {
    const data = new Float32Array(decodedLen);
    for (let i = 0; i < decodedLen; i++) data[i] = (i % 100) / 100;
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: decodedLen,
        numberOfChannels: 1,
        sampleRate: decodedRate,
        getChannelData: () => data,
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  it('downsamples 48 kHz decoder output to ~24 kHz (factor 2)', async () => {
    // Simulates the bug-report case: 8-bit mono 16 kHz WAV decoded by a
    // 48 kHz AudioContext → 65K samples in. After downsample factor 2
    // we get ~32K samples at 24 kHz.
    const ctx = makeCtx(48000, 65_000);
    const file = { size: 43_000, arrayBuffer: async () => new ArrayBuffer(43_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    expect(result.sampleRate).toBe(24000);
    // Length halves (factor=2 from floor(48000/24000)).
    expect(result.samples!.length).toBe(32_500);
  });

  it('keeps low-rate decoder output at its native rate (no downsample)', async () => {
    // 22 kHz decoder output is already below target — pass through.
    const ctx = makeCtx(22050, 10_000);
    const file = { size: 20_000, arrayBuffer: async () => new ArrayBuffer(20_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    expect(result.sampleRate).toBe(22050);
    expect(result.samples!.length).toBe(10_000);
  });

  it('confirms SAMSLOOP_TARGET_SAMPLE_RATE is 24 kHz', () => {
    expect(SAMSLOOP_TARGET_SAMPLE_RATE).toBe(24000);
  });
});

describe('loadSamsloopWav decoded-buffer cap', () => {
  function makeCtx(decodedLen: number): BaseAudioContext {
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: decodedLen,
        numberOfChannels: 1,
        sampleRate: 22050,
        getChannelData: () => new Float32Array(decodedLen),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  it('rejects buffers exceeding SAMSLOOP_MAX_DECODED_SAMPLES with a clear error', async () => {
    // Source rate 22050 (below target → no downsample applied) so we can
    // construct a buffer larger than the cap directly. The raw-file gate
    // is 250 KB which we satisfy with size: 100_000.
    const ctx = makeCtx(SAMSLOOP_MAX_DECODED_SAMPLES + 1);
    const file = { size: 100_000, arrayBuffer: async () => new ArrayBuffer(100_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/decoded buffer too large/i);
    expect(result.error).toMatch(new RegExp(String(SAMSLOOP_MAX_DECODED_SAMPLES)));
    expect(result.samples).toBeUndefined();
  });

  it('accepts buffers exactly at the cap', async () => {
    const ctx = makeCtx(SAMSLOOP_MAX_DECODED_SAMPLES);
    const file = { size: 100_000, arrayBuffer: async () => new ArrayBuffer(100_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    expect(result.samples!.length).toBe(SAMSLOOP_MAX_DECODED_SAMPLES);
  });

  it('cap fires AFTER downsample — high-rate input that fits post-downsample is accepted', async () => {
    // 48 kHz decoder output that's just over the cap pre-downsample but
    // comfortably under post-downsample (factor=2). Used to verify that
    // we measure the STORED buffer size, not the decoder's raw output.
    const preDownsampleLen = SAMSLOOP_MAX_DECODED_SAMPLES + 10_000;
    const ctx = {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: preDownsampleLen,
        numberOfChannels: 1,
        sampleRate: 48000,
        getChannelData: () => new Float32Array(preDownsampleLen),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
    const file = { size: 100_000, arrayBuffer: async () => new ArrayBuffer(100_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    // Length should be the downsampled count, well under the cap.
    expect(result.samples!.length).toBeLessThanOrEqual(SAMSLOOP_MAX_DECODED_SAMPLES);
    expect(result.sampleRate).toBe(24000);
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

// ---------- mic-record state machine ----------
//
// The state machine is pure; the card owns the actual MediaStream and
// AudioContext wiring. We test the transitions, the cap-enforcement
// auto-stop, and the one-sample-only invariant.

describe('samsloop mic-record state machine — transitions', () => {
  it('createSamsloopRecMachine starts in idle with empty samples', () => {
    const m = createSamsloopRecMachine(48000);
    expect(m.state).toBe('idle');
    expect(m.samples.length).toBe(0);
    expect(m.sampleRate).toBe(48000);
    expect(m.error).toBeNull();
    expect(m.stopReason).toBeNull();
  });

  it('samsloopRecStart: idle → recording, resets sample buffer', () => {
    const m = createSamsloopRecMachine(48000);
    const r = samsloopRecStart(m, 44100);
    expect(r.state).toBe('recording');
    expect(r.samples.length).toBe(0);
    expect(r.sampleRate).toBe(44100);
    expect(r.error).toBeNull();
  });

  it('samsloopRecStart on already-recording is a no-op (idempotent)', () => {
    let m = createSamsloopRecMachine(48000);
    m = samsloopRecStart(m, 48000);
    m = samsloopRecAppend(m, new Float32Array([0.1, 0.2, 0.3]));
    const before = m.samples;
    const after = samsloopRecStart(m, 48000);
    // Same object identity ⇒ no transition happened.
    expect(after).toBe(m);
    expect(after.samples).toBe(before);
  });

  it('samsloopRecStop: recording → stopped with stopReason=user', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    m = samsloopRecAppend(m, new Float32Array([0.5, 0.4]));
    const stopped = samsloopRecStop(m);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('user');
    expect(stopped.samples.length).toBe(2);
  });

  it('samsloopRecStop is a no-op when not recording', () => {
    const idle = createSamsloopRecMachine();
    expect(samsloopRecStop(idle)).toBe(idle);
    const stopped = samsloopRecStop(samsloopRecStop(samsloopRecStart(idle, 48000)));
    expect(stopped.state).toBe('stopped');
    // Calling stop on an already-stopped machine returns the same ref.
    expect(samsloopRecStop(stopped)).toBe(stopped);
  });

  it('samsloopRecFail returns to idle with an inline error message (NOT thrown)', () => {
    const m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    const failed = samsloopRecFail(m, 'Microphone permission denied');
    expect(failed.state).toBe('idle');
    expect(failed.error).toBe('Microphone permission denied');
    // Fresh sample buffer — failed recording does not leak partial samples.
    expect(failed.samples.length).toBe(0);
  });

  it('starting a fresh recording clears a previous error', () => {
    let m = samsloopRecFail(createSamsloopRecMachine(), 'No microphone available');
    expect(m.error).toBe('No microphone available');
    m = samsloopRecStart(m, 48000);
    expect(m.error).toBeNull();
    expect(m.state).toBe('recording');
  });
});

describe('samsloop mic-record state machine — append + cap', () => {
  it('samsloopRecAppend grows the sample buffer in order', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    m = samsloopRecAppend(m, new Float32Array([0.1, 0.2]));
    m = samsloopRecAppend(m, new Float32Array([0.3, 0.4]));
    expect(Array.from(m.samples)).toEqual([
      // toBeCloseTo not needed — we wrote literal values.
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
      expect.closeTo(0.4, 6),
    ]);
    expect(m.state).toBe('recording');
  });

  it('samsloopRecAppend on non-recording state is a no-op', () => {
    const idle = createSamsloopRecMachine();
    const out = samsloopRecAppend(idle, new Float32Array([0.5]));
    expect(out).toBe(idle);
    expect(out.samples.length).toBe(0);
  });

  it('SAMSLOOP_MAX_SAMPLES is SAMSLOOP_MAX_FILE_BYTES / 4 (Float32 size)', () => {
    expect(SAMSLOOP_MAX_SAMPLES).toBe(Math.floor(SAMSLOOP_MAX_FILE_BYTES / 4));
  });

  it('auto-stops with stopReason=cap when the cap is exceeded mid-chunk', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 22050);
    // Fill to one short of the cap.
    const fill = new Float32Array(SAMSLOOP_MAX_SAMPLES - 1);
    m = samsloopRecAppend(m, fill);
    expect(m.state).toBe('recording');
    // One more chunk pushes over: the helper truncates and stops.
    const oversize = new Float32Array(100);
    m = samsloopRecAppend(m, oversize);
    expect(m.state).toBe('stopped');
    expect(m.stopReason).toBe('cap');
    expect(m.samples.length).toBe(SAMSLOOP_MAX_SAMPLES);
  });

  it('append on a cap-stopped machine is a no-op (no further growth)', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 22050);
    m = samsloopRecAppend(m, new Float32Array(SAMSLOOP_MAX_SAMPLES));
    expect(m.state).toBe('stopped');
    const before = m.samples;
    m = samsloopRecAppend(m, new Float32Array([0.99]));
    expect(m.samples).toBe(before);
  });

  it('one-sample invariant: re-start while stopped DROPS the previous take', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    m = samsloopRecAppend(m, new Float32Array([0.1, 0.2, 0.3]));
    m = samsloopRecStop(m);
    expect(m.samples.length).toBe(3);
    // Starting fresh wipes the previous samples — SAMSLOOP holds ONE
    // sample at a time (see header comment on samsloop.ts).
    m = samsloopRecStart(m, 48000);
    expect(m.samples.length).toBe(0);
    expect(m.state).toBe('recording');
  });
});
