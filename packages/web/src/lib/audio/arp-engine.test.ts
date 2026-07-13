// packages/web/src/lib/audio/arp-engine.test.ts
//
// Exhaustive, deterministic unit tests for the pure arpeggiator generator.
// Covers: division→period + coercion; each octave range's expanded+sorted
// pool (incl. MIDI-range drop); up/down/exclusive-updown ordering for 1/2/3
// note sets; pendulum turnaround has no duplicated extreme; latch
// replace-vs-add/freeze + latch-off stop; empty-set safety; cursor stays valid
// across add/remove; note-on/note-off pairing.

import { describe, it, expect } from 'vitest';
import {
  createArpState,
  arpSetHeld,
  arpSetParams,
  arpAdvance,
  expandPool,
  arpStepPeriod,
  coerceDivisionIndex,
  coerceOctaveRangeIndex,
  ARP_DIVISIONS,
  ARP_DIVISION_DEFAULT_INDEX,
  ARP_OCTAVE_RANGES,
  ARP_OCTAVE_RANGE_DEFAULT_INDEX,
  type ArpState,
} from './arp-engine';

// C major triad — the contract's worked example (C E G).
const C = 60;
const E = 64;
const G = 67;

/** Drive `n` arp steps, threading state; return the note-on sequence. */
function collect(state: ArpState, n: number): { notes: (number | undefined)[]; state: ArpState } {
  const notes: (number | undefined)[] = [];
  let s = state;
  for (let i = 0; i < n; i++) {
    const r = arpAdvance(s);
    notes.push(r.noteOn);
    s = r.state;
  }
  return { notes, state: s };
}

// ---------------- Division → period helper ----------------

describe('arp: division table + period helper', () => {
  it('tables are aligned and default is 1x', () => {
    expect(ARP_DIVISIONS).toEqual([8, 4, 2, 1, 0.5, 0.25, 0.125]);
    expect(ARP_DIVISIONS[ARP_DIVISION_DEFAULT_INDEX]).toBe(1);
  });

  it('period scales the base by 1/mult (8x faster, 1/8 slower)', () => {
    expect(arpStepPeriod(1, 3)).toBe(1);        // 1x → base
    expect(arpStepPeriod(1, 0)).toBe(1 / 8);    // 8x → base/8
    expect(arpStepPeriod(1, 2)).toBe(1 / 2);    // 2x → base/2
    expect(arpStepPeriod(1, 4)).toBe(2);        // 1/2 → base*2
    expect(arpStepPeriod(1, 6)).toBe(8);        // 1/8 → base*8
    expect(arpStepPeriod(0.5, 3)).toBe(0.5);    // unit-agnostic passthrough
  });

  it('coerceDivisionIndex clamps + rounds, falls back to 1x', () => {
    expect(coerceDivisionIndex(-5)).toBe(0);
    expect(coerceDivisionIndex(99)).toBe(ARP_DIVISIONS.length - 1);
    expect(coerceDivisionIndex(2.4)).toBe(2);
    expect(coerceDivisionIndex(NaN)).toBe(ARP_DIVISION_DEFAULT_INDEX);
    expect(coerceDivisionIndex(undefined)).toBe(ARP_DIVISION_DEFAULT_INDEX);
    // out-of-range indices still yield a valid period (no undefined mult).
    expect(arpStepPeriod(1, 99)).toBe(1 / 0.125);
  });
});

// ---------------- Octave-range expansion ----------------

describe('arp: octave-range expansion (symmetric, sorted)', () => {
  it('range table + default is "1 oct"', () => {
    expect(ARP_OCTAVE_RANGES).toEqual([1, 2, 3]);
    expect(ARP_OCTAVE_RANGES[ARP_OCTAVE_RANGE_DEFAULT_INDEX]).toBe(1);
  });

  it('"1 oct" (index 0) is the held notes as-is, sorted', () => {
    expect(expandPool([G, C, E], 0)).toEqual([C, E, G]);
  });

  it('"+1..-1" (index 1) adds ±12 to each note, deduped + sorted', () => {
    expect(expandPool([C], 1)).toEqual([48, 60, 72]);
    expect(expandPool([C, E, G], 1)).toEqual([48, 52, 55, 60, 64, 67, 72, 76, 79]);
  });

  it('"+2..-2" (index 2) adds ±12 and ±24', () => {
    expect(expandPool([C], 2)).toEqual([36, 48, 60, 72, 84]);
  });

  it('drops octave copies that fall outside MIDI 0..127', () => {
    expect(expandPool([0], 2)).toEqual([0, 12, 24]);       // -24,-12 dropped
    expect(expandPool([127], 1)).toEqual([115, 127]);      // 139 dropped
  });

  it('dedupes overlapping octave copies', () => {
    // C4(60) and C5(72) with ±1 oct both emit 60/72 — no duplicates.
    expect(expandPool([60, 72], 1)).toEqual([48, 60, 72, 84]);
  });
});

// ---------------- Direction ordering ----------------

