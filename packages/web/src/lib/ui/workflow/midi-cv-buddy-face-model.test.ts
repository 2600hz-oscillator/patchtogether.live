// packages/web/src/lib/ui/workflow/midi-cv-buddy-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for MIDI-CV-BUDDY's faceplate, plus the
// regression cover for the CHANNEL-KEY COLLISION its promotion found.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `face-rack-status-source`, `faces-parity`) enrol this module automatically
// and ask GENERIC questions: does every key resolve, does every cell operate,
// does the declared body role hold. This file asks the ones that are only true
// of THIS module — the ones that, if they silently stopped being true, would
// leave every one of those sweeps green.
//
// ⚠ EACH ASSERTION HERE EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT
// QUIETLY, and the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import '$lib/audio/modules';
import {
  channelForChoice,
  choiceForChannel,
  DEFAULT_DATA,
  MIDI_CHANNEL_COUNT,
  MIDI_CV_BUDDY_CHANNEL_ALL,
  midiCvBuddyChannelChoices,
  midiCvBuddyDef,
  midiCvBuddyPriorityOptions,
  midiInChannelOf,
  priorityForChoice,
} from '$lib/audio/modules/midi-cv-buddy';
import { STRICT_FACES } from './strict-faces';
import { shellCellFor, shellActionProbes } from './shell-cells';
import { dockFacePlan, dockPlanControls, laneOrder } from './curated-face';

const FACE = () => midiCvBuddyDef.face!;

describe('midiCvBuddy face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    // An authored `face` that is not in STRICT_FACES is INERT: it ships as a
    // no-op while looking complete, because `migrated()` is what decides which
    // component the player actually operates.
    expect(midiCvBuddyDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('midiCvBuddy'), 'and it is promoted').toBe(true);
  });

  it('declares `glyph: none` — the only literal that can compile green here', () => {
    // ⚠ NOT A PREFERENCE. `glyphBinding` short-circuits on
    // `primaryAudioOutPortId`, which matches `type === 'audio'` exactly. This
    // module's outputs are cv/gate/cv, so that resolves null and EVERY other
    // glyph literal falls through to `{ kind: 'static' }`, which
    // module-face-lint's dead-glyph clause reddens unconditionally.
    expect(FACE().glyph).toBe('none');
    expect(
      midiCvBuddyDef.outputs.some((o) => o.type === 'audio'),
      'no audio output exists for a live glyph to bind to',
    ).toBe(false);
  });

  it('is a ZERO-PARAM face — every control arrives as a family', () => {
    // `resolveFaceControl` resolves a key to a PARAM id, a family TEMPLATE or a
    // legend STATIC. With `params: []` the only route is a family, and every
    // ranked key must therefore have a `controlFamilies` entry AND a
    // `SHELL_CELLS` record. Pinned because "add a param and rank it" looks like
    // the obvious next edit and would quietly split the face across two
    // mechanisms.
    expect(midiCvBuddyDef.params).toEqual([]);
    const families = new Set((midiCvBuddyDef.controlFamilies ?? []).map((f) => `${f.id}-{n}`));
    for (const key of FACE().order) {
      expect(families.has(key), `${key} is backed by a declared controlFamily`).toBe(true);
    }
  });
});

