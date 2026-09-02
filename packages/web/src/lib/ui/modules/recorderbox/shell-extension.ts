// packages/web/src/lib/ui/modules/recorderbox/shell-extension.ts
//
// The RECORDERBOX shell extension — the module-owned end of the extension seam
// (#1512), filling BOTH wired body slots.
//
// `recorderboxDef.face!.extension: 'recorderbox'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a recorder component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THESE SLOTS ARE THE MODULE'S ONLY SURFACE, not an addition to a faceplate.
// `recorderboxDef` declares `params: []` and the face declares `order: []` (the
// `videoOut` / `flipper` shape), so there are no generic control bands to
// augment — and recorderbox is in NEITHER half of `HEADLESS_MOUNT_LANE_TYPES`,
// not in `DOM_SOURCE_LANE_TYPES` and not in `CARD_PRODUCER_LANE_TYPES`, so
// promotion stops `RecorderboxCard.svelte` being mounted ANYWHERE on the default
// shell. Everything a player does with this module — arm, stop, name the file,
// choose the folder, choose the size tier, recover a crashed take, collapse the
// monitor — lives here or nowhere.
//
// ⚠ BOTH SLOTS, NOT ONE, AND THE TILE IS THE LOAD-BEARING HALF. `cameraInput`
// learned this first: an extension that fills only `fullViewBody` leaves the
// lane tile a dead end. Here it would be worse, because `Canvas.svelte`'s
// workflow seed auto-spawns a recorderbox into the video zone of every fresh
// rack — so the un-startable tile would be the first module of every new
// session. The two components are counterparts, never siblings: ModuleShell
// renders `tileBody` only where `fullViewBody` is NOT painting, so one node
// never shows two RECORD switches at once.
//
// ⚠ NEITHER BODY OWNS THE RECORDING. The capture canvas, the encode pump and
// the render lease belong to `node-recorder-registry` on NODE lifetime (#1574),
// which exposes no teardown by design; both components drive it through the
// shared `../recorderbox-transport` seam that the legacy card also calls.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import RecorderboxCaptureBody from './RecorderboxCaptureBody.svelte';
import RecorderboxTileBody from './RecorderboxTileBody.svelte';

export default {
  fullViewBody: RecorderboxCaptureBody,
  // The LANE TILE's counterpart: the transport only. The picture is already the
  // shell's (`VideoTileThumb`), and the file/folder/size controls are dock-side
  // — none of the three is needed to START a take.
  tileBody: RecorderboxTileBody,
} satisfies ShellExtension;
