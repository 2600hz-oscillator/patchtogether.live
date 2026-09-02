// packages/web/src/lib/ui/modules/videovarispeed/shell-extension.ts
//
// The VIDEOVARISPEED shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `videoVarispeedDef.face!.extension: 'videovarispeed'` declares this file —
// the id IS this directory's name, and the non-eager `import.meta.glob` in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a player component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS LOAD-BEARING RATHER THAN DECORATIVE, and more so here than for
// any other video face so far. Everything this module is FOR is gesture-shaped:
// picking a clip, dropping one, re-allowing a remembered handle, striking one
// of seven slots, dragging a crop box, scrubbing a playhead. A file picker and
// a permission re-grant are honoured only inside a real user gesture on a
// mounted surface, and NO ParamCellKind mounts an `<input type=file>` or a
// draggable rectangle. videovarispeed is in neither `DOM_SOURCE_LANE_TYPES` nor
// `CARD_PRODUCER_LANE_TYPES`, so it gets no `<HeadlessSourceHost>` either —
// under the shell there is no card mounted anywhere. Without this body a
// promoted videovarispeed would be a video player with no way to be given a
// video.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a seven-slot bank and a crop editor. The lane tile gets the module's
// picture for free from `hasVideoSurface(def)`, which is `domain === 'video'`
// and nothing else.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VideoVarispeedTransportBody from './VideoVarispeedTransportBody.svelte';

export default {
  fullViewBody: VideoVarispeedTransportBody,
} satisfies ShellExtension;
