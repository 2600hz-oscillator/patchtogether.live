// packages/web/src/lib/ui/modules/score-face-model.test.ts
//
// SCORE's FACE, as pure model: what the plate ranks, what each band cell reads
// and writes, and where the removed numbers went. No DOM, no Y.Doc, no
// AudioContext.
//
// ⚠ THE PERMANENT NEGATIVE CONTROLS THIS FILE EXISTS FOR — each one a claim the
// face makes that nothing else in the repo can see:
//
//   1. THE SELECTION COUPLING. Four cells (ACC, DYN, TIE, END) read and write
//      "…of the selected note". That is this design's one real hazard: a cell
//      and the staff disagreeing about which note is on screen would be silent,
//      plausible and wrong. Asserted in BOTH directions — selecting moves every
//      one of them, and deselecting returns every one of them to its empty
//      state.
//
//   2. A DANGLING SELECTION IS NOT A SELECTION. `selectedNoteId` can name a note
//      a collaborator just deleted. Every cell must read that as "nothing
//      selected", not throw and not edit a ghost.
//
//   3. THE PAGE SHRINK IS NON-DESTRUCTIVE. `setPages(1)` on a four-page piece
//      must keep every note in `node.data`. A filter over `d.notes` in that
//      setter would turn a mis-click into permanent data loss — the defect it
//      exists to fix, inverted — and no other gate would notice.
//
//   4. THE SECOND PANEL IS PROTECTED BY ITS RANK, NOT BY A RULE. `score-slots`
//      is not the hero, so it stays in `laneOrder`; it is safe only because rank
//      16 exceeds the six-cell `full` cap. `panelCellKeys`'s own comment calls
//      that "a coincidence that a future cap bump silently removes". Asserted
//      here so a re-rank fails with a reason instead of failing later in
//      `module-face-lint` with a panel-in-a-knob-column message.
//
//   5. A FRESH SCORE WRITES NOTHING. `noteValue` and `selectedNoteId` are read
//      with absent-defaults and never seeded. A face that wrote its own defaults
//      would dirty every saved patch the moment it was opened and push a Y.Doc
//      update to every collaborator for doing nothing.
//
// ⚠ THE WRITE HALF IS NOT EXERCISED HERE, and the reason is stated rather than
// left to inference: `score-writes.ts` reaches the live store through
// `mutateNode`, so a unit lane with no Y.Doc can only test the READ half plus
// the pure helpers those writes are built from. The write half's own gate is
// `score-face.spec.ts`, which drives the real cells against a real graph. What
// IS asserted here is that every cell's read and write name the same subject —
// which is the half a mocked store would have made vacuous anyway.

import { describe, it, expect } from 'vitest';
import { scoreDef } from '$lib/audio/modules/score';
import { curatedFace, laneOrder, dockFacePlan, faceTierCap } from '$lib/ui/workflow/curated-face';
import { shellCellKeys, panelCellKeys, shellPanelProbes } from '$lib/ui/workflow/shell-cells';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import type { ModuleNode } from '$lib/graph/types';
import {
  BARS_PER_PAGE,
  DYNAMIC_SCALE,
  MAX_PAGES,
  NOTE_DURATIONS,
  coerceScoreData,
  keySignatureName,
  nextNoteAfter,
  sortedNotes,
  type ScoreData,
  type ScoreNote,
} from '$lib/audio/modules/score-data';
import {
  isTiedToNext,
  readArmedAccidental,
  readArmedDynamic,
  readArmedTie,
  readNoteValue,
  readSelectedNote,
} from '$lib/audio/modules/score-writes';
import {
  SCORE_NONE,
  scoreAccidentalOptions,
  scoreAccidentalValue,
  scoreDynInForce,
  scoreDynOptions,
  scoreDynValue,
  scoreKeyOptions,
  scoreKeyValue,
  scoreLoopValue,
  scorePagesOptions,
  scorePagesValue,
  scoreStopOptions,
  scoreStopValue,
  scoreTieValue,
  scoreValueOptions,
  scoreValueValue,
} from './score-cell-actions';
import {
  beatOf,
  noteAriaLabel,
  scoreDynAriaLabel,
  scoreSlotsAriaLabel,
  scoreStaffAriaLabel,
} from './score/score-aria';