describe('midiCvBuddy face — ALL FOUR cells reach the LANE', () => {
  // The CONNECT gesture being dock-only was this module's worst practical
  // defect, exactly as on midiclock and midiLane: it is inert until MIDI access
  // is granted, and an un-migrated module renders a lane PLACEHOLDER, so the
  // grant required finding the dock full view first. If the key ever fell out
  // of the lane roster the module would silently go back to that state — and no
  // other gate in the tree would notice, because the DOCK plan would still be
  // perfect.
  it('laneOrder keeps every ranked key, CONNECT first', () => {
    // `laneOrder` drops exactly a declared `hero.cell` and each xyPad's `x`
    // key. This face declares neither, so the lane roster is the whole of
    // `face.order`, and this is what says so.
    const lane = laneOrder(FACE());
    expect([...lane]).toEqual([
      'midi-cv-buddy-connect-{n}',
      'midi-cv-buddy-channel-{n}',
      'midi-cv-buddy-priority-{n}',
      'midi-cv-buddy-retrig-{n}',
    ]);
  });

  it('the connect cell is not a PANEL — panels are the dock-only kind', () => {
    const cell = shellCellFor('midiCvBuddy', {
      kind: 'family',
      key: 'midi-cv-buddy-connect-{n}',
      label: 'Connect MIDI',
    } as never);
    expect(cell?.kind, 'an action cell, which lane tiers render').toBe('action');
  });

  it('RETRIG is a TOGGLE and the two rosters are SELECTORS', () => {
    // ⚠ THE SELECTABILITY TRAP, pinned. A few-state discrete control drawn as a
    // knob has ~2 reachable positions across the dial's whole travel and is
    // INERT while every def-reading gate stays green (`moog962` shipped that
    // way twice). None of these is a param, so none can regress to a knob by
    // accident — but a future author migrating them to `ParamDef`s could, and
    // this is the assertion that would notice.
    const kindOf = (key: string): string | undefined =>
      shellCellFor('midiCvBuddy', { kind: 'family', key, label: 'x' } as never)?.kind;
    expect(kindOf('midi-cv-buddy-channel-{n}')).toBe('selector');
    expect(kindOf('midi-cv-buddy-priority-{n}')).toBe('selector');
    expect(kindOf('midi-cv-buddy-retrig-{n}')).toBe('toggle');
  });
});

describe('midiCvBuddy face — the CONNECT probe reads a SEAM, not a counter', () => {
  it('declares an audition probe on the engine-message seam', () => {
    // A `data-rev` probe passes on a dead button that bumps a counter. A `data`
    // probe would be worse than merely weak here: it would be RED on a
    // perfectly live control, because no CI runner has a MIDI device or a
    // granted origin, so `connected` can never flip there.
    const probe = shellActionProbes().midiCvBuddy?.['midi-cv-buddy-connect-{n}'];
    expect(probe, 'the connect cell declares a probe').toBeTruthy();
    expect(probe!.effect.kind).toBe('audition');
    expect((probe!.effect as { seam: string }).seam).toBe('engine-message');
  });

  it('NEGATIVE CONTROL: no OTHER midiCvBuddy cell shares that seam on the same node', () => {
    // The `twotracks-save` lesson, applied before it can bite: two cells on one
    // node declaring the same audition seam means a probe for either is
    // satisfied by a press on the other, so one of them could be completely
    // dead and stay green.
    const cells = shellActionProbes().midiCvBuddy ?? {};
    const engineSeamKeys = Object.entries(cells).filter(
      ([, p]) => p.effect.kind === 'audition' && (p.effect as { seam: string }).seam === 'engine-message',
    );
    expect(engineSeamKeys.map(([k]) => k)).toEqual(['midi-cv-buddy-connect-{n}']);
  });
});

