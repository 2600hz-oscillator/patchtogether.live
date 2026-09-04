// packages/web/src/lib/meta/modules/electra-control.ts
//
// ELECTRA CONTROL — a specialized CONTROL SURFACE variant laid out EXACTLY for
// the Electra One physical control scheme. Where CONTROL SURFACE is a dynamic,
// first-seen, auto-grouped panel, ElectraControl is a FIXED positional 6×6 grid
// (36 slots, never dynamic): 6 rows × 6 knobs, with the rows grouped into three
// 2-row banks — TOP (Row1-2), MID (Row3-4), BOT (Row5-6) — that mirror the
// Electra One's three stacked 12-pot control sets. (Those three strings are the
// SHIPPED bank labels and the ones the specs assert; this header used to say
// MIDDLE / BOTTOM, which is what the banks are called nowhere.)
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
//                                         //   (MID), 5-6 → set 3 (BOT)
//   potId        = (row odd ? 0 : 6) + knob  // odd row = a band's TOP sub-row
//                                            //   (pots 1-6); even row = its
//                                            //   BOT sub-row (pots 7-12)
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
// CONTROL COLOUR (passthrough): each filled slot shows a thin COLOUR STRIPE =
//   the SOURCE module's "control colour" (right-click a module → "Assign control
//   color"; unassigned modules get a stable auto colour). And the FLASH threads
//   that colour onto the Electra One control bars (the device renders the best
//   RGB565 approximation). The colour is NEVER stored on the slot/electra node —
//   it is resolved live from the source each render / each preset regenerate
//   (passthrough). See $lib/graph/control-color.ts.
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
  label: 'electra control',
  category: 'tools',
  inputs: [],
  outputs: [],
  params: [],
  // SINGLETON — exactly one ElectraControl per rack. The face owns the "Send to
  // Electra" action, which generates ONE 3-page preset from the whole rack, so a
  // second surface would be redundant + ambiguous. Enforced at three layers
  // (palette filter, Canvas spawn guard, engine.addNode defensive check). It
  // stays DELETABLE (no `undeletable`), unlike TIMELORDE — a deletable singleton
  // is auto-covered by the deterministic post-merge singleton cleanup.
  maxInstances: 1,

  // ── THE FLASH, DECLARED AS A ONE-MEMBER FAMILY ────────────────────────────
  //
  // push2Control's and launchpadControlLeft's route, and for a meta def it is
  // the ONLY route: `params` is empty by construction (no engine, no ports), so
  // every key `face.order` can ever hold is a NON-param key, and
  // module-face-lint legitimizes one exactly two ways — a `<familyId>-{n}`
  // template whose prefix is a family DECLARED here, or an entry in a committed
  // `<type>.legend.json`, of which three exist in the whole repo and none is
  // this module's. Without this the face could rank NOTHING; `order: []` is
  // legal and paints a BLANK TILE, which is worse than the legacy card it
  // replaces — the matrixMix lesson, restated in midiLane's promotion note.
  //
  // ⚠ EXACTLY ONE FAMILY IS DECLARED, and the ceiling is a GATE rather than a
  // preference: module-face-lint requires every declared family to appear in
  // `face.order` AND the dock plan to render it exactly once. A family is a
  // promise to RANK, not a vocabulary list — declaring the thirty-six slots or
  // their rename fields here would force them into cells they cannot be, for
  // the addressability reason the extension file gives in full.
  //
  // The `testidPrefix` is a literal the LEGACY BUTTON already emits
  // (`ElectraConnectButton.svelte`, `data-testid="electra-connect-button"`),
  // which is what module-docs-lint's card grep checks — so a rename on either
  // surface is RED. The card file survives promotion: `?shell=legacy` still
  // renders it, and `electra-control.spec.ts` still drives it there.
  controlFamilies: [
    {
      id: 'electra-connect-button',
      label: 'Send',
      kind: 'other',
      testidPrefix: 'electra-connect-button',
    },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR: this is the only module in the fleet whose subject is OTHER
  // MODULES. It is a 6×6 board of thirty-six named holes; you fill a hole by
  // right-clicking any knob anywhere in the rack and sending it here, and it
  // stores POINTERS, not values — a slot is `{ moduleId, paramId, name? }`, so a
  // filled slot is a live proxy onto the real control. The verb a player
  // performs is LAY OUT THE BOARD: you are not performing here, you are deciding
  // what your hands will find when you reach for the hardware. The second half
  // is what makes the layout matter at all — the grid IS the preset the Electra
  // One is flashed with, and the geometry is fixed and positional because the
  // device's is.
  //
  // THE LADDER, read back as a sentence: at every tier you get the gesture the
  // board is inert without — SEND TO ELECTRA, which is what turns thirty-six
  // pointers into a preset on a physical panel; at the dock and in the drawer
  // you additionally get the board itself, all thirty-six places, the live
  // source colours, the proxied knobs and the per-slot rename.
  //
  // ⚠ WHY SEND IS THE ONE RANKED CELL. It is the only gesture on this module
  // that is unconditional and always meaningful: it needs no slot to be filled
  // (an empty preset is a legal, useful reset of the panel), it does not change
  // meaning between presses, and it is the ONLY thing here that reaches outside
  // the browser. Everything else on the surface is a proxy of another module's
  // param, which no `face.order` key can address at all — that is the
  // definitional reason this module needs a body rather than a ranking, and it
  // is a mechanism rather than a ranking judgement.
  //
  // ⚠ `glyph: 'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN, and
  // the premise is true by inspection rather than by luck: `outputs` is EMPTY,
  // so `primaryAudioOutPortId` (`outputs.find(o => o.type === 'audio')`)
  // resolves null and every live-audio binding short-circuits; 'envelope' needs
  // a/d/s/r params and there are none. Each falls to `{kind:'static'}`, which
  // module-face-lint reddens by name (#1692) with no exemption list.
  // 'algorithm' would resolve — it accepts a `face.extension` — but
  // `ShellExtensionGlyphProps` carries `num`/`numbers`/`testid` and NO nodeId,
  // so every instance would draw the same picture while the only useful glance
  // here ("what is on the board") is per-node slot state.
  //
  // ⚠ NO `pages`. One ranked cell is one band, and a section header reading
  // "surface" over a single cell captioned "Send to Electra" adds a ~81 px band
  // to say nothing the cell has not said. `face.pages` is for a face with more
  // than one IDEA in it, and `DOCK_TAB_MIN_BANDS` is 7 — nothing here is padded
  // toward a rail.
  //
  // ⚠ AND THE BANDS BELOW THE BODY ARE NOT EMPTY, WHICH IS WORTH SAYING
  // BECAUSE THE SLOT'S OWN DOC WARNS ABOUT EXACTLY THAT. `shell-extensions.ts`
  // records that wiring `fullViewBody` as a REPLACEMENT for the faceplate "would
  // make the first adopter lose every one of its controls — the warrensspectrum
  // failure this seam exists to prevent". It paints ABOVE the bands and the
  // bands are untouched; here that band carries SEND, so the plate is a board
  // over a gesture rather than a board over nothing.
  //
  // ⚠ NO `rear` GROUPS: `inputs` and `outputs` are both empty, so there is no
  // jack for a group to name and module-face-lint refuses a group that resolves
  // to no port at all.
  //
  // The thirty-six proxies, the three bank labels, the live source-colour
  // stripes, the per-slot rename and the always-rendered empty places are the
  // extension's `fullViewBody` — see
  // $lib/ui/modules/electraControl/shell-extension.ts.
  face: {
    glyph: 'none',
    order: ['electra-connect-button-{n}'],
    extension: 'electraControl',
  },
};
