// packages/web/src/lib/ui/modules/lushgarden/shell-extension.ts
//
// The LUSH GARDEN SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `lushgardenDef.face.extension: 'lushgarden'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a lushgarden component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE SCREEN SWITCH IS A PORT HERE, NOT AN ADDITION. `LushGardenCard.svelte`
// already draws the CLEAN output as a live preview — but it has NO toggle for
// it, so promotion would have handed the player a picture they could not
// collapse. The switch is new; the picture is not.
//
// ⚠ WHY THIS SLOT AT ALL (#1928): promotion stops BOTH surfaces rendering the
// legacy card, so a faced video module has NO route to a SCREEN ON/OFF switch
// except here. A toggle left on the card is deleted by the very promotion that
// was supposed to keep it.
//
// ⚠ THE BODY MUST STAY 2D. `LushGardenCard.svelte` is correctly ABSENT from the
// WebGL attest basis because it uses a 2D context, and this body must stay that
// way for the same reason: a WebGL context here pulls the file into the basis
// through the whole-directory sweep, and every future edit to it would then cost
// a real GPU re-attest. It blits the engine's already-rendered canvas; it never
// creates a GL context of its own.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import LushGardenScreenBody from './LushGardenScreenBody.svelte';

export default {
  fullViewBody: LushGardenScreenBody,
} satisfies ShellExtension;
