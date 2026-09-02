// packages/web/src/lib/audio/momentary-params.test.ts
//
// THE TEST THAT WOULD HAVE CAUGHT THE STUCK PAD — a rack saved with tomtom's
// STRIKE at 1, which masks `trigger_in` forever, or with tidyVco's HOLD at 1,
// which reloads the voice already droning.
//
// Both halves are asserted here, and they are different claims:
//
//   1. THE RULE, pure — a declared press-pad's persisted value never survives
//      to a spawn, and NOTHING ELSE is touched. The second half matters as much
//      as the first: a repair that also reset the user's knobs would be a
//      worse bug than the one it fixes, and "returns the input by identity when
//      nothing is stuck" is the cheap way to prove it did not.
//   2. THE REAL DEFS — tomtom and tidyVco are the two modules in the repo that
//      declare `face.momentary`, and the fixtures below are their ACTUAL defs,
//      so this cannot pass on a hand-written shape that has drifted from them.
//      A third module growing a press-pad is enrolled automatically.
//
// The write half (a press never becoming durable in the first place) is pinned
// in manual-strike-actions.test.ts; the audible half is tomtom.spec.ts.

import { describe, expect, it } from 'vitest';
import {
  momentaryIds,
  momentaryRest,
  restedParams,
  stuckMomentaryIds,
  type MomentaryDefLike,
} from './momentary-params';
import './modules';
import { tomtomDef } from './modules/tomtom';
import { tidyVcoDef } from './modules/tidy-vco';
import { listModuleDefs } from './module-registry';

const FIXTURE: MomentaryDefLike = {
  params: [
    { id: 'strike', defaultValue: 0 },
    { id: 'tune', defaultValue: 120 },
    { id: 'restsAtOne', defaultValue: 1 },
  ],
  face: { momentary: ['strike', 'restsAtOne'] },
};

describe('momentaryIds — the declared press-pads, filtered against real params', () => {
  it('is empty for a def that declares none (the common case, zero allocation)', () => {
    expect(momentaryIds({ params: [{ id: 'a', defaultValue: 0 }] }).size).toBe(0);
    expect(momentaryIds(undefined).size).toBe(0);
  });

  it('drops a declared id that is not a real param', () => {
    // `face.momentary` is hand-maintained UI metadata; a stale entry there must
    // not invent a param, or `restedParams` would write a key the def has never
    // heard of into the spawn snapshot.
    const ids = momentaryIds({
      params: [{ id: 'strike', defaultValue: 0 }],
      face: { momentary: ['strike', 'ghost'] },
    });
    expect([...ids]).toEqual(['strike']);
  });
});

describe('momentaryRest — rest is the DEF\'s default, not a hardcoded 0', () => {
  it('reads defaultValue', () => {
    expect(momentaryRest(FIXTURE, 'strike')).toBe(0);
    expect(momentaryRest(FIXTURE, 'restsAtOne')).toBe(1);
  });
  it('an unknown param rests at 0', () => {
    expect(momentaryRest(FIXTURE, 'nope')).toBe(0);
  });
});

describe('stuckMomentaryIds — which pads were persisted away from rest', () => {
  it('finds a pad saved pressed', () => {
    expect(stuckMomentaryIds(FIXTURE, { strike: 1, tune: 200 })).toEqual(['strike']);
  });

  it('finds a pad saved AWAY from a non-zero rest', () => {
    // The generic statement of the rule: "stuck" is "not at rest", not "is 1".
    expect(stuckMomentaryIds(FIXTURE, { restsAtOne: 0 })).toEqual(['restsAtOne']);
  });

  it('a pad AT rest is not stuck, and neither is any ordinary param', () => {
    expect(stuckMomentaryIds(FIXTURE, { strike: 0, restsAtOne: 1, tune: 999 })).toEqual([]);
  });

  it('a def with no momentary declaration is never stuck, whatever its params say', () => {
    const plain: MomentaryDefLike = { params: [{ id: 'hard', defaultValue: 0 }] };
    expect(stuckMomentaryIds(plain, { hard: 1 })).toEqual([]);
  });
});

