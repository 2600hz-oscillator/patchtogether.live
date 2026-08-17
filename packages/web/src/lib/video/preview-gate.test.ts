// packages/web/src/lib/video/preview-gate.test.ts
//
// The decision's own gate. Every leg drives an explicit clock, so there is no
// wall-clock sleep and no flake surface.
//
// CLAUDE.md §VALIDATE THE INSTRUMENT: each rule is asserted in BOTH directions
// — a gate that only ever says "skip" would satisfy half of these, and a gate
// that only ever says "blit" would satisfy the other half.

import { describe, it, expect } from 'vitest';
import {
  previewDecision,
  PREVIEW_FPS,
  PREVIEW_MIN_INTERVAL_MS,
  type PreviewGateInput,
} from './preview-gate';

const base: PreviewGateInput = {
  cardVisible: true,
  leased: false,
  lastPreviewAtMs: null,
  nowMs: 1000,
};

describe('preview gate', () => {
  it('the cadence constants derive from one another', () => {
    expect(PREVIEW_MIN_INTERVAL_MS, 'ms between repaints at PREVIEW_FPS').toBeCloseTo(
      1000 / PREVIEW_FPS,
      10,
    );
  });

  it('OFF-SCREEN refuses; ON-SCREEN allows — the correctness half, both ways', () => {
    expect(
      previewDecision({ ...base, cardVisible: false }),
      'a card the observer reports off-screen must stop being an observer of its node: ' +
        'the blit IS the watch mark, so continuing to blit keeps the whole upstream chain ' +
        'rendering for a picture nobody can see (MEASURED: toybox -> backdraft drew 481 ' +
        'frames in 4s with backdraft patched nowhere)',
    ).toBe('skip:offscreen');
    expect(previewDecision({ ...base, cardVisible: true }), 'on-screen, first paint').toBe('blit');
  });

  it('UNKNOWN visibility FAILS OPEN — never blanks a card the observer has not seen', () => {
    expect(
      previewDecision({ ...base, cardVisible: undefined }),
      'absent = unknown = visible, the same rule pull evaluation uses. Failing CLOSED here ' +
        'would blank every card for the frames between mount and the first ' +
        'IntersectionObserver callback.',
    ).toBe('blit');
  });

  it('A LEASE BYPASSES BOTH GATES — and it is the only thing that does', () => {
    // Off-screen AND inside the cadence window: the two reasons to refuse,
    // together. A presenting surface still repaints.
    expect(
      previewDecision({
        ...base,
        leased: true,
        cardVisible: false,
        lastPreviewAtMs: 1000,
        nowMs: 1001,
      }),
      'fullscreen / projector / full-frame take a render lease; a lease means a human is ' +
        'looking at the real picture, so neither the viewport gate nor the cadence cap applies',
    ).toBe('blit');
    // Negative control for the same input WITHOUT the lease — otherwise the
    // assertion above is satisfied by a gate that always returns 'blit'.
    expect(
      previewDecision({ ...base, leased: false, cardVisible: false, lastPreviewAtMs: 1000, nowMs: 1001 }),
      'NEGATIVE CONTROL: the identical input without the lease must be refused',
    ).toBe('skip:offscreen');
  });

  it('the CADENCE CAP throttles, and reports WHY separately from off-screen', () => {
    // An EXACT interval, not the derived PREVIEW_MIN_INTERVAL_MS (1000/30 =
    // 33.3…), so the boundary leg tests the COMPARISON and not IEEE-754:
    // `1000 + 1000/30 - 1000` is 33.33333333333326, which is a hair BELOW
    // 33.333333333333336 and would fail a `>=` that is in fact correct.
    const interval = 30;
    const justPainted = { ...base, lastPreviewAtMs: 1000, nowMs: 1029, minIntervalMs: interval };
    expect(
      previewDecision(justPainted),
      'inside the cadence window. Reported as `skip:throttled`, NOT `skip:offscreen` — the ' +
        'two mean different things to the caller (still watching vs stop watching) and a ' +
        'boolean would erase the difference',
    ).toBe('skip:throttled');
    expect(
      previewDecision({ ...justPainted, nowMs: 1030 }),
      'exactly one interval later is ON cadence — `>=`, because `>` makes the effective rate ' +
        'drift below target on a display whose frame period divides evenly into it',
    ).toBe('blit');
    // And the real constant still throttles/releases either side of its window,
    // which is what the product actually runs.
    expect(
      previewDecision({ ...base, lastPreviewAtMs: 1000, nowMs: 1000 + PREVIEW_MIN_INTERVAL_MS / 2 }),
      'half an interval in, at the SHIPPED cadence',
    ).toBe('skip:throttled');
    expect(
      previewDecision({ ...base, lastPreviewAtMs: 1000, nowMs: 1000 + PREVIEW_MIN_INTERVAL_MS * 2 }),
      'two intervals in, at the SHIPPED cadence',
    ).toBe('blit');
  });

  it('VISIBILITY IS CHECKED BEFORE CADENCE — the reason must be the actionable one', () => {
    expect(
      previewDecision({ ...base, cardVisible: false, lastPreviewAtMs: 1000, nowMs: 1001 }),
      'both reasons apply at once; the off-screen one is the one that changes what the card ' +
        'should do about it',
    ).toBe('skip:offscreen');
  });

  it('minIntervalMs 0 disables the cadence cap without touching the visibility gate', () => {
    expect(
      previewDecision({ ...base, lastPreviewAtMs: 1000, nowMs: 1000, minIntervalMs: 0 }),
      'the kill switch shape: uncapped cadence',
    ).toBe('blit');
    expect(
      previewDecision({ ...base, cardVisible: false, lastPreviewAtMs: 1000, nowMs: 1000, minIntervalMs: 0 }),
      'NEGATIVE CONTROL: disabling the cadence cap must NOT disable the visibility gate — ' +
        'they are separate rules and the correctness one is not a performance knob',
    ).toBe('skip:offscreen');
  });

  it('a never-painted node paints immediately at any clock value', () => {
    expect(previewDecision({ ...base, lastPreviewAtMs: null, nowMs: 0 })).toBe('blit');
    expect(previewDecision({ ...base, lastPreviewAtMs: null, nowMs: 1e9 })).toBe('blit');
  });
});
