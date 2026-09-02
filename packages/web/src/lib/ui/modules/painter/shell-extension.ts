// packages/web/src/lib/ui/modules/painter/shell-extension.ts
//
// The PAINTER shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `painterDef.face!.extension: 'painter'` declares this file: the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a browser component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS THE MODULE, NOT AN ADDITION TO IT. painter declares
// `params: []` and `inputs: []` — there is nothing to rank and no cell to
// render — so `face.order` is empty and the faceplate has no bands. Everything
// painter IS lives here: the nine tools, the 28-colour palette, SIZE, FILL, the
// text stamp, UNDO/CLEAR and the drawing canvas whose pixels ARE the video
// output. Promotion stops both surfaces rendering `PainterCard.svelte`, so
// without this body a promoted painter could not be drawn on at all.
//
// ⚠ AND "THE CARD STILL HAS IT" IS NOT AN ANSWER. painter is in none of
// `DOM_SOURCE_LANE_TYPES`, `CARD_PRODUCER_LANE_TYPES` or
// `HEADLESS_MOUNT_LANE_TYPES`: under the shipping shell no card is mounted
// anywhere once the module is migrated. (What DOES survive with no surface
// mounted is the PICTURE — `$lib/ui/media/extras-producers` replays the op log
// onto a node-owned canvas on node lifetime, #1720 — but a picture is not an
// editor.)
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile is not a
// surface anyone can paint on, and expanding a module to work on it is the
// ordinary dock gesture. The lane tile gets the module's own picture for free
// from `hasVideoSurface(def)`, which is `domain === 'video'` and nothing else —
// a live thumbnail of the actual drawing, white page and all.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PainterEditorBody from './PainterEditorBody.svelte';

export default {
  fullViewBody: PainterEditorBody,
} satisfies ShellExtension;
