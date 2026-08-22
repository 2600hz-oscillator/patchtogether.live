// packages/web/src/lib/ui/modules/acidwarp/shell-extension.ts
//
// The ACIDWARP SHELL EXTENSION — the module-owned end of the extension seam
// (#1512).
//
// `acidwarpDef.face.extension: 'acidwarp'` declares this file; the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports an acidwarp component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion is what stops BOTH surfaces from rendering
// `AcidwarpCard.svelte`, and that card owns the module's ONLY picture. This is
// a module that IS a display — a pure-GPU plasma SOURCE with no input, whose
// entire product is the frame it synthesizes — so promoting without this file
// would delete the point of it while every def-reading gate stayed green.
// `video-face-screen-source.test.ts` refuses that shape by name.
//
// ONE slot: `fullViewBody`. Dock-only by `dockFullViewHeadPlan`, because a
// 192 px lane tile cannot carry a module surface; the lane keeps the generic
// `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import AcidwarpScreenBody from './AcidwarpScreenBody.svelte';

export default {
  fullViewBody: AcidwarpScreenBody,
} satisfies ShellExtension;
