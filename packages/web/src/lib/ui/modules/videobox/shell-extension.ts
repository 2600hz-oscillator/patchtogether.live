// packages/web/src/lib/ui/modules/videobox/shell-extension.ts
//
// The VIDEOBOX shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `videoboxDef.face!.extension: 'videobox'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a player component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS LOAD-BEARING RATHER THAN DECORATIVE. Everything this module
// is FOR — pick a file, re-allow a remembered handle, drop a clip, play, seek —
// is gesture-shaped, and a file picker or a permission re-grant is honoured
// only inside a real user gesture on a mounted surface. videobox left
// `DOM_SOURCE_LANE_TYPES` in LEG-02 P1 (#1511) because its source became
// node-owned, so under the shell there is no card mounted ANYWHERE. Without
// this body a promoted videobox could not load a file at all.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a player surface. The lane tile gets the module's picture for free
// from `hasVideoSurface(def)`, which is `domain === 'video'` and nothing else.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VideoboxScreenBody from './VideoboxScreenBody.svelte';

export default {
  fullViewBody: VideoboxScreenBody,
} satisfies ShellExtension;
