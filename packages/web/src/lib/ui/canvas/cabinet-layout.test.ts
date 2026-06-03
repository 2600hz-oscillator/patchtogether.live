// Unit tests for the Moog (moogafakkin) cabinet layout helper.
// Pure data, no DOM / no registry. Run via vitest in the web workspace.
//
// Asserts:
//   - the exact module SEQUENCE per system (mirrors the service-manual rows),
//   - the module COUNTS (S35: 9 upper + 8 lower = 17; S55: 15 upper + 12 = 27),
//   - that NO two cards' bounding boxes overlap (rect = x + width-by-type at
//     the row y, generous fixed card height), pairwise.

import { describe, it, expect } from 'vitest';
import {
  computeCabinetLayout,
  cardWidth,
  ROW_HEIGHT,
  ORIGIN,
  GAP,
  type CabinetPlacement,
} from './cabinet-layout';

// Each card occupies its declared width × a fixed conservative height for
// overlap purposes. The tallest moog cards (the fixed-filter banks
// moog907a/moog914) render ~650-900px tall, so we model a generous height
// that bounds the real cards — yet stays < ROW_HEIGHT so the two rows can
// never vertically overlap. (If this ever exceeds ROW_HEIGHT the overlap
// assertions below would correctly fail.)
const CARD_HEIGHT = 920;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function toRect(p: CabinetPlacement): Rect {
  return { x: p.x, y: p.y, w: cardWidth(p.type), h: CARD_HEIGHT };
}

function overlaps(a: Rect, b: Rect): boolean {
  // Standard AABB overlap; touching edges (== ) is NOT an overlap.
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function assertNoOverlaps(placements: CabinetPlacement[]) {
  const rects = placements.map(toRect);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(
        overlaps(rects[i], rects[j]),
        `cards ${i} (${placements[i].type}) and ${j} (${placements[j].type}) overlap`,
      ).toBe(false);
    }
  }
}

const S35_ROW1 = [
  'moog907a',
  'moog904b',
  'moog904a',
  'moog902',
  'moog902',
  'moog902',
  'moog911',
  'moog911',
  'moog911',
];
const S35_ROW2 = [
  'moog921a',
  'moog921b',
  'moog921b',
  'moog923',
  'moog921a',
  'moog921b',
  'moog921b',
  'moog921Vco',
];

const S55_ROW1 = [
  'moog904a',
  'moog992',
  'moog902',
  'moog902',
  'moog911',
  'moog911',
  'moog902',
  'moog902',
  'moog902',
  'moog993',
  'moog911',
  'moog993',
  'moog911',
  'moog911',
  'moog911',
];
const S55_ROW2 = [
  'moog921a',
  'moog921b',
  'moog921b',
  'moog921b',
  'moog921a',
  'moog921b',
  'moog921b',
  'moog921b',
  'moog914',
  'moog904b',
  'moog904a',
  'moog992',
];

describe('computeCabinetLayout', () => {
  describe('System 35', () => {
    const placements = computeCabinetLayout('35');

    it('returns the right module SEQUENCE (row1 then row2)', () => {
      expect(placements.map((p) => p.type)).toEqual([...S35_ROW1, ...S35_ROW2]);
    });

    it('has 9 upper + 8 lower = 17 modules', () => {
      expect(S35_ROW1.length).toBe(9);
      expect(S35_ROW2.length).toBe(8);
      expect(placements.length).toBe(17);
    });

    it('lays row1 at ORIGIN.y and row2 one ROW_HEIGHT below', () => {
      const row1 = placements.slice(0, S35_ROW1.length);
      const row2 = placements.slice(S35_ROW1.length);
      expect(row1.every((p) => p.y === ORIGIN.y)).toBe(true);
      expect(row2.every((p) => p.y === ORIGIN.y + ROW_HEIGHT)).toBe(true);
    });

    it('advances x by width + GAP within a row (left-to-right, ascending)', () => {
      const row1 = placements.slice(0, S35_ROW1.length);
      let expectedX = ORIGIN.x;
      for (const p of row1) {
        expect(p.x).toBe(expectedX);
        expectedX += cardWidth(p.type) + GAP;
      }
    });

    it('has NO two cards overlapping', () => {
      assertNoOverlaps(placements);
    });
  });

  describe('System 55', () => {
    const placements = computeCabinetLayout('55');

    it('returns the right module SEQUENCE (row1 then row2)', () => {
      expect(placements.map((p) => p.type)).toEqual([...S55_ROW1, ...S55_ROW2]);
    });

    it('has 15 upper + 12 lower = 27 modules', () => {
      expect(S55_ROW1.length).toBe(15);
      expect(S55_ROW2.length).toBe(12);
      expect(placements.length).toBe(27);
    });

    it('lays row1 at ORIGIN.y and row2 one ROW_HEIGHT below', () => {
      const row1 = placements.slice(0, S55_ROW1.length);
      const row2 = placements.slice(S55_ROW1.length);
      expect(row1.every((p) => p.y === ORIGIN.y)).toBe(true);
      expect(row2.every((p) => p.y === ORIGIN.y + ROW_HEIGHT)).toBe(true);
    });

    it('has NO two cards overlapping', () => {
      assertNoOverlaps(placements);
    });
  });

  it('starts at the configured ORIGIN', () => {
    const first = computeCabinetLayout('35')[0];
    expect(first.x).toBe(ORIGIN.x);
    expect(first.y).toBe(ORIGIN.y);
  });
});
