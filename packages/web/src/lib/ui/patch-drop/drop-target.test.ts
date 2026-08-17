// ⛔ DEV SANDBOX — covers the drop-target decision behind the working gesture
// on /dev/video-patch-drop. Nothing in the engine imports the subject.
//
// The load-bearing tests here are the two NEGATIVE CONTROLS on the threshold.
// A gate that refuses everything and a gate that is looking at the wrong
// quantity produce the same output — `targetId: null` — so every refusal
// assertion is paired with a positive reading off the SAME decision object
// proving the instrument saw the overlap and declined it.
import { describe, it, expect } from 'vitest';
import { HP_UNIT, RACK_UNIT } from '$lib/ui/rack-grid';
import { pickDropTarget, overlapPx, type DropRect } from './drop-target';

/** A one-U card, in the app's own units. Not a made-up fixture size: RACK_UNIT
 *  is the row pitch and HP_UNIT the horizontal step `findFreeRackSlot` slides
 *  a colliding card by, so "one HP of overlap" below is the real reshuffle. */
const CARD_W = HP_UNIT * 8; // 180 px
const CARD_H = RACK_UNIT; //   180 px
const card = (id: string, x: number, y: number): DropRect => ({
  id,
  x,
  y,
  width: CARD_W,
  height: CARD_H,
});

describe('overlapPx — the raw quantity everything else is derived from', () => {
  it('is zero for disjoint rects and for merely touching edges', () => {
    expect(overlapPx(card('a', 0, 0), card('b', 500, 0))).toBe(0);
    // Touching does NOT count — same convention as rack-grid's rectsOverlap.
    expect(overlapPx(card('a', 0, 0), card('b', CARD_W, 0))).toBe(0);
  });

  it('is the product of the two axis overlaps', () => {
    expect(overlapPx(card('a', 0, 0), card('b', CARD_W / 2, 0))).toBe((CARD_W / 2) * CARD_H);
    expect(overlapPx(card('a', 0, 0), card('b', 0, 0))).toBe(CARD_W * CARD_H);
  });

  it('is symmetric', () => {
    const a = card('a', 13, 29);
    const b = card('b', 71, 103);
    expect(overlapPx(a, b)).toBe(overlapPx(b, a));
  });
});

describe('DECISION 2 — the threshold refuses an ordinary reshuffle', () => {
  // ⚠ NEGATIVE CONTROL, DIRECTION 1: the instrument CAN see this overlap.
  // Without this leg, a gate hard-wired to `null` would pass the next test.
  it('SEES a one-HP nudge — 4050 px², the app\'s own smallest reshuffle step', () => {
    const dragged = card('a', HP_UNIT, 0); // slid one HP into its neighbour
    const d = pickDropTarget(dragged, [card('b', CARD_W, 0)]);
    expect(d.ranked).toHaveLength(1);
    expect(d.ranked[0]!.overlapPx).toBe(HP_UNIT * CARD_H);
    expect(d.ranked[0]!.overlapPx).toBeGreaterThan(0);
  });

  it('and REFUSES it — the library default (>0 px²) would have claimed it', () => {
    const dragged = card('a', HP_UNIT, 0);
    const d = pickDropTarget(dragged, [card('b', CARD_W, 0)]);
    expect(d.targetId).toBeNull();
    expect(d.refusal).toBe('centre-outside-every-candidate');
    expect(d.ranked[0]!.centreInside).toBe(false);
  });

  it('refuses a 1 px² corner clip, and reports the 1 px it saw', () => {
    // Bottom-right corner of the dragged card overlapping the candidate's
    // top-left corner by exactly one pixel on each axis.
    const dragged: DropRect = { id: 'a', x: 1, y: 1, width: CARD_W, height: CARD_H };
    const d = pickDropTarget(dragged, [card('b', CARD_W, CARD_H)]);
    expect(d.ranked[0]!.overlapPx).toBe(1); // instrument is awake
    expect(d.targetId).toBeNull(); // …and still says no
  });

  // ⚠ NEGATIVE CONTROL, DIRECTION 2: the gate can be SATISFIED. Without this
  // leg, every assertion above is also passed by a gate that never fires.
  it('CLAIMS the moment the dragged centre crosses the edge', () => {
    // Centre inside by half a pixel.
    const dragged = card('a', CARD_W / 2 + 0.5, 0);
    const d = pickDropTarget(dragged, [card('b', CARD_W, 0)]);
    expect(d.targetId).toBe('b');
    expect(d.refusal).toBeUndefined();
  });

  it('is a step function AT the centre, not a tuned fraction near it', () => {
    // One pixel either side of the boundary flips the answer, and nothing else
    // about the geometry changed — so the gate is centre-containment and not a
    // coverage threshold that happens to sit nearby.
    const just_outside = pickDropTarget(card('a', CARD_W / 2 - 1, 0), [card('b', CARD_W, 0)]);
    const just_inside = pickDropTarget(card('a', CARD_W / 2 + 1, 0), [card('b', CARD_W, 0)]);
    expect(just_outside.targetId).toBeNull();
    expect(just_inside.targetId).toBe('b');
  });

  it('reports no-overlap distinctly from centre-outside', () => {
    const d = pickDropTarget(card('a', 0, 0), [card('b', 900, 900)]);
    expect(d.refusal).toBe('no-overlap');
    expect(d.ranked).toEqual([]);
  });
});

