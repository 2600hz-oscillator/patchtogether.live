// packages/web/src/lib/ui/modules/acidwarp-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the ACIDWARP faceplate (#2111).
//
// Everything here is a claim the shipped face MAKES and that no pixel gate can
// check — this face has NO VRT scenes at all (`FACES_WITHOUT_SCENES`), so this
// file and the e2e render legs are the whole of its coverage. That raises the
// bar rather than lowering it: each block says what it would look like if it
// were wrong.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acidwarpDef,
  speedKnobToMultiplier,
} from '$lib/video/modules/acidwarp';
import {
  ACIDWARP_PALETTE_OPTIONS,
  PALETTE_BASE_NAMES,
  PALETTE_COUNT,
  SCENE_COUNT,
  buildPalette,
  type PaletteType,
} from '$lib/video/modules/acidwarp-patterns';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = acidwarpDef as unknown as FaceDefLike & { type: string };

/** The LIVE `ParamDef` — `FaceDefLike` narrows params to `FaceParamLike`, which
 *  projects only what curation reads, so min/max/curve/options/landmarks are
 *  unreachable through `def.params`. (svelte-check catches this; vitest does not.) */
function param(id: string) {
  const p = acidwarpDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`acidwarp has no param '${id}'`);
  return p;
}

describe('acidwarp face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('acidwarp')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    // A video def MUST declare 'none' (no audio out ⇒ any other literal is a
    // dead glyph), which makes 'none + blank tile' and 'none + live thumb'
    // indistinguishable from the declaration. So assert the OTHER seam — the
    // one that actually paints. On a module that is nothing BUT a picture, a
    // blank tile would be the whole module missing from the lane.
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('owns a fullViewBody extension — the card is its only other picture', () => {
    expect(def.face?.extension).toBe('acidwarp');
  });
});

describe('acidwarp face — the tier ladder, MEASURED', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('mini = SPEED, compact = SPEED + PALETTE', () => {
    // Read back as a sentence: at mini, the one control that decides whether
    // anything appears to move; at compact, pace plus colour world.
    expect(keysAt('mini')).toEqual(['speed']);
    expect(keysAt('compact')).toEqual(['speed', 'paletteType']);
  });

  it('the dock shows all four real controls and NOT the synthetic trigger', () => {
    expect(keysAt('dock')).toEqual(['speed', 'paletteType', 'scene', 'freeze']);
    expect(keysAt('dock')).not.toContain('sceneTrig');
  });

  it('⚠ LANDMARKS COST LANE HEIGHT — measured, not assumed', () => {
    // `speed` declares landmarks, which makes `paintsReadout` true and adds
    // LANE_KNOB_READOUT_H to its cell. The face flags this as a consequence to
    // measure; this is the measurement. If a future edit drops the landmarks
    // the first cell gets SHORTER and the lane may fit a different number of
    // controls — which would silently change the compact tile.
    const heights = curatedFace(def, 'compact')!.cellHeights;
    expect(heights.length).toBeGreaterThan(0);
    const withLandmarks = heights[0]!;
    const bare = curatedFace(
      { ...def, params: acidwarpDef.params.map((p) => (p.id === 'speed' ? { ...p, landmarks: undefined } : p)) } as unknown as FaceDefLike,
      'compact',
    )!.cellHeights[0]!;
    expect(
      withLandmarks,
      'the landmarked SPEED cell must be TALLER than the bare one — that is the readout row',
    ).toBeGreaterThan(bare);
  });
});

describe('acidwarp face — two bands, no rail', () => {
  it('renders exactly the two authored bands', () => {
    expect(dockFacePlan(def)!.map((b) => b.id)).toEqual(['pattern', 'motion']);
  });

  it('groups by IDEA: what is on screen, and how it moves', () => {
    const bands = dockFacePlan(def)!;
    expect(bands[0]!.controls.map((c) => c.key)).toEqual(['scene', 'paletteType']);
    expect(bands[1]!.controls.map((c) => c.key)).toEqual(['speed', 'freeze']);
  });

  it('no tab rail — two bands is far below the threshold', () => {
    expect(dockFacePlan(def)!.length).toBeLessThan(7);
    expect(def.face?.tabbed).toBeUndefined();
  });
});

