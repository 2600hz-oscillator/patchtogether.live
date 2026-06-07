// packages/web/src/lib/meta/modules/electra-control.ts
//
// ELECTRA CONTROL — a specialized CONTROL SURFACE variant laid out EXACTLY for
// the Electra One physical control scheme. Where CONTROL SURFACE is a dynamic,
// first-seen, auto-grouped panel, ElectraControl is a FIXED positional 6×6 grid
// (36 slots, never dynamic): 6 rows × 6 knobs, with the rows grouped into three
// 2-row banks — TOP (Row1-2), MIDDLE (Row3-4), BOTTOM (Row5-6) — that mirror the
// Electra One's three stacked 12-pot control sets.
//
// USAGE
//   Right-click any MIDI-assignable knob/fader on any module and choose
//   "Send to <electra>" → Row1..Row6 → 1..6 (knob left-to-right). The control's
//   pointer (moduleId:paramId) is assigned to that exact (row, knob) grid slot.
//   The card shows the 36-slot grid; each filled slot renders a proxied Knob
//   driving the SOURCE module's live param plus an editable label. Empty slots
//   render empty. The label is the name flashed to the Electra (clamped to 14).
//
// (row, knob) → Electra mapping (see $lib/graph/electra-control.ts §electraPosOf):
//   controlSetId = ceil(row / 2)          // rows 1-2 → set 1 (TOP), 3-4 → set 2
//                                         //   (MIDDLE), 5-6 → set 3 (BOTTOM)
//   potId        = (row odd ? 0 : 6) + knob  // odd row = a band's TOP sub-row
//                                            //   (pots 1-6); even row = its
//                                            //   BOTTOM sub-row (pots 7-12)
//   slotIndex    = (row-1)*6 + (knob-1)    // 0..35, the card storage key
//
// MODEL
//   Pointers, not copies — exactly like CONTROL SURFACE. A slot stores only
//   {moduleId, paramId, name?}; the proxied Knob reads + writes the source
//   node's live param (patch.nodes[moduleId].params[paramId]) and is keyed for
//   MIDI by the same moduleId:paramId, so a MIDI assignment / edit on the proxy
//   is the same as on the source. The source stays live even when collapsed in
//   a Group, so proxies keep working when the underlying module is folded away.
//
// IO
//   Inputs: none. Outputs: none. Params: none. Meta domain: no engine binding —
//   all persistent state lives on the node's `data` (Yjs-synced), see
//   $lib/graph/electra-control.ts (ElectraControlData.slots).
//
// FLASH
//   Reuses the ENTIRE Electra flash pipeline (generatePreset / Allocator /
//   boundsForPotSet / broker / autoconfig / feedback). The only new bit is a
//   positional emit: ElectraControl feeds its bindings at their FIXED slots
//   (skipping empties, no per-module group headers) so each control lands on the
//   exact (controlSetId, potId) derived from electraPosOfSlot(slot). When an
//   ElectraControl is present it is PREFERRED over a CONTROL SURFACE for page 1
//   (it is the explicit, fixed-layout surface).

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const ELECTRA_CONTROL_TYPE = 'electraControl';

export const electraControlDef: MetaModuleDef = {
  type: ELECTRA_CONTROL_TYPE,
  palette: { top: 'Hybrid', sub: 'Hybrid' }, // sits beside CONTROL SURFACE
  domain: 'meta',
  label: 'ELECTRA CONTROL',
  category: 'tools',
  card: 'ElectraControlCard',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
};
