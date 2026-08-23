// packages/web/src/lib/ui/workflow/shell-cells.test.ts
//
// The BROWSER-FREE pre-gate for the INERT-CELL class (P1 batch-2 adversarial
// render verify). The shell's `param` cells are generic, but a `family` /
// `static` cell needs a real per-module spec; before this registry every one of
// them rendered as a DEAD LABEL, which is how dx7 shipped with an unreachable
// preset selector (its hero, `face.order[0]`) and an unreachable .syx import.
//
// Two lines held here, both registry-driven so every future promoted face
// auto-enrols:
//   1. COVERAGE — every family/static key ranked by a STRICT_FACES module
//      resolves to a spec, so nothing can render `data-cell-inert`.
//   2. NO ORPHANS — every registered spec addresses a key some module's face
//      actually ranks (a renamed face key can't leave a dead hook behind).
// The DOM-level twin is e2e/tests/faces-parity.spec.ts, which drives each
// rendered cell and asserts an observable effect.

import { describe, it, expect } from 'vitest';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ModuleFace } from '$lib/graph/types';
import { STRICT_FACES } from './strict-faces';
import { dockFacePlan, dockPlanControls, type FaceDefLike } from './curated-face';
import {
  panelCellKeys,
  shellCellFor,
  shellCellKeys,
  paramShapedCellKind,
  shellPanelProbes,
  typesWithShellCells,
  type ShellActionCell,
  type ShellActionProbe,
  type ShellPanelProbe,
} from './shell-cells';

interface CellDef extends FaceDefLike {
  type: string;
  face?: ModuleFace;
}

function allDefs(): CellDef[] {
  return [
    ...(listModuleDefs() as unknown as CellDef[]),
    ...(listVideoModuleDefs() as unknown as CellDef[]),
    ...(listMetaModuleDefs() as unknown as CellDef[]),
  ].sort((a, b) => a.type.localeCompare(b.type));
}