describe('acidwarp — the palette roster is DERIVED from the encoding', () => {
  it('is total over the param span and matches the base names + sparkle bit', () => {
    const p = param('paletteType');
    expect(p.options).toBe(ACIDWARP_PALETTE_OPTIONS);
    expect(ACIDWARP_PALETTE_OPTIONS.map((o) => o.value)).toEqual(
      Array.from({ length: p.max - p.min + 1 }, (_, i) => p.min + i),
    );
    expect(ACIDWARP_PALETTE_OPTIONS).toHaveLength(PALETTE_COUNT);
  });

  it('⚠ every label agrees with `buildPalette`s OWN encoding, not with a list', () => {
    // The property that makes deriving worth it: `buildPalette` reads a type as
    // `type & 3` (base) + `type & 4` (sparkle). Assert the roster reproduces
    // exactly that, so a name can never drift from the palette it selects.
    for (const opt of ACIDWARP_PALETTE_OPTIONS) {
      const base = PALETTE_BASE_NAMES[opt.value & 3]!;
      expect(opt.label.startsWith(base), `${opt.value} → ${opt.label} starts with ${base}`).toBe(true);
      expect(
        opt.label.length > base.length,
        `${opt.value} → sparkle variants are marked, plain ones are not`,
      ).toBe((opt.value & 4) !== 0);
    }
  });

  it('⚠ NEGATIVE CONTROL: the four base palettes really are DIFFERENT', () => {
    // Without this, the naming legs pass on an encoding where every type built
    // the same palette — the roster would be four names for one thing and the
    // assertions above could not tell.
    const seen = new Set<string>();
    for (let t = 0; t < 4; t++) seen.add(buildPalette(t as PaletteType).join(','));
    expect(seen.size, 'the four BASE palettes are distinct').toBe(4);
    // …and the sparkle pass actually changes the palette it is applied to.
    expect(buildPalette(0 as PaletteType).join(',')).not.toBe(buildPalette(4 as PaletteType).join(','));
  });

  it('`scene` gets NO roster — 41 unnamed states, and inventing names is forbidden', () => {
    const p = param('scene');
    expect(p.options).toBeUndefined();
    expect(p.landmarks).toBeUndefined();
    expect(p.max - p.min + 1).toBe(SCENE_COUNT);
  });
});

describe('acidwarp — SPEED landmarks replace a deleted readout', () => {
  it('names STILL and NATIVE, and both are NAMES rather than numbers', () => {
    const p = param('speed');
    expect(p.landmarks?.map((l) => l.label)).toEqual(['STILL', 'NATIVE']);
    // A numeric label would need a NUMERIC_LABEL_EXEMPTIONS entry; these do not.
    for (const l of p.landmarks ?? []) {
      expect(/^[+\-−]?[0-9]+(\.[0-9]+)?\s*[a-zA-Z%°¢×x]{0,3}$/.test(l.label), l.label).toBe(false);
    }
  });

  it('⚠ the landmark VALUES are where the mapping actually turns over', () => {
    // The whole reason the landmarks exist: the card printed a live multiplier,
    // and the one fact that number carried which the ParamDef does not is that
    // NATIVE 1x is the MIDPOINT, not the top. Assert against the real mapping,
    // so a landmark that drifted off the turnover point goes red.
    const p = param('speed');
    const byLabel = new Map((p.landmarks ?? []).map((l) => [l.label, l.value]));
    expect(speedKnobToMultiplier(byLabel.get('STILL')!)).toBe(0);
    expect(speedKnobToMultiplier(byLabel.get('NATIVE')!)).toBe(1);
    // …and the top of the dial is 4x, which is deliberately NOT a landmark
    // (it would be a numeric label, and "fully clockwise is fastest" is legible
    // from the control itself).
    expect(speedKnobToMultiplier(1)).toBe(4);
  });

  it('⚠ NEGATIVE CONTROL: the midpoint claim is non-trivial', () => {
    // If the mapping were linear, NATIVE at 0.5 would be unremarkable and the
    // landmark would carry nothing. It is piecewise, so 0.5 is a genuine
    // turnover: the first half spans 0..1x and the second 1x..4x.
    expect(speedKnobToMultiplier(0.25)).toBeCloseTo(0.5, 10);
    expect(speedKnobToMultiplier(0.75)).toBeCloseTo(2.5, 10);
    expect(speedKnobToMultiplier(0.75) - speedKnobToMultiplier(0.5)).toBeGreaterThan(
      speedKnobToMultiplier(0.5) - speedKnobToMultiplier(0.25),
    );
  });
});

