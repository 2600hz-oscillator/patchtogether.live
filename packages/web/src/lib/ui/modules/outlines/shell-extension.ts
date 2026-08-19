// packages/web/src/lib/ui/modules/outlines/shell-extension.ts
//
// The outlines SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), and the fifth adopter of the `fullViewBody` slot after `backdraft`,
// `videoOut`, `spirographs` and `mirrorpool`.
//
// `outlinesDef.face.extension: 'outlines'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports an outlines component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): promotion makes `migrated()` true and stops both surfaces from
// rendering `OutlinesCard.svelte`, so the SCREEN on/off toggle the 2026-08-18
// owner ruling requires cannot live on the card. There is no generic shell
// affordance for it — `previewCollapsed` appears in zero shell files.
//
// ⚠ Unlike the other adopters, this module's preview is NOT a GL blit: it draws
// from `engine.read(node, 'sceneCanvas')`, a 2D canvas the module keeps itself.
// The slot does not care, which is the point of building the cell against the
// declared video surface rather than against one module's blit.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import OutlinesOutputBody from './OutlinesOutputBody.svelte';

export default {
  fullViewBody: OutlinesOutputBody,
} satisfies ShellExtension;
