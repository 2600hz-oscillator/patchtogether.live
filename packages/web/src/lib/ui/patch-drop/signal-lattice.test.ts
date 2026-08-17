// ⛔ MOCK / PROPOSAL — covers the derived predicate the /dev/video-patch-drop
// mocks render. Nothing in the engine imports the subject.
//
// The load-bearing test here is `pins the ONLY divergence from the shipped
// rule`: it does not restate the lattice, it DIFFERENCES the proposal against
// the live `canConnect` over every ordered pair and asserts the exact set of
// pairs where they disagree. If the proposal drifts, or if someone edits
// canConnect's upcast table, this reddens with the offending pair named — and
// it can never go stale the way a hand-copied expectation would.
import { describe, it, expect } from 'vitest';
import { canConnect } from '$lib/graph/types';
import {
  VIDEO_SHAPE,
  videoWidensTo,
  isVideoShape,
  refusalReason,
  REFUSAL_TEXT,
  CHANNEL_RANK,
  MOTION_RANK,
} from './signal-lattice';

/** Derived from the lattice itself — never typed out. */
const TYPES = Object.keys(VIDEO_SHAPE);
const PAIRS = TYPES.flatMap((src) => TYPES.map((dst) => [src, dst] as const));

describe('the video lattice is a partial order', () => {
  it('is reflexive — every type widens to itself', () => {
    const notReflexive = TYPES.filter((t) => !videoWidensTo(t, t));
    expect(notReflexive).toEqual([]);
  });

  it('is transitive — a two-hop widening is always a one-hop widening', () => {
    // The property the shipped edge table FAILS. Asserted over the whole
    // relation rather than on the one pair we happen to know about, so a
    // future fifth video type is covered without editing this test.
    const gaps: string[] = [];
    for (const a of TYPES) {
      for (const b of TYPES) {
        if (!videoWidensTo(a, b)) continue;
        for (const c of TYPES) {
          if (videoWidensTo(b, c) && !videoWidensTo(a, c)) gaps.push(`${a} -> ${b} -> ${c}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it('is antisymmetric — mutual widening only between identical types', () => {
    const mutual = PAIRS.filter(
      ([a, b]) => a !== b && videoWidensTo(a, b) && videoWidensTo(b, a),
    ).map(([a, b]) => `${a} <-> ${b}`);
    expect(mutual).toEqual([]);
  });
});

describe("the owner's rule, stated directly", () => {
  it('mono widens into colour on both motion rows', () => {
    expect(videoWidensTo('mono-video', 'video')).toBe(true);
    expect(videoWidensTo('keys', 'image')).toBe(true);
  });

  it('colour NEVER widens into mono', () => {
    const illegal = PAIRS.filter(
      ([s, d]) =>
        CHANNEL_RANK[VIDEO_SHAPE[s].channels] > CHANNEL_RANK[VIDEO_SHAPE[d].channels],
    );
    // Derived membership: every colour→mono pair the lattice can express is
    // refused, and there is at least one such pair to refuse (a vacuity guard
    // that reads off the lattice rather than counting it).
    expect(illegal.length).toBeGreaterThan(0);
    expect(illegal.filter(([s, d]) => videoWidensTo(s, d))).toEqual([]);
  });

  it('still widens into animated, never the reverse', () => {
    expect(videoWidensTo('keys', 'mono-video')).toBe(true);
    expect(videoWidensTo('image', 'video')).toBe(true);
    const illegal = PAIRS.filter(
      ([s, d]) => MOTION_RANK[VIDEO_SHAPE[s].motion] > MOTION_RANK[VIDEO_SHAPE[d].motion],
    );
    expect(illegal.filter(([s, d]) => videoWidensTo(s, d))).toEqual([]);
  });
});

describe('difference against the SHIPPED rule', () => {
  it('pins the ONLY divergence from canConnect: the un-closed diagonal', () => {
    const divergent = PAIRS.filter(
      ([s, d]) => videoWidensTo(s, d) !== canConnect(s, d),
    ).map(([s, d]) => `${s} -> ${d}`);

    // keys is mono+still; video is colour+animated. It is a widening on BOTH
    // axes, which is free, and it is legal in two hops today. The shipped
    // edge table simply never wrote the diagonal down. Adopting the lattice
    // ADDS this patch and changes nothing else — that is the whole diff, and
    // it is stated here as the set it is rather than as a count.
    expect(divergent).toEqual(['keys -> video']);
  });

  it('negative control: the difference is really being measured', () => {
    // If videoWidensTo were (say) always-true or always-false, the assertion
    // above would still be an assertion — it just would not be about the
    // lattice. Perturb the subject and confirm the divergence set MOVES.
    const alwaysTrue = PAIRS.filter(([s, d]) => true !== canConnect(s, d));
    const alwaysFalse = PAIRS.filter(([s, d]) => false !== canConnect(s, d));
    expect(alwaysTrue.length).toBeGreaterThan(0);
    expect(alwaysFalse.length).toBeGreaterThan(0);
    // …and neither degenerate answer produces the real one-element set.
    expect(alwaysTrue.length).not.toBe(1);
    expect(alwaysFalse.length).not.toBe(1);
  });
});

describe('refusal reasons name the AXIS that failed', () => {
  it('colour into mono', () => {
    expect(refusalReason('video', 'mono-video')).toBe('colour-into-mono');
    expect(refusalReason('image', 'keys')).toBe('colour-into-mono');
  });
  it('motion into still', () => {
    expect(refusalReason('mono-video', 'keys')).toBe('motion-into-still');
    expect(refusalReason('video', 'image')).toBe('motion-into-still');
  });
  it('both axes at once', () => {
    expect(refusalReason('video', 'keys')).toBe('colour-and-motion');
  });
  it('undefined exactly when the widening is legal', () => {
    const disagree = PAIRS.filter(
      ([s, d]) => (refusalReason(s, d) === undefined) !== videoWidensTo(s, d),
    );
    expect(disagree).toEqual([]);
  });
  it('every reason has user-facing text', () => {
    const reasons = new Set(
      PAIRS.map(([s, d]) => refusalReason(s, d)).filter((r) => r !== undefined),
    );
    expect([...reasons].filter((r) => !REFUSAL_TEXT[r!])).toEqual([]);
    // Every declared text is reachable from some real pair — a REFUSAL_TEXT
    // key naming a reason the lattice can never produce is dead vocabulary.
    expect(Object.keys(REFUSAL_TEXT).filter((k) => !reasons.has(k as never))).toEqual([]);
  });
});

describe('scope — what the lattice does not claim', () => {
  it('non-video types have no position and never widen', () => {
    for (const t of ['audio', 'cv', 'gate', 'pitch', 'modsignal', 'polyPitchGate']) {
      expect(isVideoShape(t)).toBe(false);
      expect(videoWidensTo(t, 'video')).toBe(false);
      expect(videoWidensTo('video', t)).toBe(false);
    }
  });

  it('cv -> video is an ADAPTER, so the lattice refuses it while canConnect allows it', () => {
    // Stated as a test so the divergence assertion above cannot be read as
    // "the lattice reproduces canConnect entirely" — it reproduces the
    // WIDENING clause only, and this is the clause it deliberately omits.
    for (const v of TYPES) {
      expect(videoWidensTo('cv', v)).toBe(false);
      expect(canConnect('cv', v)).toBe(true);
    }
  });
});
