// packages/web/src/lib/ui/modules/edges/shell-extension.ts
//
// The EDGES SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `edgesDef.face.extension: 'edges'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a edges component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion is what stops BOTH surfaces rendering the module's
// legacy card, so a faced video module has NO route to a SCREEN ON/OFF switch
// except this slot. Unlike `reshaper`/`ruttetra` there is no MONITOR mode and
// no corner resize to carry across — this module's card is a flat knob card
// with no preview canvas at all, so the switch is an ADDITION rather than a
// port, and `video-face-screen-source.test.ts` is what requires it.
//
// EDGES is a stateless outline filter: `out` is `mono-video`, and its
// natural downstream is COLORIZER, which is in this same batch. The body
// keeps the watch mark alive while the screen is off so that chain does not
// stall — see the #2015 paragraph in the component.
//
// Dock-only, enforced by `dockFullViewHeadPlan`, because a 192 px lane tile
// cannot carry a module surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import EdgesOutputBody from './EdgesOutputBody.svelte';

export default {
  fullViewBody: EdgesOutputBody,
} satisfies ShellExtension;
