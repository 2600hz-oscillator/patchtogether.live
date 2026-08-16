// packages/web/src/lib/ui/workflow/no-user-control.test.ts
//
// THE LINT for the no-user-control DECLARATION (#1726).
//
// The declaration exists so a module can say "a player never sets this param"
// in a form a gate can read. The risk of any such field is that it becomes an
// escape hatch: a way to make a red gate green without changing anything true.
// Three properties are what stop that, and all three are asserted here over the
// LIVE registries, deny-by-default:
//
//   1. ANCHORED TO THE ARTIFACT — every entry names a live `ParamDef` of the
//      SAME def. An entry that outlives its param is RED, never inert.
//   2. ANCHORED IN BOTH DIRECTIONS — `writer: 'cv-port'` requires an input port
//      with a matching `paramTarget`; `writer: 'internal'` requires that NO
//      such port exists. So neither arm can be asserted about nothing, and
//      ADDING a CV port to an 'internal' param reddens the entry that called it
//      internal.
//   3. THE CONSUMERS ACTUALLY CONSUME IT — a declaration no renderer branches
//      on is the `curve="linear"` trap (a green gate certifying a live bug), so
//      the consumers are driven here against the REAL defs, not just described.
//
// ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
//
// It cannot see whether the `why` is TRUE. Nothing can: "a player never sets
// this" is a design claim, and the only machine-checkable half of it is the
// wiring, which is what `writer` pins. It also cannot see a param that SHOULD
// have been declared and was not — that direction is covered where it matters,
// by the face-completeness gate, which still demands a rank for every param no
// declaration covers.

import { describe, it, expect } from 'vitest';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { NoUserControlDefLike } from '$lib/graph/types';
import { listExposableControls } from '$lib/graph/group-controls';
import { resolvePushCardControls, pushCardParams } from '$lib/control/push2/push-card-schema';
import {
  cvWritersOf,
  hasNoUserControl,
  noUserControlIds,
  noUserControlProblems,
  NO_USER_CONTROL_WHY_MIN,
} from './no-user-control';

function allDefs(): NoUserControlDefLike[] {
  return [
    ...(listModuleDefs() as unknown as NoUserControlDefLike[]),
    ...(listVideoModuleDefs() as unknown as NoUserControlDefLike[]),
    ...(listMetaModuleDefs() as unknown as NoUserControlDefLike[]),
  ].sort((a, b) => (a.type ?? '').localeCompare(b.type ?? ''));
}

/** Defs that actually declare something — the subject of the consumer legs.
 *  DERIVED, never a count: if the population is empty the vacuity leg below
 *  says so out loud rather than reporting green over nothing. */
function declaringDefs(): NoUserControlDefLike[] {
  return allDefs().filter((d) => (d.noUserControl ?? []).length > 0);
}

