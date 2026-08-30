// packages/web/src/lib/ui/modules/chroma/shell-extension.ts
//
// The CHROMA SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `chromaDef.face.extension: 'chroma'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a chroma component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE SCREEN SWITCH IS AN ADDITION HERE, NOT A PORT. `ChromaCard.svelte`
// draws NO preview at all — it is a colour swatch plus three faders — so this
// face GAINS a picture from `hasVideoSurface` and therefore gains the control
// that governs it. Nothing is lost by promotion; recorded so the next reader
// does not "restore parity" by deleting it.
//
// ⚠ WHY THIS SLOT AT ALL (#1928): promotion stops BOTH surfaces rendering the
// legacy card, so a faced video module has NO route to a SCREEN ON/OFF switch
// except here. A toggle left on the card is deleted by the very promotion that
// was supposed to keep it.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ChromaOutputBody from './ChromaOutputBody.svelte';

export default {
  fullViewBody: ChromaOutputBody,
} satisfies ShellExtension;
