// packages/web/src/lib/audio/wavetable-presets.test.ts
//
// Unit coverage for the preset registry (46 entries; stable ids/labels/urls)
// + the lenient WAV→number[][] parser (16-bit PCM, 32-bit float, stereo,
// non-256-multiple → zero-pad).
//
// (The spec asked for "45 presets" but the enumerated filename list contained
// 46 — see WAVETABLE_PRESETS header.)

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  WAVETABLE_PRESETS,
  PRESET_FRAME_SIZE,
  getWavetablePreset,
  loadWavetablePreset,
  parseWavetablePresetBuffer,
} from './wavetable-presets';

// ---------- registry ----------

describe('WAVETABLE_PRESETS', () => {
  it('has exactly 46 entries', () => {
    // Spec said 45; enumerated filename list was 46. We bundle all 46.
    expect(WAVETABLE_PRESETS).toHaveLength(46);
  });

  it('each entry has unique id, non-empty label, non-empty url', () => {
    const ids = new Set<string>();
    for (const p of WAVETABLE_PRESETS) {
      expect(p.id, `preset.id empty`).not.toBe('');
      expect(p.label, `preset(${p.id}).label empty`).not.toBe('');
      expect(p.url, `preset(${p.id}).url empty`).not.toBe('');
      expect(ids.has(p.id), `duplicate id ${p.id}`).toBe(false);
      ids.add(p.id);
    }
  });

  it('id is all-lowercase (stable storage key)', () => {
    for (const p of WAVETABLE_PRESETS) {
      expect(p.id, `${p.id} should be lowercase`).toBe(p.id.toLowerCase());
    }
  });

  it('url is served from /wavetables/ and ends with .WAV', () => {
    for (const p of WAVETABLE_PRESETS) {
      expect(p.url.startsWith('/wavetables/'), `${p.id} url: ${p.url}`).toBe(true);
      expect(p.url.endsWith('.WAV'), `${p.id} url: ${p.url}`).toBe(true);
    }
  });

  it('label matches id when uppercased (round-trip filename convention)', () => {
    for (const p of WAVETABLE_PRESETS) {
      // The label is the filename-without-.WAV ALL-CAPS; the id is its
      // lower-case form. So label.toLowerCase() must equal id, and the
      // url stem must equal label.
      expect(p.label.toLowerCase()).toBe(p.id);
      const stem = p.url.replace(/^\/wavetables\//, '').replace(/\.WAV$/, '');
      expect(stem).toBe(p.label);
    }
  });

  it('getWavetablePreset round-trips', () => {
    const first = WAVETABLE_PRESETS[0]!;
    expect(getWavetablePreset(first.id)).toBe(first);
    expect(getWavetablePreset('nope-no-such-preset')).toBeUndefined();
  });
});

// ---------- synthetic WAV helpers (test only) ----------

/** Build a minimal RIFF/WAVE/fmt /data WAV.
 *  - `format` = 1 for PCM16 (16-bit signed), 3 for IEEE-754 float (32-bit).
 *  - `channels` controls the interleave width.
 *  - `samples` is a flat interleaved Float32Array (length = channels * frames).
 */
function makeWav(
  format: 1 | 3,
  bitsPerSample: 16 | 32,
  channels: number,
  sampleRate: number,
  interleaved: Float32Array,
): ArrayBuffer {
  const bytesPerSample = bitsPerSample / 8;
  const dataLen = interleaved.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(view, 8, 'WAVE');
  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLen, true);
  // payload
  let off = 44;
  for (let i = 0; i < interleaved.length; i++) {
    const x = interleaved[i]!;
    if (format === 1 && bitsPerSample === 16) {
      const clamped = Math.max(-1, Math.min(1, x));
      const i16 = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
      view.setInt16(off, i16, true);
      off += 2;
    } else if (format === 3 && bitsPerSample === 32) {
      view.setFloat32(off, x, true);
      off += 4;
    } else {
      throw new Error(`makeWav: unsupported format/${bitsPerSample}`);
    }
  }
  return buf;
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

// ---------- parseWavetablePresetBuffer ----------

describe('parseWavetablePresetBuffer', () => {
  it('parses a 256-sample 16-bit PCM mono WAV into one frame of 256', () => {
    const samples = new Float32Array(256);
    for (let i = 0; i < 256; i++) samples[i] = Math.sin((2 * Math.PI * i) / 256);
    const buf = makeWav(1, 16, 1, 44100, samples);

    const parsed = parseWavetablePresetBuffer(buf, 256);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]).toHaveLength(256);
    expect(parsed.channels).toBe(1);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.frameSize).toBe(256);
    // PCM16 round-trip is lossy by ~1/32767; check shape, not exact bits.
    for (let i = 0; i < 256; i++) {
      expect(parsed.frames[0]![i]!).toBeCloseTo(samples[i]!, 3);
    }
  });

  it('zero-pads the last frame when samples are NOT a multiple of frameSize', () => {
    // 257 samples → 2 frames, second frame is 1 real + 255 zeros.
    const samples = new Float32Array(257);
    samples[0] = 0.5;
    samples[256] = -0.5;
    const buf = makeWav(1, 16, 1, 44100, samples);

    const parsed = parseWavetablePresetBuffer(buf, 256);
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[0]).toHaveLength(256);
    expect(parsed.frames[1]).toHaveLength(256);
    // First frame is the 256 leading samples.
    expect(parsed.frames[0]![0]!).toBeCloseTo(0.5, 3);
    // Second frame: index 0 is the 257th sample (-0.5), 1..255 are padding (0).
    expect(parsed.frames[1]![0]!).toBeCloseTo(-0.5, 3);
    for (let i = 1; i < 256; i++) {
      expect(parsed.frames[1]![i]!).toBe(0);
    }
  });

  it('parses a 32-bit IEEE-float WAV', () => {
    const samples = new Float32Array(256);
    for (let i = 0; i < 256; i++) samples[i] = i / 256 - 0.5; // [-0.5..+0.498]
    const buf = makeWav(3, 32, 1, 48000, samples);

    const parsed = parseWavetablePresetBuffer(buf, 256);
    expect(parsed.bitsPerSample).toBe(32);
    expect(parsed.sampleRate).toBe(48000);
    expect(parsed.frames).toHaveLength(1);
    for (let i = 0; i < 256; i++) {
      // Float WAV is lossless.
      expect(parsed.frames[0]![i]!).toBeCloseTo(samples[i]!, 6);
    }
  });

  it('takes channel 0 of a stereo WAV (discards channel 1)', () => {
    // Stereo, 256 frames. ch0 = +0.5, ch1 = -0.9. We must see +0.5 in the output.
    const interleaved = new Float32Array(256 * 2);
    for (let i = 0; i < 256; i++) {
      interleaved[i * 2 + 0] = 0.5;
      interleaved[i * 2 + 1] = -0.9;
    }
    const buf = makeWav(1, 16, 2, 44100, interleaved);
    const parsed = parseWavetablePresetBuffer(buf, 256);
    expect(parsed.channels).toBe(2);
    expect(parsed.frames).toHaveLength(1);
    for (let i = 0; i < 256; i++) {
      expect(parsed.frames[0]![i]!).toBeCloseTo(0.5, 3);
    }
  });

  it('rejects an unsupported sample format', () => {
    // Pretend audioFormat = 7 (mu-law) and bitsPerSample = 8. We never write
    // such files, but a paranoid future user might point loadWavetablePreset
    // at something exotic. We refuse rather than silently misread it.
    const buf = makeWav(1, 16, 1, 44100, new Float32Array(8));
    const view = new DataView(buf);
    view.setUint16(20, 7, true); // poison audioFormat
    view.setUint16(34, 8, true); // poison bps
    expect(() => parseWavetablePresetBuffer(buf, 256)).toThrow(/unsupported WAV format/);
  });

  it('rejects a non-RIFF buffer', () => {
    const buf = new ArrayBuffer(100);
    expect(() => parseWavetablePresetBuffer(buf, 256)).toThrow(/RIFF/);
  });

  it('rejects an unreasonable frameSize', () => {
    const buf = makeWav(1, 16, 1, 44100, new Float32Array(256));
    expect(() => parseWavetablePresetBuffer(buf, 0)).toThrow(/frameSize/);
    expect(() => parseWavetablePresetBuffer(buf, -1)).toThrow(/frameSize/);
    expect(() => parseWavetablePresetBuffer(buf, 1.5)).toThrow(/frameSize/);
  });
});

// ---------- loadWavetablePreset (fetch wrapper) ----------

describe('loadWavetablePreset', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('fetches the URL, parses the result, and returns the frame array', async () => {
    const samples = new Float32Array(256);
    for (let i = 0; i < 256; i++) samples[i] = i / 255 * 2 - 1; // ramp -1..+1
    const buf = makeWav(1, 16, 1, 44100, samples);

    const fakeFetch = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => buf,
    }));
    globalThis.fetch = fakeFetch as unknown as typeof fetch;

    const parsed = await loadWavetablePreset('/wavetables/TEST.WAV', PRESET_FRAME_SIZE);
    expect(fakeFetch).toHaveBeenCalledWith('/wavetables/TEST.WAV');
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]).toHaveLength(256);
  });

  it('throws when fetch returns !ok', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    await expect(loadWavetablePreset('/wavetables/MISSING.WAV')).rejects.toThrow(/404/);
  });
});
