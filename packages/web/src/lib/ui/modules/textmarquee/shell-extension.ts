// packages/web/src/lib/ui/modules/textmarquee/shell-extension.ts
//
// The TEXTMARQUEE SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `textmarqueeDef.face.extension: 'textmarquee'` declares this file; the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a textmarquee component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ THIS IS THE #1928 SHAPE AT ITS SHARPEST. For a video processor the body
// rescues a PREVIEW; here it rescues the module's only WRITER. TEXTMARQUEE's
// four params (ScrlX / ScrlY / PosX / PosY) all move the ribbon and none of
// them says what it READS — that is `node.data.richText`, and until this file
// the only affordance in the tree that could write it was
// `TextmarqueeCard.svelte`, which promotion stops the shipping shell
// rendering. A face without this body would ship a module with four working
// knobs and permanently unchangeable text.
//
// ⚠ AND IT IS NOT THE PRODUCER. The rasterize-and-push half moved to
// `$lib/ui/media/extras-producers` on NODE lifetime in #1720 precisely so a
// saved rack shows your text with no UI mounted (measured then: nonBlack
// 446/49152 with no card versus 36992/49152 with one). This body writes the
// MODEL and blits a preview, so textmarquee stays correctly absent from
// `CARD_PRODUCER_LANE_TYPES`.
//
// ⚠ THE BODY MUST STAY 2-D. `textmarquee.ts` is in the WebGL attest basis and
// `TextmarqueeEditorBody.svelte` is deliberately outside it — but
// `resolveWebglBasis()` step (2) sweeps `lib/ui/modules/**/*.svelte` by
// CONTENT, so a `getContext('webgl')` here would enrol the file permanently
// and put every future face edit on the real-GPU attest critical path.
//
// ONE slot: `fullViewBody`. Dock-only by `dockFullViewHeadPlan`, because a
// 192 px lane tile cannot carry a twelve-control toolbar plus a
// `contenteditable`; the lane keeps the generic `VideoTileThumb` (which is
// textmarquee's first lane picture) above its four knob cells.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import TextmarqueeEditorBody from './TextmarqueeEditorBody.svelte';

export default {
  fullViewBody: TextmarqueeEditorBody,
} satisfies ShellExtension;
