// packages/web/src/lib/mike/catalog.ts
//
// Mike's curated module palette. He's the meticulous sibling of Carl —
// favors melodic, tonal, structured modules; avoids destructive /
// glitchy / chaos-leaning ones.
//
// We deliberately RE-EXPORT the Catalog / CatalogModule shape from
// `$lib/carl/catalog` rather than duplicating the type. The personality
// scorers in both bots share the same port/param reduced shape (cable
// types + ranges). The only difference is the spawn filter — `isMikeSpawnable`.

import {
  buildCatalogFromRegistry,
  type Catalog,
  type CatalogModule,
} from '$lib/carl/catalog';

export type { Catalog, CatalogModule };

/**
 * Modules Mike never spawns. Two reasons a module appears here:
 *   1. Output-only singletons (audioOut — there's exactly one of those
 *      per rack and Mike connects to the existing one, never spawns a
 *      second).
 *   2. Destructive / chaos / glitch personalities that conflict with
 *      Mike's "musical not chaotic" mandate (destroy, buggles).
 *
 * Mike is also allowed to skip a module by name via `isMikeSpawnable` for
 * any future module that doesn't fit. We bias toward an allow-list pattern
 * in the personality layer (PREFERRED_TYPES below) and use this set as
 * a hard floor.
 */
const NEVER_SPAWN: ReadonlySet<string> = new Set([
  'audioOut',
  'destroy',
  'buggles',
]);

export function isMikeSpawnable(module: CatalogModule): boolean {
  return !NEVER_SPAWN.has(module.type);
}

/**
 * Modules Mike actively reaches for, grouped by what they're FOR in his
 * patch-building loop. Returned arrays may overlap with one another
 * (a module can be useful in multiple roles).
 *
 * If a preferred type isn't in the runtime catalog (e.g. a build trimmed
 * it), the picker falls back to whatever IS present in the same role —
 * `pickByRole()` filters by `catalog.find()`.
 */
export const PREFERRED_TYPES = {
  /** Step/note sequencers. Drums first since drums get spawned first. */
  drumSequencers: ['drumseqz'],
  toneSequencers: ['polyseqz', 'sequencer', 'macseq', 'sequencerPages'],
  /** Tonal voices for melody + bass lines. */
  tonalVoices: ['analogVco', 'macrooscillator', 'wavetableVco', 'swolevco'],
  /** Drum voices — modules whose output is a drum hit. Mike's drum-
   *  voice slot in his progression accepts any "audio out + gate in"
   *  module; in practice that's the modules below. */
  drumVoices: ['drummergirl', 'meowbox', 'noise'],
  /** Effects — apply after a voice, before the mixer. */
  effects: ['reverb', 'cloudseed', 'shimmershine', 'clouds', 'charlottesEchos'],
  /** Mixers — Mike spawns ONE per rack and re-uses it. */
  mixers: ['mixer', 'mixmstrs'],
  /** Master clock generators — TIMELORDE only for v1. */
  clocks: ['timelorde'],
  /** Envelopes for shaping voice gates. */
  envelopes: ['adsr'],
  /** VCAs for amplitude shaping. */
  vcas: ['vca', 'stereovca'],
} as const;

export type MikeRole = keyof typeof PREFERRED_TYPES;

/**
 * Find a CatalogModule in the runtime catalog whose type matches the
 * first available preferred type for the given role. Returns null if
 * none of the preferred types are present in the catalog (which would
 * be unusual but is handled defensively).
 */
export function pickByRole(catalog: Catalog, role: MikeRole): CatalogModule | null {
  const preferred = PREFERRED_TYPES[role];
  for (const type of preferred) {
    const found = catalog.find((m) => m.type === type);
    if (found) return found;
  }
  return null;
}

/**
 * Same as pickByRole but also accepts a "skip these types" set so the
 * driver can ask for a SECOND choice ("give me a different sequencer
 * than this one"). Used when Mike adds variety (e.g. different
 * sequencer for the bass line than for the drums).
 */
export function pickByRoleExcluding(
  catalog: Catalog,
  role: MikeRole,
  skip: ReadonlySet<string>,
): CatalogModule | null {
  const preferred = PREFERRED_TYPES[role];
  for (const type of preferred) {
    if (skip.has(type)) continue;
    const found = catalog.find((m) => m.type === type);
    if (found) return found;
  }
  return null;
}

export { buildCatalogFromRegistry };
