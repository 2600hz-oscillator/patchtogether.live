// packages/web/src/lib/ui/modules/freezeframe/shell-extension.ts
//
// The freezeframe SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), and an adopter of the `fullViewBody` slot alongside `backdraft`,
// `videoOut`, `spirographs` and `mirrorpool`.
//
// `freezeframeDef.face.extension: 'freezeframe'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a freezeframe component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY (#1934 / #1928): this module's SCREEN toggle shipped on its CARD in the
// same change that promoted it into STRICT_FACES — and promotion is what stops
// both surfaces from rendering that card, so the required control was deleted
// by the promotion meant to keep it. There is no generic shell affordance to
// fall back on (`previewCollapsed` appears in zero shell files), and the spec
// proving the toggle worked was pinned to `?shell=legacy`, the one surface
// promotion does not change — so it could not have caught it.
//
// ONE slot: `fullViewBody` — the live picture plus the SCREEN switch, rendered
// at the head of the DOCK full view. Dock-only, enforced by
// `dockFullViewHeadPlan`, because a 192 px lane tile cannot carry a module
// surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import FreezeframeOutputBody from './FreezeframeOutputBody.svelte';

export default {
  fullViewBody: FreezeframeOutputBody,
} satisfies ShellExtension;
