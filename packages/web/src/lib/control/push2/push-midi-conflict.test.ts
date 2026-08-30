// packages/web/src/lib/control/push2/push-midi-conflict.test.ts
//
// THE MIDI CONFLICT MAP — the owner's explicit ask for the ElectraControl-mode
// work: "we need to make sure our midi implementations for this, and also
// generally for grid and how we assign things in electracontrol, do not
// conflict."
//
// FOUR independent collision surfaces, each gated separately because each has a
// different failure mode:
//
//   1. CC ↔ CC, WITHIN the Push, in BOTH modes. A full 0..127 sweep of the
//      SHIPPING classifier against a NAMED ledger. Deny by default AND anchored
//      to the artifact: an undeclared binding is RED and a stale ledger row is
//      RED, so the ledger keys and the live bound set are held EQUAL BY NAME.
//   2. CC ↔ NOTE, within the Push. Push scene CCs 36..43 and pad notes 36..43
//      share numbers. Asserted to be a non-collision through the CODEC, not by
//      argument.
//   3. Push CC ↔ ELECTRA-allocation CC. The Electra One's generated preset
//      allocates CCs from 0 upward, so it genuinely overlaps the Push's map.
//      Asserted NON-EMPTY so the observation cannot go vacuous. Whether that
//      overlap is HARMFUL is decided by inbound routing, which this file does
//      not own — see the scope note below.
//   4. A DUPLICATED CC LITERAL IN AN E2E SPEC. Added after one shipped: a spec
//      that re-types a CC keeps testing the OLD binding after a rename, silently.
//
// ── RETIRED: the inbound-attachment surface ───────────────────────────────
//
// An earlier revision carried a fifth surface — an `ATTACH_LEDGER` source-shape
// gate over every `MIDIInput.onmidimessage` assignment. It is GONE, superseded
// by `midi-input-ownership.test.ts` (the shared input fan-out), which covers
// strictly more: it adds the per-subscriber FILTER column, and the filter — not
// the assignment count — is what actually decides device collisions.
//
// ⚠ IT WAS ALSO WRONG ABOUT THE CONSEQUENCE, and the correction matters more
// than the deletion. The ledger inferred from "N subscribers null every input"
// that touching a MIDI LANE would SILENCE the Push. Measured in Chromium with
// the Push attached, that does not happen: `requestMIDIAccess()` returns a
// DISTINCT MIDIAccess per call, `a1.inputs.get(id) === a2.inputs.get(id)` is
// FALSE for every port, and a destructive sweep over one access leaves the
// other's handler installed. The ledger read the source shape correctly and the
// runtime consequence incorrectly — it did flag that inference as unverified,
// which is the only reason it was caught rather than believed.
//
// NOTHING BELOW RESTS ON THE SILENCING PREMISE. Where the old text used it to
// argue surface 3 was harmless, surface 3 now states what it actually proves and
// hands the routing question to the file that owns it.
//
// ── WHAT THIS FILE STRUCTURALLY CANNOT SEE ────────────────────────────────
//
// Stated so a green run is not read as more than it is:
//   · It cannot confirm which PHYSICAL control sends a given CC. Nothing in CI
//     can. Two Push buttons have now shipped on a wrong CC from paper
//     inference; the surviving unconfirmed one is the scroll encoder (CC 15).
//   · It reads the Push's own dispatch and the Electra's GENERATED allocation.
//     It does not model a user's hand-learned MIDI bindings (midi-learn stores
//     those per-rack in the Y.Doc), which can name any CC on any device.
//   · IT DOES NOT MODEL INBOUND ROUTING AT ALL — which subscriber receives which
//     device's stream. That is `midi-input-ownership.test.ts`. So this file can
//     say two CC numbers collide; it cannot say whether a message ever reaches
//     the wrong handler.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPush2,
  encoderTarget,
  isEncoderCc,
  push2FrameToLeds,
  PUSH_CC_ENCODER_TEMPO,
  PUSH_CC_ELECTRA_MODE,
  PUSH_CC_LEGEND,
  PUSH_CC_SHIFT,
  PUSH_CC_SCENE_BASE,
  PUSH_CC_ENCODER_SWING,
  PUSH_CC_ENCODER_MASTER,
  type Push2Action,
  type PushEncoderTarget,
} from './push2-map';
import { decodePush2Message, pushPadNote } from './push2-sysex';
import { electraModeEncoder } from './push-electra-model';
import { generatePreset } from '$lib/electra/preset';

