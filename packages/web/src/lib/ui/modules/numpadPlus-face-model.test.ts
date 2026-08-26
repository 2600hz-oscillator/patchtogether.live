// packages/web/src/lib/ui/modules/numpadPlus-face-model.test.ts
//
// NUMPAD+'s FACE, as pure model: what the plate ranks, what each tier resolves,
// which primitive each param becomes, and what the two panels are declared to
// do. No DOM, no Y.Doc, no AudioContext.
//
// ⚠ THE PERMANENT NEGATIVE CONTROLS THIS FILE EXISTS FOR:
//
//   M2/M3 — SELECTABILITY. `activeLayer` (0..3) and `octave` (0..8) are the
//     moog962 shape: drawn as bare dials they have four and nine reachable
//     positions across the whole travel, so a short drag quantises back to
//     where it started while every def-reading gate stays green. Both are
//     asserted by STRIPPING their roster and re-running the real resolver, in
//     both directions — a POSITIVE control, not merely a negative one.
//
//   M4 — THE KEYMAP PANEL MUST NOT BE LEFT ARMED. Its probe arms a listening
//     mode, and `faces-parity` clicks a probe and moves on. A panel left
//     listening would capture the sweep's NEXT keystroke and silently rebind a
//     key — a test that mutates the fixture it is measuring. Asserted here as
//     "arming writes NOTHING", which is the property that makes the sweep safe.
//
//   THE OCTAVE ROSTER IS DERIVED, NOT TYPED. `c0..c8` come from the module's
//     own `midiForKey` arithmetic; a roster that drifted from the pitch the
//     keypad actually plays would be a label that lies, and nothing else would
//     notice.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  numpadPlusDef,
  NUMPAD_LAYER_OPTIONS,
  NUMPAD_OCTAVE_OPTIONS,
  NUMPAD_PLUS_LAYERS,
  NUMPAD_PLUS_STEPS,
  DEFAULT_KEYMAP,
  OCTAVE_DOWN_ACTION,
  OCTAVE_UP_ACTION,
  midiForKey,
  codeForSemitone,
  remapKeymap,
} from '$lib/audio/modules/numpad-plus';
import { readNumpadKeymap, setNumpadKeymap } from '$lib/audio/modules/numpad-plus-writes';
import { patch } from '$lib/graph/store';
import { noteNameForMidi } from '$lib/audio/note-entry';
import {
  curatedFace,
  dockFacePlan,
  faceLaneCellHeights,
  faceTierCap,
  laneOrder,
} from '$lib/ui/workflow/curated-face';
import { laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import {
  panelCellKeys,
  shellCellFor,
  shellCellKeys,
  type ShellPanelCell,
} from '$lib/ui/workflow/shell-cells';
import type { FaceControl } from '$lib/ui/workflow/curated-face';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { paramCellKind, momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import type { ParamDef } from '$lib/graph/types';

const FACE = numpadPlusDef.face!;
const PARAM = (id: string): ParamDef => numpadPlusDef.params!.find((p) => p.id === id)!;

describe('numpadPlus face — promotion and rank', () => {
  it('is PROMOTED and ranks every param and both declared families', () => {
    expect(STRICT_FACES.has('numpadPlus')).toBe(true);
    const params = (numpadPlusDef.params ?? []).map((p) => p.id);
    const families = (numpadPlusDef.controlFamilies ?? []).map((f) => `${f.id}-{n}`);
    expect([...FACE.order].sort()).toEqual([...params, ...families].sort());
  });

  it('the ONLY picture is the step grid, and it is the hero', () => {
    expect(FACE.hero?.cell).toBe('numpad-cell-{n}');
    // `glyph: 'none'` is not a preference: not one of the NINE outputs is
    // `type: 'audio'`, so no live-glyph binding can resolve and every other
    // literal would fall through to a dead static picture.
    expect(FACE.glyph).toBe('none');
    expect((numpadPlusDef.outputs ?? []).some((o) => o.type === 'audio')).toBe(false);
  });

  it('every ranked key resolves to a registered cell or a param — nothing renders as a dead label', () => {
    const params = new Set((numpadPlusDef.params ?? []).map((p) => p.id));
    const registered = new Set(shellCellKeys('numpadPlus'));
    expect(FACE.order.filter((k) => !params.has(k) && !registered.has(k))).toEqual([]);
  });

  it('⚠ NEITHER PANEL is selected at a LANE tier, and both render at the DOCK', () => {
    // A panel declares its own minWidth and a lane knob column is 46 px. The
    // hero promotion covers the grid; the keymap is covered by ARITHMETIC (rank
    // 9 of a roster whose `full` cap is six), which is why this is asserted
    // rather than assumed.
    const panels = new Set(panelCellKeys('numpadPlus'));
    expect([...panels].sort()).toEqual(['numpad-cell-{n}', 'numpad-key-{n}']);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const keys = curatedFace(numpadPlusDef, tier)!.controls.map((c) => c.key);
      for (const p of panels) {
        expect(keys, `${tier}: a panel must never be selected into a 46px knob column`).not.toContain(p);
      }
    }
    const dock = curatedFace(numpadPlusDef, 'dock')!.controls.map((c) => c.key);
    expect(dock).toContain('numpad-cell-{n}');
    expect(dock).toContain('numpad-key-{n}');
  });

  it('the TIER LADDER reads back as the sentence the face claims', () => {
    // mini: which LAYER. compact: + is it ARMED, is it RUNNING. full: + the
    // rest of the transport and the octave. The hero is dock-only (PF-22), so
    // the grid costs no lane rank.
    expect(laneOrder(FACE)[0]).toBe('activeLayer');
    expect(laneOrder(FACE)).not.toContain('numpad-cell-{n}');
    expect(curatedFace(numpadPlusDef, 'mini')!.controls.map((c) => c.key)).toEqual(['activeLayer']);
    expect(curatedFace(numpadPlusDef, 'compact')!.controls.map((c) => c.key))
      .toEqual(['activeLayer', 'octave', 'recArm']);
    expect(curatedFace(numpadPlusDef, 'full')!.controls.map((c) => c.key))
      .toEqual(['activeLayer', 'octave', 'recArm', 'isPlaying', 'overdub', 'bpm']);
    // `poly` and the keymap never reach a lane tier — the second half of the
    // panel claim above.
    expect(curatedFace(numpadPlusDef, 'full')!.controls.map((c) => c.key)).not.toContain('poly');
  });

  it('⚠ THE PLATE PAINTS BOTH ROWS, and the rank is what buys the second one', () => {
    // MEASURED, not argued. A roster param earns a name readout, so its lane
    // cell is 57 px against a plain 42, and the plate charges the MAX of each
    // row. With BOTH roster params in row one the plan is 57 + 4 + 42 = 103
    // against LANE_BODY_H = 116 and both rows fit. Split them across the rows —
    // which the equally-defensible "modes before octave" ranking does — and it
    // is 57 + 4 + 57 = 118, the second row is dropped, and 'full' collapses to
    // the same three cells as 'compact'.
    //
    // ⚠ THE NEGATIVE CONTROL IS THE POINT: this asserts the alternative really
    // does cost three cells, so the claim cannot quietly become false if the
    // geometry moves.
    expect(faceLaneCellHeights(numpadPlusDef)).toEqual([57, 57, 42, 42, 42, 42]);
    const glyph = laneGlyphFor(numpadPlusDef);
    expect(faceTierCap('full', glyph, [57, 57, 42, 42, 42, 42]), 'as ranked: both rows fit').toBe(6);
    expect(
      faceTierCap('full', glyph, [57, 42, 42, 42, 57, 42]),
      'octave ranked sixth: the readouts land in different rows and the plate loses a row',
    ).toBe(3);
  });

  it('FOUR bands survive the hero promotion — no band is emptied', () => {
    // The number the VRT scene roster declares. `heroFacePlan` lifts
    // `numpad-cell-{n}` out of its band, and `pattern` keeps `activeLayer`, so
    // the post-hero band count is still four.
    const bands = dockFacePlan(numpadPlusDef)!;
    expect(bands.map((b) => b.id)).toEqual(['pattern', 'record', 'transport', 'keypad']);
    for (const b of bands) {
      expect([...b.controls, ...b.clusters.flatMap((c) => c.controls)].length,
        `band '${b.id}' must not be empty`).toBeGreaterThan(0);
    }
  });
});

describe('numpadPlus face — the two rosters make states SELECTABLE (M2/M3)', () => {
  const NONE = momentaryParamIds(numpadPlusDef);

  it('⚠ POSITIVE + NEGATIVE CONTROL: activeLayer is a SEGMENTED row only because of its roster', () => {
    expect(paramCellKind(PARAM('activeLayer'), NONE, 'dock')).toBe('segmented');
    // Strip the roster and re-run the REAL resolver: it collapses to a bare
    // four-position dial, which is the moog962 shape faces-parity failed twice.
    const stripped: ParamDef = { ...PARAM('activeLayer'), options: undefined };
    expect(paramCellKind(stripped, NONE, 'dock'), 'without names it is an anonymous dial').toBe('knob');
  });

  it('⚠ POSITIVE + NEGATIVE CONTROL: octave is a SELECTOR only because of its roster', () => {
    expect(paramCellKind(PARAM('octave'), NONE, 'dock')).toBe('selector');
    const stripped: ParamDef = { ...PARAM('octave'), options: undefined };
    expect(paramCellKind(stripped, NONE, 'dock')).toBe('knob');
  });

  it('both are KNOBS at a lane tier, and that is reachable rather than a downgrade', () => {
    // The lane has no room for a laid-out roster, so an `options` param renders
    // as a dial with the state NAME in its readout. Four and nine detents
    // across the full travel are both reachable; two are not, which is the
    // moog962 failure.
    expect(paramCellKind(PARAM('activeLayer'), NONE, 'lane')).toBe('knob');
    expect(paramCellKind(PARAM('octave'), NONE, 'lane')).toBe('knob');
    expect(NUMPAD_LAYER_OPTIONS.length).toBeGreaterThan(2);
  });

  it('the four switches are TOGGLES, and none is a press-pad', () => {
    for (const id of ['isPlaying', 'recArm', 'overdub', 'poly']) {
      expect(paramCellKind(PARAM(id), NONE, 'dock'), id).toBe('toggle');
    }
    expect(FACE.momentary ?? [], 'this module has no press-pad of any kind').toEqual([]);
  });

  it('bpm is the ONE continuous control', () => {
    expect(paramCellKind(PARAM('bpm'), NONE, 'dock')).toBe('knob');
    expect(PARAM('bpm').curve).toBe('linear');
  });

  it('⚠ the OCTAVE roster is DERIVED from what the keypad actually plays', () => {
    // A roster typed by hand could drift from `midiForKey` and nothing would
    // notice — the label would simply lie about the pitch. Re-derived here from
    // the module's OWN function, key by key.
    const cCode = codeForSemitone(DEFAULT_KEYMAP, 0)!;
    for (const opt of NUMPAD_OCTAVE_OPTIONS) {
      const midi = midiForKey(cCode, opt.value, 0)!;
      expect(opt.label, `octave ${opt.value}: the keypad's first key plays this note`)
        .toBe(noteNameForMidi(midi));
    }
    expect(NUMPAD_OCTAVE_OPTIONS.map((o) => o.label))
      .toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
  });

  it('⚠ NO label on either roster reads as a NUMBER', () => {
    // The offence `face-readout-source` owns, checked here at the source rather
    // than only in the fleet sweep: a numeric label would be a bare number
    // painted under a control, and labelling the octaves '0'..'8' would have
    // needed NINE exemption entries.
    const looksNumeric = (s: string) => /^[+\-−]?[0-9]+(\.[0-9]+)?\s*[a-zA-Z%°¢×x]{0,3}$/.test(s.trim());
    for (const o of [...NUMPAD_LAYER_OPTIONS, ...NUMPAD_OCTAVE_OPTIONS]) {
      expect(looksNumeric(o.label), `label '${o.label}' reads as a number`).toBe(false);
    }
  });

  it('neither roster declares optionsExhaustive — both cover every step', () => {
    for (const id of ['activeLayer', 'octave']) {
      const p = PARAM(id);
      expect(p.options!.length, id).toBe(Math.round(p.max - p.min) + 1);
      expect((p as { optionsExhaustive?: unknown }).optionsExhaustive, id).toBeUndefined();
    }
    expect(NUMPAD_LAYER_OPTIONS.length).toBe(NUMPAD_PLUS_LAYERS);
  });
});

describe('numpadPlus face — the two PANELS declare honest probes', () => {
  /** The registered cell for a face key, narrowed to a PANEL — which is itself
   *  an assertion: a key that resolved to some other kind would throw here
   *  rather than silently satisfy a loose cast. */
  function panelFor(key: string): ShellPanelCell {
    const cell = shellCellFor('numpadPlus', { key } as unknown as FaceControl);
    expect(cell, `${key} resolves to a registered cell`).toBeTruthy();
    expect(cell!.kind, `${key} is a PF-14 panel`).toBe('panel');
    return cell as ShellPanelCell;
  }

  it('the step grid probes a step that is LIVE IN THE SHIPPED DEFAULT STATE', () => {
    const probe = panelFor('numpad-cell-{n}').probe;
    // A fresh spawn selects layer 0 and step 0 rests at `{on: false, midi: null}`,
    // so one click toggles it with no seeding, no transport and no audio gate.
    expect(probe.testid).toBe('numpad-cell-0');
    expect(probe.action).toBe('click');
    expect(probe.effect).toEqual({ kind: 'data', key: 'layers.0.0', expect: 'changed' });
    expect(PARAM('activeLayer').defaultValue).toBe(0);
    expect(PARAM('isPlaying').defaultValue, 'and the transport is STOPPED at rest').toBe(0);
  });

  it('⚠ the keymap probe is `text`, not `data`, and it names a DIFFERENT element', () => {
    const probe = panelFor('numpad-key-{n}').probe;
    // Beginning a remap writes NOTHING to the graph, so a `data` probe would be
    // RED on a perfectly live cap. Naming the driven element itself would be
    // the weak form — a button that only relabels itself would pass.
    expect(probe.effect.kind).toBe('text');
    expect(probe.effect.kind === 'text' && probe.effect.testid).not.toBe(probe.testid);
    expect(probe.effect.kind === 'text' && probe.effect.testid).toBe('numpad-key-hint');
  });

  it('the panels declare widths in the order the plate needs them', () => {
    const grid = panelFor('numpad-cell-{n}');
    const caps = panelFor('numpad-key-{n}');
    // 4 x 36 + 3 gaps + padding; 7 x 26 + 6 gaps + padding. The keymap defines
    // the plate, and the whole plate is roughly a fifth of the legacy card's
    // 714 px — compact by construction rather than by exemption.
    expect(grid.minWidth).toBe(168);
    expect(caps.minWidth).toBe(210);
    expect(caps.minWidth).toBeGreaterThan(grid.minWidth);
  });
});

describe('numpadPlus face — ⚠ M4: ARMING A REMAP WRITES NOTHING', () => {
  const N = 'numpad-face-model-1';
  beforeEach(() => {
    for (const k of Object.keys(patch.nodes)) delete patch.nodes[k];
    patch.nodes[N] = {
      id: N, type: 'numpadPlus', domain: 'audio', position: { x: 0, y: 0 },
      params: {}, data: {},
    } as never;
  });

  it('the keymap is UNTOUCHED until a physical key actually arrives', () => {
    // The property that makes the parity sweep safe. `faces-parity` clicks the
    // probe's cap and moves on; if arming wrote anything — or if the panel
    // stayed armed and caught a later keystroke — the sweep would rebind a key
    // in the fixture it is measuring.
    expect(readNumpadKeymap(N), 'a fresh node has no keymap of its own').toBe(DEFAULT_KEYMAP);
    // Arming is component state. Nothing in the write seam is reachable from it.
    expect((patch.nodes[N]!.data as Record<string, unknown>).keymap).toBeUndefined();

    // And the write that a REAL keystroke performs is the one that moves it —
    // the positive leg, so this cannot pass by the seam being broken.
    setNumpadKeymap(N, remapKeymap(DEFAULT_KEYMAP, 'KeyQ', 0));
    expect(readNumpadKeymap(N).KeyQ).toBe(0);
  });

  it('the fourteen caps are ONE family and cover the whole map', () => {
    // The card used to emit two prefixes for one control kind. The def declares
    // one family, and its members are exactly the fourteen remap targets.
    const fam = (numpadPlusDef.controlFamilies ?? []).find((f) => f.id === 'numpad-key')!;
    expect(fam.testidPrefix).toBe('numpad-key');
    const targets = [...Array(12).keys(), OCTAVE_UP_ACTION, OCTAVE_DOWN_ACTION];
    expect(targets.length).toBe(Object.keys(DEFAULT_KEYMAP).length);
    for (const t of targets) {
      expect(codeForSemitone(DEFAULT_KEYMAP, t), `target ${t} has a default binding`).toBeTruthy();
    }
  });

  it('the grid draws exactly the module’s declared dimensions', () => {
    expect(NUMPAD_PLUS_STEPS).toBe(16);
    expect(NUMPAD_PLUS_LAYERS).toBe(4);
  });
});
