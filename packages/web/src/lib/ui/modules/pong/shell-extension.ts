// packages/web/src/lib/ui/modules/pong/shell-extension.ts
//
// The PONG SHELL EXTENSION — the module-owned end of the extension seam (#1512),
// on the `fullViewBody` slot.
//
// `pongDef.face.extension: 'pong'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a pong component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE COURT IS THE WHOLE REASON THIS EXISTS. `drawPong` is a pure function the
// legacy CARD called every rAF; promotion stops both surfaces rendering that
// card, so without this slot a faced pong is three faders over an invisible game.
// ⚠ And the game does not stop to tell you: it runs engine-side on the shared
// scheduler clock and goes on firing its score gates whether or not anything is
// mounted, which is precisely how the picture could be lost with nothing failing.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface.
//
// ⚠ TWO SLOTS, TWO SURFACES, AND THE SPLIT IS THE POINT (the #2160 adopter).
// `fullViewBody` is the LIVE court at the dock — it gets a `nodeId`, so it can
// read `eng.read(node, 'snapshot')` every frame. `glyph` is the LANE IDENTITY
// picture — its props are `{ num, numbers?, testid? }` with no `nodeId`, so it
// is a pure layout function by construction and draws pong's rest frame.
//
// Before this pair, the lane tile was a `ModuleShellPlaceholder`: the game ran,
// scored and pulsed its gates while a rack of pongs showed a rack of grey boxes.
// The comment in `PongCourtBody.svelte` still records why the body alone could
// not close that — `ShellExtension.glyph` rendered only under
// `binding.kind === 'algorithm'`, and that branch required a param literally
// named `algorithm`. #2160 widened the branch to carry a LAYOUT SOURCE instead,
// which is what `glyph` below is now resolved through: `face.glyph:'algorithm'`
// + `face.extension:'pong'` ⇒ `{ kind:'algorithm', layoutSource:'pong',
// paramId:null }`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PongCourtBody from './PongCourtBody.svelte';
import PongCourtGlyph from './PongCourtGlyph.svelte';

export default {
  glyph: PongCourtGlyph,
  fullViewBody: PongCourtBody,
} satisfies ShellExtension;
