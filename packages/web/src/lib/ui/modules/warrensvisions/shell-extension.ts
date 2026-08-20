// packages/web/src/lib/ui/modules/warrensvisions/shell-extension.ts
//
// The WARREN'S VISIONS SHELL EXTENSION — the module-owned end of the extension
// seam (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines`, `b3ntb0x` and `4plexvid` on the `fullViewBody`
// slot.
//
// `warrensvisionsDef.face.extension: 'warrensvisions'` declares this file — the
// id IS this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a warrensvisions component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #1935): promotion is what stops BOTH surfaces from rendering
// `WarrensvisionsCard.svelte`, and that card is the only home of the module's
// live preview (`warrensvisions-canvas`). Promoting without this file would
// delete the picture from a module whose ELEVEN CONTROLS ALL DESCRIBE WHAT THE
// PICTURE DOES — the card's own header says so ("this module has an obvious
// hero visual and the whole point of every knob is what it does to that
// picture") — while every def-reading gate stayed green.
// `video-face-screen-source.test.ts` refuses that shape by name.
//
// ONE slot: `fullViewBody`. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface; the lane keeps the
// generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import WarrensvisionsOutputBody from './WarrensvisionsOutputBody.svelte';

export default {
  fullViewBody: WarrensvisionsOutputBody,
} satisfies ShellExtension;
