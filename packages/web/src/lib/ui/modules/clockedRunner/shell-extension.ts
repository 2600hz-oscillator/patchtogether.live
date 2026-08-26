// packages/web/src/lib/ui/modules/clockedRunner/shell-extension.ts
//
// The CLOCKED RUNNER shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `clockedRunnerDef.face!.extension: 'clockedRunner'` declares this file; the id
// IS this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from here,
// which is what keeps `module-shell-import-guard` green.
//
// ── WHY A BODY, WHEN THE DIVISION IS A CELL ─────────────────────────────────
//
// This module has exactly two affordances and they land on opposite sides of
// the cell/slot line, for a reason that is mechanical rather than aesthetic:
//
//   * THE DIVISION → RANKED, not here. It is the `selector` cell in the band
//     below, which is what puts it on the LANE TILE. See
//     `$lib/ui/modules/clocked-runner-cell-actions.ts` for why a `node.data`
//     roster rather than a `ParamDef`.
//   * THE CALLBACK BODY → HERE. `resolveFaceControl` resolves a face key to a
//     PARAM id, a `-{n}` family TEMPLATE or a legend STATIC, and a text document
//     is none of the three — there is no cell kind whose value is a buffer.
//     electraControl hit the identical wall with thirty-six in-place rename
//     fields and landed on this slot for the identical reason. A `fullViewBody`
//     needs no probe because it is a SLOT rather than a cell.
//
// ⚠ `editorSurface` IS NOT THE SLOT FOR THIS, despite the name. It is DECLARED
// and UNWIRED — `WIRED_SHELL_EXTENSION_SLOTS` is `['glyph', 'fullViewBody']`,
// and `shell-extensions.test.ts` REFUSES an extension exporting `editorSurface`
// precisely so a slot can never silently no-op. Wiring it would mean adding a
// render site to ModuleShell in the same diff, which is a platform change a
// promotion has no business making.
//
// ⚠ THIS MODULE NEEDS NO CARD-STATUS REGISTRY, and the reason is the strongest
// version of it in the roster. `cameraInput` had to build one because promotion
// parks its real card in `<HeadlessSourceHost>`. `clockedRunner` is in NEITHER
// half of `HEADLESS_MOUNT_LANE_TYPES` (`DOM_SOURCE_LANE_TYPES` union
// `CARD_PRODUCER_LANE_TYPES`) and does not need to be: its tick loop is
// `clock.subscribe(tick)` inside the FACTORY closure
// ($lib/audio/modules/clocked-runner), so it is materialised from the GRAPH by
// the reconciler and evaluates its body on every division boundary with no card,
// no faceplate and no lane tile mounted anywhere. The card only ever POLLED it.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a code
// buffer. The lane keeps the DIVISION, which is the half that means anything
// there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ClockedRunnerEditorBody from './ClockedRunnerEditorBody.svelte';

export default {
  fullViewBody: ClockedRunnerEditorBody,
} satisfies ShellExtension;
