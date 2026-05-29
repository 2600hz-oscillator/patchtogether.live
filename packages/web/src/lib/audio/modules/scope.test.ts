// packages/web/src/lib/audio/modules/scope.test.ts
//
// Unit test for SCOPE's def shape, including the new mono-video
// output port added in this PR. SCOPE has no Faust assets so we can
// import its def directly without dynamic-import hedging.

import { describe, expect, it } from 'vitest';
import { scopeDef } from './scope';
import { pixelFromSample, RANGE_MAX_AUDIO, RANGE_MAX_CV } from './scope-draw';

describe('SCOPE module def shape', () => {
  it('declares the mono-video output port', () => {
    const out = scopeDef.outputs.find((p) => p.id === 'out');
    expect(out, 'scope.out video port present').toBeDefined();
    expect(out?.type).toBe('mono-video');
  });

  it('preserves the legacy audio passthrough outputs', () => {
    const ids = scopeDef.outputs.map((p) => p.id);
    expect(ids).toContain('ch1_out');
    expect(ids).toContain('ch2_out');
  });

  it('exposes per-channel display-mode params (ch1Range, ch2Range)', () => {
    // The mode toggle is named ch{1,2}Range in the def (the param
    // shipped pre-PR as a generic "range" toggle; the AUDIO↔CV UX
    // landed in this PR). Both are discrete 0..1 with default 0 = AUDIO.
    const ch1 = scopeDef.params.find((p) => p.id === 'ch1Range');
    const ch2 = scopeDef.params.find((p) => p.id === 'ch2Range');
    expect(ch1, 'ch1Range param present').toBeDefined();
    expect(ch2, 'ch2Range param present').toBeDefined();
    for (const p of [ch1!, ch2!]) {
      expect(p.curve).toBe('discrete');
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(0); // 0 = AUDIO; today's behavior preserved
    }
  });

  it('exposes 2 audio inputs + 1 cv input per param', () => {
    // PR-69 added per-param CV inputs ("scope should have cv inputs
    // for everything"). Port id MUST equal param id so the cross-domain
    // CV bridge in PatchEngine routes via setParam(portId).
    const ids = scopeDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        'ch1', 'ch2',
        'timeMs',
        'ch1Scale', 'ch1Offset', 'ch1Range',
        'ch2Scale', 'ch2Offset', 'ch2Range',
        'mode',
      ].sort(),
    );
    for (const p of scopeDef.inputs) {
      if (p.id === 'ch1' || p.id === 'ch2') {
        expect(p.type, `${p.id} stays audio`).toBe('audio');
      } else {
        expect(p.type, `${p.id} is CV`).toBe('cv');
        // Param routing invariant: port id == paramTarget == def.params[].id.
        expect((p as { paramTarget?: string }).paramTarget, `${p.id} routes to itself`).toBe(p.id);
      }
    }
  });
});

describe('SCOPE pixelFromSample (display-mode scaling)', () => {
  // halfHeight=100, cvRange=5 — chosen to match the task spec's pinned
  // endpoints. Caller (the channel-draw loop) wraps the result into
  //   y = h/2 - (yOffsetPx * scale + offset * h/2)
  // so a +halfHeight return lands at the top of the channel (0 px) and
  // a -halfHeight return at the bottom (h px) once scale=1, offset=0.

  it('AUDIO mode: ±1 fills the channel; 0 sits at the mid-line', () => {
    expect(pixelFromSample(0, false, 100, 5)).toBe(0);
    expect(pixelFromSample(1, false, 100, 5)).toBe(100);
    expect(pixelFromSample(-1, false, 100, 5)).toBe(-100);
  });

  it('CV mode: ±5V fills the channel; 0 sits at the mid-line', () => {
    expect(pixelFromSample(0, true, 100, 5)).toBe(0);
    expect(pixelFromSample(5, true, 100, 5)).toBe(100);
    expect(pixelFromSample(-5, true, 100, 5)).toBe(-100);
  });

  it('CV mode: a 1V signal sits at 1/5 of the channel height', () => {
    // Eurorack convention: 1V/oct → one octave above C4 should be a
    // readable fraction of the channel, NOT pinned to the rails.
    expect(pixelFromSample(1, true, 100, 5)).toBe(20);
    expect(pixelFromSample(-1, true, 100, 5)).toBe(-20);
  });

  it('AUDIO mode: a 1V "CV" signal would clip the rails (motivates the toggle)', () => {
    // If the user patches a CV-range signal but leaves the channel in
    // AUDIO mode, samples beyond ±1 land outside the channel. Pinning
    // this asserts WHY the toggle matters.
    expect(pixelFromSample(5, false, 100, 5)).toBe(500);
    expect(pixelFromSample(-5, false, 100, 5)).toBe(-500);
  });

  it('exposed display-range constants match the Eurorack convention', () => {
    expect(RANGE_MAX_AUDIO).toBe(1);
    expect(RANGE_MAX_CV).toBe(5);
  });
});
