// packages/web/src/lib/ui/modules/b3ntb0x/shell-extension.ts
//
// The b3ntb0x SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), and the sixth adopter of the `fullViewBody` slot alongside
// `backdraft`, `videoOut`, `spirographs`, `mirrorpool` and `freezeframe`.
//
// `b3ntb0xDef.face.extension: 'b3ntb0x'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a b3ntb0x component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #1896): promotion is what stops BOTH surfaces from rendering
// `B3ntb0xCard.svelte`, and that card is the only home of five things that are
// not `ParamDef`s — the SCREEN switch the 2026-08-18 owner ruling requires, the
// fullscreen / full-frame / present menu, the render lease, the resize handle
// writing `data.width`/`data.height`, and `data.fullFrame`. Promoting without
// this file would delete all five at once while every def-reading gate stayed
// green. `video-face-screen-source.test.ts` refuses that shape for the SCREEN
// switch by name; the other four are held by this module's own e2e.
//
// ONE slot: `fullViewBody`. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface; the lane keeps the
// generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import B3ntb0xOutputBody from './B3ntb0xOutputBody.svelte';

export default {
  fullViewBody: B3ntb0xOutputBody,
} satisfies ShellExtension;
