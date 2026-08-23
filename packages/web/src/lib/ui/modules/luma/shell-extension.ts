// packages/web/src/lib/ui/modules/luma/shell-extension.ts
//
// The LUMA SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `lumaDef.face.extension: 'luma'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a luma component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ DO NOT CONFUSE THIS DIRECTORY WITH `../lumakey`. They are different
// modules with adjacent names and adjacent jobs — `luma` is a single-input
// TONE PROCESSOR, `lumakey` is the two-input COMPOSITOR — and `luma.ts`'s own
// header exists because earlier versions of this module conflated them.
//
// ⚠ WHY (#1928): promotion stops BOTH surfaces rendering the legacy card, so a
// faced video module has NO route to a SCREEN ON/OFF switch except this slot.
// On this module the switch is an ADDITION rather than a port — `LumaCard.
// svelte` never drew a preview at all — and the picture is what makes an
// IDENTITY-at-defaults grade observable. There is no MONITOR mode to carry
// across; this card mounts no `hideControls`.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import LumaOutputBody from './LumaOutputBody.svelte';

export default {
  fullViewBody: LumaOutputBody,
} satisfies ShellExtension;
