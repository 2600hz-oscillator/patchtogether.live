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
  offersFullView,
  domainClassForCable,
  domainClassForDef,
  SHELL_TILE_H,
  SHELL_TILE_W,
  SHELL_TILE_H_MINI,
  SHELL_TILE_H_COMPACT,
  SHELL_TILE_H_FULL,
  SHELL_VIDEO_ZONE_TILE_INSET_Y,
  shellTileHeightForTier,
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

describe('SHELL_TILE_W / SHELL_TILE_H_* — the RACKLINE tile geometry (CSS/TS lock)', () => {
  // These mirror the tokens.css `--shell-tile-w` / `--tile-h-{mini,compact,full}`
  // values 1:1; _module-card.css pins the shell/placeholder tile `width` to
  // var(--shell-tile-w) and its height per `data-shell-tier` off those tokens,
  // and Canvas (wcolCardWidthPx / wcolCardHeightPx) returns the SAME numbers under
  // the preview so the reserved column slot == the rendered tile. If a token OR a
  // constant moves, they MUST move together — a drift floats the baseline badge /
  // breaks band-centering.
  it('SHELL_TILE_W is the mock 192px uniform tile width (--shell-tile-w)', () => {
    expect(SHELL_TILE_W).toBe(192);
  });

  it('per-tier heights grow mini→compact→full (--tile-h-{mini,compact,full})', () => {
    expect(SHELL_TILE_H_MINI).toBe(88);
    expect(SHELL_TILE_H_COMPACT).toBe(150);
    expect(SHELL_TILE_H_FULL).toBe(180);
    // strictly increasing — the tile grows as you zoom in.
    expect(SHELL_TILE_H_MINI).toBeLessThan(SHELL_TILE_H_COMPACT);
    expect(SHELL_TILE_H_COMPACT).toBeLessThan(SHELL_TILE_H_FULL);
  });

  it('SHELL_TILE_H is the mini floor (back-compat alias)', () => {
    expect(SHELL_TILE_H).toBe(88);
    expect(SHELL_TILE_H).toBe(SHELL_TILE_H_MINI);
  });

  it('shellTileHeightForTier maps every lane tier to its height (dock → full)', () => {
    expect(shellTileHeightForTier('mini')).toBe(SHELL_TILE_H_MINI);
    expect(shellTileHeightForTier('compact')).toBe(SHELL_TILE_H_COMPACT);
    expect(shellTileHeightForTier('full')).toBe(SHELL_TILE_H_FULL);
    // 'dock' never reaches a lane (laneFaceTier collapses it), but map defensively.
    expect(shellTileHeightForTier('dock')).toBe(SHELL_TILE_H_FULL);
  });

  it('SHELL_VIDEO_ZONE_TILE_INSET_Y nudges a video tile fully inside the video area', () => {
    // A positive inset (so the tile top clears the zone's dashed border + VIDEO
    // label at COLUMN_BASELINE_Y), with room for the tallest tile inside the
    // 540px video area (inset + full height stays well under the zone height).
    expect(SHELL_VIDEO_ZONE_TILE_INSET_Y).toBeGreaterThan(0);
    expect(SHELL_VIDEO_ZONE_TILE_INSET_Y + SHELL_TILE_H_FULL).toBeLessThan(540);
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
