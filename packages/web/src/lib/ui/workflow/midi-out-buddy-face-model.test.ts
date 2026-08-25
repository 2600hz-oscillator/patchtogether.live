// packages/web/src/lib/ui/workflow/midi-out-buddy-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for MIDI-OUT-BUDDY's faceplate.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `face-rack-status-source`, `faces-parity`) enrol this module automatically
// and ask GENERIC questions. This file asks the ones that are only true of THIS
// module — the ones that, if they silently stopped being true, would leave
// every one of those sweeps green.
//
// ⚠ EACH ASSERTION HERE EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT
// QUIETLY, and the comment on each says which edit.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import '$lib/audio/modules';
import {
  channelForChoice,
  clampMidiChannel,
  DEFAULT_MIDI_OUT_CHANNEL,
  effectiveMidiOutChannel,
  isMidiOutChannelOverridden,
  midiOutBuddyChannelChoices,
  midiOutBuddyDef,
} from '$lib/audio/modules/midi-out-buddy';
import { MIDI_CHANNEL_COUNT } from '$lib/audio/modules/midi-cv-buddy';
import { STRICT_FACES } from './strict-faces';
import { shellCellFor, shellActionProbes } from './shell-cells';
import { curatedFace, dockFacePlan, dockPlanControls, laneOrder } from './curated-face';

const FACE = () => midiOutBuddyDef.face!;

describe('midiOutBuddy face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    expect(midiOutBuddyDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('midiOutBuddy'), 'and it is promoted').toBe(true);
  });

  it('declares `glyph: none` — and here there is not even a PORT to bind to', () => {
    // ⚠ THE STRONGEST FORM OF THIS ARGUMENT IN THE FLEET. `glyphBinding`
    // short-circuits on `primaryAudioOutPortId`, which matches
    // `type === 'audio'` exactly — and this def declares `outputs: []`, because
    // it is a TERMINAL MIDI SINK. So there is not merely no audio port, there
    // is no port at all, and every other glyph literal falls through to
    // `{ kind: 'static' }`, which module-face-lint's dead-glyph clause reddens.
    expect(FACE().glyph).toBe('none');
    expect(midiOutBuddyDef.outputs, 'a terminal sink has no outputs').toEqual([]);
  });

  it('is a ZERO-PARAM face — both controls arrive as families', () => {
    expect(midiOutBuddyDef.params).toEqual([]);
    const families = new Set((midiOutBuddyDef.controlFamilies ?? []).map((f) => `${f.id}-{n}`));
    for (const key of FACE().order) {
      expect(families.has(key), `${key} is backed by a declared controlFamily`).toBe(true);
    }
  });
});

describe('midiOutBuddy face — BOTH cells reach the LANE', () => {
  it('laneOrder keeps both ranked keys, CONNECT first', () => {
    const lane = laneOrder(FACE());
    expect([...lane]).toEqual([
      'midi-out-buddy-connect-{n}',
      'midi-out-buddy-channel-{n}',
    ]);
  });

  it('the connect cell is not a PANEL — panels are the dock-only kind', () => {
    // Without this, granting Web MIDI would require finding the dock full view
    // first, on a module that sends nothing at all until the grant lands. That
    // was the practical defect on midiclock, midiLane and this one alike.
    const cell = shellCellFor('midiOutBuddy', {
      kind: 'family',
      key: 'midi-out-buddy-connect-{n}',
      label: 'Connect MIDI',
    } as never);
    expect(cell?.kind, 'an action cell, which lane tiers render').toBe('action');
  });

  it('and it SURVIVES THE TIER CAP at every lane tier, mini included', () => {
    // ⚠ `laneOrder` IS NOT THE TILE. The roster above is what the lane MAY
    // draw; `curatedFace` then slices it to `faceTierCap`, which is 1 at mini.
    // A key that ranks first in the roster and falls off the cap is invisible
    // on the surface a player meets — which on this module means the permission
    // gesture is unreachable again, with the dock plan still perfect and every
    // other gate still green.
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const keys = (curatedFace(midiOutBuddyDef, tier)?.controls ?? []).map((c) => c.key);
      expect(keys[0], `${tier} tier leads with the permission gesture`).toBe(
        'midi-out-buddy-connect-{n}',
      );
    }
  });
});

