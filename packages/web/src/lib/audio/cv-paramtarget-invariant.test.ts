// packages/web/src/lib/audio/cv-paramtarget-invariant.test.ts
//
// Universal CV-input paramTarget invariant.
//
// Rationale (audit issue #G.1, .myrobots/plans/test-coverage-audit.md):
// every Phase-1 video module declares CV inputs whose port id matches a
// param id, but only LINES + INWARDS used to declare the matching
// `paramTarget: <id>`. The runtime CV bridge (PatchEngine.addEdge)
// looks up the target via `edge.target.portId` directly and works
// either way — but the docs/manifest layer (module-manifest.ts:578)
// reads `port.paramTarget` to render "CV -> shift param." instead of
// the generic "Control voltage." This test catches the
// inconsistency at unit time so future modules stay aligned.
//
// Invariant: for every registered module def (audio + video), every
// CV input port whose `id` matches one of the def's param ids MUST
// declare `paramTarget: id`.
//
// We allow CV inputs that don't match any param id (e.g.
// polyseqz.humanize_cv -> paramTarget: 'humanize') — those declare
// their target explicitly.

import { describe, expect, it } from 'vitest';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect imports auto-register every module def.
import '$lib/audio/modules';
import '$lib/video/modules';

interface PortDef {
  id: string;
  type: string;
  paramTarget?: string;
}
interface ParamDef {
  id: string;
}
interface DefShape {
  type: string;
  domain: string;
  inputs: readonly PortDef[];
  params: readonly ParamDef[];
}

function asDefShape(d: unknown): DefShape {
  return d as DefShape;
}

describe('CV-input paramTarget invariant — every domain', () => {
  // A single test that walks ALL defs is more useful than per-module
  // because the failure message lists every offender, so a diff that
  // adds 5 new modules with broken paramTarget surfaces 5 hits at once.
  it('every CV input whose id matches a param id declares paramTarget: id', () => {
    const allDefs: DefShape[] = [
      ...listModuleDefs().map(asDefShape),
      ...listVideoModuleDefs().map(asDefShape),
    ];

    const offenders: string[] = [];

    for (const def of allDefs) {
      const paramIds = new Set(def.params.map((p) => p.id));
      for (const port of def.inputs) {
        if (port.type !== 'cv') continue;
        if (!paramIds.has(port.id)) continue; // non-param-named CV port
        if (port.paramTarget !== port.id) {
          offenders.push(
            `[${def.domain}/${def.type}] cv input '${port.id}' should declare paramTarget: '${port.id}' (got: ${JSON.stringify(port.paramTarget)})`,
          );
        }
      }
    }

    expect(offenders, `paramTarget mismatches:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('audio + video registries are non-empty (sanity — registration ran)', () => {
    expect(listModuleDefs().length, 'audio defs registered').toBeGreaterThan(0);
    expect(listVideoModuleDefs().length, 'video defs registered').toBeGreaterThan(0);
  });
});
