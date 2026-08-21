// packages/web/src/lib/ui/workflow/rack-status-model.test.ts
//
// The RACK-GLOBAL STATUS predicate (#2024). Pure, so everything about it is
// decidable here rather than in a browser.
//
// The three properties worth stating up front, because the tests below are
// organised around them:
//
//   1. UNDECLARED IS INERT. 96 of 98 faces declare nothing, and none of their
//      behaviour may change.
//   2. IT CANNOT BLANK A PLATE. Suppression requires the module's own body to
//      be painting — `faceMonitorPlan`'s precondition, and sharper here because
//      cvBuddy's suppressed band holds BOTH of its params.
//   3. THE THREE "HIDE NOTHING" ROUTES ARE DISTINCT and are asserted
//      separately. Collapsing them would let a real bug (the peer scan finding
//      nothing) look exactly like a policy (undeclared ⇒ inert).

import { describe, expect, it } from 'vitest';
import { peerNodeIds, primaryNodeId, rackStatusPlan, type RackStatusDecl } from './rack-status-model';

const DECL: RackStatusDecl = {
  why: 'a worked fixture standing in for cvBuddy: RUN and CLOCK are single-source, so the clock band belongs to the primary instance only.',
  peers: ['cvBuddy', 'cvBuddyMini'],
  primaryOnlyBands: ['clock'],
};

function nodes(...entries: [string, string][]): Record<string, { type?: string } | undefined> {
  return Object.fromEntries(entries.map(([id, type]) => [id, { type }]));
}

describe('primaryNodeId — the converged tie-break', () => {
  it('is the lexicographically smallest id', () => {
    expect(primaryNodeId(['n-9', 'n-2', 'n-5'])).toBe('n-2');
  });

  it('is INDEPENDENT of iteration order — every peer computes the same answer', () => {
    // The whole reason it is a lex sort rather than "first seen": a collab peer
    // whose Yjs map iterates differently must not disagree about which node
    // drives the hardware. Two modules driving one physical jack is silently
    // wrong voltage, with no error.
    const ids = ['n-c', 'n-a', 'n-b'];
    expect(primaryNodeId(ids)).toBe(primaryNodeId([...ids].reverse()));
    expect(primaryNodeId(ids)).toBe(primaryNodeId([...ids].sort()));
  });

  it('is null for an empty set — which is NOT "this node is primary"', () => {
    expect(primaryNodeId([])).toBeNull();
  });
});

describe('peerNodeIds — who counts as a peer', () => {
  it('takes every declared type and nothing else', () => {
    const map = nodes(
      ['n-1', 'cvBuddy'],
      ['n-2', 'es9'],
      ['n-3', 'cvBuddyMini'],
      ['n-4', 'adsr'],
    );
    expect(peerNodeIds(map, DECL.peers).sort()).toEqual(['n-1', 'n-3']);
  });

  it('⚠ SPANS TYPES — the mini is a peer of the full, which is the point', () => {
    // Two independent per-type scans would each name their own primary, and
    // BOTH would drive ES-9 jacks 7 and 8. The shared pool is the module's own
    // stated invariant; this is where the face inherits it.
    const map = nodes(['n-2', 'cvBuddy'], ['n-1', 'cvBuddyMini']);
    expect(primaryNodeId(peerNodeIds(map, DECL.peers))).toBe('n-1');
  });

  it('survives a hole in the map (mid-delete) without throwing', () => {
    const map: Record<string, { type?: string } | undefined> = {
      'n-1': undefined,
      'n-2': { type: 'cvBuddy' },
      'n-3': {},
    };
    expect(peerNodeIds(map, DECL.peers)).toEqual(['n-2']);
  });
});

describe('rackStatusPlan — 1. UNDECLARED IS INERT', () => {
  it('hides nothing, is unavailable, and reports primary for a face that declares none', () => {
    const p = rackStatusPlan({
      view: 'dock-full',
      declared: undefined,
      extBody: true,
      nodeId: 'n-9',
      nodes: nodes(['n-1', 'cvBuddy'], ['n-9', 'cvBuddy']),
    });
    expect(p.hiddenBands.size).toBe(0);
    expect(p.available).toBe(false);
    // `primary: true` for an undeclared face is deliberate: every consumer asks
    // "may I hide this?", and the answer for a face with no declaration must be
    // no, by the same route as for the instance that owns the resource.
    expect(p.primary).toBe(true);
  });
});

