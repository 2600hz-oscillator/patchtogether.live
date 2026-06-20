// packages/web/src/lib/meta/modules/launchpad-control-right.ts
//
// LAUNCHPAD CONTROL · RIGHT — a CONTROL SURFACE node that binds the RIGHT
// Novation Launchpad Mini Mk3 (the COMMAND DECK; it flips to the 8-pitch ×
// 8-step NOTE EDITOR while editing) to a focused `clipplayer`. The sibling of
// launchpad-control-left; the two cards are TWO modules (owner decision) driving
// the SAME physical pair through the one launchpad-device singleton.
//
// RIGHT owns: EDIT (hold) / COPY / PASTE / PASTE-REV / COPY-IND / DOUBLE /
// LENGTH-EDIT / NOW + per-lane STOP (right scene column) + transport + stop-all
// (top row); and when editing, the full note grid with ▲▼◀▶ + SHIFT(×8)
// windowing, VEL / SCALE / FOLLOW. See launchpad-control.svelte.ts.
//
// Inputs: none. Outputs: none. Params: none. (Card-only, like ElectraControl.)

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const LAUNCHPAD_CONTROL_RIGHT_TYPE = 'launchpadControlRight';

export const launchpadControlRightDef: MetaModuleDef = {
  type: LAUNCHPAD_CONTROL_RIGHT_TYPE,
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'meta',
  label: 'launchpad control right',
  category: 'tools',
  card: 'LaunchpadControlRightCard',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
};
