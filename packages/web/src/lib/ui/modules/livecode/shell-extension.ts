// packages/web/src/lib/ui/modules/livecode/shell-extension.ts
//
// The LIVECODE shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `livecodeDef.face!.extension: 'livecode'` declares this file; the id IS this
// directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from here,
// which is what keeps `module-shell-import-guard` green.
//
// ── ⚠ THIS SLOT IS NOT A NICETY ON THIS MODULE — IT IS THE MODULE ───────────
//
// `livecodeDef.factory` returns a NO-OP handle. No AudioNode, no timer, no
// subscription: unlike its own CLOCKED RUNNER child, whose tick loop lives in
// the factory closure and therefore keeps evaluating with nothing mounted, every
// evaluation LIVECODE has ever performed happened inside `LivecodeCard.svelte`.
// `migrated(type)` stops BOTH surfaces rendering a promoted module's card, so a
// promotion that left the editor and the RUN gesture on the card would not have
// degraded this module — it would have deleted everything it does, while every
// def-reading gate stayed green because the def has nothing to read.
//
// The evaluation therefore moved OUT of any component, into
// `$lib/ui/modules/livecode-cell-actions.ts`, which the ranked RUN cell, this
// body and the legacy card all call. Three callers, one implementation.
//
// ── WHY A BODY, WHEN RUN IS A CELL ──────────────────────────────────────────
//
//   * RUN → RANKED, not here. An `action` cell is not dock-restricted (only
//     `panel` is), so the gesture reaches the LANE TILE — one click from the
//     rack, where before promotion it was behind an expand.
//   * THE SCRIPT BUFFER and THE OUTPUT LOG → HERE. `resolveFaceControl` resolves
//     a face key to a PARAM id, a `-{n}` family TEMPLATE or a legend STATIC, and
//     neither a text document nor a console is any of the three. A `fullViewBody`
//     needs no probe because it is a SLOT rather than a cell.
//
// ⚠ `editorSurface` IS NOT THE SLOT FOR THIS, despite the name. It is DECLARED
// and UNWIRED — `WIRED_SHELL_EXTENSION_SLOTS` is `['glyph', 'fullViewBody']`,
// and `shell-extensions.test.ts` REFUSES an extension exporting `editorSurface`
// precisely so a slot can never silently no-op.
//
// ⚠ THIS MODULE NEEDS NO CARD-STATUS REGISTRY, but it DOES need an editor
// registry, which is the narrower thing and worth not confusing. `cameraInput`
// built a status registry because promotion parks its real card in
// `<HeadlessSourceHost>`, mounted-but-unclickable. `livecode` is in NEITHER half
// of `HEADLESS_MOUNT_LANE_TYPES`, so its card is simply not mounted and there is
// no second owner to coordinate with. What the RUN cell does need is the LIVE
// buffer rather than the debounced-by-250 ms committed one — so the mounted
// editor publishes a flush, node-keyed, in `livecode-cell-actions`.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a code
// buffer. The lane keeps RUN, which is the half that means anything there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import LivecodeEditorBody from './LivecodeEditorBody.svelte';

export default {
  fullViewBody: LivecodeEditorBody,
} satisfies ShellExtension;
