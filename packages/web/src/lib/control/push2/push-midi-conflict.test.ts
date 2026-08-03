// packages/web/src/lib/control/push2/push-midi-conflict.test.ts
//
// THE MIDI CONFLICT MAP — the owner's explicit ask for the ElectraControl-mode
// work: "we need to make sure our midi implementations for this, and also
// generally for grid and how we assign things in electracontrol, do not
// conflict."
//
// FIVE independent collision surfaces, each gated separately because each has a
// different failure mode:
//
//   1. CC ↔ CC, WITHIN the Push, in BOTH modes. A full 0..127 sweep of the
//      SHIPPING classifier against a NAMED ledger. Deny by default, ratcheted in
//      both directions, and stale entries are RED.
//   2. CC ↔ NOTE, within the Push. Push scene CCs 36..43 and pad notes 36..43
//      share numbers. Asserted to be a non-collision through the CODEC, not by
//      argument.
//   3. Push CC ↔ ELECTRA-allocation CC. The Electra One's generated preset
//      allocates CCs from 0 upward, so it genuinely overlaps the Push's map.
//      Asserted to be a cross-DEVICE overlap, and asserted NON-EMPTY so the
//      exemption cannot go vacuous.
//   4. WHO OWNS THE INPUT STREAM. The real one. `MIDIInput.onmidimessage` is a
//      SINGLE-SLOT property, and eight subsystems assign it — three claim EVERY
//      input and FOUR null every input. See ATTACH_LEDGER.
//   5. A DUPLICATED CC LITERAL IN AN E2E SPEC. Added after one shipped: a spec
//      that re-types a CC keeps testing the OLD binding after a rename, silently.
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
//   · Surface 4 is a SOURCE-SHAPE gate. It proves how many places assign the
//     handler and over what scope; it does not execute a browser MIDI stack.

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

/** Ratchet. Moves only when a binding is deliberately added or removed, and it
 *  is asserted in BOTH directions so a shrink that forgets to lower it is red. */
