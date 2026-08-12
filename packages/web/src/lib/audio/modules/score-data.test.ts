// packages/web/src/lib/audio/modules/score-data.test.ts
//
// Pure-data unit tests for the SCORE module. Covers tickWidth,
// barCapacityRemaining, canPlace (overflow + overlap + range),
// staffStepToMidi (key sig + accidentals), dynamicAt, tieSpanNotes,
// tie chain helpers, dynamics scale (v2 numbers), data migration
// (v1 single-array -> v2 page model), and page-count constraint.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import {
  BARS_PER_PAGE,
  DEFAULT_PAGES,
  DYNAMIC_SCALE,
  MAX_PAGES,
  GRID_TICKS_PER_SLOT,
  NOTE_DURATIONS,
  TICKS_PER_BAR,
  TOTAL_BARS,
  SCORE_MIN_MIDI,
  SCORE_MAX_MIDI,
  barCapacityRemaining,
  canPlace,
  dynamicAt,
  emptyScoreData,
  placeableTicksInBar,
  reachableTicksInBar,
  slotEmitPlan,
  slotGridTicks,
  staffStepToMidi,
  tickWidth,
  tieChainFrom,
  tieRoleFor,
  tieSpanNotes,
  totalBars,
  type ScoreNote,
  type DynamicMarker,
  type Tie,
} from './score-data';

function note(opts: Partial<ScoreNote> & Pick<ScoreNote, 'bar' | 'tick' | 'duration' | 'midi' | 'staffStep'>): ScoreNote {
  return {
    id: opts.id ?? `${opts.bar}-${opts.tick}`,
    accidental: opts.accidental ?? null,
    ...opts,
  } as ScoreNote;
}

describe('tickWidth', () => {
  it('maps each duration to its tick count', () => {
    expect(tickWidth('whole')).toBe(48);
    expect(tickWidth('half')).toBe(24);
    expect(tickWidth('quarter')).toBe(12);
    expect(tickWidth('eighth')).toBe(6);
    expect(tickWidth('16th')).toBe(3);
    expect(tickWidth('triplet8th')).toBe(4);
  });
});

describe('barCapacityRemaining', () => {
  it('returns full bar capacity when empty', () => {
    expect(barCapacityRemaining(0, [])).toBe(TICKS_PER_BAR);
  });
  it('subtracts placed note widths', () => {
    const notes: ScoreNote[] = [
      note({ bar: 0, tick: 0, duration: 'half', midi: 60, staffStep: 5 }),
      note({ bar: 0, tick: 24, duration: 'quarter', midi: 60, staffStep: 5 }),
    ];
    expect(barCapacityRemaining(0, notes)).toBe(48 - 24 - 12);
  });
  it('ignores notes in other bars', () => {
    const notes: ScoreNote[] = [
      note({ bar: 1, tick: 0, duration: 'whole', midi: 60, staffStep: 5 }),
    ];
    expect(barCapacityRemaining(0, notes)).toBe(TICKS_PER_BAR);
  });
});

