// packages/web/src/lib/ui/workflow/shell-extensions.ts
//
// THE MODULE-EXTENSION REGISTRY (#1512) — def-declared, LAZILY-resolved
// bespoke components at the shell's defined slots.
//
// ModuleShell is the ONE shared renderer every migrated module fills, and it
// was already carrying its first module-specific import (Dx7AlgorithmGlyph) —
// the exact trajectory that produced the 8,610-line Canvas. As bespoke
// surfaces arrive for the NON_SHELL_LANE_TYPES cohort (clipplayer,
// controlSurface, electraControl, launchpadControl, videoOut, cameraInput),
// each would want its own special case in the shell. This registry is the seam
// they plug into instead:
//
//   1. The DEF declares `face.extension: '<id>'` — a string, never a
//      component, so `face` stays serialisable data (the sidebar-panels /
//      PF-14 precedent).
//   2. The extension lives at `$lib/ui/modules/<id>/shell-extension.ts`,
//      default-exporting a ShellExtension slot map. The module OWNS that file;
//      it may statically import its own components there.
//   3. The shell resolves the id through `loadShellExtension` — a NON-EAGER
//      `import.meta.glob`, so the module's bespoke code is a separate chunk
//      loaded only when a def that declares it actually renders. No module
//      name ever appears in ModuleShell's imports.
//
// Registration rides the SAME glob+declaration pattern the module registry and
// modules-card-map use: drop the file at the conventional path, declare the id
// on the def, and no shared file is edited (no cross-PR conflict surface).
//
// GUARDED, deny-by-default:
//   - module-shell-import-guard.test.ts — ModuleShell + its static import
//     closure reference no module-owned path; a new direct import reddens.
//   - shell-extensions.test.ts — every declared id resolves to a discovered
//     extension module and every discovered module is declared by a def (both
//     directions, anchored to the artifact); an extension exporting a slot the
//     shell does not render yet is refused until the render site exists.

import type { Component } from 'svelte';

/** Props of the GLYPH slot — the module's data-derived identity picture
 *  (dx7: the algorithm routing diagram). The shell renders it inside its own
 *  generic plate (`.topo-glyph` frame + caption) at the tile/dock glyph slot
 *  AND as the per-cell picture of a `paramCells: 'grid'` picker, so the
 *  component must scale by viewBox alone. */
export interface ShellExtensionGlyphProps {
  /** The bound topology param's current value (see GlyphBinding 'algorithm'). */
  num: number;
  /** Draw in-picture labels (e.g. operator numbers). The picker's ~26px cells
   *  turn them off — a 2px digit is noise, not information. */
  numbers?: boolean;
  testid?: string;
}

/**
 * The slot map ONE extension module default-exports. Every slot is optional —
 * an extension fills only what its module needs.
 *
 * ⚠ ONLY `glyph` HAS A RENDER SITE TODAY (`WIRED_SHELL_EXTENSION_SLOTS`).
 * `editorSurface` / `fullViewBody` are the DECLARED contract for the LEG-05
 * bespoke-surface cohort; the first adopter wires the render site in
 * ModuleShell and moves the slot to the wired list IN THE SAME DIFF —
 * shell-extensions.test.ts refuses an extension exporting an unwired slot, so
 * a slot can never silently no-op.
 */
export interface ShellExtension {
  /** The module's identity/topology picture — fills the shell's glyph slot
   *  (the `.topo-diagram` plate) and the grid-picker cell. */
  glyph?: Component<ShellExtensionGlyphProps>;
  /** A bespoke EDITOR SURFACE for controls that are not cell-shaped at all
   *  (a clip arranger, a pad matrix). Distinct from a PF-14 `panel` CELL,
   *  which stays the right seam for one picture-you-edit inside the generic
   *  face. UNWIRED — see the interface note. */
  editorSurface?: Component<{ nodeId: string }>;
  /** A fully bespoke DOCK FULL-VIEW body, replacing the generic faceplate
   *  bands for modules whose full view is not a faceplate. UNWIRED — see the
   *  interface note. */
  fullViewBody?: Component<{ nodeId: string }>;
}

/** Every slot key the contract defines. A loaded extension exporting any OTHER
 *  key is refused by shell-extensions.test.ts (deny by default). */
export const SHELL_EXTENSION_SLOTS = ['glyph', 'editorSurface', 'fullViewBody'] as const;

/** The slots ModuleShell actually RENDERS today. shell-extensions.test.ts
 *  anchors this list to ModuleShell's source in BOTH directions (a wired slot
 *  must be read as `ext?.<slot>`; an unwired one must not appear), so it
 *  cannot drift from the render reality it names. */
export const WIRED_SHELL_EXTENSION_SLOTS = ['glyph'] as const;

/** Slot keys a loaded extension exports that the contract does not define. */
export function unknownSlotKeys(ext: object): string[] {
  const known = new Set<string>(SHELL_EXTENSION_SLOTS);
  return Object.keys(ext).filter((k) => !known.has(k));
}

/** Declared slot keys the shell has no render site for yet — exporting one is
 *  a silent no-op, which the lint refuses (wire the site first). */
export function unwiredSlotKeys(ext: object): string[] {
  const wired = new Set<string>(WIRED_SHELL_EXTENSION_SLOTS);
  return Object.keys(ext).filter(
    (k) => (SHELL_EXTENSION_SLOTS as readonly string[]).includes(k) && !wired.has(k),
  );
}

// The LAZY glob — no `eager`, so each match compiles to a dynamic import in
// its own chunk. The key is the extension id's one home: the directory name.
const EXTENSION_MODULES = import.meta.glob<{ default?: ShellExtension }>(
  '../modules/*/shell-extension.ts',
);

const LOADERS = new Map<string, () => Promise<{ default?: ShellExtension }>>();
for (const [path, loader] of Object.entries(EXTENSION_MODULES)) {
  const m = path.match(/\/modules\/([^/]+)\/shell-extension\.ts$/);
  if (m) LOADERS.set(m[1], loader);
}

/** Every discovered extension id (the glob's directory names), sorted — the
 *  roster the def-side lint checks a declared `face.extension` against. */
export function shellExtensionIds(): string[] {
  return [...LOADERS.keys()].sort();
}

const CACHE = new Map<string, Promise<ShellExtension | null>>();

/**
 * Resolve a declared extension id to its slot map. Lazy on first call, cached
 * after (module-level, so every shell instance shares one load). An id the
 * glob did not discover resolves `null` — the RENDER degrades to the generic
 * shell (never throws mid-frame); the LINT is what makes the mismatch red.
 */
export function loadShellExtension(id: string): Promise<ShellExtension | null> {
  let p = CACHE.get(id);
  if (!p) {
    const loader = LOADERS.get(id);
    p = loader ? loader().then((m) => m.default ?? null) : Promise.resolve(null);
    CACHE.set(id, p);
  }
  return p;
}
