// packages/web/src/lib/ui/modules/vfpgaRunner/shell-extension.ts
//
// The vfpga-runner SHELL EXTENSION — the module-owned end of the extension seam
// (#1512).
//
// `vfpgaRunnerDef.face.extension: 'vfpgaRunner'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a vfpga component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): the 2026-08-18 owner ruling gives every video module a SCREEN
// on/off toggle. Promotion makes `migrated()` true and stops BOTH surfaces from
// rendering `VfpgaRunnerCard.svelte`, so a toggle authored only there is deleted
// by the promotion that was supposed to keep it. There is no generic shell
// affordance to fall back on (`previewCollapsed` appears in zero shell files),
// so the toggle arrives through this slot — and it brings the card's FABRIC
// floorplan view with it, for the same reason and by the same route.
//
// ONE slot: `fullViewBody` — the live picture, the SCREEN switch and the FABRIC
// view, rendered at the head of the DOCK full view. Dock-only, enforced by
// `dockFullViewHeadPlan`, because a 192 px lane tile cannot carry a module
// surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VfpgaRunnerOutputBody from './VfpgaRunnerOutputBody.svelte';

export default {
  fullViewBody: VfpgaRunnerOutputBody,
} satisfies ShellExtension;
