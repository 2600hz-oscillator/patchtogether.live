// packages/web/src/lib/ui/modules/4plexvid/shell-extension.ts
//
// The 4PLEXVID SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines` and `b3ntb0x` on the `fullViewBody` slot.
//
// `fourPlexVidDef.face.extension: '4plexvid'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a 4plexvid component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #1935): promotion is what stops BOTH surfaces from rendering
// `FourPlexVidCard.svelte`, and that card is the only home of the module's live
// OUT 1 preview. Promoting without this file would delete the picture from a
// VIDEO ROUTER — the one module class where seeing which feed you just selected
// is the entire point — while every def-reading gate stayed green.
// `video-face-screen-source.test.ts` refuses that shape by name.
//
// ONE slot: `fullViewBody`. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface; the lane keeps the
// generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import FourPlexVidOutputBody from './FourPlexVidOutputBody.svelte';

export default {
  fullViewBody: FourPlexVidOutputBody,
} satisfies ShellExtension;
