// packages/web/src/lib/ui/modules/vstBridge/shell-extension.ts
//
// The VST BRIDGE shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// ⚠ ONE EXTENSION, TWO DEFS. Both `vstInstrumentDef.face.extension` and
// `vstFxDef.face.extension` are `'vstBridge'`, which is legal by construction:
// `shell-extensions.test.ts` requires every declared id to RESOLVE and every
// discovered extension to be declared by AT LEAST ONE def. Sharing is the honest
// shape here rather than a shortcut — the two modules already share one engine
// factory (`vst-bridge-shared.ts`), one worklet (`vst-bridge`), one transport
// and one legacy card body (`VstBridgePanel.svelte`); a second copy of this file
// would be a second place for the plugin surface to drift.
//
// ⚠ WHY A BODY AT ALL. Both defs declare `params: []`, so unlike es9 — whose
// twenty-two jack classes are ordinary cells — there is almost nothing here that
// COULD be a cell. Exactly two affordances can: CONNECT and DISCONNECT, which
// are unconditional gestures with an audition-ledger observable. Everything else
// on the bridge control plane is gated on a LIVE helper connection and a LIVE
// plugin roster, and the full argument (with the two gate mechanics that decide
// it) is in `VstBridgeFaceBody.svelte`'s header.
//
// ⚠ AND THE TWO CELLS ARE NOT DUPLICATED HERE. The body carries no connect
// button. A body that also carried them would be a second implementation of
// controls the face already owns, and it would take the gestures OFF the lane
// tile, which is the half that makes them cells.
//
// ⚠ NO STATUS REGISTRY IS NEEDED, and the reason is es9's verbatim.
// `cameraInput` had to build one because promotion parks its real card in
// `<HeadlessSourceHost>`. Neither VST module is in `DOM_SOURCE_LANE_TYPES` or
// `CARD_PRODUCER_LANE_TYPES`, so nothing keeps their cards alive after promotion
// and nothing needs to: every connection, every ring and the whole persistence
// driver already live in node-keyed, ENGINE-side registries built for exactly
// this (`$lib/audio/vst/bridge-owner`, `createVstHandle`), on GRAPH lifetime.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps the ranked cells, which is the half that matters
// there — and CONNECT, the gesture both modules are silent without, is one.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VstBridgeFaceBody from './VstBridgeFaceBody.svelte';

export default {
  fullViewBody: VstBridgeFaceBody,
} satisfies ShellExtension;