const FACE = scoreDef.face!;

function note(over: Partial<ScoreNote> & { id: string }): ScoreNote {
  return {
    bar: 0,
    tick: 0,
    duration: 'quarter',
    midi: 72,
    staffStep: 3,
    accidental: null,
    ...over,
  };
}

/** A node carrying `data`, with no params set. */
function nodeWith(data: Record<string, unknown>): ModuleNode {
  return {
    id: 's',
    type: 'score',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data,
  } as unknown as ModuleNode;
}

/** Every SELECTION-COUPLED cell's rendered value, as one comparable record. */
function markCells(node: ModuleNode) {
  return {
    accidental: scoreAccidentalValue(node),
    dyn: scoreDynValue(node),
    tie: scoreTieValue(node),
    stop: scoreStopValue(node),
  };
}

// ── THE DECLARATION ─────────────────────────────────────────────────────────

describe('score face — the declaration', () => {
  it('is PROMOTED and ranks the STAFF first', () => {
    expect(STRICT_FACES.has('score')).toBe(true);
    expect(FACE.order[0]).toBe('score-note-{n}');
    expect(FACE.hero?.cell).toBe('score-note-{n}');
  });

  it('the staff is a PANEL, and PF-22 keeps it out of every lane tier', () => {
    expect(panelCellKeys('score')).toContain('score-note-{n}');
    expect(laneOrder(FACE)).not.toContain('score-note-{n}');
    expect(laneOrder(FACE)[0], 'the lane leads with the transport').toBe('isPlaying');
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(
        curatedFace(scoreDef, tier)!.controls.map((c) => c.key),
        `${tier}: a 720px staff must never be selected into a 46px knob column`,
      ).not.toContain('score-note-{n}');
    }
    expect(curatedFace(scoreDef, 'dock')!.controls.map((c) => c.key)).toContain('score-note-{n}');
    expect(dockFacePlan(scoreDef)).toBeTruthy();
  });

  // ⚠ NEGATIVE CONTROL 4 — the second panel's protection is ARITHMETIC.
  it('the QUICKSAVE panel is kept out of the lane by its RANK, and the margin is asserted', () => {
    const lane = laneOrder(FACE);
    expect(lane, 'not the hero, so it stays in the lane roster').toContain('score-slots-{n}');
    const rank = lane.indexOf('score-slots-{n}');
    const cap = faceTierCap('full', laneGlyphFor(scoreDef));
    expect(
      rank,
      `score-slots-{n} sits at lane rank ${rank} against a 'full' cap of ${cap}. It is a PANEL, ` +
        'and a panel selected into a lane knob column is an authoring bug module-face-lint ' +
        'refuses. Nothing but this margin protects it — if you re-ranked the face, either move ' +
        'it back below the cap or make it the hero.',
    ).toBeGreaterThanOrEqual(cap);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(curatedFace(scoreDef, tier)!.controls.map((c) => c.key)).not.toContain(
        'score-slots-{n}',
      );
    }
  });

  it('every ranked key resolves to a registered, non-inert cell or a param', () => {
    const params = new Set(scoreDef.params.map((p) => p.id));
    const registered = new Set(shellCellKeys('score'));
    const inert = FACE.order.filter((k) => !params.has(k) && !registered.has(k));
    expect(inert, 'a ranked key with no registered cell renders as a dead dashed label').toEqual([]);
    const orphans = [...registered].filter((k) => !FACE.order.includes(k));
    expect(orphans, 'a registered cell that no face key ranks is dead code').toEqual([]);
  });

  it('FIVE bands, no tab rail — the honest grouping, not a padded one', () => {
    expect(FACE.pages?.map((p) => p.id)).toEqual([
      'score', 'marks', 'transport', 'envelope', 'slots',
    ]);
    expect(FACE.tabbed, 'face.tabbed is owner-instruction-only').toBeUndefined();
    // END and LOOP are one decision in two controls, so they are a CLUSTER
    // inside `marks` rather than a sixth band.
    const marks = FACE.pages!.find((p) => p.id === 'marks')!;
    expect(marks.clusters?.map((c) => c.label)).toEqual(['ending']);
    expect(marks.clusters![0].controls).toEqual(['score-stop-{n}', 'score-loop-{n}']);
  });

  it('declares NO glyph and NO shell extension — the seam has nothing to bind', () => {
    expect(FACE.glyph).toBe('none');
    expect(FACE.extension).toBeUndefined();
    // The mechanical reason, asserted rather than asserted-about: a live glyph
    // resolves through the first `audio`-typed OUTPUT, and score has none.
    expect(scoreDef.outputs.map((o) => o.type)).toEqual(['pitch', 'gate', 'cv', 'gate']);
    expect(scoreDef.outputs.some((o) => o.type === 'audio')).toBe(false);
  });

  it('both PANELS declare a probe, and neither targets a control- testid', () => {
    const probes = shellPanelProbes().score ?? {};
    expect(Object.keys(probes).sort()).toEqual(['score-note-{n}', 'score-slots-{n}']);
    for (const [key, probe] of Object.entries(probes)) {
      expect(probe.testid, `${key}: a panel must never emit a control- testid`).not.toMatch(
        /^control-/,
      );
      expect(probe.effect.kind, `${key}: prefer a data probe over a revision counter`).toBe('data');
    }
  });
});

