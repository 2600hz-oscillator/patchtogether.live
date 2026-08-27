// packages/web/src/lib/ui/modules/frogger/shell-extension.ts
//
// The FROGGER shell extension — the module-owned end of the extension seam
// (#1512), and an adopter of the `fullViewBody` slot alongside `backdraft`,
// `videoOut`, `spirographs`, `cameraInput` and `rasterize`.
//
// `froggerDef.face.extension: 'frogger'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a frogger component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY THIS MODULE NEEDS THE SLOT: THE BOARD IS THE MODULE, AND THE BOARD WAS
// ON THE CARD. `drawFrogger` is a pure exported function and the LEGACY CARD
// called it every rAF from `eng.read(node, 'snapshot')`. Nothing engine-side
// depends on that call — the game runs on the shared scheduler clock inside the
// factory, so it keeps playing and keeps pulsing `dead_gate` with no UI mounted
// at all — but the PICTURE lives only wherever something paints it. frogger is
// not in `NON_SHELL_LANE_TYPES`, not a `CARD_PRODUCER` and not in
// `HEADLESS_MOUNT_LANE_TYPES`, so under the shipping shell its lane tile is a
// bare `ModuleShellPlaceholder` and the card is not mounted. Promotion without
// this slot would therefore replace a live arcade board with one knob.
//
// ⚠ `rasterize` IS THE PRECEDENT THAT MATTERS, not the video adopters: it is an
// AUDIO-domain module with a JS-painted picture and a `fullViewBody`, which is
// frogger's exact shape. `hasVideoSurface(def)` is `def.domain === 'video'`, so
// there is no generic route to this picture and no `VideoTileThumb`.
//
// ONE slot: `fullViewBody` — the live board plus its SCREEN switch, rendered at
// the head of the DOCK full view. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface. ⚠ That means the
// LANE tile still has no board: `ShellExtensionGlyphProps` is
// `{ num, numbers?, testid? }` with no `nodeId`, so a glyph component cannot
// resolve a graph node and cannot reach the snapshot. Stated rather than left
// implicit — a rack of froggers is a rack of one-knob tiles, which is what
// ships today and is not a regression, but it is not the fix either.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import FroggerBoardBody from './FroggerBoardBody.svelte';

export default {
  fullViewBody: FroggerBoardBody,
} satisfies ShellExtension;
