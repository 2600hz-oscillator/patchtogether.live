// packages/web/src/lib/ui/modules/spirographs/shell-extension.ts
//
// The spirographs SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), and the THIRD adopter of the `fullViewBody` slot after `backdraft`
// and `videoOut`.
//
// `spirographsDef.face.extension: 'spirographs'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a spirographs component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY (#1928): the 2026-08-18 owner ruling gives every video module a SCREEN
// on/off toggle. spirographs shipped one on its CARD and was then promoted into
// STRICT_FACES — which makes `migrated()` true and stops both surfaces from
// rendering that card, leaving the required control unreachable from the
// faceplate that replaced it. There is no generic shell affordance to fall back
// on (`previewCollapsed` appears in zero shell files), so the toggle arrives
// through this slot, which is the route the two existing adopters use.
//
// ONE slot: `fullViewBody` — the live picture plus the SCREEN switch, rendered
// at the head of the DOCK full view. Dock-only, enforced by
// `dockFullViewHeadPlan`, because a 192 px lane tile cannot carry a module
// surface; the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import SpirographsOutputBody from './SpirographsOutputBody.svelte';

export default {
  fullViewBody: SpirographsOutputBody,
} satisfies ShellExtension;
