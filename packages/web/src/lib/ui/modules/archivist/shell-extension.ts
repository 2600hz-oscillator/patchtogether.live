// packages/web/src/lib/ui/modules/archivist/shell-extension.ts
//
// The ARCHIVIST SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on BOTH body slots.
//
// `archivistDef.face!.extension: 'archivist'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a browser component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS LOAD-BEARING RATHER THAN DECORATIVE, and the reason is
// structural. archivist declares exactly ONE user-facing param (`gain`).
// Everything the module IS lives in affordances no `ParamDef` can express:
//
//   * the SEARCH — a free-text term, a media-type filter and two year bounds,
//     run against archive.org's advancedsearch endpoint. The results are a
//     runtime network fetch against a third-party index, which
//     `ShellSelectorCell.options` (a pure synchronous `(node) =>
//     SelectorOption[]`) cannot express;
//   * ↻ NEXT — an ACTION that re-rolls another random match, not a value;
//   * the TRANSPORT — play/pause, ±10 s, the random-position jump and a seek
//     bar over a duration that is only known once an element has metadata;
//   * the LOAD PROGRESS and FAILURE prose, which name which item is being
//     fetched and what a failed search should be changed to.
//
// None of them is expressible as a generic cell. `ShellSelectorCell.options` is
// typed `(node: ModuleNode | undefined) => SelectorOption<string>[]` — PURE and
// SYNCHRONOUS (shell-cells.ts:269), so it cannot express a runtime fetch; and a
// `static` face key renders as the deliberately INERT dashed label whenever no
// spec is registered for it (ModuleShell.svelte:757, :1930), which is the case
// for every affordance above and would stay the case unless a new cell kind
// were invented for this one module. The extension is the last rung of the
// ladder and the only rung that fits.
//
// ⚠ WHY "THE CARD STILL HAS THOSE" IS NOT AN ANSWER — the cameraInput/loopback
// argument, on the third and last member of `DOM_SOURCE_LANE_TYPES`. Promotion
// moves the real card into `<HeadlessSourceHost>`, which parks it at
// `left:-9999px` with `pointer-events: none`. The card is MOUNTED — that is
// what keeps the three node-owned elements attached and a loaded item playing —
// but nothing on it is CLICKABLE. Keeping the source alive and keeping the
// module usable are two different problems, and only the first one had a
// mechanism before this face.
//
// ⚠ WHAT THESE BODIES MUST NEVER DO: adopt a node-owned element, issue an
// archive.org fetch, or call an engine attach. The card owns all three; these
// surfaces read its published status and invoke its registered commands through
// `$lib/ui/media/archivist-status-registry`, so ownership stays in one place.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ArchivistArchiveBody from './ArchivistArchiveBody.svelte';
import ArchivistTileBody from './ArchivistTileBody.svelte';

export default {
  fullViewBody: ArchivistArchiveBody,
  // ⚠ THE LANE TILE'S COUNTERPART, AND IT IS NOT OPTIONAL HERE. cameraInput
  // shipped `fullViewBody`-only and lost its only route to a first capture;
  // archivist is the same shape one step worse, because a fresh archivist has
  // no item at all until a search runs. Without this the lane tile is an idle
  // gradient with no way to fill it. `EXTENSION_BODY_ROLES` is structurally
  // unable to see a `tileBody`, so it is pinned in `archivist-face-model.test.ts`.
  tileBody: ArchivistTileBody,
} satisfies ShellExtension;
