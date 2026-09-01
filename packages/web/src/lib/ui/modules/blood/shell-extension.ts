// packages/web/src/lib/ui/modules/blood/shell-extension.ts
//
// The BLOOD SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `bloodDef.face.extension: 'blood'` declares this file; the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a blood component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ THE USUAL #1928 ARGUMENT DOES NOT APPLY HERE, AND THE REAL ONE IS STRONGER.
// For acidwarp and lushgarden this slot exists because promotion deletes the
// card that owned the module's only picture. `BloodCard.svelte` has NO picture
// — no `<canvas>` anywhere in it — so nothing visual is being rescued. What the
// card owned was the module's BOOT: `extras.ensureLoaded()` had exactly one
// caller in the tree and it was that card. blood is in neither half of
// `HEADLESS_MOUNT_LANE_TYPES`, so promotion would have left a module that never
// starts, on a plate where every gate stays green. The body carries the boot,
// the folder picker, the actionable error prose and the capture-phase keyboard
// host, and it ADDS the module's first live picture and its first SCREEN
// switch.
//
// ⚠ THE BODY MUST STAY 2-D. `blood.ts` is in the WebGL attest basis;
// `BloodCard.svelte` is correctly outside it, and `BloodScreenBody.svelte` must
// stay outside it for the same reason. It blits the engine's already-rendered
// canvas through a 2-D context; a `getContext('webgl')` here would enrol the
// file permanently and put every future face edit on the real-GPU attest
// critical path.
//
// ONE slot: `fullViewBody`. Dock-only by `dockFullViewHeadPlan`, because a
// 192 px lane tile cannot carry a game viewport; the lane keeps the generic
// `VideoTileThumb`, which is BLOOD's first lane picture too.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import BloodScreenBody from './BloodScreenBody.svelte';

export default {
  fullViewBody: BloodScreenBody,
} satisfies ShellExtension;