describe('restedParams — the spawn snapshot', () => {
  it('forces a stuck pad back to rest', () => {
    const out = restedParams(FIXTURE, { strike: 1, tune: 200 })!;
    expect(out.strike).toBe(0);
  });

  it('LEAVES EVERY OTHER PARAM EXACTLY AS SAVED', () => {
    // The negative control on the repair: a fix that reset the rack's knobs
    // would be worse than the stuck pad. tune must survive verbatim.
    const out = restedParams(FIXTURE, { strike: 1, tune: 200, restsAtOne: 1 })!;
    expect(out.tune).toBe(200);
    expect(out.restsAtOne).toBe(1);
    expect(Object.keys(out).sort()).toEqual(['restsAtOne', 'strike', 'tune']);
  });

  it('returns the input BY IDENTITY when nothing is stuck', () => {
    // Not an optimisation detail — it is how the caller (AudioEngine.addNode)
    // tells "repaired" from "untouched" without a deep compare, and it proves
    // the ordinary spawn allocates nothing.
    const params = { strike: 0, tune: 200 };
    expect(restedParams(FIXTURE, params)).toBe(params);
    expect(restedParams(undefined, params)).toBe(params);
    expect(restedParams(FIXTURE, undefined)).toBe(undefined);
  });
});

describe('the REAL defs that declare a press-pad', () => {
  it('tomtom `strike` rests at 0, and a rack saved with it at 1 spawns at 0', () => {
    expect([...momentaryIds(tomtomDef as MomentaryDefLike)]).toEqual(['strike']);
    // The exact corrupt state: the worklet does `max(trigger_in, strike)`, so a
    // persisted 1 holds the combined trigger permanently high and the drum can
    // never be struck again by anything.
    const saved = { strike: 1, tune: 180, decay: 400 };
    const spawn = restedParams(tomtomDef as MomentaryDefLike, saved)!;
    expect(spawn.strike, 'a saved press must not reach the worklet').toBe(0);
    expect(spawn.tune).toBe(180);
    expect(spawn.decay).toBe(400);
    // …and the SAVED object is untouched — `restedParams` is a view, because
    // the live node is a syncedStore proxy and mutating it here would be an
    // untagged Y.Doc write from the engine.
    expect(saved.strike).toBe(1);
  });

  it('tidyVco `hold` rests at 0, and a rack saved mid-drone spawns silent', () => {
    expect([...momentaryIds(tidyVcoDef as MomentaryDefLike)]).toEqual(['hold']);
    const spawn = restedParams(tidyVcoDef as MomentaryDefLike, { hold: 1, cutoff: 3000 })!;
    expect(spawn.hold, 'a saved hold must not reach the worklet').toBe(0);
    expect(spawn.cutoff).toBe(3000);
  });

  it('EVERY def declaring face.momentary is covered — a fourth one enrolls itself', () => {
    // Registry-driven so this cannot go stale: a new press-pad module gets the
    // rest-at-spawn guarantee asserted the day it lands, without an edit here.
    // The ROSTER line is the accept-loop half — a new member is confirmed once,
    // here, rather than joining silently.
    //
    // bluebox (2026-08-09) is the first member that is ENTIRELY press-pads:
    // twelve keys, no values. Its legacy card writes the held 1 through
    // `setNodeParam`, so a rack closed mid-hold saves a stuck key — the tomtom
    // failure mode exactly, ×12 — and the loop below now asserts the repair on
    // all twelve.
    // moog956 (2026-09-02) is the first member whose pad is HALF OF A GESTURE
    // rather than a button: the ribbon's one pointer stroke raises `gate` and
    // writes `pos` together. Its enrolment also came with a curve correction —
    // `gate` was declared `linear` while the factory has thresholded it at
    // `> 0.5` since the module shipped, and `looksLikeSwitch` reaches only
    // params that are ALREADY `0..1 discrete`, so the pad was unclassifiable
    // until the declaration told the truth. The failure mode it closes is
    // tomtom's with the opposite symptom: a rack saved mid-note reloaded with
    // the gate HIGH and the patched envelope open, i.e. a drone nothing could
    // stop.
    const declaring = (listModuleDefs() as unknown as (MomentaryDefLike & { type: string })[])
      .filter((d) => (d.face?.momentary ?? []).length > 0);
    expect(declaring.map((d) => d.type).sort())
      .toEqual(['bluebox', 'clap', 'moog956', 'tidyVco', 'tomtom']);
    for (const def of declaring) {
      for (const pid of momentaryIds(def as MomentaryDefLike)) {
        const rest = momentaryRest(def as MomentaryDefLike, pid);
        // A pad's rest must be its default AND the pressed value (1) must
        // differ from it, or "stuck" is not a detectable state at all.
        expect(rest, `${def.type}.${pid} rest`).not.toBe(1);
        const spawn = restedParams(def as MomentaryDefLike, { [pid]: 1 })!;
        expect(spawn[pid], `${def.type}.${pid} must spawn at rest`).toBe(rest);
      }
    }
  });
});
