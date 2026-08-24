// packages/web/src/lib/ui/modules/picturebox/shell-extension.ts
//
// The PICTUREBOX SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `pictureboxDef.face.extension: 'picturebox'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a picturebox component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY, AND IT IS MORE THAN THE #1928 SCREEN SWITCH. Promotion stops BOTH
// surfaces rendering `PictureboxCard.svelte`, and that card owns the module's
// ENTIRE INPUT PATH: the "Choose image…" picker and the seven per-slot pickers
// are `<input type="file">` elements, and no `ParamCellKind` mounts one. Without
// this slot a faced picturebox would be a picture source with no way to be given
// a picture — the STOP-2 refusal the faceplate skill describes for `samsloop`.
// So the body carries the pickers and the bank as well as the SCREEN ON/OFF
// switch `video-face-screen-source.test.ts` requires.
//
// ⚠ NOT a `panel` CELL, which is the other seam that could hold a bank. A panel
// cell must be a ranked key in `face.order` — the bank would then compete with
// GAIN for band space when it is not a control, it is a library — and its probe
// vocabulary is `data` / `data-rev` / `text`, none of which can honestly observe
// "a file dialog opened". A probe that proves less than it appears to is worse
// than no seam.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb` — which for a
// video def is a live, per-node picture of this node's own output, for free.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PictureboxAssetsBody from './PictureboxAssetsBody.svelte';

export default {
  fullViewBody: PictureboxAssetsBody,
} satisfies ShellExtension;
