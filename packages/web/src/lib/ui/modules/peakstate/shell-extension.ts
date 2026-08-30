// packages/web/src/lib/ui/modules/peakstate/shell-extension.ts
//
// The PEAKSTATE SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `peakstateDef.face.extension: 'peakstate'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a peakstate component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928), and on this module it is the ORIGINAL form of the defect
// rather than the ruling's follow-on: `PeakstateCard.svelte` already draws a
// 144x144 mandala preview, and promotion is precisely what stops that card
// rendering. Without this slot the promotion would DELETE a picture the module
// has always had — on a module whose entire output is a picture. The SCREEN
// switch rides with it because the 2026-08-18 ruling requires one of every
// video face. No MONITOR mode to carry across; this card mounts no
// `hideControls`.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PeakstateOutputBody from './PeakstateOutputBody.svelte';

export default {
  fullViewBody: PeakstateOutputBody,
} satisfies ShellExtension;
