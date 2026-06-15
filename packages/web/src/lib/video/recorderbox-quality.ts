// packages/web/src/lib/video/recorderbox-quality.ts
//
// RECORDERBOX quality/size tiers + codec selection.
//
// The card exposes a QUALITY selector (HIGH / BALANCED / SMALL). Each tier maps
// to an encode PROFILE — the codec + bitrate + keyframe interval + audio bitrate
// the recorder feeds Mediabunny. This file is the single source of truth for
// that mapping; the recorder + card + tests all read it.
//
// ── The levers (and why) ─────────────────────────────────────────────────────
//
//  1. CODEC. A modern codec (AV1 / VP9) is dramatically more efficient than
//     H.264 at equal perceptual quality (~30-50% smaller for AV1, ~25-40% for
//     VP9 on typical content), so the single biggest size win is to PREFER a
//     modern codec when the runtime can encode it — falling back to H.264, which
//     is the guaranteed baseline. We keep the MP4 container in every case
//     (Mediabunny's MP4 muxer carries avc/hevc/vp9/av1), so the container,
//     extension (.mp4), and the fragmented-MP4 crash-recovery semantics never
//     change — only the codec inside it does. We probe each candidate with
//     `canEncodeVideo` at the ACTUAL recording resolution before selecting it.
//
//  2. BITRATE / RATE CONTROL. Lower target bitrate is the direct size knob;
//     Mediabunny's default `bitrateMode:'variable'` (VBR) already spends bits
//     where they matter. We express each tier's video target as a fraction of
//     the HIGH baseline (~14 Mbps for H.264) AND scale it for the more-efficient
//     codecs (a VP9/AV1 take needs fewer bits for the same look), so SMALL is
//     small on size, not just on codec.
//
//  3. KEYFRAME INTERVAL (GOP). Longer GOP = fewer expensive I-frames = smaller
//     file, at a small seek-granularity / crash-recovery-granularity cost (a
//     fragmented-MP4 fragment can't begin before a keyframe). HIGH keeps the
//     ~2 s default (best seek + most recoverable fragments); SMALL stretches it.
//
//  4. AUDIO BITRATE. Cheap size: 192 kbps AAC is overkill for most synth output;
//     128 kbps (BALANCED) / 96 kbps (SMALL) is transparent for most material.
//
// What we DON'T do (in-browser real-time constraints):
//   * True 2-pass encoding — needs the whole clip up front; impossible for a
//     live, crash-recoverable stream. VBR single-pass is the realistic ceiling.
//   * `bitrateMode:'quantizer'` per-frame QP — WebCodecs exposes a `quantizer`
//     bitrate mode in spec, but Mediabunny's high-level config surfaces only
//     'constant' | 'variable', and per-frame QP needs frame-level control we'd
//     have to drop the CanvasSource convenience for. VBR + a good codec gets the
//     bulk of the size-at-quality win without that complexity.

import { canEncodeVideo as mbCanEncodeVideo, type VideoCodec } from 'mediabunny';

/** The user-facing quality/size tier. `high` is the DEFAULT — it preserves the
 *  pre-existing ~14 Mbps H.264 behavior exactly (no silent regression). */
export type RecorderboxQuality = 'high' | 'balanced' | 'small';

/** The DEFAULT tier — BALANCED (owner default, 2026-06-15): AV1/VP9 at ~−80%
 *  file size for a small quality hit, with H.264 fallback where AV1/VP9 isn't
 *  supported. HIGH (the historical ~14 Mbps H.264 baseline) stays one click away. */
export const DEFAULT_QUALITY: RecorderboxQuality = 'balanced';

export const QUALITY_VALUES: readonly RecorderboxQuality[] = ['high', 'balanced', 'small'] as const;

/** The HIGH-tier H.264 baseline (the historical default — DO NOT lower it). */
export const BASELINE_H264_BITRATE = 14_000_000;
/** The HIGH-tier audio baseline. */
export const BASELINE_AUDIO_BITRATE = 192_000;

/** Coerce an arbitrary value (e.g. node.data.quality) to a valid tier. */
export function coerceQuality(v: unknown): RecorderboxQuality {
  return v === 'balanced' || v === 'small' || v === 'high' ? v : DEFAULT_QUALITY;
}

/** Per-tier knobs (codec-INDEPENDENT). The video bitrate is expressed against
 *  the H.264 baseline; pickEncodeProfile() additionally scales it DOWN for a
 *  more-efficient chosen codec via CODEC_EFFICIENCY. */
interface TierSpec {
  /** Video target as a fraction of BASELINE_H264_BITRATE (for H.264). */
  videoBitrateFactor: number;
  /** Keyframe interval in seconds (longer = smaller; default ~2 s = HIGH). */
  keyFrameInterval: number;
  /** Audio (AAC) target bitrate, bps. */
  audioBitrate: number;
  /** Ordered codec preference. The first the runtime can encode wins; H.264
   *  ('avc') is ALWAYS last so it's the guaranteed fallback. */
  codecPreference: VideoCodec[];
}

