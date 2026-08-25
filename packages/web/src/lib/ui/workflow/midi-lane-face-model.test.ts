// packages/web/src/lib/ui/workflow/midi-lane-face-model.test.ts
//
// MIDI LANE's face, pinned where a def-reading gate cannot see it.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `dock-row-plan`, `faces-parity`) already assert that this face is COMPLETE
// and that every cell OPERATES. What they cannot ask is whether the specific
// decisions in it are the ones that were argued for — so this file pins the
// three that a future edit could reverse while every other gate stayed green,
// and negative-controls each one in the direction it would actually break.

import { describe, expect, it } from 'vitest';

import {
  MIDI_CHANNEL_COUNT,
  MIDI_LANE_CHANNEL_ALL,
  MIDI_LANE_FACE,
  NOTE_GATE_MAX_NOTE,
  NOTE_GATE_MIN_NOTE,
  channelsForChoice,
  choiceForChannels,
  midiLaneChannelChoices,
  midiLaneDef,
  noteGateNoteText,
  parseNoteGateNote,
} from '$lib/audio/modules/midi-lane';
import { noteNameForMidi } from '$lib/audio/note-entry';
import { STRICT_FACES } from './strict-faces';
import { curatedFace } from './curated-face';
import { panelCellKeys, shellCellKeys, shellCellKindsFor } from './shell-cells';
import {
  midiLaneCcDetail,
  midiLaneCcLit,
  midiLaneDeviceDetail,
  midiLaneNoteDetail,
} from '$lib/ui/modules/midiLane/midi-lane-status-model';
import type { MidiLaneCardState } from '$lib/audio/modules/midi-lane';

const REST: MidiLaneCardState = {
  connected: false,
  permissionDenied: false,
  devices: [],
  selectedDeviceId: null,
  lastNote: null,
  lastVelocity: 0,
  heldCount: 0,
  lastCcA: null,
  lastCcB: null,
  ccANum: null,
  ccBNum: null,
  learningCcA: false,
  learningCcB: false,
};

