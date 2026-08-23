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

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PongCourtBody from './PongCourtBody.svelte';

export default {
  fullViewBody: PongCourtBody,
} satisfies ShellExtension;