const TIERS: Record<RecorderboxQuality, TierSpec> = {
  // HIGH — byte-for-byte the historical default: H.264 only, full bitrate, ~2 s
  // GOP, 192 kbps audio. We do NOT prefer a modern codec here even if available
  // so the default take is bit-identical in config to what shipped in #103/#108
  // (no surprise look/size change for existing users; the user opts in to the
  // smaller codecs by choosing BALANCED/SMALL).
  high: {
    videoBitrateFactor: 1.0,
    keyFrameInterval: 2,
    audioBitrate: BASELINE_AUDIO_BITRATE,
    codecPreference: ['avc'],
  },
  // BALANCED — meaningfully smaller at near-imperceptible quality cost: prefer a
  // modern codec, ~55% of the H.264-equivalent bitrate, slightly longer GOP,
  // 128 kbps audio.
  balanced: {
    videoBitrateFactor: 0.55,
    keyFrameInterval: 4,
    audioBitrate: 128_000,
    codecPreference: ['av1', 'vp9', 'avc'],
  },
  // SMALL — aggressively small for sharing/upload: prefer the most efficient
  // codec, ~30% of the H.264-equivalent bitrate, long GOP, 96 kbps audio.
  small: {
    videoBitrateFactor: 0.3,
    keyFrameInterval: 8,
    audioBitrate: 96_000,
    codecPreference: ['av1', 'vp9', 'avc'],
  },
};

/** How many bits a codec needs RELATIVE to H.264 for the same perceptual
 *  quality (lower = more efficient). The tier's H.264-equivalent target is
 *  multiplied by this once a codec is chosen, so a VP9/AV1 take is smaller than
 *  the same tier's bitrate-factor alone would imply. Conservative values. */
const CODEC_EFFICIENCY: Record<VideoCodec, number> = {
  av1: 0.6, // AV1 ~ 40% smaller than H.264 at equal quality.
  vp9: 0.72, // VP9 ~ 28% smaller.
  hevc: 0.65, // HEVC ~ 35% smaller (not in the preference lists; here for safety).
  avc: 1.0, // H.264 reference.
  vp8: 1.05, // older than H.264 — slightly worse (never preferred).
};

/** The concrete encode profile the recorder feeds Mediabunny. */
export interface EncodeProfile {
  videoCodec: VideoCodec;
  /** Target video bitrate (bps), already codec-adjusted. */
  videoBitrate: number;
  /** Keyframe interval in seconds. */
  keyFrameInterval: number;
  audioBitrate: number;
}

/** Injectable probe so unit tests can drive the codec-support matrix. */
export type CanEncodeVideoFn = (
  codec: VideoCodec,
  opts: { width: number; height: number; bitrate: number },
) => Promise<boolean>;

/**
 * Resolve the encode PROFILE for a tier at a given recording resolution.
 *
 * Walks the tier's ordered codec preference, probing each with `canEncodeVideo`
 * at the ACTUAL recording resolution + the codec-adjusted bitrate, and picks the
 * FIRST the runtime can really encode. H.264 ('avc') is always last in every
 * list, so it's the guaranteed fallback — if even H.264 fails the probe we still
 * RETURN an H.264 profile (the recorder's own start() / the card's
 * probeEncoders gate is the real "can we record at all" check; this never
 * throws + never returns null).
 *
 * Pure w.r.t. the injected probe; the card calls it with the real Mediabunny
 * probe, tests inject a stub.
 */
export async function pickEncodeProfile(
  quality: RecorderboxQuality,
  width: number,
  height: number,
  canEncode: CanEncodeVideoFn = mbCanEncodeVideo as unknown as CanEncodeVideoFn,
): Promise<EncodeProfile> {
  const tier = TIERS[coerceQuality(quality)];
  const h264Target = Math.round(BASELINE_H264_BITRATE * tier.videoBitrateFactor);

  for (const codec of tier.codecPreference) {
    const bitrate = Math.round(h264Target * (CODEC_EFFICIENCY[codec] ?? 1));
    let ok = false;
    try {
      ok = await canEncode(codec, { width, height, bitrate });
    } catch {
      ok = false;
    }
    if (ok) {
      return {
        videoCodec: codec,
        videoBitrate: bitrate,
        keyFrameInterval: tier.keyFrameInterval,
        audioBitrate: tier.audioBitrate,
      };
    }
  }

  // Nothing probed clean — return the H.264 fallback profile anyway (the
  // recorder's start() + the card's canRecord gate decide whether to proceed).
  return {
    videoCodec: 'avc',
    videoBitrate: Math.round(h264Target),
    keyFrameInterval: tier.keyFrameInterval,
    audioBitrate: tier.audioBitrate,
  };
}

/** Short human label for the card + tooltips. */
export function qualityLabel(q: RecorderboxQuality): string {
  switch (q) {
    case 'high':
      return 'HIGH';
    case 'balanced':
      return 'BALANCED';
    case 'small':
      return 'SMALL';
  }
}