// ── THE SELECTION MODEL ─────────────────────────────────────────────────────

describe('score face — the SELECTION is what makes the mark cells cells', () => {
  const n1 = note({ id: 'a', bar: 0, tick: 0 });
  const n2 = note({ id: 'b', bar: 0, tick: 12, midi: 74, staffStep: 2 });

  // ⚠ NEGATIVE CONTROL 1, direction A: nothing selected ⇒ every mark cell falls
  // back to its ARMED value. On a fresh score nothing is armed either, so they
  // all read empty — but the fallback is what keeps them LIVE, and asserting
  // both halves is what stops a future edit from quietly making them inert
  // again (which is how the first version of this face shipped, and what
  // `faces-parity` caught).
  it('with NOTHING selected every mark cell reads its ARMED value', () => {
    const bare = nodeWith({ notes: [n1, n2] });
    expect(readSelectedNote(bare)).toBeNull();
    expect(markCells(bare), 'nothing armed, nothing selected').toEqual({
      accidental: SCORE_NONE,
      dyn: SCORE_NONE,
      tie: false,
      stop: SCORE_NONE,
    });

    const armed = nodeWith({
      notes: [n1, n2],
      armedAccidental: 'flat',
      armedDynamic: 'pp',
      armedTie: true,
    });
    expect(readSelectedNote(armed), 'still nothing SELECTED').toBeNull();
    expect(
      markCells(armed),
      'and yet every cell paints the state it holds — an inert cell is the sixstrum defect',
    ).toEqual({ accidental: 'flat', dyn: 'pp', tie: true, stop: SCORE_NONE });
  });

  // ⚠ THE SELECTION WINS OVER THE ARMED VALUE, in both directions. A cell that
  // preferred the armed value would show the wrong thing for the note you are
  // looking at; one that had no armed fallback would be inert.
  it('a SELECTION overrides the armed value, and deselecting restores it', () => {
    const armedOnly = { armedAccidental: 'flat', armedDynamic: 'pp', armedTie: true };
    const selected = nodeWith({
      ...armedOnly,
      notes: [note({ id: 'a', accidental: 'sharp' }), n2],
      selectedNoteId: 'a',
    });
    expect(scoreAccidentalValue(selected), 'the NOTE, not the armed value').toBe('sharp');
    expect(scoreDynValue(selected), 'no marker at this note').toBe(SCORE_NONE);
    expect(scoreTieValue(selected), 'this note is not tied').toBe(false);

    const deselected = nodeWith({ ...armedOnly, notes: [n1, n2] });
    expect(scoreAccidentalValue(deselected)).toBe('flat');
    expect(scoreDynValue(deselected)).toBe('pp');
    expect(scoreTieValue(deselected)).toBe(true);
  });

  // ⚠ NEGATIVE CONTROL 1, direction B: selecting moves EVERY one of them, and
  // selecting the OTHER note moves them again. A cell that had silently frozen
  // on the first note would pass direction A and fail here.
  it('selecting a note moves every mark cell, and switching notes moves them again', () => {
    const base = {
      notes: [n1, { ...n2, accidental: 'sharp' as const }],
      dynamics: [{ id: 'd1', bar: 0, tick: 12, level: 'ff' as const }],
      ties: [{ id: 't1', fromNoteId: 'a', toNoteId: 'b' }],
      stopBar: { bar: 0, tick: 24 },
    };
    const onA = nodeWith({ ...base, selectedNoteId: 'a' });
    const onB = nodeWith({ ...base, selectedNoteId: 'b' });

    expect(markCells(onA)).toEqual({
      accidental: SCORE_NONE, // a carries no accidental of its own
      dyn: SCORE_NONE, // the ff marker sits at b's position, not a's
      tie: true, // a is tied forward to b
      stop: 'here', // a stop bar exists
    });
    expect(markCells(onB)).toEqual({
      accidental: 'sharp',
      dyn: 'ff',
      tie: false, // b is the LAST note; there is nothing after it to tie to
      stop: 'here',
    });
    expect(markCells(onA), 'the two selections must not read alike').not.toEqual(markCells(onB));
  });

  // ⚠ NEGATIVE CONTROL 2 — a selection naming a note that no longer exists.
  it('a DANGLING selectedNoteId reads as nothing selected, on every cell', () => {
    const node = nodeWith({ notes: [n1], selectedNoteId: 'deleted-by-a-collaborator' });
    expect(readSelectedNote(node)).toBeNull();
    expect(markCells(node)).toEqual({
      accidental: SCORE_NONE,
      dyn: SCORE_NONE,
      tie: false,
      stop: SCORE_NONE,
    });
    expect(scoreDynAriaLabel(readSelectedNote(node), coerceScoreData(node.data))).toBe(
      'no note selected',
    );
  });

  it('the DYN cell shows the marker HERE, never the level in force', () => {
    // A marker at bar 0 forward-fills to bar 4 — but bar 4's note carries no
    // marker of its own, and a selector claiming otherwise would silently ADD a
    // second marker when you re-picked the level already in force.
    const far = note({ id: 'c', bar: 4, tick: 0 });
    const node = nodeWith({
      notes: [n1, far],
      dynamics: [{ id: 'd1', bar: 0, tick: 0, level: 'pp' }],
      selectedNoteId: 'c',
    });
    expect(scoreDynValue(node), 'no marker at this position').toBe(SCORE_NONE);
    expect(scoreDynInForce(node), 'but pp is what it will sound like').toBe('pp');
    expect(scoreDynAriaLabel(readSelectedNote(node), coerceScoreData(node.data))).toBe(
      'no marking here; sounding pianissimo',
    );
  });

  it('TIE means "to the NEXT note in score order", and the order is total', () => {
    // Score order is by absolute position, so a note in a later BAR follows one
    // at a higher tick of an earlier bar.
    const early = note({ id: 'x', bar: 0, tick: 36 });
    const late = note({ id: 'y', bar: 1, tick: 0 });
    expect(sortedNotes([late, early]).map((n) => n.id)).toEqual(['x', 'y']);
    expect(nextNoteAfter('x', [late, early])?.id).toBe('y');
    expect(nextNoteAfter('y', [late, early]), 'the last note has no successor').toBeNull();

    const tied = nodeWith({
      notes: [early, late],
      ties: [{ id: 't', fromNoteId: 'x', toNoteId: 'y' }],
      selectedNoteId: 'x',
    });
    expect(isTiedToNext(tied, 'x')).toBe(true);
    expect(scoreTieValue(tied)).toBe(true);

    // ⚠ A tie to something OTHER than the successor must not light this cell —
    // otherwise turning the toggle off would appear to do nothing.
    const mid = note({ id: 'z', bar: 0, tick: 40 });
    const skipped = nodeWith({
      notes: [early, mid, late],
      ties: [{ id: 't', fromNoteId: 'x', toNoteId: 'y' }],
      selectedNoteId: 'x',
    });
    expect(scoreTieValue(skipped)).toBe(false);
  });
});

