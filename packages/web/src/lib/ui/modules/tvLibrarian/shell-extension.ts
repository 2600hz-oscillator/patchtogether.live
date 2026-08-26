// packages/web/src/lib/ui/modules/tvLibrarian/shell-extension.ts
//
// The TV LIBRARIAN shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `tvLibrarianDef.face!.extension: 'tvLibrarian'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a tuner component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS LOAD-BEARING RATHER THAN DECORATIVE HERE. Everything this
// module is FOR — pick a country, pick a station — is a browse surface, and none
// of it is param-shaped: the country roster and the channel roster are two
// runtime network fetches against a third-party dataset, which
// `ShellSelectorCell.options` (a pure synchronous `(node) => SelectorOption[]`)
// cannot express, and persisting that volatile payload into `node.data` to make
// it expressible would sync it into every saved rack. `next` / `random` are
// gestures the def itself classifies as DOM-only, and their CV path is the two
// real gate inputs, which keep working untouched.
//
// ⚠ AND "THE CARD STILL HAS THOSE" IS NOT AN ANSWER HERE — less so than on
// camera or loopback. Those two keep a real card alive off-screen in
// `<HeadlessSourceHost>`, so the argument is only that its buttons are
// unclickable. tvLibrarian left `DOM_SOURCE_LANE_TYPES` in LEG-02 P3 (#2209)
// because its stream became node-owned, so under the shell there is no card
// mounted ANYWHERE. Without this body a promoted tvLibrarian could not be tuned
// at all.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface. The lane tile gets the module's picture for free from
// `hasVideoSurface(def)`, which is `domain === 'video'` and nothing else.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import TvLibrarianTunerBody from './TvLibrarianTunerBody.svelte';

export default {
  fullViewBody: TvLibrarianTunerBody,
} satisfies ShellExtension;
