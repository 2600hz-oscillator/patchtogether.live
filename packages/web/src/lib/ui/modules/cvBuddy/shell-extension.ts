// packages/web/src/lib/ui/modules/cvBuddy/shell-extension.ts
//
// The CV BUDDY shell extension — the module-owned end of the extension seam
// (#1512), and the first adopter of `fullViewBody` for a NON-VIDEO reason.
//
// Every previous adopter (`backdraft`, `videoOut`, `spirographs`,
// `grainsOfVision`, `ruttetra`, `colourofmagic`) mounts this slot to carry a
// PICTURE — a live preview canvas the generic faceplate has no cell for. This
// one carries rack-global STATUS: which ES-9 jacks this instance owns, whether
// they reach hardware, and whether the clock is dropping pulses. None of it is
// a function of this node's params, so no param-reading resolver can produce
// it, and `ModuleFace` has no field that could carry it (#2024 item 3).
//
// ⚠ ONE FILE FOR TWO DEFS. Both `cvBuddyDef` and `cvBuddyMiniDef` declare
// `face.extension: 'cvBuddy'`, because they share one ES-9 jack pool and one
// allocator — two extensions would be two answers to "who owns jack 1", which
// is the argument the shared card body has always made. The id is this
// DIRECTORY's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`; ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ONE slot: `fullViewBody`, rendered at the head of the DOCK full view.
// Dock-only by `dockFullViewHeadPlan` — a 192px lane tile cannot carry it, and
// that is the named blind spot in `rack-status-model.ts`'s header: the lane
// suppresses no bands precisely because this body is not there to explain the
// absence.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import CvBuddyStatusBody from './CvBuddyStatusBody.svelte';

export default {
  fullViewBody: CvBuddyStatusBody,
} satisfies ShellExtension;
