// packages/web/src/lib/ui/modules/mappy/shell-extension.ts
//
// The MAPPY shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `mappyDef.face!.extension: 'mappy'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a mapper component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS THE MODULE. MAPPY's two params say how many surfaces are live
// and whether the calibration grid is forced; everything that makes it a
// projection MAPPER is a pointer gesture over a picture — pin a corner, drag a
// quad bodily, focus a surface, flip it between FIT and CROP, reset it, open
// the full-window MAP editor. No `ParamCellKind` mounts a canvas and none can
// express six independent per-surface booleans, so without this body a promoted
// mappy would be a projection mapper you could not aim.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a corner-pin surface. The lane tile gets the module's picture for free from
// `hasVideoSurface(def)`, which is `domain === 'video'` and nothing else.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MappyMapBody from './MappyMapBody.svelte';

export default {
  fullViewBody: MappyMapBody,
} satisfies ShellExtension;