describe('shell cells — COVERAGE (no inert cell can render on a promoted face)', () => {
  it('every STRICT_FACES family/static control resolves to a registered cell spec', () => {
    const inert: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      // dockFacePlan is the shell's ACTUAL dock render plan — using it (rather
      // than face.order) means this gate covers exactly what gets painted.
      // dockPlanControls flattens BOTH halves of a band (un-clustered cells +
      // ModuleFacePage.clusters sub-groups), so moving a control into a cluster
      // never drops it out of this coverage sweep.
      for (const ctl of dockPlanControls(dockFacePlan(def) ?? [])) {
        if (ctl.kind === 'param') continue;
        if (!shellCellFor(def.type, ctl)) {
          inert.push(
            `${def.type}: '${ctl.key}' (${ctl.kind}) has no shell-cell spec — it would render ` +
              `as a DEAD LABEL. Register it in shell-cells.ts (prefer the generic ` +
              `selector/action/file/toggle kinds) or drop the key from the face.`,
          );
        }
      }
    }
    expect(inert.join('\n'), 'INERT shell cell(s) — a curated control the user cannot touch').toBe('');
  });

  // ⚠ THIS PAIR REPLACES A SINGLE TEST THAT PINNED A BUG AS A RULE. It read
  // "a param control never routes to the family/static registry" and swept
  // EVERY param, asserting `shellCellFor` returned null. That was true — and
  // correct — until #2144 introduced `warped-fader`, the first cell kind that
  // BINDS A PARAM. #2144 added the type, the ModuleShell render branch and a
  // source gate, but not the resolver arm, so its branch was unreachable from
  // the day it merged and this test was what held the door shut.
  //
  // Nothing went red, because a warped-fader param still resolved a perfectly
  // valid GENERIC cell — it just drew the param LINEARLY, which is the exact
  // geometry the cell exists to prevent. The two halves of the real rule are
  // now asserted separately, in both directions.

  it('a param control cannot borrow a FAMILY/STATIC cell', () => {
    const borrowed: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      for (const ctl of dockPlanControls(dockFacePlan(def) ?? [])) {
        if (ctl.kind !== 'param') continue;
        const cell = shellCellFor(def.type, ctl);
        // A param may resolve ONLY a param-shaped cell. Every other kind edits
        // node.data and carries no paramId, so rendering one over a param would
        // write somewhere the control does not point.
        if (cell && cell.kind !== 'warped-fader') {
          borrowed.push(`${def.type}: param '${ctl.key}' resolved a '${cell.kind}' cell`);
        }
      }
    }
    expect(borrowed.join('\n'), 'a param control borrowed a non-param cell').toBe('');
  });

  it('every DECLARED param cell is REACHABLE through the real resolver', () => {
    // The leg that would have caught #2144's dead branch. A module can declare a
    // `warped-fader` and rank its param, and every other gate stays green while
    // the shell silently renders the generic control — so the declaration itself
    // has to be checked against the resolution path the shell actually uses.
    const unreachable: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      const declared = shellCellKeys(def.type).filter(
        (k) => paramShapedCellKind(def.type, k),
      );
      if (declared.length === 0) continue;
      const reached = new Set(
        dockPlanControls(dockFacePlan(def) ?? [])
          .filter((ctl) => shellCellFor(def.type, ctl)?.kind === 'warped-fader')
          .map((ctl) => ctl.key),
      );
      for (const key of declared) {
        if (!reached.has(key)) {
          unreachable.push(
            `${def.type}: declares a param-shaped cell for '${key}' that the dock plan ` +
              `never resolves — the shell would render the GENERIC control instead, ` +
              `silently discarding the cell's geometry.`,
          );
        }
      }
    }
    expect(unreachable.join('\n'), 'a declared param cell is unreachable').toBe('');
  });

  it('NEGATIVE CONTROL: the reachability sweep is not vacuous', () => {
    // It only means something if some module really declares one today.
    const declaring = allDefs()
      .filter((d) => STRICT_FACES.has(d.type))
      .filter((d) => shellCellKeys(d.type).some((k) => paramShapedCellKind(d.type, k)));
    expect(
      declaring.length,
      'no promoted module declares a param-shaped cell — the sweep above proves nothing',
    ).toBeGreaterThan(0);
  });
});