describe('canPlace', () => {
  const middleC = 60;
  it('rejects bar overflow', () => {
    const notes: ScoreNote[] = [];
    // Placing a half (24 ticks) at tick 36 -> end = 60 > 48 = overflow.
    expect(canPlace(0, 36, 'half', middleC, notes)).toBe(false);
  });
  it('rejects overlap', () => {
    const notes: ScoreNote[] = [
      note({ bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
    ];
    // Placing an eighth at tick 6 (overlaps the existing quarter ending at 12).
    expect(canPlace(0, 6, 'eighth', middleC, notes)).toBe(false);
  });
  it('allows abutting notes', () => {
    const notes: ScoreNote[] = [
      note({ bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
    ];
    // Quarter ends at tick 12; placing an eighth starting at 12 is valid.
    expect(canPlace(0, 12, 'eighth', middleC, notes)).toBe(true);
  });
  it('rejects out-of-range pitch', () => {
    expect(canPlace(0, 0, 'quarter', SCORE_MIN_MIDI - 1, [])).toBe(false);
    expect(canPlace(0, 0, 'quarter', SCORE_MAX_MIDI + 1, [])).toBe(false);
  });
  it('rejects out-of-range bar', () => {
    expect(canPlace(-1, 0, 'quarter', middleC, [])).toBe(false);
    // Default maxBar is TOTAL_BARS (page-1 size = 16).
    expect(canPlace(TOTAL_BARS, 0, 'quarter', middleC, [])).toBe(false);
  });
  it('respects custom maxBar (multi-page mode)', () => {
    // With pages=2, bars 0..31 are valid.
    const maxBar = 32;
    expect(canPlace(20, 0, 'quarter', middleC, [], undefined, maxBar)).toBe(true);
    expect(canPlace(32, 0, 'quarter', middleC, [], undefined, maxBar)).toBe(false);
  });
  it('respects ignoreNoteId for drag-move scenarios', () => {
    const existing = note({ bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5, id: 'A' });
    expect(canPlace(0, 0, 'quarter', 60, [existing], 'A')).toBe(true);
  });
});

describe('staffStepToMidi', () => {
  it('C major: top staff line (step 0) -> F5 (MIDI 77)', () => {
    expect(staffStepToMidi(0, 0, null)).toBe(77);
  });
  it('C major: top space (step 1) -> E5 (MIDI 76)', () => {
    expect(staffStepToMidi(1, 0, null)).toBe(76);
  });
  it('C major: bottom staff line (step 8) -> E4 (MIDI 64)', () => {
    expect(staffStepToMidi(8, 0, null)).toBe(64);
  });
  it('G major (1 sharp) raises F-line to F#5', () => {
    expect(staffStepToMidi(0, 1, null)).toBe(78); // F#5
  });
  it('explicit natural in G major returns F5', () => {
    expect(staffStepToMidi(0, 1, 'natural')).toBe(77);
  });
  it('per-note sharp in C major: F-line -> F#5', () => {
    expect(staffStepToMidi(0, 0, 'sharp')).toBe(78);
  });
  it('per-note flat in C major: B-line -> Bb4', () => {
    expect(staffStepToMidi(4, 0, null)).toBe(71); // B4
    expect(staffStepToMidi(4, 0, 'flat')).toBe(70); // Bb4
  });
  it('F major (1 flat): B-line plays as Bb4', () => {
    expect(staffStepToMidi(4, -1, null)).toBe(70); // Bb4 from key-sig
  });
});

describe('dynamicAt forward-fill', () => {
  it('returns mf default when no markers', () => {
    expect(dynamicAt(0, 0, [])).toBe('mf');
  });
  it('returns the latest marker at-or-before (bar, tick)', () => {
    const dyns: DynamicMarker[] = [
      { id: 'a', bar: 0, tick: 0, level: 'p' },
      { id: 'b', bar: 1, tick: 0, level: 'f' },
      { id: 'c', bar: 2, tick: 12, level: 'ff' },
    ];
    expect(dynamicAt(0, 5, dyns)).toBe('p');
    expect(dynamicAt(1, 0, dyns)).toBe('f');
    expect(dynamicAt(1, 30, dyns)).toBe('f');
    expect(dynamicAt(2, 11, dyns)).toBe('f');
    expect(dynamicAt(2, 12, dyns)).toBe('ff');
    expect(dynamicAt(7, 47, dyns)).toBe('ff');
  });
  it('mf when only future markers exist', () => {
    const dyns: DynamicMarker[] = [{ id: 'a', bar: 3, tick: 0, level: 'pp' }];
    expect(dynamicAt(0, 0, dyns)).toBe('mf');
  });
});

describe('DYNAMIC_SCALE — v2 dynamics tweak', () => {
  it('pp is 10% quieter than v1 (0.225 instead of 0.25)', () => {
    expect(DYNAMIC_SCALE.pp).toBeCloseTo(0.225, 5);
  });
  it('p / mf / f are unchanged from v1', () => {
    expect(DYNAMIC_SCALE.p).toBeCloseTo(0.4, 5);
    expect(DYNAMIC_SCALE.mf).toBeCloseTo(0.55, 5);
    expect(DYNAMIC_SCALE.f).toBeCloseTo(0.75, 5);
  });
  it('ff is 10% louder than v1 (1.045 instead of 0.95)', () => {
    expect(DYNAMIC_SCALE.ff).toBeCloseTo(1.045, 5);
  });
  it('ff is louder than pp by the new ratio (~4.64)', () => {
    const ratio = DYNAMIC_SCALE.ff / DYNAMIC_SCALE.pp;
    // New ratio: 1.045 / 0.225 ≈ 4.644. Old ratio: 0.95 / 0.25 = 3.8.
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(4.8);
  });
});

describe('tieSpanNotes', () => {
  it('returns notes between fromNoteId and toNoteId in absolute order', () => {
    const notes: ScoreNote[] = [
      note({ id: 'a', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
      note({ id: 'b', bar: 0, tick: 12, duration: 'quarter', midi: 62, staffStep: 4 }),
      note({ id: 'c', bar: 0, tick: 24, duration: 'quarter', midi: 64, staffStep: 3 }),
      note({ id: 'd', bar: 1, tick: 0, duration: 'quarter', midi: 65, staffStep: 2 }),
    ];
    const span = tieSpanNotes('a', 'c', notes);
    expect(span.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
  it('handles reversed argument order', () => {
    const notes: ScoreNote[] = [
      note({ id: 'a', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
      note({ id: 'b', bar: 0, tick: 12, duration: 'quarter', midi: 62, staffStep: 4 }),
    ];
    const span = tieSpanNotes('b', 'a', notes);
    expect(span.map((n) => n.id)).toEqual(['a', 'b']);
  });
  it('returns [] for unknown ids', () => {
    expect(tieSpanNotes('x', 'y', [])).toEqual([]);
  });
});

describe('tie chain helpers — single-envelope semantics', () => {
  // Three quarters tied: A -> B -> C, all at MIDI 60. The whole chain should
  // produce ONE held envelope: gate-on at A.start, gate-off at C.end.
  const notes: ScoreNote[] = [
    note({ id: 'A', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 10 }),
    note({ id: 'B', bar: 0, tick: 12, duration: 'quarter', midi: 60, staffStep: 10 }),
    note({ id: 'C', bar: 0, tick: 24, duration: 'quarter', midi: 60, staffStep: 10 }),
  ];
  const ties: Tie[] = [
    { id: 't1', fromNoteId: 'A', toNoteId: 'B' },
    { id: 't2', fromNoteId: 'B', toNoteId: 'C' },
  ];

  it('tieRoleFor identifies start, mid, end for a 3-note chain', () => {
    expect(tieRoleFor('A', ties)).toBe('tied-start');
    expect(tieRoleFor('B', ties)).toBe('tied-mid');
    expect(tieRoleFor('C', ties)).toBe('tied-end');
  });

  it('tieRoleFor returns "none" for un-tied notes', () => {
    expect(tieRoleFor('A', [])).toBe('none');
    const z = note({ id: 'Z', bar: 1, tick: 0, duration: 'quarter', midi: 60, staffStep: 10 });
    expect(tieRoleFor(z.id, ties)).toBe('none');
  });

  it('tieChainFrom walks A -> B -> C and stops at the end', () => {
    const chain = tieChainFrom('A', ties, notes);
    expect(chain.map((n) => n.id)).toEqual(['A', 'B', 'C']);
  });

  it('tieChainFrom on mid-chain note walks forward only (B -> C)', () => {
    const chain = tieChainFrom('B', ties, notes);
    expect(chain.map((n) => n.id)).toEqual(['B', 'C']);
  });

  it('tieChainFrom on tied-end note returns just that note', () => {
    const chain = tieChainFrom('C', ties, notes);
    expect(chain.map((n) => n.id)).toEqual(['C']);
  });

  it('tieChainFrom is cycle-safe (no infinite loop on bad data)', () => {
    const cyclic: Tie[] = [
      { id: 'x', fromNoteId: 'A', toNoteId: 'B' },
      { id: 'y', fromNoteId: 'B', toNoteId: 'A' },
    ];
    const chain = tieChainFrom('A', cyclic, notes);
    // A -> B, then B's outgoing tie points back to A which is visited; stop.
    expect(chain.map((n) => n.id)).toEqual(['A', 'B']);
  });

  it('chain end-tick equals last note end (single-envelope span)', () => {
    const chain = tieChainFrom('A', ties, notes);
    const last = chain[chain.length - 1];
    const startAbs = notes[0].bar * TICKS_PER_BAR + notes[0].tick;
    const endAbs = last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
    // 0..36 ticks (3 quarters = 36 grid ticks).
    expect(endAbs - startAbs).toBe(36);
  });
});

describe('triplet packing', () => {
  it('three triplet-8th notes at 0, 4, 8 fit inside one beat (12 ticks)', () => {
    const notes: ScoreNote[] = [
      note({ id: 'a', bar: 0, tick: 0, duration: 'triplet8th', midi: 60, staffStep: 5 }),
      note({ id: 'b', bar: 0, tick: 4, duration: 'triplet8th', midi: 62, staffStep: 4 }),
    ];
    expect(canPlace(0, 8, 'triplet8th', 64, notes)).toBe(true);
    expect(barCapacityRemaining(0, [
      ...notes,
      note({ id: 'c', bar: 0, tick: 8, duration: 'triplet8th', midi: 64, staffStep: 3 }),
    ])).toBe(TICKS_PER_BAR - 12);
  });
});

// ── PLACEABLE ⇒ REACHABLE ─────────────────────────────────────────────────
//
// ⚠ THE TEST DIRECTLY ABOVE WAS GREEN FOR THREE MONTHS WHILE CERTIFYING A
// PLACEMENT THE ENGINE COULD NOT SOUND, and it is the cleanest example of a
// gate reading one side of a two-sided contract that this module owns. It
// exercises `canPlace` / `barCapacityRemaining` — the AUTHORING side — and
// never `slotGridTicks` / the emit path. It asserts, correctly and uselessly,
// that ticks 4 and 8 are legal; ticks 4 and 8 were two of the eight positions
// per bar the scheduler could never visit. The test would read identically
// green if score.ts did not exist.
//
// The missing assertion is the JOIN: a tick the toolbar can PLACE must be a
// tick the transport can REACH. Both halves are now derived from the shipping
// functions, so neither a new note value nor a change to the slot width can
// re-open the gap without this going red.
describe('placement grid ⇔ scheduler grid (the join the tests above never made)', () => {
  const reachable = new Set(reachableTicksInBar());

  it.each(NOTE_DURATIONS)('every tick the toolbar can place a %s on is REACHED by the transport', (d) => {
    const placeable = placeableTicksInBar(d);
    const unreachable = placeable.filter((t) => !reachable.has(t));
    expect(
      unreachable,
      `duration '${d}' (width ${tickWidth(d)}) can be placed at ticks ` +
        `[${placeable.join(',')}] but the scheduler only ever emits at ` +
        `[${[...reachable].join(',')}]. A note on an unreached tick is placed, ` +
        `drawn at the right x, saved and synced — and never sounds, because ` +
        `noteStartingAt matches the absolute tick EXACTLY. This is how triplets ` +
        `lost 8 of their 12 positions per bar from the module's first commit.`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL — the join can fail, and it is the pre-fix arithmetic that fails it', () => {
    // Kept executable so the finding is not something to take on faith, and so
    // a regression that puts the stride back reddens HERE with the reason.
    // This is the OLD reachable set: slot starts only, no sub-slot emits.
    const preFix = new Set(
      Array.from({ length: TICKS_PER_BAR / GRID_TICKS_PER_SLOT }, (_, i) => i * GRID_TICKS_PER_SLOT),
    );
    const dropped = placeableTicksInBar('triplet8th').filter((t) => !preFix.has(t));
    expect(
      dropped,
      'the pre-fix scheduler dropped exactly the 2nd and 3rd note of every ' +
        'triplet group; if this list is empty the control is vacuous',
    ).toEqual([4, 8, 16, 20, 28, 32, 40, 44]);
    // …and the four that DID sound were just the beat downbeats, which is why
    // a bar of triplets sounded like a plain quarter pulse.
    expect(placeableTicksInBar('triplet8th').filter((t) => preFix.has(t))).toEqual([0, 12, 24, 36]);
    // The instrument is the same one the real leg uses: the shipping set must
    // be a strict superset of the pre-fix one, or the fix did nothing.
    for (const t of preFix) expect(reachable.has(t), `slot start ${t} still reached`).toBe(true);
    expect(reachable.size).toBeGreaterThan(preFix.size);
  });

  it('a slot emits its ticks in order, and slots tile the bar exactly', () => {
    expect(slotGridTicks(0)).toEqual([0, 1, 2]);
    expect(slotGridTicks(5)).toEqual([15, 16, 17]);
    // No gaps, no overlaps, no off-by-one at the bar boundary.
    expect(reachableTicksInBar()).toEqual(Array.from({ length: TICKS_PER_BAR }, (_, i) => i));
  });

  it('the plan preserves the OLD timestamp for every slot-aligned note', () => {
    // The compatibility claim, asserted rather than asserted-in-prose: index 0
    // is offset 0, so a quarter/eighth/16th note — every duration whose width
    // is a multiple of GRID_TICKS_PER_SLOT — sounds at exactly the second it
    // sounded before. Only the two new sub-slot emits are new events.
    for (const n of [0, 1, 7, 15]) {
      const plan = slotEmitPlan(n);
      expect(plan[0]).toEqual({ absTick: n * GRID_TICKS_PER_SLOT, offset: 0 });
      expect(plan.map((e) => e.offset)).toEqual([0, 1 / 3, 2 / 3]);
    }
  });

  // ── AND THE ENGINE ACTUALLY RUNS THE PLAN ────────────────────────────────
  //
  // ⚠ WITHOUT THIS LEG THE WHOLE describe IS A FUNCTION AGREEING WITH ITSELF.
  // Every assertion above reads score-data.ts; none of them can see score.ts
  // keeping a private `tickIndex * 3`, which is exactly the shape of the
  // original defect — a placement grid and a playback grid, each internally
  // consistent, that nothing joined. score.ts has no unit harness (it needs an
  // AudioContext + the Faust worklet), so the join is made at SOURCE level,
  // the same altitude card-range-source works at.
  //
  // Comments are stripped first, and they have to be: the explanation now
  // standing over that loop QUOTES `tickIndex * 3` to say what went wrong, and
  // a raw grep would report the documentation as the defect. Shared stripper,
  // shared for that reason.
  it('score.ts emits through slotEmitPlan and keeps no private stride', () => {
    const engine = stripSourceComments(
      readFileSync(fileURLToPath(new URL('./score.ts', import.meta.url)), 'utf8'),
    );
    expect(
      /slotEmitPlan\(/.test(engine),
      'score.ts must emit via slotEmitPlan — otherwise the reachability sweep ' +
        'above is score-data.ts agreeing with itself while the engine does ' +
        'something else entirely.',
    ).toBe(true);
    const strides = [...engine.matchAll(/tickIndex\s*\*\s*3\b/g)].map((m) => m[0]);
    expect(
      strides,
      'a bare `tickIndex * 3` in score.ts is the pre-fix stride: it emits only ' +
        'at slot boundaries, which drops 8 of the 12 triplet positions per bar. ' +
        'Derive the ticks from slotEmitPlan(tickIndex) instead.',
    ).toEqual([]);
    // NEGATIVE CONTROL on this grep, in both directions, on the same pattern —
    // a `toEqual([])` over a scan that matches nothing reads identically green.
    expect([...'emitTick(tickIndex * 3, nowAt, d);'.matchAll(/tickIndex\s*\*\s*3\b/g)]).toHaveLength(1);
    expect([...'emitSlot(tickIndex, nowAt, d);'.matchAll(/tickIndex\s*\*\s*3\b/g)]).toHaveLength(0);
    // …and the stripper is genuinely load-bearing here: the real file DOES
    // quote the old stride in prose, so an un-stripped scan would be red.
    const raw = readFileSync(fileURLToPath(new URL('./score.ts', import.meta.url)), 'utf8');
    expect(
      [...raw.matchAll(/tickIndex\s*\*\s*3\b/g)].length,
      'score.ts still explains the defect in a comment — if this reaches 0 the ' +
        'stripper is no longer being exercised by this leg and the note above ' +
        'has been deleted along with the reason.',
    ).toBeGreaterThan(0);
  });
});

describe('page model', () => {
  it('emptyScoreData defaults to 1 page, loop=false, no stopBar', () => {
    const d = emptyScoreData();
    expect(d.pages).toBe(DEFAULT_PAGES);
    expect(d.pages).toBe(1);
    expect(d.loop).toBe(false);
    expect(d.stopBar).toBeUndefined();
  });

  it('totalBars returns pages × BARS_PER_PAGE', () => {
    expect(totalBars({ ...emptyScoreData(), pages: 1 })).toBe(BARS_PER_PAGE);
    expect(totalBars({ ...emptyScoreData(), pages: 4 })).toBe(BARS_PER_PAGE * MAX_PAGES);
  });

  it('totalBars clamps pages to [1, MAX_PAGES]', () => {
    expect(totalBars({ ...emptyScoreData(), pages: 0 })).toBe(BARS_PER_PAGE);
    expect(totalBars({ ...emptyScoreData(), pages: 99 })).toBe(BARS_PER_PAGE * MAX_PAGES);
  });
});

describe('stop-bar logic (engine-level expectations)', () => {
  // Engine behavior at sequencer step >= stopBarStep:
  //   - loop OFF -> stop playback, gate goes low
  //   - loop ON  -> wrap tickIndex back to 0
  //
  // We mirror that decision here as a pure helper test so the engine's
  // branch is testable without spinning up a Faust worklet.
  function decideAtStopBar(reachedStop: boolean, loop: boolean): 'stop' | 'wrap' | 'continue' {
    if (!reachedStop) return 'continue';
    return loop ? 'wrap' : 'stop';
  }

  it('returns "continue" before reaching the stop bar', () => {
    expect(decideAtStopBar(false, false)).toBe('continue');
    expect(decideAtStopBar(false, true)).toBe('continue');
  });
  it('returns "stop" at the stop bar with loop OFF', () => {
    expect(decideAtStopBar(true, false)).toBe('stop');
  });
  it('returns "wrap" at the stop bar with loop ON', () => {
    expect(decideAtStopBar(true, true)).toBe('wrap');
  });
});
