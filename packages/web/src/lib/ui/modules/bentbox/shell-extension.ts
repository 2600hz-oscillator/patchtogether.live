// packages/web/src/lib/ui/modules/bentbox/shell-extension.ts
//
// The BENTBOX SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines`, `b3ntb0x`, `4plexvid`, `grainsOfVision` and
// `warrensvisions` on the `fullViewBody` slot.
//
// `bentboxDef.face.extension: 'bentbox'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a bentbox component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #1935): promotion is what stops BOTH surfaces from rendering
// `BentboxCard.svelte`, and that card is the sole home of FIVE affordances —
// the live CRT picture, fullscreen, in-app full-frame, present-on-a-second-
// display, and the resize handle. On a module whose entire output is a
// SCREEN, promoting without this file would delete the screen and every way of
// enlarging it, while every def-reading gate stayed green.
//
// ONE slot: `fullViewBody`. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface; the lane keeps the
// generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import BentboxOutputBody from './BentboxOutputBody.svelte';

export default {
  fullViewBody: BentboxOutputBody,
} satisfies ShellExtension;
