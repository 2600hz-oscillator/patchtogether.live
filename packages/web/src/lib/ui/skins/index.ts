// Palette registry — single source of truth for the curated palettes shipped
// in-tree. (Formerly the "skins" registry; P0.1 re-tiered the theme surface to
// COLOR-ONLY palettes over one fixed dark structure — see ./types.ts.)
//
// New built-in palettes land here. The `PALETTES` array's order is the order
// rendered in the switcher popover; `rackline` MUST stay first so a brand-new
// visitor sees the canonical RACKLINE default.

import { racklinePalette } from './palettes/rackline';
import { graphitePalette } from './palettes/graphite';
import { midnightPalette } from './palettes/midnight';
import { emberPalette } from './palettes/ember';
import { slatePalette } from './palettes/slate';
import type { Palette, PaletteId } from './types';

export type { Palette, PaletteId } from './types';
export { swatchColorsFor } from './types';

export const PALETTES: readonly Palette[] = [
  racklinePalette,
  graphitePalette,
  midnightPalette,
  emberPalette,
  slatePalette,
] as const;

const PALETTE_BY_ID: Map<PaletteId, Palette> = new Map(PALETTES.map((p) => [p.id, p]));

export function getPalette(id: PaletteId): Palette {
  return PALETTE_BY_ID.get(id) ?? racklinePalette;
}

export function isPaletteId(id: string): id is PaletteId {
  return PALETTE_BY_ID.has(id as PaletteId);
}

export const DEFAULT_PALETTE_ID: PaletteId = 'rackline';
