// packages/web/src/lib/ui/modules/matrixmix/shell-extension.ts
//
// The MATRIXMIX SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `matrixmixDef.face!.extension: 'matrixmix'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a matrix component itself, which keeps
// `module-shell-import-guard` green.
//
// ── WHY `fullViewBody` AND NOT A PF-14 `panel` CELL ─────────────────────────
//
// A `ShellPanelCell` is the seam for "one picture-you-edit inside the generic
// face", which is very nearly what a cross-point grid is, and it was the first
// candidate. It loses on two measurements, both of them about REQUIRED fields:
//
//   1. `minWidth` is a required NUMBER — "the panel's own design floor", emitted
//      as `--panel-min-w`. This grid has no design floor: it is 4 columns or 40
//      depending on two OTHER modules. Any number written there would be a
//      fiction, and a fiction in a required field is worse than an absent field.
//   2. The required `probe` speaks `data` / `data-rev` / `text`. This grid's
//      observable is `patch.edges` — an edge materialising between two FOREIGN
//      nodes. That is neither this node's `data` nor its text, so the only
//      expressible probe would be a revision counter, and the registry's own
//      warning applies verbatim: "a revision-only probe passes on a DEAD button
//      that bumps the counter without editing anything."
//
// `fullViewBody` requires neither. It is WIRED, takes `nodeId`, paints above the
// bands, replaces the hero glyph (which matrixMix does not have), and leaves the
// two ranked axis cells intact.
//
// ── AND NEVER `editorSurface`, EVEN THOUGH THIS IS THE MODULE IT NAMES ──────
//
// `shell-extensions.ts` describes `editorSurface` as "a bespoke EDITOR SURFACE
// for controls that are not cell-shaped at all (a clip arranger, A PAD MATRIX)",
// and a cross-point matrix is about as close to a pad matrix as the roster gets.
// It is still the wrong slot: `editorSurface` is DECLARED AND UNWIRED
// (`WIRED_SHELL_EXTENSION_SLOTS`), and its own note requires the first adopter to
// wire the render site in ModuleShell IN THE SAME DIFF. This face already
// carries a platform precursor (the meta registry's `face?` / `controlFamilies?`
// fields); loading the third extension slot onto it as well would make one PR
// responsible for both the meta-domain seam and a new render site. `fullViewBody`
// does the job with no platform change at all.
//
// Recorded because "the slot for this exact thing exists and does not render" is
// worth knowing before somebody wires it speculatively for a module that did not
// need it.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface — which is also what keeps the near-global `patch.edges` scan
// OUT of the lane. Only the two axis cells are always-mounted, and their roster
// is memoised on a node-set signature for exactly that reason
// (matrixmix-cell-actions.ts).

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MatrixMixGridBody from './MatrixMixGridBody.svelte';

export default {
  fullViewBody: MatrixMixGridBody,
} satisfies ShellExtension;
