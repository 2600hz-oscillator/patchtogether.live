// packages/web/src/lib/meta/modules/launchpad-control-left.ts
//
// LAUNCHPAD CONTROL · LEFT — a CONTROL SURFACE node that binds the LEFT
// Novation Launchpad Mini Mk3 (the always-live 8×8 CLIP MATRIX) to a focused
// `clipplayer`. Modeled on ElectraControl (a meta-domain control-surface node
// that has no audio cable I/O — all state on node.data + the per-machine local
// binding); see $lib/control/launchpad/launchpad-control.svelte.ts for the
// behaviour and the proposal at .myrobots/plans/clip-launcher-launchpad/.
//
// The LEFT + RIGHT cards are TWO modules (owner decision) but drive the SAME
// physical pair through the one launchpad-device singleton: LEFT owns the matrix
// + scene launch, RIGHT owns the command deck + the note editor. Either card's
// "Pair" button runs the press-a-pad L/R handshake; the binding (which ports are
// L vs R, which clip-player) is per-machine localStorage, never synced. LED
// frames are local render state, never written to the Y.Doc.
//
// Inputs: none. Outputs: none. Params: none. (Card-only, like ElectraControl.)

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const LAUNCHPAD_CONTROL_LEFT_TYPE = 'launchpadControlLeft';

export const launchpadControlLeftDef: MetaModuleDef = {
  type: LAUNCHPAD_CONTROL_LEFT_TYPE,
  palette: { top: 'Hybrid', sub: 'Hybrid' }, // sits beside the other control surfaces
  domain: 'meta',
  label: 'launchpad control left',
  category: 'tools',
  card: 'LaunchpadControlLeftCard',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
};
