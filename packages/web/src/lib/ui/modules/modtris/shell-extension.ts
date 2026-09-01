// packages/web/src/lib/ui/modules/modtris/shell-extension.ts
//
// The MODTRIS shell extension — the module-owned end of the extension seam
// (#1512), and an adopter of the `fullViewBody` slot alongside `frogger`,
// `backdraft`, `videoOut`, `spirographs`, `cameraInput` and `rasterize`.
//
// `modtrisDef.face.extension: 'modtris'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a modtris component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY THIS MODULE NEEDS THE SLOT: THE WELL IS THE MODULE, AND THE WELL WAS ON
// THE CARD. `drawModtris` is a pure exported function and the LEGACY CARD
// called it every rAF from `eng.read(node, 'snapshot')`. Nothing engine-side
// depends on that call — the game runs on the shared scheduler clock inside the
// factory, so it keeps playing and keeps pulsing `line_cleared` with no UI
// mounted at all — but the PICTURE lives only wherever something paints it.
// modtris is not in `NON_SHELL_LANE_TYPES`, not a `CARD_PRODUCER` and not in
// `HEADLESS_MOUNT_LANE_TYPES`, so under the shipping shell its lane tile is a
// bare `ModuleShellPlaceholder` and the card is not mounted. Promotion without
// this slot would replace a live well with two faders.
//
// ⚠ A PF-14 `panel` CELL CANNOT REACH IT. A panel's first legal rank is 7 and
// modtris declares two params, so `fullViewBody` is the only route — and it is
// the right one, because the well is not a control, it is the module's
// identity.
//
// ⚠ `rasterize` / `frogger` ARE THE PRECEDENTS THAT MATTER, not the video
// adopters: both are AUDIO-domain modules with a JS-painted picture and a
// `fullViewBody`, which is modtris's exact shape. `hasVideoSurface(def)` is
// `def.domain === 'video'`, so there is no generic route to this picture and no
// `VideoTileThumb`.
//
// ONE slot: `fullViewBody` — the live well plus its SCREEN switch, rendered at
// the head of the DOCK full view. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface. ⚠ That means the
// LANE tile still has no well: `ShellExtensionGlyphProps` is
// `{ num, numbers?, testid? }` with no `nodeId`, so a glyph component cannot
// resolve a graph node and cannot reach the snapshot. Stated rather than left
// implicit — a rack of modtrises is a rack of two-fader tiles, which is what
// ships today and is not a regression, but it is not the fix either.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ModtrisWellBody from './ModtrisWellBody.svelte';

export default {
  fullViewBody: ModtrisWellBody,
} satisfies ShellExtension;