describe('midiLane face — the promotion itself', () => {
  it('is promoted, and every ranked key resolves to a registered cell', () => {
    expect(STRICT_FACES.has('midiLane')).toBe(true);
    // DERIVED MEMBERSHIP in both directions: the face's `order` and the cell
    // registry must name the SAME keys. A cell nobody ranks is dead code; a
    // ranked key with no cell renders the explicitly-INERT cell.
    expect([...MIDI_LANE_FACE.order].sort()).toEqual(shellCellKeys('midiLane'));
  });

  it('declares NO params, so every control arrives as a family', () => {
    // This is the premise the whole face rests on. If a param is ever added,
    // `resolveFaceControl` starts resolving keys a different way and the
    // families below stop being the only route — which is a design change, not
    // a refactor, and it should have to be made deliberately.
    expect(midiLaneDef.params).toEqual([]);
    const familyIds = (midiLaneDef.controlFamilies ?? []).map((f) => f.id).sort();
    // Every ranked key is `<familyId>-{n}` — derived from the order, never
    // typed as a count.
    const impliedFamilies = MIDI_LANE_FACE.order
      .map((k) => /^(.+)-\{n\}$/.exec(k)?.[1])
      .filter((v): v is string => v !== undefined)
      .sort();
    expect(impliedFamilies).toEqual([...MIDI_LANE_FACE.order].map((k) => k.replace(/-\{n\}$/, '')).sort());
    expect(impliedFamilies).toEqual(familyIds);
  });

  it('CONNECT ranks FIRST — the module is inert until it is pressed', () => {
    // The whole practical argument for promoting this module. `laneRenderKind`
    // gives it a placeholder today, so the compact tier is where the permission
    // gesture becomes reachable at all; demoting it below rank 3 would push it
    // off that tier and quietly restore the defect.
    expect(MIDI_LANE_FACE.order[0]).toBe('midi-lane-connect-{n}');
  });

  it('the CONNECT gesture actually reaches the LANE TILE — the claim, resolved', () => {
    // ⚠ THE HEADLINE CLAIM, ASSERTED AT THE TIER RATHER THAN AT THE RANK.
    // "CONNECT is rank 1" is a statement about the declaration; "CONNECT paints
    // on a lane tile" is a statement about the RESOLVER, and the two can come
    // apart — `laneOrder` drops a hero cell, `foldedOrder` drops a pad partner,
    // and the tier caps are geometry. Running the real selector is the only way
    // to ask the question the PR body answers.
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const resolved = curatedFace(midiLaneDef, tier);
      expect(resolved, `${tier} resolves`).not.toBeNull();
      expect(
        resolved!.controls.map((c) => c.key),
        `the permission gesture must survive the ${tier} tier — it is the one control this `
          + 'module does nothing without',
      ).toContain('midi-lane-connect-{n}');
    }
  });

  it('and NOTHING here is dock-restricted — the other half of that claim', () => {
    // `curatedFace` deciding a key survives the compact tier is necessary and
    // not sufficient: a PANEL cell is filtered out of every non-dock tier by a
    // face-lint rule keyed on `panelCellKeys`. This module registers no panel,
    // so the plan above is what the lane actually renders. Pinning it here
    // means "CONNECT reaches the lane" cannot be quietly falsified by someone
    // later re-shaping a cell into a panel.
    expect(panelCellKeys('midiLane')).toEqual([]);
  });

  it('NEGATIVE CONTROL: the tier selector CAN drop a key, so the leg above is not vacuous', () => {
    // If `curatedFace` returned every key at every tier, the check above would
    // pass on any ranking at all. The cap is real: the dock shows all ten and
    // `mini` does not.
    const dock = curatedFace(midiLaneDef, 'dock');
    const mini = curatedFace(midiLaneDef, 'mini');
    expect(dock!.controls.length).toBe(MIDI_LANE_FACE.order.length);
    expect(mini!.controls.length).toBeLessThan(dock!.controls.length);
    // And the ranked-last key is one of the ones a lane tier drops — so
    // "survives the tier" discriminates between rank 1 and rank 10.
    expect(
      curatedFace(midiLaneDef, 'compact')!.controls.map((c) => c.key),
    ).not.toContain(MIDI_LANE_FACE.order[MIDI_LANE_FACE.order.length - 1]);
  });

  it('the glyph is NONE, and it is forced rather than chosen', () => {
    expect(MIDI_LANE_FACE.glyph).toBe('none');
    // The reason, asserted rather than asserted-about: `glyphBinding` reaches a
    // live trace only through a port whose `type` is exactly 'audio', and this
    // module has none. Any other glyph value would resolve to the dead static
    // binding.
    expect(midiLaneDef.outputs.some((o) => o.type === 'audio')).toBe(false);
  });

  it('no page is named `signal` or `voice` — those ids belong to the rear rails', () => {
    const ids = (MIDI_LANE_FACE.pages ?? []).map((p) => p.id);
    expect(ids).not.toContain('signal');
    expect(ids).not.toContain('voice');
  });

  it('every page control is ranked, and every ranked control is on exactly one page', () => {
    const paged = (MIDI_LANE_FACE.pages ?? []).flatMap((p) => [...p.controls]);
    expect([...paged].sort()).toEqual([...MIDI_LANE_FACE.order].sort());
    expect(new Set(paged).size).toBe(paged.length);
  });
});

