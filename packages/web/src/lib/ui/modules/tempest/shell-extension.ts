// packages/web/src/lib/ui/modules/tempest/shell-extension.ts
//
// The TEMPEST SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `tempestDef.face.extension: 'tempest'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a tempest component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion stops BOTH surfaces rendering `TempestCard.svelte`, so a
// faced video module has NO route to a SCREEN ON/OFF switch except this slot.
// There is no MONITOR mode and no corner resize to carry across — this card
// mounts no `hideControls` — so the switch is an ADDITION rather than a port,
// required by `video-face-screen-source.test.ts`.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import TempestOutputBody from './TempestOutputBody.svelte';

export default {
  fullViewBody: TempestOutputBody,
} satisfies ShellExtension;
