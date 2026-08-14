// packages/web/src/lib/meta/modules/push2-control.ts
//
// PUSH 2 CONTROL — a CONTROL SURFACE node that binds an Ableton Push 2 to a
// focused `clipplayer` (Phase 1). The Push drives the FULL Launchpad clip-launch
// / note-editor / arm / scene / KEYS parity surface by injecting itself as the
// control surface of the shipped launchpad-control singleton (no forked parity
// logic — see $lib/control/push2/push2-control.svelte.ts and the plan
//, decision A).
//
// ON TOP of parity, the additive Push-only features are built around the PUSH
// CARD — the view every module shows on the 960×160 screen (up to 8 controls,
// each a name + bar graph + readout, one per display encoder):
//   · the 8 buttons above the display select LANE 1-8 and switch the screen to
//     that lane's push card;
//   · the #2-from-the-left encoder flips through the cards of the modules in
//     that lane, one at a time;
//   · the 8 display encoders turn the card's 8 controls (SHIFT = fine);
//   · the master encoder drives MixMasters master volume;
//   · the D-Pad scrolls the CLIP-view window (SHIFT = ×8).
// START/STOP moves to the Push Play button. Which 8 controls a module shows is
// an owner-editable text schema: $lib/control/push2/push-card-config.ts.
//
// LEGEND MODE — hold the LEGEND button (`PUSH_CC_LEGEND`) and the screen becomes
// 2 rows × 8 slices naming what the surrounding buttons do IN THE CURRENT VIEW:
// the BOTTOM row sits directly above the 8 function buttons under the display,
// the TOP row documents the 8 scene buttons beside the grid (left→right =
// top→bottom). SHIFT swaps every cell to its shift layer without releasing.
// MOMENTARY and DISPLAY-ONLY — no button changes what it does, and release
// restores the previous screen. The text is not a written list: it lives ON the
// routing table rows themselves ($lib/control/launchpad/launchpad-map.ts) or is
// computed from the router's own classifiers, and a unit gate
// (push-legend-model.test.ts) fails in BOTH directions if a binding loses its
// legend or a legend loses its binding.
//
// The 960×160 display runs over WebUSB and degrades to nothing if it is
// unavailable or declined — pads and encoders keep working over Web MIDI, and
// the card renders the same push card in the browser. Modeled on
// ElectraControl / LaunchpadControl — a meta-domain control-surface node with no
// audio cable I/O; all hardware state is per-machine local, LED and display
// frames never touch the Y.Doc.
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
  // 2u: the card now carries a 960×160 PUSH-CARD PREVIEW (CSS-scaled to the card
  // width) plus the card-flip row above the lane buttons, which takes its natural
  // height past the 180 px a 1u allows. `card-control-overflow` measured 201 px
  // of content in a 180 px card — the def is the ONE place that height is
  // declared, so it moves here rather than the preview being shrunk to fit.
  size: '2u',
  hp: 2,
  inputs: [],
  outputs: [],
  params: [],
  // One expensive device per rack (like ElectraControl / ES-9). Deletable → the
  // deterministic post-merge singleton cleanup covers it.
  maxInstances: 1,
};
