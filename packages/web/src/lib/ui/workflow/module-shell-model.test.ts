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
  PLATE_ROW_H,
  PLATE_GAP_Y,
  LANE_BODY_H,
  LANE_CELL_H,
  laneCellHeight,
  plateRowsFor,
  plateGlyphFits,
  SHELL_TILE_H,
  SHELL_TILE_W,
  SHELL_TILE_H_SLOT,
  SHELL_VIDEO_ZONE_TILE_INSET_Y,
  DOCK_HERO_GLYPH_COLS,
  DOCK_KCOL_W,
  DOCK_PAGE_GAP_X,
  DOCK_HERO_GLYPH_W,
  hasVideoSurface,
  thumbFitRect,
  videoZonePackedXs,
  VIDEO_THUMB_W,
  VIDEO_THUMB_H,
  VIDEO_THUMB_FPS,
  dockFullViewHeadPlan,
  isFaceplateView,
  type ShellDefLike,
  type ShellView,
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
    expect(laneBodyPlan(8, true, 'mini')).toEqual({ layout: 'row', cellCount: 1, glyph: true, knobSize: 'md', rowTracks: [] });
    expect(laneBodyPlan(0, true, 'mini')).toEqual({ layout: 'row', cellCount: 0, glyph: true, knobSize: 'md', rowTracks: [] });
    expect(laneBodyPlan(5, false, 'mini')).toEqual({ layout: 'row', cellCount: 1, glyph: false, knobSize: 'md', rowTracks: [] });
  });

  it('compact row: whole md cells only — 2 with a glyph (which fills the rest), 3 without', () => {
    expect(laneBodyPlan(3, true, 'compact')).toEqual({
      layout: 'row',
      cellCount: LANE_ROW_MAX_CELLS_WITH_GLYPH,
      glyph: true,
      knobSize: 'md',
      rowTracks: [],
    });
    expect(laneBodyPlan(3, false, 'compact')).toEqual({
      layout: 'row',
      cellCount: LANE_ROW_MAX_CELLS,
      glyph: false,
      knobSize: 'md',
      rowTracks: [],
    });
    // A small face keeps every cell.
    expect(laneBodyPlan(2, true, 'compact')).toEqual({ layout: 'row', cellCount: 2, glyph: true, knobSize: 'md', rowTracks: [] });
  });

  it('full keeps the ROW (md cells, glyph) while the whole face fits it — the vca case', () => {
    expect(laneBodyPlan(2, true, 'full')).toEqual({ layout: 'row', cellCount: 2, glyph: true, knobSize: 'md', rowTracks: [] });
    expect(laneBodyPlan(3, false, 'full')).toEqual({ layout: 'row', cellCount: 3, glyph: false, knobSize: 'md', rowTracks: [] });
  });

  it('full switches to the 3-col PLATE when the face outgrows the row: whole rows only, max 6 cells', () => {
    // kickdrum/tidyVco/cloudseed: 8 ranked at full → 2 whole rows = 6 cells,
    // ranks 7-8 not rendered in-lane, no room for a whole glyph strip.
    expect(laneBodyPlan(8, true, 'full')).toEqual({ layout: 'plate', cellCount: 6, glyph: false, knobSize: 'sm', rowTracks: [PLATE_ROW_H, PLATE_ROW_H] });
    expect(laneBodyPlan(8, true, 'full').cellCount).toBe(PLATE_COLS * PLATE_MAX_ROWS);
    // adsr: 4 ranked → 2 rows (3+1), all four render, glyph strip doesn't fit.
    expect(laneBodyPlan(4, true, 'full')).toEqual({ layout: 'plate', cellCount: 4, glyph: false, knobSize: 'sm', rowTracks: [PLATE_ROW_H, PLATE_ROW_H] });
  });

  it('full PLATE keeps the glyph strip when the cells need only one row — the lfo case', () => {
    // lfo: 3 ranked with a glyph → 3 > row max (2) → plate, one row of cells +
    // a whole full-width glyph strip.
    expect(laneBodyPlan(3, true, 'full')).toEqual({ layout: 'plate', cellCount: 3, glyph: true, knobSize: 'sm', rowTracks: [PLATE_ROW_H] });
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

// ── THE NO-CLIP GUARANTEE, HELD FOR EVERY CELL KIND ─────────────────────────
//
// The guarantee `laneBodyPlan` has always CLAIMED is "only whole cells ever
// render inside the fixed tile". For six months it was computed against a
// single hardcoded cell height (42px, a small knob column) — true for every
// kind that existed, and false the moment one did not fit.
//
// `fader` (#1464) is 96px. `grid-auto-rows: 42px` with `align-items: start`
// does NOT clip an over-tall cell — it lets it paint over the row below — so
// the failure did not even present as a fit bug. marbles' full-tier tile
// measured three overlaps of exactly 50.0 CSS px (96 − the 46px row pitch):
// two thumbs per column, row 1's labels covered, and a `COIN ▾` grid chip
// floating on the T BIAS fader. Shipped to dev.
//
// These tests are written over the KIND UNION rather than over the two kinds
// that exist today, because "a whole kind reached production without this path
// ever seeing one" is the actual defect and a test naming `fader` would not
// have prevented it.
describe('lane cell HEIGHT — the plate fits every ParamCellKind, not just a knob', () => {
  // The union, enumerated ONCE from the table's own keys. A new kind lands in
  // `LANE_CELL_H` (a Record<ParamCellKind, number>, so TS forces it) and is
  // swept here automatically — there is no list in this file to forget.
  const KINDS = Object.keys(LANE_CELL_H) as (keyof typeof LANE_CELL_H)[];

  it('sweeps every declared kind (an empty sweep would prove nothing)', () => {
    expect(KINDS.length).toBeGreaterThan(0);
    // The table and the accessor are the same truth.
    for (const k of KINDS) expect(laneCellHeight(k)).toBe(LANE_CELL_H[k]);
  });

  it('EVERY kind gets whole rows that fit the body — no cell paints outside the tile', () => {
    const offenders: string[] = [];
    for (const kind of KINDS) {
      const h = LANE_CELL_H[kind];
      const rows = plateRowsFor(h);
      // What the grid actually occupies: `rows` tracks of `h` plus the gaps
      // BETWEEN them. This is the number that must clear the body.
      const used = rows * h + (rows - 1) * PLATE_GAP_Y;
      if (used > LANE_BODY_H) {
        offenders.push(
          `${kind}: cell ${h}px × ${rows} row(s) = ${used}px used, but the lane body is ` +
            `${LANE_BODY_H}px — the plate would paint ${used - LANE_BODY_H}px outside the tile`,
        );
      }
      expect(rows, `${kind}: a kind must always get at least one row`).toBeGreaterThanOrEqual(1);
    }
    expect(offenders.join('\n'), 'lane plate rows that do not fit the tile body').toBe('');
  });

  it('EVERY kind that the plate renders keeps its cells inside their grid track', () => {
    // The overlap condition, stated directly: a cell taller than its own row's
    // track paints over the row below. With PER-ROW tracks reported by the plan
    // the track IS the row's tallest cell, so the pitch can never be short —
    // which is the whole fix. Asserted per kind so a future kind whose height
    // the plan does not carry through cannot pass.
    const offenders: string[] = [];
    for (const kind of KINDS) {
      const h = LANE_CELL_H[kind];
      // 12 controls forces the plate at 'full' for any kind.
      const plan = laneBodyPlan(12, false, 'full', h);
      if (plan.layout !== 'plate') continue;
      // Every track must clear the cells it holds; only a row with a row BELOW
      // it can overlap anything, so the last track is free to be short.
      for (const [i, track] of plan.rowTracks.entries()) {
        const isLast = i === plan.rowTracks.length - 1;
        const overlap = h - track;
        if (overlap > 0 && !isLast) {
          offenders.push(
            `${kind}: a ${h}px cell in row ${i}'s ${track}px track overlaps the row below ` +
              `by ${overlap} CSS px`,
          );
        }
      }
      expect(
        Math.max(...plan.rowTracks),
        `${kind}: the plan must report the height its cells need`,
      ).toBe(h);
    }
    expect(offenders.join('\n'), 'lane plate cells overlapping the row below').toBe('');
  });

  it('a glyph strip is never promised where it would not fit', () => {
    for (const kind of KINDS) {
      const h = LANE_CELL_H[kind];
      const plan = laneBodyPlan(12, true, 'full', h);
      if (!plan.glyph) continue;
      const rows = Math.ceil(plan.cellCount / PLATE_COLS);
      expect(
        rows * (h + PLATE_GAP_Y) + PLATE_ROW_H,
        `${kind}: the plan keeps a glyph strip that does not fit under ${rows} row(s)`,
      ).toBeLessThanOrEqual(LANE_BODY_H + PLATE_GAP_Y);
    }
  });

  // ── THE NEGATIVE CONTROL, PERMANENT ───────────────────────────────────────
  // Every assertion above passes trivially if the geometry stops depending on
  // the cell height at all — which is EXACTLY the bug (a flat 42px). So push a
  // cell that cannot fit twice through the SAME predicates the checks call and
  // require the answers to move. Without this leg, a `plateRowsFor` that
  // returned the constant 2 would keep the suite green.
  it('the geometry actually reads the cell height (a flat row count fails here)', () => {
    // The design cell reproduces the historic hand-derived constant …
    expect(plateRowsFor(PLATE_ROW_H)).toBe(PLATE_MAX_ROWS);
    expect(PLATE_MAX_ROWS).toBe(2);
    // … and a cell too tall for two rows must drop to one.
    expect(plateRowsFor(LANE_CELL_H.fader)).toBe(1);
    expect(plateRowsFor(LANE_BODY_H)).toBe(1);
    // Same for the glyph strip: room under one design row, none under two, and
    // none under a fader row.
    expect(plateGlyphFits(1, PLATE_ROW_H)).toBe(true);
    expect(plateGlyphFits(2, PLATE_ROW_H)).toBe(false);
    expect(plateGlyphFits(1, LANE_CELL_H.fader)).toBe(false);
    // And the PLAN moves with it: the same control count and glyph flag give a
    // different tile for a tall cell than for a short one.
    expect(laneBodyPlan(6, false, 'full', PLATE_ROW_H).cellCount).toBe(6);
    expect(laneBodyPlan(6, false, 'full', LANE_CELL_H.fader).cellCount).toBe(PLATE_COLS);
  });

  it('marbles: the regression, at the numbers that were measured in the browser', () => {
    // The shipped face: six ranked controls, five of them faders, no glyph.
    //
    // BEFORE the fix the tile rendered all six in a 2-row plate of 42px tracks
    // while each fader cell was 96px, so rows 1 and 2 overlapped by exactly
    // 96 − 46 = 50 CSS px. Measured in Chromium on the live tile:
    //   rate×spread 22.6×50.0 · deja_vu×steps 28.2×50.0 · t_bias×t_model 33.9×24.0
    const fader = LANE_CELL_H.fader;
    expect(fader - (PLATE_ROW_H + PLATE_GAP_Y)).toBe(50);

    // AFTER: the plate can hold ONE row of 96px cells, so the cap is 3 …
    expect(plateRowsFor(fader)).toBe(1);

    // … and the two-step path the shell actually walks — cap the controls,
    // then plan the body — lands on three whole cells with NO overlap. Three
    // cells and no glyph fit the ROW layout, which lays them side by side, so
    // one 96px cell clears the 112px body outright.
    const cap = laneBodyPlan(Number.MAX_SAFE_INTEGER, false, 'full', fader).cellCount;
    expect(cap).toBe(3);
    const plan = laneBodyPlan(cap, false, 'full', fader);
    expect(plan.cellCount).toBe(3);
    expect(plan.layout).toBe('row');
    expect(fader).toBeLessThanOrEqual(LANE_BODY_H);
  });
});

describe('hasVideoSurface — which tiles carry the LIVE video thumbnail', () => {
  it('true exactly for VIDEO-domain defs (the ones VideoEngine.addNode registers a surface FBO for)', () => {
    expect(hasVideoSurface({ domain: 'video' })).toBe(true);
    expect(hasVideoSurface({ domain: 'audio' })).toBe(false);
    expect(hasVideoSurface({})).toBe(false);
    expect(hasVideoSurface(undefined)).toBe(false);
  });

  it('an AUDIO-domain module with cross-domain video PORTS (synesthesia) has NO engine surface → static glyph', () => {
    const synesthesiaLike: ShellDefLike = {
      domain: 'audio',
      inputs: [
        { id: 'a_in', type: 'audio' },
        { id: 'a_video_in', type: 'video' },
      ],
      outputs: [
        { id: 'a_band1_audio', type: 'audio' },
        { id: 'a_band1_raster', type: 'mono-video' },
      ],
    };
    expect(hasVideoSurface(synesthesiaLike)).toBe(false);
  });

  it('thumb policy constants: small buffer, throttled fps', () => {
    expect(VIDEO_THUMB_W).toBe(160);
    expect(VIDEO_THUMB_H).toBe(120);
    expect(VIDEO_THUMB_FPS).toBe(15);
  });
});

describe('thumbFitRect — aspect-fit blit rect (the legacy preview fit rule)', () => {
  it('pillarboxes a 4:3 engine frame into a wide well', () => {
    // 4:3 source into a 2:1 well → height-fill, centred horizontally.
    expect(thumbFitRect(1024, 768, 200, 100)).toEqual({ x: Math.round((200 - 133) / 2), y: 0, w: 133, h: 100 });
  });

  it('letterboxes into a tall well', () => {
    expect(thumbFitRect(1024, 768, 100, 200)).toEqual({ x: 0, y: Math.round((200 - 75) / 2), w: 100, h: 75 });
  });

  it('exact-aspect fills edge-to-edge', () => {
    expect(thumbFitRect(1024, 768, 160, 120)).toEqual({ x: 0, y: 0, w: 160, h: 120 });
  });

  it('degenerate source dims fall back to 4:3 (never NaN)', () => {
    expect(thumbFitRect(0, 0, 160, 120)).toEqual({ x: 0, y: 0, w: 160, h: 120 });
  });
});

describe('videoZonePackedXs — the shell video-zone render override packing', () => {
  const PITCH = 216; // SHELL_COLUMN_W (the tight ?shell=1 pitch)

  it('an all-tile zone packs to EXACTLY the historic fixed slots (originX + i*pitch)', () => {
    const xs = videoZonePackedXs(1000, [SHELL_TILE_W, SHELL_TILE_W, SHELL_TILE_W], PITCH);
    expect(xs).toEqual([1000, 1000 + PITCH, 1000 + 2 * PITCH]);
  });

  it('a LEGACY-width head (videoOut 360) pushes its tile neighbours right — no overlap', () => {
    const xs = videoZonePackedXs(1000, [360, SHELL_TILE_W, SHELL_TILE_W], PITCH);
    const gap = PITCH - SHELL_TILE_W; // 24
    expect(xs).toEqual([1000, 1000 + 360 + gap, 1000 + 360 + gap + SHELL_TILE_W + gap]);
    // no-overlap invariant: each next x clears the previous card's right edge
    expect(xs[1]! - (xs[0]! + 360)).toBe(gap);
    expect(xs[2]! - (xs[1]! + SHELL_TILE_W)).toBe(gap);
  });

  it('a RESIZED videoOut repacks the zone (pure render — widths in, xs out)', () => {
    const wide = videoZonePackedXs(0, [720, SHELL_TILE_W], PITCH);
    const narrow = videoZonePackedXs(0, [360, SHELL_TILE_W], PITCH);
    expect(wide[1]! - narrow[1]!).toBe(360);
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

  it('swaps CONTENT across LOD tiers: mini=1 / compact=2 (glyph face) / full=6', () => {
    expect(laneControlCount('mini')).toBe(1);
    // The fixture declares glyph 'scope', so compact is the fit-reconciled
    // two cells + glyph (faceTierCap) — the SAME number laneBodyPlan renders.
    expect(laneControlCount('compact')).toBe(2);
    expect(laneBodyPlan(laneControlCount('compact'), true, 'compact').cellCount).toBe(2);
    // 'full' is likewise fit-reconciled: the 3×2 plate paints SIX whole cells,
    // so selecting 8 only ever handed the shell two it had to throw away.
    expect(laneControlCount('full')).toBe(6);
    expect(laneBodyPlan(laneControlCount('full'), true, 'full').cellCount).toBe(6);
  });

  it("the richest LOD band 'dock' still renders the FULL-in-lane face (6), not all", () => {
    // In the lane, 'dock' collapses to 'full' — the true all-controls faceplate
    // is the separate dock VIEW (curatedFace(def,'dock')), never the lane.
    expect(laneControlCount('dock')).toBe(6);
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

describe('DOCK_HERO_GLYPH_W — the dock hero glyph width cap (owner batch-1 feedback)', () => {
  it('spans exactly the first FOUR knob columns of the control grid (+ their gaps)', () => {
    expect(DOCK_HERO_GLYPH_COLS).toBe(4);
    expect(DOCK_HERO_GLYPH_W).toBe(
      DOCK_HERO_GLYPH_COLS * DOCK_KCOL_W + (DOCK_HERO_GLYPH_COLS - 1) * DOCK_PAGE_GAP_X,
    );
    expect(DOCK_HERO_GLYPH_W).toBe(214);
  });

  it('stays well under the uniform faceplate width vocabulary (blank space remains to the right)', () => {
    // The dock faceplate is far wider than a lane tile; even against the
    // 192px lane-tile vocabulary the cap can never exceed ~2 tiles — the
    // point is a BOUNDED hero, not a full-width strip.
    expect(DOCK_HERO_GLYPH_W).toBeLessThan(SHELL_TILE_W * 2);
    // Aligned to the shared knob-column design constant (--kcol-max mirror).
    expect(DOCK_KCOL_W).toBe(46);
    expect(DOCK_PAGE_GAP_X).toBe(10);
  });
});

// ── dockFullViewHeadPlan — the dock full-view head (#1726) ───────────────────
//
// WHAT THIS GATE CANNOT SEE, stated inside it: this is the PURE precedence, not
// the paint. It cannot see that `.dock-ext-body` is styled full-width, nor that
// the mounted component draws anything — the source anchors in
// shell-extensions.test.ts pin the render site's existence, and a VRT scene
// pins the pixels the day a face adopts the slot. What it CAN see, and what no
// other browser-free gate can, is that adding the slot changed nothing for the
// faces that do not use it.
describe('dockFullViewHeadPlan — who owns the top of a dock faceplate', () => {
  const LANE = { view: 'lane', hasGlyph: true, heroCell: false, hasExtensionBody: false } as const;
  const DOCK = { ...LANE, view: 'dock-full' } as const;

  it('an extension body claims the head and takes the hero glyph with it', () => {
    const p = dockFullViewHeadPlan({ ...DOCK, hasExtensionBody: true });
    expect(p.extBody).toBe(true);
    expect(p.heroGlyph, 'a module that brought its own picture does not also want the shell thumbnail').toBe(false);
  });

  it('it beats a hero.cell too — most specific wins, and only one head paints', () => {
    const p = dockFullViewHeadPlan({ ...DOCK, heroCell: true, hasExtensionBody: true });
    expect(p.extBody).toBe(true);
    expect(p.heroGlyph).toBe(false);
  });

  it('LANE never paints it: a 192px tile cannot carry a module surface', () => {
    const p = dockFullViewHeadPlan({ ...LANE, hasExtensionBody: true });
    expect(p.extBody).toBe(false);
    expect(p.heroGlyph, 'and the lane keeps the thumbnail glyph it has today').toBe(true);
  });

  it('a def with no glyph at all gets neither head', () => {
    const p = dockFullViewHeadPlan({ ...DOCK, hasGlyph: false });
    expect(p).toEqual({ extBody: false, heroGlyph: false });
  });

  // ── PERMANENT NEGATIVE CONTROL — the no-adopter invariant ─────────────────
  //
  // The whole risk of wiring a new head is that it moves the ~40 faceplates
  // that will never declare one. So: over EVERY combination of the other
  // inputs, `hasExtensionBody: false` must reproduce the expression ModuleShell
  // carried before #1726, bit for bit. This is the leg that would redden if a
  // later edit made the plan "helpful" — and it is written as the pre-#1726
  // formula rather than as expected values, so it is the OLD CODE that is being
  // compared against, not a transcription of the new one.
  it('NEGATIVE CONTROL: with no extension body the plan IS the pre-#1726 expression', () => {
    const legacyHeroGlyph = (view: 'lane' | 'dock-full', hasGlyph: boolean, heroCell: boolean) =>
      hasGlyph && !(view === 'dock-full' && heroCell);
    for (const view of ['lane', 'dock-full'] as const) {
      for (const hasGlyph of [false, true]) {
        for (const heroCell of [false, true]) {
          const p = dockFullViewHeadPlan({ view, hasGlyph, heroCell, hasExtensionBody: false });
          expect(p.extBody, `${view}/${hasGlyph}/${heroCell}`).toBe(false);
          expect(p.heroGlyph, `${view}/${hasGlyph}/${heroCell}`).toBe(
            legacyHeroGlyph(view, hasGlyph, heroCell),
          );
        }
      }
    }
  });

  // The other direction of the same control: the ONLY input that may change the
  // answer relative to the legacy formula is `hasExtensionBody`, and it must
  // change it — a plan invariant to the new input would be a no-op wearing a
  // render site.
  it('NEGATIVE CONTROL (other direction): the new input actually moves the plan', () => {
    const off = dockFullViewHeadPlan({ ...DOCK, hasExtensionBody: false });
    const on = dockFullViewHeadPlan({ ...DOCK, hasExtensionBody: true });
    expect(off).not.toEqual(on);
    expect([off.extBody, on.extBody]).toEqual([false, true]);
  });
});

// ── THE SHELL VIEW UNION, AND THE THIRD MEMBER (#1739) ──────────────────────
//
// `isFaceplateView` is the one place the union collapses to "is this the full
// faceplate?". ModuleShell asks it ~30 times; every one of those sites used to
// read `view === 'dock-full'`, which silently answered NO for the drawer and
// would have painted six of mixmstrs' ninety-one controls in the `m` tray.
//
// ⚠ WHAT THIS GATE CANNOT SEE: it is the pure predicate, not the shell. That
// ModuleShell actually CALLS it at every one of those sites is
// `module-shell-drawer-view.test.ts`'s source anchor; that the drawer host
// mounts the shell at all is `e2e/tests/workflow-drawer-face.spec.ts`.
describe('isFaceplateView — which surfaces paint the FULL faceplate (#1739)', () => {
  // DERIVED over the union, not three hand-written cases: a fourth member added
  // without a decision here goes red rather than defaulting.
  const ALL: readonly ShellView[] = ['lane', 'dock-full', 'drawer'];

  it('both DOCK hosts are faceplates; the lane tile is not', () => {
    expect(ALL.filter((v) => isFaceplateView(v))).toEqual(['dock-full', 'drawer']);
    expect(ALL.filter((v) => !isFaceplateView(v))).toEqual(['lane']);
  });

  it('it is `!== lane`, so a NEW member is a faceplate by default rather than silently a tile', () => {
    // The failure mode this shape prevents: `=== dock-full` makes every future
    // member fall into the LANE branch, which is a fraction of the controls and
    // looks like a working face.
    expect(isFaceplateView('drawer')).toBe(true);
  });
});

describe('dockFullViewHeadPlan — the DRAWER answers like the full view (#1739)', () => {
  const BASE = { hasGlyph: true, heroCell: false, hasExtensionBody: false } as const;

  it('the two dock hosts agree over EVERY combination of the other inputs', () => {
    for (const hasGlyph of [false, true]) {
      for (const heroCell of [false, true]) {
        for (const hasExtensionBody of [false, true]) {
          const args = { hasGlyph, heroCell, hasExtensionBody };
          expect(
            dockFullViewHeadPlan({ ...args, view: 'drawer' }),
            `drawer vs dock-full @ glyph=${hasGlyph} hero=${heroCell} ext=${hasExtensionBody}`,
          ).toEqual(dockFullViewHeadPlan({ ...args, view: 'dock-full' }));
        }
      }
    }
  });

  it('NEGATIVE CONTROL: and BOTH still differ from the lane, so the equality above is not vacuous', () => {
    const ext = { ...BASE, hasExtensionBody: true };
    expect(dockFullViewHeadPlan({ ...ext, view: 'lane' })).not.toEqual(
      dockFullViewHeadPlan({ ...ext, view: 'drawer' }),
    );
    expect(dockFullViewHeadPlan({ ...ext, view: 'lane' }).extBody).toBe(false);
    expect(dockFullViewHeadPlan({ ...ext, view: 'drawer' }).extBody).toBe(true);
  });
});