describe('acidwarp — `sceneTrig` is CV-written, and `freeze` is NOT', () => {
  it('sceneTrig is the only noUserControl param, written by a cv-port', () => {
    const decl = (acidwarpDef as { noUserControl?: readonly { param: string; writer: string }[] })
      .noUserControl ?? [];
    expect(decl.map((d) => d.param)).toEqual(['sceneTrig']);
    expect(decl[0]!.writer).toBe('cv-port');
  });

  it('⚠ the cv-port claim is CHECKABLE — a port really targets it', () => {
    const targets = (acidwarpDef.inputs ?? []).map(
      (p) => (p as { paramTarget?: string }).paramTarget,
    );
    expect(targets).toContain('sceneTrig');
    // …and the sweep is reading real ports, so a hit means something.
    expect(targets.filter(Boolean).length).toBe(2);
  });

  it('⚠ `freeze` is NOT noUserControl — it is a shipped control, despite the name', () => {
    // The trap this module sets: on every other def `freeze` is a determinism
    // hook and IS declared noUserControl. Here it is a documented feature. A
    // future author pattern-matching on the name would delete a real control.
    const decl = (acidwarpDef as { noUserControl?: readonly { param: string }[] }).noUserControl ?? [];
    expect(decl.map((d) => d.param)).not.toContain('freeze');
    expect(def.face?.order).toContain('freeze');
  });
});

describe('acidwarp — the face DELETES two resting readouts, not one', () => {
  const bodySrc = () =>
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'acidwarp/AcidwarpScreenBody.svelte'),
      'utf8',
    );

  it('the screen body paints NO scene index and NO speed multiplier', () => {
    const src = bodySrc();
    expect(src.length, 'the probe read an empty/missing component').toBeGreaterThan(2000);
    // The card's two readouts, by their rendered shape. Neither may appear.
    expect(/SCENE\s*\{/.test(src), 'the SCENE n/41 readout must not be ported').toBe(false);
    expect(/speedLabel|speed-readout/.test(src), 'the speed multiplier must not be ported').toBe(false);
  });

  it('the collapsed branch marks the node watched BEFORE it returns', () => {
    // #1937 / #2015. Sharper on a SOURCE than on a filter: acidwarp has no
    // input, so a lapsed watch mark does not stall a preview — it mutes the
    // generator every downstream node is sampling.
    const src = bodySrc();
    expect(src).toContain('markWatched');
    expect(
      /if\s*\(previewCollapsed\)\s*\{[\s\S]{0,400}markWatched/.test(src),
      'SCREEN OFF must keep the watch mark or the switch is a producer kill switch',
    ).toBe(true);
  });

  it('⚠ NEGATIVE CONTROL: the probe discriminates', () => {
    const src = bodySrc();
    expect(src).toContain('acidwarp-face-screen-toggle');
    const sabotaged = src.replace(/if\s*\(previewCollapsed\)\s*\{[\s\S]{0,400}?markWatched[^\n]*\n/, 'if (previewCollapsed) {\n');
    expect(/if\s*\(previewCollapsed\)\s*\{[\s\S]{0,400}markWatched/.test(sabotaged)).toBe(false);
  });
});