describe('midiLane face — the TYPED-ENTRY decision', () => {
  it('the note field is an `entry` cell, not a roster', () => {
    // ⚠ THE PERMANENT LEG FOR THE CENTRAL DESIGN DECISION. Swapping this cell
    // for a `selector` would keep every other gate green — it renders, it
    // operates, it writes the same key — and would silently redden the
    // face-migration inventory's TYPED-ENTRY parity leg, because the legacy
    // card keeps its `<input type="number">` under `?shell=legacy`.
    expect(shellCellKindsFor('midiLane')).toContain('entry');
  });

  it('a 128-name roster would have carried BLANK labels — the measurement, kept', () => {
    // The rejected alternative, pinned so the reason survives the decision.
    // `noteNameForMidi` is bounded to the range that HAS a printable name, and
    // the module's own field is not — so a roster labelled by it cannot name
    // every value the control can hold.
    const unnameable = [];
    for (let m = NOTE_GATE_MIN_NOTE; m <= NOTE_GATE_MAX_NOTE; m++) {
      if (noteNameForMidi(m) === '') unnameable.push(m);
    }
    expect(unnameable.length).toBeGreaterThan(0);
    // And the typed field reaches every one of them, which is the parity claim.
    for (const m of unnameable) {
      expect(parseNoteGateNote(String(m)), `MIDI ${m} must be typeable`).toBe(m);
    }
  });

  it('the parser ACCEPTS both forms and REFUSES rather than clamps', () => {
    expect(parseNoteGateNote('36')).toBe(36);
    expect(parseNoteGateNote('c2')).toBe(36);
    expect(parseNoteGateNote(' C2 ')).toBe(36);
    expect(parseNoteGateNote('f#3')).toBe(54);
    expect(parseNoteGateNote('0')).toBe(0);
    expect(parseNoteGateNote(String(NOTE_GATE_MAX_NOTE))).toBe(NOTE_GATE_MAX_NOTE);
  });

  it('NEGATIVE CONTROL: the refusals are refusals, and 128 is the one that matters', () => {
    // ⚠ THE ANTI-CLAMP LEG, and it is the permanent one. The engine's
    // `setNoteGateNote` ends in `Math.max(0, Math.min(127, …))`, so a cell that
    // forwarded raw text would silently re-point the gate at 127 — a control
    // writing a value the domain does not contain while the model corrects it.
    // A parser that returned 127 here would pass every positive leg above.
    expect(parseNoteGateNote('128')).toBeNull();
    expect(parseNoteGateNote('-1')).toBeNull();
    expect(parseNoteGateNote('999')).toBeNull();
    expect(parseNoteGateNote('')).toBeNull();
    expect(parseNoteGateNote('  ')).toBeNull();
    expect(parseNoteGateNote('h4')).toBeNull();
    expect(parseNoteGateNote('c')).toBeNull();
    expect(parseNoteGateNote('36.5')).toBeNull();
  });

  it('the field ROUND-TRIPS for every value the module can hold', () => {
    // What makes the resting string an `authored-entry` rather than a readout:
    // it is the stored value spelled back, and the speller and the parser are
    // inverses across the whole domain.
    for (let m = NOTE_GATE_MIN_NOTE; m <= NOTE_GATE_MAX_NOTE; m++) {
      expect(parseNoteGateNote(noteGateNoteText(m)), `round-trip MIDI ${m}`).toBe(m);
    }
  });
});

describe('midiLane face — the CHANNEL roster', () => {
  it('is ALL plus one entry per MIDI channel, derived from the protocol constant', () => {
    const choices = midiLaneChannelChoices();
    expect(choices).toHaveLength(MIDI_CHANNEL_COUNT + 1);
    expect(choices[0]).toEqual({ value: MIDI_LANE_CHANNEL_ALL, label: 'ALL' });
    // 0-based on the wire, 1-based on the label — the off-by-one every piece of
    // MIDI hardware has, encoded once.
    expect(choices[1]).toEqual({ value: '0', label: '1' });
    expect(choices[MIDI_CHANNEL_COUNT]).toEqual({
      value: String(MIDI_CHANNEL_COUNT - 1),
      label: String(MIDI_CHANNEL_COUNT),
    });
  });

  it('every offered choice ROUND-TRIPS through the stored form', () => {
    for (const c of midiLaneChannelChoices()) {
      expect(choiceForChannels(channelsForChoice(c.value)), c.label).toBe(c.value);
    }
  });

  it('NEGATIVE CONTROL: ALL and a multi-channel set are DIFFERENT stored values', () => {
    // `null` matches every channel; an explicit set matches only its members.
    // Collapsing them would make a lane silently listen to everything.
    expect(channelsForChoice(MIDI_LANE_CHANNEL_ALL)).toBeNull();
    expect(channelsForChoice('3')).toEqual([3]);
    // A multi-channel set has no single-channel chip to show, so the picker
    // reads ALL — the card's own behaviour — while the engine keeps the Set.
    expect(choiceForChannels([1, 2])).toBe(MIDI_LANE_CHANNEL_ALL);
    expect(choiceForChannels([MIDI_CHANNEL_COUNT])).toBe(MIDI_LANE_CHANNEL_ALL);
  });
});

