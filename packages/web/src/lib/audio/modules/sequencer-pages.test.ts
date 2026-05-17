// packages/web/src/lib/audio/modules/sequencer-pages.test.ts
//
// Pure-math unit tests for the page-nav helpers. Validated in isolation so
// each sequencer card (DRUMSEQZ, POLYSEQZ, MACSEQ, Sequencer) can lean on
// them without re-deriving the page-index logic in each Svelte component.

import { describe, it, expect } from 'vitest';
import {
  PAGE_SIZE,
  MAX_PAGES,
  MAX_STEPS,
  pageCountFor,
  playheadPageFor,
  visiblePageFor,
  pageRange,
  ensureCapacity,
} from './sequencer-pages';

describe('constants', () => {
  it('PAGE_SIZE × MAX_PAGES = MAX_STEPS = 128', () => {
    expect(PAGE_SIZE).toBe(16);
    expect(MAX_PAGES).toBe(8);
    expect(MAX_STEPS).toBe(128);
    expect(PAGE_SIZE * MAX_PAGES).toBe(MAX_STEPS);
  });
});

describe('pageCountFor', () => {
  it('length=1 → 1 page', () => {
    expect(pageCountFor(1)).toBe(1);
  });
  it('length=16 → 1 page', () => {
    expect(pageCountFor(16)).toBe(1);
  });
  it('length=17 → 2 pages', () => {
    expect(pageCountFor(17)).toBe(2);
  });
  it('length=32 → 2 pages', () => {
    expect(pageCountFor(32)).toBe(2);
  });
  it('length=64 → 4 pages', () => {
    expect(pageCountFor(64)).toBe(4);
  });
  it('length=128 → 8 pages', () => {
    expect(pageCountFor(128)).toBe(8);
  });
  it('caps at MAX_PAGES (8) even when length > MAX_STEPS', () => {
    expect(pageCountFor(999)).toBe(8);
  });
  it('handles length<=0 by floor-clamping to 1 page', () => {
    expect(pageCountFor(0)).toBe(1);
    expect(pageCountFor(-5)).toBe(1);
  });
});

describe('playheadPageFor', () => {
  it('step 0 → page 0', () => {
    expect(playheadPageFor(0, 32)).toBe(0);
  });
  it('step 15 → page 0', () => {
    expect(playheadPageFor(15, 32)).toBe(0);
  });
  it('step 16 → page 1', () => {
    expect(playheadPageFor(16, 32)).toBe(1);
  });
  it('step 47 → page 2 (when length=64 / 4 pages)', () => {
    expect(playheadPageFor(47, 64)).toBe(2);
  });
  it('out-of-range step clamps to last page', () => {
    expect(playheadPageFor(999, 32)).toBe(1); // pageCount=2 → max page = 1
  });
});

describe('visiblePageFor', () => {
  it('HOLD off: follows playhead', () => {
    expect(visiblePageFor(0, 0, 64, false)).toBe(0);
    expect(visiblePageFor(0, 17, 64, false)).toBe(1);
    expect(visiblePageFor(0, 47, 64, false)).toBe(2);
    expect(visiblePageFor(99, 47, 64, false)).toBe(2); // userPage ignored
  });
  it('HOLD on: user-controlled, clamped to pageCount-1', () => {
    expect(visiblePageFor(0, 99, 64, true)).toBe(0);
    expect(visiblePageFor(2, 99, 64, true)).toBe(2);
    expect(visiblePageFor(99, 0, 64, true)).toBe(3); // pageCount=4 → clamp to 3
  });
  it('matches the spec formula: hold ? userPage : floor(step/PAGE_SIZE)', () => {
    for (const length of [16, 32, 48, 64, 80, 96, 128]) {
      for (let step = 0; step < length; step += 5) {
        for (let userPage = 0; userPage < 8; userPage++) {
          for (const hold of [true, false]) {
            const got = visiblePageFor(userPage, step, length, hold);
            const expected = hold
              ? Math.min(pageCountFor(length) - 1, userPage)
              : Math.floor(step / PAGE_SIZE);
            expect(got, `len=${length} step=${step} userPage=${userPage} hold=${hold}`).toBe(
              Math.min(pageCountFor(length) - 1, expected),
            );
          }
        }
      }
    }
  });
});

