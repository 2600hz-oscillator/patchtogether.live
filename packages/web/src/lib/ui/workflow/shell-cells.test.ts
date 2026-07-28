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
import { shellCellFor, shellCellKeys, typesWithShellCells } from './shell-cells';

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

  it('a param control never routes to the family/static registry', () => {
    for (const def of allDefs()) {
      if (!STRICT_FACES.has(def.type)) continue;
      for (const ctl of dockPlanControls(dockFacePlan(def) ?? [])) {
        if (ctl.kind !== 'param') continue;
        expect(shellCellFor(def.type, ctl), `${def.type}: ${ctl.key}`).toBeNull();
      }
    }
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
