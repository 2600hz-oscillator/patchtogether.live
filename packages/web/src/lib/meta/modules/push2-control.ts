// packages/web/src/lib/meta/modules/push2-control.ts
//
// PUSH 2 CONTROL — a CONTROL SURFACE node that binds an Ableton Push 2 to a
// focused `clipplayer` (Phase 1). The Push drives the FULL Launchpad clip-launch
// / note-editor / arm / scene / KEYS parity surface by injecting itself as the
// control surface of the shipped launchpad-control singleton (no forked parity
// logic — see $lib/control/push2/push2-control.svelte.ts and the plan
// .myrobots/plans/push2-control-phase1.md §3, decision A).
//
// ON TOP of parity, three additive Push-only features: the 8 buttons above the
// display select channel 1-8 (the card shows "CH n · <instrument>"); the 11
// encoders drive MixMasters (ch1-8 volume, the 2 left encoders = the selected
// channel's send1/send2, the master encoder = master volume); the D-Pad scrolls
// the CLIP-view window (SHIFT = ×8). START/STOP moves to the Push Play button.
//
// The 960×160 WebUSB display is DEFERRED to Phase 2 (Phase 1 shows the channel
// name in the card). Modeled on ElectraControl / LaunchpadControl — a meta-domain
// control-surface node with no audio cable I/O; all hardware state is per-machine
// local, LED frames never touch the Y.Doc.
//
// Inputs: none. Outputs: none. Params: none. (Card-only, like LaunchpadControl.)

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const PUSH2_CONTROL_TYPE = 'push2Control';

export const push2ControlDef: MetaModuleDef = {
  type: PUSH2_CONTROL_TYPE,
  palette: { top: 'Hybrid', sub: 'Hybrid' }, // sits beside the other control surfaces
  domain: 'meta',
  label: 'push 2 control',
  category: 'tools',
  card: 'Push2ControlCard',
  size: '1u', // compact "wide 1u"
  hp: 2,
  inputs: [],
  outputs: [],
  params: [],
  // One expensive device per rack (like ElectraControl / ES-9). Deletable → the
  // deterministic post-merge singleton cleanup covers it.
  maxInstances: 1,
};