describe('pageRange', () => {
  it('page 0 spans [0, 16)', () => {
    expect(pageRange(0)).toEqual({ start: 0, end: 16 });
  });
  it('page 1 spans [16, 32)', () => {
    expect(pageRange(1)).toEqual({ start: 16, end: 32 });
  });
  it('page 7 spans [112, 128)', () => {
    expect(pageRange(7)).toEqual({ start: 112, end: 128 });
  });
});

describe('ensureCapacity', () => {
  type Cell = { on: boolean; v: number };
  const make = (i: number): Cell => ({ on: false, v: -i });

  it('produces a MAX_STEPS-length array', () => {
    const out = ensureCapacity<Cell>([], make);
    expect(out).toHaveLength(MAX_STEPS);
  });

  it('preserves existing entries; fills the tail with the factory', () => {
    const existing: Cell[] = [
      { on: true, v: 100 },
      { on: false, v: 200 },
      { on: true, v: 300 },
    ];
    const out = ensureCapacity<Cell>(existing, make);
    expect(out[0]).toEqual({ on: true, v: 100 });
    expect(out[1]).toEqual({ on: false, v: 200 });
    expect(out[2]).toEqual({ on: true, v: 300 });
    expect(out[3]).toEqual({ on: false, v: -3 });
    expect(out[MAX_STEPS - 1]).toEqual({ on: false, v: -(MAX_STEPS - 1) });
  });

  it('backward-compat: a 16-cell saved array widens to 128', () => {
    const legacy = Array.from({ length: 16 }, (_, i) => ({ on: i % 2 === 0, v: i }));
    const out = ensureCapacity<Cell>(legacy, make);
    expect(out).toHaveLength(MAX_STEPS);
    // legacy slots preserved
    for (let i = 0; i < 16; i++) {
      expect(out[i]).toEqual({ on: i % 2 === 0, v: i });
    }
    // tail default-empty via factory
    for (let i = 16; i < MAX_STEPS; i++) {
      expect(out[i]).toEqual({ on: false, v: -i });
    }
  });

  it('truncates over-long input to MAX_STEPS', () => {
    const huge = Array.from({ length: MAX_STEPS + 64 }, (_, i) => ({ on: true, v: i }));
    const out = ensureCapacity<Cell>(huge, make);
    expect(out).toHaveLength(MAX_STEPS);
    expect(out[MAX_STEPS - 1]).toEqual({ on: true, v: MAX_STEPS - 1 });
  });

  it('falls back to factory for non-array input', () => {
    const out = ensureCapacity<Cell>(undefined, make);
    expect(out).toHaveLength(MAX_STEPS);
    // Object.is over toEqual to dodge the JS -0/+0 sign quirk at index 0
    // (the factory returns v: -0, while a literal { v: 0 } in the assertion
    // serializes as +0 — toEqual treats those as unequal).
    expect(out[0].on).toBe(false);
    expect(Object.is(out[0].v, -0) || Object.is(out[0].v, 0)).toBe(true);
    expect(out[1]).toEqual({ on: false, v: -1 });
  });
});

describe('HOLD does not affect playhead derivation (math sanity)', () => {
  it('playheadPageFor is unchanged regardless of HOLD/userPage', () => {
    // The whole point: HOLD only changes what the USER sees; the audio
    // thread keeps stepping. Verified by the helpers having no `hold`
    // parameter on playheadPageFor.
    expect(playheadPageFor(50, 128)).toBe(3);
    expect(playheadPageFor(50, 128)).toBe(3);
  });
});
