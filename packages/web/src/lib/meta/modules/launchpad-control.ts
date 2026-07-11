// packages/web/src/lib/meta/modules/launchpad-control.ts
//
// LAUNCHPAD CONTROL — a CONTROL SURFACE node that binds a PAIR of Novation
// Launchpad Mini Mk3 units to a focused `clipplayer`. ONE module drives the
// whole pair through the single launchpad-device + launchpad-control singleton:
// the LEFT unit is the always-live 8×8 CLIP MATRIX (scene launch); the RIGHT
// unit is the COMMAND DECK + NOTE EDITOR (EDIT/COPY/PASTE/DOUBLE/LENGTH/NOW +
// per-lane STOP + transport, and it flips to the note grid while editing).
//
// Modeled on ElectraControl (a meta-domain control-surface node with no audio
// cable I/O — all state on node.data + the per-machine local binding); see
// $lib/control/launchpad/launchpad-control.svelte.ts for the behaviour and the
// proposal at .myrobots/plans/clip-launcher-launchpad/.
//
// The "Pair" button runs the press-a-pad L/R handshake; "Connect single
// Launchpad" binds ONE device whose role flips between the CLIP (matrix) and
// CONTROL (deck/editor) views — single mode is a first-class deployment with
// the full feature set (arm row, double-tap edit, FOLLOW on the editor's scene
// column, KEYS on one device). The binding (which ports are L vs R, which
// clip-player) is per-machine localStorage, never synced. LED frames are local
// render state, never written to the Y.Doc.
//
// NOTE: this single module consolidates the former LEFT + RIGHT cards. The type
// string is KEPT as `launchpadControlLeft` so saved LEFT nodes keep loading
// clean — only a stray RIGHT node degrades to a placeholder.
//
// Inputs: none. Outputs: none. Params: none. (Card-only, like ElectraControl.)

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const LAUNCHPAD_CONTROL_TYPE = 'launchpadControlLeft';

export const launchpadControlDef: MetaModuleDef = {
  type: LAUNCHPAD_CONTROL_TYPE,
  palette: { top: 'Hybrid', sub: 'Hybrid' }, // sits beside the other control surfaces
  domain: 'meta',
  label: 'launchpad control',
  category: 'tools',
  card: 'LaunchpadControlCard',
  size: '1u', // compact "wide 1u" — measured natural height ≤ 180px
  hp: 2,
  inputs: [],
  outputs: [],
  params: [],
};
