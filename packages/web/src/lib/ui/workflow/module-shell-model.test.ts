// packages/web/src/lib/ui/workflow/module-shell-model.test.ts
//
// Pure display model for the ModuleShell / ModuleShellPlaceholder (P0.3b).
// Proves the spine/domain hue resolution + the LANE face-tier mapping (the LOD
// 'dock' band collapses to 'full' in the lane; the full faceplate is a separate
// dock VIEW).

import { describe, it, expect } from 'vitest';
import {
  cableTypeForDef,
  spineCableVar,
  laneFaceTier,
  laneBodyPlan,
  roleLineForDef,
  offersFullView,
  domainClassForCable,
  domainClassForDef,
  LANE_ROW_MAX_CELLS,
  LANE_ROW_MAX_CELLS_WITH_GLYPH,
  PLATE_COLS,
  PLATE_MAX_ROWS,
  SHELL_TILE_H,
  SHELL_TILE_W,
  SHELL_TILE_H_SLOT,
  SHELL_VIDEO_ZONE_TILE_INSET_Y,
  type ShellDefLike,
} from './module-shell-model';
import { curatedFace, type FaceDefLike } from './curated-face';
import type { Tier } from '$lib/ui/canvas/lod';

describe('cableTypeForDef / spineCableVar — spine = the module domain hue', () => {
  it('prefers the first OUTPUT cable type', () => {
    const def: ShellDefLike = {
      domain: 'audio',
      inputs: [{ id: 'in', type: 'audio' }],
      outputs: [{ id: 'out', type: 'cv' }],
    };
    expect(cableTypeForDef(def)).toBe('cv');
    expect(spineCableVar(def)).toBe('var(--cable-cv)');
  });

  it('falls back to the first INPUT when there are no outputs', () => {
    expect(cableTypeForDef({ inputs: [{ id: 'g', type: 'gate' }], outputs: [] })).toBe('gate');
  });

  it('falls back to the domain when there are no ports', () => {
    expect(cableTypeForDef({ domain: 'video' })).toBe('video');
    expect(cableTypeForDef({ domain: 'audio' })).toBe('audio');
    // meta / unknown domain → audio hue
    expect(cableTypeForDef({ domain: 'meta' })).toBe('audio');
    expect(cableTypeForDef(undefined)).toBe('audio');
  });

  it('spineCableVar always yields a var(--cable-*) reference', () => {
    expect(spineCableVar({ domain: 'video' })).toBe('var(--cable-video)');
    expect(spineCableVar(undefined)).toBe('var(--cable-audio)');
  });
});

describe('laneFaceTier — LOD tier → lane FaceTier', () => {
  it('is identity for mini/compact/full', () => {
    expect(laneFaceTier('mini')).toBe('mini');
    expect(laneFaceTier('compact')).toBe('compact');
    expect(laneFaceTier('full')).toBe('full');
  });

  it("collapses the richest LOD band 'dock' to 'full' in the lane", () => {
    expect(laneFaceTier('dock')).toBe('full');
  });

  it('never returns dock for a lane (the dock faceplate is a separate view)', () => {
    const tiers: Tier[] = ['mini', 'compact', 'full', 'dock'];
    for (const t of tiers) expect(laneFaceTier(t)).not.toBe('dock');
  });
});

describe('offersFullView', () => {
  it('offers the dock full-view affordance at every tier', () => {
    for (const t of ['mini', 'compact', 'full', 'dock'] as Tier[]) {
      expect(offersFullView(t)).toBe(true);
    }
  });
});

