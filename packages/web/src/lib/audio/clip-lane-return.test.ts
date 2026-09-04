// packages/web/src/lib/audio/clip-lane-return.test.ts
//
// The launcher→mixer NORMALLED RETURN seam: the MON mode roster and the two
// pure decisions that define it. Slice 1 ships the contract; slice 3 wires the
// param + duck and slice 5 the return itself — so these tests are what stops
// those two slices from each inventing their own reading of "clip-auto".

import { describe, it, expect } from 'vitest';
import {
  CLIP_LANE_MON_MODES,
  DEFAULT_CLIP_LANE_MON,
  clipLaneLiveGain,
  clipLaneNormalConnected,
  coerceClipLaneMon,
  coerceClipLanePlayingEdge,
  type ClipLaneMonMode,
} from './clip-lane-return';

describe('MON roster', () => {
  it('is the three declared modes, in param order', () => {
    expect(CLIP_LANE_MON_MODES).toEqual(['live', 'both', 'clip-auto']);
  });

  it('defaults to clip-auto — the zero-gesture behaviour', () => {
    expect(DEFAULT_CLIP_LANE_MON).toBe('clip-auto');
    expect(CLIP_LANE_MON_MODES.indexOf(DEFAULT_CLIP_LANE_MON)).toBe(2);
  });

  it('coerces from BOTH the string and the discrete param index', () => {
    for (let i = 0; i < CLIP_LANE_MON_MODES.length; i++) {
      expect(coerceClipLaneMon(i)).toBe(CLIP_LANE_MON_MODES[i]);
      expect(coerceClipLaneMon(CLIP_LANE_MON_MODES[i])).toBe(CLIP_LANE_MON_MODES[i]);
    }
    expect(coerceClipLaneMon(1.4)).toBe('both'); // a param value rounds
  });

  it('NEVER fails — an unknown value monitors rather than going silent', () => {
    for (const bad of [undefined, null, '', 'off', -1, 99, NaN, Infinity, {}, []]) {
      expect(coerceClipLaneMon(bad), String(bad)).toBe(DEFAULT_CLIP_LANE_MON);
    }
  });
});

describe('clipLaneLiveGain — what MON actually does to the LIVE branch', () => {
  it('is a full 3×2 table, stated rather than implied', () => {
    const table = CLIP_LANE_MON_MODES.flatMap((mon) =>
      [false, true].map((playing) => `${mon}/${playing ? 'playing' : 'stopped'} → ${clipLaneLiveGain(mon, playing)}`),
    );
    expect(table).toEqual([
      'live/stopped → 1',
      'live/playing → 1',
      'both/stopped → 1',
      'both/playing → 1',
      'clip-auto/stopped → 1',
      'clip-auto/playing → 0',
    ]);
  });

  it('ONLY clip-auto ducks, and only while the lane is playing', () => {
    const ducks = CLIP_LANE_MON_MODES.filter((m) => clipLaneLiveGain(m, true) === 0);
    expect(ducks).toEqual(['clip-auto']);
    // NEGATIVE CONTROL for the assertion above: a stopped lane ducks in NO
    // mode, so a duck that latched on and never released would be red here.
    expect(CLIP_LANE_MON_MODES.filter((m) => clipLaneLiveGain(m, false) === 0)).toEqual([]);
  });

  it('returns a GAIN, so the caller can ramp it (a boolean invites a click)', () => {
    for (const mon of CLIP_LANE_MON_MODES) {
      for (const playing of [false, true]) {
        const g = clipLaneLiveGain(mon, playing);
        expect(typeof g).toBe('number');
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(1);
      }
    }
  });

  it('`both` is the DOUBLING pattern — it never attenuates either side', () => {
    expect(clipLaneLiveGain('both', true)).toBe(1);
    expect(clipLaneLiveGain('both', false)).toBe(1);
  });

  it('an unknown mode still behaves — coerce first, and clip-auto is the floor', () => {
    const mon = coerceClipLaneMon('nonsense') as ClipLaneMonMode;
    expect(clipLaneLiveGain(mon, true)).toBe(0);
  });
});

describe('clipLaneNormalConnected — a hardware normal, broken by a jack', () => {
  it('is connected only while NOTHING is patched into the channel input', () => {
    expect(clipLaneNormalConnected(false)).toBe(true);
    expect(clipLaneNormalConnected(true)).toBe(false);
  });

  it('is a GRAPH fact — a patched-but-silent source still breaks the normal', () => {
    // Stated as a test because the tempting bug is to ask "is that cable
    // actually carrying anything", which is the runtime "is it really X?"
    // heuristic the stereo policy bans by name. On hardware, inserting a jack
    // into a silent module still breaks the normal; so does it here.
    expect(clipLaneNormalConnected(true)).toBe(false);
  });
});

describe('coerceClipLanePlayingEdge — the cross-module boundary', () => {
  it('passes a well-formed edge through unchanged', () => {
    expect(coerceClipLanePlayingEdge({ lane: 3, playing: true, atTime: 1.25 })).toEqual({
      lane: 3,
      playing: true,
      atTime: 1.25,
    });
    expect(coerceClipLanePlayingEdge({ lane: 0, playing: false, atTime: 0 })).toEqual({
      lane: 0,
      playing: false,
      atTime: 0,
    });
  });

  it('drops everything that could put NaN (or worse) onto an AudioParam', () => {
    expect(coerceClipLanePlayingEdge(null)).toBeNull();
    expect(coerceClipLanePlayingEdge('edge')).toBeNull();
    expect(coerceClipLanePlayingEdge({})).toBeNull();
    expect(coerceClipLanePlayingEdge({ lane: 1.5, playing: true, atTime: 1 })).toBeNull();
    expect(coerceClipLanePlayingEdge({ lane: -1, playing: true, atTime: 1 })).toBeNull();
    expect(coerceClipLanePlayingEdge({ lane: 1, playing: 1, atTime: 1 })).toBeNull();
    expect(coerceClipLanePlayingEdge({ lane: 1, playing: true, atTime: NaN })).toBeNull();
    expect(coerceClipLanePlayingEdge({ lane: 1, playing: true, atTime: Infinity })).toBeNull();
    // A renamed field is a DROPPED edge, never a half-read one.
    expect(coerceClipLanePlayingEdge({ lane: 1, isPlaying: true, atTime: 1 })).toBeNull();
  });
});
