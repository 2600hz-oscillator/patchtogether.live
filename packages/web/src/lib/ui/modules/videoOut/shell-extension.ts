// packages/web/src/lib/ui/modules/videoOut/shell-extension.ts
//
// The videoOut SHELL EXTENSION (#1512 seam, #1821 adopter) — the module-owned
// end of the extension registry, and the SECOND adopter of `fullViewBody` after
// backdraft.
//
// `videoOutDef.face.extension: 'videoOut'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// $lib/ui/workflow/shell-extensions.ts is the one resolver. ModuleShell loads it
// lazily and never imports a videoOut component itself, which is what keeps
// module-shell-import-guard green.
//
// ONE slot: `fullViewBody`. For backdraft that slot AUGMENTS a faceplate of
// thirty knobs; here it IS the faceplate, because `videoOutDef` declares
// `params: []` — there is nothing for the generic bands to render. See
// VideoOutBody.svelte's header for why every affordance it carries (full frame,
// DETACH, full screen, present) is `node.data` or browser state that no
// `ParamCellKind` can express, and therefore why promoting without this slot
// would delete the module's only route to its own picture.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VideoOutBody from './VideoOutBody.svelte';

export default {
  fullViewBody: VideoOutBody,
} satisfies ShellExtension;