describe('SHELL_TILE_W / SHELL_TILE_H_SLOT — the RACKLINE tile geometry (CSS/TS lock)', () => {
  // These mirror the tokens.css `--shell-tile-w` / `--shell-tile-h` values 1:1;
  // _module-card.css pins the shell/placeholder tile box to those tokens — the
  // SAME height at EVERY LOD tier — and Canvas (wcolCardWidthPx /
  // wcolCardHeightPx) returns the SAME numbers under the preview so the reserved
  // column slot == the rendered tile. If a token OR a constant moves, they MUST
  // move together — a drift floats the baseline badge / breaks band-centering.
  it('SHELL_TILE_W is the mock 192px uniform tile width (--shell-tile-w)', () => {
    expect(SHELL_TILE_W).toBe(192);
  });

  it('SHELL_TILE_H_SLOT is the ONE fixed slot height — the mock 180px tile (--shell-tile-h)', () => {
    // The zoom-reposition fix (option (c)): the OUTER lane-slot box keeps ONE
    // FIXED height across every LOD tier (only the CONTENT varies), so
    // flush-stack Y positions are byte-identical at every zoom. Pinned to the
    // compact/full design height — the mock's 180px .mod/.plate tile.
    expect(SHELL_TILE_H_SLOT).toBe(180);
  });

  it('SHELL_TILE_H is the fixed slot (back-compat alias)', () => {
    expect(SHELL_TILE_H).toBe(SHELL_TILE_H_SLOT);
  });

  it('SHELL_VIDEO_ZONE_TILE_INSET_Y nudges a video tile fully inside the video area', () => {
    // A positive inset (so the tile top clears the zone's dashed border + VIDEO
    // label at COLUMN_BASELINE_Y), with room for the fixed-slot tile inside the
    // 540px video area (inset + slot height stays well under the zone height).
    expect(SHELL_VIDEO_ZONE_TILE_INSET_Y).toBeGreaterThan(0);
    expect(SHELL_VIDEO_ZONE_TILE_INSET_Y + SHELL_TILE_H_SLOT).toBeLessThan(540);
  });
});

describe('domainClassForCable / domainClassForDef — kit domain class', () => {
  it('maps each cable type to its signal-domain setter', () => {
    expect(domainClassForCable('audio')).toBe('audio');
    expect(domainClassForCable('gate')).toBe('gate');
    expect(domainClassForCable('cv')).toBe('cv');
    // secondary cable types fold into their parent domain
    expect(domainClassForCable('pitch')).toBe('cv');
    expect(domainClassForCable('polyPitchGate')).toBe('poly');
    expect(domainClassForCable('keys')).toBe('poly');
    expect(domainClassForCable('video')).toBe('video');
    expect(domainClassForCable('image')).toBe('video');
    expect(domainClassForCable('mono-video')).toBe('video');
  });

  it('unknown / undefined cable → audio', () => {
    expect(domainClassForCable('bananas')).toBe('audio');
    expect(domainClassForCable(undefined)).toBe('audio');
  });

  it('domainClassForDef derives from the module primary cable (spine hue)', () => {
    // A video sink: primary OUTPUT (or input) is video → violet domain.
    expect(domainClassForDef({ outputs: [{ id: 'out', type: 'video' }] })).toBe('video');
    // A gate source → amber domain.
    expect(domainClassForDef({ inputs: [], outputs: [{ id: 'g', type: 'gate' }] })).toBe('gate');
    // No ports → domain fallback (video domain → video; else audio).
    expect(domainClassForDef({ domain: 'video' })).toBe('video');
    expect(domainClassForDef(undefined)).toBe('audio');
  });
});

describe('roleLineForDef — the migrated header role line', () => {
  it('prefers the def category role string', () => {
    expect(roleLineForDef({ category: 'modulation' })).toBe('modulation');
    expect(
      roleLineForDef({ category: 'effects', palette: { top: 'Audio modules', sub: 'Effects' } }),
    ).toBe('effects');
  });

  it('falls back to the palette sub-category, then undefined (caller keeps the type)', () => {
    expect(roleLineForDef({ palette: { top: 'Audio modules', sub: 'Utility' } })).toBe('Utility');
    expect(roleLineForDef({})).toBeUndefined();
    expect(roleLineForDef(undefined)).toBeUndefined();
  });

  it('ignores blank strings (a whitespace category never renders an empty badge)', () => {
    expect(roleLineForDef({ category: '   ', palette: { top: 'Audio modules', sub: 'VCOs' } })).toBe(
      'VCOs',
    );
    expect(roleLineForDef({ category: ' ', palette: { top: 'x', sub: '  ' } })).toBeUndefined();
  });
});

