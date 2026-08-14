// packages/web/src/lib/ui/modules/dx7/shell-extension.ts
//
// The dx7 SHELL EXTENSION (#1512) — the module-owned end of the extension
// seam. `dx7Def.face.extension: 'dx7'` declares this file (the id IS this
// directory's name — the glob in $lib/ui/workflow/shell-extensions.ts is the
// one resolver), and ModuleShell lazily loads it instead of importing any dx7
// component itself.
//
// ONE slot: the GLYPH — the algorithm routing diagram, resolved when the
// shell's glyphBinding is 'algorithm'. The shell renders it in its generic
// `.topo-glyph` plate (tile/dock glyph slot) and as the per-cell picture of
// the 32-entry algorithm picker (`paramCells: { algorithm: 'grid' }`), passing
// exactly the props it always passed — the markup/props contract did not move,
// only the resolution path did (the DX7 VRT baselines are the check).

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import Dx7AlgorithmGlyph from './Dx7AlgorithmGlyph.svelte';

export default {
  glyph: Dx7AlgorithmGlyph,
} satisfies ShellExtension;
