// packages/web/src/lib/ui/modules/shapes/shell-extension.ts
//
// The SHAPES SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `shapesDef.face.extension: 'shapes'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a shapes component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ DO NOT CONFUSE THIS DIRECTORY WITH `../shapegen`. They are different
// modules with adjacent names: `shapes` is this 2-D SDF primitive generator,
// `shapegen` is the generative 3-D shape synthesiser promoted in batch-22 G2a.
// Both are faced, both have a body in this tree, and the ids differ by three
// characters.
//
// ⚠ WHY (#1928): promotion stops BOTH surfaces rendering the legacy card, so a
// faced video module has NO route to a SCREEN ON/OFF switch except this slot.
// On this module the switch is an ADDITION rather than a port — `ShapesCard.
// svelte` never drew a preview — and the picture matters here because SHAPES is
// a SOURCE with no input: the frame is the only place its output exists at all
// before something downstream consumes it. There is no MONITOR mode to carry
// across; this card mounts no `hideControls`.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ShapesOutputBody from './ShapesOutputBody.svelte';

export default {
  fullViewBody: ShapesOutputBody,
} satisfies ShellExtension;
