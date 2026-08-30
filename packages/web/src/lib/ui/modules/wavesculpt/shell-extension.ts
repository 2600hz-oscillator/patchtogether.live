// packages/web/src/lib/ui/modules/wavesculpt/shell-extension.ts
//
// The wavesculpt SHELL EXTENSION — the module-owned end of the extension seam.
//
// `wavesculptDef.face.extension: 'wavesculpt'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a wavesculpt component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY THIS MODULE NEEDS THE SLOT, and it is the strongest case in the fleet.
// `hasVideoSurface(def)` is literally `def.domain === 'video'`; wavesculpt is
// `domain: 'audio'` with a `mono-video` OUT, so the shell has NO generic route
// to its picture — the `rasterize` situation. But wavesculpt goes further: its
// picture is a WebGL2 scene the module renders itself, and with no drawer
// installed its own `drawFrame` fills the canvas SOLID BLACK. Promoting it
// without this slot would replace a live 3-D render with a wall of knobs on the
// one module whose entire identity is that render.
//
// ONE slot: `fullViewBody` — the renderer, the camera pad that flies it, and
// the SCREEN / MONITOR switches, rendered at the head of the DOCK full view.
// Dock-only, enforced by `dockFullViewHeadPlan`, because a 192 px lane tile
// cannot carry a module surface (which is also why `face.glyph` is 'none' and
// why the camera pad costs no lane rank).

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import WavesculptOutputBody from './WavesculptOutputBody.svelte';

export default {
  fullViewBody: WavesculptOutputBody,
} satisfies ShellExtension;
