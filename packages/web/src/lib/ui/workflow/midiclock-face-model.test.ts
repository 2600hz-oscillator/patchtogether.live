// packages/web/src/lib/ui/workflow/midiclock-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for MIDICLOCK's faceplate.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `face-rack-status-source`, `faces-parity`) enrol this module automatically
// and ask GENERIC questions: does every key resolve, does every cell operate,
// does the declared body role hold. This file asks the ones that are only true
// of THIS module — the three that, if they silently stopped being true, would
// leave every one of those sweeps green.
//
// ⚠ EACH ASSERTION HERE EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT
// QUIETLY, and the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import '$lib/audio/modules';
import { midiclockDef, CLOCK_DIVISORS } from '$lib/audio/modules/midiclock';
import { STRICT_FACES } from './strict-faces';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from './shell-control-kind';
import { shellCellFor, shellActionProbes } from './shell-cells';
import { dockFacePlan, dockPlanControls, laneOrder } from './curated-face';

const FACE = () => midiclockDef.face!;

describe('midiclock face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    // An authored `face` that is not in STRICT_FACES is INERT: it ships as a
    // no-op while looking complete, because `migrated()` is what decides which
    // component the player actually operates.
    expect(midiclockDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('midiclock'), 'and it is promoted').toBe(true);
  });

  it('declares `glyph: none` — the only literal that can compile green here', () => {
    // ⚠ NOT A PREFERENCE. `glyphBinding` short-circuits on
    // `primaryAudioOutPortId`, which matches `type === 'audio'` exactly. This
    // module's four outputs are gate/cv/gate/gate, so that resolves null and
    // EVERY other glyph literal falls through to `{ kind: 'static' }`, which
    // module-face-lint's dead-glyph clause reddens unconditionally. Asserted
    // here with the reason attached so a future author reads WHY rather than
    // discovering it from a failure three files away.
    expect(FACE().glyph).toBe('none');
    expect(
      midiclockDef.outputs.some((o) => o.type === 'audio'),
      'no audio output exists for a live glyph to bind to',
    ).toBe(false);
  });
});

describe('midiclock face — M2: the DIV cell is SEGMENTED, read off the RESOLVER', () => {
  // ⚠ THE SPEC SAID "five options <= SEGMENTED_MAX_OPTIONS, so it resolves to
  // segmented" AND THAT IS AN INFERENCE, NOT A MEASUREMENT. The resolver has
  // four earlier branches (`momentary`, a declared `paramCells` kind, the
  // options branch, `looksLikeToggle`) and any of them could claim this param
  // first. So the resolver is CALLED.
  const divisor = () => midiclockDef.params.find((p) => p.id === 'divisor')!;

  it('resolves SEGMENTED at the dock', () => {
    expect(paramCellKind(divisor(), new Set(), 'dock', new Map())).toBe('segmented');
  });

  it('resolves KNOB at every LANE tier — and that is correct, not a bug', () => {
    // A lane column cannot hold a five-button roster, so the dial keeps the
    // space. This is asserted rather than assumed because it is exactly what
    // makes `setParam`'s SNAP load-bearing: a knob over `1..24 discrete` can
    // reach all 24 steps, 19 of which are not on the roster.
    expect(paramCellKind(divisor(), new Set(), 'lane', new Map())).toBe('knob');
  });

  it('the roster fits the segmented budget, WITH slack', () => {
    // Not a population count — a policy threshold on a derived measurement,
    // and it is checked with real headroom rather than sitting exactly on the
    // roster size (a floor ON the population is a ratchet whatever its intent).
    expect(CLOCK_DIVISORS.length).toBeLessThan(SEGMENTED_MAX_OPTIONS);
  });

  it('NO `paramCells` override is declared — the kind is DERIVED', () => {
    // ⚠ AND IT COULD NOT BE DECLARED ANYWAY: `'segmented'` is not an
    // `AuthoredParamCell`. An author reaching for an override here would have
    // to pick a DIFFERENT kind, silently changing the control. Pinning the
    // absence is what makes that edit visible.
    expect(FACE().paramCells).toBeUndefined();
  });
});

