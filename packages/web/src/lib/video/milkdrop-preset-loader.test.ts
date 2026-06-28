// packages/web/src/lib/video/milkdrop-preset-loader.test.ts
//
// Unit coverage for the MILKDROP custom-preset loader helpers. convertMilkPreset
// runs the REAL `milkdrop-preset-converter` (the deterministic in-browser .milk →
// butterchurn-JSON path the card uses), so this also proves the converter
// resolves + parses under the bundler/test runtime — not just on the owner's GPU.

import { describe, it, expect } from 'vitest';
import { convertMilkPreset, resolvePresetNames } from './milkdrop-preset-loader';

// A minimal-but-real classic Milkdrop preset (INI base vals + a per-frame and a
// per-pixel EEL equation). The converter transpiles the EEL → JS and lifts the
// base vals, so we can assert on concrete parsed values (deterministic).
const SAMPLE_MILK = `[preset00]
fRating=3.000000
fDecay=0.980000
fGammaAdj=2.000000
nWaveMode=7
zoom=1.010000
rot=0.020000
warp=1.000000
per_frame_1=wave_r = 0.5 + 0.5*sin(time*1.1);
per_pixel_1=zoom = zoom + 0.01*sin(rad*10);
`;

describe('convertMilkPreset', () => {
  it('converts a classic .milk into a butterchurn preset object', async () => {
    const preset = (await convertMilkPreset(SAMPLE_MILK)) as Record<string, unknown>;
    expect(preset).toBeTypeOf('object');
    // butterchurn preset shape — the fields visualizer.loadPreset consumes.
    expect(preset).toHaveProperty('baseVals');
    expect(preset).toHaveProperty('frame_eqs_str');
    expect(preset).toHaveProperty('pixel_eqs_str');

    // The INI base vals were actually parsed (not just defaulted).
    const baseVals = preset.baseVals as Record<string, number>;
    expect(baseVals.zoom).toBeCloseTo(1.01, 5);
    expect(baseVals.rot).toBeCloseTo(0.02, 5);
    expect(baseVals.wave_mode).toBe(7);

    // The EEL equations transpiled to non-empty JS strings.
    expect(typeof preset.frame_eqs_str).toBe('string');
    expect((preset.frame_eqs_str as string).length).toBeGreaterThan(0);
    expect((preset.pixel_eqs_str as string).length).toBeGreaterThan(0);
  });

  it('throws when given a non-string / unparseable buffer is irrelevant — empty text still yields a (default) preset object', async () => {
    // The converter is forgiving: ANY text yields a valid default preset object
    // (no equations), so the wrapper passes it through rather than faking a throw.
    const preset = (await convertMilkPreset('')) as Record<string, unknown>;
    expect(preset).toBeTypeOf('object');
    expect((preset.frame_eqs_str as string).length).toBe(0);
  });
});

describe('resolvePresetNames', () => {
  const CURATED = ['Geiss - A', 'Flexi - B', 'Martin - C'] as const;

  it('uses the live engine list when present (curated + in-session customs)', () => {
    const live = ['Geiss - A', 'Flexi - B', 'Martin - C', 'my-custom'];
    expect(resolvePresetNames(live, CURATED)).toEqual(live);
  });

  it('falls back to the curated names before the live list is ready', () => {
    expect(resolvePresetNames(undefined, CURATED)).toEqual([...CURATED]);
    expect(resolvePresetNames([], CURATED)).toEqual([...CURATED]);
  });

  it('returns a fresh copy (callers may mutate / Svelte may diff)', () => {
    const out = resolvePresetNames(undefined, CURATED);
    expect(out).not.toBe(CURATED);
    out.push('x');
    expect(CURATED).toHaveLength(3);
  });
});
