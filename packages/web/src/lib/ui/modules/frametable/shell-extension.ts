// packages/web/src/lib/ui/modules/frametable/shell-extension.ts
//
// The FRAMETABLE SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `frametableDef.face.extension: 'frametable'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a frametable component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE PICTURE HERE IS A PORT, NOT AN ADDITION — the opposite of `chroma`,
// whose card drew no preview at all. `FrametableCard.svelte` already paints a
// 176x92 `video_out` preview (`data-testid="frametable-preview"`), and
// `migrated(type)` stops BOTH surfaces rendering that card. So without this
// slot, promotion would DELETE a surface the module already shipped — and on
// this module in particular that surface is not decoration: FRAMETABLE's whole
// subject is what a 60-frame history looks like when you scan it, and MORPH,
// SPREAD and the two waveform pads are unjudgeable without watching the frame
// they produce.
//
// ⚠ WHY THE SCREEN SWITCH IS HERE AT ALL (#1928): promotion leaves a faced
// video module with NO route to a SCREEN ON/OFF toggle except this slot. A
// toggle left on the card is deleted by the very promotion that was supposed to
// keep it — which is the defect `spirographs` shipped and #1930 repaired.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import FrametableOutputBody from './FrametableOutputBody.svelte';

export default {
  fullViewBody: FrametableOutputBody,
} satisfies ShellExtension;