// ---------------------------------------------------------------------------
// Role derivation — every string below comes from the SHIPPING dispatch, never
// from a parallel table. That is what makes the ledger a check rather than a
// second copy of the map.
// ---------------------------------------------------------------------------

function encRoleBase(t: PushEncoderTarget): string {
  switch (t.kind) {
    case 'strip':
      return `card-strip-${t.index + 1}`;
    case 'moduleScroll':
      return 'card-scroll';
    case 'master':
      return 'master-volume';
  }
}

function encRoleElectra(t: PushEncoderTarget): string {
  const r = electraModeEncoder(t);
  switch (r.kind) {
    case 'knob':
      return `electra-knob-${r.knob}`;
    case 'rowScroll':
      return 'electra-row-scroll';
    case 'master':
      return 'master-volume';
    case 'inert':
      return 'INERT';
  }
}

function roleOf(a: Push2Action | null, electra: boolean): string | null {
  if (!a) return null;
  switch (a.kind) {
    case 'launchpad':
      return a.ev.type === 'top'
        ? `launchpad-top-${a.ev.cc}`
        : a.ev.type === 'scene'
          ? `launchpad-scene-row-${a.ev.row}`
          : 'launchpad-pad';
    case 'selectChannel':
      return `select-lane-${a.channel + 1}`;
    case 'dpad':
      return `dpad-${a.dir}`;
    case 'legend':
      return 'legend-hold';
    case 'electraMode':
      return 'electra-mode-toggle';
    case 'encoder':
      return `encoder:${electra ? encRoleElectra(a.target) : encRoleBase(a.target)}`;
  }
}

/** What CC `cc` does, as the shipping code would handle a PRESS of it. */
function roleForCc(cc: number, electra: boolean): string | null {
  // 127 is a button press AND a legal relative-encoder value (−1 detent), so the
  // one probe reaches both branches of the classifier.
  return roleOf(classifyPush2({ type: 'cc', cc, s: 1, value: 127 }), electra);
}

// ---------------------------------------------------------------------------
// 1 — THE CC LEDGER. Every CC the Push binds, in both modes. Deny by default:
// a CC that dispatches but is absent here is RED, and an entry naming a CC that
// dispatches nothing is RED too.
// ---------------------------------------------------------------------------

interface LedgerRow {
  base: string;
  electra: string;
  note: string;
}

