// packages/web/src/lib/ui/modules/doom/shell-extension.ts
//
// The DOOM shell extension — the module-owned end of the extension seam
// (#1512). `doomDef.face.extension: 'doom'` declares this file; the non-eager
// glob in $lib/ui/workflow/shell-extensions.ts is the one resolver, ModuleShell
// loads it lazily and never imports a doom component itself (the
// module-shell-import-guard stays green).
//
// ONE slot: `fullViewBody` — the game screen with its keyboard capture, the
// WAD load gesture, the multiplayer identity badges, the Single Player / Host
// Multiplayer choice, the guest Join button, the arbiter's New Game dialog and
// the SCREEN switch, rendered at the head of the DOCK full view.
//
// THE LANE NEEDS NOTHING FROM HERE: doom is `domain: 'video'`, so
// `hasVideoSurface` gives its tile the live `VideoTileThumb` for free — this
// module's own first-person view, per node, with nothing declared. That is the
// picture the un-migrated placeholder tile never had.
//
// ⚠ THIS BODY CARRIES THE MODULE'S WHOLE RUNTIME OWNERSHIP, which is unusual
// enough to say here rather than leave to the component. DOOM's multiplayer
// session — `nodeDoomSession.adopt`, the awareness/nodes/edges observers, the
// pump that feeds the lockstep barrier, the `__doomCards` hook — is adopted in
// the surface component's `onMount`. Promotion stops the default shell rendering
// `DoomCard.svelte`, so if this slot did not mount that surface, a promoted DOOM
// would be a black tile with no game, no keyboard and no netgame, while every
// def-reading gate stayed green. Hence one SHARED surface rather than a second
// implementation: `doom/DoomSurface.svelte`, mounted by the card with
// by `DoomBody`, which is this module's `fullViewBody`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import DoomBody from './DoomBody.svelte';

export default {
  fullViewBody: DoomBody,
} satisfies ShellExtension;