// ── THE ROSTERS ─────────────────────────────────────────────────────────────

describe('score face — every roster is DERIVED from the module, not re-typed', () => {
  it('VALUE offers exactly the durations the engine can place', () => {
    expect(scoreValueOptions().map((o) => o.value)).toEqual([...NOTE_DURATIONS]);
    // …and every label is a NAME, never a tick count.
    for (const o of scoreValueOptions()) expect(o.label).toMatch(/^[a-z]+$/);
  });

  it('DYN offers exactly the declared dynamic levels, plus an explicit none', () => {
    expect(scoreDynOptions().map((o) => o.value)).toEqual([
      SCORE_NONE,
      ...Object.keys(DYNAMIC_SCALE),
    ]);
  });

  it('PAGES offers exactly 1..MAX_PAGES — the control the card never had', () => {
    expect(scorePagesOptions().map((o) => o.value)).toEqual(['1', '2', '3', '4']);
    expect(scorePagesOptions()).toHaveLength(MAX_PAGES);
  });

  it('KEY offers the full cycle-of-fifths span, named by its major key', () => {
    const opts = scoreKeyOptions();
    expect(opts).toHaveLength(15);
    expect(opts[0].value).toBe('-7');
    expect(opts[14].value).toBe('7');
    expect(opts.find((o) => o.value === '0')!.label).toBe('C major');
    expect(opts.find((o) => o.value === '1')!.label).toBe('G major');
    // ⚠ NO SIGNED INTEGER SURVIVES INTO A LABEL. `+2` would restate the
    // control's own roster position; `D major` is what the state IS.
    for (const o of opts) expect(o.label, o.value).not.toMatch(/[+-]?\d/);
  });

  it('ACC and END name STATES, and both carry an explicit empty option first', () => {
    expect(scoreAccidentalOptions()[0].value).toBe(SCORE_NONE);
    expect(scoreStopOptions().map((o) => o.value)).toEqual([SCORE_NONE, 'here']);
  });

  it('every cell reads the SHIPPED default of a fresh, unwritten node', () => {
    // ⚠ NEGATIVE CONTROL 5 — a fresh score has literally no `data`.
    const fresh = nodeWith({});
    expect(readNoteValue(fresh), 'absent noteValue reads as the card default').toBe('quarter');
    expect(readSelectedNote(fresh)).toBeNull();
    // The three ARMED keys read absent too — a face that seeded them would dirty
    // every saved patch on open just as surely as one that seeded a selection.
    expect(readArmedAccidental(fresh)).toBeNull();
    expect(readArmedDynamic(fresh)).toBeNull();
    expect(readArmedTie(fresh)).toBe(false);
    expect(scoreValueValue(fresh)).toBe('quarter');
    expect(scoreKeyValue(fresh)).toBe('0');
    expect(scorePagesValue(fresh)).toBe('1');
    expect(scoreLoopValue(fresh)).toBe(false);
    expect(scoreStopValue(fresh)).toBe(SCORE_NONE);
    // And the same on a node with NO data key at all.
    const bare = { id: 's', type: 'score', domain: 'audio', position: { x: 0, y: 0 }, params: {} } as unknown as ModuleNode;
    expect(scoreValueValue(bare)).toBe('quarter');
    expect(scorePagesValue(bare)).toBe('1');
  });
});