describe('laneBodyPlan — the fixed-tile no-clip guarantee', () => {
  it('mini: one hero cell + the glyph', () => {
    expect(laneBodyPlan(8, true, 'mini')).toEqual({ layout: 'row', cellCount: 1, glyph: true, knobSize: 'md' });
    expect(laneBodyPlan(0, true, 'mini')).toEqual({ layout: 'row', cellCount: 0, glyph: true, knobSize: 'md' });
    expect(laneBodyPlan(5, false, 'mini')).toEqual({ layout: 'row', cellCount: 1, glyph: false, knobSize: 'md' });
  });

  it('compact row: whole md cells only — 2 with a glyph (which fills the rest), 3 without', () => {
    expect(laneBodyPlan(3, true, 'compact')).toEqual({
      layout: 'row',
      cellCount: LANE_ROW_MAX_CELLS_WITH_GLYPH,
      glyph: true,
      knobSize: 'md',
    });
    expect(laneBodyPlan(3, false, 'compact')).toEqual({
      layout: 'row',
      cellCount: LANE_ROW_MAX_CELLS,
      glyph: false,
      knobSize: 'md',
    });
    // A small face keeps every cell.
    expect(laneBodyPlan(2, true, 'compact')).toEqual({ layout: 'row', cellCount: 2, glyph: true, knobSize: 'md' });
  });

  it('full keeps the ROW (md cells, glyph) while the whole face fits it — the vca case', () => {
    expect(laneBodyPlan(2, true, 'full')).toEqual({ layout: 'row', cellCount: 2, glyph: true, knobSize: 'md' });
    expect(laneBodyPlan(3, false, 'full')).toEqual({ layout: 'row', cellCount: 3, glyph: false, knobSize: 'md' });
  });

  it('full switches to the 3-col PLATE when the face outgrows the row: whole rows only, max 6 cells', () => {
    // kickdrum/tidyVco/cloudseed: 8 ranked at full → 2 whole rows = 6 cells,
    // ranks 7-8 not rendered in-lane, no room for a whole glyph strip.
    expect(laneBodyPlan(8, true, 'full')).toEqual({ layout: 'plate', cellCount: 6, glyph: false, knobSize: 'sm' });
    expect(laneBodyPlan(8, true, 'full').cellCount).toBe(PLATE_COLS * PLATE_MAX_ROWS);
    // adsr: 4 ranked → 2 rows (3+1), all four render, glyph strip doesn't fit.
    expect(laneBodyPlan(4, true, 'full')).toEqual({ layout: 'plate', cellCount: 4, glyph: false, knobSize: 'sm' });
  });

  it('full PLATE keeps the glyph strip when the cells need only one row — the lfo case', () => {
    // lfo: 3 ranked with a glyph → 3 > row max (2) → plate, one row of cells +
    // a whole full-width glyph strip.
    expect(laneBodyPlan(3, true, 'full')).toEqual({ layout: 'plate', cellCount: 3, glyph: true, knobSize: 'sm' });
  });

  it('never plans more cells than exist, and never a partial row beyond the plate cap', () => {
    for (const tier of ['mini', 'compact', 'full'] as const) {
      for (const glyph of [true, false]) {
        for (let n = 0; n <= 12; n++) {
          const plan = laneBodyPlan(n, glyph, tier);
          expect(plan.cellCount).toBeLessThanOrEqual(n);
          expect(plan.cellCount).toBeLessThanOrEqual(PLATE_COLS * PLATE_MAX_ROWS);
          if (plan.layout === 'plate' && plan.glyph) {
            // A plate glyph strip only ever coexists with a single cell row.
            expect(Math.ceil(plan.cellCount / PLATE_COLS)).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe('ModuleShell tier-swap contract (fixture — no real module is faced yet)', () => {
  // A 10-param fixture with a full ranking — the shell's controlGrid renders
  // exactly curatedFace(def, laneFaceTier(lodTier)).controls, so this composes
  // what the shell does across the LOD bands and pins the content-swap ladder.
  const fixture: FaceDefLike = {
    params: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, label: `P${i}` })),
    face: { order: Array.from({ length: 10 }, (_, i) => `p${i}`), glyph: 'scope' },
  };

  function laneControlCount(lodTier: Tier): number {
    return curatedFace(fixture, laneFaceTier(lodTier))?.controls.length ?? -1;
  }

  it('swaps CONTENT across LOD tiers: mini=1 / compact=3 / full=8', () => {
    expect(laneControlCount('mini')).toBe(1);
    expect(laneControlCount('compact')).toBe(3);
    expect(laneControlCount('full')).toBe(8);
  });

  it("the richest LOD band 'dock' still renders the FULL-in-lane face (8), not all", () => {
    // In the lane, 'dock' collapses to 'full' — the true all-controls faceplate
    // is the separate dock VIEW (curatedFace(def,'dock')), never the lane.
    expect(laneControlCount('dock')).toBe(8);
    expect(curatedFace(fixture, 'dock')?.controls.length).toBe(10); // the dock view = ALL
  });

  it('is monotonic non-decreasing in richness across the lane tiers', () => {
    const counts = (['mini', 'compact', 'full', 'dock'] as Tier[]).map(laneControlCount);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });

  it('an un-faced def yields no curated face (the shell falls back to placeholder upstream)', () => {
    expect(curatedFace({ params: [{ id: 'x' }] }, 'compact')).toBeNull();
  });
});