describe('arp: direction ordering (1/2/3-note sets)', () => {
  it('UP walks the sorted pool low→high and wraps', () => {
    const s = arpSetHeld(createArpState({ direction: 'up' }), [G, C, E]);
    expect(collect(s, 6).notes).toEqual([C, E, G, C, E, G]);
  });

  it('DOWN walks high→low and wraps', () => {
    const s = arpSetHeld(createArpState({ direction: 'down' }), [C, E, G]);
    expect(collect(s, 6).notes).toEqual([G, E, C, G, E, C]);
  });

  it('UPDOWN is an EXCLUSIVE pendulum on 3 notes (C E G E …, no repeat)', () => {
    const s = arpSetHeld(createArpState({ direction: 'updown' }), [C, E, G]);
    expect(collect(s, 8).notes).toEqual([C, E, G, E, C, E, G, E]);
  });

  it('UPDOWN on 2 notes is C E C E (turnaround plays each extreme once)', () => {
    const s = arpSetHeld(createArpState({ direction: 'updown' }), [C, E]);
    expect(collect(s, 6).notes).toEqual([C, E, C, E, C, E]);
  });

  it('single-note set retriggers that note in every direction (no stutter/crash)', () => {
    for (const direction of ['up', 'down', 'updown'] as const) {
      const s = arpSetHeld(createArpState({ direction }), [C]);
      expect(collect(s, 4).notes).toEqual([C, C, C, C]);
    }
  });

  it('two-note UP / DOWN order', () => {
    expect(collect(arpSetHeld(createArpState({ direction: 'up' }), [C, E]), 4).notes)
      .toEqual([C, E, C, E]);
    expect(collect(arpSetHeld(createArpState({ direction: 'down' }), [C, E]), 4).notes)
      .toEqual([E, C, E, C]);
  });
});

describe('arp: pendulum has no duplicated turnaround', () => {
  it('never plays the same extreme twice in a row for 2..5 note pools', () => {
    for (let n = 2; n <= 5; n++) {
      const held = Array.from({ length: n }, (_, i) => C + i);
      const s = arpSetHeld(createArpState({ direction: 'updown' }), held);
      const notes = collect(s, n * 4).notes;
      for (let i = 1; i < notes.length; i++) {
        expect(notes[i]).not.toBe(notes[i - 1]); // adjacent notes always differ
      }
      // full pendulum period is 2*(n-1): both extremes appear exactly once/cycle.
      const period = 2 * (n - 1);
      const min = held[0];
      const max = held[held.length - 1];
      const oneCycle = notes.slice(0, period);
      expect(oneCycle.filter((x) => x === min).length).toBe(1);
      expect(oneCycle.filter((x) => x === max).length).toBe(1);
    }
  });
});

describe('arp: expanded pool is what the direction walks', () => {
  it('UP over a "+1..-1" pool walks all 9 expanded notes ascending', () => {
    const s = arpSetHeld(createArpState({ direction: 'up', octaveRangeIndex: 1 }), [C, E, G]);
    expect(collect(s, 9).notes).toEqual([48, 52, 55, 60, 64, 67, 72, 76, 79]);
  });
});

// ---------------- Latch semantics ----------------

describe('arp: latch replace-vs-add / freeze', () => {
  it('latch OFF: releasing all notes stops the arp', () => {
    let s = arpSetHeld(createArpState(), [C, E]);
    expect(s.pool).toEqual([C, E]);
    s = arpSetHeld(s, []);
    expect(s.pool).toEqual([]);
    expect(arpAdvance(s).noteOn).toBeUndefined();
  });

  it('latch ON: set survives full release (arp keeps running)', () => {
    let s = arpSetHeld(createArpState({ latch: true }), [C, E, G]);
    s = arpSetHeld(s, []); // release all
    expect(s.pool).toEqual([C, E, G]);
    expect(collect(s, 3).notes).toEqual([C, E, G]); // still generating
  });

  it('latch ON: hold + press ADDS; fresh press after full release REPLACES', () => {
    let s = arpSetHeld(createArpState({ latch: true }), [C]);
    expect(s.held).toEqual([C]);
    s = arpSetHeld(s, [C, E]); // still holding C, press E → add
    expect(s.held).toEqual([C, E]);
    s = arpSetHeld(s, [C]); // release E while holding C → accumulate (no shrink)
    expect(s.held).toEqual([C, E]);
    s = arpSetHeld(s, []); // full release → freeze
    expect(s.held).toEqual([C, E]);
    s = arpSetHeld(s, [G]); // fresh press after full release → replace
    expect(s.held).toEqual([G]);
    expect(s.pool).toEqual([G]);
  });

  it('turning latch OFF collapses a frozen set back to physically-held keys', () => {
    let s = arpSetHeld(createArpState({ latch: true }), [C, E]);
    s = arpSetHeld(s, []); // frozen [C,E], nothing physically down
    expect(s.pool).toEqual([C, E]);
    s = arpSetParams(s, { latch: false }); // latch off, nothing held → stop
    expect(s.pool).toEqual([]);
  });

  it('turning latch OFF while keys are held keeps those keys', () => {
    let s = arpSetHeld(createArpState({ latch: true }), [C, E]);
    s = arpSetParams(s, { latch: false });
    expect(s.pool).toEqual([C, E]);
  });
});