// ── THE PAGE SHRINK ─────────────────────────────────────────────────────────

describe('score face — shrinking the piece is NON-DESTRUCTIVE', () => {
  // ⚠ NEGATIVE CONTROL 3. `setPages` reaches the live store, so the property is
  // asserted on the SHAPE the setter produces: `pages` moves and `notes` does
  // not. A filter over `d.notes` in that setter is the failure this pins.
  it('a note on page 3 SURVIVES a shrink to one page and comes back', () => {
    const onPage3 = note({ id: 'far', bar: 2 * BARS_PER_PAGE + 1 });
    const four: ScoreData = { ...coerceScoreData({ pages: 4, notes: [onPage3] }) };
    expect(four.pages).toBe(4);
    expect(four.notes).toHaveLength(1);

    // What `setPages(1)` writes: pages, and nothing else.
    const shrunk = coerceScoreData({ ...four, pages: 1 });
    expect(shrunk.pages).toBe(1);
    expect(
      shrunk.notes.map((n) => n.id),
      'shrinking must not delete music — a mis-click would be permanent data loss',
    ).toEqual(['far']);

    // The note is out of range while shrunk (bar 33 of 16 allocated) …
    expect(onPage3.bar).toBeGreaterThanOrEqual(shrunk.pages * BARS_PER_PAGE);
    // … and back in range when it grows again.
    const regrown = coerceScoreData({ ...shrunk, pages: 4 });
    expect(onPage3.bar).toBeLessThan(regrown.pages * BARS_PER_PAGE);
    expect(regrown.notes.map((n) => n.id)).toEqual(['far']);
  });

  it('the coercion clamps a page count the engine could not walk', () => {
    expect(coerceScoreData({ pages: 99 }).pages).toBe(MAX_PAGES);
    expect(coerceScoreData({ pages: 0 }).pages).toBe(1);
    expect(coerceScoreData({ pages: -3 }).pages).toBe(1);
  });
});

