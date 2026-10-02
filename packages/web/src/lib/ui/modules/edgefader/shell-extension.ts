// The EDGEFADER SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `edgefaderDef.face.extension: 'edgefader'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports an edgefader component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): a faced video module has NO route to a SCREEN ON/OFF switch
// except this slot, and `video-face-screen-source.test.ts` requires one.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import EdgefaderOutputBody from './EdgefaderOutputBody.svelte';

export default {
  fullViewBody: EdgefaderOutputBody,
} satisfies ShellExtension;
