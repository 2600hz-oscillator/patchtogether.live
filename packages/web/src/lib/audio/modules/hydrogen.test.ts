// packages/web/src/lib/audio/modules/hydrogen.test.ts
//
// Unit tests for HYDROGEN's module def shape + pure-data helpers
// (defaultTracks, coerceTracks, coerceCell, instrumentParamIds). The
// audio path — sample fetch + decodeAudioData + scheduler ticks +
// mute-group choke — is exercised in the ART scenario + Playwright
// E2E (we don't have a Web Audio polyfill in node-vitest, and the
// node-web-audio-api package doesn't decode FLAC anyway).

import { describe, expect, it } from 'vitest';
import {
  hydrogenDef,
  defaultTracks,
  defaultTrack,
  coerceTracks,
  coerceCell,
  instrumentParamIds,
  STEP_COUNT,
} from './hydrogen';
import { TR808_INSTRUMENTS, TR808_INSTRUMENT_COUNT } from './hydrogen-tr808-kit-data';

describe('hydrogen module def shape', () => {
  it('declares type/label/domain/category', () => {
    expect(hydrogenDef.type).toBe('hydrogen');
    expect(hydrogenDef.label).toBe('HYDROGEN');
    expect(hydrogenDef.domain).toBe('audio');
    expect(hydrogenDef.category).toBe('sources');
  });

  it('declares clock_in + reset_in + one trig{i} per instrument', () => {
    const ids = hydrogenDef.inputs.map((p) => p.id);
    expect(ids).toContain('clock_in');
    expect(ids).toContain('reset_in');
    for (const inst of TR808_INSTRUMENTS) {
      expect(ids, `trig${inst.id} missing`).toContain(`trig${inst.id}`);
    }
    expect(ids.length).toBe(2 + TR808_INSTRUMENT_COUNT);
  });

  it('declares stereo audio outputs', () => {
    const outs = hydrogenDef.outputs.map((p) => p.id).sort();
    expect(outs).toEqual(['out_l', 'out_r']);
    expect(hydrogenDef.outputs.find((o) => o.id === 'out_l')?.type).toBe('audio');
    expect(hydrogenDef.outputs.find((o) => o.id === 'out_r')?.type).toBe('audio');
  });

  it('exposes transport params (bpm / swing / gain / isPlaying)', () => {
    const ids = hydrogenDef.params.map((p) => p.id);
    expect(ids).toContain('bpm');
    expect(ids).toContain('swing');
    expect(ids).toContain('gain');
    expect(ids).toContain('isPlaying');
  });

  it('exposes vol/pan/A/D/S/R/mute/solo per instrument', () => {
    const ids = new Set(hydrogenDef.params.map((p) => p.id));
    for (const inst of TR808_INSTRUMENTS) {
      for (const k of ['vol', 'pan', 'A', 'D', 'S', 'R', 'mute', 'solo'] as const) {
        expect(ids, `${k}${inst.id} missing`).toContain(`${k}${inst.id}`);
      }
    }
  });

  it('bpm defaults to 120 and is clamped 30..300', () => {
    const bpm = hydrogenDef.params.find((p) => p.id === 'bpm');
    expect(bpm).toBeDefined();
    expect(bpm!.defaultValue).toBe(120);
    expect(bpm!.min).toBe(30);
    expect(bpm!.max).toBe(300);
  });

  it('exposes the play button on exposableControls (so a GROUP can hoist it)', () => {
    const exposable = hydrogenDef.exposableControls?.find((c) => c.id === 'playStop');
    expect(exposable).toBeDefined();
    expect(exposable?.paramId).toBe('isPlaying');
  });

  it('marks the 16x16 pattern as an exposable sequence (Instruments v1)', () => {
    expect(hydrogenDef.exposesSequence).toBe(true);
  });
});