describe('shell cells — PANEL probes (PF-14: the parity sweep stays registry-driven)', () => {
  // A bespoke panel has no natural interaction the faces-parity sweep could
  // guess, and the alternative to declaring one is special-casing the module
  // inside the e2e — which forfeits the property that makes the whole gate
  // work: STRICT_FACES enumerates itself, so every future face auto-enrols with
  // zero test edits. So the panel DECLARES how to poke it and what must change.
  //
  // These are BROWSER-FREE integrity checks on that declaration. The DOM twin
  // is faces-parity's `panel` driveCell branch, which reads the SAME projection
  // off `window.__shellPanelProbes`.

  /** The pure clauses a probe must satisfy, driven over the live registry AND
   *  over synthetic probes below (no module declares a panel until dx7 PR 6, so
   *  the live sweep is vacuous today and would stay green on a `return []`). */
  function probeProblems(where: string, probe: ShellPanelProbe | undefined): string[] {
    const problems: string[] = [];
    if (!probe) return [`${where}: panel cell declares no operability probe`];
    if (!probe.testid.trim()) problems.push(`${where}: probe has a blank testid`);
    // THE HARD RULE. faces-parity asserts EXACT MULTISET EQUALITY between the
    // dock's `control-*` testids and the def's param ids, so a `control-` testid
    // inside a panel is an unbacked EXTRA control that fails the whole face.
    if (probe.testid.startsWith('control-')) {
      problems.push(
        `${where}: probe targets '${probe.testid}' — a panel must NEVER emit a ` +
          `'control-<paramId>' testid. faces-parity asserts exact multiset equality ` +
          `against the def's params, so that reads as an extra control with no def backing.`,
      );
    }
    if (probe.effect.kind === 'text') {
      // A `text` probe watches a DIFFERENT element than the one it drives.
      // Naming the driven element itself is the WEAK form — a button that only
      // relabels itself would pass, which is the dead-control class the whole
      // probe exists to catch — so it is an authoring error, not a style note.
      if (!probe.effect.testid.trim()) {
        problems.push(`${where}: text-probe effect names no witness testid`);
      } else if (probe.effect.testid === probe.testid) {
        problems.push(
          `${where}: text-probe witness '${probe.effect.testid}' is the element it DRIVES. ` +
            `Name a different element the interaction must move — a control that only ` +
            `relabels itself is indistinguishable from a dead one.`,
        );
      }
    } else if (!probe.effect.key.trim()) {
      problems.push(`${where}: probe effect names no node.data key`);
    }
    return problems;
  }

  it('every registered PANEL cell declares a usable probe', () => {
    const problems: string[] = [];
    for (const type of typesWithShellCells()) {
      for (const key of panelCellKeys(type)) {
        const probe = shellPanelProbes()[type]?.[key];
        problems.push(...probeProblems(`${type}:${key}`, probe));
      }
    }
    expect(problems.join('\n'), 'panel probe drift — faces-parity could not drive the panel').toBe('');
  });

  it('shellPanelProbes() projects EXACTLY the registered panel cells', () => {
    const projected = shellPanelProbes();
    for (const type of typesWithShellCells()) {
      const keys = panelCellKeys(type);
      expect(Object.keys(projected[type] ?? {}).sort(), type).toEqual(keys);
      // …and a non-panel cell never leaks into the probe map.
      for (const key of shellCellKeys(type)) {
        if (keys.includes(key)) continue;
        expect(projected[type]?.[key], `${type}:${key} is not a panel`).toBeUndefined();
      }
    }
  });

  it('NEGATIVE CONTROL: the probe clauses actually fail on a malformed probe', () => {
    const ok: ShellPanelProbe = {
      testid: 'dx7-op-onoff-2',
      action: 'click',
      effect: { kind: 'data', key: 'opOn[1]', expect: 'changed' },
    };
    expect(probeProblems('x:y', ok)).toEqual([]);

    expect(probeProblems('x:y', undefined)).toHaveLength(1);
    expect(probeProblems('x:y', { ...ok, testid: '  ' })).toHaveLength(1);
    // The hard rule, proven to bite.
    const leaked = probeProblems('x:y', { ...ok, testid: 'control-algorithm' });
    expect(leaked).toHaveLength(1);
    expect(leaked[0]).toContain('must NEVER emit');
    expect(
      probeProblems('x:y', { ...ok, effect: { kind: 'data-rev', key: '' } }),
    ).toHaveLength(1);

    // The `text` shape, and its own hard rule. A well-formed one passes…
    const okText: ShellPanelProbe = {
      testid: 'kickdrum-graph-window',
      action: 'click',
      effect: { kind: 'text', testid: 'kickdrum-graph-axis', expect: 'changed' },
    };
    expect(probeProblems('x:y', okText)).toEqual([]);
    // …a blank witness fails…
    expect(
      probeProblems('x:y', { ...okText, effect: { kind: 'text', testid: ' ', expect: 'changed' } }),
    ).toHaveLength(1);
    // …and so does the WEAK form: watching the very element you drive, which a
    // button that merely relabels itself would satisfy while doing nothing.
    const selfWatch = probeProblems('x:y', {
      ...okText,
      effect: { kind: 'text', testid: 'kickdrum-graph-window', expect: 'changed' },
    });
    expect(selfWatch).toHaveLength(1);
    expect(selfWatch[0]).toContain('is the element it DRIVES');
  });
});

