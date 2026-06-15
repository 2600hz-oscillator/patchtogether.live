// packages/web/src/lib/video/recorderbox-quality.test.ts
//
// Pure-logic coverage for the RECORDERBOX quality/size tiers + codec selection.
// All deterministic + browser-API-free: pickEncodeProfile takes an injectable
// canEncodeVideo probe so no real codec is needed (CI-safe).

import { describe, expect, it } from 'vitest';
import {
  pickEncodeProfile,
  coerceQuality,
  qualityLabel,
  QUALITY_VALUES,
  DEFAULT_QUALITY,
  BASELINE_H264_BITRATE,
  BASELINE_AUDIO_BITRATE,
  type RecorderboxQuality,
  type CanEncodeVideoFn,
} from '$lib/video/recorderbox-quality';

/** A probe that says yes to a fixed set of codecs, recording every call. */
function probeFor(supported: string[]): CanEncodeVideoFn & { calls: { codec: string; bitrate: number; width: number; height: number }[] } {
  const calls: { codec: string; bitrate: number; width: number; height: number }[] = [];
  const fn = (async (codec, opts) => {
    calls.push({ codec, bitrate: opts.bitrate, width: opts.width, height: opts.height });
    return supported.includes(codec);
  }) as CanEncodeVideoFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe('coerceQuality', () => {
  it('passes through the three valid tiers', () => {
    expect(coerceQuality('high')).toBe('high');
    expect(coerceQuality('balanced')).toBe('balanced');
    expect(coerceQuality('small')).toBe('small');
  });
  it('defaults anything else to the BALANCED default (owner default 2026-06-15)', () => {
    expect(coerceQuality(undefined)).toBe('balanced');
    expect(coerceQuality(null)).toBe('balanced');
    expect(coerceQuality('garbage')).toBe('balanced');
    expect(coerceQuality(42)).toBe('balanced');
    expect(DEFAULT_QUALITY).toBe('balanced');
  });
});

describe('qualityLabel + QUALITY_VALUES', () => {
  it('labels every tier', () => {
    expect(qualityLabel('high')).toBe('HIGH');
    expect(qualityLabel('balanced')).toBe('BALANCED');
    expect(qualityLabel('small')).toBe('SMALL');
  });
  it('QUALITY_VALUES holds exactly the three tiers in order', () => {
    expect([...QUALITY_VALUES]).toEqual(['high', 'balanced', 'small']);
  });
});

describe('pickEncodeProfile — HIGH preserves the original H.264 baseline', () => {
  it('HIGH always picks H.264 at the full baseline bitrate + ~2 s GOP + 192 kbps audio', async () => {
    // Even with AV1 + VP9 available, HIGH stays H.264 (bit-identical default).
    const probe = probeFor(['av1', 'vp9', 'avc']);
    const p = await pickEncodeProfile('high', 1024, 768, probe);
    expect(p.videoCodec).toBe('avc');
    expect(p.videoBitrate).toBe(BASELINE_H264_BITRATE);
    expect(p.keyFrameInterval).toBe(2);
    expect(p.audioBitrate).toBe(BASELINE_AUDIO_BITRATE);
    // HIGH only ever probes avc — it never even considers a modern codec.
    expect(probe.calls.map((c) => c.codec)).toEqual(['avc']);
  });
});

describe('pickEncodeProfile — BALANCED / SMALL prefer a modern codec', () => {
  it('BALANCED picks AV1 when available, at a reduced + codec-adjusted bitrate', async () => {
    const probe = probeFor(['av1', 'vp9', 'avc']);
    const p = await pickEncodeProfile('balanced', 1024, 768, probe);
    expect(p.videoCodec).toBe('av1');
    // Strictly smaller than the HIGH baseline (the whole point).
    expect(p.videoBitrate).toBeLessThan(BASELINE_H264_BITRATE);
    expect(p.keyFrameInterval).toBeGreaterThan(2); // longer GOP than HIGH
    expect(p.audioBitrate).toBeLessThan(BASELINE_AUDIO_BITRATE);
    expect(probe.calls[0].codec).toBe('av1'); // probed AV1 first
  });

  it('SMALL is strictly smaller than BALANCED at every knob', async () => {
    const probe = probeFor(['av1', 'vp9', 'avc']);
    const bal = await pickEncodeProfile('balanced', 1024, 768, probe);
    const sml = await pickEncodeProfile('small', 1024, 768, probe);
    expect(sml.videoBitrate).toBeLessThan(bal.videoBitrate);
    expect(sml.keyFrameInterval).toBeGreaterThan(bal.keyFrameInterval);
    expect(sml.audioBitrate).toBeLessThanOrEqual(bal.audioBitrate);
  });

  it('falls back through the preference list: VP9 when AV1 is unavailable', async () => {
    const probe = probeFor(['vp9', 'avc']); // no AV1
    const p = await pickEncodeProfile('small', 1024, 768, probe);
    expect(p.videoCodec).toBe('vp9');
    // Probed AV1 (rejected) before VP9.
    expect(probe.calls.map((c) => c.codec)).toEqual(['av1', 'vp9']);
  });

  it('falls all the way back to H.264 when no modern codec encodes', async () => {
    const probe = probeFor(['avc']); // H.264 only (the typical Safari / older case)
    const p = await pickEncodeProfile('small', 1024, 768, probe);
    expect(p.videoCodec).toBe('avc');
    // Still a SMALL-tier bitrate (reduced) + long GOP — size win even on H.264.
    expect(p.videoBitrate).toBeLessThan(BASELINE_H264_BITRATE);
    expect(p.keyFrameInterval).toBeGreaterThan(2);
  });
});

describe('pickEncodeProfile — robustness', () => {
  it('returns an H.264 fallback profile (never null/throws) when NOTHING encodes', async () => {
    const probe = probeFor([]); // nothing supported
    const p = await pickEncodeProfile('balanced', 640, 480, probe);
    expect(p.videoCodec).toBe('avc');
    expect(p.videoBitrate).toBeGreaterThan(0);
    expect(p.audioBitrate).toBeGreaterThan(0);
  });

  it('never throws when the probe itself rejects — degrades to the fallback', async () => {
    const throwing = (async () => { throw new Error('probe blew up'); }) as CanEncodeVideoFn;
    const p = await pickEncodeProfile('small', 1024, 768, throwing);
    expect(p.videoCodec).toBe('avc');
    expect(p.videoBitrate).toBeGreaterThan(0);
  });

  it('probes at the ACTUAL recording resolution', async () => {
    const probe = probeFor(['av1']);
    await pickEncodeProfile('small', 1280, 720, probe);
    expect(probe.calls[0].width).toBe(1280);
    expect(probe.calls[0].height).toBe(720);
  });

  it('coerces a garbage tier to the BALANCED default', async () => {
    const probe = probeFor(['av1', 'vp9', 'avc']);
    const garbage = await pickEncodeProfile('nonsense' as RecorderboxQuality, 1024, 768, probe);
    const balanced = await pickEncodeProfile('balanced', 1024, 768, probe);
    // Falls back to DEFAULT_QUALITY (now 'balanced'), not the historical HIGH.
    expect(garbage.videoCodec).toBe(balanced.videoCodec);
    expect(garbage.videoBitrate).toBe(balanced.videoBitrate);
    expect(garbage.videoBitrate).not.toBe(BASELINE_H264_BITRATE);
  });
});
