// packages/web/src/lib/ui/modules/colourofmagic/shell-extension.ts
//
// The colourofmagic SHELL EXTENSION — the module-owned end of the extension
// seam (#1512), and the FOURTH adopter of the `fullViewBody` slot after
// `backdraft`, `videoOut` and `spirographs`.
//
// `colourofmagicDef.face.extension: 'colourofmagic'` declares this file — the
// id IS this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a colourofmagic component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): the 2026-08-18 owner ruling gives every video module a SCREEN
// on/off toggle, and on a FACE it cannot live on the card. Promotion sets
// `migrated()` true and neither surface renders `ColourofmagicCard` afterwards,
// so a toggle left there is deleted by the very promotion meant to preserve it
// — which is exactly what shipped on spirographs. There is no generic shell
// affordance to fall back on (`previewCollapsed` appears in zero shell files),
// so the control arrives through this slot, the route the three existing
// adopters already take.
//
// ONE slot: `fullViewBody` — the live picture plus the SCREEN switch, rendered
// at the head of the DOCK full view. Dock-only, enforced by
// `dockFullViewHeadPlan`, because a 192 px lane tile cannot carry a module
// surface; the lane keeps the generic `VideoTileThumb`.
//
// ⚠ NOTE THE DIVISION OF LABOUR WITH THE HERO. This module's `face.hero`
// promotes `preview` — the control that chooses WHICH of the 22 outputs to
// look at — and declares NO hero `cell`. The picture belongs here instead;
// declaring both would put two pictures on one faceplate.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ColourofmagicOutputBody from './ColourofmagicOutputBody.svelte';

export default {
  fullViewBody: ColourofmagicOutputBody,
} satisfies ShellExtension;