// ── WHERE THE REMOVED NUMBERS WENT ──────────────────────────────────────────

describe('score face — the ARIA contract carries every deleted readout', () => {
  it('the staff names its note count, its bars, its key, its page and its playhead', () => {
    const data = coerceScoreData({
      pages: 2,
      keySignature: 1,
      notes: [note({ id: 'a', bar: 0, tick: 24, midi: 72 }), note({ id: 'b', bar: 3, tick: 0 })],
    });
    const label = scoreStaffAriaLabel(data, 1, 'a', 'b');
    expect(label).toContain('2 notes over 32 bars');
    expect(label).toContain('showing page 2 of 2');
    expect(label).toContain('key of G major');
    // The playhead readout the card would have PRINTED as `bar 1 · beat 3`.
    expect(label).toContain('playing bar 1, beat 3');
    // ⚠ LOWERCASE, because `noteNameForMidi` is the shared helper the whole app
    // names pitches with — the face invents no second spelling.
    expect(label).toContain('c5 selected');
  });

  it('an EMPTY score says so rather than printing a zero', () => {
    const label = scoreStaffAriaLabel(coerceScoreData({}), 0, null, null);
    expect(label).toContain('empty staff');
    expect(label).toContain('not playing');
    expect(label).toContain('no note selected');
    expect(label, 'a count of zero is still a count').not.toContain('0 notes');
  });

  it('beats are 1-based quarters of the 48-tick bar', () => {
    expect([0, 11, 12, 24, 36, 47].map(beatOf)).toEqual([1, 1, 2, 3, 4, 4]);
  });

  it('a note names its pitch, value, position and both of its states', () => {
    const n = note({ id: 'a', bar: 1, tick: 12, midi: 73, accidental: 'sharp', duration: 'eighth' });
    expect(noteAriaLabel(n, false, false)).toBe('eighth note c#5, sharp, bar 2, beat 2');
    expect(noteAriaLabel(n, true, true)).toBe(
      'eighth note c#5, sharp, bar 2, beat 2, selected, sounding',
    );
  });

  it('the quicksave panel names what was legible on the card only as COLOUR', () => {
    expect(scoreSlotsAriaLabel([], null, null, null)).toBe('no saved patterns; nothing armed');
    expect(scoreSlotsAriaLabel(['1', '3'], '3', '1', 'queue')).toBe(
      'slots 1 and 3 saved; slot 1 last loaded; slot 3 queued for the end of this pass; queue armed',
    );
  });

  it('the KEY SIGNATURE has a name at every legal value, and clamps outside them', () => {
    for (let ks = -7; ks <= 7; ks++) expect(keySignatureName(ks)).toMatch(/major$/);
    expect(keySignatureName(99)).toBe('C sharp major');
    expect(keySignatureName(-99)).toBe('C flat major');
  });

  it('ff is the ONE dynamic above unity — the fact the card only showed in a tooltip', () => {
    // The card's dynamics buttons carried `title="Dynamic ff (105%)"`, which was
    // the only place a player could learn that this marking pushes ENV past full
    // scale. A `title` is unpainted and may stay on the card; the FACE prints no
    // percentage at all, so the arithmetic needs a home that is not a renderer.
    expect(DYNAMIC_SCALE.ff).toBeGreaterThan(1);
    const others = Object.entries(DYNAMIC_SCALE).filter(([k]) => k !== 'ff');
    for (const [k, v] of others) expect(v, `${k} must stay at or below unity`).toBeLessThanOrEqual(1);
  });
});
