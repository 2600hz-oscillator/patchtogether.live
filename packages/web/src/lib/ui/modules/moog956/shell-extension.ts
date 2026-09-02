// packages/web/src/lib/ui/modules/moog956/shell-extension.ts
//
// The MOOG 956 SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on BOTH wired body slots.
//
// `moog956Def.face.extension: 'moog956'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a moog956 component itself, which keeps
// `module-shell-import-guard` green.
//
// ── WHY TWO SLOTS ───────────────────────────────────────────────────────────
//
// The module's instrument is ONE POINTER STROKE that writes `pos` and raises
// `gate` together, holds the pitch on release, and is therefore not expressible
// by any ranked cell — see the def's face block for the ladder walk. Both
// surfaces a player meets need it:
//
//   * `fullViewBody` — the DOCK, at the full width of the plate, where the
//     ribbon's precision (≈ 8 px per semitone over the default 2-octave span)
//     actually exists.
//   * `tileBody`     — the LANE, because `faceTierCap('compact', 'none')` is 3
//     and `gate` ranks fourth: without a strip the tile can set a pitch and
//     cannot sound it.
//
// ⚠ THEY ARE COUNTERPARTS, NEVER SIBLINGS. ModuleShell gates the tile slot on
// `!extBody`, so exactly one of them paints per shell instance — but a faced
// module's lane tile and its open dock pane are two instances for the SAME
// node, mounted at once, so the shared `Moog956RibbonStrip` namespaces every
// testid by `testidPrefix` (`moog956-tile-*` / `moog956-face-*`) rather than
// sharing one.
//
// ⚠ NO `glyph` SLOT, and none is possible: the def's outputs are `pitch` and
// `gate`, so `primaryAudioOutPortId` is null and `glyphBinding` has no live tap
// to bind. `face.glyph` is `'none'`, which the dead-glyph clause forces.
//
// ⚠ NEITHER BODY MAY GROW A CANVAS. The strip is DOM by construction; a
// drawing surface would flip the declared `EXTENSION_BODY_ROLES` role
// (`control-grid`) red and, beyond the gate, enrol an audio utility in the
// real-GPU WebGL attest, whose basis is derived from CONTENT.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import Moog956RibbonBody from './Moog956RibbonBody.svelte';
import Moog956TileBody from './Moog956TileBody.svelte';

export default {
  fullViewBody: Moog956RibbonBody,
  tileBody: Moog956TileBody,
} satisfies ShellExtension;