describe('midiOutBuddy face — the CONNECT probe reads a SEAM, not a counter', () => {
  it('declares an audition probe on the engine-message seam', () => {
    const probe = shellActionProbes().midiOutBuddy?.['midi-out-buddy-connect-{n}'];
    expect(probe, 'the connect cell declares a probe').toBeTruthy();
    expect(probe!.effect.kind).toBe('audition');
    expect((probe!.effect as { seam: string }).seam).toBe('engine-message');
  });

  it('NEGATIVE CONTROL: no OTHER midiOutBuddy cell shares that seam on the same node', () => {
    const cells = shellActionProbes().midiOutBuddy ?? {};
    const engineSeamKeys = Object.entries(cells).filter(
      ([, p]) => p.effect.kind === 'audition' && (p.effect as { seam: string }).seam === 'engine-message',
    );
    expect(engineSeamKeys.map(([k]) => k)).toEqual(['midi-out-buddy-connect-{n}']);
  });
});

describe('midiOutBuddy face — the dock plan is ONE honest band', () => {
  it('renders exactly the two ranked controls, nothing unbacked', () => {
    const controls = dockPlanControls(dockFacePlan(midiOutBuddyDef) ?? []);
    expect(controls.map((c) => c.key).sort()).toEqual([
      'midi-out-buddy-channel-{n}',
      'midi-out-buddy-connect-{n}',
    ]);
  });

  it('is ONE band and is NOT tab-railed — nothing is padded to reach a rail', () => {
    expect(FACE().pages?.length).toBe(1);
    expect(FACE().tabbed).toBeUndefined();
    expect(dockFacePlan(midiOutBuddyDef)?.length).toBe(1);
  });

  it('no page is named `voice` or `signal` — the dx7 double-band scar', () => {
    // ⚠ AND THE LINT CANNOT SEE THIS ONE: its collision check reads DECLARED
    // rear groups and this module declares none, so its leading rear band is
    // DERIVED by `rearFieldPlan` from the ports — and all four inputs carry
    // gate/poly/pitch drive, which is exactly the condition that derives a
    // `voice`/`signal` section. A page with that id would render a second band
    // with the same name, with every registry gate green.
    for (const p of FACE().pages ?? []) {
      expect(['voice', 'signal']).not.toContain(p.id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE INVERSE ASSERTION — the card's CH-vs-LANE badge is GONE from the plate.
//
// ⚠ RELOCATION AND DELETION LOOK IDENTICAL FROM A GREEN RUN. The status-model
// test proves the warning's two numbers and its undo instruction reached the
// lamp's `detail`; nothing in it would fail if the body ALSO still painted the
// badge, or still outlined itself violet. Both are derived state, both are
// refused at rest, and both absences have to be asserted on their own.
//
// ⚠ SOURCE-LEVEL, BECAUSE NO RUNTIME GATE SEES IT.
// `face-resting-text-source` denies `ModuleFace` FIELDS, not an extension
// body's markup, and states that blind spot in its own header. Like every
// source gate here it cannot tell code from a comment, which is why the
// strings below are assembled rather than written out.
// ─────────────────────────────────────────────────────────────────────────────

describe('midiOutBuddy — the card\'s CH-vs-LANE badge and violet outline are GONE', () => {
  const bodySource = (): string =>
    readFileSync(
      resolve(import.meta.dirname, '../modules/midiOutBuddy/MidiOutBuddyDeviceBody.svelte'),
      'utf8',
    );

  it('the body paints no badge, no readout row, and no divergence text node', () => {
    const src = bodySource();
    for (const marker of ['ch-' + 'badge', 'read' + 'out-row', 'activeNote' + 'Label', '↯']) {
      expect(src.includes(marker), `the body must not carry \`${marker}\``).toBe(false);
    }
  });

  it('and it does NOT re-spend the video CABLE HUE on a non-domain meaning', () => {
    // ⚠ THE COLOUR IS HALF THE DELETED WARNING, so it needs its own leg. The
    // card outlined itself in `--cable-video` because it was "the only purple
    // in the token set" — a domain hue standing in for a fault, which is the
    // collision `rear-direction.test.ts` refuses on the rear rails. The lamp's
    // `warn` tone is the app's own fault colour and carries the same fact.
    expect(bodySource().includes('--cable-' + 'video')).toBe(false);
  });

  it('POSITIVE CONTROL: the warning IS reachable — through `detail`, on a WARN lamp', () => {
    // ⚠ THE NEGATIVES ABOVE ARE SATISFIED BY AN EMPTY FILE, so they prove
    // nothing on their own. This is the half that says the information
    // survived the move.
    const src = bodySource();
    expect(src).toContain('midiOutBuddyLaneDetail');
    expect(src).toContain('detail={laneDetail}');
    expect(src).toContain('tone="warn"');
  });
});

describe('midiOutBuddy face — the OUTPUT BODY is declared and is the only bespoke surface', () => {
  it('declares the extension by id', () => {
    expect(FACE().extension).toBe('midiOutBuddy');
  });

  it('declares NO rackStatus — every instance binds its own port', () => {
    expect(FACE().rackStatus).toBeUndefined();
  });

  it('does NOT declare a hero — a hero on a two-cell face would empty the band', () => {
    // `heroFacePlan` MOVES a key rather than duplicating it, so promoting
    // either of these would leave the only band with one control and drop its
    // hint. Pinned because the failure mode is a near-blank plate.
    expect(FACE().hero).toBeUndefined();
  });
});

describe('midiOutBuddy — the CHANNEL cell says what is SENT, not what is stored', () => {
  // ⚠ THIS IS THE ONE THAT WOULD REGRESS SILENTLY. Reading the raw
  // `midiOutChannel` would paint `1` on a module in lane 5 that is actually
  // sending on 5 — a cell that lies about the graph, on a face whose whole
  // claim is that it tracks the graph. Every registry gate would stay green,
  // because the cell would still read, write and re-project perfectly.
  it('an un-overridden module in a lane shows its LANE channel', () => {
    expect(effectiveMidiOutChannel({ channel: 5 } as never)).toBe(5);
  });

  it('an overridden module shows the OVERRIDE, and reports the divergence', () => {
    expect(effectiveMidiOutChannel({ channel: 5, midiOutChannel: 9 } as never)).toBe(9);
    expect(isMidiOutChannelOverridden({ channel: 5, midiOutChannel: 9 } as never)).toBe(true);
  });

  it('NEGATIVE CONTROL: an override EQUAL to the lane is not a divergence', () => {
    // A lamp lit on `midiOutChannel != null` rather than on the two numbers
    // disagreeing would be a permanent warning on any module whose channel was
    // ever touched. The predicate compares values, and this is what says so.
    expect(isMidiOutChannelOverridden({ channel: 5, midiOutChannel: 5 } as never)).toBe(false);
    expect(isMidiOutChannelOverridden({ midiOutChannel: 9 })).toBe(false);
  });

  it('a free-canvas module falls back to channel 1', () => {
    expect(effectiveMidiOutChannel({})).toBe(DEFAULT_MIDI_OUT_CHANNEL);
  });
});

describe('midiOutBuddy — the CHANNEL roster is TOTAL and 1-based on BOTH sides', () => {
  it('offers every channel the stored form can hold, with no gap', () => {
    // A roster is TOTAL by default: one that skipped a value would leave a
    // state the engine can be in and the picker cannot name. Asserted against
    // the protocol constant rather than a typed length.
    const choices = midiOutBuddyChannelChoices();
    for (let i = 0; i < MIDI_CHANNEL_COUNT; i++) {
      expect(choices[i]).toEqual({ value: String(i + 1), label: String(i + 1) });
    }
    expect(choices).toHaveLength(MIDI_CHANNEL_COUNT);
  });

  it('1-BASED, unlike the input sibling — and the asymmetry is in the SAVED SHAPES', () => {
    // ⚠ PINNED SO IT CANNOT BE "TIDIED". This module's `midiOutChannel` is
    // 1..16 because `effectiveMidiOutChannel` compares it directly against a
    // LANE NUMBER, which is 1-based. MIDI-CV-BUDDY stores the 0..15 wire nibble
    // it matches a status byte against. Making the two rosters agree would mean
    // changing one module's saved shape for symmetry.
    expect(channelForChoice('1')).toBe(1);
    expect(channelForChoice(String(MIDI_CHANNEL_COUNT))).toBe(MIDI_CHANNEL_COUNT);
  });

  it('round-trips: every choice parses back to the value that produced it', () => {
    for (const c of midiOutBuddyChannelChoices()) {
      expect(String(channelForChoice(c.value))).toBe(c.value);
    }
  });

  it('NEGATIVE CONTROL: an unparseable choice clamps into range, never to 0', () => {
    // A Note On is a channel-voice message: there is no channel 0 on the wire
    // for this module's 1-based form, and a 0 would be stamped into a status
    // byte as channel 1 anyway. Clamping is the honest behaviour and this pins
    // it at the roster's own parser rather than only at `clampMidiChannel`.
    expect(channelForChoice('nonsense')).toBe(DEFAULT_MIDI_OUT_CHANNEL);
    expect(channelForChoice('0')).toBe(1);
    expect(clampMidiChannel(999)).toBe(MIDI_CHANNEL_COUNT);
  });
});
