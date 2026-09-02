// packages/web/src/lib/ui/modules/seqtris/shell-extension.ts
//
// The SEQTRIS SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on BOTH wired body slots.
//
// `seqtrisDef.face!.extension: 'seqtris'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a seqtris component itself, which is what keeps
// `module-shell-import-guard` green. No shared file is edited to register it.
//
// ⚠ WHY THIS MODULE NEEDS BOTH SLOTS. seqtris declares exactly two params
// (grav, quant), so a face WITHOUT the bodies would rank those two into the
// lane and leave THE BOARD AND THE CONTROLLER BEHIND — which is what the
// migration inventory's `why` says the surface must not lose, and it is the
// literal shape of a promotion done wrong here. There is no `ParamCellKind`
// that mounts a live 8x8 grid, and a PF-14 `panel` cell's first legal rank is 7
// against a two-param module, so the body slots are not a preference: they are
// the only route. `skifree` is the precedent for filling both.
//
// ⚠ THE TWO ARE COUNTERPARTS, NEVER SIBLINGS. `ModuleShell` gates the tile slot
// on `!extBody`, so exactly one paints per shell instance — but a LANE TILE and
// an OPEN DOCK PANE for the same node are two instances mounted AT ONCE, which
// is why the bodies namespace their testids (`seqtris-tile-*` /
// `seqtris-face-*`) rather than sharing them, and why the `revision`
// invalidation tick they both read is page-wide instead of component-local
// (`seqtris-surface.svelte.ts`). Sharing testids would put two elements behind
// every selector, which is the failure `skifree/shell-extension.ts` records.
//
// ⚠ WHAT NEITHER BODY MAY DO:
//   * call `launchpad.release()` — that is the node's death, called from the
//     factory's `dispose` (#1728). `unbind()` is a user gesture only.
//   * re-derive `SEQTRIS_SCENE_ACTIONS` or `seqtrisCssColor`. One roster and
//     one palette for the screen and the pads, on purpose.
//   * statically import `launchpad-device.svelte.ts` — it declares `$state` at
//     module scope and the ART harness runs the audio registry with no Svelte
//     plugin. `import type` only.
//   * run a `requestAnimationFrame` loop. Unlike modtris and skifree, THIS
//     module pushes: the factory's `changed()` fires a listener set, and the
//     bodies subscribe. An rAF poll would make an idle, unclocked seqtris — the
//     resting state a VRT scene captures — do work forever.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import SeqtrisWellBody from './SeqtrisWellBody.svelte';
import SeqtrisTileBody from './SeqtrisTileBody.svelte';

export default {
  // The DOCK: the well, the eight-row hardware scene column (both dead buttons
  // included), CONNECT / Unbind, the index-keyed port picker, the status line
  // and the SCREEN switch.
  fullViewBody: SeqtrisWellBody,
  // The LANE: the same well, read-only, plus the bind lamp. The tile is where a
  // player normally meets this module, and until now it could show nothing
  // there but a placeholder while the game ran underneath.
  tileBody: SeqtrisTileBody,
} satisfies ShellExtension;
