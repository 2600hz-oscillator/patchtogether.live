// packages/web/src/lib/ui/modules/vdelay/shell-extension.ts
//
// The VDELAY SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `vdelayDef.face.extension: 'vdelay'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a vdelay component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion is what stops BOTH surfaces rendering the module's
// legacy card, so a faced video module has NO route to a SCREEN ON/OFF switch
// except this slot. Unlike `reshaper`/`ruttetra` there is no MONITOR mode and
// no corner resize to carry across — this module's card is a flat knob card
// with no preview canvas at all, so the switch is an ADDITION rather than a
// port, and `video-face-screen-source.test.ts` is what requires it.
//
// VDELAY is the ACCUMULATOR case in this batch: a 32-frame ring advanced by
// every draw. Dropping the watch mark while the screen is off would let the
// echo chain decay out of the ring, so the body keeps marking — the one
// module here where SCREEN OFF could have changed the PICTURE, not just
// stalled the output.
//
// Dock-only, enforced by `dockFullViewHeadPlan`, because a 192 px lane tile
// cannot carry a module surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VdelayOutputBody from './VdelayOutputBody.svelte';

export default {
  fullViewBody: VdelayOutputBody,
} satisfies ShellExtension;
