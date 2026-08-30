// packages/web/src/lib/ui/modules/scoreboard/shell-extension.ts
//
// The SCOREBOARD SHELL EXTENSION — the module-owned end of the extension seam
// (#1512).
//
// `scoreboardDef.face.extension: 'scoreboard'` declares this file; the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a scoreboard component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion is what stops BOTH surfaces rendering
// `ScoreboardCard.svelte`, and that card owns the only view of the counter.
// This module's entire product is a number on a screen — two gates in, four
// digits out — so a faceplate without the display is a colour wheel attached
// to nothing observable. `video-face-screen-source.test.ts` refuses that shape
// by name.
//
// ONE slot: `fullViewBody`. Dock-only by `dockFullViewHeadPlan`, because a
// 192 px lane tile cannot carry a module surface; the lane keeps the generic
// `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ScoreboardScreenBody from './ScoreboardScreenBody.svelte';

export default {
  fullViewBody: ScoreboardScreenBody,
} satisfies ShellExtension;
