// packages/web/src/lib/ui/modules/peertube/shell-extension.ts
//
// The PEERTUBE shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `peertubeDef.face!.extension: 'peertube'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a browser component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS LOAD-BEARING RATHER THAN DECORATIVE HERE. Everything this
// module is FOR — type a term, pick a video — is a browse surface, and none of
// it is param-shaped: the results roster is a runtime network fetch against a
// third-party meta-index, which `ShellSelectorCell.options` (a pure synchronous
// `(node) => SelectorOption[]`) cannot express, and persisting that volatile
// payload into `node.data` to make it expressible would sync it into every
// saved rack.
//
// ⚠ AND "THE CARD STILL HAS THOSE" IS NOT AN ANSWER HERE. peertube left
// `DOM_SOURCE_LANE_TYPES` in LEG-02 P3 (#1511) because its stream became
// node-owned, so unlike camera or loopback there is no `<HeadlessSourceHost>`
// keeping a card alive off-screen: under the shell NO card is mounted anywhere.
// Without this body a promoted peertube could not be searched at all.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a browse surface. The lane tile gets the module's picture for free from
// `hasVideoSurface(def)`, which is `domain === 'video'` and nothing else.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PeerTubeBrowseBody from './PeerTubeBrowseBody.svelte';

export default {
  fullViewBody: PeerTubeBrowseBody,
} satisfies ShellExtension;