describe('pattern coercion helpers', () => {
  it('defaultTracks() returns one all-off track per instrument', () => {
    const tracks = defaultTracks();
    expect(tracks.length).toBe(TR808_INSTRUMENT_COUNT);
    for (const track of tracks) {
      expect(track.length).toBe(STEP_COUNT);
      for (const cell of track) {
        expect(cell.on).toBe(false);
      }
    }
  });

  it('defaultTrack() is length STEP_COUNT and all-off', () => {
    const t = defaultTrack();
    expect(t.length).toBe(STEP_COUNT);
    expect(t.every((c) => c.on === false)).toBe(true);
  });

  it('coerceCell() rejects non-objects', () => {
    expect(coerceCell(null)).toEqual({ on: false });
    expect(coerceCell(undefined)).toEqual({ on: false });
    expect(coerceCell(42)).toEqual({ on: false });
    expect(coerceCell('on')).toEqual({ on: false });
  });

  it('coerceCell() preserves the on flag (truthy → true)', () => {
    expect(coerceCell({ on: true })).toEqual({ on: true });
    expect(coerceCell({ on: 1 })).toEqual({ on: true });
    expect(coerceCell({ on: false })).toEqual({ on: false });
    expect(coerceCell({})).toEqual({ on: false });
  });

  it('coerceTracks() fills missing rows with defaults', () => {
    const raw = [[{ on: true }, { on: false }]]; // only the first instrument has data, partial row
    const out = coerceTracks(raw);
    expect(out.length).toBe(TR808_INSTRUMENT_COUNT);
    // Row 0: first cell preserved, remaining padded to STEP_COUNT.
    expect(out[0]!.length).toBe(STEP_COUNT);
    expect(out[0]![0]!.on).toBe(true);
    expect(out[0]![1]!.on).toBe(false);
    expect(out[0]![2]!.on).toBe(false);
    // Every other row is fully default.
    for (let i = 1; i < TR808_INSTRUMENT_COUNT; i++) {
      expect(out[i]!.length).toBe(STEP_COUNT);
      expect(out[i]!.every((c) => c.on === false)).toBe(true);
    }
  });

  it('coerceTracks() rejects non-array input', () => {
    expect(coerceTracks(undefined)).toEqual(defaultTracks());
    expect(coerceTracks(null)).toEqual(defaultTracks());
    expect(coerceTracks({})).toEqual(defaultTracks());
  });

  it('instrumentParamIds() returns 8 params × N instruments', () => {
    const ids = instrumentParamIds();
    expect(ids.length).toBe(TR808_INSTRUMENT_COUNT * 8);
    // Spot-check the first few.
    expect(ids[0]).toBe('vol0');
    expect(ids[1]).toBe('pan0');
    expect(ids[7]).toBe('solo0');
    expect(ids[8]).toBe('vol1');
  });
});

describe('TR808 kit data', () => {
  it('ships 16 instruments with unique ids 0..15', () => {
    expect(TR808_INSTRUMENT_COUNT).toBe(16);
    const ids = TR808_INSTRUMENTS.map((i) => i.id).sort((a, b) => a - b);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('every instrument points at a /drumkits/tr808/ FLAC', () => {
    for (const inst of TR808_INSTRUMENTS) {
      expect(inst.sampleUrl).toMatch(/^\/drumkits\/tr808\/.+\.flac$/);
      expect(inst.name.length).toBeGreaterThan(0);
      expect(inst.label.length).toBeGreaterThan(0);
    }
  });

  it('hihat triad (Hat Closed/Open/Pedal) shares a mute group', () => {
    const hats = TR808_INSTRUMENTS.filter((i) => i.name.startsWith('Hat '));
    expect(hats.length).toBe(3);
    const groups = new Set(hats.map((h) => h.muteGroup));
    expect(groups.size, 'all three hats must share one mute group').toBe(1);
    expect([...groups][0], 'mute group must be > 0').toBeGreaterThan(0);
  });

  it('non-hihat instruments have no mute group (0 = none)', () => {
    const nonHats = TR808_INSTRUMENTS.filter((i) => !i.name.startsWith('Hat '));
    for (const inst of nonHats) {
      expect(inst.muteGroup, `${inst.name} should have no mute group`).toBe(0);
    }
  });

  it('per-instrument defaults are within param ranges', () => {
    for (const inst of TR808_INSTRUMENTS) {
      expect(inst.defaultGain).toBeGreaterThanOrEqual(0);
      expect(inst.defaultGain).toBeLessThanOrEqual(2);
      expect(inst.defaultPan).toBeGreaterThanOrEqual(-1);
      expect(inst.defaultPan).toBeLessThanOrEqual(1);
      expect(inst.defaultS).toBeGreaterThanOrEqual(0);
      expect(inst.defaultS).toBeLessThanOrEqual(1);
    }
  });
});