describe('midiLane device body — the strings nobody paints', () => {
  it('the NOTE lamp tracks HELD KEYS, not the latched last note', () => {
    // ⚠ THE PERMANENT LEG FOR THE BUG THIS FACE ALMOST SHIPPED. `lastNote` is
    // assigned on note-on and never cleared, so a lamp bound to it lights once
    // and never goes dark. Binding to `heldCount` is what makes it an
    // indicator; this test fails if anyone rewires it back.
    const latchedButReleased = { ...REST, lastNote: 60, lastVelocity: 100, heldCount: 0 };
    expect(midiLaneNoteDetail(latchedButReleased)).toBe('no key held on this lane');

    const held = { ...REST, lastNote: 60, lastVelocity: 100, heldCount: 1 };
    expect(midiLaneNoteDetail(held)).toContain('1 key held');
    expect(midiLaneNoteDetail(held)).toContain('C4');
    expect(midiLaneNoteDetail({ ...held, heldCount: 3 })).toContain('3 keys held');
  });

  it('the MIDI lamp names each outcome distinctly', () => {
    expect(midiLaneDeviceDetail(REST)).toContain('not granted');
    expect(midiLaneDeviceDetail({ ...REST, permissionDenied: true })).toContain('refused');
    expect(midiLaneDeviceDetail({ ...REST, connected: true })).toContain('no input device');
    const bound = {
      ...REST,
      connected: true,
      devices: [{ id: 'd1', name: 'Reliq', state: 'connected' }],
      selectedDeviceId: 'd1',
    };
    expect(midiLaneDeviceDetail(bound)).toBe('listening to Reliq');
    // Granted, devices present, none chosen — a fourth state, not folded in.
    expect(midiLaneDeviceDetail({ ...bound, selectedDeviceId: null })).toContain('no device chosen');
  });

  it('a CC lamp separates ARMED from BOUND from UNASSIGNED', () => {
    expect(midiLaneCcLit(null, false)).toBe(false);
    expect(midiLaneCcLit(null, true)).toBe(true);
    expect(midiLaneCcLit(1, false)).toBe(true);
    expect(midiLaneCcDetail('A', null, false, null)).toContain('not assigned');
    expect(midiLaneCcDetail('A', null, true, null)).toContain('armed');
    // ⚠ ARMED WINS OVER BOUND, deliberately: a player who just pressed LEARN is
    // standing in the transient state and needs to know the lane is listening.
    expect(midiLaneCcDetail('A', 1, true, 64)).toContain('armed');
    expect(midiLaneCcDetail('B', 7, false, 64)).toContain('controller 7');
    expect(midiLaneCcDetail('B', 7, false, 64)).toContain('last value 64');
    expect(midiLaneCcDetail('B', 7, false, null)).toContain('nothing received yet');
  });

  it('NEGATIVE CONTROL: no detail string is empty, on any reachable state', () => {
    // A blank `aria-label` is the failure mode a painted readout would have
    // made obvious and an unpainted one hides completely.
    const states: MidiLaneCardState[] = [
      REST,
      { ...REST, permissionDenied: true },
      { ...REST, connected: true },
      { ...REST, connected: true, heldCount: 2, lastNote: 36, lastVelocity: 1 },
    ];
    for (const s of states) {
      expect(midiLaneDeviceDetail(s).length).toBeGreaterThan(0);
      expect(midiLaneNoteDetail(s).length).toBeGreaterThan(0);
    }
    for (const assigned of [null, 0, 127]) {
      for (const learning of [true, false]) {
        expect(midiLaneCcDetail('A', assigned, learning, null).length).toBeGreaterThan(0);
      }
    }
  });
});
