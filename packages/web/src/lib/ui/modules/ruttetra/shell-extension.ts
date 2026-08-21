// packages/web/src/lib/ui/modules/ruttetra/shell-extension.ts
//
// The RUTTETRA SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines`, `b3ntb0x`, `4plexvid`, `grainsOfVision`,
// `warrensvisions` and `bentbox` on the `fullViewBody` slot.
//
// `ruttetraDef.face.extension: 'ruttetra'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a ruttetra component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #2009): promotion is what stops BOTH surfaces rendering
// `RuttetraCard.svelte`, and that card is the sole home of the live picture,
// the SCREEN switch, the hide-controls MONITOR toggle and the corner resize.
// Three of those four are affordances the def's own `docs` describe to the
// player in the player's words, so promoting without this file would have left
// the shipped documentation describing controls that no longer exist — and
// every def-reading gate would have stayed green, because they all read the
// same def that tells the lie.
//
// ⚠ ONE SLOT, AND `editorSurface` IS DELIBERATELY NOT IT. #2009 nominated
// `editorSurface` as the home for `hideControls`. It is not: that slot is
// specced for "controls that are not cell-shaped at all" (a clip arranger, a
// pad matrix) and is a STATIC structural choice, while ruttetra's twelve params
// are ordinary scalars and monitor mode is a TOGGLE over the bands they render
// into. Adopting it here would have made ruttetra a fake first adopter of a
// slot it does not need and left the real blocker standing. The suppression is
// the SHELL's (`faceMonitorPlan`); this file owns the button that drives it.
//
// Dock-only, enforced by `dockFullViewHeadPlan`, because a 192 px lane tile
// cannot carry a module surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import RuttetraOutputBody from './RuttetraOutputBody.svelte';

export default {
  fullViewBody: RuttetraOutputBody,
} satisfies ShellExtension;
