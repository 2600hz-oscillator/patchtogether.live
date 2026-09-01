// packages/web/src/lib/ui/modules/gibribbon/shell-extension.ts
//
// The GIBRIBBON shell extension — the module-owned end of the extension seam
// (#1512). `gibribbonDef.face.extension: 'gibribbon'` declares this file; the
// non-eager glob in $lib/ui/workflow/shell-extensions.ts is the one resolver,
// ModuleShell loads it lazily and never imports a gibribbon component itself
// (module-shell-import-guard stays green).
//
// ONE slot: `fullViewBody` — the game screen with its keyboard capture, the
// RESET action + WAD lamp, and the SCREEN + MONITOR switches, rendered at the
// head of the DOCK full view. The LANE needs nothing from here: gibribbon is
// `domain: 'video'`, so `hasVideoSurface` gives its tile the live
// VideoTileThumb — the running game — for free. (That is the picture the
// un-migrated placeholder tile never had, and the reason this module was
// invisible in the shipping shell for its whole first life.)
//
// SCREEN OFF is unusually safe here for the same reason it is on frogger:
// the game runs on the shared SCHEDULER CLOCK inside the module's factory —
// not in a card, not on rAF, not gated on anything watching — so collapsing
// the preview stops a blit and nothing else; attract keeps playing and the
// evt_* gates keep firing into whatever is patched.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import GibribbonBody from './GibribbonBody.svelte';

export default {
  fullViewBody: GibribbonBody,
} satisfies ShellExtension;
