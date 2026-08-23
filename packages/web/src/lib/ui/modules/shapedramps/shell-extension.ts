// packages/web/src/lib/ui/modules/shapedramps/shell-extension.ts
//
// The SHAPEDRAMPS SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `shapedrampsDef.face.extension: 'shapedramps'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a shapedramps component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 class): promotion stops BOTH surfaces rendering the legacy card,
// so a faced video module has NO route to a SCREEN ON/OFF switch except this
// slot. `video-face-screen-source.test.ts` requires one of every promoted video
// face.
//
// ⚠ AND HERE IT IS AN ADDITION, NOT A PORT. `ShapedrampsCard.svelte` mounts no
// canvas at all — `vrt-exemptions.ts` records it as one of the "confirmed 0
// canvases each" cards — so there is no `hideControls`, no MONITOR mode and no
// corner resize to carry across. This is the FIRST picture this module has ever
// had on its own surface, which makes the role declared here the first
// statement on record about what that surface shows.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ShapedrampsOutputBody from './ShapedrampsOutputBody.svelte';

export default {
  fullViewBody: ShapedrampsOutputBody,
} satisfies ShellExtension;
