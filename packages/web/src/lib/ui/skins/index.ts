// Skin registry — single source of truth for the skins shipped in-tree.
//
// New built-in skins land here. The `SKINS` array's order is the order
// rendered in the SkinSwitcher popover; `default` MUST stay first so a
// brand-new visitor sees it as the canonical baseline.

import { defaultSkin } from './default';
import { terminalGreenSkin } from './terminal-green';
import { brutalistSkin } from './brutalist';
import { vaporwaveSkin } from './vaporwave';
import { vintageSkin } from './vintage';
import type { Skin, SkinId } from './types';

export type { Skin, SkinId } from './types';
export { swatchColorsFor } from './types';

export const SKINS: readonly Skin[] = [
  defaultSkin,
  terminalGreenSkin,
  brutalistSkin,
  vaporwaveSkin,
  vintageSkin,
] as const;

const SKIN_BY_ID: Map<SkinId, Skin> = new Map(SKINS.map((s) => [s.id, s]));

export function getSkin(id: SkinId): Skin {
  return SKIN_BY_ID.get(id) ?? defaultSkin;
}

export function isSkinId(id: string): id is SkinId {
  return SKIN_BY_ID.has(id as SkinId);
}

export const DEFAULT_SKIN_ID: SkinId = 'default';
