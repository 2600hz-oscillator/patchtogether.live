// packages/web/src/lib/audio/modules/cv-buddy-face-model.test.ts
//
// THE Q52 FACE — the claims that are specific to `cvBuddy` / `cvBuddyMini` and
// are not decidable from the platform alone.
//
// Three of them, in rising order of how badly they fail if they are wrong:
//
//   1. ONE FACE OBJECT for two defs — asserted by IDENTITY, so a copy cannot
//      pass.
//   2. THE FACE IS LEGAL FOR BOTH — the two defs differ only in ports, and this
//      is the assertion that keeps that true as either def changes.
//   3. ⚠ THE PLATFORM'S "PRIMARY" IS THE MODULE'S "CLOCK OWNER" — exhaustively.
//      `rackStatusPlan` hides the clock band on every node that is not the
//      lexicographically smallest peer; `allocateCvBuddySlots` gives RUN/CLOCK
//      to the first instance that ACTUALLY GOT NOTE JACKS. Those two rules
//      agree today for a reason that is easy to state and easy to break: the
//      note pool always fits the first instance, so the id-smallest is never
//      inert. If that ever stops being true, the face hides the clock band on
//      the very instance that owns the clock — a defect with no symptom except
//      a missing control, on the one node where it matters.

import { describe, expect, it } from 'vitest';
import { cvBuddyDef, CV_BUDDY_FACE, CV_BUDDY_PPQN_CHOICES } from './cv-buddy';
import { cvBuddyMiniDef } from './cv-buddy-mini';
import { allocateCvBuddySlots, type CvBuddyInstance, type CvBuddyKind } from '$lib/audio/cv-buddy/slot-alloc';
import { primaryNodeId, rackStatusPlan } from '$lib/ui/workflow/rack-status-model';
import { paramCellKind } from '$lib/ui/workflow/shell-control-kind';

const BOTH = [cvBuddyDef, cvBuddyMiniDef];

describe('Q52 — ONE face for two modules', () => {
  it('⚠ BY IDENTITY: both defs reference the SAME object, not an equal one', () => {
    // `toEqual` would pass over two literals that happen to match today and say
    // nothing about tomorrow. `toBe` is the assertion that makes drift
    // unrepresentable rather than merely untested — the same argument the
    // shared PPQN param and the shared card body already make.
    expect(cvBuddyDef.face).toBe(CV_BUDDY_FACE);
    expect(cvBuddyMiniDef.face).toBe(CV_BUDDY_FACE);
    expect(cvBuddyDef.face).toBe(cvBuddyMiniDef.face);
  });

  it('the shared face is LEGAL for both defs — it ranks every param of each, once', () => {
    // The face names PARAMS and the two defs differ only in PORTS. This is what
    // keeps that premise true: if either def gains a param, the shared face
    // must gain the rank, and this goes red rather than the face silently
    // dropping a control on one of the two modules.
    for (const def of BOTH) {
      const params = (def.params ?? []).map((p) => p.id).sort();
      const ranked = [...(def.face?.order ?? [])].sort();
      expect(ranked, `${def.type}: face.order must be exactly its params`).toEqual(params);
    }
  });

  it('the single band holds EVERY control — which is why the body is load-bearing', () => {
    // Both params are clock params, so suppressing `clock` suppresses the whole
    // control surface. That is a fact about this module, and it is the reason
    // `rackStatusPlan` may not hide anything unless the status body is
    // painting. Stated here so a later band split does not quietly make the
    // never-a-blank-plate argument stop applying without anyone noticing.
    const pages = CV_BUDDY_FACE.pages ?? [];
    expect(pages.map((p) => p.id)).toEqual(['clock']);
    for (const def of BOTH) {
      expect([...pages[0]!.controls].sort()).toEqual((def.params ?? []).map((p) => p.id).sort());
    }
    expect(CV_BUDDY_FACE.rackStatus?.primaryOnlyBands).toEqual(['clock']);
  });

  it('PPQN resolves to a SELECTOR at the dock — verbatim parity with the card\'s <select>', () => {
    // The card has always drawn a dropdown for this. Seven options is one past
    // `SEGMENTED_MAX_OPTIONS`, so the dock resolves `selector` — the same
    // gesture, not a 48-position dial (which is what the face made visible and
    // #2055 fixed).
    const ppqn = cvBuddyDef.params.find((p) => p.id === 'ppqn')!;
    expect(ppqn.options?.length).toBe(CV_BUDDY_PPQN_CHOICES.length);
    expect(paramCellKind(ppqn, new Set(), 'dock')).toBe('selector');
    // NEGATIVE CONTROL for the same resolver: the offset knob is a plain
    // continuous scalar and must NOT come back as a roster control.
    const offset = cvBuddyDef.params.find((p) => p.id === 'clockOffsetMs')!;
    expect(paramCellKind(offset, new Set(), 'dock')).toBe('knob');
  });
});

