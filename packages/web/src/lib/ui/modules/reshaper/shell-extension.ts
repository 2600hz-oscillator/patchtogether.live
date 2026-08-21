// packages/web/src/lib/ui/modules/reshaper/shell-extension.ts
//
// The RESHAPER SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines`, `b3ntb0x`, `4plexvid`, `grainsOfVision`,
// `warrensvisions`, `bentbox`, `ruttetra` and `monoglitch` on the
// `fullViewBody` slot.
//
// `reshaperDef.face.extension: 'reshaper'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a reshaper component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #2009): promotion is what stops BOTH surfaces rendering
// `ReshaperCard.svelte`, and that card is the sole home of the live picture, the
// hide-controls MONITOR toggle and the corner resize. The def's own `docs`
// describe the monitor to the player in the player's words, so promoting without
// this file would have left the shipped documentation describing a control that
// no longer exists — and every def-reading gate would have stayed green, because
// they all read the same def that tells the lie.
//
// ⚠ THIRD ADOPTER OF MONITOR MODE, NOT ITS AUTHOR. `ruttetra` proved the seam
// (#2053) and `monoglitch` inherited it first (#2081). Everything here is
// deliberately the SAME SHAPE as those two — same keys, same overlay geometry,
// same watch-mark handling. A second spelling of `previewCollapsed` or of the
// corner drag is exactly how these fork.
//
// Dock-only, enforced by `dockFullViewHeadPlan`, because a 192 px lane tile
// cannot carry a module surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ReshaperOutputBody from './ReshaperOutputBody.svelte';

export default {
  fullViewBody: ReshaperOutputBody,
} satisfies ShellExtension;
