// packages/web/src/lib/ui/modules/rasterize/shell-extension.ts
//
// The rasterize SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), and an adopter of the `fullViewBody` slot alongside `backdraft`,
// `videoOut` and `spirographs`.
//
// `rasterizeDef.face.extension: 'rasterize'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a rasterize component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY THIS MODULE NEEDS THE SLOT AT ALL, and it is a different reason from
// the three existing adopters. Those are VIDEO-domain modules whose picture the
// shell can already draw generically (`VideoTileThumb`, gated on
// `hasVideoSurface`); they reach for `fullViewBody` to add the SCREEN switch.
// `rasterize` is `domain: 'audio'` with a `mono-video` OUT, and
// `hasVideoSurface` is literally `def.domain === 'video'` — a case that
// predicate's own doc-comment calls out by name. So there is no generic route
// to this module's picture at all, and the picture IS the module: promoting
// rasterize without this slot replaces a live raster with four knobs. The
// committed face-migration inventory says the same thing in its own note —
// "the scan preview is a read-only picture with no glyph kind — it needs a
// registered panel or it is a look loss".
//
// ONE slot: `fullViewBody` — the live raster plus the SCREEN switch, rendered
// at the head of the DOCK full view. Dock-only, enforced by
// `dockFullViewHeadPlan`, because a 192 px lane tile cannot carry a module
// surface.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import RasterizeOutputBody from './RasterizeOutputBody.svelte';

export default {
  fullViewBody: RasterizeOutputBody,
} satisfies ShellExtension;