describe('DECISION 1 — which node wins', () => {
  it('picks the candidate the dragged centre is actually inside', () => {
    // `a` straddles b and c; its centre is over c.
    const dragged = card('a', CARD_W * 0.6, 0);
    const d = pickDropTarget(dragged, [card('b', 0, 0), card('c', CARD_W, 0)]);
    expect(d.targetId).toBe('c');
    // Both were seen and scored — the loser is reported, not dropped.
    expect(d.ranked.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });

  it('coverage, not raw area, decides between two candidates it is inside', () => {
    // A BIG candidate clipped, and a SMALL one fully covered, both containing
    // the dragged centre. Raw overlap px favours the big one; coverage does
    // not — and coverage is the ranking, so the small one wins.
    const dragged: DropRect = { id: 'a', x: 0, y: 0, width: 100, height: 100 };
    // Both contain the dragged centre (50,50). `big` is only CLIPPED by the
    // dragged rect (6 000 px² of it); `small` sits entirely inside it (1 600).
    const big: DropRect = { id: 'big', x: 40, y: -400, width: 500, height: 500 };
    const small: DropRect = { id: 'small', x: 40, y: 40, width: 40, height: 40 };
    const d = pickDropTarget(dragged, [big, small]);

    const byId = Object.fromEntries(d.ranked.map((r) => [r.id, r]));
    // The instrument's own numbers, stated so the claim is checkable here:
    expect(byId.big!.overlapPx).toBeGreaterThan(byId.small!.overlapPx); // raw area WOULD pick big
    expect(byId.small!.coverage).toBe(1); // …but small is fully contained
    expect(byId.small!.coverage).toBeGreaterThan(byId.big!.coverage);
    expect(d.targetId).toBe('small');
  });

  it('scores full containment as 1.0 in BOTH directions', () => {
    const bigDrag: DropRect = { id: 'a', x: 0, y: 0, width: 400, height: 400 };
    const tiny: DropRect = { id: 't', x: 180, y: 180, width: 40, height: 40 };
    expect(pickDropTarget(bigDrag, [tiny]).ranked[0]!.coverage).toBe(1);
    // …and the mirror: a small card dropped fully inside a big one.
    const smallDrag: DropRect = { id: 't', x: 180, y: 180, width: 40, height: 40 };
    const big: DropRect = { id: 'a', x: 0, y: 0, width: 400, height: 400 };
    expect(pickDropTarget(smallDrag, [big]).ranked[0]!.coverage).toBe(1);
  });

  it('is a FUNCTION of the geometry — identical candidates resolve the same way twice', () => {
    // Two candidates stacked exactly on each other: every ranking key ties, so
    // only the id break decides. The point is not WHICH one, it is that a
    // second call cannot answer differently.
    const dragged = card('a', 0, 0);
    const twins = [card('z', 0, 0), card('b', 0, 0)];
    const first = pickDropTarget(dragged, twins);
    const second = pickDropTarget(dragged, [...twins].reverse());
    expect(first.targetId).toBe(second.targetId);
    expect(first.targetId).toBe('b');
  });

  it('never claims the dragged node itself, even when handed the whole set', () => {
    const dragged = card('a', 0, 0);
    const d = pickDropTarget(dragged, [dragged, card('b', 0, 0)]);
    expect(d.ranked.map((r) => r.id)).toEqual(['b']);
    expect(d.targetId).toBe('b');
  });
});

describe('DECISION 3 — the drop is inert unless a target is claimed', () => {
  // The property that lets the sandbox (and, on adoption, Canvas) leave the
  // rest of drag-stop untouched: for every geometry that does NOT claim a
  // target, the decision carries nothing a caller could act on.
  it('a null decision names no node, in every refusal mode', () => {
    const cases = [
      pickDropTarget(card('a', 0, 0), []),
      pickDropTarget(card('a', 0, 0), [card('b', 900, 900)]),
      pickDropTarget(card('a', HP_UNIT, 0), [card('b', CARD_W, 0)]),
    ];
    expect(cases.map((d) => d.targetId)).toEqual([null, null, null]);
    expect(cases.every((d) => d.refusal !== undefined)).toBe(true);
  });
});