describe('midiCvBuddy face — the dock plan is two honest bands', () => {
  it('renders exactly the four ranked controls, nothing unbacked', () => {
    const controls = dockPlanControls(dockFacePlan(midiCvBuddyDef) ?? []);
    expect(controls.map((c) => c.key).sort()).toEqual([
      'midi-cv-buddy-channel-{n}',
      'midi-cv-buddy-connect-{n}',
      'midi-cv-buddy-priority-{n}',
      'midi-cv-buddy-retrig-{n}',
    ]);
  });

  it('is TWO bands and is NOT tab-railed — nothing is padded to reach a rail', () => {
    // The rail engages at DOCK_TAB_MIN_BANDS = 7 and `face.tabbed` is
    // owner-instruction-only. Four ranked cells is two bands; a future author
    // splitting them further "so each gets a header" would fail here, which is
    // the intent — a page is a different IDEA, not a way to get a heading.
    expect(FACE().pages?.length).toBe(2);
    expect(FACE().tabbed).toBeUndefined();
    expect(dockFacePlan(midiCvBuddyDef)?.length).toBe(2);
  });

  it('no page is named `voice` or `signal` — the dx7 double-band scar', () => {
    // ⚠ AND THE LINT CANNOT SEE THIS ONE. `module-face-lint`'s collision check
    // reads `def.face.rear.groups`, i.e. only DECLARED groups; this module
    // declares none, so its leading rear band is DERIVED by `rearFieldPlan`
    // from the ports — and its three outputs carry gate/pitch drive, which is
    // exactly the condition that derives a `voice`/`signal` section. A page
    // with that id would render a second band carrying the same name, with
    // every registry gate green.
    for (const p of FACE().pages ?? []) {
      expect(['voice', 'signal']).not.toContain(p.id);
    }
  });
});

