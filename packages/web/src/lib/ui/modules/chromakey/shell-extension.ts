// packages/web/src/lib/ui/modules/chromakey/shell-extension.ts
//
// The CHROMAKEY SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `chromakeyDef.face.extension: 'chromakey'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a chromakey component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE SCREEN SWITCH IS AN ADDITION HERE, NOT A PORT. `ChromakeyCard.svelte`
// draws NO preview — a key-colour swatch and three faders — so this face GAINS
// the picture and the control that governs it. Nothing is lost by promotion.
//
// ⚠ DO NOT CONFUSE THIS DIRECTORY WITH `../chroma`. They are different modules
// with adjacent names and a shared history: `chroma` is the single-input COLOUR
// GRADE, `chromakey` is this two-input COMPOSITOR, and chroma.ts carries a
// header about earlier versions conflating exactly these two roles.
//
// ⚠ WHY THIS SLOT AT ALL (#1928): promotion stops BOTH surfaces rendering the
// legacy card, so a faced video module has NO route to a SCREEN ON/OFF switch
// except here. A toggle left on the card is deleted by the very promotion that
// was supposed to keep it.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ChromakeyOutputBody from './ChromakeyOutputBody.svelte';

export default {
  fullViewBody: ChromakeyOutputBody,
} satisfies ShellExtension;
