// packages/web/src/lib/ui/modules/toybox/shell-extension.ts
//
// The TOYBOX SHELL EXTENSION (#1512) — the module-owned end of the extension
// seam.
//
// `toyboxDef.face.extension: 'toybox'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a toybox component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ ONE SLOT, AND IT IS LOAD-BEARING RATHER THAN DECORATIVE. `toyboxDef.params`
// is `[]` — the module declares ZERO ParamDefs — so `face.order` is empty and
// the faceplate renders no control bands at all. Everything TOYBOX is lives in
// affordances no `ParamDef` can express:
//
//   * the LAYER band — four layers, each with a KIND (gen / frag / obj / image /
//     video / off) and a per-kind editor whose controls change with the kind:
//     the shader bank's manifest-declared uniforms, a mesh + matcap + transform,
//     an image import, a video SOURCE (patched feed / file / camera). The
//     control roster is (layer × kind)-scoped and changes under the player's
//     hands, so no static `order` can name it;
//   * the COMBINE GRAPH — an EDITABLE node graph: 17 op kinds, click-to-patch
//     bezier cables, click-to-delete edges, per-node randomize locks, a
//     right-click contextual menu and a canvas whose height persists to
//     `node.data.combineView`. There is no cell kind that wires a DAG;
//   * the CV RAIL — six routed modulation inputs, each addressing a layer or
//     op-node param BY THE GRAPH'S OWN DISPLAY NAME, with an attenuverter, an
//     offset and a live scope. The target roster is a function of the combine
//     graph, which `ShellSelectorCell.options` (pure, synchronous, over
//     `node`) could express only by re-deriving the graph per render;
//   * the PRESET STORE — bundled + saved presets, a seeded RANDOM roll that
//     honours locks, REVERT to the pre-roll patch, and zip export/import.
//
// ⚠ AND "THE CARD STILL HAS THOSE" IS NOT AN ANSWER HERE — it is not even
// available. toybox is in NONE of `DOM_SOURCE_LANE_TYPES`,
// `CARD_PRODUCER_LANE_TYPES` or `HEADLESS_MOUNT_LANE_TYPES`, so unlike the
// archivist / cameraInput / loopback cohort there is no `<HeadlessSourceHost>`
// keeping a parked card alive. Promotion stops `ToyboxCard.svelte` mounting
// ANYWHERE. This body is not a second way to reach the console; after the
// promotion it is the ONLY way.
//
// ⚠ NO `tileBody`, and that is a decision with a reason. The lane tile is
// ~192 px wide and every control this module has is layer-scoped or
// node-scoped — choosing WHICH layer or WHICH op node to operate is already a
// dock-sized task, so any single control promoted to the tile would be
// operating something the player cannot see they have selected. The lane keeps
// the generic `VideoTileThumb`, which is the honest identity of a compositor:
// the picture IS the module. (recorderbox and archivist took a tileBody because
// each has a gesture — start a take, run a search — that a fresh node needs and
// that has no layer to be scoped to. toybox has no such gesture.)

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ToyboxConsoleBody from './ToyboxConsoleBody.svelte';

export default {
  fullViewBody: ToyboxConsoleBody,
} satisfies ShellExtension;
