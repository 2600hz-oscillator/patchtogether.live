// packages/web/src/lib/ui/modules/mandleblot/shell-extension.ts
//
// The MANDLEBLOT SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `mandleblotDef.face.extension: 'mandleblot'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a mandleblot component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE SCREEN SWITCH IS A PORT HERE, NOT AN ADDITION. `MandleblotCard.svelte`
// already draws the live fractal — but with no toggle, so promotion would have
// handed the player the heaviest renderer in this batch and no way to collapse
// it. The switch is new; the picture is not.
//
// ⚠ THE ZOOM READOUT DOES NOT COME WITH IT. That card also paints a derived
// magnification string ("1000x") under its ZOOM knob, and the resting faceplate
// paints no derived-state text. It is deliberately absent here; the finding it
// carried — that knob position is a LOG map onto magnification and the two are
// not linearly related — moved into the def's `docs.controls.zoom` prose and
// survives on the control as `aria-valuetext`.
//
// ⚠ WHY THIS SLOT AT ALL (#1928): promotion stops BOTH surfaces rendering the
// legacy card, so a faced video module has NO route to a SCREEN ON/OFF switch
// except here. A toggle left on the card is deleted by the very promotion that
// was supposed to keep it.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MandleblotOutputBody from './MandleblotOutputBody.svelte';

export default {
  fullViewBody: MandleblotOutputBody,
} satisfies ShellExtension;