const CC_LEDGER: Record<number, LedgerRow> = {
  // ── permanent-controls row (below the display) → Launchpad top row 91..98 ──
  20: { base: 'launchpad-top-91', electra: 'launchpad-top-91', note: 'transport' },
  21: { base: 'launchpad-top-92', electra: 'launchpad-top-92', note: 'view' },
  22: { base: 'launchpad-top-93', electra: 'launchpad-top-93', note: 'view' },
  23: { base: 'launchpad-top-94', electra: 'launchpad-top-94', note: 'view' },
  24: { base: 'launchpad-top-95', electra: 'launchpad-top-95', note: 'view' },
  25: { base: 'launchpad-top-96', electra: 'launchpad-top-96', note: 'undo' },
  26: { base: 'launchpad-top-97', electra: 'launchpad-top-97', note: 'redo' },
  27: {
    base: 'launchpad-top-98',
    electra: 'launchpad-top-98',
    note: 'THE SHIFT MODIFIER — ×8 window, encoder fine-nudge, arm gestures, legend shift layer',
  },
  // ── scene-launch column, right of the grid (TOP 43 … BOTTOM 36) ──
  36: { base: 'launchpad-scene-row-0', electra: 'launchpad-scene-row-0', note: 'bottom scene button' },
  37: { base: 'launchpad-scene-row-1', electra: 'launchpad-scene-row-1', note: 'scene' },
  38: { base: 'launchpad-scene-row-2', electra: 'launchpad-scene-row-2', note: 'scene' },
  39: { base: 'launchpad-scene-row-3', electra: 'launchpad-scene-row-3', note: 'scene' },
  40: { base: 'launchpad-scene-row-4', electra: 'launchpad-scene-row-4', note: 'scene' },
  41: { base: 'launchpad-scene-row-5', electra: 'launchpad-scene-row-5', note: 'scene' },
  42: { base: 'launchpad-scene-row-6', electra: 'launchpad-scene-row-6', note: 'scene' },
  43: { base: 'launchpad-scene-row-7', electra: 'launchpad-scene-row-7', note: 'top scene button' },
  // ── D-Pad ──
  44: { base: 'dpad-left', electra: 'dpad-left', note: 'clip-view nav (SHIFT = ×8)' },
  45: { base: 'dpad-right', electra: 'dpad-right', note: 'clip-view nav (SHIFT = ×8)' },
  46: { base: 'dpad-up', electra: 'dpad-up', note: 'clip-view nav (SHIFT = ×8)' },
  47: { base: 'dpad-down', electra: 'dpad-down', note: 'clip-view nav (SHIFT = ×8)' },
  // ── the two lower-right buttons ──
  // LEGEND's CC is keyed off the CONSTANT, not a literal: it is being corrected
  // on hardware evidence in a PR in flight (28 → 48), and a literal here would
  // make this ledger red on whichever side of that merge it landed. The number
  // is not the claim — "one CC, owned by LEGEND, in both modes" is.
  [PUSH_CC_LEGEND]: {
    base: 'legend-hold',
    electra: 'legend-hold',
    note: 'LEGEND — momentary, display-only, wins over electra mode for the screen',
  },
  49: {
    base: 'electra-mode-toggle',
    electra: 'electra-mode-toggle',
    note: 'the button LABELLED "Shift" — latched ElectraControl mode. NOT the shift modifier (that is CC 27)',
  },
  // ── the scroll encoder ──
  15: {
    base: 'encoder:card-scroll',
    electra: 'encoder:electra-row-scroll',
    note: 'ONE knob, one job: step the list on screen. Physical position UNCONFIRMED — bound by function',
  },
  // ── the 8 display encoders ──
  71: { base: 'encoder:card-strip-1', electra: 'encoder:electra-knob-1', note: 'display encoder 1' },
  72: { base: 'encoder:card-strip-2', electra: 'encoder:electra-knob-2', note: 'display encoder 2' },
  73: { base: 'encoder:card-strip-3', electra: 'encoder:electra-knob-3', note: 'display encoder 3' },
  74: { base: 'encoder:card-strip-4', electra: 'encoder:electra-knob-4', note: 'display encoder 4' },
  75: { base: 'encoder:card-strip-5', electra: 'encoder:electra-knob-5', note: 'display encoder 5' },
  76: { base: 'encoder:card-strip-6', electra: 'encoder:electra-knob-6', note: 'display encoder 6' },
  77: { base: 'encoder:card-strip-7', electra: 'encoder:INERT', note: 'display encoder 7 — UNASSIGNED in electra mode' },
  78: { base: 'encoder:card-strip-8', electra: 'encoder:INERT', note: 'display encoder 8 — UNASSIGNED in electra mode' },
  79: { base: 'encoder:master-volume', electra: 'encoder:master-volume', note: 'master encoder — unchanged in both modes' },
  // ── dedicated transport / undo ──
  85: { base: 'launchpad-top-91', electra: 'launchpad-top-91', note: 'Play → transport (also reachable at CC 20)' },
  119: { base: 'launchpad-top-96', electra: 'launchpad-top-96', note: 'Undo (also reachable at CC 25)' },
  // ── lane select, above the display ──
  102: { base: 'select-lane-1', electra: 'select-lane-1', note: 'push-local lane select' },
  103: { base: 'select-lane-2', electra: 'select-lane-2', note: 'push-local lane select' },
  104: { base: 'select-lane-3', electra: 'select-lane-3', note: 'push-local lane select' },
  105: { base: 'select-lane-4', electra: 'select-lane-4', note: 'push-local lane select' },
  106: { base: 'select-lane-5', electra: 'select-lane-5', note: 'push-local lane select' },
  107: { base: 'select-lane-6', electra: 'select-lane-6', note: 'push-local lane select' },
  108: { base: 'select-lane-7', electra: 'select-lane-7', note: 'push-local lane select' },
  109: { base: 'select-lane-8', electra: 'select-lane-8', note: 'push-local lane select' },
};