describe('rackStatusPlan — 2. IT CANNOT BLANK A PLATE', () => {
  const nonPrimary = {
    declared: DECL,
    nodeId: 'n-9',
    nodes: nodes(['n-1', 'cvBuddy'], ['n-9', 'cvBuddy']),
  } as const;

  it('hides the declared band on a non-primary node WHEN the body is painting', () => {
    const p = rackStatusPlan({ view: 'dock-full', extBody: true, ...nonPrimary });
    expect(p.primary).toBe(false);
    expect([...p.hiddenBands]).toEqual(['clock']);
    expect(p.available).toBe(true);
  });

  it('⚠ hides NOTHING when no extension body is painting — the precondition', () => {
    // Without this, a face declaring rackStatus whose extension failed to
    // resolve renders a plate with no controls and no picture. On cvBuddy that
    // is the ENTIRE surface, since both params live in the suppressed band.
    const p = rackStatusPlan({ view: 'dock-full', extBody: false, ...nonPrimary });
    expect(p.primary).toBe(false);
    expect(p.hiddenBands.size).toBe(0);
    expect(p.available).toBe(false);
  });

  it('⚠ hides NOTHING on the LANE — the named blind spot, asserted not assumed', () => {
    // `dockFullViewHeadPlan` never mounts an extension body on a 192px tile, so
    // a non-primary lane tile still paints its clock controls. That is a real
    // difference from the legacy card, and it is the deliberate trade: a tile
    // with no controls and no body is blank.
    const p = rackStatusPlan({ view: 'lane', extBody: false, ...nonPrimary });
    expect(p.hiddenBands.size).toBe(0);
    expect(p.available).toBe(false);
    // …and the primary answer is still correct on the lane; only the ACTION differs.
    expect(p.primary).toBe(false);
  });

  it('the DRAWER is a faceplate too, so it suppresses like the dock (#1739)', () => {
    const p = rackStatusPlan({ view: 'drawer', extBody: true, ...nonPrimary });
    expect([...p.hiddenBands]).toEqual(['clock']);
    expect(p.available).toBe(true);
  });
});

describe('rackStatusPlan — 3. THE PRIMARY KEEPS EVERYTHING', () => {
  it('a LONE instance is primary and loses nothing', () => {
    // This is the state every freshly spawned node and every VRT face scene is
    // in, so it is the one that must be boring.
    const p = rackStatusPlan({
      view: 'dock-full',
      declared: DECL,
      extBody: true,
      nodeId: 'n-1',
      nodes: nodes(['n-1', 'cvBuddy']),
    });
    expect(p.primary).toBe(true);
    expect(p.hiddenBands.size).toBe(0);
    expect(p.available).toBe(true);
  });

  it('the id-smallest of MANY keeps the band; every other one loses it', () => {
    const map = nodes(['n-3', 'cvBuddy'], ['n-1', 'cvBuddyMini'], ['n-2', 'cvBuddy']);
    const hidden = (id: string) =>
      [...rackStatusPlan({ view: 'dock-full', declared: DECL, extBody: true, nodeId: id, nodes: map }).hiddenBands];
    expect(hidden('n-1')).toEqual([]);
    expect(hidden('n-2')).toEqual(['clock']);
    expect(hidden('n-3')).toEqual(['clock']);
  });

  it('⚠ FAILS OPEN when this node is not in the map yet', () => {
    // Mid-spawn / mid-delete the patch can hand a nodeId that is not in
    // `nodes`. The cost of failing open is one frame of a dead dial; the cost
    // of failing closed is a faceplate with no controls while the patch
    // settles, which looks like a broken module.
    const p = rackStatusPlan({
      view: 'dock-full',
      declared: DECL,
      extBody: true,
      nodeId: 'n-not-yet',
      nodes: {},
    });
    expect(p.primary).toBe(true);
    expect(p.hiddenBands.size).toBe(0);
  });

  it('an EMPTY primaryOnlyBands hides nothing even on a non-primary node', () => {
    const p = rackStatusPlan({
      view: 'dock-full',
      declared: { ...DECL, primaryOnlyBands: [] },
      extBody: true,
      nodeId: 'n-9',
      nodes: nodes(['n-1', 'cvBuddy'], ['n-9', 'cvBuddy']),
    });
    expect(p.primary).toBe(false);
    expect(p.hiddenBands.size).toBe(0);
  });
});

describe('rackStatusPlan — the instrument itself', () => {
  it('NEGATIVE CONTROL: an unrelated sibling type does not make a node non-primary', () => {
    // If `peerNodeIds` ever matched everything, every declaring face would
    // silently lose its band the moment any second node existed — and the
    // symptom (a missing band) looks exactly like the feature working.
    const p = rackStatusPlan({
      view: 'dock-full',
      declared: DECL,
      extBody: true,
      nodeId: 'n-9',
      nodes: nodes(['n-1', 'adsr'], ['n-2', 'es9'], ['n-9', 'cvBuddy']),
    });
    expect(p.primary, 'an adsr and an es9 are not CV Buddies').toBe(true);
    expect(p.hiddenBands.size).toBe(0);
  });

  it('POSITIVE CONTROL: the same call with a real peer DOES suppress', () => {
    // The pair matters more than either half: it proves the negative above is
    // reading a live predicate rather than a path that can never fire.
    const p = rackStatusPlan({
      view: 'dock-full',
      declared: DECL,
      extBody: true,
      nodeId: 'n-9',
      nodes: nodes(['n-1', 'cvBuddyMini'], ['n-9', 'cvBuddy']),
    });
    expect(p.primary).toBe(false);
    expect([...p.hiddenBands]).toEqual(['clock']);
  });

  it('the returned set is never the same mutable object twice', () => {
    // The shell filters with it every frame; a shared mutable Set would be a
    // cross-node leak that only shows up with two faceplates open.
    const call = (id: string) =>
      rackStatusPlan({
        view: 'dock-full',
        declared: DECL,
        extBody: true,
        nodeId: id,
        nodes: nodes(['n-1', 'cvBuddy'], ['n-8', 'cvBuddy'], ['n-9', 'cvBuddy']),
      }).hiddenBands;
    const a = call('n-8');
    const b = call('n-9');
    expect(a).not.toBe(b);
    expect([...a]).toEqual([...b]);
  });
});
