// packages/web/src/lib/ui/modules/timelorde/shell-extension.ts
//
// The timelorde SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), and an adopter of the `fullViewBody` slot alongside `rasterize`,
// `pong`, `backdraft` and friends.
//
// `timelordeDef.face.extension: 'timelorde'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a timelorde component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY THIS MODULE NEEDS THE SLOT, and it is the RASTERIZE reason rather than
// the backdraft one. The three original adopters are VIDEO-domain modules whose
// picture the shell can already draw generically (`VideoTileThumb`, gated on
// `hasVideoSurface`); they reach for `fullViewBody` to add a SCREEN switch.
// timelorde is `domain: 'audio'` with a `video` OUT, and `hasVideoSurface` is
// literally `def.domain === 'video'` — the case that predicate's own doc-comment
// names. So there is no generic route to this module's picture at all, and
// promoting it without this slot would replace the owl display with six knobs.
//
// ⚠ AND THE PICTURE IS NOT RE-IMPLEMENTED HERE. The body BLITS `video_out`'s own
// `drawFrame` — the same picture every downstream video module sees — so the owl
// render, the beat boost, the reduced-motion freeze and the live `video_in`
// monitor all keep exactly ONE implementation (`TimelordeCard`, kept alive
// off-screen by `<HeadlessSourceHost>`). A second renderer here would be a second
// place for the display to be wrong.
//
// ONE slot: `fullViewBody` — the display plus its SCREEN switch, rendered at the
// head of the DOCK full view. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import TimelordeDisplayBody from './TimelordeDisplayBody.svelte';

export default {
  fullViewBody: TimelordeDisplayBody,
} satisfies ShellExtension;
