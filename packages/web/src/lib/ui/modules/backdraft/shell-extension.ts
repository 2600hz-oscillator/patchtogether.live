// packages/web/src/lib/ui/modules/backdraft/shell-extension.ts
//
// The backdraft SHELL EXTENSION (#1512) — the module-owned end of the extension
// seam, and the repo's FIRST adopter of the `fullViewBody` slot (#1732 wired the
// render site; `WIRED_SHELL_EXTENSION_SLOTS` now carries it).
//
// `backdraftDef.face.extension: 'backdraft'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// $lib/ui/workflow/shell-extensions.ts is the one resolver. ModuleShell loads it
// lazily and never imports a backdraft component itself, which is what keeps
// module-shell-import-guard green.
//
// ONE slot: `fullViewBody` — the module's live output picture plus the ⛶ OUTPUT
// menu, rendered at the head of the DOCK full view (dock-only, enforced by
// `dockFullViewHeadPlan`, because a 192 px lane tile cannot carry a module
// surface; the lane keeps the generic `VideoTileThumb`).
//
// It is here rather than in a cell because the affordance is not a param: Full
// Frame is `node.data.fullFrame` and Full Screen / Present are browser state, so
// there is nothing for a `ParamCellKind` to bind to — and it is the SOLE entry
// to all three, so losing it in promotion would have left the module unable to
// show its own picture.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import BackdraftOutputBody from './BackdraftOutputBody.svelte';

export default {
  fullViewBody: BackdraftOutputBody,
} satisfies ShellExtension;