// ---------------- Empty-set safety ----------------

describe('arp: empty-set safety', () => {
  it('advancing an empty pool is a silent no-op', () => {
    const s = createArpState();
    const r = arpAdvance(s);
    expect(r.noteOn).toBeUndefined();
    expect(r.noteOff).toBeUndefined();
    expect(r.state.pool).toEqual([]);
  });

  it('emitting the trailing note-off when the pool empties out', () => {
    let s = arpSetHeld(createArpState(), [C]);
    const first = arpAdvance(s);
    expect(first.noteOn).toBe(C);
    s = arpSetHeld(first.state, []); // release → pool empty, C still sounding
    const r = arpAdvance(s);
    expect(r.noteOff).toBe(C);
    expect(r.noteOn).toBeUndefined();
    // subsequent advances are fully silent (no dangling note-off)
    const r2 = arpAdvance(r.state);
    expect(r2.noteOff).toBeUndefined();
    expect(r2.noteOn).toBeUndefined();
  });
});

// ---------------- Cursor stability ----------------

describe('arp: cursor stays valid across add/remove', () => {
  it('clamps into range on shrink and never indexes an empty/OOB pool', () => {
    let s = arpSetHeld(createArpState({ direction: 'up' }), [C, E, G]);
    // advance to the top of the pool
    ({ state: s } = collect(s, 2)); // played C,E → cursor at G (index 2)
    expect(s.cursor).toBe(2);
    // remove two notes → pool [C]; cursor must clamp to 0
    s = arpSetHeld(s, [C]);
    expect(s.pool).toEqual([C]);
    expect(s.cursor).toBeGreaterThanOrEqual(0);
    expect(s.cursor).toBeLessThan(s.pool.length);
    // add notes back → still valid, still generating
    s = arpSetHeld(s, [C, E, G, 72]);
    expect(s.cursor).toBeGreaterThanOrEqual(0);
    expect(s.cursor).toBeLessThan(s.pool.length);
    const r = arpAdvance(s);
    expect(s.pool).toContain(r.noteOn);
  });

  it('invariant: cursor ∈ [0, pool.length) after an arbitrary add/remove script', () => {
    let s = arpSetHeld(createArpState({ direction: 'updown' }), [C, E, G]);
    const script: number[][] = [
      [C, E, G], [C, E], [C], [C, E, G, 72, 76], [E], [], [C, E, G], [G],
    ];
    for (const held of script) {
      s = arpSetHeld(s, held);
      if (s.pool.length === 0) {
        expect(s.cursor).toBe(0);
      } else {
        expect(s.cursor).toBeGreaterThanOrEqual(0);
        expect(s.cursor).toBeLessThan(s.pool.length);
        expect(s.pool[s.cursor]).toBeTypeOf('number');
      }
      // advancing never throws, whatever the pool
      s = arpAdvance(s).state;
    }
  });

  it('changing division mid-run does not disturb the cursor', () => {
    let s = arpSetHeld(createArpState({ direction: 'up' }), [C, E, G]);
    ({ state: s } = collect(s, 1)); // cursor at 1
    const before = s.cursor;
    s = arpSetParams(s, { divisionIndex: 0 });
    expect(s.cursor).toBe(before);
  });
});

// ---------------- Note on/off pairing ----------------

describe('arp: note-on/note-off pairing', () => {
  it('first step has no note-off; each later step offs the previous note', () => {
    const s = arpSetHeld(createArpState({ direction: 'up' }), [C, E]);
    const r1 = arpAdvance(s);
    expect(r1.noteOn).toBe(C);
    expect(r1.noteOff).toBeUndefined();
    const r2 = arpAdvance(r1.state);
    expect(r2.noteOn).toBe(E);
    expect(r2.noteOff).toBe(C);
    const r3 = arpAdvance(r2.state);
    expect(r3.noteOn).toBe(C);
    expect(r3.noteOff).toBe(E);
  });

  it('single-note pool retriggers: note-off and note-on are the same value', () => {
    const s = arpSetHeld(createArpState(), [C]);
    const r1 = arpAdvance(s);
    const r2 = arpAdvance(r1.state);
    expect(r2.noteOff).toBe(C);
    expect(r2.noteOn).toBe(C);
  });
});

// ---------------- Coercion guards ----------------

describe('arp: octave-range coercion', () => {
  it('clamps + rounds + falls back to "1 oct"', () => {
    expect(coerceOctaveRangeIndex(-1)).toBe(0);
    expect(coerceOctaveRangeIndex(99)).toBe(ARP_OCTAVE_RANGES.length - 1);
    expect(coerceOctaveRangeIndex(1.4)).toBe(1);
    expect(coerceOctaveRangeIndex(NaN)).toBe(ARP_OCTAVE_RANGE_DEFAULT_INDEX);
  });

  it('createArpState coerces out-of-range param seeds', () => {
    const s = createArpState({ divisionIndex: 99, octaveRangeIndex: -3 });
    expect(s.params.divisionIndex).toBe(ARP_DIVISIONS.length - 1);
    expect(s.params.octaveRangeIndex).toBe(0);
  });
});
