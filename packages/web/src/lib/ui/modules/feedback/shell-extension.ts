// packages/web/src/lib/ui/modules/feedback/shell-extension.ts
//
// The FEEDBACK SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `feedbackDef.face.extension: 'feedback'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a feedback component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE SCREEN SWITCH IS A PORT HERE, NOT AN ADDITION. `FeedbackCard.svelte`
// already draws a live output preview at the top of the card — but it has NO
// toggle for it, so promotion would have handed the player a picture they could
// not collapse. The switch is new; the picture is not.
//
// ⚠ WHY THIS SLOT AT ALL (#1928): promotion stops BOTH surfaces rendering the
// legacy card, so a faced video module has NO route to a SCREEN ON/OFF switch
// except here. A toggle left on the card is deleted by the very promotion that
// was supposed to keep it.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import FeedbackOutputBody from './FeedbackOutputBody.svelte';

export default {
  fullViewBody: FeedbackOutputBody,
} satisfies ShellExtension;
