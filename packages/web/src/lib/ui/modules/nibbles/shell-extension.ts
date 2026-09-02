// packages/web/src/lib/ui/modules/nibbles/shell-extension.ts
//
// The NIBBLES SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `nibblesDef.face!.extension: 'nibbles'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a nibbles component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ ONE SLOT, NOT TWO, AND THAT IS A MEASUREMENT RATHER THAN A DEFAULT. Its
// three sibling games (frogger, modtris, skifree) are AUDIO-domain defs, so
// `hasVideoSurface` is false for all three and the lane tile has no generic
// route to their picture — skifree had to author a `tileBody` to get one.
// NIBBLES is `domain: 'video'`, and `laneGlyphFor` returns `'picture'` for a
// video def before it ever reads `face.glyph`, so ModuleShell already paints a
// live per-node `<VideoTileThumb nodeId={id} />` on the lane tile with nothing
// declared. A `tileBody` here would REPLACE that free picture with a bespoke
// one — ModuleShell gates the tile slot on `!extBody` — for no gain.
//
// ⚠ WHAT THE BODY MUST CARRY THAT NOTHING ELSE CAN: the SCREEN switch (the
// 2026-08-18 owner ruling for every video module; `previewCollapsed` appears in
// ZERO shell files, so `fullViewBody` is the only route), the 1x-4x SCALE
// switch (a per-view preference; making it a ParamDef would be an edit to a def
// inside the WebGL attest basis), and the ARROW KEYS — which are this module's
// PLAYING INTERFACE, not a keyboard-a11y affordance. Without the last of those
// a promoted nibbles is a game with no way to play it, which is a parity loss
// rather than an accessibility question.
//
// ⚠ AND THE `spirographs` LESSON IS WHY THIS FILE EXISTS AT ALL: that module
// shipped its SCREEN toggle on its CARD, was promoted, and the ruling was then
// satisfied only on a surface nobody can reach (#1928). Promotion is precisely
// what stops the card rendering.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import NibblesScreenBody from './NibblesScreenBody.svelte';

export default {
  fullViewBody: NibblesScreenBody,
} satisfies ShellExtension;
