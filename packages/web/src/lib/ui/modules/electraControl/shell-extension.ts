// packages/web/src/lib/ui/modules/electraControl/shell-extension.ts
//
// The ELECTRA CONTROL shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `electraControlDef.face!.extension: 'electraControl'` declares this file; the
// id IS this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from here,
// which is what keeps `module-shell-import-guard` green.
//
// ── WHY A BODY, WHEN THE FLASH IS A CELL ───────────────────────────────────
//
// This module's surface is thirty-six PROXIES OF OTHER MODULES' PARAMS, and that
// is not a ranking problem — it is an ADDRESSABILITY one. `resolveFaceControl`
// resolves a face key to exactly three things: a param id on THIS def (there are
// none, `params: []` by construction for a meta def), a `<familyId>-{n}` family
// TEMPLATE, or a legend static from a committed `<type>.legend.json` (three such
// files exist in the whole repo and none is this module's). A family template
// renders ONE cell however many members it names — there is no per-member index
// (#1509) — so thirty-six slots cannot be thirty-six cells at any rank, and
// thirty-six per-slot RENAME fields cannot be cells either, however many entry
// cells the platform grows. Inside a body they are ordinary markup, which is
// what the legacy card always had.
//
// The SEND TO ELECTRA gesture is NOT here, deliberately: it is the ranked action
// cell in the band below, which is what puts it on the lane tile. A second
// button on this plate would be one gesture with two affordances.
//
// ── WHY NOT A PF-14 `panel` CELL ───────────────────────────────────────────
//
// The matrixMix arithmetic, and it lands the same way twice:
//
//   1. `ShellPanelCell.minWidth` is a required NUMBER — "the panel's own design
//      floor". This board's floor is not a design choice at all, it is the
//      HARDWARE's: six columns because the Electra One has six pots in a row.
//      That number could honestly be written. But —
//   2. the required `probe` speaks `data` / `data-rev` / `text`, and this
//      surface's observable is a param on a DIFFERENT NODE. Turning a proxy
//      writes `patch.nodes[sourceId].params[paramId]`, never this node's own
//      `data`. So the only expressible probe is a revision counter, and the
//      registry's own warning applies verbatim: "a revision-only probe passes on
//      a DEAD button that bumps the counter without editing anything."
//
// `fullViewBody` requires neither, and it is a SLOT rather than a cell so it
// needs no probe at all.
//
// ── AND NEVER `editorSurface`, EVEN THOUGH THIS IS A MODULE IT NAMES ───────
//
// `shell-extensions.ts` describes `editorSurface` as the slot for "controls that
// are not cell-shaped at all (a clip arranger, A PAD MATRIX)", and a fixed 6×6
// pot matrix is about as close to that as the roster gets. It is still the wrong
// slot: it is DECLARED AND UNWIRED (`WIRED_SHELL_EXTENSION_SLOTS`), and its own
// note requires the first adopter to wire the render site in ModuleShell IN THE
// SAME DIFF. `fullViewBody` is already wired, already gated for the drawer, and
// does the job with no platform change. Recorded because it is the tempting
// wrong turn — matrixMix and push2Control both wrote the same note.
//
// ── THE DRAWER, WHICH IS THE WHOLE POINT ───────────────────────────────────
//
// Every other adopter of this slot is dock-only in practice. This one is not:
// `electraControl` is the `E` of the M/E/C workflow pin trio with `surface:
// 'drawer'`, and its always-on instance is CANVAS-HIDDEN, so the bottom drawer is
// the ONLY surface it has. `dockFullViewHeadPlan` gates `extBody` on
// `isFaceplateView(view)` = `view !== 'lane'`, and says why at the site: "the
// pinned drawer paints the same full faceplate and wants the same head
// precedence (#1739)". So the board reaches the drawer, and promotion is a
// lateral move there rather than a deletion.
//
// Dock/drawer-only by that same gate: a 192 px lane tile cannot carry a surface
// whose narrowest honest width is six 48 px columns plus bank gutters. The lane
// keeps the SEND cell, which is the half that matters there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ElectraGridBody from './ElectraGridBody.svelte';

export default {
  fullViewBody: ElectraGridBody,
} satisfies ShellExtension;
