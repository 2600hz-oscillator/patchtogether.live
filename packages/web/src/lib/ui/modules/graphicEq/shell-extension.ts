// packages/web/src/lib/ui/modules/graphicEq/shell-extension.ts
//
// The GRAPHIC EQ SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines`, `b3ntb0x`, `4plexvid`, `grainsOfVision`,
// `warrensvisions`, `bentbox`, `ruttetra`, `monoglitch` and `reshaper` on the
// `fullViewBody` slot.
//
// `graphicEqDef.face.extension: 'graphicEq'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a graphicEq component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #2009): promotion is what stops BOTH surfaces rendering
// `GraphicEqCard.svelte`, and that card is the sole home of the live meters, the
// hide-controls MONITOR toggle and the corner resize. The def's own `docs` end
// with "hide the controls to use the card as a resizable full-screen monitor",
// so promoting without this file would have left the shipped documentation
// describing a control that no longer exists — and every def-reading gate would
// have stayed green, because they all read the same def that tells the lie.
//
// ⚠ FIFTH AND LAST ADOPTER OF MONITOR MODE, NOT ITS AUTHOR. `ruttetra` proved
// the seam (#2053); `monoglitch` (#2081), `reshaper` (#2086) and `milkdrop`
// inherited it. Everything here is deliberately the SAME SHAPE as those — same
// keys, same overlay geometry, same watch-mark handling. A second spelling of
// `previewCollapsed` or of the corner drag is exactly how these fork.
//
// Dock-only, enforced by `dockFullViewHeadPlan`, because a 192 px lane tile
// cannot carry a module surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import GraphicEqOutputBody from './GraphicEqOutputBody.svelte';

export default {
  fullViewBody: GraphicEqOutputBody,
} satisfies ShellExtension;
