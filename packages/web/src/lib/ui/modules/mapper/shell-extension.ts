// packages/web/src/lib/ui/modules/mapper/shell-extension.ts
//
// The MAPPER SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `mapperDef.face.extension: 'mapper'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a mapper component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion stops BOTH surfaces rendering the legacy card, so a
// faced video module has NO route to a SCREEN ON/OFF switch except this slot.
// On this module the switch is an ADDITION rather than a port — `MapperCard.
// svelte` never drew a preview at all — and the picture beside it is the whole
// argument for facing a one-param keyer: its output is a MATTE DECISION, which
// a dial cannot show. There is no MONITOR mode to carry across either; this
// card mounts no `hideControls`.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MapperOutputBody from './MapperOutputBody.svelte';

export default {
  fullViewBody: MapperOutputBody,
} satisfies ShellExtension;
