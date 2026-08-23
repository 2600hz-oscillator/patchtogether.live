// packages/web/src/lib/ui/modules/lines/shell-extension.ts
//
// The LINES SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `linesDef.face.extension: 'lines'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a lines component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion stops BOTH surfaces rendering the legacy card, so a
// faced video module has NO route to a SCREEN ON/OFF switch except this slot.
// On this module the switch is an ADDITION rather than a port — `LinesCard.
// svelte` never drew a preview — and the picture is what makes an
// AUTO-SCROLLING source legible: the grating drifts on its own, so the frame is
// the only place the module's liveness is visible at all. There is no MONITOR
// mode to carry across; this card mounts no `hideControls`.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import LinesOutputBody from './LinesOutputBody.svelte';

export default {
  fullViewBody: LinesOutputBody,
} satisfies ShellExtension;