describe('noUserControl — the declaration is sound (live registries)', () => {
  it('every entry names a live ParamDef, with a real why and a truthful writer', () => {
    const problems = allDefs().flatMap((d) => noUserControlProblems(d));
    expect(problems.join('\n'), 'unsound noUserControl declaration(s)').toBe('');
  });

  it('the two writer arms partition the declared params, and each is inhabited', () => {
    // A partition rather than a count: every entry is 'cv-port' XOR 'internal'
    // by the type, and the ANCHOR is what makes the label mean something. This
    // asserts the anchor holds for every live entry, from the port side.
    const wrong: string[] = [];
    for (const def of declaringDefs()) {
      for (const e of def.noUserControl ?? []) {
        const writers = cvWritersOf(def, e.param);
        const expected = writers.length > 0 ? 'cv-port' : 'internal';
        if (e.writer !== expected) {
          wrong.push(
            `${def.type}.${e.param}: declared '${e.writer}' but the def's ports say '${expected}' ` +
              `(targeting ports: ${writers.join(', ') || 'none'})`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('VACUITY: the declaration has at least one live adopter', () => {
    // Every other leg in this file is registry-driven, so with no adopter they
    // would all pass having exercised nothing — the exact "platform PR lands a
    // cycle before its consumer" failure param-cell-coverage.test.ts was
    // written about. DERIVED MEMBERSHIP, no number: the assertion is that the
    // adopter set is non-empty and that its members really do declare.
    const adopters = declaringDefs().map((d) => d.type);
    expect(adopters.length, 'no def declares noUserControl — the field is inert').toBeGreaterThan(0);
    for (const t of adopters) {
      const def = allDefs().find((d) => d.type === t)!;
      expect(noUserControlIds(def).size).toBeGreaterThan(0);
    }
  });
});

describe('noUserControl — the consumers actually consume it', () => {
  it('CONSUMER: a declared param is never auto-exposed on a group control bar', () => {
    const defs = allDefs();
    const lookup = (type: string) => defs.find((d) => d.type === type) as never;
    const leaked: string[] = [];
    for (const def of declaringDefs()) {
      const exposed = new Set(
        listExposableControls(def.type!, lookup).map((c) => c.paramId),
      );
      for (const id of noUserControlIds(def)) {
        if (exposed.has(id)) leaked.push(`${def.type}.${id}`);
      }
    }
    expect(leaked, 'declared param(s) still offered as auto-exposed group controls').toEqual([]);

    // The OTHER direction, so this is not a probe that reads nothing: the same
    // call must still expose the params that ARE controls. Without this leg a
    // `listExposableControls` that returned [] would pass the assertion above.
    for (const def of declaringDefs()) {
      const exposed = listExposableControls(def.type!, lookup);
      expect(exposed.length, `${def.type}: every control was suppressed — the filter is too wide`).toBeGreaterThan(0);
    }
  });

  it('CONSUMER: a declared param never reaches a Push 2 encoder', () => {
    const onEncoders: string[] = [];
    for (const def of declaringDefs()) {
      const spec = resolvePushCardControls(def as never);
      const ids = new Set(pushCardParams(spec).map((p) => p.id));
      for (const id of noUserControlIds(def)) {
        if (ids.has(id)) onEncoders.push(`${def.type}.${id} (source: ${spec.source})`);
      }
    }
    expect(onEncoders, 'declared param(s) bound to a Push encoder').toEqual([]);
  });

  // ── NEGATIVE CONTROLS — permanent legs, calling the SAME predicates ───────
  //
  // A passing positive control proves the probe can move, not that it reads the
  // right thing. Each of these perturbs exactly the dimension under test and
  // asserts the number moves the right way.

  const FIXTURE = {
    type: 'fixture',
    params: [
      { id: 'knob', label: 'Knob', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
      { id: 'gate', label: 'Gate', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
      { id: 'quiet', label: 'Quiet', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    ],
    inputs: [{ id: 'gate_in', type: 'cv', paramTarget: 'gate' }],
  };
  const WHY = 'written by the gate_in bridge; the module edge-detects it';
  const good = {
    ...FIXTURE,
    noUserControl: [
      { param: 'gate', writer: 'cv-port' as const, why: WHY },
      { param: 'quiet', writer: 'internal' as const, why: 'determinism toggle flipped by the VRT harness' },
    ],
  };

  it('NEGATIVE CONTROL: the sanctioned fixture is clean, and each defect reddens', () => {
    expect(noUserControlProblems(good)).toEqual([]);

    // (a) an entry naming a param that does not exist
    const ghost = { ...FIXTURE, noUserControl: [{ param: 'vanished', writer: 'internal' as const, why: WHY }] };
    expect(noUserControlProblems(ghost).join()).toContain('not a ParamDef of this def');

    // (b) 'cv-port' with no port targeting it — the arm asserted about nothing
    const unwritten = { ...FIXTURE, noUserControl: [{ param: 'quiet', writer: 'cv-port' as const, why: WHY }] };
    expect(noUserControlProblems(unwritten).join()).toContain('NO input port declares');

    // (c) 'internal' on a param a port DOES target — the direction that catches
    //     a port added later to something previously called internal
    const nowWired = { ...FIXTURE, noUserControl: [{ param: 'gate', writer: 'internal' as const, why: WHY }] };
    expect(noUserControlProblems(nowWired).join()).toContain("says writer 'internal' but input port(s)");

    // (d) a placeholder why
    const lazy = { ...FIXTURE, noUserControl: [{ param: 'gate', writer: 'cv-port' as const, why: 'hidden' }] };
    expect(noUserControlProblems(lazy).join()).toContain("needs a real 'why'");
    expect('hidden'.length).toBeLessThan(NO_USER_CONTROL_WHY_MIN);

    // (e) the same param twice
    const dup = {
      ...FIXTURE,
      noUserControl: [
        { param: 'gate', writer: 'cv-port' as const, why: WHY },
        { param: 'gate', writer: 'cv-port' as const, why: WHY },
      ],
    };
    expect(noUserControlProblems(dup).join()).toContain('twice');

    // (f) a def that declares nothing has nothing to be wrong about
    expect(noUserControlProblems(FIXTURE)).toEqual([]);
    expect(noUserControlProblems(undefined)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the group bar drops exactly the declared params, no more', () => {
    const withDecl = (type: string) => (type === 'fixture' ? (good as never) : undefined);
    const without = (type: string) => (type === 'fixture' ? (FIXTURE as never) : undefined);

    const before = listExposableControls('fixture', without).map((c) => c.paramId).sort();
    const after = listExposableControls('fixture', withDecl).map((c) => c.paramId).sort();

    // The probe moves (it is not blind), and it moves by EXACTLY the declared
    // set — a filter that dropped anything else would pass a "does it shrink?"
    // check and be wrong.
    expect(before).toEqual(['gate', 'knob', 'quiet']);
    expect(after).toEqual(['knob']);
    expect(before.filter((id) => !after.includes(id)).sort()).toEqual([...noUserControlIds(good)].sort());
  });

  it('NEGATIVE CONTROL: an EXPLICIT exposableControls entry still wins over the declaration', () => {
    // The declaration says "no AUTO control". A module that deliberately puts
    // the param on the bar under its own label is making a louder, explicit
    // claim, and the auto-synthesis filter must not silently override it —
    // otherwise the declaration becomes a way to break a module's own curation.
    const explicit = {
      ...good,
      exposableControls: [{ id: 'gateBtn', label: 'Gate', kind: 'button' as const, paramId: 'gate' }],
    };
    const ids = listExposableControls('fixture', (t) => (t === 'fixture' ? (explicit as never) : undefined))
      .map((c) => c.paramId)
      .sort();
    expect(ids).toEqual(['gate', 'knob']);
  });

  it('NEGATIVE CONTROL: hasNoUserControl / noUserControlIds read the def, both ways', () => {
    expect(hasNoUserControl(good, 'gate')).toBe(true);
    expect(hasNoUserControl(good, 'knob')).toBe(false);
    expect(hasNoUserControl(FIXTURE, 'gate')).toBe(false);
    expect([...noUserControlIds(good)].sort()).toEqual(['gate', 'quiet']);
    expect([...noUserControlIds(FIXTURE)]).toEqual([]);
    expect([...noUserControlIds(undefined)]).toEqual([]);
    expect(cvWritersOf(good, 'gate')).toEqual(['gate_in']);
    expect(cvWritersOf(good, 'quiet')).toEqual([]);
  });
});