/** CCs that are a real physical control but deliberately route NOWHERE. Listed
 *  so "classifies to null" cannot silently mean "we forgot it". */
const DELIBERATELY_UNBOUND: Record<number, string> = {
  [PUSH_CC_ENCODER_TEMPO]: 'tempo encoder — a global tempo control is a separate decision (obvious home: timelorde bpm)',
};

// ⚠ `BOUND_CC_COUNT` (42) IS GONE (2026-08-10), and so is the test whose whole
// body was the count — 'RATCHETS IN BOTH DIRECTIONS — the count cannot drift up
// OR down unnoticed'. It counted the keys of `CC_LEDGER`, a list the two
// assertions immediately below already pin NAME BY NAME, in both directions:
//
//   · 'DENY BY DEFAULT — every dispatching CC is in the ledger with its exact
//     roles' gives   bound ⊆ ledger   (a live binding with no row is RED);
//   · 'ANCHORED TO THE ARTIFACT — a ledger entry for a CC that dispatches
//     nothing is RED' gives   ledger ⊆ bound   (a row for a dead binding is RED).
//
// Two inclusions are SET EQUALITY. So `bound.size <= 42`,
// `42 - bound.size === 0` and `Object.keys(CC_LEDGER).length === 42` were all
// true by construction on any tree where those two were green — the number could
// not go red, only go stale. WHAT IT PROTECTED (a binding silently added or
// silently removed) is carried entirely by that pair, and they name WHICH CC
// moved instead of reporting that a total did.
//
// The one place the number was load-bearing is the NEGATIVE CONTROL at the
// bottom of this block: every name-anchored assertion above is satisfied
// vacuously by a sweep that found nothing at all. That leg survives in DERIVED
// form — `boundBase.size` is compared to `Object.keys(CC_LEDGER).length`, read
// off the ledger rather than re-typed, so there is no literal to keep in sync.