describe('midiclock face — BOTH cells reach the LANE (this is D4\'s whole fix)', () => {
  // The CONNECT gesture being dock-only was the module's worst practical
  // defect: midiclock is inert until MIDI access is granted, and an
  // un-migrated module renders a lane PLACEHOLDER, so the grant required
  // finding the dock full view first. If either key ever fell out of the lane
  // roster the module would silently go back to that state — and no other gate
  // in the tree would notice, because the DOCK plan would still be perfect.
  it('laneOrder keeps the divisor AND the connect gesture', () => {
    // `laneOrder` drops exactly a declared `hero.cell` and each xyPad's `x`
    // key. This face declares neither — asserted just above — so the lane
    // roster is the whole of `face.order`, and this is what says so.
    const lane = laneOrder(FACE());
    expect([...lane]).toEqual(['divisor', 'midiclock-connect-{n}']);
  });

  it('the connect cell is not a PANEL — panels are the dock-only kind', () => {
    const cell = shellCellFor('midiclock', {
      kind: 'family',
      key: 'midiclock-connect-{n}',
      label: 'Connect MIDI',
    } as never);
    expect(cell?.kind, 'an action cell, which lane tiers render').toBe('action');
  });
});

describe('midiclock face — the CONNECT probe reads a SEAM, not a counter', () => {
  it('declares an audition probe on the engine-message seam', () => {
    // ⚠ M4. A `data-rev` probe passes on a dead button that bumps a counter,
    // and this file's neighbours outlaw that shape by name. A `data` probe
    // would be worse here than merely weak: it would be RED on a perfectly
    // live control, because no CI runner has a MIDI device or a granted
    // origin, so `connected` can never flip there.
    const probe = shellActionProbes().midiclock?.['midiclock-connect-{n}'];
    expect(probe, 'the connect cell declares a probe').toBeTruthy();
    expect(probe!.effect.kind).toBe('audition');
    expect((probe!.effect as { seam: string }).seam).toBe('engine-message');
  });

  it('NEGATIVE CONTROL: no OTHER midiclock cell shares that seam on the same node', () => {
    // The `twotracks-save` lesson, applied before it can bite: two cells on one
    // node declaring the same audition seam means a probe for either is
    // satisfied by a press on the other, so one of them could be completely
    // dead and stay green. midiclock has exactly one action cell today, and
    // this assertion is what makes adding a second one a deliberate act.
    const cells = shellActionProbes().midiclock ?? {};
    const engineSeamKeys = Object.entries(cells).filter(
      ([, p]) => p.effect.kind === 'audition' && (p.effect as { seam: string }).seam === 'engine-message',
    );
    expect(engineSeamKeys.map(([k]) => k)).toEqual(['midiclock-connect-{n}']);
  });
});

describe('midiclock face — the dock plan is one honest band', () => {
  it('renders exactly the two ranked controls, nothing unbacked', () => {
    const controls = dockPlanControls(dockFacePlan(midiclockDef) ?? []);
    expect(controls.map((c) => c.key).sort()).toEqual(['divisor', 'midiclock-connect-{n}']);
  });

  it('is ONE band and is NOT tab-railed — nothing is padded to reach a rail', () => {
    // The rail engages at DOCK_TAB_MIN_BANDS = 7 and `face.tabbed` is
    // owner-instruction-only. Two ranked cells is one band; a future author
    // splitting them into pages "so each gets a header" would fail here, which
    // is the intent — a page is a different IDEA, not a way to get a heading.
    expect(FACE().pages?.length).toBe(1);
    expect(FACE().tabbed).toBeUndefined();
    expect(dockFacePlan(midiclockDef)?.length).toBe(1);
  });
});

describe('midiclock face — the DEVICE BODY is declared and is the only bespoke surface', () => {
  it('declares the extension by id', () => {
    expect(FACE().extension).toBe('midiclock');
  });

  it('declares NO rackStatus — this binding is not a property of the rack', () => {
    // ⚠ THE DISTINCTION FROM cvBuddy, pinned so it cannot blur. cvBuddy's body
    // exists because its subject (which ES-9 jacks this instance owns) is a
    // function of every CV Buddy present, which is why it suppresses a band on
    // non-primary instances. Two midiclocks can listen to two different devices
    // and neither is a property of the other, so there is no band to suppress
    // and declaring the field would hide controls for no reason.
    expect(FACE().rackStatus).toBeUndefined();
  });

  it('does NOT declare a hero — there is no control to promote over one other', () => {
    // A hero MOVES a key rather than duplicating it, so on a two-cell face it
    // would empty the only band. Pinned because the failure is a blank plate.
    expect(FACE().hero).toBeUndefined();
  });
});
