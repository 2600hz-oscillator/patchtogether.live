// Covers the VIDEO WIDENING RULE — the predicate `canConnect` derives its video
// quadrant from, and the one the drop modal renders.
//
// ⚠ READ THIS BEFORE TRUSTING THE DIVERGENCE TEST. Until #1780 the lattice was a
// PROPOSAL and `canConnect` had its own hand-written edge table, so differencing
// the two over every ordered pair was an empirical measurement — and it found
// exactly one disagreement, `keys -> video`, the un-closed diagonal. Now that
// canConnect CALLS `videoWidensTo`, that same assertion measures something
// weaker: it proves canConnect's video quadrant adds NOTHING of its own. It can
// still redden (a special case slipped in above or below the lattice branch,
// canConnect ceasing to route video pairs through it at all) but it can no
// longer discover a rule disagreement, because there is only one rule left.
//
// So the load-bearing tests are now the ones ABOVE it — the partial-order
// properties and the owner's rule stated directly — plus the pinned `keys ->
// video` regression, which names the artifact rather than the relation and
// therefore cannot go quiet. The `cv -> video` case at the bottom stays for the
// same reason it always did: it is the clause the lattice deliberately does not
// model, so "the lattice IS canConnect" can never be assumed from a green run.
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
  it('canConnect and the lattice agree on EVERY video pair — no divergence left', () => {
    const divergent = PAIRS.filter(
      ([s, d]) => videoWidensTo(s, d) !== canConnect(s, d),
    ).map(([s, d]) => `${s} -> ${d}`);

    // Before #1780 this set was exactly ['keys -> video'] — the diagonal the
    // hand-written edge table never wrote down, measured rather than guessed.
    // canConnect's video quadrant is now the lattice itself, so the set is
    // EMPTY, and it is stated as the set it is rather than as a count.
    expect(divergent).toEqual([]);
  });

  it('pins the fix at the ARTIFACT: keys -> video is patchable through canConnect', () => {
    // The regression the issue is about, asserted on the SHIPPED entry point in
    // its own terms. Unlike the sweep above this does not restate the relation,
    // so it survives any future re-shaping of how canConnect reaches the rule.
    // keys is mono+still, video is colour+animated: a widening on BOTH axes,
    // free at the shader layer, and legal in two hops even before the fix.
    expect(canConnect('keys', 'video')).toBe(true);
    // …and the fix did not open the lossy direction on the way past.
    expect(canConnect('video', 'keys')).toBe(false);
  });

  it('canConnect is TRANSITIVELY CLOSED over video pairs — the defect class, on the shipped rule', () => {
    // The property the edge table failed, asserted against canConnect rather
    // than against the lattice: a two-hop patch is always a one-hop patch. This
    // is what a re-introduced special case in canConnect's video quadrant would
    // break, and it is stated over the whole relation so a fifth video type is
    // covered without editing the test.
    const gaps: string[] = [];
    for (const a of TYPES) {
      for (const b of TYPES) {
        if (!canConnect(a, b)) continue;
        for (const c of TYPES) {
          if (canConnect(b, c) && !canConnect(a, c)) gaps.push(`${a} -> ${b} -> ${c}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it('negative control: the difference is really being measured', () => {
    // If videoWidensTo were (say) always-true or always-false, the sweep above
    // would still be an assertion — it just would not be about the lattice.
    // Perturb the subject and confirm the divergence set MOVES: a degenerate
    // answer disagrees with canConnect on real pairs, so neither one can
    // produce the EMPTY set the real predicate produces.
    const alwaysTrue = PAIRS.filter(([s, d]) => true !== canConnect(s, d));
    const alwaysFalse = PAIRS.filter(([s, d]) => false !== canConnect(s, d));
    expect(alwaysTrue.length).toBeGreaterThan(0);
    expect(alwaysFalse.length).toBeGreaterThan(0);
    // Both directions named, so the control cannot pass by canConnect having
    // collapsed to a constant itself: canConnect refuses SOME video pair and
    // permits SOME video pair.
    expect(alwaysTrue.map(([s, d]) => `${s} -> ${d}`)).toContain('video -> keys');
    expect(alwaysFalse.map(([s, d]) => `${s} -> ${d}`)).toContain('keys -> video');
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
