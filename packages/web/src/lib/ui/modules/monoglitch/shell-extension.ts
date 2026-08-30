// packages/web/src/lib/ui/modules/monoglitch/shell-extension.ts
//
// The MONOGLITCH SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines`, `b3ntb0x`, `4plexvid`, `grainsOfVision`,
// `warrensvisions`, `bentbox` and `ruttetra` on the `fullViewBody` slot.
//
// `monoglitchDef.face.extension: 'monoglitch'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a monoglitch component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #2009): promotion is what stops BOTH surfaces rendering
// `MonoglitchCard.svelte`, and that card is the sole home of the live picture,
// the hide-controls MONITOR toggle and the corner resize. The def's own `docs`
// describe the monitor to the player in the player's words, so promoting
// without this file would have left the shipped documentation describing a
// control that no longer exists — and every def-reading gate would have stayed
// green, because they all read the same def that tells the lie.
//
// ⚠ SECOND ADOPTER OF MONITOR MODE, NOT ITS AUTHOR. `ruttetra` proved the seam
// (#2053) and this is the first of the four remaining `hideControls` cards to
// inherit it. Everything here is deliberately the SAME SHAPE as
// `ruttetra/RuttetraOutputBody.svelte` — the same keys, the same overlay
// geometry, the same watch-mark handling. A second spelling of `previewCollapsed`
// or of the corner drag is exactly how these fork.
//
// Dock-only, enforced by `dockFullViewHeadPlan`, because a 192 px lane tile
// cannot carry a module surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MonoglitchOutputBody from './MonoglitchOutputBody.svelte';

export default {
  fullViewBody: MonoglitchOutputBody,
} satisfies ShellExtension;
