// packages/web/src/lib/ui/modules/grainsOfVision/shell-extension.ts
//
// The GRAINS OF VISION shell extension — the module-owned end of the extension
// seam (#1512), and the fourth adopter of the `fullViewBody` slot after
// `backdraft`, `videoOut` and `spirographs`.
//
// `grainsOfVisionDef.face.extension: 'grainsOfVision'` declares this file — the
// id IS this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a grainsOfVision component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): the 2026-08-18 owner ruling gives every video module a SCREEN
// on/off toggle. Promotion sets `migrated()` true, and neither surface renders
// `GrainsOfVisionCard.svelte` after that — so a toggle authored on the card
// would be deleted by the promotion meant to keep it. There is no generic shell
// affordance to fall back on (`previewCollapsed` appears in zero shell files).
//
// ONE slot: `fullViewBody` — the live picture plus the SCREEN switch, rendered
// at the head of the DOCK full view. Dock-only, enforced by
// `dockFullViewHeadPlan`, because a 192 px lane tile cannot carry a module
// surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import GrainsOfVisionOutputBody from './GrainsOfVisionOutputBody.svelte';

export default {
  fullViewBody: GrainsOfVisionOutputBody,
} satisfies ShellExtension;
