// packages/web/src/lib/ui/modules/skifree/shell-extension.ts
//
// The SKIFREE SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on BOTH wired body slots.
//
// `skifreeDef.face!.extension: 'skifree'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a skifree component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ BOTH SLOTS, AND NEITHER IS OPTIONAL. skifree declares `params: []`, so the
// generic face has nothing to rank at any tier, and `glyph: 'none'` is forced
// (no `type: 'audio'` output for a live glyph binding, and `hasVideoSurface` is
// `domain === 'video'` while this is an audio def carrying a video PORT). The
// shell therefore has NOTHING of its own to paint for this module on either
// surface:
//
//   * without `fullViewBody` the dock full view is a jack field — and since the
//     mouse is skifree's only direct-manipulation instrument, the module would
//     have no controls anywhere;
//   * without `tileBody` the lane tile is a title bar and four jacks, which on
//     a game you WATCH is worse than the placeholder promotion replaces.
//
// ⚠ THE TWO ARE COUNTERPARTS, NEVER SIBLINGS — ModuleShell gates the tile slot
// on `!extBody`, so exactly one of them paints per shell instance. But a lane
// tile and an open dock pane for the SAME node are two instances mounted at
// once, which is why the tile is READ-ONLY (two steering surfaces would fight
// over one cursor) and why the two bodies namespace their testids
// (`skifree-face-*` / `skifree-tile-*`) rather than sharing them.
//
// ⚠ WHAT NEITHER BODY MAY DO: adopt the node-owned game canvas. `skifree.ts`
// mints it DETACHED in the factory and the bundle draws into it for the node's
// whole lifetime; a DOM node has one parent, so adopting it here would hand the
// game's surface to a component that unmounts on a dock collapse or an LRU
// eviction — the cameraInput trap, one seam over. Both bodies BLIT.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import SkifreeSlopeBody from './SkifreeSlopeBody.svelte';
import SkifreeTileBody from './SkifreeTileBody.svelte';

export default {
  fullViewBody: SkifreeSlopeBody,
  // The LANE TILE's counterpart: the same picture, smaller and read-only. The
  // tile is where a player normally meets this module, and until now it could
  // do nothing there but show a placeholder.
  tileBody: SkifreeTileBody,
} satisfies ShellExtension;