// ── THE ONE-TRUTH LEG ───────────────────────────────────────────────────────

/** Every arrangement of `n` instances over both kinds, as kind tuples. */
function kindTuples(n: number): CvBuddyKind[][] {
  if (n === 0) return [[]];
  const out: CvBuddyKind[][] = [];
  for (const rest of kindTuples(n - 1)) {
    out.push(['full', ...rest], ['mini', ...rest]);
  }
  return out;
}

/** Ids that are NOT in insertion order, so a rule that took "the first one it
 *  saw" would disagree with one that sorts. `n-30` sorts before `n-4`, which is
 *  also how real Yjs ids behave (they are opaque strings, not integers). */
function idsFor(n: number): string[] {
  const pool = ['n-30', 'n-4', 'n-100', 'n-7', 'n-25'];
  return pool.slice(0, n);
}

describe('Q52 — the platform PRIMARY is the module CLOCK OWNER (exhaustive)', () => {
  it('agrees for every kind-combination up to four instances', () => {
    const disagreements: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const ids = idsFor(n);
      for (const kinds of kindTuples(n)) {
        const instances: CvBuddyInstance[] = ids.map((id, i) => ({ id, kind: kinds[i]! }));
        const alloc = allocateCvBuddySlots(instances);
        const platformPrimary = primaryNodeId(ids);
        for (const id of ids) {
          const ownsClock = alloc.get(id)?.ownsClock === true;
          const isPrimary = id === platformPrimary;
          if (ownsClock !== isPrimary) {
            disagreements.push(
              `${kinds.join('+')} [${ids.join(',')}]: ${id} ownsClock=${ownsClock} primary=${isPrimary}`,
            );
          }
        }
      }
    }
    expect(
      disagreements,
      'the allocator and the face disagree about which instance owns RUN/CLOCK. The face hides '
        + 'the clock band on every NON-primary node, so a disagreement means the band is hidden on '
        + 'the node that owns the clock (or shown on one that does not) — a missing control with '
        + 'no other symptom. `allocateCvBuddySlots` gives RUN/CLOCK to the first instance that got '
        + 'note jacks, `primaryNodeId` names the lexicographically smallest peer; they coincide '
        + 'only while the id-smallest instance can never be inert. If that premise changed, this '
        + 'is the assertion that says so — fix the FACE\'s rule, do not relax this test.',
    ).toEqual([]);
  });

  it('the sweep is NOT VACUOUS — it reached inert instances and multi-kind racks', () => {
    // 4 minis need 8 note jacks and only 6 exist, so the fourth is inert. If
    // the generator ever stopped producing that case, the leg above would still
    // be green while no longer exercising the hard half.
    const ids = idsFor(4);
    const allMini: CvBuddyInstance[] = ids.map((id) => ({ id, kind: 'mini' }));
    const alloc = allocateCvBuddySlots(allMini);
    expect(alloc.size, 'exactly three minis fit the 6-jack note pool').toBe(3);
    const inert = ids.filter((id) => !alloc.has(id));
    expect(inert.length, 'the sweep really does include an INERT instance').toBe(1);
    // …and the inert one is NOT the primary, which is the premise the leg above
    // depends on. Pinned explicitly so the premise is visible, not implied.
    expect(inert[0]).not.toBe(primaryNodeId(ids));
    expect(kindTuples(4).length, 'every full/mini arrangement of four').toBe(16);
  });

  it('⚠ BOTH RULES SORT LEXICOGRAPHICALLY, and node ids are STRINGS not integers', () => {
    // Worth pinning explicitly because it reads wrong at a glance: `n-30` sorts
    // BEFORE `n-4`, since ids are opaque strings and compare character by
    // character. Both rules do the same thing — the allocator's own comparator
    // is `a.id < b.id` — so they agree; a numeric-looking intuition would
    // predict the opposite, and this is where that is written down.
    expect(primaryNodeId(['n-4', 'n-30'])).toBe('n-30');
    const alloc = allocateCvBuddySlots([
      { id: 'n-4', kind: 'full' },
      { id: 'n-30', kind: 'full' },
    ]);
    expect(alloc.get('n-30')?.ownsClock, 'the allocator sorts the same way').toBe(true);
    expect(alloc.get('n-4')?.ownsClock).toBe(false);
  });

  it('POSITIVE CONTROL: a WRONG peer set names a different node, so the sweep can fail', () => {
    // A sweep of agreements proves nothing unless disagreement is reachable at
    // all. The realistic way to produce one is a `peers` roster that stopped
    // naming both kinds: shown only its own type, a node computes a different
    // primary and the face hides the band on the instance that owns the clock.
    expect(primaryNodeId(['n-4', 'n-30'])).toBe('n-30');
    expect(primaryNodeId(['n-4'])).toBe('n-4');
    expect(primaryNodeId(['n-4'])).not.toBe(primaryNodeId(['n-4', 'n-30']));
  });

  it('END TO END: the peer of the OTHER kind can be the clock owner', () => {
    // The same fact one level up, through the SHIPPED declaration rather than
    // through `primaryNodeId` directly — so a `peers` roster that stopped
    // naming both kinds reddens here even though the allocator agreement above
    // is untouched.
    //
    // ⚠ AND IT IS THE MINI THAT OWNS THE CLOCK HERE, which is the module's own
    // documented behaviour rather than an accident of the fixture: "three minis
    // and still have a clock" is only true because a mini can be the id-
    // smallest instance. A face that assumed the full kind always wins would
    // pass a same-kind fixture and fail on a real rack.
    const nodes = { 'n-4': { type: 'cvBuddy' }, 'n-30': { type: 'cvBuddyMini' } };
    const plan = (id: string) =>
      rackStatusPlan({
        view: 'dock-full',
        declared: CV_BUDDY_FACE.rackStatus,
        extBody: true,
        nodeId: id,
        nodes,
      });
    expect([...plan('n-30').hiddenBands], 'the mini is primary and keeps its band').toEqual([]);
    expect([...plan('n-4').hiddenBands], 'the full instance loses it').toEqual(['clock']);
    // …and it agrees with the allocator on the same rack.
    const alloc = allocateCvBuddySlots([
      { id: 'n-4', kind: 'full' },
      { id: 'n-30', kind: 'mini' },
    ]);
    expect(alloc.get('n-30')?.ownsClock).toBe(true);
    // If the face named only its own type, BOTH nodes would be primary and
    // nothing would ever hide. Asserted through the shipped declaration.
    expect(CV_BUDDY_FACE.rackStatus?.peers).toContain('cvBuddy');
    expect(CV_BUDDY_FACE.rackStatus?.peers).toContain('cvBuddyMini');
  });
});