describe('1 — the Push CC map: no CC has two owners, in either mode', () => {
  const boundBase = new Map<number, string>();
  const boundElectra = new Map<number, string>();
  for (let cc = 0; cc < 128; cc++) {
    const b = roleForCc(cc, false);
    const e = roleForCc(cc, true);
    if (b !== null) boundBase.set(cc, b);
    if (e !== null) boundElectra.set(cc, e);
  }

  it('DENY BY DEFAULT — every dispatching CC is in the ledger with its exact roles', () => {
    const undeclared: string[] = [];
    for (const [cc, role] of boundBase) {
      const row = CC_LEDGER[cc];
      if (!row) {
        undeclared.push(`CC ${cc} dispatches "${role}" (base) with NO ledger entry`);
        continue;
      }
      if (row.base !== role) undeclared.push(`CC ${cc} base: ledger says "${row.base}", map says "${role}"`);
    }
    for (const [cc, role] of boundElectra) {
      const row = CC_LEDGER[cc];
      if (!row) {
        undeclared.push(`CC ${cc} dispatches "${role}" (electra) with NO ledger entry`);
        continue;
      }
      if (row.electra !== role) {
        undeclared.push(`CC ${cc} electra: ledger says "${row.electra}", map says "${role}"`);
      }
    }
    expect(undeclared, undeclared.join('\n')).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT — a ledger entry for a CC that dispatches nothing is RED', () => {
    // A stale exemption is one nobody is watching. This is the direction that
    // catches a binding silently deleted rather than one silently added.
    const stale = Object.keys(CC_LEDGER)
      .map(Number)
      .filter((cc) => !boundBase.has(cc) && !boundElectra.has(cc))
      .map((cc) => `CC ${cc} is in the ledger but dispatches nothing in either mode`);
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('the two modes bind the SAME CC SET — entering the mode strands no button', () => {
    // This is the guarantee behind "everything else routes exactly as before".
    // If electra mode ever silently swallowed a button, these sets diverge.
    expect([...boundElectra.keys()].sort((a, b) => a - b)).toEqual([...boundBase.keys()].sort((a, b) => a - b));
  });

  it('ONLY the display + scroll encoders change meaning between the modes', () => {
    const changed = [...boundBase.keys()]
      .filter((cc) => boundBase.get(cc) !== boundElectra.get(cc))
      .sort((a, b) => a - b);
    // 71..76 → electra knobs, 77/78 → inert, 15 → row scroll. Nothing else.
    expect(changed).toEqual([15, 71, 72, 73, 74, 75, 76, 77, 78]);
  });

  it('a deliberately-unbound physical control is DECLARED, not merely silent', () => {
    for (const [ccStr, why] of Object.entries(DELIBERATELY_UNBOUND)) {
      const cc = Number(ccStr);
      expect(why.length, `CC ${cc} needs a reason`).toBeGreaterThan(10);
      expect(roleForCc(cc, false), `CC ${cc} routes somewhere now — update the ledger`).toBeNull();
      expect(roleForCc(cc, true)).toBeNull();
      // …and it IS a real encoder, which is what makes it worth declaring.
      expect(isEncoderCc(cc)).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the sweep really does see bindings', () => {
    // Without this, every assertion above would pass against an empty map: both
    // inclusions hold trivially when one side is empty. DERIVED, not typed — the
    // expected size is read off the ledger, so this leg has no number of its own
    // to go stale (it was `BOUND_CC_COUNT`, deleted 2026-08-10, see above).
    expect(boundBase.size).toBe(Object.keys(CC_LEDGER).length);
    expect(boundBase.get(PUSH_CC_SHIFT)).toBe('launchpad-top-98');
    expect(boundBase.get(PUSH_CC_ELECTRA_MODE)).toBe('electra-mode-toggle');
    expect(roleForCc(0, false), 'an unbound CC really reads as null').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 — CC ↔ NOTE. Push scene CCs 36..43 and pad notes 36..43 share numbers.
// ---------------------------------------------------------------------------

describe('2 — the CC/NOTE number overlap is a non-collision, proven through the codec', () => {
  it('the SAME data byte decodes to a pad or a scene depending ONLY on the status byte', () => {
    for (let i = 0; i < 8; i++) {
      const n = PUSH_CC_SCENE_BASE + i; // 36..43 — legal as both a CC and a note
      const asCc = decodePush2Message([0xb0, n, 127]);
      const asNote = decodePush2Message([0x90, n, 100]);
      expect(asCc).toEqual({ type: 'cc', cc: n, s: 1, value: 127 });
      expect(asNote?.type).toBe('pad');
      // …and they classify to genuinely different actions.
      expect(classifyPush2(asCc!)?.kind).toBe('launchpad');
      expect(roleOf(classifyPush2(asCc!), false)).toBe(`launchpad-scene-row-${i}`);
      expect(roleOf(classifyPush2(asNote!), false)).toBe('launchpad-pad');
    }
  });

  it('NEGATIVE CONTROL: the overlap is REAL, so the exemption is not vacuous', () => {
    // If the two number spaces stopped overlapping this test would still pass on
    // its own terms while proving nothing. Assert the collision exists.
    const sceneCcs = new Set(Array.from({ length: 8 }, (_, i) => PUSH_CC_SCENE_BASE + i));
    const padNotes = new Set(Array.from({ length: 64 }, (_, i) => pushPadNote(i % 8, Math.floor(i / 8))));
    const shared = [...sceneCcs].filter((n) => padNotes.has(n));
    expect(shared).toEqual([36, 37, 38, 39, 40, 41, 42, 43]);
  });
});

// ---------------------------------------------------------------------------
// 3 — Push CC ↔ ELECTRA-allocation CC. A LATENT overlap: the numbers really do
// collide; whether a message crosses is an inbound-ROUTING question this file
// does not own.
// ---------------------------------------------------------------------------

describe('3 — Push CCs vs the Electra One preset allocation', () => {
  const generated = generatePreset({
    surfaceBindings: [
      { moduleId: 'vco1', paramId: 'cutoff', slot: 0 },
      { moduleId: 'vco1', paramId: 'res', slot: 1 },
    ],
    moduleLabel: () => 'vco',
    resolveParamDef: (_m, p) => ({ id: p, label: p, min: 0, max: 1, defaultValue: 0.5, curve: 'linear' }),
    mixmstrsId: 'mx1',
    timelordeId: 'tl1',
  });
  const electraCcs = new Set(
    generated.allocations.filter((a) => a.messageType !== 'note').map((a) => a.number),
  );
  const pushCcs = new Set(Object.keys(CC_LEDGER).map(Number));

  it('THE NUMBERS DO OVERLAP — stated as a fact, not waved away', () => {
    // The generator allocates from 0 upward, so it walks straight through the
    // Push's permanent row and scene column. This assertion exists so the
    // observation below can never become vacuous by the overlap disappearing.
    const shared = [...electraCcs].filter((n) => pushCcs.has(n)).sort((a, b) => a - b);
    expect(shared.length).toBeGreaterThan(5);
    expect(shared).toContain(PUSH_CC_SHIFT); // CC 27 is allocated by the Electra too
  });

  it('the overlap reaches the CONTROL-CARRYING CCs, not just spare numbers', () => {
    // WHY THIS IS SHARPER THAN A COUNT. An earlier revision concluded the
    // overlap was "nominal — two devices, two handlers, two number spaces that
    // never meet". That was WRONG, and wrong in the opposite direction from the
    // one it worried about: the risk is CROSSTALK, not silencing.
    //
    // `ElectraBroker.attachInputs()` claimed EVERY input and filtered only by
    // status byte, and `ElectraAutoconfig.handleCc` writes the bound rack param
    // straight off the CC NUMBER. With an Electra connected, a Push encoder
    // could therefore move an Electra-mapped parameter. So the numbers that
    // matter are the ones the Push actually SENDS while being turned — the
    // encoders and the permanent row — not the total size of the intersection.
    const shared = new Set([...electraCcs].filter((n) => pushCcs.has(n)));
    const liveOnThePush = [
      PUSH_CC_ENCODER_SWING, // 15 — the scroll encoder
      ...Array.from({ length: 8 }, (_, i) => 20 + i), // 20..27 permanent row (incl. SHIFT)
      ...Array.from({ length: 8 }, (_, i) => 71 + i), // 71..78 display encoders
      PUSH_CC_ENCODER_MASTER, // 79
    ].filter((cc) => shared.has(cc));
    expect(liveOnThePush.length, 'the overlap is on controls the Push transmits').toBeGreaterThan(0);
  });

  it('SCOPE: whether that overlap is HARMFUL is decided elsewhere, and is asserted there', () => {
    // What this file CAN prove: the two number spaces intersect, and the Electra
    // side is structured per logical device / hardware port.
    expect(generated.allocations.every((a) => a.deviceId === 1 || a.deviceId === 2)).toBe(true);
    const ports = new Set(generated.preset.devices.map((d) => d.port));
    expect(ports.size).toBe(generated.preset.devices.length);
    // What it CANNOT prove, and must not claim: that a Push message never
    // reaches the Electra dispatch. That depends on which subscriber receives
    // which device's stream — inbound routing — which lives in the shared fan-out
    // and is gated by `midi-input-ownership.test.ts` (the per-subscriber FILTER
    // column). A numeric overlap is only ever a LATENT collision here; the
    // routing gate is what makes it latent rather than live.
    //
    // Deliberately NOT re-derived from the source shape: the previous attempt to
    // settle this question by counting `onmidimessage` assignment sites produced
    // a confident, plausible and FALSE conclusion in both directions. A guard
    // that cannot fire would be decoration; the scope note is the deliverable.
  });

  it('ELECTRA CONTROL mode drives the same slots the Electra flash reads', () => {
    // The Push mode and the preset generator both take the FIRST ElectraControl,
    // id-sorted, and both address it by storage slot. If they picked different
    // surfaces, turning a Push knob would move a control the hardware Electra is
    // not showing. Asserted at the seam they share: the generator's page-1 input
    // is keyed by `${moduleId}:${paramId}`, exactly what the Push writes.
    const keys = generated.allocations.filter((a) => a.role === 'rw').map((a) => a.key);
    expect(keys).toContain('vco1:cutoff');
    expect(keys).toContain('vco1:res');
  });
});

// ---------------------------------------------------------------------------
// 4 — A DUPLICATED CC LITERAL IS A GATE THAT CANNOT SEE A RENAME.
// ---------------------------------------------------------------------------
//
// Found the hard way on 2026-08-03. `push2-clip-launch.spec.ts` hardcoded seven
// Push CC literals, including `const CC_SHIFT = 49`. When SHIFT moved to CC 27,
// the spec kept pressing 49 — so the ×8 D-Pad gesture silently degraded to ×1
// and the spec went on asserting a contract that no longer existed. No unit test
// could catch it: the unit tests read the CONSTANT while the spec read a COPY.
//
// Same class as `RANGE_BOUND_CARDS` (a card re-typing a range its def declares)
// and `RAW_PARAM_WRITE` (a filter that redefined its own subject). A second
// source of truth for a binding does not fail on a rename — it quietly starts
// testing something else.
//
// SCOPE, stated inside the gate so an unstated scope cannot read as full
// coverage: this checks `e2e/tests/push2-*.spec.ts` ONLY. It deliberately does
// NOT flag the LAUNCHPAD specs, which legitimately declare `CC_SHIFT = 98` and
// `SCENE_CCS = [89, 79, …, 49, …]` — those are the LAUNCHPAD's own CC
// vocabulary, a different device, and 49 there is a scene button, not this
// button. Conflating the two is the exact confusion this file exists to prevent.

const E2E_TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../e2e/tests');

/** Every Push CC value the shipping map exports — the numbers a spec must not
 *  re-type. Derived from the ledger, which is itself derived from the map. */
const PUSH_CC_VALUES = new Set(Object.keys(CC_LEDGER).map(Number));

describe('4 — no Push e2e spec re-types a CC the map already owns', () => {
  const specs = readdirSync(E2E_TESTS_DIR)
    .filter((f) => /^push2-.*\.spec\.ts$/.test(f))
    .map((f) => ({ file: f, src: readFileSync(join(E2E_TESTS_DIR, f), 'utf8') }));

  it('NEGATIVE CONTROL: the gate actually found Push specs to check', () => {
    // Without this, a rename of the spec file would silently empty the sweep
    // and every assertion below would pass against nothing.
    expect(specs.length, `no push2-*.spec.ts under ${E2E_TESTS_DIR}`).toBeGreaterThan(0);
    expect(specs.map((s) => s.file)).toContain('push2-clip-launch.spec.ts');
  });

  // ⚠ THE SUBJECT IS "A SPEC THAT USES A CC", NOT "A SPEC WHOSE FILENAME STARTS
  // WITH push2-", AND THE DIFFERENCE IS NOT PEDANTIC. This leg used to require
  // the import from EVERY `push2-*.spec.ts`, which is a STATIC PROXY for the
  // dynamic thing the gate is actually about — the same "a proxy standing in
  // for the subject" shape this repo has been bitten by elsewhere. It held only
  // while every Push spec happened to drive MIDI.
  //
  // `push2-face.spec.ts` (the faceplate promotion, 2026-08-25) is the
  // counter-example: it drives the DOM — a ranked action cell, the lane
  // buttons, the view segment, BIND — and reads the control singleton's own
  // state. It contains no CC number of any kind, so there is nothing for it to
  // import and nothing it could re-type. Under the old predicate the only ways
  // to green it were to add an unused import or to RENAME THE FILE out of the
  // sweep, and both make the gate weaker: an unused import is noise a later
  // cleanup deletes, and a rename removes the file from leg 3 as well — the leg
  // that is the real gate.
  //
  // So the requirement is now conditional on the spec REFERENCING the Push CC
  // vocabulary at all, and the vacuity guard below is what stops that condition
  // from quietly emptying the sweep.
  const usesCc = (src: string) => /\bCC_|\bPUSH_CC_/.test(src);
  const ccSpecs = specs.filter((s) => usesCc(s.src));

  it('the CC-using subset is NOT EMPTY — the condition cannot silently skip everything', () => {
    // Without this, a refactor that stopped every spec naming a CC would empty
    // the leg below and it would pass against nothing.
    expect(
      ccSpecs.map((s) => s.file),
      'no push2-*.spec.ts references a Push CC — the import leg would be vacuous',
    ).toContain('push2-clip-launch.spec.ts');
  });

  it('every Push spec THAT USES A CC imports its numbers from push2-map', () => {
    for (const { file, src } of ccSpecs) {
      expect(src, `${file} must import the Push CC constants, not re-type them`).toMatch(
        /from '.*control\/push2\/push2-map'/,
      );
    }
  });

  it('NEGATIVE CONTROL for the condition — a CC-free spec is exempt, a CC-using one is not', () => {
    // The instrument, perturbed in BOTH directions, so "every spec passed" and
    // "no spec was checked" cannot look alike.
    expect(usesCc('await page.getByTestId("push2-face-lane-4-px").click();'), 'DOM-only').toBe(false);
    expect(usesCc('const CC_PLAY = PUSH_CC_PLAY;'), 'names a CC').toBe(true);
    expect(usesCc('await cc(CC_ENCODER_BASE, 3);'), 'uses an imported CC').toBe(true);
  });

  it('DENY BY DEFAULT — no `const CC_… = <a Push CC>` literal in a Push spec', () => {
    const offenders: string[] = [];
    for (const { file, src } of specs) {
      const decl = /const\s+(\w+)\s*=\s*(\d+)\s*;/g;
      for (let m = decl.exec(src); m; m = decl.exec(src)) {
        const [, name, valueStr] = m;
        const value = Number(valueStr);
        if (!/cc/i.test(name)) continue; // only CC-shaped constants
        if (!PUSH_CC_VALUES.has(value)) continue; // not a number the map owns
        offenders.push(
          `${file}: \`const ${name} = ${value}\` duplicates a Push CC the map owns — import it instead`,
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('NEGATIVE CONTROL for the detector — it catches the exact shape that broke', () => {
    // The instrument, perturbed: feed it the literal that actually shipped and
    // confirm it fires, and a non-Push number and confirm it does not. Without
    // this, "no offenders" could equally mean "the regex matches nothing".
    const probe = (src: string) => {
      const out: string[] = [];
      const decl = /const\s+(\w+)\s*=\s*(\d+)\s*;/g;
      for (let m = decl.exec(src); m; m = decl.exec(src)) {
        if (!/cc/i.test(m[1])) continue;
        if (!PUSH_CC_VALUES.has(Number(m[2]))) continue;
        out.push(m[1]);
      }
      return out;
    };
    expect(probe('const CC_SHIFT = 49;'), 'the literal that shipped').toEqual(['CC_SHIFT']);
    expect(probe('const CC_SHIFT = 27;'), 'the corrected literal is ALSO a duplicate').toEqual(['CC_SHIFT']);
    expect(probe('const CC_SHIFT = 98;'), 'a LAUNCHPAD CC is not a Push CC').toEqual([]);
    expect(probe('const TIMEOUT = 49;'), 'a non-CC constant is not a binding').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Outbound — the LED side of the same question.
// ---------------------------------------------------------------------------

describe('outbound: the ELECTRA-MODE button LED is Push-local, never a frame mirror', () => {
  it('no Launchpad frame can address CC 49', () => {
    const leds = push2FrameToLeds({
      leds: new Map<number, [number, number, number]>(
        // Every index the translator knows: the 8×8 grid, the top row and the
        // scene column. If ANY of them reached 49 the mode light would flicker
        // with the clip brain.
        [
          ...Array.from(
            { length: 64 },
            (_, i): [number, [number, number, number]] => [11 + Math.floor(i / 8) * 10 + (i % 8), [127, 0, 0]],
          ),
          ...Array.from({ length: 8 }, (_, i): [number, [number, number, number]] => [91 + i, [0, 127, 0]]),
          ...[89, 79, 69, 59, 49, 39, 29, 19].map(
            (cc): [number, [number, number, number]] => [cc, [0, 0, 127]],
          ),
        ],
      ),
    });
    const ccs = leds.filter((l) => l.kind === 'button').map((l) => (l as { cc: number }).cc);
    expect(ccs).not.toContain(PUSH_CC_ELECTRA_MODE);
    // NEGATIVE CONTROL: the frame really did paint buttons, including the
    // LAUNCHPAD scene CC 49 — which is a different vocabulary from Push CC 49
    // and must NOT be confused with it. That confusion is the whole point.
    expect(ccs.length).toBeGreaterThan(8);
    expect(ccs).toContain(PUSH_CC_SHIFT);
  });

  it('encoderTarget is total over the encoder CCs the ledger names', () => {
    for (const cc of Object.keys(CC_LEDGER).map(Number)) {
      if (!isEncoderCc(cc)) continue;
      expect(encoderTarget(cc), `CC ${cc} is an encoder with no target`).not.toBeNull();
    }
  });
});