describe('midiCvBuddy face — the DEVICE BODY is declared and is the only bespoke surface', () => {
  it('declares the extension by id', () => {
    expect(FACE().extension).toBe('midiCvBuddy');
  });

  it('declares NO rackStatus — this binding is not a property of the rack', () => {
    // The distinction from cvBuddy, pinned so it cannot blur. cvBuddy's body
    // exists because its subject (which ES-9 jacks this instance owns) is a
    // function of every CV Buddy present, which is why it suppresses a band on
    // non-primary instances. Two MIDI-CV-BUDDYs can listen to two different
    // devices and neither is a property of the other, so there is no band to
    // suppress and declaring the field would hide controls for no reason.
    expect(FACE().rackStatus).toBeUndefined();
  });

  it('does NOT declare a hero — a hero MOVES a key and could empty a band', () => {
    expect(FACE().hero).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CHANNEL-KEY COLLISION (#1168's other half) — the regression cover.
//
// `channel-columns.ts` declares `data.channel: 1..8` to be workflow COLUMN
// MEMBERSHIP TRUTH. This module's card wrote a 0..15 MIDI channel FILTER into
// that same key and its factory read the key back as one. Both directions were
// live, and the second needs no user action at all.
//
// ⚠ THESE ASSERTIONS ARE THE ONLY THING THAT HOLDS THE LINE, because the
// collision is invisible to every existing gate: `contract-lock` projects
// params and this module has none, `module-docs-lint` reads the def, and
// `faces-parity` would happily watch a write land in `data.channel` and call
// the cell live. The bug was a WORKING control writing the WRONG key.
// ─────────────────────────────────────────────────────────────────────────────

describe('midiCvBuddy — the MIDI filter does not touch the lane membership key', () => {
  it('the stored key is `midiInChannel`, and `channel` is not read as a filter', () => {
    // The forward half. A lane member's `data.channel` is its COLUMN NUMBER,
    // written by the reconciler on a positional drop with no port-shape check,
    // so reading it as a filter made a module dropped into channel column 5
    // listen to MIDI channel 6 only.
    expect(midiInChannelOf({ channel: 5 } as never), 'a lane number is not a filter').toBe(null);
    expect(midiInChannelOf({ midiInChannel: 5 }), 'our own key is').toBe(5);
  });

  it('the DEFAULT is ALL, and it is stored under our key', () => {
    // ⚠ THERE IS NO LEGACY FALLBACK, DELIBERATELY — a stored `3` is the same
    // bytes whether the card wrote a filter or the reconciler wrote a lane, so
    // there is no discriminator to write. A rack saved with a filter therefore
    // re-opens on ALL, which is the recoverable direction. Pinned so the
    // fallback cannot be "restored" as a kindness.
    expect(DEFAULT_DATA.midiInChannel).toBe(null);
    expect(Object.keys(DEFAULT_DATA)).not.toContain('channel');
  });

  it('NEGATIVE CONTROL: an out-of-range stored value widens rather than mutes', () => {
    // A value the wire format cannot express must not silently filter to
    // nothing — a module that hears no channel at all is the failure this whole
    // section is about.
    expect(midiInChannelOf({ midiInChannel: MIDI_CHANNEL_COUNT })).toBe(null);
    expect(midiInChannelOf({ midiInChannel: -1 })).toBe(null);
    expect(midiInChannelOf(undefined)).toBe(null);
  });

  it('the CELL READS `midiInChannel`, which is what makes faces-parity able to see the write', () => {
    // ⚠ THE READER IS THE HALF THAT CAN BE PINNED PURELY, AND IT IS ENOUGH.
    // `faces-parity` operates every cell and asserts the change reached the
    // graph by reading it back through the cell's OWN `value` function. So if
    // the setter ever went back to writing `data.channel` while this reader
    // reads `midiInChannel`, the cell would appear completely inert at the e2e
    // tier and that sweep would fail — the two halves cannot disagree silently.
    // What THIS pins is which key the reader is aimed at, which is the fact
    // that argument rests on.
    const cell = shellCellFor('midiCvBuddy', {
      kind: 'family',
      key: 'midi-cv-buddy-channel-{n}',
      label: 'Channel',
    } as never);
    expect(cell?.kind).toBe('selector');
    const read = (cell as { value: (n: unknown) => string }).value;
    expect(read({ data: { midiInChannel: 4 } }), 'our key drives the cell').toBe('4');
    expect(read({ data: { channel: 4 } }), 'the lane key does NOT').toBe(MIDI_CV_BUDDY_CHANNEL_ALL);
  });
});

describe('midiCvBuddy — the CHANNEL roster is TOTAL and 1-based on screen', () => {
  it('offers ALL plus every wire channel, with no gap', () => {
    // A roster is TOTAL by default: one that skipped a value would leave a
    // state the engine can be in and the picker cannot name. Asserted against
    // the protocol constant rather than a typed length.
    const choices = midiCvBuddyChannelChoices();
    expect(choices[0]).toEqual({ value: MIDI_CV_BUDDY_CHANNEL_ALL, label: 'ALL' });
    for (let i = 0; i < MIDI_CHANNEL_COUNT; i++) {
      expect(choices[i + 1]).toEqual({ value: String(i), label: String(i + 1) });
    }
    expect(choices).toHaveLength(MIDI_CHANNEL_COUNT + 1);
  });

  it('round-trips: every choice parses back to the value that produced it', () => {
    for (const c of midiCvBuddyChannelChoices()) {
      expect(choiceForChannel(channelForChoice(c.value))).toBe(c.value);
    }
  });

  it('the LABEL is 1-based and the VALUE is the 0-based wire nibble', () => {
    // ⚠ THE OFF-BY-ONE IS THE WHOLE REASON THIS ROSTER IS SHARED. `channelMatches`
    // compares against `status & 0x0f`, which is 0-based; every keyboard on the
    // planet prints 1-based. The card and the face both read this function, so
    // there is exactly one place the convention can be wrong.
    expect(channelForChoice('0'), 'the option printed "1"').toBe(0);
    expect(channelForChoice(MIDI_CV_BUDDY_CHANNEL_ALL)).toBe(null);
  });
});

describe('midiCvBuddy — the PRIORITY roster agrees with the engine', () => {
  it('names exactly the three the engine has a branch for', () => {
    // The array is typed `VoicePriority[]`, so a name the union does not have
    // is a compile error rather than a dead option. This asserts the runtime
    // shape a `<select>` and a `SelectorOption` share.
    expect(midiCvBuddyPriorityOptions().map((p) => p.value)).toEqual(['last', 'low', 'high']);
  });

  it('an unknown choice narrows to the default rather than reaching pickWinner', () => {
    expect(priorityForChoice('sideways')).toBe('last');
    expect(priorityForChoice('high')).toBe('high');
  });
});
