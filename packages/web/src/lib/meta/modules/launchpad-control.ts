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
  size: '1u', // compact "wide 1u" — measured natural height ≤ 180px
  hp: 2,
  inputs: [],
  outputs: [],
  params: [],

  // ── THE TWO HANDSHAKES, DECLARED AS ONE-MEMBER FAMILIES ───────────────────
  //
  // matrixMix's route, and for a meta def it is the ONLY route: `params` is
  // empty by construction, so every key `face.order` can hold is a NON-param
  // key, and module-face-lint legitimizes one only as a declared family
  // template or a committed `.legend.json` entry. Without these the face could
  // rank nothing at all.
  //
  // ⚠ ONLY THE TWO RANKED GESTURES ARE DECLARED, and the ceiling is the
  // completeness gate rather than a preference: module-face-lint requires EVERY
  // declared `controlFamily` to appear in `face.order` and the dock plan to
  // render each exactly once. So a family is a promise to rank, not a
  // vocabulary list — declaring BIND and the VIEW segment here (they live in
  // the extension body, for the reasons that file gives) would force them into
  // cells they cannot be.
  //
  // Each `testidPrefix` is a literal the LEGACY CARD already emits
  // (`LaunchpadControlCard.svelte:150`, `:165`), which is what
  // module-docs-lint's card grep checks — so a rename on either surface is red.
  // The card file survives promotion: `?shell=legacy` still renders it.
  controlFamilies: [
    { id: 'launchpad-control-single', label: 'Single', kind: 'other', testidPrefix: 'launchpad-control-single' },
    { id: 'launchpad-control-pair', label: 'Pair', kind: 'other', testidPrefix: 'launchpad-control-pair' },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR: this module is the only thing that puts a physical Novation
  // Launchpad in charge of a clip-player. The verb a player performs on it is
  // BIND A DEVICE — everything on the plate serves that one act, which is why
  // there is one band and no tab rail (`DOCK_TAB_MIN_BANDS` is 7 and nothing
  // here is padded toward it).
  //
  // THE LADDER, read back as a sentence: at the tightest tier you get the
  // gesture that a player with ONE Launchpad can actually complete; one tier up
  // you also get the two-unit handshake; at the dock you additionally get the
  // binding, the single-unit role segment, the hardware errors and the two
  // lamps.
  //
  // ⚠ SINGLE RANKS ABOVE PAIR, and the argument is a MEASURED asymmetry rather
  // than a preference between two equals. The failure modes are not
  // symmetrical: press SINGLE with two units plugged in and you get a working
  // single-unit binding (recoverable in one press — PAIR is right there), but
  // press PAIR with one unit plugged in and `startPairing` returns false on
  // `ports.length < 2` and the only thing that says so is the `one-unit` error
  // — which lives on the dock body. So a mini tile showing only PAIR is a dead
  // end for the one-unit player, and a mini tile showing only SINGLE is not a
  // dead end for anybody. The def's own header agrees on the merits ("single
  // mode is a first-class deployment with the full feature set"), but the
  // reachability argument is the one that would be WRONG for a different module
  // and is therefore the one that decides it.
  //
  // ⚠ `glyph: 'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN.
  // `glyphBinding` resolves 'scope'/'meter'/'waveform' through
  // `primaryAudioOutPortId`, which is `outputs.find(o => o.type === 'audio')`
  // and this def has NO outputs at all; 'envelope' needs a/d/s/r params and
  // there are none. Each falls to `{kind:'static'}`, which module-face-lint
  // reddens by name (#1692). 'algorithm' would resolve — it accepts a
  // `face.extension` — but taking it means shipping a glyph COMPONENT, and
  // `ShellExtensionGlyphProps` carries `num`/`numbers`/`testid` and NO nodeId,
  // so every instance would draw the same picture while the only useful glance
  // here ("is a Launchpad attached, and to which clip-player") is per-node
  // binding state. That is the fifth module to reach this conclusion and no new
  // glyph kind is invented for it. Declaring 'none' also buys the compact tier
  // a third control slot (`faceTierCap`), which this face does not need.
  //
  // The BIND control, the four-role VIEW segment, the hardware errors and the
  // lamps are `face.extension`'s `fullViewBody` — see
  // $lib/ui/modules/launchpadControl/shell-extension.ts for why each one cannot
  // be a cell.
  face: {
    glyph: 'none',
    order: ['launchpad-control-single-{n}', 'launchpad-control-pair-{n}'],
    extension: 'launchpadControl',
  },
};