const BOUND_CC_COUNT = 42;

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

  it('RATCHETS IN BOTH DIRECTIONS — the count cannot drift up OR down unnoticed', () => {
    const bound = new Set([...boundBase.keys(), ...boundElectra.keys()]);
    expect(bound.size).toBeLessThanOrEqual(BOUND_CC_COUNT);
    expect(BOUND_CC_COUNT - bound.size, 'lower BOUND_CC_COUNT in the same commit').toBe(0);
    expect(Object.keys(CC_LEDGER)).toHaveLength(BOUND_CC_COUNT);
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
    // Without this, every assertion above would pass against an empty map.
    expect(boundBase.size).toBe(BOUND_CC_COUNT);
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
// 3 — Push CC ↔ ELECTRA-allocation CC. Numerically overlapping, on different
// devices.
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
    // exemption below can never become vacuous by the overlap disappearing.
    const shared = [...electraCcs].filter((n) => pushCcs.has(n)).sort((a, b) => a - b);
    expect(shared.length).toBeGreaterThan(5);
    expect(shared).toContain(PUSH_CC_SHIFT); // CC 27 is allocated by the Electra too
  });

  it('…and it is a CROSS-DEVICE overlap: neither dispatch can see the other stream', () => {
    // The Electra allocation is matched against `${messageType}:${number}` by
    // ElectraAutoconfig on the ELECTRA broker's inbound fan-out; the Push map is
    // matched by push2-device on the PUSH's bound input. Two devices, two
    // handlers, two number spaces that never meet — the collision is nominal.
    //
    // What makes that argument checkable rather than rhetorical is surface 4
    // below: it is only true while each subsystem reads its OWN input.
    expect(generated.allocations.every((a) => a.deviceId === 1 || a.deviceId === 2)).toBe(true);
    // The Electra's own two logical devices are on separate hardware PORTS, so
    // its CC stream is not even self-colliding across them.
    const ports = new Set(generated.preset.devices.map((d) => d.port));
    expect(ports.size).toBe(generated.preset.devices.length);
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
// 4 — WHO OWNS THE INPUT STREAM. The collision that is actually live.
// ---------------------------------------------------------------------------

const LIB_SOURCES = import.meta.glob('../../**/*.{ts,svelte}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Vite returns the SHORTEST relative key, so the same tree comes back as
 *  './x', '../y/x' and '../../a/b/x'. Resolve them all against this file's own
 *  directory so the ledger can be keyed on ONE spelling. */
function toLibPath(key: string): string {
  const segs = ['control', 'push2']; // this file's directory, relative to lib/
  for (const part of key.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  return segs.join('/');
}

/**
 * Every place that assigns `MIDIInput.onmidimessage`, on TWO axes.
 *
 * `onmidimessage` is a SINGLE-SLOT property (not `addEventListener`), so the
 * last assignment to a given input wins and silently displaces whoever held it.
 * Two different ways to hurt a neighbour, hence two fields:
 *
 *   · `claims`   — 'own-port' assigns only to a port this subsystem selected;
 *                  'every-port' iterates the whole MIDIAccess and takes the lot.
 *   · `detaches` — 'own-port' nulls only a handler it previously installed;
 *                  'every-port' nulls EVERY input before/after doing its work,
 *                  which tears down other subsystems that were not consulted;
 *                  'none' never detaches.
 *
 * ⚠ THE FINDING, recorded here because it is live and it is NOT introduced by
 * this PR: FOUR subsystems null EVERY input's handler. Three of them
 * (`midi-lane`, `midi-cv-buddy`, `midiclock`) do it on every device re-target
 * AND on `dispose()`. So spawning, re-pointing or deleting a MIDI LANE — the
 * default poly source — silently kills the Push 2's inbound stream, along with
 * the Launchpad's, the Electra's and MIDI-learn's. ElectraControl mode inherits
 * that hazard exactly as the rest of the Push integration already does.
 *
 * DENY BY DEFAULT: a new assignment site, or an existing one that changes
 * scope, is RED. This gate does NOT fix the hazard — a shared input fan-out is a
 * cross-subsystem refactor with real behaviour changes to MIDI-learn, the
 * external clock, three audio modules and the Electra, and it needs its own
 * hardware review. It makes the hazard impossible to grow silently, and it puts
 * the exact file list in front of whoever picks that work up.
 */
interface AttachRow {
  claims: 'own-port' | 'every-port';
  detaches: 'own-port' | 'every-port' | 'none';
  why: string;
}

const ATTACH_LEDGER: Record<string, AttachRow> = {
  'control/push2/push2-device.svelte.ts': {
    claims: 'own-port',
    detaches: 'own-port',
    why: 'binds ONLY the enumerated Push 2 port and clears only the previous port it owned',
  },
  'control/launchpad/launchpad-device.svelte.ts': {
    claims: 'own-port',
    detaches: 'own-port',
    why: 'binds ONLY the enumerated Launchpad port(s); detaches a previous input only when truly orphaned',
  },
  'electra/broker.ts': {
    claims: 'every-port',
    detaches: 'none',
    why: 'attachInputs() claims EVERY input, so connecting the Electra displaces the Push handler',
  },
  'midi/midi-learn.svelte.ts': {
    claims: 'every-port',
    detaches: 'none',
    why: 'attachAllInputs() claims EVERY input so a knob can be learned from any device',
  },
  'midi/midi-clock-source.ts': {
    claims: 'every-port',
    detaches: 'every-port',
    why: 'claims EVERY input to find clock bytes, and nulls EVERY input on destroy()',
  },
  'audio/modules/midi-lane.ts': {
    claims: 'own-port',
    detaches: 'every-port',
    why: 'attachToDevice() nulls EVERY input before claiming its one — and dispose() nulls them all again',
  },
  'audio/modules/midi-cv-buddy.ts': {
    claims: 'own-port',
    detaches: 'every-port',
    why: 'attachToDevice() nulls EVERY input before claiming its one — and dispose() nulls them all again',
  },
  'audio/modules/midiclock.ts': {
    claims: 'own-port',
    detaches: 'every-port',
    why: 'attachToDevice() nulls EVERY input before claiming its one — and dispose() nulls them all again',
  },
};

/** Ratchets. Both may only SHRINK — a fix lowers them in the same commit. */
const EVERY_PORT_CLAIMANTS = 3;
const EVERY_PORT_DETACHERS = 4;

describe('4 — MIDIInput.onmidimessage has ONE slot and eight claimants', () => {
  const sites = new Map<string, string>();
  for (const [key, src] of Object.entries(LIB_SOURCES)) {
    if (/\.(test|spec)\.ts$/.test(key)) continue;
    if (!/onmidimessage\s*=/.test(src)) continue;
    // The simulated-device getters/setters DEFINE the property rather than
    // claim a stream, so they are not assignment sites.
    const touches = src
      .split('\n')
      .filter((l) => /onmidimessage\s*=/.test(l))
      .filter((l) => !/^\s*(get|set)\s+onmidimessage/.test(l));
    if (touches.length === 0) continue;
    sites.set(toLibPath(key), src);
  }

  it('DENY BY DEFAULT — every claimant is named in the ledger', () => {
    const undeclared = [...sites.keys()].filter((k) => !ATTACH_LEDGER[k]).sort();
    expect(
      undeclared,
      `a subsystem touches MIDIInput.onmidimessage and is not in ATTACH_LEDGER:\n${undeclared.join('\n')}`,
    ).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT — a ledger entry for a file that no longer touches it is RED', () => {
    const stale = Object.keys(ATTACH_LEDGER).filter((k) => !sites.has(k)).sort();
    expect(stale, `stale ATTACH_LEDGER entries:\n${stale.join('\n')}`).toEqual([]);
  });

  /**
   * Does this file assign `onmidimessage` ON THE LOOP VARIABLE of a sweep over
   * every input? Precise on purpose: a bare `inputs.values()` is innocent —
   * both device layers iterate inputs to FILTER them by port name, which is how
   * they find their own hardware. The destructive shape is specifically writing
   * the handler slot of every input the loop yields.
   */
  function sweepsEveryInput(src: string): boolean {
    const loop = /for\s*\(\s*const\s+(\w+)\s+of\s+[^)]*inputs\.values\(\)\s*\)/g;
    for (let m = loop.exec(src); m; m = loop.exec(src)) {
      const body = src.slice(m.index, m.index + 300);
      if (new RegExp(`\\b${m[1]}\\.onmidimessage\\s*=`).test(body)) return true;
    }
    return false;
  }

  it('the DECLARED scope matches the source — an every-port sweep is detectable', () => {
    for (const [file, src] of sites) {
      const row = ATTACH_LEDGER[file];
      expect(row.why.length, `${file} needs a stated reason`).toBeGreaterThan(20);
      const sweeps = sweepsEveryInput(src);
      if (row.claims === 'every-port' || row.detaches === 'every-port') {
        expect(sweeps, `${file} declares an every-port scope but writes no handler in an input sweep`).toBe(true);
      } else {
        // NEGATIVE CONTROL in the other direction: a file declared polite must
        // NOT write handlers across a sweep, or the declaration is a fiction.
        expect(sweeps, `${file} declares own-port only but writes handlers across every input`).toBe(false);
      }
    }
  });

  it('NEGATIVE CONTROL for the probe itself — it separates the two shapes', () => {
    // The probe is the instrument; if it said "true" (or "false") for everything
    // the scope test above would be decoration. Feed it both shapes directly.
    const destructive = 'for (const inp of access.inputs.values()) inp.onmidimessage = null;';
    const benign = 'for (const inp of access.inputs.values()) {\n  if (isPortName(inp.name)) ins.push(inp);\n}';
    expect(sweepsEveryInput(destructive)).toBe(true);
    expect(sweepsEveryInput(benign)).toBe(false);
    // …and the block form the three audio modules actually use.
    expect(
      sweepsEveryInput('for (const inp of access.inputs.values()) {\n  inp.onmidimessage = null;\n}'),
    ).toBe(true);
  });

  it('RATCHET (both directions) — the every-port claimants and detachers may only shrink', () => {
    const claimants = Object.values(ATTACH_LEDGER).filter((v) => v.claims === 'every-port').length;
    const detachers = Object.values(ATTACH_LEDGER).filter((v) => v.detaches === 'every-port').length;
    expect(claimants).toBeLessThanOrEqual(EVERY_PORT_CLAIMANTS);
    expect(EVERY_PORT_CLAIMANTS - claimants, 'lower EVERY_PORT_CLAIMANTS in the same commit').toBe(0);
    expect(detachers).toBeLessThanOrEqual(EVERY_PORT_DETACHERS);
    expect(EVERY_PORT_DETACHERS - detachers, 'lower EVERY_PORT_DETACHERS in the same commit').toBe(0);
  });

  it('THE PUSH IS IN THE BLAST RADIUS — named, so it is not rediscovered later', () => {
    // push2-device owns exactly one input and is polite about it. It is the
    // OTHER subsystems that can take its stream away, and this pins which.
    const push = ATTACH_LEDGER['control/push2/push2-device.svelte.ts'];
    expect(push.claims).toBe('own-port');
    expect(push.detaches).toBe('own-port');
    const canKillThePush = Object.entries(ATTACH_LEDGER)
      .filter(([, v]) => v.claims === 'every-port' || v.detaches === 'every-port')
      .map(([k]) => k)
      .sort();
    expect(canKillThePush).toEqual([
      'audio/modules/midi-cv-buddy.ts',
      'audio/modules/midi-lane.ts',
      'audio/modules/midiclock.ts',
      'electra/broker.ts',
      'midi/midi-clock-source.ts',
      'midi/midi-learn.svelte.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5 — A DUPLICATED CC LITERAL IS A GATE THAT CANNOT SEE A RENAME.
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

describe('5 — no Push e2e spec re-types a CC the map already owns', () => {
  const specs = readdirSync(E2E_TESTS_DIR)
    .filter((f) => /^push2-.*\.spec\.ts$/.test(f))
    .map((f) => ({ file: f, src: readFileSync(join(E2E_TESTS_DIR, f), 'utf8') }));

  it('NEGATIVE CONTROL: the gate actually found Push specs to check', () => {
    // Without this, a rename of the spec file would silently empty the sweep
    // and every assertion below would pass against nothing.
    expect(specs.length, `no push2-*.spec.ts under ${E2E_TESTS_DIR}`).toBeGreaterThan(0);
    expect(specs.map((s) => s.file)).toContain('push2-clip-launch.spec.ts');
  });

  it('every Push spec IMPORTS its CC numbers from push2-map', () => {
    for (const { file, src } of specs) {
      expect(src, `${file} must import the Push CC constants, not re-type them`).toMatch(
        /from '.*control\/push2\/push2-map'/,
      );
    }
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
