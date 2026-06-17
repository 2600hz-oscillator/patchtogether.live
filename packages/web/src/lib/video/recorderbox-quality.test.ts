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
    // Even with HEVC available, HIGH stays H.264 (bit-identical default).
    const probe = probeFor(['hevc', 'avc']);
    const p = await pickEncodeProfile('high', 1024, 768, probe);
    expect(p.videoCodec).toBe('avc');
    expect(p.videoBitrate).toBe(BASELINE_H264_BITRATE);
    expect(p.keyFrameInterval).toBe(2);
    expect(p.audioBitrate).toBe(BASELINE_AUDIO_BITRATE);
    expect(p.hardwareAcceleration).toBe('prefer-hardware');
    // HIGH only ever probes avc — it never even considers HEVC.
    expect(probe.calls.map((c) => c.codec)).toEqual(['avc']);
  });
});

describe('pickEncodeProfile — BALANCED / SMALL prefer hardware HEVC', () => {
  it('BALANCED picks HEVC when available, at a reduced + codec-adjusted bitrate', async () => {
    const probe = probeFor(['hevc', 'avc']);
    const p = await pickEncodeProfile('balanced', 1024, 768, probe);
    expect(p.videoCodec).toBe('hevc');
    // Strictly smaller than the HIGH baseline (the whole point).
    expect(p.videoBitrate).toBeLessThan(BASELINE_H264_BITRATE);
    expect(p.keyFrameInterval).toBeGreaterThan(2); // longer GOP than HIGH
    expect(p.audioBitrate).toBeLessThan(BASELINE_AUDIO_BITRATE);
    expect(p.hardwareAcceleration).toBe('prefer-hardware');
    expect(probe.calls[0].codec).toBe('hevc'); // probed HEVC first
  });

  it('SMALL is strictly smaller than BALANCED at every knob', async () => {
    const probe = probeFor(['hevc', 'avc']);
    const bal = await pickEncodeProfile('balanced', 1024, 768, probe);
    const sml = await pickEncodeProfile('small', 1024, 768, probe);
    expect(sml.videoBitrate).toBeLessThan(bal.videoBitrate);
    expect(sml.keyFrameInterval).toBeGreaterThan(bal.keyFrameInterval);
    expect(sml.audioBitrate).toBeLessThanOrEqual(bal.audioBitrate);
  });

  it('falls back to H.264 when HEVC is unavailable (no-HEVC-encoder platform)', async () => {
    const probe = probeFor(['avc']); // no HEVC encoder
    const p = await pickEncodeProfile('small', 1024, 768, probe);
    expect(p.videoCodec).toBe('avc');
    // Still a SMALL-tier bitrate (reduced) + long GOP — size win even on H.264.
    expect(p.videoBitrate).toBeLessThan(BASELINE_H264_BITRATE);
    expect(p.keyFrameInterval).toBeGreaterThan(2);
    // Probed HEVC (rejected) before falling to H.264 — never av1/vp9.
    expect(probe.calls.map((c) => c.codec)).toEqual(['hevc', 'avc']);
  });

  it('NEVER selects AV1/VP9 even when the runtime can encode them (audio-glitch + NLE guard)', async () => {
    // All modern codecs available, but no HEVC → must land on H.264, NOT av1/vp9.
    const probe = probeFor(['av1', 'vp9', 'avc']);
    const bal = await pickEncodeProfile('balanced', 1024, 768, probe);
    const sml = await pickEncodeProfile('small', 1024, 768, probe);
    expect(bal.videoCodec).toBe('avc');
    expect(sml.videoCodec).toBe('avc');
    // av1/vp9 are never even probed — only hevc then avc.
    for (const c of probe.calls) expect(['hevc', 'avc']).toContain(c.codec);
  });
});

describe('pickEncodeProfile — robustness', () => {
  it('returns an H.264 fallback profile (never null/throws) when NOTHING encodes', async () => {
    const probe = probeFor([]); // nothing supported
    const p = await pickEncodeProfile('balanced', 640, 480, probe);
    expect(p.videoCodec).toBe('avc');
    expect(p.videoBitrate).toBeGreaterThan(0);
    expect(p.audioBitrate).toBeGreaterThan(0);
    expect(p.hardwareAcceleration).toBe('prefer-hardware');
  });

  it('never throws when the probe itself rejects — degrades to the fallback', async () => {
    const throwing = (async () => { throw new Error('probe blew up'); }) as CanEncodeVideoFn;
    const p = await pickEncodeProfile('small', 1024, 768, throwing);
    expect(p.videoCodec).toBe('avc');
    expect(p.videoBitrate).toBeGreaterThan(0);
    expect(p.hardwareAcceleration).toBe('prefer-hardware');
  });

  it('probes at the ACTUAL recording resolution', async () => {
    const probe = probeFor(['hevc']);
    await pickEncodeProfile('small', 1280, 720, probe);
    expect(probe.calls[0].width).toBe(1280);
    expect(probe.calls[0].height).toBe(720);
  });

  it('coerces a garbage tier to the BALANCED default', async () => {
    const probe = probeFor(['hevc', 'avc']);
    const garbage = await pickEncodeProfile('nonsense' as RecorderboxQuality, 1024, 768, probe);
    const balanced = await pickEncodeProfile('balanced', 1024, 768, probe);
    // Falls back to DEFAULT_QUALITY (now 'balanced'), not the historical HIGH.
    expect(garbage.videoCodec).toBe(balanced.videoCodec);
    expect(garbage.videoBitrate).toBe(balanced.videoBitrate);
    expect(garbage.videoBitrate).not.toBe(BASELINE_H264_BITRATE);
  });
});