describe('shell cells — ACTION cells declare the handler their MODE needs', () => {
  // A `mode:'gate'` cell whose only handler is `onFire` renders as a momentary
  // <Button>, which dispatches press/release and NEVER calls onTrigger — so the
  // pad would be inert while looking perfectly alive (it presses, it reports
  // aria-pressed, it does nothing). The inverse is worse: a `mode:'trigger'`
  // cell carrying only `onGate` is a one-shot Button that never fires either
  // handler. Neither is visible to any DOM assertion that checks the button is
  // "enabled and clickable", which is what the existing faces-parity action
  // probe does — so it is checked HERE, off the declaration.

  /** The pure clause, driven over the live registry AND over synthetic cells. */
  function actionProblems(where: string, cell: ShellActionCell): string[] {
    const problems: string[] = [];
    const mode = cell.mode ?? 'trigger';
    if (mode === 'gate') {
      if (!cell.onGate) problems.push(`${where}: mode 'gate' but no onGate — the held pad would do nothing`);
      if (cell.onFire) problems.push(`${where}: mode 'gate' declares onFire, which a momentary Button never calls`);
    } else {
      if (!cell.onFire) problems.push(`${where}: mode 'trigger' but no onFire — the button would do nothing`);
      if (cell.onGate) problems.push(`${where}: mode 'trigger' declares onGate, which a one-shot Button never calls`);
    }
    // ⚠ THE PROBE IS REQUIRED (2026-08-02). Until this clause existed,
    // faces-parity's `action` branch asserted `toBeEnabled()`, clicked, and
    // asserted NO EFFECT — the only cell kind in that sweep with no probe at
    // all, on the kind whose whole purpose is to do something. An action cell
    // with no declared observable is indistinguishable from a dead one, which
    // is the exact class this gate set exists to catch.
    const probe = (cell as { probe?: ShellActionProbe }).probe;
    if (!probe) {
      problems.push(
        `${where}: declares no operability probe. Add one to its shell-cell spec — ` +
          `an audition writes nothing to the graph, so the sweep has NO other way to ` +
          `tell a live press from a dead one.`,
      );
    } else if (probe.effect.kind === 'audition') {
      // ⚠ `manual-press` is DELIBERATELY ABSENT. It is a real `AuditionSeam`,
      // but it belongs to the MOMENTARY PAD (`face.momentary`), which the shell
      // renders as a `momentary` CONTROL — not an `action` CELL. An action cell
      // declaring it would be asserted against a seam it can never reach, i.e.
      // a probe that can only fail, which is how a gate gets deleted. Omission
      // here is what makes that a loud "unknown audition seam" rather than a
      // silently-accepted mis-wiring; the pad's own coverage is the `momentary`
      // branch of faces-parity + audition-ledger.test.ts.
      //
      // ⚠ `file-export` IS PRESENT, and it is a ONE-SHOT seam like the first and
      // third. It exists because samsloop's sample EXPORT reaches no engine and
      // no worklet — its whole effect leaves the app — so labelling it
      // `engine-message` would make the ledger describe something that did not
      // happen, AND would let a probe watching this node be satisfied by a REC
      // press instead. That is the same aliasing `manual-press` was split out to
      // prevent, one seam over.
      const SEAMS = ['manual-strike', 'manual-gate', 'engine-message', 'file-export'];
      if (!SEAMS.includes(probe.effect.seam)) {
        problems.push(`${where}: unknown audition seam '${probe.effect.seam}'`);
      } else if (mode === 'gate' && probe.effect.seam !== 'manual-gate') {
        // A HELD action whose probe watches the one-shot seam would be asserted
        // against a seam it never reaches — a probe that can only fail, which
        // gets deleted, which is how a gate dies.
        problems.push(
          `${where}: mode 'gate' but the probe watches seam '${probe.effect.seam}' — a held ` +
            `action reaches 'manual-gate'`,
        );
      } else if (mode === 'trigger' && probe.effect.seam === 'manual-gate') {
        problems.push(`${where}: mode 'trigger' but the probe watches the HELD seam`);
      }
    } else if (!probe.effect.key.trim()) {
      problems.push(`${where}: probe effect names no node.data key`);
    }
    return problems;
  }

  it('every registered ACTION cell is well-formed for its mode', () => {
    const problems: string[] = [];
    for (const type of typesWithShellCells()) {
      for (const key of shellCellKeys(type)) {
        const cell = shellCellFor(type, { key, kind: 'family', label: key });
        if (cell?.kind !== 'action') continue;
        problems.push(...actionProblems(`${type}:${key}`, cell));
      }
    }
    expect(problems.join('\n'), 'action cell(s) wired to a handler their mode never calls').toBe('');
  });

  it('NEGATIVE CONTROL: the clause actually fails on each malformed shape', () => {
    const fire = () => {};
    const gate = () => {};
    const trigProbe: ShellActionProbe = { effect: { kind: 'audition', seam: 'manual-strike' } };
    const gateProbe: ShellActionProbe = { effect: { kind: 'audition', seam: 'manual-gate' } };
    // Well-formed, both shapes.
    expect(actionProblems('x:y', { kind: 'action', label: 'a', onFire: fire, probe: trigProbe })).toEqual([]);
    expect(actionProblems('x:y', { kind: 'action', label: 'a', mode: 'trigger', onFire: fire, probe: trigProbe })).toEqual([]);
    expect(actionProblems('x:y', { kind: 'action', label: 'a', mode: 'gate', onGate: gate, probe: gateProbe })).toEqual([]);
    // The four ways to get the HANDLER wrong.
    expect(actionProblems('x:y', { kind: 'action', label: 'a', mode: 'gate', probe: gateProbe })).toHaveLength(1);
    expect(actionProblems('x:y', { kind: 'action', label: 'a', mode: 'gate', onFire: fire, probe: gateProbe })).toHaveLength(2);
    expect(actionProblems('x:y', { kind: 'action', label: 'a', probe: trigProbe })).toHaveLength(1);
    expect(actionProblems('x:y', { kind: 'action', label: 'a', onGate: gate, probe: trigProbe })).toHaveLength(2);
    // …and the three ways to get the PROBE wrong. THE FIRST IS THE SHIPPED
    // STATE this clause was written for: a cell with no probe at all.
    const noProbe = { kind: 'action', label: 'a', onFire: fire } as unknown as ShellActionCell;
    expect(actionProblems('x:y', noProbe)).toHaveLength(1);
    expect(actionProblems('x:y', noProbe)[0]).toContain('no operability probe');
    // A held pad probed against the one-shot seam — a probe that could only fail.
    expect(
      actionProblems('x:y', { kind: 'action', label: 'a', mode: 'gate', onGate: gate, probe: trigProbe }),
    ).toHaveLength(1);
    // …and a one-shot probed against the held seam.
    expect(
      actionProblems('x:y', { kind: 'action', label: 'a', onFire: fire, probe: gateProbe }),
    ).toHaveLength(1);
  });

  it('the gate-mode shape is REACHED by a real module (the clause is not vacuous)', () => {
    // A sweep over a registry with no gate-mode cell in it would stay green on
    // a `return []`. snaredrum's ROLL audition is the first one; if it is ever
    // removed, this line says so rather than the coverage silently evaporating.
    const modes: string[] = [];
    for (const type of typesWithShellCells()) {
      for (const key of shellCellKeys(type)) {
        const cell = shellCellFor(type, { key, kind: 'family', label: key });
        if (cell?.kind === 'action' && cell.mode === 'gate') modes.push(`${type}:${key}`);
      }
    }
    expect(modes, 'at least one registered action cell uses mode gate').not.toEqual([]);
  });
});

describe('shell cells — NO ORPHANS (a renamed face key cannot leave a dead hook)', () => {
  it('every registered spec addresses a real module + a key that module ranks', () => {
    const byType = new Map(allDefs().map((d) => [d.type, d]));
    const orphans: string[] = [];
    for (const type of typesWithShellCells()) {
      const def = byType.get(type);
      if (!def) {
        orphans.push(`shell-cells registers '${type}', which is not a registered module`);
        continue;
      }
      const ranked = new Set(def.face?.order ?? []);
      for (const key of shellCellKeys(type)) {
        if (!ranked.has(key)) {
          orphans.push(`${type}: shell-cell '${key}' is not in face.order (stale hook)`);
        }
      }
    }
    expect(orphans.join('\n'), 'orphaned shell-cell spec(s) — fix the key or delete the hook').toBe('');
  });
});
