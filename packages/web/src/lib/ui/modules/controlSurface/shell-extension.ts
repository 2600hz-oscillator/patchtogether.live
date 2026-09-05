// packages/web/src/lib/ui/modules/controlSurface/shell-extension.ts
//
// The CONTROL SURFACE shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` AND `tileBody` slots.
//
// `controlSurfaceDef.face!.extension: 'controlSurface'` declares this file; the
// id IS this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ── WHY A BODY, WHEN THE LOCK IS A CELL ────────────────────────────────────
//
// electraControl's addressability argument, verbatim: this module's surface is
// PROXIES OF OTHER MODULES' PARAMS, and a face key resolves to exactly three
// things — a param id on THIS def (`params: []` by construction), a
// `<familyId>-{n}` family TEMPLATE (ONE cell, no per-member index, #1509), or
// a legend static from a committed legend JSON this module does not have. A
// dynamic roster of proxies and their rename fields cannot be cells at any
// rank. Inside a body they are ordinary markup, which is what the legacy card
// always had. The LOCK — the module's one own control, `node.data.locked` —
// is the ranked `ShellToggleCell`, which is what puts it on the lane tile.
//
// ── WHY NOT A PF-14 `panel` CELL ───────────────────────────────────────────
//
// The electraControl arithmetic, and it lands harder here: `ShellPanelCell.
// minWidth` is a required NUMBER and this board's width is a FUNCTION of how
// many sources are bound (360–760 px on the card) — any number would be a
// fiction in a required field; and the required probe speaks
// `data`/`data-rev`/`text` while this surface's observable is a param on a
// DIFFERENT NODE. `fullViewBody` requires neither.
//
// ── WHY A `tileBody` TOO, AND WHY THE PRUNE LIVES THERE ────────────────────
//
// Two reasons, one visible and one structural:
//   1. the lane strip — a shell extension GLYPH carries no nodeId, so only a
//      tileBody can give the tile a per-node glance ("what is bound here");
//   2. `pruneSurfaceDangling` had exactly ONE production caller — the legacy
//      card's `$effect` — and controlSurface is in neither half of
//      `HEADLESS_MOUNT_LANE_TYPES`, so promotion would silently stop it with
//      every registry test green. The tile is the surface mounted whenever the
//      node is on canvas; the dock body exists only while the full view is
//      open. The effect therefore rides the tile.
//
// ⚠ THE USER-DOCKED RESIDUAL THIS NOTE RECORDED IS CLOSED (owner P0,
// 2026-09-03). It read: "`dockRailRendersFace` requires `pinned`, and
// controlSurface is not in the pin trio, so a user-docked node's dock-rail
// occupant stays the verbatim legacy card (which carries its own prune effect
// and its own lock button)". That residual is the defect the owner reported on
// cameraInput: a docked promoted module painting its pre-promotion card. The
// `pinned` term is gone, so the rail occupant is the face — and the reason no
// surface is prune-less is now this file's `tileBody`, on every surface, rather
// than a card that only some surfaces mounted.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ControlSurfaceBoardBody from './ControlSurfaceBoardBody.svelte';
import ControlSurfaceTileBody from './ControlSurfaceTileBody.svelte';

export default {
  fullViewBody: ControlSurfaceBoardBody,
  // The LANE TILE's counterpart: the live source-colour strip, the empty-state
  // discovery prompt, and the dangling-binding prune on node-on-canvas
  // lifetime.
  tileBody: ControlSurfaceTileBody,
} satisfies ShellExtension;
